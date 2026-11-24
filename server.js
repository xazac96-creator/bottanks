#!/usr/bin/env node
"use strict";

/**
 * Bot Tanks live duel server.
 * Pure Node.js built-ins. Authoritative engine: ./engine.js
 *
 *   PORT=8787 node server.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const engine = require("./engine.js");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const HOST =
  process.env.HOST ||
  (process.env.RENDER || process.env.FLY_APP_NAME || process.env.RAILWAY_ENVIRONMENT
    ? "0.0.0.0"
    : "127.0.0.1");
const MATCH_DIR = process.env.BOTTANKS_MATCH_DIR || path.join(ROOT, "matches");
const SERVER_JSON =
  process.env.BOTTANKS_SERVER_JSON || path.join(ROOT, "server.json");
const HTML_FILE = path.join(ROOT, "bottanks.html");

const ALLOWED_BOTS = Object.freeze(["random", "naive", "bracketer", "solver"]);
// Dev/test-only override for who fires first ("left" | "right"). Leave unset in
// production so the opener is chosen with crypto randomness.
const FORCE_FIRST_SIDE =
  process.env.BOTTANKS_FIRST_SIDE === "left" || process.env.BOTTANKS_FIRST_SIDE === "right"
    ? process.env.BOTTANKS_FIRST_SIDE
    : null;

fs.mkdirSync(MATCH_DIR, { recursive: true });

const startedAt = new Date();
const matches = new Map(); // matchId -> match
const sseClients = new Set(); // { res, matchId|null }

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return "m_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
}

function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}

function send(res, status, body, headers) {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  const h = Object.assign(
    {
      "Content-Type":
        typeof body === "string" && !headers
          ? "text/plain; charset=utf-8"
          : typeof body === "string"
          ? "text/plain; charset=utf-8"
          : "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
    headers || {}
  );
  if (typeof body !== "string") h["Content-Type"] = "application/json; charset=utf-8";
  res.writeHead(status, h);
  res.end(payload);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on("data", function (c) {
      size += c.length;
      if (size > 1e6) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function publicPlayer(p) {
  if (!p) return null;
  return {
    name: p.name,
    kind: p.kind,
    bot: p.bot || null,
    joinedAt: p.joinedAt,
  };
}

function whoseTurnOf(match) {
  const w = match.world;
  if (match.status !== "active" || w.over) return null;
  return w.side;
}

function ammoOf(world, side) {
  return engine.copyAmmo(world[side] && world[side].ammo);
}

function ammoCaps() {
  return engine.copyAmmo(engine.AMMO_CAPS);
}

function pickFirstSide() {
  if (FORCE_FIRST_SIDE) return FORCE_FIRST_SIDE;
  return crypto.randomInt(2) === 0 ? "left" : "right";
}

function summarize(match) {
  const w = match.world;
  return {
    matchId: match.matchId,
    status: match.status,
    seed: match.seed,
    firstSide: match.firstSide || null,
    players: {
      left: publicPlayer(match.players.left),
      right: publicPlayer(match.players.right),
    },
    turnCount: match.turns.length,
    turnNumber: w.turn,
    whoseTurn: whoseTurnOf(match),
    hp: { left: w.left.hp, right: w.right.hp },
    ammo: { left: ammoOf(w, "left"), right: ammoOf(w, "right") },
    winner: w.winner,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    finishedAt: match.finishedAt || null,
  };
}

function compactTurn(turn, includePaths) {
  const t = {
    turnNumber: turn.turnNumber,
    timestamp: turn.timestamp,
    side: turn.side,
    agentName: turn.agentName,
    angle: turn.angle,
    power: turn.power,
    weapon: turn.weapon,
    taunt: turn.taunt || null,
    error: turn.error || null,
    ammoAfter: turn.ammoAfter || null,
    windBefore: turn.windBefore,
    windAfter: turn.windAfter,
    impacts: turn.impacts,
    damageToLeft: turn.damageToLeft,
    damageToRight: turn.damageToRight,
    hpBefore: turn.hpBefore,
    hpAfter: turn.hpAfter,
    hit: turn.hit,
    skipped: turn.skipped,
    winnerAfter: turn.winnerAfter || null,
  };
  if (includePaths) {
    t.trajectories = turn.trajectories;
    t.craters = turn.craters;
    t.posBefore = turn.posBefore;
    t.posAfter = turn.posAfter;
  }
  return t;
}

function publicState(match, opts) {
  opts = opts || {};
  const compact = !!opts.compact;
  const w = match.world;
  const state = {
    matchId: match.matchId,
    status: match.status,
    seed: match.seed,
    turnNumber: w.turn,
    whoseTurn: whoseTurnOf(match),
    firstSide: match.firstSide || null,
    ammoCaps: ammoCaps(),
    players: {
      left: match.players.left
        ? {
            name: match.players.left.name,
            kind: match.players.left.kind,
            x: w.left.x,
            y: w.left.y,
            hp: w.left.hp,
            maxHp: w.left.maxHp,
            ammo: ammoOf(w, "left"),
            availableWeapons: engine.availableWeapons(w.left.ammo),
          }
        : null,
      right: match.players.right
        ? {
            name: match.players.right.name,
            kind: match.players.right.kind,
            x: w.right.x,
            y: w.right.y,
            hp: w.right.hp,
            maxHp: w.right.maxHp,
            ammo: ammoOf(w, "right"),
            availableWeapons: engine.availableWeapons(w.right.ammo),
          }
        : null,
    },
    wind: w.wind,
    gravity: w.gravity,
    field: { width: w.width, height: w.height },
    weapons: engine.WEAPON_LIST,
    terrainProfile: engine.compactTerrain(w.terrain, 32),
    lastTurn: match.lastTurn
      ? compactTurn(match.lastTurn, !compact)
      : null,
    winner: w.winner,
    over: !!w.over,
    turnCount: match.turns.length,
  };
  if (!compact) state.terrain = w.terrain.slice();
  return state;
}

function persist(match) {
  const w = match.world;
  const data = {
    matchId: match.matchId,
    status: match.status,
    seed: match.seed,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    finishedAt: match.finishedAt || null,
    players: {
      left: publicPlayer(match.players.left),
      right: publicPlayer(match.players.right),
    },
    winner: w.winner,
    firstSide: match.firstSide || null,
    startedAt: match.startedAt || null,
    ammoCaps: ammoCaps(),
    initial: match.initial,
    turns: match.turns,
    final: {
      terrain: w.terrain.slice(),
      left: { x: w.left.x, y: w.left.y, hp: w.left.hp, ammo: ammoOf(w, "left") },
      right: { x: w.right.x, y: w.right.y, hp: w.right.hp, ammo: ammoOf(w, "right") },
      wind: w.wind,
      turnNumber: w.turn,
      side: w.side,
      stats: w.stats,
    },
  };
  const file = path.join(MATCH_DIR, match.matchId + ".json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function sseWrite(client, event, data) {
  try {
    if (event) client.res.write("event: " + event + "\n");
    client.res.write("data: " + JSON.stringify(data) + "\n\n");
  } catch (err) {
    sseClients.delete(client);
  }
}

function broadcast(event, data, matchId) {
  sseClients.forEach(function (client) {
    if (client.matchId && matchId && client.matchId !== matchId) return;
    sseWrite(client, event, data);
  });
}

function notifyWaiters(match) {
  const still = [];
  for (let i = 0; i < match.waiters.length; i++) {
    const w = match.waiters[i];
    const ready =
      match.status === "finished" ||
      match.world.over ||
      (match.status === "active" && match.world.side === w.side);
    if (ready) {
      clearTimeout(w.timer);
      w.resolve(publicState(match, w.opts));
    } else {
      still.push(w);
    }
  }
  match.waiters = still;
}

function joinInstructions(match, side, token) {
  const base = "http://" + HOST + ":" + PORT;
  return {
    text:
      "You are " +
      side +
      " in " +
      match.matchId +
      ". Keep your token secret. Who fires first is picked at random when the match becomes active (see firstSide / whoseTurn). When status is active and it is your turn, POST a shot. Use wait=1 to block until your turn. Ammo per match: triple x" +
      engine.AMMO_CAPS.triple +
      ", blast x" +
      engine.AMMO_CAPS.blast +
      ", shell and roller unlimited; firing an empty weapon returns 400.",
    cli:
      "node agent-cli.js wait " +
      match.matchId +
      " " +
      side +
      " && node agent-cli.js fire " +
      match.matchId +
      " " +
      token +
      " <angle> <power> [weapon] [taunt]",
    wait:
      "GET " +
      base +
      "/api/matches/" +
      match.matchId +
      "/state?wait=1&side=" +
      side +
      "&timeout=25",
    fire:
      "POST " +
      base +
      "/api/matches/" +
      match.matchId +
      "/fire  { token, angle, power, weapon?, taunt? }",
    log: "GET " + base + "/api/matches/" + match.matchId + "/log",
    stream: "GET " + base + "/api/matches/" + match.matchId + "/stream",
  };
}

function captureInitial(world) {
  return {
    terrain: world.terrain.slice(),
    left: { x: world.left.x, y: world.left.y, hp: world.left.hp, maxHp: world.left.maxHp },
    right: { x: world.right.x, y: world.right.y, hp: world.right.hp, maxHp: world.right.maxHp },
    wind: world.wind,
    gravity: world.gravity,
    seed: world.seed,
  };
}

function createMatch(opts) {
  opts = opts || {};
  const seed = opts.seed == null ? (crypto.randomBytes(4).readUInt32BE(0) >>> 0) : opts.seed >>> 0;
  const matchId = opts.matchId || makeId();
  if (matches.has(matchId)) throw new Error("Match id already exists");
  const world = engine.createWorld({ seed: seed });
  const match = {
    matchId: matchId,
    status: "waiting",
    seed: seed,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    allowSelfDuel: !!opts.allowSelfDuel,
    players: { left: null, right: null },
    world: world,
    initial: captureInitial(world),
    firstSide: null,
    startedAt: null,
    turns: [],
    lastTurn: null,
    waiters: [],
  };
  matches.set(matchId, match);
  return match;
}

function emptySeat(match) {
  if (!match.players.left) return "left";
  if (!match.players.right) return "right";
  return null;
}

function oldestWaiting() {
  let best = null;
  matches.forEach(function (m) {
    if (m.status !== "waiting") return;
    if (!emptySeat(m)) return;
    if (!best || m.createdAt < best.createdAt) best = m;
  });
  return best;
}

function seatPlayer(match, side, info) {
  match.players[side] = {
    name: info.name,
    kind: info.kind || "agent",
    bot: info.bot || null,
    fn: info.fn || null,
    token: info.token,
    joinedAt: nowIso(),
  };
  match.updatedAt = nowIso();
  if (match.players.left && match.players.right) {
    match.status = match.world.over ? "finished" : "active";
    if (match.status === "active" && !match.firstSide && !match.world.history.length && !match.turns.length) {
      // Coin flip with crypto randomness (not the terrain seed) so seat order
      // can't be gamed: either seat may fire first.
      match.firstSide = engine.setFirstSide(match.world, pickFirstSide());
      match.startedAt = nowIso();
      match.initial.firstSide = match.firstSide;
    }
  } else {
    match.status = "waiting";
  }
}

function finishMatch(match) {
  if (match.world.over) {
    match.status = "finished";
    if (!match.finishedAt) match.finishedAt = nowIso();
  }
}

function packLiveTurn(match, record, agentName, taunt) {
  return {
    turnNumber: record.turnNumber,
    timestamp: nowIso(),
    side: record.side,
    agentName: agentName,
    angle: record.angle,
    power: record.power,
    weapon: record.weapon,
    taunt: taunt || null,
    windBefore: record.windBefore,
    windAfter: record.windAfter,
    trajectories: record.trajectories,
    impacts: record.impacts,
    craters: record.craters,
    damageToLeft: record.damageToLeft,
    damageToRight: record.damageToRight,
    hpBefore: record.hpBefore,
    hpAfter: record.hpAfter,
    posBefore: record.posBefore,
    posAfter: record.posAfter,
    hit: record.hit,
    skipped: record.skipped,
    error: record.error,
    timeout: record.timeout,
    ammoAfter: record.ammoAfter,
    firstSide: match.firstSide || null,
    winnerAfter: record.winnerAfter,
  };
}

const BOT_TAUNTS = {
  random: ["Yeet.", "I meant to do that.", "Physics is a suggestion."],
  naive: ["Straight at you.", "Point and shoot.", "Line of sight never lies."],
  bracketer: ["Adjusting fire.", "Short? I'll add power.", "Bracketing you in."],
  solver: ["Solved.", "The arc was inevitable.", "Wind accounted for."],
};

function botTaunt(bot, record) {
  const list = BOT_TAUNTS[bot] || BOT_TAUNTS.random;
  const pick = list[(record.turnNumber + list.length) % list.length];
  if (record.hit) return pick;
  return pick;
}

function applyFire(match, side, cmd, taunt, meta) {
  const name = match.players[side] ? match.players[side].name : side;
  const record = engine.resolveShot(match.world, cmd, Object.assign({ path: true }, meta || {}));
  const turn = packLiveTurn(match, record, name, taunt || null);
  match.turns.push(turn);
  match.lastTurn = turn;
  match.updatedAt = nowIso();
  finishMatch(match);
  persist(match);
  broadcast("turn", { matchId: match.matchId, turn: turn, state: publicState(match, { compact: false }) }, match.matchId);
  if (match.status === "finished") {
    broadcast(
      "finished",
      { matchId: match.matchId, winner: match.world.winner, state: publicState(match) },
      match.matchId
    );
  }
  notifyWaiters(match);
  return turn;
}

function runBotTurn(match) {
  if (match.status !== "active" || match.world.over) return null;
  const side = match.world.side;
  const player = match.players[side];
  if (!player || player.kind !== "bot" || !player.fn) return null;
  const snap = engine.snapshotFor(match.world, side);
  const result = engine.runBot(player.fn, snap, engine.CONSTANTS.BOT_TIME_LIMIT_MS);
  const cmd = result.cmd;
  const taunt = botTaunt(player.bot || "random", {
    turnNumber: match.world.turn,
    hit: false,
  });
  return applyFire(match, side, cmd, taunt, {
    error: result.error,
    timeout: result.timeout,
    path: true,
  });
}

function drainBots(match) {
  let guard = 0;
  while (
    match.status === "active" &&
    !match.world.over &&
    match.players[match.world.side] &&
    match.players[match.world.side].kind === "bot" &&
    guard++ < 90
  ) {
    runBotTurn(match);
  }
}

function helpJson() {
  const base = "http://" + HOST + ":" + PORT;
  return {
    name: "Bot Tanks Live Arena",
    url: base,
    cap: "Two live agents per match. A third join to the same match returns 409.",
    firstSide: "When the second seat fills, the server flips a crypto-random coin to pick who fires first (state.firstSide). Check whoseTurn — the right seat may open.",
    ammo: {
      caps: ammoCaps(),
      rule:
        "Per tank, per match: triple x" + engine.AMMO_CAPS.triple + ", blast x" + engine.AMMO_CAPS.blast +
        ", shell and roller unlimited (null = unlimited). Remaining counts are in state.players.<side>.ammo and availableWeapons. Firing an exhausted weapon returns 400 (nothing is swapped and your turn is not used).",
    },
    quickstart: [
      "POST " + base + "/api/join  { \"name\": \"YourBot\" }",
      "Save matchId, side, and token from the response.",
      "GET " + base + "/api/matches/<id>/state?wait=1&side=<side>&timeout=25  until it is your turn (and status=active). The first shooter is random (firstSide).",
      "POST " + base + "/api/matches/<id>/fire  { \"token\", \"angle\": 0-180, \"power\": 0-100, \"weapon\": \"shell|blast|triple|roller\", \"taunt\": \"optional\" }",
      "Ammo: triple x" + engine.AMMO_CAPS.triple + ", blast x" + engine.AMMO_CAPS.blast + " per match; shell/roller unlimited. Check players.<side>.ammo before firing — an empty weapon returns 400.",
      "Repeat wait + fire until winner is set. GET .../log for the full ledger.",
    ],
    cli: "node /workspace/bottanks/agent-cli.js join MyName",
    guide: "/workspace/bottanks/AGENT_PLAY.md",
    weapons: engine.WEAPON_LIST,
    angle: "0 is due right, 90 is straight up, 180 is due left",
    endpoints: [
      "POST /api/join",
      "GET /api/matches",
      "GET /api/matches/:id/state  (?compact=1, ?wait=1&side=left|right&timeout=25)",
      "POST /api/matches/:id/fire",
      "GET /api/matches/:id/log",
      "GET /api/matches/:id/stream  and  GET /api/stream",
      "POST /api/matches/:id/add-bot",
      "GET /api/health",
      "GET /api/help",
      "GET /openapi.json",
    ],
  };
}

function helpText() {
  const h = helpJson();
  return (
    "Bot Tanks Live Arena  " +
    h.url +
    "\nTwo agents per match. Drop in and duel.\n\n" +
    h.quickstart.map(function (l, i) { return "  " + (i + 1) + ". " + l; }).join("\n") +
    "\n\nCLI: " +
    h.cli +
    "\nGuide: " +
    h.guide +
    "\nAngle: " +
    h.angle +
    "\nAmmo: " +
    h.ammo.rule +
    "\nFirst shot: " +
    h.firstSide +
    "\n"
  );
}

async function handleJoin(req, res) {
  const body = await readBody(req);
  const name = String(body.name || "Agent").trim().slice(0, 40) || "Agent";
  const allowSelfDuel = !!body.allowSelfDuel;
  let match = null;
  let created = false;

  if (body.matchId) {
    const id = String(body.matchId);
    match = matches.get(id);
    if (!match) {
      match = createMatch({
        matchId: id,
        seed: body.seed,
        allowSelfDuel: allowSelfDuel,
      });
      created = true;
      broadcast("match_created", summarize(match), match.matchId);
    } else if (match.status === "finished" || !emptySeat(match)) {
      send(res, 409, { error: "Match is full — max 2 live agents", matchId: id, status: match.status });
      return;
    }
  } else {
    match = oldestWaiting();
    if (match && !allowSelfDuel && match.players.left && match.players.left.name === name && !match.players.right) {
      // Don't auto-sit in your own lobby unless you asked to.
      match = null;
    }
    if (!match) {
      match = createMatch({ seed: body.seed, allowSelfDuel: allowSelfDuel });
      created = true;
      broadcast("match_created", summarize(match), match.matchId);
    }
  }

  if (match.allowSelfDuel === false && allowSelfDuel) match.allowSelfDuel = true;

  const seat = emptySeat(match);
  if (!seat) {
    send(res, 409, { error: "Match is full — max 2 live agents", matchId: match.matchId });
    return;
  }
  if (
    !allowSelfDuel &&
    !match.allowSelfDuel &&
    ((match.players.left && match.players.left.name === name) ||
      (match.players.right && match.players.right.name === name))
  ) {
    send(res, 409, {
      error: "That name is already in this match. Pass allowSelfDuel: true to occupy both seats.",
      matchId: match.matchId,
    });
    return;
  }

  const token = makeToken();
  seatPlayer(match, seat, { name: name, kind: "agent", token: token });
  match.updatedAt = nowIso();
  persist(match);
  broadcast("player_joined", { matchId: match.matchId, side: seat, player: publicPlayer(match.players[seat]), status: match.status, state: publicState(match, { compact: true }) }, match.matchId);
  notifyWaiters(match);
  if (match.status === "active") drainBots(match);

  const oppSide = seat === "left" ? "right" : "left";
  send(res, created && seat === "left" ? 201 : 200, {
    matchId: match.matchId,
    side: seat,
    token: token,
    status: match.status,
    opponent: publicPlayer(match.players[oppSide]),
    state: publicState(match),
    instructions: joinInstructions(match, seat, token),
  });
}

async function handleFire(req, res, match) {
  const body = await readBody(req);
  const token = String(body.token || "");
  let side = null;
  if (match.players.left && match.players.left.token === token) side = "left";
  else if (match.players.right && match.players.right.token === token) side = "right";
  if (!side) {
    send(res, 403, { error: "Invalid token for this match" });
    return;
  }
  if (match.status !== "active") {
    send(res, 409, {
      error: match.status === "waiting" ? "Match is waiting for a second agent" : "Match is not active",
      status: match.status,
    });
    return;
  }
  if (match.world.over) {
    send(res, 409, { error: "Match is already finished", winner: match.world.winner });
    return;
  }
  if (match.world.side !== side) {
    send(res, 409, {
      error: "Not your turn",
      whoseTurn: match.world.side,
      turnNumber: match.world.turn,
    });
    return;
  }
  const cmd = engine.sanitizeCmd({
    angle: body.angle,
    power: body.power,
    weapon: body.weapon,
  });
  if (!cmd) {
    send(res, 400, { error: "Need numeric angle (0-180) and power (0-100)" });
    return;
  }
  const ammo = match.world[side].ammo;
  if (!engine.hasAmmo(ammo, cmd.weapon)) {
    const cap = engine.AMMO_CAPS[cmd.weapon];
    const avail = engine.availableWeapons(ammo);
    send(res, 400, {
      error:
        "Out of ammo: " + engine.WEAPONS[cmd.weapon].name + " (" + cmd.weapon + ") has 0 of " + cap +
        " left for " + side + " this match. Pick another weapon: " + avail.join(", ") + ". Your turn was not used.",
      code: "out_of_ammo",
      weapon: cmd.weapon,
      side: side,
      ammo: ammoOf(match.world, side),
      availableWeapons: avail,
      whoseTurn: match.world.side,
      turnNumber: match.world.turn,
    });
    return;
  }
  const taunt = body.taunt == null ? null : String(body.taunt).slice(0, 80);
  const turn = applyFire(match, side, cmd, taunt, { path: true });
  drainBots(match);
  send(res, 200, {
    turn: turn,
    state: publicState(match),
  });
}

async function handleAddBot(req, res, match) {
  const body = await readBody(req);
  const bot = String(body.bot || "").toLowerCase();
  if (ALLOWED_BOTS.indexOf(bot) < 0) {
    send(res, 400, { error: "bot must be one of " + ALLOWED_BOTS.join(", ") });
    return;
  }
  const seat = emptySeat(match);
  if (!seat) {
    send(res, 409, { error: "Match is full — max 2 live agents", matchId: match.matchId });
    return;
  }
  const name = String(body.name || bot[0].toUpperCase() + bot.slice(1)).trim().slice(0, 40);
  const token = makeToken();
  const fn = engine.createBot(bot, { rng: match.world.rng });
  seatPlayer(match, seat, { name: name, kind: "bot", bot: bot, token: token, fn: fn });
  persist(match);
  broadcast("player_joined", { matchId: match.matchId, side: seat, player: publicPlayer(match.players[seat]), status: match.status, state: publicState(match, { compact: true }) }, match.matchId);
  drainBots(match);
  notifyWaiters(match);
  send(res, 200, {
    matchId: match.matchId,
    side: seat,
    status: match.status,
    bot: bot,
    name: name,
    state: publicState(match),
  });
}

function handleState(req, res, match, query) {
  const compact = query.get("compact") === "1";
  const wait = query.get("wait") === "1";
  const side = query.get("side") === "right" ? "right" : query.get("side") === "left" ? "left" : null;
  if (!wait) {
    send(res, 200, publicState(match, { compact: compact }));
    return;
  }
  if (!side) {
    send(res, 400, { error: "wait=1 requires side=left or side=right" });
    return;
  }
  const timeout = Math.max(1, Math.min(60, Number(query.get("timeout") || 25) || 25));
  const ready =
    match.status === "finished" ||
    match.world.over ||
    (match.status === "active" && match.world.side === side);
  if (ready) {
    send(res, 200, publicState(match, { compact: compact }));
    return;
  }
  let settled = false;
  const waiter = {
    side: side,
    opts: { compact: compact },
    timer: null,
    resolve: function (state) {
      if (settled) return;
      settled = true;
      send(res, 200, state);
    },
  };
  waiter.timer = setTimeout(function () {
    match.waiters = match.waiters.filter(function (w) { return w !== waiter; });
    waiter.resolve(publicState(match, { compact: compact }));
  }, timeout * 1000);
  match.waiters.push(waiter);
  req.on("close", function () {
    if (settled) return;
    settled = true;
    clearTimeout(waiter.timer);
    match.waiters = match.waiters.filter(function (w) { return w !== waiter; });
  });
}

function handleLog(res, match) {
  send(res, 200, {
    matchId: match.matchId,
    status: match.status,
    seed: match.seed,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    finishedAt: match.finishedAt,
    players: {
      left: publicPlayer(match.players.left),
      right: publicPlayer(match.players.right),
    },
    winner: match.world.winner,
    firstSide: match.firstSide || null,
    startedAt: match.startedAt || null,
    ammoCaps: ammoCaps(),
    ammo: { left: ammoOf(match.world, "left"), right: ammoOf(match.world, "right") },
    turnCount: match.turns.length,
    turns: match.turns,
    initial: match.initial,
    summary: summarize(match),
  });
}

function handleStream(req, res, matchId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("retry: 2000\n\n");
  const client = { res: res, matchId: matchId || null };
  sseClients.add(client);
  if (matchId) {
    const match = matches.get(matchId);
    if (match) sseWrite(client, "snapshot", { matchId: match.matchId, state: publicState(match), summary: summarize(match), turns: match.turns });
    else sseWrite(client, "error", { error: "Match not found", matchId: matchId });
  } else {
    const list = [];
    matches.forEach(function (m) { list.push(summarize(m)); });
    list.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    sseWrite(client, "snapshot", { matches: list });
  }
  const beat = setInterval(function () {
    try { res.write(": ping\n\n"); } catch (e) { /* ignore */ }
  }, 15000);
  req.on("close", function () {
    clearInterval(beat);
    sseClients.delete(client);
  });
}

function health() {
  let waiting = 0, active = 0, finished = 0;
  matches.forEach(function (m) {
    if (m.status === "waiting") waiting++;
    else if (m.status === "active") active++;
    else finished++;
  });
  return {
    ok: true,
    port: PORT,
    url: "http://" + HOST + ":" + PORT,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
    matches: { waiting: waiting, active: active, finished: finished, total: matches.size },
  };
}

function publicBaseUrl(req) {
  if (process.env.PUBLIC_URL) {
    return String(process.env.PUBLIC_URL).replace(/\/$/, "");
  }
  const xfProto = req && req.headers && req.headers["x-forwarded-proto"];
  const proto = String(xfProto || "http").split(",")[0].trim() || "http";
  const xfHost = req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host);
  const host = String(xfHost || HOST + ":" + PORT).split(",")[0].trim();
  return proto + "://" + host;
}

function openapiSpec(req) {
  const angleDesc =
    "Launch angle in degrees. 0° is due right, 90° is straight up, 180° is due left. Left tank typically aims 5°–85°; right tank typically aims 95°–175°.";
  const powerDesc =
    "Shot power from 10 to 100 (100 is maximum muzzle speed). Values are clamped to the legal range.";
  const weaponDesc =
    "Weapon id: shell (standard, unlimited), blast (big crater and damage, " + engine.AMMO_CAPS.blast +
    " per match), triple (three projectiles, " + engine.AMMO_CAPS.triple +
    " per match), or roller (trench, unlimited). Ammo is per tank per match; check players.<side>.ammo / availableWeapons in getMatchState. Firing an exhausted weapon returns 400 and does not use your turn.";
  const firstDesc =
    "Who fires first is chosen at random (crypto coin flip) when the second seat fills; see firstSide and whoseTurn. Either seat may open.";
  const idParam = {
    name: "id",
    in: "path",
    required: true,
    description: "Match id, for example m_abc123.",
    schema: { type: "string" },
  };
  const errSchema = {
    type: "object",
    properties: {
      error: { type: "string" },
      matchId: { type: "string" },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Bot Tanks Live Arena",
      version: "1.0.0",
      description:
        "Turn-based artillery duel for two live agents. Import this document as a ChatGPT Custom GPT Action. Angle: 0° right, 90° up, 180° left. Power: 10–100. Weapons: shell, blast, triple, roller. Ammo caps per tank per match: triple x" + engine.AMMO_CAPS.triple + ", blast x" + engine.AMMO_CAPS.blast + ", shell and roller unlimited. The first shooter is random (firstSide). Join, wait until it is your turn, then fire.",
    },
    servers: [{ url: publicBaseUrl(req), description: "This arena server" }],
    paths: {
      "/api/matches": {
        get: {
          operationId: "listMatches",
          summary: "List matches",
          description: "List waiting, active, and finished matches in this arena (newest first).",
          responses: {
            "200": {
              description: "Match lobby list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      matches: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/join": {
        post: {
          operationId: "joinMatch",
          summary: "Join a match",
          description:
            "Sit in a seat. Omit matchId to join the oldest waiting match, or to open a new lobby. The first agent is left; the second is right and the match becomes active. " + firstDesc + " A third join to a full match returns 409. Save matchId, side, and token from the response — the token is required to fire.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", description: "Agent or player display name (max 40 characters).", maxLength: 40 },
                    matchId: { type: "string", description: "Optional existing or chosen match id." },
                    seed: { type: "integer", description: "Optional terrain seed when opening a new match." },
                    allowSelfDuel: { type: "boolean", description: "Set true to occupy both seats with the same name." },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Joined an existing waiting match (usually as right). Returns matchId, side, token, status, and state." },
            "201": { description: "Opened a new waiting match as left. Returns matchId, side, token, status, and state." },
            "409": { description: "Match is full or the name is already seated.", content: { "application/json": { schema: errSchema } } },
          },
        },
      },
      "/api/matches/{id}/state": {
        get: {
          operationId: "getMatchState",
          summary: "Get match state",
          description:
            "Current wind, gravity, both tanks' exact (x, y), HP and remaining ammo (players.<side>.ammo: counts per weapon, null = unlimited; players.<side>.availableWeapons), firstSide, whose turn it is, and the last shot. " + firstDesc + " Add wait=1&side=left|right to long-poll until it is that side's turn or the match ends (timeout defaults to 25 seconds). Add compact=1 to omit full terrain.",
          parameters: [
            idParam,
            { name: "compact", in: "query", schema: { type: "string" }, description: "Set to 1 to omit the full terrain array." },
            { name: "wait", in: "query", schema: { type: "string" }, description: "Set to 1 to block until it is `side`'s turn or the match finishes." },
            { name: "side", in: "query", schema: { type: "string", enum: ["left", "right"] }, description: "Required with wait=1." },
            { name: "timeout", in: "query", schema: { type: "integer" }, description: "Long-poll timeout in seconds (default 25)." },
          ],
          responses: {
            "200": {
              description: "Public match state, including wind, gravity, tank positions, HP, ammo, firstSide, whoseTurn, and lastTurn.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      matchId: { type: "string" },
                      status: { type: "string", enum: ["waiting", "active", "finished"] },
                      whoseTurn: { type: ["string", "null"], enum: ["left", "right", null], description: "Side that must fire now (null while waiting or after the match ends)." },
                      firstSide: { type: ["string", "null"], enum: ["left", "right", null], description: firstDesc },
                      ammoCaps: { type: "object", description: "Starting ammo per weapon per tank (null = unlimited).", additionalProperties: { type: ["integer", "null"] } },
                      players: {
                        type: "object",
                        description: "players.left / players.right: name, x, y, hp, maxHp, ammo (remaining per weapon, null = unlimited), availableWeapons.",
                      },
                    },
                  },
                },
              },
            },
            "404": { description: "Match not found", content: { "application/json": { schema: errSchema } } },
          },
        },
      },
      "/api/matches/{id}/fire": {
        post: {
          operationId: "fireShot",
          summary: "Fire a shot",
          description:
            "Fire on your turn. " + angleDesc + " " + powerDesc + " " + weaponDesc + " Include the token from join. Out-of-turn shots return 409.",
          parameters: [idParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["token", "angle", "power"],
                  properties: {
                    token: { type: "string", description: "Secret seat token returned by joinMatch." },
                    angle: { type: "number", minimum: 0, maximum: 180, description: angleDesc },
                    power: { type: "number", minimum: 10, maximum: 100, description: powerDesc },
                    weapon: { type: "string", enum: ["shell", "blast", "triple", "roller"], description: weaponDesc, default: "shell" },
                    taunt: { type: "string", description: "Optional short taunt shown as a speech bubble.", maxLength: 140 },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Turn receipt plus the updated public state." },
            "400": { description: "Bad angle/power, or the chosen weapon is out of ammo (code: out_of_ammo, with ammo and availableWeapons). Nothing is fired and your turn is not used.", content: { "application/json": { schema: errSchema } } },
            "403": { description: "Invalid token for this match.", content: { "application/json": { schema: errSchema } } },
            "409": { description: "Not your turn, match not active, or invalid token.", content: { "application/json": { schema: errSchema } } },
            "404": { description: "Match not found", content: { "application/json": { schema: errSchema } } },
          },
        },
      },
      "/api/matches/{id}/log": {
        get: {
          operationId: "getMatchLog",
          summary: "Get the full turn ledger",
          description: "Full history of the match: players, initial terrain, every turn (angle, power, weapon, wind, damage, HP before/after, trajectories), and the winner.",
          parameters: [idParam],
          responses: {
            "200": { description: "Match log with turns and initial state." },
            "404": { description: "Match not found", content: { "application/json": { schema: errSchema } } },
          },
        },
      },
      "/api/matches/{id}/add-bot": {
        post: {
          operationId: "addBot",
          summary: "Fill the empty seat with a built-in bot",
          description: "Seat a built-in bot (random, naive, bracketer, or solver) in the empty chair. Useful when a second live agent does not show. The bot will fire automatically on its turns.",
          parameters: [idParam],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    bot: { type: "string", enum: ["random", "naive", "bracketer", "solver"], default: "solver" },
                    name: { type: "string", description: "Optional display name for the bot." },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Bot seated; match may now be active." },
            "409": { description: "No empty seat or invalid bot.", content: { "application/json": { schema: errSchema } } },
            "404": { description: "Match not found", content: { "application/json": { schema: errSchema } } },
          },
        },
      },
    },
  };
}

function worldFromSaved(data) {
  const world = engine.createWorld({ seed: (data.seed || 0) >>> 0 });
  const fin = data.final || {};
  const init = data.initial || {};
  if (Array.isArray(fin.terrain)) world.terrain = fin.terrain.slice();
  else if (Array.isArray(init.terrain)) world.terrain = init.terrain.slice();
  const L = fin.left || init.left;
  const R = fin.right || init.right;
  if (L) {
    if (L.x != null) world.left.x = L.x;
    if (L.y != null) world.left.y = L.y;
    if (L.hp != null) world.left.hp = L.hp;
    if (L.maxHp != null) world.left.maxHp = L.maxHp;
  }
  if (R) {
    if (R.x != null) world.right.x = R.x;
    if (R.y != null) world.right.y = R.y;
    if (R.hp != null) world.right.hp = R.hp;
    if (R.maxHp != null) world.right.maxHp = R.maxHp;
  }
  if (fin.wind != null) world.wind = fin.wind;
  else if (init.wind != null) world.wind = init.wind;
  if (init.gravity != null) world.gravity = init.gravity;
  if (fin.turnNumber != null) world.turn = fin.turnNumber;
  if (fin.stats) world.stats = fin.stats;
  const turns = Array.isArray(data.turns) ? data.turns : [];
  const first = data.firstSide === "right" || data.firstSide === "left"
    ? data.firstSide
    : (turns.length ? turns[0].side : "left");
  world.firstSide = first;
  if (fin.side === "left" || fin.side === "right") world.side = fin.side;
  else world.side = turns.length % 2 === 0 ? first : (first === "left" ? "right" : "left");
  ["left", "right"].forEach(function (side) {
    const saved = fin[side] && fin[side].ammo;
    if (saved && typeof saved === "object") {
      world[side].ammo = engine.copyAmmo(saved);
    } else {
      // Older saves: rebuild remaining ammo from the turn ledger.
      const ammo = engine.initialAmmo();
      turns.forEach(function (t) {
        if (t.side === side && !t.skipped && ammo[t.weapon] != null && ammo[t.weapon] > 0) ammo[t.weapon] -= 1;
      });
      world[side].ammo = ammo;
    }
  });
  world.winner = data.winner || null;
  world.over = data.status === "finished" || !!world.winner;
  return world;
}

function hydrateMatch(data) {
  if (!data || !data.matchId) return null;
  const match = {
    matchId: data.matchId,
    status: data.status || "finished",
    seed: data.seed,
    createdAt: data.createdAt || nowIso(),
    updatedAt: data.updatedAt || data.createdAt || nowIso(),
    finishedAt: data.finishedAt || null,
    allowSelfDuel: true,
    players: {
      left: data.players && data.players.left
        ? Object.assign({}, data.players.left, { token: null })
        : null,
      right: data.players && data.players.right
        ? Object.assign({}, data.players.right, { token: null })
        : null,
    },
    world: worldFromSaved(data),
    firstSide: data.firstSide || (Array.isArray(data.turns) && data.turns.length ? data.turns[0].side : null),
    startedAt: data.startedAt || null,
    initial: data.initial || captureInitial(engine.createWorld({ seed: (data.seed || 0) >>> 0 })),
    turns: Array.isArray(data.turns) ? data.turns : [],
    lastTurn: null,
    waiters: [],
    persisted: true,
  };
  match.lastTurn = match.turns.length ? match.turns[match.turns.length - 1] : null;
  matches.set(match.matchId, match);
  return match;
}

function loadOnePersisted(id) {
  if (!id || /[^A-Za-z0-9_-]/.test(id)) return null;
  const file = path.join(MATCH_DIR, id + ".json");
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.matchId && data.matchId !== id) data.matchId = id;
    return hydrateMatch(data);
  } catch (err) {
    console.error("Failed to load match " + id + ":", err.message);
    return null;
  }
}

function loadPersistedMatches() {
  if (!fs.existsSync(MATCH_DIR)) return 0;
  let n = 0;
  fs.readdirSync(MATCH_DIR).forEach(function (name) {
    if (!name.endsWith(".json")) return;
    const id = name.slice(0, -5);
    if (matches.has(id)) return;
    if (loadOnePersisted(id)) n++;
  });
  return n;
}

function findMatch(id, res) {
  let match = matches.get(id);
  if (!match) match = loadOnePersisted(id);
  if (!match) {
    send(res, 404, { error: "Match not found", matchId: id });
    return null;
  }
  return match;
}

async function route(req, res) {
  const url = new URL(req.url, "http://" + HOST + ":" + PORT);
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (p === "/" || p === "/bottanks.html")) {
    if (!fs.existsSync(HTML_FILE)) {
      send(res, 404, { error: "bottanks.html missing" });
      return;
    }
    const html = fs.readFileSync(HTML_FILE);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(html);
    return;
  }

  if (req.method === "GET" && (p === "/openapi.json" || p === "/api/openapi.json")) {
    send(res, 200, openapiSpec(req));
    return;
  }
  if (req.method === "GET" && p === "/api/health") {
    send(res, 200, health());
    return;
  }
  if (req.method === "GET" && p === "/api/help") {
    const accept = String(req.headers.accept || "");
    if (accept.indexOf("text/plain") >= 0 && accept.indexOf("application/json") < 0) {
      send(res, 200, helpText(), { "Content-Type": "text/plain; charset=utf-8" });
    } else {
      send(res, 200, helpJson());
    }
    return;
  }
  if (req.method === "GET" && p === "/api/matches") {
    const list = [];
    matches.forEach(function (m) { list.push(summarize(m)); });
    list.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    send(res, 200, { matches: list });
    return;
  }
  if (req.method === "POST" && p === "/api/join") {
    await handleJoin(req, res);
    return;
  }
  if (req.method === "GET" && p === "/api/stream") {
    handleStream(req, res, null);
    return;
  }

  const mState = p.match(/^\/api\/matches\/([^/]+)\/state$/);
  if (req.method === "GET" && mState) {
    const match = findMatch(decodeURIComponent(mState[1]), res);
    if (match) handleState(req, res, match, url.searchParams);
    return;
  }
  const mFire = p.match(/^\/api\/matches\/([^/]+)\/fire$/);
  if (req.method === "POST" && mFire) {
    const match = findMatch(decodeURIComponent(mFire[1]), res);
    if (match) await handleFire(req, res, match);
    return;
  }
  const mLog = p.match(/^\/api\/matches\/([^/]+)\/log$/);
  if (req.method === "GET" && mLog) {
    const match = findMatch(decodeURIComponent(mLog[1]), res);
    if (match) handleLog(res, match);
    return;
  }
  const mStream = p.match(/^\/api\/matches\/([^/]+)\/stream$/);
  if (req.method === "GET" && mStream) {
    handleStream(req, res, decodeURIComponent(mStream[1]));
    return;
  }
  const mBot = p.match(/^\/api\/matches\/([^/]+)\/add-bot$/);
  if (req.method === "POST" && mBot) {
    const match = findMatch(decodeURIComponent(mBot[1]), res);
    if (match) await handleAddBot(req, res, match);
    return;
  }
  const mOne = p.match(/^\/api\/matches\/([^/]+)$/);
  if (req.method === "GET" && mOne) {
    const match = findMatch(decodeURIComponent(mOne[1]), res);
    if (match) send(res, 200, summarize(match));
    return;
  }

  send(res, 404, { error: "Not found", path: p, help: "/api/help" });
}

const server = http.createServer(function (req, res) {
  Promise.resolve()
    .then(function () { return route(req, res); })
    .catch(function (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err.message === "Invalid JSON body" ? 400 : 500;
      send(res, status, { error: err.message || "Server error" });
    });
});

function writeServerJson() {
  const info = {
    port: PORT,
    url: "http://" + HOST + ":" + PORT,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
  };
  fs.writeFileSync(SERVER_JSON, JSON.stringify(info, null, 2));
  return info;
}

if (require.main === module) {
  const loaded = loadPersistedMatches();
  server.listen(PORT, HOST, function () {
    const info = writeServerJson();
    console.log("Bot Tanks live arena at " + info.url + "  pid " + info.pid + (loaded ? "  loaded " + loaded + " saved match(es)" : ""));
  });
  server.on("error", function (err) {
    console.error("Server failed:", err.message);
    process.exit(1);
  });
  process.on("SIGINT", function () { server.close(function () { process.exit(0); }); });
  process.on("SIGTERM", function () { server.close(function () { process.exit(0); }); });
}

module.exports = {
  server: server,
  start: function (cb) {
    loadPersistedMatches();
    server.listen(PORT, HOST, function () {
      const info = writeServerJson();
      if (cb) cb(info);
    });
    return server;
  },
  loadPersistedMatches: loadPersistedMatches,
  openapiSpec: openapiSpec,
  writeServerJson: writeServerJson,
};

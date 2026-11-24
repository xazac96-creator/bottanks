#!/usr/bin/env node
"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const engine = require("./engine.js");

const PORT = Number(process.env.TEST_PORT || 18787);
const HOST = "127.0.0.1";
const BASE = "http://" + HOST + ":" + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bottanks-test-"));
const MATCH_DIR = path.join(TMP, "matches");
const SERVER_JSON = path.join(TMP, "server.json");
const CLI = path.join(__dirname, "agent-cli.js");
const SERVER = path.join(__dirname, "server.js");

let failed = 0;
const results = [];
function pass(name, detail) {
  results.push({ name: name, ok: true, detail: detail });
  console.log("PASS  " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  failed++;
  results.push({ name: name, ok: false, detail: detail });
  console.log("FAIL  " + name + " — " + detail);
}

function request(method, urlPath, body, timeoutMs, extraHeaders) {
  return new Promise(function (resolve, reject) {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        method: method,
        hostname: HOST,
        port: PORT,
        path: urlPath,
        headers: Object.assign(
          { Accept: "application/json" },
          payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {},
          extraHeaders || {}
        ),
        timeout: timeoutMs || 20000,
      },
      function (res) {
        const chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = raw;
          try { data = JSON.parse(raw); } catch (e) { /* text */ }
          resolve({ status: res.statusCode, headers: res.headers, data: data, raw: raw });
        });
      }
    );
    req.on("timeout", function () { req.destroy(); reject(new Error("timeout " + urlPath)); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function startServer() {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [SERVER], {
      cwd: __dirname,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        HOST: HOST,
        BOTTANKS_MATCH_DIR: MATCH_DIR,
        BOTTANKS_SERVER_JSON: SERVER_JSON,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const onOut = function (d) {
      buf += d.toString();
      if (buf.indexOf("live arena") >= 0 || buf.indexOf("listening") >= 0) {
        child.stdout.off("data", onOut);
        resolve(child);
      }
    };
    child.stdout.on("data", onOut);
    child.stderr.on("data", function (d) { buf += d.toString(); });
    child.on("exit", function (code) {
      reject(new Error("server exited early " + code + " " + buf));
    });
    setTimeout(function () {
      // Try health even if banner missed
      request("GET", "/api/health")
        .then(function () { resolve(child); })
        .catch(function () { reject(new Error("server did not start: " + buf)); });
    }, 1500);
  });
}

function cli() {
  const args = ["--url", BASE].concat([].slice.call(arguments));
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [CLI].concat(args), { cwd: __dirname });
    let out = "", err = "";
    child.stdout.on("data", function (d) { out += d; });
    child.stderr.on("data", function (d) { err += d; });
    child.on("close", function (code) {
      let data = out;
      try { data = JSON.parse(out); } catch (e) { /* text */ }
      resolve({ code: code, data: data, out: out, err: err });
    });
    child.on("error", reject);
  });
}

function listenSse(urlPath, ms) {
  return new Promise(function (resolve, reject) {
    const events = [];
    const req = http.get(BASE + urlPath, function (res) {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", function (chunk) {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { event: "message", data: null };
          block.split("\n").forEach(function (line) {
            if (line.startsWith("event:")) ev.event = line.slice(6).trim();
            else if (line.startsWith("data:")) {
              try { ev.data = JSON.parse(line.slice(5).trim()); }
              catch (e) { ev.data = line.slice(5).trim(); }
            }
          });
          if (ev.data != null) events.push(ev);
        }
      });
    });
    req.on("error", reject);
    setTimeout(function () {
      req.destroy();
      resolve(events);
    }, ms);
  });
}

function snapFromState(state, side) {
  const own = state.players[side];
  const opp = state.players[side === "left" ? "right" : "left"];
  return {
    terrain: state.terrain,
    field: state.field,
    own: { x: own.x, y: own.y, hp: own.hp, maxHp: own.maxHp, side: side, ammo: own.ammo },
    opponent: { x: opp.x, y: opp.y, hp: opp.hp, maxHp: opp.maxHp, ammo: opp.ammo },
    wind: state.wind,
    gravity: state.gravity,
    weapons: state.weapons,
    shotHistory: [],
    allShots: [],
    turn: state.turnNumber,
    time: state.turnCount,
  };
}

// Re-simulate a saved match from its seed + firstSide + recorded shots and
// check every turn's HP and ammo match the ledger.
function replayMatches(saved) {
  const world = engine.createWorld({ seed: saved.seed, firstSide: saved.firstSide || "left" });
  for (let i = 0; i < saved.turns.length; i++) {
    const t = saved.turns[i];
    if (world.side !== t.side) return "turn " + t.turnNumber + " side " + world.side + " != " + t.side;
    const rec = engine.resolveShot(world, t.skipped ? null : { angle: t.angle, power: t.power, weapon: t.weapon }, { path: false });
    if (Math.abs(rec.hpAfter.left - t.hpAfter.left) > 1e-9 || Math.abs(rec.hpAfter.right - t.hpAfter.right) > 1e-9) {
      return "turn " + t.turnNumber + " hp " + JSON.stringify(rec.hpAfter) + " != " + JSON.stringify(t.hpAfter);
    }
    if (t.ammoAfter && JSON.stringify(rec.ammoAfter) !== JSON.stringify(t.ammoAfter)) {
      return "turn " + t.turnNumber + " ammo " + JSON.stringify(rec.ammoAfter) + " != " + JSON.stringify(t.ammoAfter);
    }
  }
  if ((world.winner || null) !== (saved.winner || null)) return "winner " + world.winner + " != " + saved.winner;
  return null;
}

// Harmless shot straight off the near edge (no damage) for the given side.
function offscreen(side, weapon) {
  return { angle: side === "left" ? 175 : 5, power: 100, weapon: weapon || "shell" };
}

async function main() {
  fs.mkdirSync(MATCH_DIR, { recursive: true });
  let child;
  try {
    child = await startServer();
  } catch (err) {
    fail("start test server", err.message);
    process.exit(1);
  }
  child.on("exit", function () { /* ignore later */ });

  try {
    const health = await request("GET", "/api/health");
    if (health.status === 200 && health.data.ok && health.data.port === PORT) {
      pass("GET /api/health", "pid " + health.data.pid + " url " + health.data.url);
    } else fail("GET /api/health", JSON.stringify(health.data));

    const sj = JSON.parse(fs.readFileSync(SERVER_JSON, "utf8"));
    if (sj.port === PORT && sj.pid && sj.url && sj.startedAt) {
      pass("server.json written", JSON.stringify(sj));
    } else fail("server.json written", JSON.stringify(sj));

    const help = await request("GET", "/api/help");
    if (help.status === 200 && help.data.quickstart && help.data.quickstart.length) {
      pass("GET /api/help", help.data.name + " · " + help.data.quickstart.length + " steps");
    } else fail("GET /api/help", JSON.stringify(help.data).slice(0, 200));

    const home = await request("GET", "/");
    const isHtml = home.status === 200 && /<canvas id="field"/.test(home.raw) && /Live Arena/.test(home.raw);
    if (isHtml) pass("GET / serves bottanks.html", "bytes " + home.raw.length);
    else fail("GET / serves bottanks.html", "status " + home.status + " len " + (home.raw && home.raw.length));

    const requiredUi = [
      "Join Live Match", "Fire Shot", "Leave Seat", "Match Telemetry",
      "livePlayerName", "liveJoinMatchId", "btnJoinLive", "liveTelemetry",
      "liveAngle", "livePower", "liveWeapon", "liveTaunt", "btnLiveFire", "btnLeaveSeat",
    ];
    const missingUi = requiredUi.filter(function (t) { return home.raw.indexOf(t) < 0; });
    if (home.status === 200 && missingUi.length === 0) {
      pass("GET / HTML has Live Arena player controls", requiredUi.length + " markers present");
    } else {
      fail("GET / HTML has Live Arena player controls", "missing " + missingUi.join(", "));
    }

    try {
      const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let sm;
      let scriptCount = 0;
      while ((sm = scriptRe.exec(home.raw))) {
        if (/\bsrc\s*=/.test(sm[1] || "")) continue;
        new vm.Script(sm[2], { filename: "bottanks-inline-" + (++scriptCount) + ".js" });
      }
      if (scriptCount >= 1) pass("inline <script> parses cleanly", "scripts=" + scriptCount);
      else fail("inline <script> parses cleanly", "no inline scripts found");
    } catch (err) {
      fail("inline <script> parses cleanly", err.message);
    }

    const spec = await request("GET", "/openapi.json");
    const paths = spec.data && spec.data.paths;
    const needed = [
      "/api/matches",
      "/api/join",
      "/api/matches/{id}/state",
      "/api/matches/{id}/fire",
      "/api/matches/{id}/log",
      "/api/matches/{id}/add-bot",
    ];
    const ops = {
      "/api/matches": "listMatches",
      "/api/join": "joinMatch",
      "/api/matches/{id}/state": "getMatchState",
      "/api/matches/{id}/fire": "fireShot",
      "/api/matches/{id}/log": "getMatchLog",
      "/api/matches/{id}/add-bot": "addBot",
    };
    const missingPaths = needed.filter(function (k) { return !paths || !paths[k]; });
    const missingOps = needed.filter(function (k) {
      if (!paths || !paths[k]) return true;
      const item = paths[k];
      const op = item.get || item.post;
      return !op || op.operationId !== ops[k];
    });
    const defaultUrl = spec.data && spec.data.servers && spec.data.servers[0] && spec.data.servers[0].url;
    const localUrlOk = defaultUrl === BASE || defaultUrl === "http://127.0.0.1:" + PORT;
    if (
      spec.status === 200 &&
      spec.data.openapi === "3.1.0" &&
      missingPaths.length === 0 &&
      missingOps.length === 0 &&
      localUrlOk
    ) {
      pass("GET /openapi.json OpenAPI 3.1.0", "servers[0].url=" + defaultUrl + " ops=" + Object.keys(ops).length);
    } else {
      fail(
        "GET /openapi.json OpenAPI 3.1.0",
        "status=" + spec.status + " openapi=" + (spec.data && spec.data.openapi) +
        " url=" + defaultUrl + " missingPaths=" + missingPaths.join(",") +
        " missingOps=" + missingOps.join(",")
      );
    }

    const specFwd = await request("GET", "/openapi.json", null, 20000, {
      Host: "arena.example:8443",
      "X-Forwarded-Proto": "https",
    });
    const fwdUrl = specFwd.data && specFwd.data.servers && specFwd.data.servers[0] && specFwd.data.servers[0].url;
    if (specFwd.status === 200 && fwdUrl === "https://arena.example:8443") {
      pass("openapi servers[0].url follows Host and X-Forwarded-Proto", fwdUrl);
    } else {
      fail("openapi servers[0].url follows Host and X-Forwarded-Proto", "url=" + fwdUrl + " status=" + specFwd.status);
    }

    const opt = await request("OPTIONS", "/api/join");
    const h = opt.headers || {};
    const origin = h["access-control-allow-origin"];
    const methods = String(h["access-control-allow-methods"] || "");
    const allowHeaders = String(h["access-control-allow-headers"] || "");
    const methodsOk = /GET/i.test(methods) && /POST/i.test(methods) && /OPTIONS/i.test(methods);
    const headersOk = /content-type/i.test(allowHeaders);
    if ((opt.status === 204 || opt.status === 200) && origin === "*" && methodsOk && headersOk) {
      pass("OPTIONS /api/join CORS headers", "status " + opt.status + " methods " + methods);
    } else {
      fail(
        "OPTIONS /api/join CORS headers",
        "status=" + opt.status + " origin=" + origin + " methods=" + methods + " headers=" + allowHeaders
      );
    }

    const a = await request("POST", "/api/join", { name: "Alpha", seed: 11 });
    if (a.status === 201 && a.data.side === "left" && a.data.status === "waiting" && a.data.token && a.data.matchId) {
      pass("first agent joins left / waiting", a.data.matchId);
    } else fail("first agent joins left / waiting", JSON.stringify(a.data));
    const matchId = a.data.matchId;
    const tokenA = a.data.token;

    const b = await request("POST", "/api/join", { name: "Bravo" });
    if (b.status === 200 && b.data.matchId === matchId && b.data.side === "right" && b.data.status === "active") {
      pass("second agent joins right / active", "opponent " + (b.data.opponent && b.data.opponent.name));
    } else fail("second agent joins right / active", JSON.stringify(b.data));
    const tokenB = b.data.token;
    const firstSide = b.data.state && b.data.state.firstSide;
    if ((firstSide === "left" || firstSide === "right") && b.data.state.whoseTurn === firstSide) {
      pass("match start records random firstSide and whoseTurn", "firstSide=" + firstSide);
    } else fail("match start records random firstSide and whoseTurn", JSON.stringify(b.data.state && { f: b.data.state.firstSide, w: b.data.state.whoseTurn }));
    const openerSide = firstSide === "right" ? "right" : "left";
    const waiterSide = openerSide === "left" ? "right" : "left";
    const sideTokens = { left: tokenA, right: tokenB };

    const c = await request("POST", "/api/join", { name: "Charlie", matchId: matchId });
    if (c.status === 409 && /full/i.test(JSON.stringify(c.data))) {
      pass("third agent 409 on same match", JSON.stringify(c.data.error));
    } else fail("third agent 409 on same match", "status " + c.status + " " + JSON.stringify(c.data));

    const c2 = await request("POST", "/api/join", { name: "Delta" });
    if (c2.status === 201 && c2.data.matchId !== matchId && c2.data.side === "left") {
      pass("third agent without matchId opens a new lobby", c2.data.matchId);
    } else fail("third agent without matchId opens a new lobby", JSON.stringify(c2.data));

    const ot = await request("POST", "/api/matches/" + matchId + "/fire", {
      token: sideTokens[waiterSide], angle: waiterSide === "right" ? 120 : 60, power: 60, weapon: "shell",
    });
    if (ot.status === 409 && /not your turn/i.test(JSON.stringify(ot.data))) {
      pass("out-of-turn fire 409", "whoseTurn " + ot.data.whoseTurn);
    } else fail("out-of-turn fire 409", "status " + ot.status + " " + JSON.stringify(ot.data));

    // Long-poll: the non-opener waits, the opener fires, wait returns the waiter's turn
    const waitP = request("GET", "/api/matches/" + matchId + "/state?wait=1&side=" + waiterSide + "&timeout=25", null, 30000);
    await sleep(150);
    const fireA = await request("POST", "/api/matches/" + matchId + "/fire", {
      token: sideTokens[openerSide], angle: openerSide === "left" ? 50 : 130, power: 70, weapon: "shell", taunt: "Opening salvo.",
    });
    if (fireA.status !== 200) fail("opening shot by firstSide", JSON.stringify(fireA.data));
    else pass("opening shot by firstSide", openerSide + " turn " + fireA.data.turn.turnNumber + " weapon " + fireA.data.turn.weapon + " taunt " + fireA.data.turn.taunt);
    const waited = await waitP;
    if (waited.status === 200 && (waited.data.whoseTurn === waiterSide || waited.data.over)) {
      pass("long-poll wait=1 returns on turn change", "whoseTurn " + waited.data.whoseTurn + " lastTurn side " + (waited.data.lastTurn && waited.data.lastTurn.side));
    } else fail("long-poll wait=1 returns on turn change", "status " + waited.status + " " + JSON.stringify(waited.data).slice(0, 300));

    // SSE while we finish the duel
    const ssePromise = listenSse("/api/matches/" + matchId + "/stream", 8000);

    const weapons = ["blast", "triple", "roller", "shell", "blast", "shell"];
    const solvers = { left: engine.createBot("solver"), right: engine.createBot("solver") };
    const tokens = { left: tokenA, right: tokenB };
    const names = { left: "Alpha", right: "Bravo" };
    let safety = 0;
    let usedWeapons = { shell: 1, blast: 0, triple: 0, roller: 0 };
    let tauntCount = 1;
    let state = (await request("GET", "/api/matches/" + matchId + "/state")).data;
    while (!state.over && safety++ < 80) {
      const side = state.whoseTurn;
      const cmd = solvers[side](snapFromState(state, side));
      if (weapons.length) {
        cmd.weapon = weapons.shift();
      }
      if (!engine.hasAmmo(state.players[side].ammo, cmd.weapon)) {
        fail("bot respects ammo in live duel", side + " chose empty " + cmd.weapon);
        break;
      }
      usedWeapons[cmd.weapon] = (usedWeapons[cmd.weapon] || 0) + 1;
      const taunt = names[side] + " fires " + cmd.weapon + " #" + state.turnNumber;
      const fired = await request("POST", "/api/matches/" + matchId + "/fire", {
        token: tokens[side],
        angle: cmd.angle,
        power: cmd.power,
        weapon: cmd.weapon,
        taunt: taunt,
      });
      if (fired.status !== 200) {
        fail("live duel shot", "status " + fired.status + " " + JSON.stringify(fired.data));
        break;
      }
      tauntCount++;
      if (!fired.data.turn.trajectories || !fired.data.turn.trajectories.length) {
        fail("turn receipt has trajectories", "turn " + fired.data.turn.turnNumber);
      }
      if (!fired.data.turn.hpBefore || !fired.data.turn.hpAfter) {
        fail("turn receipt has hp before/after", "turn " + fired.data.turn.turnNumber);
      }
      state = fired.data.state;
    }
    if (state.over && state.winner) {
      const kinds = Object.keys(usedWeapons).filter(function (k) { return usedWeapons[k] > 0; });
      pass(
        "full live duel completes",
        "winner=" + state.winner + " turns=" + state.turnCount + " weapons=" + kinds.join(",") + " taunts=" + tauntCount
      );
    } else {
      fail("full live duel completes", "over=" + state.over + " winner=" + state.winner + " turns=" + state.turnCount);
    }

    const log = await request("GET", "/api/matches/" + matchId + "/log");
    const logOk =
      log.status === 200 &&
      log.data.turns &&
      log.data.turns.length === state.turnCount &&
      log.data.turns.every(function (t) {
        return t.turnNumber && t.agentName && t.timestamp && ("windBefore" in t) && ("hpBefore" in t) && ("hpAfter" in t) && Array.isArray(t.trajectories);
      }) &&
      log.data.turns.some(function (t) { return t.taunt; }) &&
      log.data.turns.some(function (t) { return t.weapon === "blast"; }) &&
      log.data.turns.some(function (t) { return t.weapon === "triple"; }) &&
      log.data.turns.some(function (t) { return t.weapon === "roller"; });
    if (logOk) {
      pass(
        "GET /api/matches/:id/log full history",
        "turns=" + log.data.turns.length + " winner=" + log.data.winner + " first taunt=" + log.data.turns[0].taunt
      );
    } else {
      fail("GET /api/matches/:id/log full history", "turns " + ((log.data.turns && log.data.turns.length) || 0));
    }

    const savedPath = path.join(MATCH_DIR, matchId + ".json");
    if (fs.existsSync(savedPath)) {
      const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
      if (saved.matchId === matchId && saved.turns && saved.turns.length === log.data.turns.length && saved.initial && saved.final) {
        pass("match JSON persisted", savedPath + " turns=" + saved.turns.length + " status=" + saved.status);
      } else fail("match JSON persisted", "shape mismatch " + savedPath);
    } else fail("match JSON persisted", "missing " + savedPath);

    const sseEvents = await ssePromise;
    const kinds = {};
    sseEvents.forEach(function (e) { kinds[e.event] = (kinds[e.event] || 0) + 1; });
    if (kinds.snapshot >= 1 && kinds.turn >= 1) {
      pass("SSE stream delivers snapshot and turn", JSON.stringify(kinds));
    } else fail("SSE stream delivers snapshot and turn", JSON.stringify(kinds) + " n=" + sseEvents.length);

    const add = await request("POST", "/api/matches/" + c2.data.matchId + "/add-bot", { bot: "naive", name: "NaiveBot" });
    if (add.status === 200 && add.data.side === "right" && (add.data.state.firstSide === "left" || add.data.state.firstSide === "right")) {
      pass("POST add-bot fills second seat", "status " + add.data.status + " side " + add.data.side + " bot " + add.data.bot);
    } else fail("POST add-bot fills second seat", "status " + add.status + " " + JSON.stringify(add.data).slice(0, 300));


    // ---- Balance: random first shooter ----
    const firstCounts = { left: 0, right: 0 };
    let fsBad = [];
    for (let i = 0; i < 24; i++) {
      const id = "m_fs_" + i;
      const j1 = await request("POST", "/api/join", { name: "FsA" + i, matchId: id, seed: 100 + i });
      const j2 = await request("POST", "/api/join", { name: "FsB" + i, matchId: id });
      const st = j2.data && j2.data.state;
      if (j1.status !== 201 || j1.data.state.whoseTurn !== null || j1.data.state.firstSide !== null) fsBad.push(id + " waiting state");
      if (!st || (st.firstSide !== "left" && st.firstSide !== "right") || st.whoseTurn !== st.firstSide) {
        fsBad.push(id + " " + JSON.stringify(st && { f: st.firstSide, w: st.whoseTurn }));
        continue;
      }
      firstCounts[st.firstSide]++;
    }
    if (!fsBad.length && firstCounts.left >= 1 && firstCounts.right >= 1) {
      pass("firstSide is random across matches and whoseTurn matches it", "24 matches: left first " + firstCounts.left + ", right first " + firstCounts.right);
    } else fail("firstSide is random across matches and whoseTurn matches it", JSON.stringify(firstCounts) + " " + fsBad.join("; "));

    const lastFs = await request("GET", "/api/matches/m_fs_0/log");
    const savedFs = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, "m_fs_0.json"), "utf8"));
    if (lastFs.data.firstSide && savedFs.firstSide === lastFs.data.firstSide && savedFs.startedAt) {
      pass("firstSide recorded in log and saved match JSON", "m_fs_0 firstSide=" + savedFs.firstSide);
    } else fail("firstSide recorded in log and saved match JSON", JSON.stringify({ log: lastFs.data.firstSide, saved: savedFs.firstSide }));

    // ---- Balance: ammo caps ----
    const am1 = await request("POST", "/api/join", { name: "AmmoA", matchId: "m_ammo", seed: 31 });
    const am2 = await request("POST", "/api/join", { name: "AmmoB", matchId: "m_ammo" });
    const amTok = { left: am1.data.token, right: am2.data.token };
    const amState0 = am2.data.state;
    const op = amState0.whoseTurn;
    const other = op === "left" ? "right" : "left";
    const capsOk =
      amState0.ammoCaps && amState0.ammoCaps.triple === 1 && amState0.ammoCaps.blast === 2 &&
      amState0.ammoCaps.shell === null && amState0.ammoCaps.roller === null &&
      amState0.players.left.ammo.triple === 1 && amState0.players.right.ammo.blast === 2;
    if (capsOk) pass("state exposes ammoCaps and per-tank ammo", JSON.stringify(amState0.players.left.ammo));
    else fail("state exposes ammoCaps and per-tank ammo", JSON.stringify({ caps: amState0.ammoCaps, l: amState0.players.left.ammo }));

    async function amFire(side, weapon) {
      return request("POST", "/api/matches/m_ammo/fire", Object.assign({ token: amTok[side] }, offscreen(side, weapon)));
    }
    const t1 = await amFire(op, "triple");
    if (t1.status === 200 && t1.data.turn.weapon === "triple" && t1.data.turn.ammoAfter[op].triple === 0 &&
        t1.data.state.players[op].ammo.triple === 0 && t1.data.state.players[op].availableWeapons.indexOf("triple") < 0 &&
        t1.data.state.players[other].ammo.triple === 1) {
      pass("triple shot decrements ammo (1 -> 0)", op + " ammo " + JSON.stringify(t1.data.state.players[op].ammo));
    } else fail("triple shot decrements ammo (1 -> 0)", "status " + t1.status + " " + JSON.stringify(t1.data).slice(0, 300));
    await amFire(other, "shell");
    const countBefore = (await request("GET", "/api/matches/m_ammo/state?compact=1")).data.turnCount;
    const t2 = await amFire(op, "triple");
    const afterReject = (await request("GET", "/api/matches/m_ammo/state?compact=1")).data;
    if (t2.status === 400 && t2.data.code === "out_of_ammo" && /out of ammo/i.test(t2.data.error) &&
        t2.data.availableWeapons.indexOf("triple") < 0 && afterReject.turnCount === countBefore && afterReject.whoseTurn === op) {
      pass("second triple shot rejected with 400 (turn kept, no swap)", t2.data.error);
    } else fail("second triple shot rejected with 400 (turn kept, no swap)", "status " + t2.status + " " + JSON.stringify(t2.data) + " turnCount " + afterReject.turnCount + "/" + countBefore);
    const b1 = await amFire(op, "blast");
    await amFire(other, "shell");
    const b2 = await amFire(op, "blast");
    await amFire(other, "shell");
    const b3 = await amFire(op, "blast");
    if (b1.status === 200 && b2.status === 200 && b2.data.state.players[op].ammo.blast === 0 && b3.status === 400 && b3.data.code === "out_of_ammo") {
      pass("big blast capped at 2 (third rejected 400)", b3.data.error);
    } else fail("big blast capped at 2 (third rejected 400)", [b1.status, b2.status, b3.status].join(",") + " " + JSON.stringify(b3.data).slice(0, 200));
    const sh = await amFire(op, "shell");
    const ro = await amFire(other, "roller");
    if (sh.status === 200 && ro.status === 200 && ro.data.state.players[op].ammo.shell === null && ro.data.state.players[other].ammo.roller === null) {
      pass("shell and roller stay unlimited", "ok");
    } else fail("shell and roller stay unlimited", sh.status + "," + ro.status);
    const savedAmmo = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, "m_ammo.json"), "utf8"));
    const rpErr = replayMatches(savedAmmo);
    const rpErr2 = replayMatches(JSON.parse(fs.readFileSync(savedPath, "utf8")));
    if (!rpErr && !rpErr2 && savedAmmo.final.left.ammo && savedAmmo.firstSide === op) {
      pass("saved matches replay exactly (seed + firstSide + shots)", "m_ammo turns=" + savedAmmo.turns.length + ", duel turns=" + log.data.turns.length);
    } else fail("saved matches replay exactly (seed + firstSide + shots)", (rpErr || "") + " | " + (rpErr2 || ""));

    const helpAmmo = await request("GET", "/api/help");
    const specAmmo = JSON.stringify((await request("GET", "/openapi.json")).data);
    if (helpAmmo.data.ammo && helpAmmo.data.ammo.caps.triple === 1 && /firstSide/.test(JSON.stringify(helpAmmo.data)) &&
        /ammo/i.test(specAmmo) && /out_of_ammo/.test(specAmmo) && /firstSide/.test(specAmmo)) {
      pass("help and OpenAPI document ammo + firstSide", "ok");
    } else fail("help and OpenAPI document ammo + firstSide", "help.ammo=" + JSON.stringify(helpAmmo.data.ammo));
    if (home.raw.indexOf("First Shooter") >= 0 && home.raw.indexOf("syncLiveWeaponSelect") >= 0 && /ammo/i.test(home.raw)) {
      pass("browser UI shows ammo + first shooter in telemetry", "markers present");
    } else fail("browser UI shows ammo + first shooter in telemetry", "missing markers");

    // agent-cli
    const cliMatches = await cli("matches");
    if (cliMatches.code === 0 && cliMatches.data.matches && cliMatches.data.matches.length >= 1) {
      pass("agent-cli matches", "n=" + cliMatches.data.matches.length);
    } else fail("agent-cli matches", cliMatches.err || cliMatches.out.slice(0, 200));

    const cliJoin = await cli("join", "CliBot", "--match", "m_cli_seat", "--seed", "99");
    if (cliJoin.code === 0 && cliJoin.data.matchId === "m_cli_seat" && cliJoin.data.token && cliJoin.data.side === "left") {
      pass("agent-cli join", cliJoin.data.matchId + " " + cliJoin.data.side);
      const cliState = await cli("state", cliJoin.data.matchId, "--compact");
      if (cliState.code === 0 && cliState.data.status === "waiting" && !cliState.data.terrain && cliState.data.terrainProfile) {
        pass("agent-cli state --compact", "status " + cliState.data.status);
      } else fail("agent-cli state --compact", JSON.stringify(cliState.data).slice(0, 200));
      const cliLog = await cli("log", cliJoin.data.matchId);
      if (cliLog.code === 0 && cliLog.data.matchId === cliJoin.data.matchId) {
        pass("agent-cli log", "turns=" + cliLog.data.turnCount);
      } else fail("agent-cli log", cliLog.out.slice(0, 200));
    } else fail("agent-cli join", (cliJoin.out || "").slice(0, 400));

    // Restart the server and make sure ammo / firstSide / whoseTurn survive reload
    try { child.kill("SIGTERM"); } catch (e) { /* ignore */ }
    await sleep(400);
    child = await startServer();
    child.on("exit", function () { /* ignore later */ });
    const re = await request("GET", "/api/matches/m_ammo/state?compact=1");
    if (re.status === 200 && re.data.firstSide && re.data.players.left.ammo &&
        re.data.players[re.data.firstSide].ammo.triple === 0 && re.data.players[re.data.firstSide].ammo.blast === 0) {
      pass("ammo and firstSide survive server restart", "firstSide=" + re.data.firstSide + " turnNumber=" + re.data.turnNumber);
    } else fail("ammo and firstSide survive server restart", JSON.stringify(re.data).slice(0, 300));
  } catch (err) {
    fail("unhandled", err.stack || err.message);
  }

  try { child.kill("SIGTERM"); } catch (e) { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log("");
  console.log(
    failed === 0
      ? "All " + results.length + " server tests passed."
      : failed + " of " + results.length + " server tests failed."
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();

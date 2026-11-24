/**
 * Bot Tanks — shared simulation engine (Node + browser).
 * Turn-based artillery. Deterministic given a seed and bot decisions.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BotTanks = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WIDTH = 960;
  const HEIGHT = 540;
  const GRAVITY = 420; // px/s^2, downward
  const WIND_MAX = 90; // px/s^2 horizontal accel
  const MAX_POWER = 100;
  const SPEED_AT_MAX = 820; // px/s at power 100
  const TANK_RADIUS = 13;
  const PROJ_RADIUS = 3.5;
  const TANK_HP = 100;
  const MAX_TURNS = 80; // 40 shots each
  const DT = 1 / 60;
  const BOT_TIME_LIMIT_MS = 25;
  const MUZZLE = TANK_RADIUS + 5;
  const MAX_FLIGHT_S = 12;
  const ROLL_SPEED = 220; // px/s along surface
  const MAX_ROLL = 280; // px
  const ROLL_TRIGGER = TANK_RADIUS + 16;

  const WEAPONS = {
    shell: {
      id: "shell",
      name: "Standard Shell",
      blast: 32,
      damage: 30,
      crater: 38,
    },
    blast: {
      id: "blast",
      name: "Big Blast",
      blast: 56,
      damage: 44,
      crater: 68,
    },
    triple: {
      id: "triple",
      name: "Triple Shot",
      blast: 24,
      damage: 18,
      crater: 28,
      spread: 7,
    },
    roller: {
      id: "roller",
      name: "Roller / Digger",
      blast: 28,
      damage: 34,
      crater: 32,
      roll: true,
    },
  };

  const WEAPON_LIST = Object.freeze(
    ["shell", "blast", "triple", "roller"].map(function (id) {
      const w = WEAPONS[id];
      return Object.freeze({
        id: w.id,
        name: w.name,
        blast: w.blast,
        damage: w.damage,
      });
    })
  );

  const CONSTANTS = Object.freeze({
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    GRAVITY: GRAVITY,
    WIND_MAX: WIND_MAX,
    MAX_POWER: MAX_POWER,
    SPEED_AT_MAX: SPEED_AT_MAX,
    TANK_RADIUS: TANK_RADIUS,
    TANK_HP: TANK_HP,
    MAX_TURNS: MAX_TURNS,
    DT: DT,
    BOT_TIME_LIMIT_MS: BOT_TIME_LIMIT_MS,
  });

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function nowMs() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  function terrainAt(terrain, x) {
    const n = terrain.length;
    if (x <= 0) return terrain[0];
    if (x >= n - 1) return terrain[n - 1];
    const i = Math.floor(x);
    const t = x - i;
    return terrain[i] * (1 - t) + terrain[i + 1] * t;
  }

  function generateTerrain(width, height, rng) {
    const h = new Array(width);
    h[0] = height * 0.58 + (rng() - 0.5) * 40;
    const step = 3.8 + rng() * 2.2;
    for (let i = 1; i < width; i++) {
      h[i] = h[i - 1] + (rng() - 0.5) * step;
    }
    // Smooth
    for (let pass = 0; pass < 6; pass++) {
      const c = h.slice();
      for (let i = 1; i < width - 1; i++) {
        h[i] = c[i] * 0.5 + c[i - 1] * 0.25 + c[i + 1] * 0.25;
      }
    }
    // Central valley, slight side hills
    const valleyAmp = height * (0.07 + rng() * 0.02);
    for (let i = 0; i < width; i++) {
      const u = i / (width - 1);
      h[i] += Math.sin(u * Math.PI) * valleyAmp;
    }
    // One extra bump somewhere in the middle third (rng already used above
    // in the loop is slightly non-uniform across seeds — bump uses one draw)
    const bumpX = (0.3 + rng() * 0.4) * width;
    const bumpW = 50 + rng() * 90;
    const bumpA = (rng() - 0.45) * height * 0.16;
    for (let i = 0; i < width; i++) {
      const d = (i - bumpX) / bumpW;
      h[i] -= Math.exp(-d * d) * bumpA;
    }
    const minH = height * 0.3;
    const maxH = height * 0.82;
    for (let i = 0; i < width; i++) {
      h[i] = clamp(h[i], minH, maxH);
    }
    return h;
  }

  function flattenPlatform(terrain, x, radius) {
    const i0 = Math.max(0, Math.floor(x - radius));
    const i1 = Math.min(terrain.length - 1, Math.ceil(x + radius));
    let sum = 0;
    let n = 0;
    for (let i = i0; i <= i1; i++) {
      sum += terrain[i];
      n++;
    }
    const y = sum / n;
    for (let i = i0; i <= i1; i++) terrain[i] = y;
    return y;
  }

  function carveCrater(terrain, ix, iy, radius) {
    if (!(radius > 0) || !isFinite(ix) || !isFinite(iy)) return;
    const i0 = Math.max(0, Math.floor(ix - radius));
    const i1 = Math.min(terrain.length - 1, Math.ceil(ix + radius));
    const heightCap = HEIGHT - 2;
    for (let i = i0; i <= i1; i++) {
      const dx = i - ix;
      const inside = radius * radius - dx * dx;
      if (inside < 0) continue;
      const bottom = iy + Math.sqrt(inside);
      if (bottom > terrain[i]) terrain[i] = Math.min(heightCap, bottom);
    }
  }

  function carveTrench(terrain, x, depth, halfWidth) {
    const i0 = Math.max(0, Math.floor(x - halfWidth));
    const i1 = Math.min(terrain.length - 1, Math.ceil(x + halfWidth));
    for (let i = i0; i <= i1; i++) {
      terrain[i] = Math.min(HEIGHT - 2, terrain[i] + depth);
    }
  }

  function settleTank(tank, terrain) {
    const surface = terrainAt(terrain, tank.x);
    tank.y = surface - TANK_RADIUS;
    if (tank.y > HEIGHT - TANK_RADIUS - 1) {
      tank.hp = 0;
    }
  }

  function damageAt(dist, blast, maxDmg) {
    const d = Math.max(0, dist - TANK_RADIUS);
    if (d >= blast) return 0;
    return maxDmg * (1 - d / blast);
  }

  function sanitizeCmd(raw) {
    if (!raw || typeof raw !== "object") return null;
    const angle = Number(raw.angle);
    const power = Number(raw.power);
    if (!isFinite(angle) || !isFinite(power)) return null;
    let weapon = raw.weapon == null ? "shell" : String(raw.weapon);
    if (!WEAPONS[weapon]) weapon = "shell";
    return {
      angle: clamp(angle, 0, 180),
      power: clamp(power, 0, MAX_POWER),
      weapon: weapon,
    };
  }

  function launchVelocity(angleDeg, power) {
    const rad = (angleDeg * Math.PI) / 180;
    const speed = (clamp(power, 0, MAX_POWER) / MAX_POWER) * SPEED_AT_MAX;
    return {
      vx: Math.cos(rad) * speed,
      vy: -Math.sin(rad) * speed,
    };
  }

  function muzzlePos(tank, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: tank.x + Math.cos(rad) * MUZZLE,
      y: tank.y - Math.sin(rad) * MUZZLE,
    };
  }

  /**
   * Integrate one projectile. Reads terrain; does not mutate world.
   * Returns impact info and a sampled path (for animation / preview).
   */
  function integrateProjectile(world, proj, opts) {
    opts = opts || {};
    const wantPath = !!opts.path;
    const terrain = world.terrain;
    const width = world.width;
    const gravity = world.gravity;
    const wind = world.wind;
    const weapon = proj.weapon;
    const tanks = [
      { side: "left", x: world.left.x, y: world.left.y },
      { side: "right", x: world.right.x, y: world.right.y },
    ];

    let x = proj.x;
    let y = proj.y;
    let vx = proj.vx;
    let vy = proj.vy;
    let rolling = false;
    let rolled = 0;
    let rollDir = vx >= 0 ? 1 : -1;
    let immune = 10;
    const path = wantPath ? [{ x: x, y: y, rolling: false }] : null;
    const maxSteps = Math.ceil(MAX_FLIGHT_S / DT);
    const rollPts = [];

    for (let i = 0; i < maxSteps; i++) {
      if (!rolling) {
        x += vx * DT;
        y += vy * DT;
        vx += wind * DT;
        vy += gravity * DT;
      } else {
        x += rollDir * ROLL_SPEED * DT;
        const surface = terrainAt(terrain, x);
        y = surface - 2;
        rolled += ROLL_SPEED * DT;
        rollPts.push(x);
      }

      if (wantPath) path.push({ x: x, y: y, rolling: rolling });

      if (x < 0 || x >= width || y > HEIGHT + 60) {
        return {
          x: x,
          y: y,
          oob: true,
          impact: false,
          hitTank: null,
          path: path,
          rolled: rolling,
          rollXs: rollPts,
          steps: i,
        };
      }

      if (immune <= 0) {
        for (let t = 0; t < 2; t++) {
          const dx = x - tanks[t].x;
          const dy = y - tanks[t].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const trigger = rolling ? ROLL_TRIGGER : TANK_RADIUS + PROJ_RADIUS;
          if (dist < trigger) {
            return {
              x: x,
              y: y,
              oob: false,
              impact: true,
              hitTank: tanks[t].side,
              path: path,
              rolled: rolling,
              rollXs: rollPts,
              steps: i,
            };
          }
        }
      } else {
        immune--;
      }

      if (!rolling && y >= terrainAt(terrain, x)) {
        y = terrainAt(terrain, x);
        if (weapon.roll) {
          rolling = true;
          rollDir = Math.abs(vx) < 8 ? (world.currentSide === "left" ? 1 : -1) : vx >= 0 ? 1 : -1;
          // Prefer rolling toward the opponent if almost vertical impact
          if (Math.abs(vx) < 8 && world.left && world.right) {
            /* rollDir already set from currentSide if provided */
          }
        } else {
          return {
            x: x,
            y: y,
            oob: false,
            impact: true,
            hitTank: null,
            path: path,
            rolled: false,
            rollXs: rollPts,
            steps: i,
          };
        }
      }

      if (rolling && rolled >= MAX_ROLL) {
        return {
          x: x,
          y: y,
          oob: false,
          impact: true,
          hitTank: null,
          path: path,
          rolled: true,
          rollXs: rollPts,
          steps: i,
        };
      }
    }

    return {
      x: x,
      y: y,
      oob: true,
      impact: false,
      hitTank: null,
      path: path,
      rolled: rolling,
      rollXs: rollPts,
      steps: maxSteps,
    };
  }

  function projectilesFor(world, side, cmd, path) {
    const tank = world[side];
    const weapon = WEAPONS[cmd.weapon] || WEAPONS.shell;
    const angles =
      weapon.id === "triple"
        ? [cmd.angle - weapon.spread, cmd.angle, cmd.angle + weapon.spread]
        : [cmd.angle];
    const out = [];
    for (let i = 0; i < angles.length; i++) {
      const a = clamp(angles[i], 0, 180);
      const muz = muzzlePos(tank, a);
      const v = launchVelocity(a, cmd.power);
      const proj = {
        x: muz.x,
        y: muz.y,
        vx: v.vx,
        vy: v.vy,
        weapon: weapon,
      };
      const res = integrateProjectile(
        Object.assign({}, world, { currentSide: side }),
        proj,
        { path: path }
      );
      res.weapon = weapon;
      res.angle = a;
      out.push(res);
    }
    return out;
  }

  function applyImpacts(world, events) {
    let dmgLeft = 0;
    let dmgRight = 0;
    const craters = [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      ev.damageLeft = 0;
      ev.damageRight = 0;
      if (ev.oob && !ev.impact) continue;
      const weapon = ev.weapon;
      if (ev.rollXs && ev.rollXs.length) {
        for (let k = 0; k < ev.rollXs.length; k += 2) {
          carveTrench(world.terrain, ev.rollXs[k], 3.2, 4);
          craters.push({
            x: ev.rollXs[k],
            y: ev.y,
            radius: 4,
            depth: 3.2,
            kind: "trench",
          });
        }
      }
      if (ev.impact || ev.hitTank) {
        carveCrater(world.terrain, ev.x, ev.y, weapon.crater);
        craters.push({
          x: ev.x,
          y: ev.y,
          radius: weapon.crater,
          kind: "crater",
        });
        const dl = damageAt(
          Math.hypot(ev.x - world.left.x, ev.y - world.left.y),
          weapon.blast,
          weapon.damage
        );
        const dr = damageAt(
          Math.hypot(ev.x - world.right.x, ev.y - world.right.y),
          weapon.blast,
          weapon.damage
        );
        ev.damageLeft = dl;
        ev.damageRight = dr;
        dmgLeft += dl;
        dmgRight += dr;
      }
    }
    world.left.hp = Math.max(0, world.left.hp - dmgLeft);
    world.right.hp = Math.max(0, world.right.hp - dmgRight);
    settleTank(world.left, world.terrain);
    settleTank(world.right, world.terrain);
    return { left: dmgLeft, right: dmgRight, craters: craters };
  }

  function pickWind(rng) {
    // Often moderate, occasionally strong, sometimes near-still
    const u = rng() * 2 - 1;
    const mag = Math.pow(Math.abs(u), 0.75) * WIND_MAX;
    return (u < 0 ? -1 : 1) * mag;
  }

  function freezeShot(s) {
    return Object.freeze({
      turn: s.turn,
      side: s.side,
      angle: s.angle,
      power: s.power,
      weapon: s.weapon,
      impactX: s.impactX,
      impactY: s.impactY,
      damageToOpponent: s.damageToOpponent,
      damageToSelf: s.damageToSelf,
      hit: s.hit,
      skipped: !!s.skipped,
      error: s.error || null,
      timeout: !!s.timeout,
    });
  }

  function snapshotFor(world, side) {
    const own = side === "left" ? world.left : world.right;
    const opp = side === "left" ? world.right : world.left;
    const ownHist = [];
    const all = [];
    for (let i = 0; i < world.history.length; i++) {
      const f = freezeShot(world.history[i]);
      all.push(f);
      if (world.history[i].side === side) ownHist.push(f);
    }
    const snap = {
      terrain: Object.freeze(world.terrain.slice()),
      field: Object.freeze({ width: world.width, height: world.height }),
      own: Object.freeze({
        x: own.x,
        y: own.y,
        hp: own.hp,
        maxHp: own.maxHp,
        side: side,
      }),
      opponent: Object.freeze({
        x: opp.x,
        y: opp.y,
        hp: opp.hp,
        maxHp: opp.maxHp,
      }),
      wind: world.wind,
      gravity: world.gravity,
      weapons: WEAPON_LIST,
      shotHistory: Object.freeze(ownHist),
      allShots: Object.freeze(all),
      turn: world.turn,
      time: world.time,
    };
    return Object.freeze(snap);
  }

  function compileCustom(code) {
    const src = String(code || "").trim();
    if (!src) {
      throw new Error("Custom bot is empty");
    }
    let fn;
    try {
      if (/^\s*(function|\(|async\s+function)/.test(src)) {
        fn = new Function(
          "state",
          '"use strict"; const __fn = (' + src + "); return __fn(state);"
        );
      } else {
        fn = new Function("state", '"use strict";\n' + src);
      }
    } catch (err) {
      const wrapped = function () {
        throw new Error("Custom bot failed to compile: " + err.message);
      };
      wrapped.__compileError = err.message;
      return wrapped;
    }
    return fn;
  }

  function runBot(fn, snap, limitMs) {
    const limit = limitMs == null ? BOT_TIME_LIMIT_MS : limitMs;
    const t0 = nowMs();
    try {
      const result = fn(snap);
      const elapsed = nowMs() - t0;
      if (elapsed > limit) {
        return { ok: false, timeout: true, error: null, cmd: null, elapsed: elapsed };
      }
      const cmd = sanitizeCmd(result);
      if (!cmd) {
        return {
          ok: false,
          timeout: false,
          error: "invalid return",
          cmd: null,
          elapsed: elapsed,
        };
      }
      return { ok: true, timeout: false, error: null, cmd: cmd, elapsed: elapsed };
    } catch (err) {
      return {
        ok: false,
        timeout: false,
        error: err && err.message ? err.message : String(err),
        cmd: null,
        elapsed: nowMs() - t0,
      };
    }
  }

  function createWorld(opts) {
    opts = opts || {};
    const seed = opts.seed == null ? 1 : opts.seed >>> 0;
    const rng = mulberry32(seed === 0 ? 1 : seed);
    const width = opts.width || WIDTH;
    const height = opts.height || HEIGHT;
    const terrain = generateTerrain(width, height, rng);
    const leftX = clamp(Math.round(width * 0.11 + (rng() - 0.5) * 24), 40, 140);
    const rightX = clamp(
      Math.round(width * 0.89 + (rng() - 0.5) * 24),
      width - 140,
      width - 40
    );
    const leftY = flattenPlatform(terrain, leftX, 16);
    const rightY = flattenPlatform(terrain, rightX, 16);
    const world = {
      seed: seed,
      rng: rng,
      width: width,
      height: height,
      terrain: terrain,
      gravity: GRAVITY,
      wind: pickWind(rng),
      left: {
        x: leftX,
        y: leftY - TANK_RADIUS,
        hp: TANK_HP,
        maxHp: TANK_HP,
        side: "left",
      },
      right: {
        x: rightX,
        y: rightY - TANK_RADIUS,
        hp: TANK_HP,
        maxHp: TANK_HP,
        side: "right",
      },
      turn: 1,
      side: "left",
      time: 0,
      history: [],
      winner: null, // 'left' | 'right' | 'draw'
      over: false,
      stats: {
        shots: { left: 0, right: 0 },
        hits: { left: 0, right: 0 },
        errors: { left: 0, right: 0 },
        timeouts: { left: 0, right: 0 },
        firstHitShots: null,
        totalShotsWhenFirstHit: null,
      },
    };
    settleTank(world.left, terrain);
    settleTank(world.right, terrain);
    return world;
  }

  function finishIfNeeded(world) {
    if (world.over) return;
    const lDead = world.left.hp <= 0;
    const rDead = world.right.hp <= 0;
    if (lDead && rDead) {
      world.over = true;
      world.winner = "draw";
    } else if (lDead) {
      world.over = true;
      world.winner = "right";
    } else if (rDead) {
      world.over = true;
      world.winner = "left";
    } else if (world.turn > MAX_TURNS) {
      world.over = true;
      if (world.left.hp > world.right.hp) world.winner = "left";
      else if (world.right.hp > world.left.hp) world.winner = "right";
      else world.winner = "draw";
    }
  }

  function packTrajectory(ev) {
    return {
      angle: ev.angle,
      weapon: ev.weapon && ev.weapon.id ? ev.weapon.id : ev.weapon,
      path: ev.path ? ev.path.map(function (p) {
        return { x: p.x, y: p.y, rolling: !!p.rolling };
      }) : [],
      rolled: !!ev.rolled,
      rollXs: ev.rollXs ? ev.rollXs.slice() : [],
      impactX: ev.x,
      impactY: ev.y,
      oob: !!ev.oob,
      impact: !!ev.impact,
      hitTank: ev.hitTank || null,
      steps: ev.steps,
      damageLeft: ev.damageLeft || 0,
      damageRight: ev.damageRight || 0,
    };
  }

  function compactTerrain(terrain, points) {
    points = points || 32;
    const out = new Array(points);
    const n = terrain.length;
    for (let i = 0; i < points; i++) {
      const x = points === 1 ? 0 : (i / (points - 1)) * (n - 1);
      out[i] = Math.round(terrainAt(terrain, x) * 100) / 100;
    }
    return out;
  }

  function resolveShot(world, cmd, meta) {
    meta = meta || {};
    const side = world.side;
    const opp = side === "left" ? "right" : "left";
    const windBefore = world.wind;
    const hpBefore = { left: world.left.hp, right: world.right.hp };
    const posBefore = {
      left: { x: world.left.x, y: world.left.y },
      right: { x: world.right.x, y: world.right.y },
    };
    const record = {
      turn: world.turn,
      turnNumber: world.turn,
      side: side,
      angle: cmd ? cmd.angle : 0,
      power: cmd ? cmd.power : 0,
      weapon: cmd ? cmd.weapon : "shell",
      impactX: null,
      impactY: null,
      damageToOpponent: 0,
      damageToSelf: 0,
      damageToLeft: 0,
      damageToRight: 0,
      hpBefore: { left: hpBefore.left, right: hpBefore.right },
      hpAfter: { left: hpBefore.left, right: hpBefore.right },
      posBefore: posBefore,
      posAfter: null,
      windBefore: windBefore,
      windAfter: windBefore,
      trajectories: [],
      impacts: [],
      craters: [],
      hit: false,
      skipped: !cmd,
      error: meta.error || null,
      timeout: !!meta.timeout,
      events: null,
      winnerAfter: null,
    };

    if (meta.timeout) world.stats.timeouts[side]++;
    else if (meta.error) world.stats.errors[side]++;

    if (!cmd) {
      record.posAfter = {
        left: { x: world.left.x, y: world.left.y },
        right: { x: world.right.x, y: world.right.y },
      };
      world.history.push(record);
      advanceTurn(world);
      record.windAfter = world.wind;
      record.winnerAfter = world.winner;
      return record;
    }

    world.stats.shots[side]++;
    const events = projectilesFor(world, side, cmd, meta.path !== false);
    const dmg = applyImpacts(world, events);
    record.events = events;
    record.craters = dmg.craters || [];
    record.trajectories = events.map(packTrajectory);
    record.impacts = record.trajectories.map(function (tr) {
      return {
        x: tr.impactX,
        y: tr.impactY,
        oob: tr.oob,
        impact: tr.impact,
        hitTank: tr.hitTank,
        damageLeft: tr.damageLeft,
        damageRight: tr.damageRight,
        weapon: tr.weapon,
      };
    });
    // Representative impact: last projectile, or first that hit a tank
    let pick = events[events.length - 1];
    for (let i = 0; i < events.length; i++) {
      if (events[i].hitTank || (events[i].impact && !events[i].oob)) {
        pick = events[i];
        if (events[i].hitTank) break;
      }
    }
    if (pick) {
      record.impactX = pick.x;
      record.impactY = pick.y;
    }
    record.damageToLeft = dmg.left;
    record.damageToRight = dmg.right;
    record.damageToSelf = dmg[side];
    record.damageToOpponent = dmg[opp];
    record.hpAfter = { left: world.left.hp, right: world.right.hp };
    record.posAfter = {
      left: { x: world.left.x, y: world.left.y },
      right: { x: world.right.x, y: world.right.y },
    };
    record.hit = dmg[opp] > 0;
    if (record.hit) {
      world.stats.hits[side]++;
      if (world.stats.firstHitShots == null) {
        world.stats.firstHitShots =
          world.stats.shots.left + world.stats.shots.right;
      }
    }
    world.history.push(record);
    finishIfNeeded(world);
    if (!world.over) advanceTurn(world);
    record.windAfter = world.wind;
    record.winnerAfter = world.winner;
    return record;
  }

  function advanceTurn(world) {
    world.side = world.side === "left" ? "right" : "left";
    world.turn += 1;
    world.wind = pickWind(world.rng);
    world.time += 1;
    finishIfNeeded(world);
  }

  // --- Built-in bots --------------------------------------------------------

  function createRandom(rng) {
    rng = rng || Math.random;
    return function (state) {
      const towardRight = state.opponent.x >= state.own.x;
      const angle = towardRight ? rng() * 90 : 90 + rng() * 90;
      const power = 25 + rng() * 75;
      const ids = ["shell", "blast", "triple", "roller"];
      const weapon = ids[Math.floor(rng() * ids.length)];
      return { angle: angle, power: power, weapon: weapon };
    };
  }

  function createNaive() {
    return function (state) {
      const dx = state.opponent.x - state.own.x;
      const dy = state.own.y - state.opponent.y; // up is positive
      let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (angle < 0) angle += 360;
      if (angle > 180) angle = angle > 270 ? 0 : 180;
      return { angle: angle, power: 60, weapon: "shell" };
    };
  }

  function createBracketer() {
    return function (state) {
      const dx = state.opponent.x - state.own.x;
      const towardRight = dx >= 0;
      const range = Math.abs(dx);
      let angle = towardRight ? 48 : 132;
      let power = clamp((range / state.field.width) * 95 + 18, 30, 90);
      const hist = state.shotHistory;
      if (hist && hist.length) {
        let last = null;
        for (let i = hist.length - 1; i >= 0; i--) {
          if (!hist[i].skipped && hist[i].impactX != null) {
            last = hist[i];
            break;
          }
        }
        if (last) {
          const err = last.impactX - state.opponent.x;
          // Overshot if impact is past the opponent from our side
          const overshot = towardRight ? err > 0 : err < 0;
          const adj = clamp(Math.abs(err) / state.field.width * 90, 3, 22);
          if (overshot) power -= adj;
          else power += adj;
          // If we slammed a nearby hill (impact much closer to us than the enemy)
          const travel = Math.abs(last.impactX - state.own.x);
          if (travel < Math.abs(dx) * 0.55) {
            angle = towardRight ? clamp(angle + 8, 20, 80) : clamp(angle - 8, 100, 160);
            power += 6;
          }
          if (last.hit) {
            // Nudge only slightly
            power = last.power + (state.wind - 0) * 0.02;
            angle = last.angle;
          }
        }
      }
      // Crude wind nudge
      if (towardRight) power -= state.wind * 0.06;
      else power += state.wind * 0.06;
      return {
        angle: clamp(angle, 5, 175),
        power: clamp(power, 15, 100),
        weapon: "shell",
      };
    };
  }

  function missScore(events, opponent, own) {
    let best = Infinity;
    let oppDmg = 0;
    let selfDmg = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const weapon = ev.weapon;
      const dOpp = damageAt(
        Math.hypot(ev.x - opponent.x, ev.y - opponent.y),
        weapon.blast,
        weapon.damage
      );
      const dSelf = damageAt(
        Math.hypot(ev.x - own.x, ev.y - own.y),
        weapon.blast,
        weapon.damage
      );
      oppDmg += dOpp;
      selfDmg += dSelf;
      const dist = Math.hypot(ev.x - opponent.x, ev.y - opponent.y);
      if (dist < best) best = dist;
    }
    if (oppDmg > 0) {
      // Prefer more damage to opponent, penalize self-damage heavily
      return -1000 - oppDmg * 10 + selfDmg * 20;
    }
    return best + selfDmg * 8;
  }

  function createSolver() {
    return function (state) {
      // Reconstruct a lightweight world for traces (read-only terrain)
      const world = {
        width: state.field.width,
        height: state.field.height,
        terrain: state.terrain,
        gravity: state.gravity,
        wind: state.wind,
        left:
          state.own.side === "left"
            ? { x: state.own.x, y: state.own.y }
            : { x: state.opponent.x, y: state.opponent.y },
        right:
          state.own.side === "right"
            ? { x: state.own.x, y: state.own.y }
            : { x: state.opponent.x, y: state.opponent.y },
        currentSide: state.own.side,
      };
      const towardRight = state.opponent.x >= state.own.x;
      const angleMin = towardRight ? 15 : 100;
      const angleMax = towardRight ? 80 : 165;
      const weapons = ["shell", "blast"];

      let best = {
        score: Infinity,
        angle: towardRight ? 50 : 130,
        power: 70,
        weapon: "shell",
      };

      function consider(angle, power, weapon) {
        const cmd = { angle: angle, power: power, weapon: weapon };
        const events = projectilesFor(world, state.own.side, cmd, false);
        const score = missScore(events, state.opponent, state.own);
        if (score < best.score) {
          best = { score: score, angle: angle, power: power, weapon: weapon };
        }
        return score;
      }

      // Coarse grid
      for (let wi = 0; wi < weapons.length; wi++) {
        const weapon = weapons[wi];
        for (let a = angleMin; a <= angleMax; a += 5) {
          for (let p = 25; p <= 100; p += 5) {
            const s = consider(a, p, weapon);
            if (s < -1000 && best.weapon === "shell" && weapon === "shell") {
              // Early exit on a solid direct-ish shell hit; still refine later
            }
          }
        }
      }

      // Refine around the best
      const rA0 = Math.max(angleMin, best.angle - 6);
      const rA1 = Math.min(angleMax, best.angle + 6);
      const rP0 = Math.max(15, best.power - 8);
      const rP1 = Math.min(100, best.power + 8);
      for (let a = rA0; a <= rA1; a += 1) {
        for (let p = rP0; p <= rP1; p += 1) {
          consider(a, p, best.weapon);
        }
      }

      // If we still miss, try a roller landed short of the enemy
      if (best.score > state.weapons[0].blast + TANK_RADIUS) {
        const rollerBest = { score: best.score, angle: best.angle, power: best.power };
        for (let a = angleMin; a <= angleMax; a += 6) {
          for (let p = 20; p <= 95; p += 8) {
            const cmd = { angle: a, power: p, weapon: "roller" };
            const events = projectilesFor(world, state.own.side, cmd, false);
            const score = missScore(events, state.opponent, state.own);
            if (score < rollerBest.score) {
              rollerBest.score = score;
              rollerBest.angle = a;
              rollerBest.power = p;
            }
          }
        }
        if (rollerBest.score + 4 < best.score) {
          best = {
            score: rollerBest.score,
            angle: rollerBest.angle,
            power: rollerBest.power,
            weapon: "roller",
          };
        }
      }

      return { angle: best.angle, power: best.power, weapon: best.weapon };
    };
  }


  // Shaky Solver: same physics search as Solver, but it misjudges the wind
  // and has hand tremor on angle and power, so it has to adjust over turns.
  function createShakySolver(rng) {
    const r = typeof rng === "function" ? rng : Math.random;
    const solve = createSolver();
    function gauss() {
      return (r() + r() + r() - 1.5) / 0.5; // roughly unit-ish spread
    }
    return function (state) {
      const windErr = gauss() * WIND_MAX * 0.18;
      const seen = Object.assign({}, state, { wind: state.wind + windErr });
      const cmd = solve(seen);
      return {
        angle: clamp(Math.round(cmd.angle + gauss() * 2.5), 0, 180),
        power: clamp(Math.round(cmd.power + gauss() * 3), 0, 100),
        weapon: cmd.weapon,
      };
    };
  }

  const BOT_FACTORIES = {
    random: function (ctx) {
      return createRandom(ctx && ctx.rng ? ctx.rng : Math.random);
    },
    naive: function () {
      return createNaive();
    },
    bracketer: function () {
      return createBracketer();
    },
    solver: function () {
      return createSolver();
    },
    shaky: function (ctx) {
      return createShakySolver(ctx && ctx.rng ? ctx.rng : Math.random);
    },
  };

  const BUILTIN_BOTS = Object.freeze(["random", "naive", "bracketer", "solver", "shaky"]);

  function createBot(name, ctx) {
    const key = String(name || "").toLowerCase();
    const factory = BOT_FACTORIES[key];
    if (!factory) throw new Error("Unknown bot: " + name);
    return factory(ctx || {});
  }

  function simulateMatch(leftCtrl, rightCtrl, opts) {
    opts = opts || {};
    const world = createWorld(opts);
    const limit = opts.timeLimitMs == null ? BOT_TIME_LIMIT_MS : opts.timeLimitMs;
    const leftFn =
      typeof leftCtrl === "function" ? leftCtrl : createBot(leftCtrl, { rng: world.rng });
    const rightFn =
      typeof rightCtrl === "function"
        ? rightCtrl
        : createBot(rightCtrl, { rng: world.rng });

    let guard = 0;
    while (!world.over && guard++ < MAX_TURNS + 2) {
      const side = world.side;
      const fn = side === "left" ? leftFn : rightFn;
      const snap = snapshotFor(world, side);
      const result = runBot(fn, snap, limit);
      resolveShot(world, result.cmd, {
        error: result.error,
        timeout: result.timeout,
        path: false,
      });
    }
    if (!world.over) {
      world.over = true;
      world.winner = "draw";
    }
    const shots = world.stats.shots.left + world.stats.shots.right;
    const hits = world.stats.hits.left + world.stats.hits.right;
    return {
      winner: world.winner,
      turns: world.turn,
      seed: world.seed,
      shots: world.stats.shots,
      hits: world.stats.hits,
      errors: world.stats.errors,
      timeouts: world.stats.timeouts,
      firstHitShots: world.stats.firstHitShots,
      accuracy: shots ? hits / shots : 0,
      leftoverHp: { left: world.left.hp, right: world.right.hp },
    };
  }

  function simulateSeries(opts) {
    opts = opts || {};
    const n = opts.n || 20;
    const seed = opts.seed == null ? 42 : opts.seed >>> 0;
    const left = opts.left;
    const right = opts.right;
    const wins = { left: 0, right: 0, draw: 0 };
    const errors = { left: 0, right: 0 };
    const timeouts = { left: 0, right: 0 };
    const shots = { left: 0, right: 0 };
    const hits = { left: 0, right: 0 };
    let firstHitSum = 0;
    let firstHitN = 0;
    const matches = [];
    for (let i = 0; i < n; i++) {
      // Fresh controllers per match so bracketer state resets
      const res = simulateMatch(left, right, {
        seed: (seed + i * 997) >>> 0,
        timeLimitMs: opts.timeLimitMs,
      });
      wins[res.winner]++;
      errors.left += res.errors.left;
      errors.right += res.errors.right;
      timeouts.left += res.timeouts.left;
      timeouts.right += res.timeouts.right;
      shots.left += res.shots.left;
      shots.right += res.shots.right;
      hits.left += res.hits.left;
      hits.right += res.hits.right;
      if (res.firstHitShots != null) {
        firstHitSum += res.firstHitShots;
        firstHitN++;
      }
      matches.push(res);
    }
    const totalShots = shots.left + shots.right;
    const totalHits = hits.left + hits.right;
    return {
      n: n,
      seed: seed,
      left: typeof left === "function" ? "custom" : left,
      right: typeof right === "function" ? "custom" : right,
      wins: wins,
      winRateLeft: wins.left / n,
      winRateRight: wins.right / n,
      drawRate: wins.draw / n,
      avgShotsToFirstHit: firstHitN ? firstHitSum / firstHitN : null,
      firstHitMatches: firstHitN,
      accuracy: {
        left: shots.left ? hits.left / shots.left : 0,
        right: shots.right ? hits.right / shots.right : 0,
        overall: totalShots ? totalHits / totalShots : 0,
      },
      shots: shots,
      hits: hits,
      errors: errors,
      timeouts: timeouts,
      matches: matches,
    };
  }

  return {
    CONSTANTS: CONSTANTS,
    WEAPONS: WEAPONS,
    WEAPON_LIST: WEAPON_LIST,
    BUILTIN_BOTS: BUILTIN_BOTS,
    createRng: mulberry32,
    generateTerrain: generateTerrain,
    createWorld: createWorld,
    snapshotFor: snapshotFor,
    compileCustom: compileCustom,
    runBot: runBot,
    createBot: createBot,
    createRandom: createRandom,
    createNaive: createNaive,
    createBracketer: createBracketer,
    createSolver: createSolver,
    createShakySolver: createShakySolver,
    projectilesFor: projectilesFor,
    integrateProjectile: integrateProjectile,
    resolveShot: resolveShot,
    sanitizeCmd: sanitizeCmd,
    launchVelocity: launchVelocity,
    muzzlePos: muzzlePos,
    terrainAt: terrainAt,
    carveCrater: carveCrater,
    carveTrench: carveTrench,
    simulateMatch: simulateMatch,
    simulateSeries: simulateSeries,
    applyImpacts: applyImpacts,
    packTrajectory: packTrajectory,
    compactTerrain: compactTerrain,
  };
});

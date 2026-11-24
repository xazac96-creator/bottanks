#!/usr/bin/env node
"use strict";

const engine = require("./engine.js");

const results = [];
let failed = 0;

function pass(name, detail) {
  results.push({ name: name, ok: true, detail: detail });
  console.log("PASS  " + name + (detail ? " — " + detail : ""));
}

function fail(name, detail) {
  failed++;
  results.push({ name: name, ok: false, detail: detail });
  console.log("FAIL  " + name + " — " + detail);
}

function pct(n) {
  return (n * 100).toFixed(1) + "%";
}

function num(n, d) {
  if (n == null || !isFinite(n)) return "n/a";
  return Number(n).toFixed(d == null ? 3 : d);
}

// 1. A match completes
(function () {
  const res = engine.simulateMatch("solver", "naive", { seed: 7 });
  if (!res.winner || res.leftoverHp.left < 0 || res.leftoverHp.right < 0) {
    fail("match completes", JSON.stringify(res));
    return;
  }
  const ended =
    res.winner === "left" || res.winner === "right" || res.winner === "draw";
  if (!ended) {
    fail("match completes", "bad winner " + res.winner);
    return;
  }
  pass(
    "match completes",
    "winner=" +
      res.winner +
      " shots=" +
      (res.shots.left + res.shots.right) +
      " leftover HP L/R=" +
      num(res.leftoverHp.left, 1) +
      "/" +
      num(res.leftoverHp.right, 1) +
      " seed=" +
      res.seed
  );
})();

// 2. Solver vs Random — Solver should win heavily
const vsRandom = engine.simulateSeries({
  left: "solver",
  right: "random",
  n: 25,
  seed: 42,
});
(function () {
  const wr = vsRandom.winRateLeft;
  const detail =
    "Solver " +
    vsRandom.wins.left +
    " / Random " +
    vsRandom.wins.right +
    " / draws " +
    vsRandom.wins.draw +
    "  (Solver win rate " +
    pct(wr) +
    ")" +
    "  accuracy S/R " +
    pct(vsRandom.accuracy.left) +
    "/" +
    pct(vsRandom.accuracy.right) +
    "  avg shots to first hit " +
    num(vsRandom.avgShotsToFirstHit, 2) +
    "  errors " +
    (vsRandom.errors.left + vsRandom.errors.right) +
    "  timeouts " +
    (vsRandom.timeouts.left + vsRandom.timeouts.right);
  if (wr >= 0.8 && vsRandom.wins.left > vsRandom.wins.right * 3) {
    pass("Solver vs Random", detail);
  } else {
    fail("Solver vs Random", "Solver did not win heavily. " + detail);
  }
})();

// 3. Solver vs Naive — Solver should win heavily
const vsNaive = engine.simulateSeries({
  left: "solver",
  right: "naive",
  n: 25,
  seed: 42,
});
(function () {
  const wr = vsNaive.winRateLeft;
  const detail =
    "Solver " +
    vsNaive.wins.left +
    " / Naive " +
    vsNaive.wins.right +
    " / draws " +
    vsNaive.wins.draw +
    "  (Solver win rate " +
    pct(wr) +
    ")" +
    "  accuracy S/N " +
    pct(vsNaive.accuracy.left) +
    "/" +
    pct(vsNaive.accuracy.right) +
    "  avg shots to first hit " +
    num(vsNaive.avgShotsToFirstHit, 2) +
    "  errors " +
    (vsNaive.errors.left + vsNaive.errors.right) +
    "  timeouts " +
    (vsNaive.timeouts.left + vsNaive.timeouts.right);
  if (wr >= 0.8 && vsNaive.wins.left > vsNaive.wins.right * 3) {
    pass("Solver vs Naive", detail);
  } else {
    fail("Solver vs Naive", "Solver did not win heavily. " + detail);
  }
})();

// 4. Custom bot errors are handled — match still ends, errors counted
(function () {
  const thrower = engine.compileCustom(
    'function(state){ throw new Error("boom"); }'
  );
  const res = engine.simulateMatch(thrower, "naive", { seed: 99 });
  const ended =
    res.winner === "left" || res.winner === "right" || res.winner === "draw";
  const detail =
    "winner=" +
    res.winner +
    " left errors=" +
    res.errors.left +
    " left shots=" +
    res.shots.left +
    " leftover HP L/R=" +
    num(res.leftoverHp.left, 1) +
    "/" +
    num(res.leftoverHp.right, 1);
  if (!ended) {
    fail("custom throw handled", "match did not end. " + detail);
    return;
  }
  if (res.errors.left < 1) {
    fail("custom throw handled", "no errors counted. " + detail);
    return;
  }
  // Thrower wastes every turn; naive or timeout-winner (HP or max turns) should decide
  if (res.shots.left !== 0) {
    fail("custom throw handled", "thrower should not have fired. " + detail);
    return;
  }
  pass("custom throw handled", detail);
})();

// 5. Custom bot timeout is handled
(function () {
  const slow = engine.compileCustom(
    "function(state){ const t = Date.now(); while (Date.now() - t < 80) {} return {angle:50,power:70,weapon:'shell'}; }"
  );
  const res = engine.simulateMatch(slow, "naive", {
    seed: 123,
    timeLimitMs: 15,
  });
  const detail =
    "winner=" +
    res.winner +
    " left timeouts=" +
    res.timeouts.left +
    " left errors=" +
    res.errors.left +
    " left shots=" +
    res.shots.left;
  if (res.timeouts.left < 1) {
    fail("custom timeout handled", "no timeouts counted. " + detail);
    return;
  }
  if (res.shots.left !== 0) {
    fail("custom timeout handled", "slow bot should not have fired. " + detail);
    return;
  }
  pass("custom timeout handled", detail);
})();

// 6. Compile error is treated as a runtime error on the first call (wasted turns)
(function () {
  const bad = engine.compileCustom("function (state) { return {");
  const res = engine.simulateMatch(bad, "random", { seed: 5 });
  const detail =
    "winner=" +
    res.winner +
    " left errors=" +
    res.errors.left +
    " compileError=" +
    (bad.__compileError || "none");
  if (res.errors.left < 1 || !bad.__compileError) {
    fail("custom compile error handled", detail);
    return;
  }
  pass("custom compile error handled", detail);
})();

// ---- Balance: ammo caps + first side -------------------------------------

// 7. Ammo decrements, exhausted weapon misfires in the engine (server rejects with 400 first)
(function () {
  const w = engine.createWorld({ seed: 77 });
  const off = { angle: 175, power: 100 };
  const capsOk = w.left.ammo.triple === 1 && w.left.ammo.blast === 2 && w.left.ammo.shell === null && w.right.ammo.roller === null;
  const r1 = engine.resolveShot(w, Object.assign({ weapon: "triple" }, off), { path: false });
  engine.resolveShot(w, { angle: 5, power: 100, weapon: "shell" }, { path: false });
  const r3 = engine.resolveShot(w, Object.assign({ weapon: "triple" }, off), { path: false });
  const ok =
    capsOk &&
    r1.ammoAfter.left.triple === 0 && !r1.skipped &&
    r3.skipped && /out of ammo/i.test(r3.error || "") && r3.attemptedWeapon === "triple" &&
    w.left.ammo.triple === 0 && !engine.hasAmmo(w.left.ammo, "triple") &&
    engine.availableWeapons(w.left.ammo).join(",") === "shell,blast,roller";
  if (ok) pass("ammo caps decrement and exhausted weapon misfires", "left ammo " + JSON.stringify(w.left.ammo));
  else fail("ammo caps decrement and exhausted weapon misfires", JSON.stringify({ capsOk: capsOk, r1: r1.ammoAfter, r3: r3.error }));
})();

// 8. Built-in bots only choose weapons that still have ammo
(function () {
  const bots = ["random", "naive", "bracketer", "solver", "shaky"];
  let bad = 0;
  let shots = 0;
  const used = {};
  for (let b = 0; b < bots.length; b++) {
    for (let k = 0; k < 6; k++) {
      const w = engine.createWorld({ seed: 500 + b * 31 + k, firstSide: k % 2 ? "right" : "left" });
      const fns = { left: engine.createBot(bots[b], { rng: w.rng }), right: engine.createBot(bots[(b + k) % bots.length], { rng: w.rng }) };
      let guard = 0;
      while (!w.over && guard++ < 90) {
        const side = w.side;
        const snap = engine.snapshotFor(w, side);
        const res = engine.runBot(fns[side], snap, 1000);
        if (res.cmd) {
          shots++;
          used[res.cmd.weapon] = (used[res.cmd.weapon] || 0) + 1;
          if (!engine.hasAmmo(w[side].ammo, res.cmd.weapon)) bad++;
        }
        engine.resolveShot(w, res.cmd, { error: res.error, timeout: res.timeout, path: false });
      }
    }
  }
  if (bad === 0 && shots > 0) pass("built-in bots respect ammo", shots + " bot shots, 0 empty-weapon picks, weapons " + JSON.stringify(used));
  else fail("built-in bots respect ammo", bad + " empty-weapon picks of " + shots);
})();

// 9. firstSide override + deterministic terrain/wind regardless of who opens
(function () {
  const a = engine.createWorld({ seed: 4242 });
  const b = engine.createWorld({ seed: 4242, firstSide: "right" });
  const same = a.wind === b.wind && a.terrain.every(function (v, i) { return v === b.terrain[i]; });
  const r = engine.resolveShot(b, { angle: 5, power: 100, weapon: "shell" }, { path: false });
  let threw = false;
  try { engine.setFirstSide(b, "left"); } catch (e) { threw = true; }
  const res = engine.simulateSeries({ left: "solver", right: "solver", n: 4, seed: 9, firstSide: "alternate" });
  const sides = res.matches.map(function (m) { return m.firstSide; }).join(",");
  if (a.side === "left" && a.firstSide === "left" && b.firstSide === "right" && r.side === "right" && same && threw && sides === "left,right,left,right") {
    pass("firstSide override (default left, 'right', 'alternate')", "series firstSides " + sides);
  } else fail("firstSide override (default left, 'right', 'alternate')", JSON.stringify({ a: a.side, b: b.firstSide, r: r.side, same: same, threw: threw, sides: sides }));
})();

// 10. Balance proof: a damage-greedy perfect opener can't kill in its first two
//     shots with caps (it could without them).
function greedyBot() {
  const R = engine.CONSTANTS.TANK_RADIUS;
  function dmg(events, opp) {
    let d = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.oob && !ev.impact) continue;
      const dist = Math.max(0, Math.hypot(ev.x - opp.x, ev.y - opp.y) - R);
      if (dist < ev.weapon.blast) d += ev.weapon.damage * (1 - dist / ev.weapon.blast);
    }
    return d;
  }
  return function (state) {
    const side = state.own.side;
    const world = {
      width: state.field.width, height: state.field.height, terrain: state.terrain, gravity: state.gravity, wind: state.wind,
      left: side === "left" ? state.own : state.opponent, right: side === "right" ? state.own : state.opponent,
    };
    const toward = state.opponent.x >= state.own.x;
    let best = { d: -1, angle: toward ? 45 : 135, power: 70, weapon: "shell" };
    const weapons = engine.availableWeapons(state.own.ammo);
    function tryCmd(a, p, wpn) {
      const d = dmg(engine.projectilesFor(world, side, { angle: a, power: p, weapon: wpn }, false), state.opponent);
      if (d > best.d) best = { d: d, angle: a, power: p, weapon: wpn };
    }
    for (let wi = 0; wi < weapons.length; wi++) {
      const local = { d: -1 };
      const keep = best;
      best = { d: -1 };
      for (let a = toward ? 8 : 100; a <= (toward ? 80 : 172); a += 3) for (let p = 20; p <= 100; p += 3) tryCmd(a, p, weapons[wi]);
      const c = best;
      for (let a = c.angle - 3; a <= c.angle + 3; a += 0.5) for (let p = c.power - 3; p <= c.power + 3; p += 0.5) tryCmd(a, p, weapons[wi]);
      local.d = best.d;
      if (keep.d > best.d) best = keep;
    }
    best.lastDamage = best.d;
    return { angle: best.angle, power: best.power, weapon: best.weapon };
  };
}
(function () {
  const seeds = [3, 11, 19, 27, 35, 43];
  function run(ammo) {
    let kills = 0;
    let maxTwo = 0;
    for (let i = 0; i < seeds.length; i++) {
      const w = engine.createWorld({ seed: seeds[i], ammo: ammo });
      const g = greedyBot();
      let dealt = 0;
      for (let shot = 0; shot < 2 && !w.over; shot++) {
        const rec = engine.resolveShot(w, g(engine.snapshotFor(w, "left")), { path: false });
        dealt += rec.damageToOpponent;
        if (!w.over) engine.resolveShot(w, null, {}); // passive opponent skips
      }
      if (dealt > maxTwo) maxTwo = dealt;
      if (w.right.hp <= 0) kills++;
    }
    return { kills: kills, maxTwo: maxTwo };
  }
  const capped = run(undefined);
  const uncapped = run({ triple: null, blast: null });
  const theoretical = 3 * engine.WEAPONS.triple.damage * engine.AMMO_CAPS.triple +
    engine.WEAPONS.blast.damage * Math.max(0, 2 - engine.AMMO_CAPS.triple);
  const detail = "capped: kills in 2 shots " + capped.kills + "/" + seeds.length + ", best 2-shot dmg " + num(capped.maxTwo, 1) +
    " (bound " + theoretical + ")  |  uncapped: kills " + uncapped.kills + "/" + seeds.length + ", best " + num(uncapped.maxTwo, 1);
  if (capped.kills === 0 && capped.maxTwo < 100 && theoretical < engine.CONSTANTS.TANK_HP) pass("ammo caps stop a perfect opener's 2-shot kill", detail);
  else fail("ammo caps stop a perfect opener's 2-shot kill", detail);
})();

console.log("");
console.log("—— Series details ——");
function dump(label, s) {
  console.log(label);
  console.log(
    "  wins L/R/D: " +
      s.wins.left +
      "/" +
      s.wins.right +
      "/" +
      s.wins.draw +
      "  win rates L/R: " +
      pct(s.winRateLeft) +
      "/" +
      pct(s.winRateRight)
  );
  console.log(
    "  accuracy L/R/all: " +
      pct(s.accuracy.left) +
      "/" +
      pct(s.accuracy.right) +
      "/" +
      pct(s.accuracy.overall)
  );
  console.log(
    "  shots L/R: " +
      s.shots.left +
      "/" +
      s.shots.right +
      "  hits L/R: " +
      s.hits.left +
      "/" +
      s.hits.right
  );
  console.log(
    "  avg shots to first hit: " +
      num(s.avgShotsToFirstHit, 3) +
      "  (n=" +
      s.firstHitMatches +
      ")"
  );
  console.log(
    "  errors L/R: " +
      s.errors.left +
      "/" +
      s.errors.right +
      "  timeouts L/R: " +
      s.timeouts.left +
      "/" +
      s.timeouts.right
  );
}
dump("Solver vs Random (n=25, seed=42)", vsRandom);
dump("Solver vs Naive  (n=25, seed=42)", vsNaive);

console.log("");
console.log(
  failed === 0
    ? "All " + results.length + " tests passed."
    : failed + " of " + results.length + " tests failed."
);
process.exit(failed === 0 ? 0 : 1);

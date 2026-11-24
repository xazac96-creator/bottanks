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

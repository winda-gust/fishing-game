#!/usr/bin/env node
"use strict";

// Offline observation harness. It injects random samples only into the exported
// engine constructor; it never adds a forced-fish mode to the browser game.
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const BASELINE = process.env.FISHING_BASELINE || "fd40855c90024718a3f7df887f4355661b266c64";
const LIMIT_MS = 180000;
const SAMPLE_MS = 5;
const OFFSETS_MS = [0, 175, 425];
const beforeSource = execFileSync("git", ["show", `${BASELINE}:game-core.js`], { cwd: ROOT, encoding: "utf8" });
const afterSource = fs.readFileSync(path.join(ROOT, "game-core.js"), "utf8");

function load(source) {
  const context = vm.createContext({ module: { exports: {} } });
  new vm.Script(source).runInContext(context);
  return context.module.exports;
}

const before = load(beforeSource);
const after = load(afterSource);
const finalDelayMs = after.CONFIG.restDelayMs ?? 300;
const strategies = [
  { id: "held", kind: "held" },
  ...[0, 150, 200, 250].map((reactionMs) => ({ id: `adaptive-${reactionMs}ms`, kind: "adaptive", reactionMs })),
  ...[[50, 50], [100, 100], [50, 150], [150, 50], [200, 200], [500, 50], [20, 500], [500, 500]].map(([on, off]) => ({ id: `fixed-${on}/${off}ms`, kind: "fixed", on, off })),
  ...[-1, 0, 1].map((delta) => ({ id: `boundary-100/${finalDelayMs + delta}ms`, kind: "fixed", on: 100, off: finalDelayMs + delta })),
  { id: "near100-release10ms", kind: "near100" },
];

function midpoint(core, fishId) {
  const total = core.FISHES.reduce((sum, fish) => sum + fish.weight, 0);
  let lower = 0;
  for (const fish of core.FISHES) {
    if (fish.id === fishId) return (lower + fish.weight / 2) / total;
    lower += fish.weight;
  }
  throw new Error(`Unknown fish ${fishId}`);
}

function hookedGame(core, fishId) {
  let draw = 0;
  const game = new core.FishingGame({ random: () => draw++ === 0 ? midpoint(core, fishId) : 0.5 });
  game.press();
  game.release();
  while (game.getSnapshot().phase !== "biting") game.advance(game.getSnapshot().phaseRemainingMs);
  game.press();
  game.release();
  return game;
}

const round = (number) => Math.round(number * 1000) / 1000;

function simulate(core, fishId, strategy, offsetMs) {
  const game = hookedGame(core, fishId);
  let now = 0;
  let snapshot = game.getSnapshot();
  let winding = false;
  let adaptiveTarget = true;
  let observedTarget = false;
  let pendingTarget = null;
  let pendingAt = Infinity;
  let nearReleased = false;
  let nearReleaseAt = Infinity;
  let maxTension = snapshot.tension;
  let maxDanger = 0;
  let dangerAdded = 0;
  let dangerClears = 0;
  let dangerStarts = 0;
  let firstDangerAt = null;
  let firstClearAt = null;
  let dangerHeldOnRelease = null;
  let dangerAfterRelease = null;
  let maxProgress = 0;
  const dangerTrace = [];
  let tracedDangerRest = false;

  function markDanger(label, final = false) {
    if (dangerTrace.length < 8 || final) {
      dangerTrace.push(`${round(now)}:${label}:${snapshot.fishState ?? "ended"}:${snapshot.isReeling ? "winding" : "resting"}:${round(snapshot.tension)}:${round(snapshot.overloadMs)}`);
    }
  }

  function setWinding(next) {
    if (next === winding) return;
    const traceInput = snapshot.overloadMs > 0 || snapshot.tension >= 99 || (next && tracedDangerRest);
    if (!next && traceInput) tracedDangerRest = true;
    if (next) game.press();
    else game.release();
    winding = next;
    snapshot = game.getSnapshot();
    if (traceInput) markDanger(next ? "press" : "release");
    if (next) tracedDangerRest = false;
  }

  while (now < LIMIT_MS && snapshot.phase === "reeling") {
    let nextBoundary = now + SAMPLE_MS;
    if (now < offsetMs) {
      setWinding(false);
      nextBoundary = Math.min(nextBoundary, offsetMs);
    } else if (strategy.kind === "held") {
      setWinding(true);
    } else if (strategy.kind === "fixed") {
      const cycle = strategy.on + strategy.off;
      const position = (now - offsetMs) % cycle;
      const on = position < strategy.on;
      setWinding(on);
      nextBoundary = Math.min(nextBoundary, now + (on ? strategy.on - position : cycle - position));
    } else if (strategy.kind === "adaptive") {
      // A visible-state controller with tension hysteresis. Rest begins at 75%,
      // and a high-tension rest ends only at 40%; warning/struggle always rest.
      if (snapshot.fishState !== "calm" || snapshot.tension >= 75) adaptiveTarget = false;
      else if (snapshot.tension <= 40) adaptiveTarget = true;
      if (adaptiveTarget !== observedTarget) {
        observedTarget = adaptiveTarget;
        pendingTarget = adaptiveTarget;
        pendingAt = now + strategy.reactionMs;
      }
      if (now >= pendingAt) {
        setWinding(pendingTarget);
        pendingAt = Infinity;
      }
      nextBoundary = Math.min(nextBoundary, pendingAt);
    } else if (strategy.kind === "near100") {
      if (!nearReleased && snapshot.overloadMs >= 700) {
        dangerHeldOnRelease = snapshot.overloadMs;
        setWinding(false);
        nearReleased = true;
        nearReleaseAt = now + 10;
      } else if (!nearReleased || now >= nearReleaseAt) {
        if (nearReleased && dangerAfterRelease === null) {
          dangerAfterRelease = snapshot.overloadMs;
          markDanger("after10ms");
        }
        setWinding(true);
      }
      nextBoundary = Math.min(nextBoundary, nearReleaseAt > now ? nearReleaseAt : Infinity);
    }
    const step = Math.min(nextBoundary - now, LIMIT_MS - now);
    if (step <= 0) throw new Error("Harness did not advance time");
    const previousDanger = snapshot.overloadMs;
    game.advance(step);
    now += step;
    snapshot = game.getSnapshot();
    maxTension = Math.max(maxTension, snapshot.tension);
    maxDanger = Math.max(maxDanger, snapshot.overloadMs);
    maxProgress = Math.max(maxProgress, snapshot.progress);
    if (snapshot.overloadMs > previousDanger) {
      dangerAdded += snapshot.overloadMs - previousDanger;
      if (previousDanger === 0) {
        dangerStarts += 1;
        firstDangerAt ??= now;
        markDanger("start");
      }
      if (previousDanger < 300 && snapshot.overloadMs >= 300) markDanger("300ms");
      if (previousDanger < 600 && snapshot.overloadMs >= 600) markDanger("600ms");
    }
    if (snapshot.overloadMs < previousDanger) {
      dangerClears += 1;
      firstClearAt ??= now;
      markDanger("clear");
    }
  }
  const outcome = snapshot.phase === "success" ? "success"
    : snapshot.phase === "failure" && snapshot.failureReason === "line" ? "line-break"
      : snapshot.phase === "reeling" ? "undecided" : snapshot.phase;
  markDanger(outcome, true);
  return {
    fish: fishId, condition: strategy.id, offsetMs, outcome,
    elapsedMs: round(now), maxTension: round(maxTension), maxProgress: round(maxProgress),
    dangerPeakMs: round(maxDanger), dangerAddedMs: round(dangerAdded), dangerStarts, dangerClears,
    firstDangerMs: firstDangerAt, firstClearMs: firstClearAt,
    dangerAtBriefReleaseMs: dangerHeldOnRelease, dangerAfterBriefReleaseMs: dangerAfterRelease,
    finalProgress: snapshot.progress, finalTension: snapshot.tension, finalDangerMs: snapshot.overloadMs,
    dangerTrace: dangerTrace.join(";"),
  };
}

function recoveryProbe(core, fishId, restMs) {
  const game = hookedGame(core, fishId);
  game.press();
  while (game.getSnapshot().phase === "reeling" && game.getSnapshot().overloadMs < 700) game.advance(SAMPLE_MS);
  const prior = game.getSnapshot();
  assert.equal(prior.phase, "reeling", "Recovery probe must reach danger before terminating");
  game.release();
  game.advance(restMs);
  const result = game.getSnapshot();
  return { fish: fishId, restMs, tensionBefore: prior.tension, tensionAfter: result.tension,
    dangerBeforeMs: prior.overloadMs, dangerAfterMs: result.overloadMs };
}

const runs = [];
for (const [version, core] of [["before", before], ["after", after]]) {
  for (const fish of before.FISHES) {
    for (const strategy of strategies) {
      for (const offset of OFFSETS_MS) runs.push({ version, ...simulate(core, fish.id, strategy, offset) });
    }
  }
}

function aggregate(version, fish, condition) {
  const selected = runs.filter((row) => row.version === version && row.fish === fish && row.condition === condition);
  const successes = selected.filter((row) => row.outcome === "success");
  return {
    version, fish, condition, runs: selected.length,
    success: successes.length,
    lineBreak: selected.filter((row) => row.outcome === "line-break").length,
    undecided: selected.filter((row) => row.outcome === "undecided").length,
    successSeconds: successes.length ? [round(Math.min(...successes.map((row) => row.elapsedMs)) / 1000), round(Math.max(...successes.map((row) => row.elapsedMs)) / 1000)] : null,
    maxTension: Math.max(...selected.map((row) => row.maxTension)),
    dangerPeakMs: Math.max(...selected.map((row) => row.dangerPeakMs)),
    dangerClears: selected.reduce((sum, row) => sum + row.dangerClears, 0),
  };
}

const summary = {
  baselineCommit: BASELINE,
  sourceSha256: {
    before: createHash("sha256").update(beforeSource).digest("hex"),
    after: createHash("sha256").update(afterSource).digest("hex"),
  },
  comparison: "committed baseline game-core.js versus current working-tree game-core.js",
  observationLimitMs: LIMIT_MS, controlSamplingMs: SAMPLE_MS, terminalTimeUncertaintyMs: SAMPLE_MS,
  reelStartOffsetsMs: OFFSETS_MS,
  random: "first sample = species weighted midpoint; subsequent waiting samples = 0.5",
  dangerTrace: "CSV records up to first 8 danger events plus final state as elapsedMs:event:fishState:input:tensionPercent:dangerMs; traces are sampled at <=5ms, not full raw logs",
  adaptive: "75% starts high-tension rest, 40% permits winding again; non-calm always rest; requested lag applies to both press and release",
  recoveryDelayMs: finalDelayMs,
  safeTension: after.CONFIG.safeTension ?? null,
  breakGraceMs: after.CONFIG.breakGraceMs,
  struggleRegressionRates: Object.fromEntries(Object.entries(after.FISH_BEHAVIORS).map(([id, behavior]) => [id, behavior.regressionRate ?? null])),
  fishRulesUnchanged: JSON.stringify(before.FISHES) === JSON.stringify(after.FISHES),
  recoveryBoundaryProbes: [],
  aggregate: [],
};
for (const [version, core] of [["before", before], ["after", after]]) {
  for (const fish of before.FISHES) {
    for (const delta of [-1, 0, 1]) summary.recoveryBoundaryProbes.push({ version, ...recoveryProbe(core, fish.id, finalDelayMs + delta) });
  }
}
for (const fish of before.FISHES) {
  for (const strategy of strategies) {
    for (const version of ["before", "after"]) summary.aggregate.push(aggregate(version, fish.id, strategy.id));
  }
}

assert.equal(summary.fishRulesUnchanged, true, "Species, original weights and scores must be unchanged");
for (const lag of [0, 150, 200, 250]) {
  const selected = runs.filter((row) => row.version === "after" && row.condition === `adaptive-${lag}ms`);
  assert.equal(selected.length, 18);
  assert.ok(selected.every((row) => row.outcome === "success"), `Adaptive ${lag}ms must succeed for every species/offset`);
}
for (const condition of ["fixed-50/50ms", "fixed-100/100ms", "fixed-50/150ms", "fixed-150/50ms", "fixed-200/200ms", "fixed-500/50ms"]) {
  assert.ok(runs.filter((row) => row.version === "before" && row.condition === condition).every((row) => row.outcome === "success"), `Baseline ${condition} reproduction failed`);
  assert.ok(runs.filter((row) => row.version === "after" && row.condition === condition).every((row) => row.outcome === "line-break"), `Fast rhythm ${condition} still exploits recovery`);
}
assert.ok(runs.filter((row) => row.version === "after" && row.condition === "near100-release10ms").every((row) => row.dangerAtBriefReleaseMs === row.dangerAfterBriefReleaseMs), "Ten millisecond release must retain danger exactly");
summary.acceptance = { allSpeciesAdaptive0_150_200_250ms: "passed", sixFastRhythmsNoRecoveryExploit: "passed", briefReleaseRetainsDanger: "passed", fishProbabilitiesAndScoresUnchanged: "passed" };
summary.representativeDangerTraces = runs.filter((row) => row.fish === "gold" && row.offsetMs === 0 && ["fixed-500/50ms", "near100-release10ms"].includes(row.condition)).map((row) => ({
  version: row.version, condition: row.condition, outcome: row.outcome,
  trace: row.dangerTrace.split(";").map((mark) => {
    const [elapsedMs, event, fishState, input, tension, dangerMs] = mark.split(":");
    return { elapsedMs: Number(elapsedMs), event, fishState, input, tension: Number(tension), dangerMs: Number(dangerMs) };
  }),
}));

const reportDirectory = path.join(ROOT, "reports");
fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(path.join(reportDirectory, "reeling-balance-summary.json"), JSON.stringify(summary, null, 2) + "\n");
const columns = Object.keys(runs[0]);
fs.writeFileSync(path.join(reportDirectory, "reeling-balance-runs.csv"), [columns.join(","), ...runs.map((row) => columns.map((key) => row[key] ?? "").join(","))].join("\n") + "\n");

console.log(`Baseline ${BASELINE}; ${runs.length} runs, ${LIMIT_MS / 1000}s cap, ${SAMPLE_MS}ms control sampling.`);
for (const strategy of strategies) {
  const line = [strategy.id];
  for (const version of ["before", "after"]) {
    const selected = runs.filter((row) => row.version === version && row.condition === strategy.id);
    line.push(`${version}: ${selected.filter((row) => row.outcome === "success").length} success / ${selected.filter((row) => row.outcome === "line-break").length} break / ${selected.filter((row) => row.outcome === "undecided").length} undecided`);
  }
  console.log(line.join(" | "));
}
console.log("Saved reports/reeling-balance-summary.json and reports/reeling-balance-runs.csv");

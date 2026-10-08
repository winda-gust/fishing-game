"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { FISHES, CONFIG, FISH_BEHAVIORS, FishingGame } = require("../game-core.js");

const expectedCatalog = [
  { id: "aji", name: "アジ", points: 10, weight: 35, color: "#66cbb7", rarity: "よく釣れる" },
  { id: "iwashi", name: "イワシ", points: 15, weight: 25, color: "#76b7e5", rarity: "よく釣れる" },
  { id: "saba", name: "サバ", points: 20, weight: 20, color: "#588dd7", rarity: "よく釣れる" },
  { id: "tai", name: "タイ", points: 50, weight: 12, color: "#ec8494", rarity: "レア" },
  { id: "maguro", name: "マグロ", points: 100, weight: 6, color: "#6874c7", rarity: "超レア" },
  { id: "gold", name: "金の魚", points: 300, weight: 2, color: "#efbd50", rarity: "伝説" },
];
const totalWeight = FISHES.reduce((sum, fish) => sum + fish.weight, 0);

function gameAt(sample, timing = 0.5) {
  let calls = 0;
  return new FishingGame({ random: () => calls++ === 0 ? sample : timing });
}

function sampleFor(fishId) {
  let start = 0;
  for (const fish of FISHES) {
    if (fish.id === fishId) return (start + fish.weight / 2) / totalWeight;
    start += fish.weight;
  }
  throw new Error("Unknown fish");
}

function cast(game, { release = true } = {}) {
  assert.equal(game.press(), true);
  assert.equal(game.getSnapshot().phase, "waiting");
  if (release) game.release();
}

function reachBite(game) {
  for (let index = 0; index < 6; index += 1) {
    const state = game.getSnapshot();
    if (state.phase === "biting") return;
    assert.ok(["waiting", "nibbling"].includes(state.phase));
    game.advance(state.phaseRemainingMs);
  }
  assert.fail("Bite must follow at most two nibbles");
}

function hook(game) {
  reachBite(game);
  assert.equal(game.press(), true);
  assert.equal(game.getSnapshot().phase, "reeling");
  assert.equal(game.getSnapshot().needsRelease, true);
  game.release();
}

function smartFinish(game) {
  for (let index = 0; index < 40; index += 1) {
    const state = game.getSnapshot();
    if (state.phase !== "reeling") return state;
    if (state.fishState === "calm") {
      if (!state.isHeld) game.press();
    } else {
      game.release();
    }
    game.advance(state.fishStateRemainingMs);
  }
  assert.fail("Calm-only reeling must complete every fish");
}

function caughtAt(sample) {
  const game = gameAt(sample);
  cast(game);
  hook(game);
  return smartFinish(game);
}

function splitAdvance(game, elapsed, step) {
  let remaining = elapsed;
  while (remaining > 0) {
    const amount = Math.min(step, remaining);
    game.advance(amount);
    remaining -= amount;
  }
}

function reelingGame(fishId = "aji") {
  const game = gameAt(sampleFor(fishId));
  cast(game);
  hook(game);
  return game;
}

function phaseGame(phase) {
  const game = gameAt(0);
  if (phase === "idle") return game;
  cast(game);
  if (phase === "waiting") return game;
  game.advance(1200);
  if (phase === "nibbling") return game;
  reachBite(game);
  if (phase === "biting") return game;
  if (phase === "failure") {
    game.advance(CONFIG.reactionMs);
    return game;
  }
  game.press();
  game.release();
  if (phase === "reeling") return game;
  if (phase === "paused") {
    game.press();
    game.advance(4720);
    game.pause();
    return game;
  }
  smartFinish(game);
  return game;
}

test("classic browser script exports the API without CommonJS, modules, or a server", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../game-core.js"), "utf8"), context);
  assert.equal(typeof context.FishingGameCore.FishingGame, "function");
  assert.equal(context.FishingGameCore.CONFIG.reactionMs, 1800);
  assert.equal(context.FishingGameCore.FISHES.length, 6);
  const game = new context.FishingGameCore.FishingGame({ random: () => 0.5 });
  game.press();
  game.release();
  game.advance(3050);
  assert.equal(game.getSnapshot().phase, "biting");
});

test("catalog values stay exactly unchanged and catalog/config/behaviors are deeply immutable", () => {
  assert.deepEqual(FISHES, expectedCatalog);
  assert.equal(new Set(FISHES.map((fish) => fish.id)).size, 6);
  for (const item of [FISHES, CONFIG, FISH_BEHAVIORS, ...FISHES, ...Object.values(FISH_BEHAVIORS)]) {
    assert.equal(Object.isFrozen(item), true);
  }
  assert.throws(() => { FISHES[0].points = 999; }, TypeError);
  assert.throws(() => { CONFIG.reactionMs = 1; }, TypeError);
  assert.throws(() => { FISH_BEHAVIORS.gold.progressRate = 999; }, TypeError);
});

test("weighted selection covers both sides of every original boundary", () => {
  assert.equal(caughtAt(0).caughtFish.id, "aji");
  let cumulative = 0;
  for (let index = 0; index < FISHES.length - 1; index += 1) {
    cumulative += FISHES[index].weight;
    const boundary = cumulative / totalWeight;
    assert.equal(caughtAt(boundary - 1e-10).caughtFish.id, FISHES[index].id);
    assert.equal(caughtAt(boundary).caughtFish.id, FISHES[index + 1].id);
    assert.equal(caughtAt(boundary + 1e-10).caughtFish.id, FISHES[index + 1].id);
  }
  assert.equal(caughtAt(1 - Number.EPSILON).caughtFish.id, "gold");
  assert.equal(caughtAt(1).caughtFish.id, "gold");
});

test("fish is selected exactly once per cast and all subsequent samples determine timing only", () => {
  let calls = 0;
  const game = new FishingGame({ random: () => calls++ === 0 ? 0.99 : 0.5 });
  cast(game);
  assert.equal(calls, 7);
  hook(game);
  game.pause();
  game.press();
  game.release();
  const result = smartFinish(game);
  assert.equal(result.caughtFish.id, "gold");
  assert.equal(calls, 7);
});

test("one or two nibbles precede a bite with bounded timing, including all timing extremes", () => {
  for (const timing of [0, 0.4999, 0.5, 1]) {
    const game = gameAt(0, timing);
    cast(game);
    let elapsed = 0;
    let nibbles = 0;
    let transitions = 0;
    while (game.getSnapshot().phase !== "biting") {
      const state = game.getSnapshot();
      if (state.phase === "nibbling") {
        nibbles += 1;
        assert.ok(state.phaseRemainingMs >= 250 && state.phaseRemainingMs <= 400);
      }
      if (transitions === 0) assert.ok(state.phaseRemainingMs >= 900 && state.phaseRemainingMs <= 1500);
      elapsed += state.phaseRemainingMs;
      game.advance(state.phaseRemainingMs);
      assert.ok(++transitions <= 5);
    }
    assert.equal(nibbles, timing < 0.5 ? 1 : 2);
    assert.ok(elapsed >= 2000 && elapsed <= 3800);
    assert.equal(game.getSnapshot().biteRemainingMs, CONFIG.reactionMs);
  }
});

test("early clicks fail both in waiting and nibbling, with zero score and no fish disclosure", () => {
  for (const phase of ["waiting", "nibbling"]) {
    const game = phaseGame(phase);
    assert.equal(game.press(), true);
    const snapshot = game.getSnapshot();
    assert.equal(snapshot.phase, "failure");
    assert.equal(snapshot.failureReason, "early");
    assert.equal(snapshot.totalScore, 0);
    assert.deepEqual(snapshot.catches, []);
    assert.equal(snapshot.caughtFish, null);
    game.advance(100000);
    assert.deepEqual(game.getSnapshot(), snapshot);
  }
});

test("hook succeeds immediately and just before the exact bite cutoff, but never at or after it", () => {
  for (const elapsed of [0, CONFIG.reactionMs - 0.001]) {
    const game = phaseGame("biting");
    game.advance(elapsed);
    game.press();
    assert.equal(game.getSnapshot().phase, "reeling");
    assert.equal(game.getSnapshot().tension, 20);
  }
  for (const elapsed of [CONFIG.reactionMs, CONFIG.reactionMs + 1000, Number.MAX_VALUE]) {
    const game = phaseGame("biting");
    game.advance(elapsed);
    assert.equal(game.getSnapshot().phase, "failure");
    assert.equal(game.getSnapshot().failureReason, "late");
    assert.equal(game.getSnapshot().totalScore, 0);
  }
});

test("cast held through a bite and repeated keydown never auto-hook or recast", () => {
  const game = gameAt(0);
  cast(game, { release: false });
  for (let index = 0; index < 10; index += 1) assert.equal(game.press(), false);
  reachBite(game);
  assert.equal(game.getSnapshot().phase, "biting");
  assert.equal(game.press(), false);
  game.advance(CONFIG.reactionMs);
  assert.equal(game.getSnapshot().failureReason, "late");
  assert.equal(game.getSnapshot().isHeld, true);
  assert.equal(game.press(), false);
  game.advance(10000);
  assert.equal(game.getSnapshot().phase, "failure");
  game.release();
  assert.equal(game.press(), true);
  assert.equal(game.getSnapshot().phase, "waiting");
});

test("hook held through repeated input cannot wind until a release and fresh press", () => {
  const game = phaseGame("biting");
  game.press();
  assert.equal(game.getSnapshot().needsRelease, true);
  assert.equal(game.getSnapshot().isReeling, false);
  assert.equal(game.press(), false);
  game.advance(10000);
  assert.equal(game.getSnapshot().phase, "reeling");
  assert.equal(game.getSnapshot().progress, 0);
  assert.equal(game.getSnapshot().tension, 0);
  game.release();
  assert.equal(game.getSnapshot().needsRelease, false);
  game.press();
  assert.equal(game.getSnapshot().isReeling, true);
  game.advance(100);
  assert.ok(game.getSnapshot().progress > 0);
});

for (const fish of FISHES) {
  test(`${fish.name}: continuous hold breaks the line before progress 100`, () => {
    const game = reelingGame(fish.id);
    game.press();
    game.advance(100000);
    const state = game.getSnapshot();
    assert.equal(state.phase, "failure");
    assert.equal(state.failureReason, "line");
    assert.equal(state.tension, CONFIG.maxTension);
    assert.equal(state.overloadMs, CONFIG.breakGraceMs);
    assert.ok(state.progress < CONFIG.maxProgress);
    assert.equal(state.caughtFish, null);
    assert.equal(state.totalScore, 0);
    assert.deepEqual(state.catches, []);
    assert.equal(game.press(), false);
  });

  test(`${fish.name}: calm-only reeling succeeds for the original score; warnings always precede struggle`, () => {
    const game = reelingGame(fish.id);
    const behavior = FISH_BEHAVIORS[fish.id];
    assert.equal(game.getSnapshot().pullHint, behavior.pullHint);
    assert.equal(game.getSnapshot().shadowScale, behavior.shadowScale);
    game.press();
    game.advance(behavior.calmMs);
    assert.equal(game.getSnapshot().fishState, "warning");
    game.release();
    game.advance(behavior.warningMs);
    assert.equal(game.getSnapshot().fishState, "struggling");
    game.advance(behavior.struggleMs);
    assert.equal(game.getSnapshot().fishState, "calm");
    const result = smartFinish(game);
    assert.equal(result.phase, "success");
    assert.equal(result.caughtFish.id, fish.id);
    assert.equal(result.progress, 100);
    assert.equal(result.totalScore, fish.points);
    assert.deepEqual(result.catches, [fish]);
  });
}

test("long rests keep every fish and preserve progress while tension decreases, with no escape or slack failure", () => {
  for (const fish of FISHES) {
    const game = reelingGame(fish.id);
    game.press();
    game.advance(500);
    const before = game.getSnapshot();
    game.release();
    game.advance(600000);
    const after = game.getSnapshot();
    assert.equal(after.phase, "reeling");
    assert.equal(after.progress, before.progress);
    assert.equal(after.tension, 0);
    assert.equal(after.overloadMs, 0);
    assert.equal(after.caughtFish, null);
    assert.equal(smartFinish(game).caughtFish.id, fish.id);
  }
  const game = reelingGame();
  game.advance(Number.MAX_VALUE);
  assert.equal(game.getSnapshot().phase, "reeling");
  assert.equal(game.getSnapshot().progress, 0);
});

test("one moment at tension 100 is recoverable; grace is exactly 900ms and rest clears overload", () => {
  const game = reelingGame();
  game.press();
  game.advance(4320);
  assert.equal(game.getSnapshot().tension, 100);
  assert.equal(game.getSnapshot().overloadMs, 0);
  game.advance(899);
  assert.equal(game.getSnapshot().phase, "reeling");
  assert.equal(game.getSnapshot().overloadMs, 899);
  game.release();
  game.advance(0);
  assert.equal(game.getSnapshot().overloadMs, 899);
  const progress = game.getSnapshot().progress;
  game.advance(0.001);
  assert.equal(game.getSnapshot().overloadMs, 0);
  assert.ok(game.getSnapshot().tension < 100);
  assert.equal(game.getSnapshot().progress, progress);
  // Keep resting before winding again: the reset grace does not erase existing tension.
  game.advance(5000);
  assert.equal(game.getSnapshot().tension, 0);
  assert.equal(smartFinish(game).phase, "success");

  const exact = reelingGame();
  exact.press();
  exact.advance(4320 + 900);
  assert.equal(exact.getSnapshot().phase, "failure");
  assert.equal(exact.getSnapshot().failureReason, "line");
});

test("pause freezes each active phase, including an overloaded reel, and clears held input", () => {
  for (const phase of ["waiting", "nibbling", "biting", "reeling"]) {
    const game = phaseGame(phase);
    if (phase === "reeling") {
      game.press();
      game.advance(4720);
      assert.equal(game.getSnapshot().overloadMs, 400);
    }
    const before = game.getSnapshot();
    assert.equal(game.pause(), true);
    const paused = game.getSnapshot();
    assert.equal(paused.phase, "paused");
    assert.equal(paused.pausedPhase, phase);
    assert.equal(paused.isHeld, false);
    assert.equal(paused.isReeling, false);
    for (const key of ["progress", "tension", "overloadMs", "phaseRemainingMs", "biteRemainingMs", "fishState", "fishStateRemainingMs"]) {
      assert.equal(paused[key], before[key]);
    }
    game.advance(1000000);
    assert.deepEqual(game.getSnapshot(), paused);
    assert.equal(game.pause(), false);
    game.release();
    assert.deepEqual(game.getSnapshot(), paused);
    assert.equal(game.press(), true);
    assert.equal(game.getSnapshot().phase, phase);
    assert.equal(game.getSnapshot().pausedPhase, null);
    assert.equal(game.press(), false);
    if (phase === "biting") {
      assert.equal(game.getSnapshot().phase, "biting", "resume press must not hook");
      game.release();
      game.press();
      assert.equal(game.getSnapshot().phase, "reeling");
    }
    if (phase === "reeling") {
      assert.equal(game.getSnapshot().isReeling, false);
      assert.equal(game.getSnapshot().needsRelease, true);
      game.advance(1);
      assert.equal(game.getSnapshot().progress, before.progress);
      assert.equal(game.getSnapshot().overloadMs, 0);
      game.release();
      game.press();
      assert.equal(game.getSnapshot().isReeling, true);
    }
  }
});

test("idle and terminal states ignore advance and pause, and repeated terminal presses cannot award twice", () => {
  for (const phase of ["idle", "success", "failure"]) {
    const game = phaseGame(phase);
    const state = game.getSnapshot();
    assert.equal(game.pause(), false);
    game.advance(Number.MAX_VALUE);
    assert.deepEqual(game.getSnapshot(), state);
    if (phase === "success") {
      assert.equal(game.press(), false);
      assert.equal(game.getSnapshot().totalScore, 10);
      assert.equal(game.getSnapshot().catches.length, 1);
      game.release();
      game.press();
      assert.equal(game.getSnapshot().phase, "waiting");
      assert.equal(game.getSnapshot().caughtFish, null);
      assert.equal(game.getSnapshot().totalScore, 10);
    }
  }
});

test("reset from every phase clears the full attempt and records; old advances and releases have no effect", () => {
  const idle = new FishingGame().getSnapshot();
  for (const phase of ["idle", "waiting", "nibbling", "biting", "reeling", "paused", "success", "failure"]) {
    const game = phaseGame(phase);
    assert.equal(game.getSnapshot().phase, phase);
    game.reset();
    assert.deepEqual(game.getSnapshot(), idle);
    game.advance(100000);
    game.release();
    game.reset();
    assert.deepEqual(game.getSnapshot(), idle);
    cast(game);
    hook(game);
    assert.equal(smartFinish(game).phase, "success");
    assert.equal(game.getSnapshot().catches.length, 1);
  }
});

test("successes accumulate in order, repeated fish count, and intervening failures do not affect records", () => {
  const samples = [0, 0.99, 0, 0.95, 0.5];
  let calls = 0;
  const game = new FishingGame({ random: () => {
    const castIndex = Math.floor(calls / 7);
    return calls++ % 7 === 0 ? samples[castIndex] : 0.5;
  } });
  for (let index = 0; index < 4; index += 1) {
    cast(game);
    hook(game);
    assert.equal(smartFinish(game).phase, "success");
    game.release();
  }
  assert.equal(game.getSnapshot().totalScore, 420);
  assert.deepEqual(game.getSnapshot().catches.map((fish) => fish.id), ["aji", "gold", "aji", "maguro"]);
  cast(game);
  game.press();
  assert.equal(game.getSnapshot().failureReason, "early");
  assert.equal(game.getSnapshot().totalScore, 420);
  assert.equal(game.getSnapshot().catches.length, 4);
});

test("snapshots expose exactly the UI contract and never selected identity before success", () => {
  const keys = ["phase", "pausedPhase", "isHeld", "isReeling", "needsRelease", "progress", "tension", "overloadMs", "biteRemainingMs", "phaseRemainingMs", "fishState", "fishStateRemainingMs", "pullHint", "shadowScale", "caughtFish", "failureReason", "totalScore", "catches"];
  for (const phase of ["idle", "waiting", "nibbling", "biting", "reeling", "paused", "failure"]) {
    const state = phaseGame(phase).getSnapshot();
    assert.deepEqual(Object.keys(state), keys);
    assert.equal(state.caughtFish, null);
    assert.deepEqual(state.catches, []);
    for (const fish of FISHES) assert.equal(JSON.stringify(state).includes(fish.name), false);
    assert.equal(Object.hasOwn(state, "id"), false);
  }
  assert.equal(phaseGame("success").getSnapshot().caughtFish.name, "アジ");
});

test("changing snapshots and caught fish cannot mutate private state or the frozen catalog", () => {
  const game = phaseGame("success");
  const first = game.getSnapshot();
  const second = game.getSnapshot();
  assert.notEqual(first.catches, second.catches);
  assert.notEqual(first.catches[0], second.catches[0]);
  assert.notEqual(first.caughtFish, first.catches[0]);
  first.phase = "idle";
  first.totalScore = 999;
  first.progress = 0;
  first.caughtFish.name = "変更";
  first.catches[0].points = 999;
  first.catches.push({ id: "fake", points: 999 });
  second.catches.length = 0;
  const state = game.getSnapshot();
  assert.equal(state.phase, "success");
  assert.equal(state.totalScore, 10);
  assert.equal(state.progress, 100);
  assert.equal(state.caughtFish.name, "アジ");
  assert.deepEqual(state.catches, [FISHES[0]]);
});

test("fine and coarse advances agree across phase, fish-state, tension, overload, and terminal boundaries", () => {
  for (const elapsed of [1200, 1525, 2500, 3050, 4849, 4850, 100000]) {
    const coarse = gameAt(0);
    const fine = gameAt(0);
    cast(coarse);
    cast(fine);
    coarse.advance(elapsed);
    splitAdvance(fine, elapsed, 13);
    assert.deepEqual(fine.getSnapshot(), coarse.getSnapshot(), `cast timing at ${elapsed}ms`);
  }
  for (const fish of FISHES) {
    for (const elapsed of [99.123, 3000, 4100, 4320, 5219, 5220, 100000]) {
      const coarse = reelingGame(fish.id);
      const fine = reelingGame(fish.id);
      coarse.press();
      fine.press();
      coarse.advance(elapsed);
      splitAdvance(fine, elapsed, 1000 / 60);
      assert.deepEqual(fine.getSnapshot(), coarse.getSnapshot(), `${fish.id} at ${elapsed}ms`);
    }
    const coarse = reelingGame(fish.id);
    const fine = reelingGame(fish.id);
    coarse.press();
    fine.press();
    coarse.advance(777);
    splitAdvance(fine, 777, 17);
    coarse.release();
    fine.release();
    coarse.advance(123456.789);
    splitAdvance(fine, 123456.789, 31);
    assert.deepEqual(fine.getSnapshot(), coarse.getSnapshot(), `${fish.id} during long rest`);
    assert.deepEqual(smartFinish(fine), smartFinish(coarse));
  }
});

test("fractional random wait schedules agree at 60fps and in one large advance", () => {
  for (let index = 0; index < 100; index += 1) {
    const timing = (index + 0.12345) / 100;
    const coarse = gameAt(0.175, timing);
    const fine = gameAt(0.175, timing);
    cast(coarse);
    cast(fine);
    coarse.advance(3550.98765);
    splitAdvance(fine, 3550.98765, 1000 / 60);
    assert.deepEqual(fine.getSnapshot(), coarse.getSnapshot(), `timing sample ${timing}`);
  }
});

test("line break wins when progress 100 and overload 900ms coincide, resolving only once", () => {
  const game = reelingGame();
  // From zero tension the next hold adds 65.916 progress before its 5620ms break.
  const firstCalmMs = 34.084 / FISH_BEHAVIORS.aji.progressRate * 1000;
  game.press();
  game.advance(firstCalmMs);
  game.release();
  game.advance(5600 - firstCalmMs);
  assert.equal(game.getSnapshot().fishState, "calm");
  assert.equal(game.getSnapshot().tension, 0);
  game.press();
  game.advance(5620);
  assert.equal(game.getSnapshot().phase, "failure");
  assert.equal(game.getSnapshot().failureReason, "line");
  assert.equal(game.getSnapshot().catches.length, 0);
  game.advance(100000);
  assert.equal(game.getSnapshot().catches.length, 0);
});

test("invalid randomness and elapsed time are rejected without changing game state", () => {
  assert.throws(() => new FishingGame({ random: 0 }), TypeError);
  for (const value of [-0.01, 1.01, NaN, Infinity, "0.5", undefined]) {
    for (const invalidCall of [0, 1, 2, 3, 6]) {
      let calls = 0;
      const game = new FishingGame({ random: () => calls++ === invalidCall ? value : 0.5 });
      const before = game.getSnapshot();
      assert.throws(() => game.press(), RangeError);
      assert.deepEqual(game.getSnapshot(), before);
    }
  }
  for (const phase of ["idle", "waiting", "reeling", "paused", "success", "failure"]) {
    const game = phaseGame(phase);
    const before = game.getSnapshot();
    for (const value of [-1, NaN, Infinity, "16", undefined]) {
      assert.throws(() => game.advance(value), RangeError);
      assert.deepEqual(game.getSnapshot(), before);
    }
    game.advance(0);
    assert.deepEqual(game.getSnapshot(), before);
  }
});

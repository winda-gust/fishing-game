"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { FISHES, FishingGame } = require("../game-core.js");

const totalWeight = FISHES.reduce((sum, fish) => sum + fish.weight, 0);

function catchAt(randomValue) {
  const game = new FishingGame({ random: () => randomValue });
  assert.equal(game.startFishing(), true);
  return { fish: game.finishFishing(), snapshot: game.getSnapshot() };
}

test("classic script exposes the same API without CommonJS or a server", () => {
  const context = vm.createContext({});
  const source = fs.readFileSync(path.join(__dirname, "../game-core.js"), "utf8");
  vm.runInContext(source, context);
  assert.equal(typeof context.FishingGameCore.FishingGame, "function");
  assert.equal(context.FishingGameCore.FISHES.length, 6);
  const game = new context.FishingGameCore.FishingGame({ random: () => 0 });
  game.startFishing();
  assert.equal(game.finishFishing().name, "アジ");
});

test("catalog contains six distinct immutable fish and positive weights", () => {
  assert.equal(FISHES.length, 6);
  assert.equal(new Set(FISHES.map((fish) => fish.id)).size, 6);
  assert.equal(Object.isFrozen(FISHES), true);
  for (const fish of FISHES) {
    assert.equal(Object.isFrozen(fish), true);
    assert.ok(fish.weight > 0);
    assert.ok(fish.points > 0);
    assert.ok(fish.name.length > 0);
    assert.ok(fish.rarity.length > 0);
  }
  assert.throws(() => { FISHES[0].points = 999; }, TypeError);
});

test("weighted selection covers both sides of every boundary", () => {
  assert.equal(catchAt(0).fish.id, FISHES[0].id);
  let cumulativeWeight = 0;
  for (let index = 0; index < FISHES.length - 1; index += 1) {
    cumulativeWeight += FISHES[index].weight;
    const boundary = cumulativeWeight / totalWeight;
    assert.equal(catchAt(boundary - 1e-10).fish.id, FISHES[index].id);
    assert.equal(catchAt(boundary).fish.id, FISHES[index + 1].id);
    assert.equal(catchAt(boundary + 1e-10).fish.id, FISHES[index + 1].id);
  }
  assert.equal(catchAt(1 - Number.EPSILON).fish.id, FISHES.at(-1).id);
  assert.equal(catchAt(1).fish.id, FISHES.at(-1).id);
});

test("each fish awards its documented score", () => {
  const expectedPoints = { aji: 10, iwashi: 15, saba: 20, tai: 50, maguro: 100, gold: 300 };
  let cumulativeWeight = 0;
  for (const fish of FISHES) {
    const midpoint = (cumulativeWeight + fish.weight / 2) / totalWeight;
    const result = catchAt(midpoint);
    assert.equal(result.fish.id, fish.id);
    assert.equal(result.fish.points, expectedPoints[fish.id]);
    assert.equal(result.snapshot.totalScore, expectedPoints[fish.id]);
    assert.equal(result.snapshot.catches.length, 1);
    assert.equal(result.snapshot.isFishing, false);
    cumulativeWeight += fish.weight;
  }
});

test("multiple catches accumulate in order and include repeated fish", () => {
  const samples = [0, 0.98, 0, 0.92];
  const game = new FishingGame({ random: () => samples.shift() });
  for (let index = 0; index < 4; index += 1) {
    assert.equal(game.startFishing(), true);
    assert.ok(game.finishFishing());
  }
  const snapshot = game.getSnapshot();
  assert.deepEqual(snapshot.catches.map((fish) => fish.id), ["aji", "gold", "aji", "maguro"]);
  assert.equal(snapshot.totalScore, 420);
  assert.equal(snapshot.isFishing, false);
});

test("duplicate starts and idle finishes cannot create extra catches", () => {
  let randomCalls = 0;
  const game = new FishingGame({ random: () => { randomCalls += 1; return 0; } });
  assert.deepEqual(game.getSnapshot(), { totalScore: 0, catches: [], isFishing: false });
  assert.equal(game.finishFishing(), null);
  assert.equal(randomCalls, 0);
  assert.equal(game.startFishing(), true);
  assert.equal(game.startFishing(), false);
  assert.equal(game.getSnapshot().isFishing, true);
  assert.equal(game.finishFishing().id, "aji");
  assert.equal(game.finishFishing(), null);
  assert.equal(randomCalls, 1);
  assert.equal(game.getSnapshot().catches.length, 1);
  assert.equal(game.getSnapshot().totalScore, 10);
});

test("reset clears catches and score and cancels an in-progress catch", () => {
  const game = new FishingGame({ random: () => 0.99 });
  game.startFishing();
  game.finishFishing();
  game.startFishing();
  game.reset();
  assert.deepEqual(game.getSnapshot(), { totalScore: 0, catches: [], isFishing: false });
  assert.equal(game.finishFishing(), null);
  assert.equal(game.startFishing(), true);
  assert.equal(game.finishFishing().points, 300);
  assert.equal(game.getSnapshot().totalScore, 300);
  game.reset();
  game.reset();
  assert.deepEqual(game.getSnapshot(), { totalScore: 0, catches: [], isFishing: false });
});

test("changing a snapshot cannot change score, catches, fish, or fishing state", () => {
  const game = new FishingGame({ random: () => 0 });
  game.startFishing();
  game.finishFishing();
  const first = game.getSnapshot();
  const second = game.getSnapshot();
  assert.notEqual(first, second);
  assert.notEqual(first.catches, second.catches);
  assert.notEqual(first.catches[0], second.catches[0]);
  first.totalScore = 999;
  first.isFishing = true;
  first.catches[0].points = 999;
  first.catches[0].name = "変更";
  first.catches.push({ id: "fake", points: 999 });
  second.catches.length = 0;
  const current = game.getSnapshot();
  assert.equal(current.totalScore, 10);
  assert.equal(current.isFishing, false);
  assert.equal(current.catches.length, 1);
  assert.equal(current.catches[0].points, 10);
  assert.equal(current.catches[0].name, "アジ");
});

test("invalid injected randomness is rejected without awarding a catch", () => {
  assert.throws(() => new FishingGame({ random: 0 }), TypeError);
  for (const sample of [-0.01, 1.01, NaN, Infinity, "0.5"]) {
    const game = new FishingGame({ random: () => sample });
    game.startFishing();
    assert.throws(() => game.finishFishing(), RangeError);
    assert.deepEqual(game.getSnapshot(), { totalScore: 0, catches: [], isFishing: true });
  }
});

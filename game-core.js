(function (root) {
  "use strict";

  const FISHES = Object.freeze([
    { id: "aji", name: "アジ", points: 10, weight: 35, color: "#66cbb7", rarity: "よく釣れる" },
    { id: "iwashi", name: "イワシ", points: 15, weight: 25, color: "#76b7e5", rarity: "よく釣れる" },
    { id: "saba", name: "サバ", points: 20, weight: 20, color: "#588dd7", rarity: "よく釣れる" },
    { id: "tai", name: "タイ", points: 50, weight: 12, color: "#ec8494", rarity: "レア" },
    { id: "maguro", name: "マグロ", points: 100, weight: 6, color: "#6874c7", rarity: "超レア" },
    { id: "gold", name: "金の魚", points: 300, weight: 2, color: "#efbd50", rarity: "伝説" },
  ].map((fish) => Object.freeze(fish)));

  const TOTAL_WEIGHT = FISHES.reduce((total, fish) => total + fish.weight, 0);

  class FishingGame {
    #random;
    #totalScore = 0;
    #catches = [];
    #isFishing = false;

    constructor({ random = Math.random } = {}) {
      if (typeof random !== "function") {
        throw new TypeError("random には関数を指定してください。");
      }
      this.#random = random;
    }

    startFishing() {
      if (this.#isFishing) return false;
      this.#isFishing = true;
      return true;
    }

    finishFishing() {
      if (!this.#isFishing) return null;

      const randomValue = this.#random();
      if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
        throw new RangeError("random の戻り値は 0 から 1 の数値にしてください。");
      }

      const target = randomValue * TOTAL_WEIGHT;
      let cumulativeWeight = 0;
      let caughtFish = FISHES[FISHES.length - 1];
      for (const fish of FISHES) {
        cumulativeWeight += fish.weight;
        if (target < cumulativeWeight) {
          caughtFish = fish;
          break;
        }
      }

      this.#catches.push(caughtFish);
      this.#totalScore += caughtFish.points;
      this.#isFishing = false;
      return caughtFish;
    }

    reset() {
      this.#totalScore = 0;
      this.#catches = [];
      this.#isFishing = false;
    }

    getSnapshot() {
      return {
        totalScore: this.#totalScore,
        catches: this.#catches.map((fish) => ({ ...fish })),
        isFishing: this.#isFishing,
      };
    }
  }

  const api = Object.freeze({ FISHES, FishingGame });
  root.FishingGameCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);

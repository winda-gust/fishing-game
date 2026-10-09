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

  const CONFIG = Object.freeze({
    reactionMs: 1800,
    breakGraceMs: 900,
    maxProgress: 100,
    maxTension: 100,
    initialTension: 20,
    restRelief: 28,
    restDelayMs: 300,
    safeTension: 70,
    waitingMinMs: 900,
    waitingMaxMs: 1500,
    nibbleMinMs: 250,
    nibbleMaxMs: 400,
    gapMinMs: 450,
    gapMaxMs: 750,
    minBiteDelayMs: 2000,
    warningProgressFactor: 0.45,
  });

  const FISH_BEHAVIORS = Object.freeze(Object.fromEntries([
    ["aji",    [3000, 1000, 1600, 18, 14, 22, 50, "穏やかな引き", 0.85, 4]],
    ["iwashi", [2300, 850, 1100, 21, 13, 20, 50, "軽快な引き", 0.8, 4]],
    ["saba",   [1450, 800, 900, 19, 20, 25, 58, "小刻みな引き", 1, 5]],
    ["tai",    [2000, 1000, 1600, 14, 21, 28, 65, "力強い引き", 1.1, 5]],
    ["maguro", [1800, 1150, 2100, 12, 24, 30, 75, "重い引き", 1.25, 6]],
    ["gold",   [1600, 1200, 2400, 13, 26, 36, 85, "とても強い引き", 1.3, 7]],
  ].map(([id, values]) => [id, Object.freeze(Object.fromEntries([
    "calmMs", "warningMs", "struggleMs", "progressRate", "tensionCalm",
    "tensionWarning", "tensionStruggle", "pullHint", "shadowScale", "regressionRate",
  ].map((key, index) => [key, values[index]])))])));

  const TOTAL_WEIGHT = FISHES.reduce((total, fish) => total + fish.weight, 0);
  const ACTIVE_PHASES = new Set(["waiting", "nibbling", "biting", "reeling"]);
  const FISH_STATES = ["calm", "warning", "struggling"];
  const rounded = (value) => Math.round(value * 1e6) / 1e6;
  // Resolve floating-point dust at event boundaries (one hundredth of a nanosecond).
  const EVENT_EPSILON_MS = 1e-8;

  class FishingGame {
    #random;
    #totalScore = 0;
    #catches = [];
    #phase = "idle";
    #pausedPhase = null;
    #isHeld = false;
    #armed = false;
    #progress = 0;
    #tension = 0;
    #overloadMs = 0;
    #restElapsedMs = 0;
    #phaseRemainingMs = 0;
    #fishStateIndex = 0;
    #fishStateRemainingMs = 0;
    #fish = null;
    #failureReason = null;
    #schedule = [];
    #scheduleIndex = 0;

    constructor({ random = Math.random } = {}) {
      if (typeof random !== "function") {
        throw new TypeError("random には関数を指定してください。");
      }
      this.#random = random;
    }

    #sample() {
      const value = this.#random();
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError("random の戻り値は 0 から 1 の数値にしてください。");
      }
      return value;
    }

    #duration(min, max) {
      return min + this.#sample() * (max - min);
    }

    #newAttempt() {
      // Select once before generating timing; the result stays private until success.
      const target = this.#sample() * TOTAL_WEIGHT;
      let cumulativeWeight = 0;
      let selected = FISHES[FISHES.length - 1];
      for (const fish of FISHES) {
        cumulativeWeight += fish.weight;
        if (target < cumulativeWeight) {
          selected = fish;
          break;
        }
      }
      const nibbleCount = this.#sample() < 0.5 ? 1 : 2;
      const schedule = [{ phase: "waiting", duration: this.#duration(CONFIG.waitingMinMs, CONFIG.waitingMaxMs) }];
      for (let index = 0; index < nibbleCount; index += 1) {
        schedule.push({ phase: "nibbling", duration: this.#duration(CONFIG.nibbleMinMs, CONFIG.nibbleMaxMs) });
        schedule.push({ phase: "waiting", duration: this.#duration(CONFIG.gapMinMs, CONFIG.gapMaxMs) });
      }
      const delay = schedule.reduce((total, step) => total + step.duration, 0);
      schedule[0].duration += Math.max(0, CONFIG.minBiteDelayMs - delay);

      // Commit only after all samples validate, preserving state if injection fails.
      this.#fish = selected;
      this.#schedule = schedule;
      this.#scheduleIndex = 0;
      this.#phase = "waiting";
      this.#pausedPhase = null;
      this.#phaseRemainingMs = schedule[0].duration;
      this.#fishStateIndex = 0;
      this.#fishStateRemainingMs = 0;
      this.#progress = 0;
      this.#tension = 0;
      this.#overloadMs = 0;
      this.#restElapsedMs = 0;
      this.#failureReason = null;
      this.#armed = false;
    }

    press() {
      if (this.#isHeld) return false;
      if (this.#phase === "idle" || this.#phase === "success" || this.#phase === "failure") {
        this.#newAttempt();
        this.#isHeld = true;
        return true;
      }
      this.#isHeld = true;
      if (this.#phase === "paused") {
        this.#phase = this.#pausedPhase;
        this.#pausedPhase = null;
        this.#armed = false;
        // A resume press can never also hook or wind.
        return true;
      }
      if (this.#phase === "waiting" || this.#phase === "nibbling") {
        this.#finish("failure", "early");
      } else if (this.#phase === "biting") {
        this.#phase = "reeling";
        this.#phaseRemainingMs = 0;
        this.#tension = CONFIG.initialTension;
        this.#fishStateIndex = 0;
        this.#fishStateRemainingMs = this.#behavior.calmMs;
        this.#armed = false;
      } else if (this.#phase === "reeling" && this.#armed) {
        // Only actual winding restarts the continuous-release requirement.
        this.#restElapsedMs = 0;
      }
      return true;
    }

    release() {
      const wasHeld = this.#isHeld;
      if (!wasHeld) return false;
      this.#isHeld = false;
      if (this.#phase === "reeling") this.#armed = true;
      return wasHeld;
    }

    pause() {
      if (!ACTIVE_PHASES.has(this.#phase)) return false;
      this.#pausedPhase = this.#phase;
      this.#phase = "paused";
      this.#isHeld = false;
      this.#armed = false;
      return true;
    }

    get #behavior() {
      return FISH_BEHAVIORS[this.#fish.id];
    }

    get #isReeling() {
      return this.#phase === "reeling" && this.#isHeld && this.#armed;
    }

    #finish(phase, reason = null) {
      this.#phase = phase;
      this.#pausedPhase = null;
      this.#phaseRemainingMs = 0;
      this.#fishStateRemainingMs = 0;
      this.#failureReason = reason;
      this.#armed = false;
      this.#restElapsedMs = 0;
      if (phase === "success") {
        this.#catches.push(this.#fish);
        this.#totalScore += this.#fish.points;
      }
      // Keep held until release so terminal transitions never recast a held input.
    }

    #advanceFishState() {
      this.#fishStateIndex = (this.#fishStateIndex + 1) % FISH_STATES.length;
      this.#fishStateRemainingMs = [
        this.#behavior.calmMs, this.#behavior.warningMs, this.#behavior.struggleMs,
      ][this.#fishStateIndex];
    }

    #advanceReeling(remainingMs) {
      const behavior = this.#behavior;
      const winding = this.#isReeling;
      // A held hook/resume is neutral, never a free rest. Pause preserves rest time.
      const resting = !this.#isHeld;
      const recovering = resting && this.#restElapsedMs >= CONFIG.restDelayMs;
      // No escape timer: cycles without changing gauges/timers can be skipped safely.
      const cycleMs = behavior.calmMs + behavior.warningMs + behavior.struggleMs;
      if (!winding && (!resting || (recovering && this.#tension === 0 && this.#overloadMs === 0)) && remainingMs >= cycleMs) {
        remainingMs %= cycleMs;
        if (remainingMs === 0) return 0;
      }
      const progressRate = winding ? [
        behavior.progressRate, behavior.progressRate * CONFIG.warningProgressFactor,
        this.#progress > 0 ? -behavior.regressionRate : 0,
      ][this.#fishStateIndex] : 0;
      const tensionRate = winding ? [
        behavior.tensionCalm, behavior.tensionWarning, behavior.tensionStruggle,
      ][this.#fishStateIndex] : recovering ? -CONFIG.restRelief : 0;
      const progressTime = progressRate > 0 ? (CONFIG.maxProgress - this.#progress) * 1000 / progressRate
        : progressRate < 0 ? this.#progress * 1000 / -progressRate : Infinity;
      const tensionTime = winding
        ? (this.#tension < CONFIG.maxTension ? (CONFIG.maxTension - this.#tension) * 1000 / tensionRate : Infinity)
        : (recovering && this.#tension > 0 ? this.#tension * 1000 / CONFIG.restRelief : Infinity);
      const restDelayTime = resting && !recovering ? CONFIG.restDelayMs - this.#restElapsedMs : Infinity;
      const safeTime = recovering && this.#overloadMs > 0 && this.#tension > CONFIG.safeTension
        ? (this.#tension - CONFIG.safeTension) * 1000 / CONFIG.restRelief : Infinity;
      const overloaded = winding && this.#tension >= CONFIG.maxTension;
      const breakTime = overloaded ? CONFIG.breakGraceMs - this.#overloadMs : Infinity;
      const step = Math.min(remainingMs, this.#fishStateRemainingMs, progressTime, tensionTime, restDelayTime, safeTime, breakTime);
      const reached = (time) => Number.isFinite(time) && time - step <= EVENT_EPSILON_MS;
      this.#progress = reached(progressTime) ? (progressRate > 0 ? CONFIG.maxProgress : 0)
        : Math.max(0, Math.min(CONFIG.maxProgress, this.#progress + progressRate * step / 1000));
      this.#tension = reached(tensionTime) ? (winding ? CONFIG.maxTension : 0)
        : Math.max(0, Math.min(CONFIG.maxTension, this.#tension + tensionRate * step / 1000));
      if (reached(safeTime)) this.#tension = CONFIG.safeTension;
      if (resting) {
        this.#restElapsedMs = reached(restDelayTime) ? CONFIG.restDelayMs
          : Math.min(CONFIG.restDelayMs, this.#restElapsedMs + step);
      }
      if (recovering && step > 0 && this.#tension <= CONFIG.safeTension) {
        this.#overloadMs = 0;
      } else if (overloaded) {
        this.#overloadMs = reached(breakTime) ? CONFIG.breakGraceMs : this.#overloadMs + step;
      }
      this.#fishStateRemainingMs = reached(this.#fishStateRemainingMs) ? 0 : this.#fishStateRemainingMs - step;
      const unconsumed = step === remainingMs ? 0 : remainingMs - step;
      // A line break wins if both terminal boundaries occur at the same instant.
      if (reached(breakTime)) this.#finish("failure", "line");
      else if (progressRate > 0 && reached(progressTime)) this.#finish("success");
      else if (this.#fishStateRemainingMs === 0) this.#advanceFishState();
      return unconsumed;
    }

    advance(elapsedMs) {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
        throw new RangeError("経過時間は 0 以上の有限のミリ秒で指定してください。");
      }
      let remainingMs = elapsedMs;
      while (remainingMs > 0 && ACTIVE_PHASES.has(this.#phase)) {
        if (this.#phase === "reeling") {
          remainingMs = this.#advanceReeling(remainingMs);
          continue;
        }
        const step = Math.min(remainingMs, this.#phaseRemainingMs);
        this.#phaseRemainingMs = step === this.#phaseRemainingMs ? 0 : this.#phaseRemainingMs - step;
        remainingMs = step === remainingMs ? 0 : remainingMs - step;
        if (this.#phaseRemainingMs !== 0) continue;
        if (this.#phase === "biting") {
          this.#finish("failure", "late");
        } else {
          this.#scheduleIndex += 1;
          const next = this.#schedule[this.#scheduleIndex];
          this.#phase = next ? next.phase : "biting";
          this.#phaseRemainingMs = next ? next.duration : CONFIG.reactionMs;
        }
      }
    }

    reset() {
      this.#totalScore = 0;
      this.#catches = [];
      this.#phase = "idle";
      this.#pausedPhase = null;
      this.#isHeld = false;
      this.#armed = false;
      this.#progress = 0;
      this.#tension = 0;
      this.#overloadMs = 0;
      this.#restElapsedMs = 0;
      this.#phaseRemainingMs = 0;
      this.#fishStateIndex = 0;
      this.#fishStateRemainingMs = 0;
      this.#fish = null;
      this.#failureReason = null;
      this.#schedule = [];
      this.#scheduleIndex = 0;
    }

    getSnapshot() {
      const visiblePhase = this.#phase === "paused" ? this.#pausedPhase : this.#phase;
      const fighting = visiblePhase === "reeling";
      return {
        phase: this.#phase,
        pausedPhase: this.#pausedPhase,
        isHeld: this.#isHeld,
        isReeling: this.#isReeling,
        needsRelease: this.#phase === "reeling" && this.#isHeld && !this.#armed,
        progress: rounded(this.#progress),
        tension: rounded(this.#tension),
        overloadMs: rounded(this.#overloadMs),
        restElapsedMs: fighting ? rounded(this.#restElapsedMs) : 0,
        restRemainingMs: fighting ? rounded(CONFIG.restDelayMs - this.#restElapsedMs) : 0,
        biteRemainingMs: visiblePhase === "biting" ? rounded(this.#phaseRemainingMs) : 0,
        phaseRemainingMs: rounded(this.#phaseRemainingMs),
        fishState: fighting ? FISH_STATES[this.#fishStateIndex] : null,
        fishStateRemainingMs: fighting ? rounded(this.#fishStateRemainingMs) : 0,
        pullHint: this.#fish ? this.#behavior.pullHint : "",
        shadowScale: this.#fish ? this.#behavior.shadowScale : 1,
        caughtFish: this.#phase === "success" ? { ...this.#fish } : null,
        failureReason: this.#failureReason,
        totalScore: this.#totalScore,
        catches: this.#catches.map((fish) => ({ ...fish })),
      };
    }
  }

  const api = Object.freeze({ FISHES, CONFIG, FISH_BEHAVIORS, FishingGame });
  root.FishingGameCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);

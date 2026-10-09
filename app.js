/* global FishingGameCore */
(() => {
  "use strict";
  const { FISHES, CONFIG, FishingGame } = FishingGameCore;
  const game = new FishingGame();
  const activePhases = new Set(["waiting", "nibbling", "biting", "reeling"]);
  const terminalPhases = new Set(["success", "failure"]);
  const elements = Object.fromEntries([
    "scene", "scene-state", "scene-caption", "bobber", "fighting-shadow",
    "catch-pop", "pop-name", "result-title", "result-description", "fish-button",
    "fish-button-label", "reset-button", "total-score", "catch-count", "empty-catch",
    "catch-list", "fish-catalog", "collection-progress", "battle-panel", "fish-state",
    "fish-pull", "bite-window", "bite-countdown", "catch-progress", "line-tension",
    "progress-value", "tension-value", "progress-fill", "tension-fill",
    "tension-warning", "tension-grace", "rest-status", "rest-countdown", "input-guide", "pause-notice"
  ].map(id => [id, document.getElementById(id)]));
  const catalogElements = new Map();
  const keysDown = new Set();
  let activeInput = null;
  let animationFrame = null;
  let clockVersion = 0;
  let previousTime = performance.now();
  let renderedCatchCount = 0;
  let wasReset = false;

  function setText(id, text) {
    if (elements[id].textContent !== text) elements[id].textContent = text;
  }
  function fishIcon(color) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 64 48");
    svg.setAttribute("aria-hidden", "true");
    svg.style.color = color;
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#fish-icon");
    svg.append(use);
    return svg;
  }
  function buildCatalog() {
    for (const fish of FISHES) {
      const item = document.createElement("li");
      item.className = "catalog-card";
      item.dataset.fishId = fish.id;
      const rarity = document.createElement("span");
      rarity.className = "rarity";
      rarity.textContent = fish.rarity;
      const name = document.createElement("h3");
      name.textContent = fish.name;
      const points = document.createElement("p");
      points.className = "catalog-points";
      points.append(String(fish.points), Object.assign(document.createElement("small"), { textContent: " pt" }));
      const status = document.createElement("span");
      status.className = "catalog-status";
      status.textContent = "未発見";
      item.append(rarity, fishIcon(fish.color), name, points, status);
      catalogElements.set(fish.id, { item, status });
      elements["fish-catalog"].append(item);
    }
  }
  function appendCatch(fish, number) {
    const row = document.createElement("li");
    row.className = "catch-row";
    const icon = document.createElement("span");
    icon.className = "mini-fish";
    icon.append(fishIcon(fish.color));
    const name = document.createElement("span");
    name.className = "catch-name";
    name.append(fish.name);
    const count = document.createElement("span");
    count.className = "catch-number";
    count.textContent = `${number}匹目`;
    name.append(count);
    const points = document.createElement("span");
    points.className = "catch-points";
    points.append(`+${fish.points}`, Object.assign(document.createElement("small"), { textContent: "pt" }));
    row.append(icon, name, points);
    elements["catch-list"].prepend(row);
    elements["catch-list"].scrollTop = 0;
  }
  function renderRecords(snapshot) {
    setText("total-score", snapshot.totalScore.toLocaleString("ja-JP"));
    setText("catch-count", `${snapshot.catches.length}匹`);
    elements["empty-catch"].hidden = snapshot.catches.length > 0;
    elements["catch-list"].hidden = snapshot.catches.length === 0;
    if (snapshot.catches.length === renderedCatchCount) return;
    if (snapshot.catches.length < renderedCatchCount) {
      elements["catch-list"].replaceChildren();
      renderedCatchCount = 0;
    }
    for (let index = renderedCatchCount; index < snapshot.catches.length; index += 1) appendCatch(snapshot.catches[index], index + 1);
    renderedCatchCount = snapshot.catches.length;
    const counts = new Map();
    for (const fish of snapshot.catches) counts.set(fish.id, (counts.get(fish.id) || 0) + 1);
    for (const [id, { item, status }] of catalogElements) {
      const count = counts.get(id) || 0;
      item.classList.toggle("is-discovered", count > 0);
      status.textContent = count > 0 ? `${count}匹 釣れた！` : "未発見";
    }
    const progress = document.createElement("strong");
    progress.textContent = `${counts.size} / ${FISHES.length}`;
    elements["collection-progress"].replaceChildren("発見 ", progress, " 種");
  }
  function phaseMessage(snapshot) {
    switch (snapshot.phase) {
      case "idle": return wasReset
        ? ["リセットしました。もう一度、のんびり。", "釣果・得点・図鑑をゼロにし、進行中の釣りも終了しました。"]
        : ["まずは、海に投げてみよう。", "大きく沈んだら合わせる。その後は、長押しで巻く・離して休む。"];
      case "waiting": return ["魚を待っています……", "小さな反応はまだ待とう。ウキが大きく沈んだら、新たに押そう。"];
      case "nibbling": return ["何かがつついている……", "まだ合わせるタイミングではありません。大きな沈みを待とう。"];
      case "biting": return ["食いついた！ 今だ！", `新たに「合わせる」を押そう。猶予は${(CONFIG.reactionMs / 1000).toFixed(1)}秒。`];
      case "reeling": return snapshot.needsRelease
        ? ["合わせ成功！ まずは一度離そう。", "押し直して長押しすると巻けます。離している間は、巻くのを休みます。"]
        : ["魚の動きを見て、巻く・休む。", "落ち着いたら巻く。暴れ中に巻くとゲージが戻ります。予兆で休もう。"];
      case "paused": return ["釣りを一時停止しています。", "時間とゲージは止まっています。準備できたら再開し、一度離してから操作しよう。"];
      case "success": return [`${snapshot.caughtFish.name}が釣れた！ +${snapshot.caughtFish.points} pt`, "いい判断でした！ 次はどんな魚に出会えるかな？"];
      case "failure": return {
        early: ["引くのが早すぎた！", "ウキが大きく沈むまで待とう。小さなつつきには合わせないでね。"],
        late: ["合わせるのが遅かった！", `食いついたら${(CONFIG.reactionMs / 1000).toFixed(1)}秒以内に、新たにボタンを押そう。`],
        line: ["糸が切れた！", `予兆で離し、少し休み続けよう。危険が残るときは張り${CONFIG.safeTension}%以下まで休もう。`]
      }[snapshot.failureReason];
    }
  }
  function render() {
    const snapshot = game.getSnapshot();
    const phase = snapshot.phase;
    const displayPhase = phase === "paused" ? snapshot.pausedPhase : phase;
    const inFight = displayPhase === "reeling";
    const held = snapshot.isHeld || activeInput !== null;
    const [title, description] = phaseMessage(snapshot);
    setText("result-title", title);
    setText("result-description", description);
    renderRecords(snapshot);
    elements.scene.dataset.phase = phase;
    elements.scene.dataset.fishState = inFight ? snapshot.fishState : "";
    elements.bobber.toggleAttribute("hidden", !activePhases.has(displayPhase));
    elements["pause-notice"].hidden = phase !== "paused";
    elements["battle-panel"].dataset.active = String(inFight);
    elements["fighting-shadow"].hidden = !inFight;
    elements["fighting-shadow"].style.setProperty("--shadow-scale", snapshot.shadowScale);
    elements["catch-pop"].hidden = phase !== "success";
    if (phase === "success") {
      elements["catch-pop"].style.color = snapshot.caughtFish.color;
      setText("pop-name", `${snapshot.caughtFish.name} +${snapshot.caughtFish.points} pt`);
    }
    const sceneTexts = {
      idle: "釣りの準備OK", waiting: "魚を待っています", nibbling: "小さな反応・まだ待とう",
      biting: "食いついた！ 今だ！", reeling: "巻く・休むで引き寄せ中",
      paused: "一時停止中", success: "釣り成功！", failure: "次の一投に挑戦"
    };
    if (elements["scene-state"].dataset.phase !== phase) {
      elements["scene-state"].dataset.phase = phase;
      elements["scene-state"].replaceChildren(Object.assign(document.createElement("span"), { className: "status-dot" }), sceneTexts[phase]);
    }
    setText("scene-caption", {
      idle: "ゆっくり待つのも、釣りの楽しみ。", waiting: "ウキが大きく沈むまで、待とう。",
      nibbling: "小さなつつき。まだ合わせないでね。", biting: "大きく沈んだ！ 新たにボタンを押そう。",
      reeling: "身をよじる予兆が出たら、離して休もう。", paused: "準備できたら、あなたのペースで再開。",
      success: "海から、ちいさな贈りもの。", failure: "次はきっと、うまくできる。"
    }[phase]);
    elements["fish-state"].dataset.state = inFight ? snapshot.fishState : "";
    setText("fish-state", inFight ? {
      calm: "落ち着いている — 巻くチャンス！",
      warning: "予兆：魚が身をよじった！ 離そう。",
      struggling: "暴れている — 巻くとゲージが戻る！"
    }[snapshot.fishState] : {
      idle: "合わせた後は、巻く・休むで引き寄せよう。", waiting: "今は待とう。早押しには注意。",
      nibbling: "小さなつつきには、まだ合わせない。", biting: "今、新たに押して合わせよう！",
      success: "釣り上げ成功！", failure: "理由を確かめて、もう一度挑戦。", paused: "時間は止まっています。"
    }[phase]);
    setText("fish-pull", inFight ? `${snapshot.pullHint} · 長押しで巻く／離して休む` : "魚の名前は、釣り上げてからのお楽しみ。");
    elements["bite-window"].hidden = displayPhase !== "biting";
    setText("bite-countdown", `残り ${(snapshot.biteRemainingMs / 1000).toFixed(1)}秒`);
    for (const [id, fill, label, value] of [
      ["catch-progress", "progress-fill", "progress-value", snapshot.progress],
      ["line-tension", "tension-fill", "tension-value", snapshot.tension]
    ]) {
      elements[id].setAttribute("aria-valuenow", Math.round(value));
      elements[fill].style.width = `${value}%`;
      setText(label, `${Math.round(value)}%`);
    }
    const retainedDanger = inFight && snapshot.overloadMs > 0;
    const danger = inFight && (snapshot.tension >= 75 || retainedDanger);
    const overloaded = inFight && snapshot.tension >= 100;
    elements["line-tension"].classList.toggle("is-danger", danger);
    elements["line-tension"].classList.toggle("is-overloaded", overloaded);
    setText("tension-warning", retainedDanger
      ? `危険は残っています。${CONFIG.safeTension}%以下まで休もう。`
      : overloaded ? "糸が切れそう！ 今すぐ離そう。" : danger ? "張りが強い。離して休もう。" : "");
    setText("tension-grace", overloaded || retainedDanger
      ? `残り猶予 ${Math.max(0, (CONFIG.breakGraceMs - snapshot.overloadMs) / 1000).toFixed(1)}秒` : "");
    let restState = "inactive";
    let restMessage = "少し休み続けると張りが回復します。";
    if (inFight) {
      if (phase === "paused") {
        restState = "paused";
        restMessage = "一時停止中：回復待ちも停止しています。";
      } else if (snapshot.needsRelease) {
        restState = "neutral";
        restMessage = "一度離してから、巻く・休むを始めよう。";
      } else if (snapshot.isReeling) {
        restState = "held";
        restMessage = "巻き中：予兆が出たら離して休もう。";
      } else if (snapshot.restRemainingMs > 0) {
        restState = "waiting";
        restMessage = "回復待ち：離したまま休もう。";
      } else {
        restState = "recovering";
        restMessage = snapshot.tension > 0 ? "張りを回復中。十分下げてから巻こう。" : "張りが落ち着きました。魚の動きを見よう。";
      }
    }
    elements["rest-status"].dataset.state = restState;
    setText("rest-status", restMessage);
    setText("rest-countdown", inFight && (restState === "waiting" || restState === "paused") && snapshot.restRemainingMs > 0
      ? `あと ${(snapshot.restRemainingMs / 1000).toFixed(1)}秒` : "");
    let buttonLabel = "投げる";
    let guide = "投げる → 大きく沈んだら押す → 長押しで巻く／離して休む";
    if (["waiting", "nibbling", "biting"].includes(phase)) {
      buttonLabel = "合わせる";
      guide = phase === "biting" ? "今、新たに押そう！ 投げた時の長押しでは合わせられません。" : "小さな反応はまだ待とう。大きく沈んだら、押し直して合わせる。";
    } else if (phase === "reeling") {
      buttonLabel = snapshot.needsRelease ? "一度離してから巻く" : snapshot.isReeling ? "巻いています…" : "長押しで巻く";
      guide = snapshot.needsRelease ? "合わせ・再開の押下は巻きに持ち越せません。一度離し、押し直そう。"
        : `離して${(CONFIG.restDelayMs / 1000).toFixed(1)}秒待つと回復。危険が残るときは張り${CONFIG.safeTension}%以下まで休もう。`;
    } else if (phase === "paused") {
      buttonLabel = "準備して再開";
      guide = "再開の押下では合わせたり巻いたりしません。一度離してから操作しよう。";
    } else if (terminalPhases.has(phase)) {
      buttonLabel = held ? "離して次へ" : "もう一度投げる";
      guide = held ? "ボタンを離してから、次の釣りを始めよう。" : "もう一度投げて、今度は魚の動きに合わせてみよう。";
    }
    setText("fish-button-label", buttonLabel);
    setText("input-guide", guide);
    elements["fish-button"].classList.toggle("is-held", snapshot.isReeling);
    if (inFight) elements["fish-button"].setAttribute("aria-pressed", String(snapshot.isReeling));
    else elements["fish-button"].removeAttribute("aria-pressed");
  }
  function syncTime(now = performance.now()) {
    const currentTime = Math.max(now, previousTime);
    game.advance(currentTime - previousTime);
    previousTime = currentTime;
  }
  function stopClock() {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    clockVersion += 1;
  }
  function update() {
    render();
    if (!activePhases.has(game.getSnapshot().phase)) {
      if (animationFrame !== null) stopClock();
      return;
    }
    if (animationFrame !== null) return;
    const version = clockVersion;
    animationFrame = requestAnimationFrame(now => {
      if (version !== clockVersion) return;
      animationFrame = null;
      syncTime(now);
      update();
    });
  }
  function press() {
    const phaseBeforeSync = game.getSnapshot().phase;
    syncTime();
    // Resolve a missed deadline without letting that same input cast again.
    if (!(activePhases.has(phaseBeforeSync) && terminalPhases.has(game.getSnapshot().phase))) {
      game.press();
      wasReset = false;
    }
    update();
  }
  function clearInput() {
    const previousInput = activeInput;
    activeInput = null;
    game.release();
    if (previousInput?.type === "pointer" && elements["fish-button"].hasPointerCapture(previousInput.id)) elements["fish-button"].releasePointerCapture(previousInput.id);
  }
  function release() {
    syncTime();
    clearInput();
    update();
  }
  elements["fish-button"].addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || activeInput || document.hidden) return;
    event.preventDefault();
    elements["fish-button"].focus({ preventScroll: true });
    activeInput = { type: "pointer", id: event.pointerId };
    try { elements["fish-button"].setPointerCapture(event.pointerId); } catch { /* Synthetic events may have no active pointer. */ }
    press();
  });
  const endPointer = event => {
    if (activeInput?.type === "pointer" && activeInput.id === event.pointerId) release();
  };
  document.addEventListener("pointerup", endPointer, true);
  document.addEventListener("pointercancel", endPointer, true);
  elements["fish-button"].addEventListener("lostpointercapture", endPointer);
  elements["fish-button"].addEventListener("keydown", event => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    const key = event.code || event.key;
    if (event.repeat || keysDown.size > 0 || activeInput || document.hidden) return;
    keysDown.add(key);
    activeInput = { type: "keyboard", key };
    press();
  });
  document.addEventListener("keyup", event => {
    const key = event.code || event.key;
    keysDown.delete(key);
    if (activeInput?.type === "keyboard" && activeInput.key === key) release();
  }, true);
  elements["fish-button"].addEventListener("blur", () => { if (activeInput) release(); });
  elements["fish-button"].addEventListener("click", event => {
    // Physical pointer/key events already acted; only discrete AT clicks fall back.
    if (event.detail !== 0 || activeInput || keysDown.size > 0 || document.hidden) return;
    press();
    release();
  });
  elements["fish-button"].addEventListener("contextmenu", event => event.preventDefault());
  elements["fish-button"].addEventListener("dragstart", event => event.preventDefault());
  function pause() {
    syncTime();
    clearInput();
    keysDown.clear();
    game.pause();
    stopClock();
    update();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
    else { previousTime = performance.now(); update(); }
  });
  window.addEventListener("blur", pause);
  elements["reset-button"].addEventListener("click", () => {
    clearInput();
    game.reset();
    stopClock();
    previousTime = performance.now();
    wasReset = true;
    update();
  });
  buildCatalog();
  update();
})();

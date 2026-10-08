/* global FishingGameCore */
(() => {
  "use strict";

  const { FISHES, FishingGame } = FishingGameCore;
  const game = new FishingGame();
  const fishingDelay = 1800;
  let pendingCatch = null;
  const elements = Object.fromEntries([
    "scene", "scene-state", "scene-caption", "catch-pop", "pop-name",
    "result-title", "result-description", "fish-button", "fish-button-label",
    "reset-button", "total-score", "catch-count", "empty-catch", "catch-list",
    "fish-catalog", "collection-progress"
  ].map(id => [id, document.getElementById(id)]));
  const catalogElements = new Map();

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

  function renderState() {
    const { totalScore, catches, isFishing } = game.getSnapshot();
    elements["total-score"].textContent = totalScore.toLocaleString("ja-JP");
    elements["catch-count"].textContent = `${catches.length}匹`;
    elements["empty-catch"].hidden = catches.length > 0;
    elements["catch-list"].hidden = catches.length === 0;
    elements["fish-button"].disabled = isFishing;
    elements["fish-button-label"].textContent = isFishing ? "魚を待っています…" : "釣りをはじめる";
    elements.scene.classList.toggle("is-fishing", isFishing);
    elements["scene-state"].replaceChildren(Object.assign(document.createElement("span"), { className: "status-dot" }), isFishing ? "アタリを待っています" : "釣りの準備OK");

    const counts = new Map();
    for (const fish of catches) counts.set(fish.id, (counts.get(fish.id) || 0) + 1);
    for (const [id, { item, status }] of catalogElements) {
      const count = counts.get(id) || 0;
      item.classList.toggle("is-discovered", count > 0);
      status.textContent = count > 0 ? `${count}匹 釣れた！` : "未発見";
    }
    const progress = document.createElement("strong");
    progress.textContent = `${counts.size} / ${FISHES.length}`;
    elements["collection-progress"].replaceChildren("発見 ", progress, " 種");
  }

  function showCatch(fish) {
    const catchNumber = game.getSnapshot().catches.length;
    const row = document.createElement("li");
    row.className = "catch-row";
    const icon = document.createElement("span");
    icon.className = "mini-fish";
    icon.append(fishIcon(fish.color));
    const name = document.createElement("span");
    name.className = "catch-name";
    name.append(fish.name);
    const number = document.createElement("span");
    number.className = "catch-number";
    number.textContent = `${catchNumber}匹目`;
    name.append(number);
    const points = document.createElement("span");
    points.className = "catch-points";
    points.append(`+${fish.points}`, Object.assign(document.createElement("small"), { textContent: "pt" }));
    row.append(icon, name, points);
    elements["catch-list"].prepend(row);
    elements["catch-list"].scrollTop = 0;
    elements["result-title"].textContent = `${fish.name}が釣れた！ +${fish.points} pt`;
    elements["result-description"].textContent = fish.id === FISHES[FISHES.length - 1].id
      ? "とても珍しい一匹！今日はきっと、いい日になりそう。"
      : "いい釣果ですね。次はどんな魚に出会えるかな？";
    elements["catch-pop"].style.color = fish.color;
    elements["pop-name"].textContent = `${fish.name} +${fish.points} pt`;
    elements["catch-pop"].hidden = false;
    elements["scene-caption"].textContent = "海から、ちいさな贈りもの。";
  }

  elements["fish-button"].addEventListener("click", () => {
    if (!game.startFishing()) return;
    elements["catch-pop"].hidden = true;
    elements["result-title"].textContent = "釣り糸を垂らしました。";
    elements["result-description"].textContent = "もうすぐ釣れるかも…ウキを眺めて待ちましょう。";
    elements["scene-caption"].textContent = "何が釣れるかな…？";
    renderState();
    pendingCatch = window.setTimeout(() => {
      pendingCatch = null;
      const fish = game.finishFishing();
      if (!fish) return;
      showCatch(fish);
      renderState();
    }, fishingDelay);
  });

  elements["reset-button"].addEventListener("click", () => {
    if (pendingCatch !== null) window.clearTimeout(pendingCatch);
    pendingCatch = null;
    game.reset();
    elements["catch-list"].replaceChildren();
    elements["catch-pop"].hidden = true;
    elements["result-title"].textContent = "リセットしました。もう一度、のんびり。";
    elements["result-description"].textContent = "釣果と得点をゼロにしました。新しい一匹を釣ってみよう。";
    elements["scene-caption"].textContent = "ゆっくり待つのも、釣りの楽しみ。";
    renderState();
  });

  buildCatalog();
  renderState();
})();

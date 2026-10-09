"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

let entrypoint;
let browser;
let server;

before(async () => {
  const files = new Map([
    ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
    ["/index.html", { name: "index.html", type: "text/html; charset=utf-8" }],
    ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
    ["/favicon.svg", { name: "favicon.svg", type: "image/svg+xml" }],
    ["/game-core.js", { name: "game-core.js", type: "text/javascript; charset=utf-8" }],
    ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ]);
  server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const file = files.get(pathname);
    if (!file) {
      response.writeHead(404).end("Not found");
      return;
    }
    try {
      const content = await fs.promises.readFile(path.join(__dirname, "..", file.name));
      response.writeHead(200, { "Content-Type": file.type }).end(content);
    } catch {
      response.writeHead(500).end("Could not read game file");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  entrypoint = `http://127.0.0.1:${server.address().port}/`;

  const options = { headless: true, args: ["--no-sandbox"] };
  if (process.env.CHROMIUM_PATH) {
    options.executablePath = process.env.CHROMIUM_PATH;
  } else if (fs.existsSync("/usr/bin/chromium")) {
    options.executablePath = "/usr/bin/chromium";
  }
  browser = await chromium.launch(options);
});

after(async () => {
  try {
    if (browser) await browser.close();
  } finally {
    if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

const fishCases = [
  { id: "aji", name: "アジ", points: 10, sample: 0.175 },
  { id: "iwashi", name: "イワシ", points: 15, sample: 0.475 },
  { id: "saba", name: "サバ", points: 20, sample: 0.7 },
  { id: "tai", name: "タイ", points: 50, sample: 0.86 },
  { id: "maguro", name: "マグロ", points: 100, sample: 0.95 },
  { id: "gold", name: "金の魚", points: 300, sample: 0.99 },
];

async function openGame(t, { sample = 0.175, viewport = { width: 1440, height: 1100 }, touch = false } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", hasTouch: touch, isMobile: touch });
  await context.addInitScript((value) => {
    const samples = [value];
    // Only the test supplies random samples. Production probabilities and timing remain intact.
    window.__fishingTestSamples = samples;
    Math.random = () => samples.length ? samples.shift() : 0.5;
  }, sample);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`);
  });
  t.after(async () => {
    try {
      assert.deepEqual(errors, [], "ページやコンソールにエラーがないこと");
    } finally {
      await context.close();
    }
  });
  const startTime = new Date("2026-10-08T00:00:00.000Z");
  await page.clock.install({ time: startTime });
  await page.clock.pauseAt(new Date(startTime.getTime() + 1000));
  await page.goto(entrypoint);
  await page.locator("#fish-catalog > li").nth(5).waitFor();
  return page;
}

async function readState(page) {
  return page.evaluate(() => ({
    phase: document.getElementById("scene").dataset.phase,
    fishState: document.getElementById("fish-state").dataset.state,
    progress: Number(document.getElementById("catch-progress").getAttribute("aria-valuenow")),
    tension: Number(document.getElementById("line-tension").getAttribute("aria-valuenow")),
    score: document.getElementById("total-score").textContent,
    count: document.getElementById("catch-count").textContent,
    label: document.getElementById("fish-button-label").textContent,
    restState: document.getElementById("rest-status").dataset.state,
    restText: document.getElementById("rest-status").textContent,
    restCountdown: document.getElementById("rest-countdown").textContent,
    graceText: document.getElementById("tension-grace").textContent,
    warning: document.getElementById("tension-warning").textContent,
  }));
}

async function advanceUntil(page, predicate, { maxMs = 10000, step = 50 } = {}) {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += step) {
    const state = await readState(page);
    if (predicate(state)) return state;
    await page.clock.runFor(step);
  }
  assert.fail(`状態が期限内に変わりません: ${JSON.stringify(await readState(page))}`);
}

async function nextFish(page, sample) {
  await page.evaluate((value) => window.__fishingTestSamples.splice(0, window.__fishingTestSamples.length, value), sample);
}

async function buttonPoint(page) {
  const button = page.locator("#fish-button");
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function mouseDown(page) {
  const point = await buttonPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
}

async function pressButton(page) {
  await mouseDown(page);
  await page.mouse.up();
}

async function cast(page, sample) {
  if (sample !== undefined) await nextFish(page, sample);
  await pressButton(page);
  assert.equal((await readState(page)).phase, "waiting");
}

async function hook(page) {
  await cast(page);
  await advanceUntil(page, (state) => state.phase === "biting");
  assert.equal(await page.locator("#bite-window").isVisible(), true);
  await pressButton(page);
  assert.equal((await readState(page)).phase, "reeling");
}

async function reelSafely(page) {
  let held = false;
  for (let elapsed = 0; elapsed <= 60000; elapsed += 100) {
    const state = await readState(page);
    if (state.phase === "success") {
      if (held) await page.mouse.up();
      return;
    }
    assert.equal(state.phase, "reeling", `安全な巻き方で失敗しないこと: ${JSON.stringify(state)}`);
    const shouldHold = state.fishState === "calm" && state.tension < 75 && state.graceText === "";
    if (shouldHold && !held) {
      await mouseDown(page);
      held = true;
    } else if (!shouldHold && held) {
      await page.mouse.up();
      held = false;
    }
    await page.clock.runFor(100);
  }
  assert.fail(`安全な巻き方で魚を釣れません: ${JSON.stringify(await readState(page))}`);
}

async function assertNoOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert.ok(dimensions.documentWidth <= dimensions.width,
    `document width ${dimensions.documentWidth} must fit viewport ${dimensions.width}`);
  assert.ok(dimensions.bodyWidth <= dimensions.width,
    `body width ${dimensions.bodyWidth} must fit viewport ${dimensions.width}`);
}

async function assertEmpty(page) {
  assert.equal(await page.locator("#total-score").textContent(), "0");
  assert.equal(await page.locator("#catch-count").textContent(), "0匹");
  assert.equal(await page.locator("#catch-list > li").count(), 0);
  assert.equal(await page.locator("#empty-catch").isVisible(), true);
  assert.equal(await page.locator("#catch-list").isVisible(), false);
  assert.equal(await page.locator("#catch-pop").isVisible(), false);
  assert.equal(await page.locator("#collection-progress strong").textContent(), "0 / 6");
  assert.deepEqual(await page.locator(".catalog-status").allTextContents(), Array(6).fill("未発見"));
}

async function assertGauges(page) {
  for (const [id, label] of [["catch-progress", "progress-value"], ["line-tension", "tension-value"]]) {
    const gauge = page.locator(`#${id}`);
    assert.equal(await gauge.isVisible(), true);
    assert.equal(await gauge.getAttribute("role"), "progressbar");
    assert.equal(await gauge.getAttribute("aria-valuemin"), "0");
    assert.equal(await gauge.getAttribute("aria-valuemax"), "100");
    const value = Number(await gauge.getAttribute("aria-valuenow"));
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 100);
    assert.match(await page.locator(`#${label}`).textContent(), /%/);
    assert.equal(Number((await page.locator(`#${label}`).textContent()).replace(/[^0-9.]/g, "")), value);
  }
}

async function assertNoRevealedFish(page) {
  const message = await page.locator("#result-title, #result-description, #scene-caption, #fish-state").allTextContents();
  for (const fish of fishCases) assert.ok(!message.join(" ").includes(fish.name), `成功前に${fish.name}を明かさないこと`);
  assert.equal(await page.locator("#catch-pop").isVisible(), false);
}

// Headless Chromium keeps real pages visible, even when another tab is selected.
// These tests explicitly simulate the visibility event; they do not certify OS/tab lifecycle behavior.
async function simulateVisibility(page, hidden) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value ? "hidden" : "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

async function historyNames(page) {
  return page.locator(".catch-name").evaluateAll((names) => names.map((name) => name.firstChild.textContent));
}

async function screenshot(page, filename) {
  if (process.env.FISHING_SCREENSHOTS !== "1") return;
  const directory = path.join(__dirname, "../artifacts");
  fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, filename), fullPage: true });
}

test("Japanese controls, catalog, stable gauges, and keyboard focus are accessible", async (t) => {
  const page = await openGame(t);
  assert.equal(await page.locator("html").getAttribute("lang"), "ja");
  assert.match(await page.title(), /釣り日和/);
  assert.equal((await readState(page)).phase, "idle");
  assert.equal((await readState(page)).label, "投げる");
  assert.deepEqual(await page.locator("#fish-catalog h3").allTextContents(), fishCases.map((fish) => fish.name));
  assert.deepEqual(await page.locator(".catalog-points").allTextContents(), fishCases.map((fish) => `${fish.points} pt`));
  assert.equal(await page.locator(".message-area").getAttribute("aria-live"), "polite");
  assert.equal(await page.locator(".message-area").getAttribute("aria-atomic"), "true");
  await assertEmpty(page);
  await assertGauges(page);
  await assertNoOverflow(page);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".brand").evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#fish-button").evaluate((element) => element === document.activeElement), true);
  const focusStyle = await page.locator("#fish-button").evaluate((element) => ({
    visible: element.matches(":focus-visible"),
    style: getComputedStyle(element).outlineStyle,
    width: getComputedStyle(element).outlineWidth,
  }));
  assert.deepEqual(focusStyle, { visible: true, style: "solid", width: "3px" });
});

for (const wrongTiming of ["early", "nibble", "late"]) {
  test(`${wrongTiming} hookup fails without a catch, score, or discovery`, async (t) => {
    const page = await openGame(t, { sample: 0.99 });
    await cast(page);
    await assertNoRevealedFish(page);
    if (wrongTiming === "nibble") await advanceUntil(page, (state) => state.phase === "nibbling");
    if (wrongTiming === "late") {
      await advanceUntil(page, (state) => state.phase === "biting");
      await page.clock.runFor(1850);
    } else {
      await pressButton(page);
    }
    assert.equal((await readState(page)).phase, "failure");
    await assertEmpty(page);
    await assertNoRevealedFish(page);
    assert.equal((await readState(page)).label, "もう一度投げる");
    await cast(page, 0.175);
    await advanceUntil(page, (state) => state.phase === "biting");
    await pressButton(page);
    await reelSafely(page);
    assert.equal((await readState(page)).score, "10");
  });
}

test("all six species award their scores only after a successful fight, with cumulative newest-first history", async (t) => {
  const page = await openGame(t);
  let score = 0;
  for (const [index, fish] of fishCases.entries()) {
    await nextFish(page, fish.sample);
    await hook(page);
    assert.equal((await readState(page)).score, String(score));
    assert.equal(await page.locator("#catch-list > li").count(), index);
    await assertNoRevealedFish(page);
    await page.clock.runFor(400);
    assert.equal((await readState(page)).progress, 0);
    assert.equal((await readState(page)).score, String(score));
    await reelSafely(page);
    score += fish.points;
    assert.equal((await readState(page)).score, String(score));
    assert.equal((await readState(page)).count, `${index + 1}匹`);
    assert.match(await page.locator("#result-title").textContent(), new RegExp(`${fish.name}.*${fish.points}`));
    assert.deepEqual(await historyNames(page), fishCases.slice(0, index + 1).reverse().map((entry) => entry.name));
    assert.equal(await page.locator(".catch-row").first().locator(".catch-points").textContent(), `+${fish.points}pt`);
    assert.equal(await page.locator(`[data-fish-id="${fish.id}"] .catalog-status`).textContent(), "1匹 釣れた！");
    assert.equal(await page.locator("#collection-progress strong").textContent(), `${index + 1} / 6`);
    await assertGauges(page);
  }
  assert.equal((await readState(page)).score, "495");
  await nextFish(page, 0.175);
  await hook(page);
  await reelSafely(page);
  assert.equal((await readState(page)).score, "505");
  assert.equal((await readState(page)).count, "7匹");
  assert.equal(await page.locator('[data-fish-id="aji"] .catalog-status').textContent(), "2匹 釣れた！");
  await screenshot(page, "fishing-game-desktop.png");
});

for (const fish of fishCases) {
  test(`continuous reeling breaks the line for ${fish.name}, without awarding points`, async (t) => {
    const page = await openGame(t, { sample: fish.sample });
    await hook(page);
    await mouseDown(page);
    const failure = await advanceUntil(page, (state) => state.phase === "failure", { maxMs: 20000 });
    assert.equal(failure.label, "離して次へ");
    await page.clock.runFor(3000);
    assert.equal((await readState(page)).phase, "failure");
    await page.mouse.up();
    assert.equal((await readState(page)).label, "もう一度投げる");
    await assertEmpty(page);
    await assertNoRevealedFish(page);
  });
}

test("holding the cast cannot auto-hook, and holding the hook cannot auto-reel", async (t) => {
  const page = await openGame(t);
  await mouseDown(page);
  assert.equal((await readState(page)).phase, "waiting");
  await advanceUntil(page, (state) => state.phase === "biting");
  await page.clock.runFor(200);
  assert.equal((await readState(page)).phase, "biting");
  await page.mouse.up();
  await mouseDown(page);
  assert.equal((await readState(page)).phase, "reeling");
  assert.equal((await readState(page)).label, "一度離してから巻く");
  assert.equal((await readState(page)).restState, "neutral");
  await page.clock.runFor(500);
  assert.equal((await readState(page)).progress, 0);
  assert.equal((await readState(page)).tension, 20);
  await page.mouse.up();
  assert.equal((await readState(page)).label, "長押しで巻く");
  assert.equal((await readState(page)).restState, "waiting");
  await mouseDown(page);
  await page.clock.runFor(200);
  assert.ok((await readState(page)).progress > 0);
  await page.mouse.up();
  await assertEmpty(page);
});

test("programmatic click remains a discrete accessible action without automatic reeling", async (t) => {
  const page = await openGame(t);
  await page.locator("#fish-button").evaluate((button) => button.click());
  assert.equal((await readState(page)).phase, "waiting");
  await advanceUntil(page, (state) => state.phase === "biting");
  await page.locator("#fish-button").evaluate((button) => button.click());
  assert.equal((await readState(page)).phase, "reeling");
  await page.clock.runFor(300);
  assert.equal((await readState(page)).progress, 0);
  await reelSafely(page);
  assert.equal((await readState(page)).score, "10");
});

for (const inputType of ["pointer", "keyboard"]) {
  test(`${inputType} input arriving after the bite deadline consumes the failure instead of casting again`, async (t) => {
    const page = await openGame(t);
    // Offset the cast from the animation-frame grid so the deadline falls between frames.
    await page.clock.runFor(7);
    const castTime = await page.evaluate(() => performance.now());
    await cast(page);
    await advanceUntil(page, (state) => state.phase === "biting");
    await page.locator("#fish-button").focus();
    const delay = await page.evaluate((started) => started + 3050 + 1800 + 1 - performance.now(), castTime);
    assert.ok(delay > 0);
    await page.evaluate(({ milliseconds, type }) => {
      setTimeout(() => {
        const button = document.getElementById("fish-button");
        window.__deadlineInputBefore = document.getElementById("scene").dataset.phase;
        const event = type === "pointer"
          ? new PointerEvent("pointerdown", { bubbles: true, pointerId: 987, pointerType: "mouse", isPrimary: true, button: 0 })
          : new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: false });
        button.dispatchEvent(event);
        window.__deadlineInputAfter = document.getElementById("scene").dataset.phase;
      }, milliseconds);
    }, { milliseconds: delay, type: inputType });
    await page.clock.runFor(delay + 1);
    const observed = await page.evaluate(() => ({ before: window.__deadlineInputBefore, after: window.__deadlineInputAfter }));
    assert.deepEqual(observed, { before: "biting", after: "failure" });
    assert.equal((await readState(page)).phase, "failure");
    await assertEmpty(page);
    await page.evaluate((type) => {
      const event = type === "pointer"
        ? new PointerEvent("pointerup", { bubbles: true, pointerId: 987, pointerType: "mouse", isPrimary: true, button: 0 })
        : new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" });
      document.dispatchEvent(event);
    }, inputType);
    await cast(page, 0.175);
    assert.equal((await readState(page)).phase, "waiting");
  });
}

test("calm, warning, and struggling each show distinct visible Japanese feedback", async (t) => {
  const page = await openGame(t);
  await hook(page);
  const messages = [];
  for (const fishState of ["calm", "warning", "struggling"]) {
    await advanceUntil(page, (state) => state.fishState === fishState);
    assert.equal(await page.locator("#fish-state").isVisible(), true);
    messages.push(await page.locator("#fish-state").textContent());
    assert.ok((await page.locator("#input-guide").textContent()).length > 0);
    await assertGauges(page);
    await assertEmpty(page);
    await assertNoRevealedFish(page);
  }
  assert.equal(new Set(messages).size, 3);
  for (const message of messages) assert.match(message, /[ぁ-んァ-ヶ一-龯]/);
});

test("100% tension freezes danger on release, recovers only after continuous rest, and clears danger at the safe threshold", async (t) => {
  const page = await openGame(t, { sample: 0.99 });
  await hook(page);
  await mouseDown(page);
  await advanceUntil(page, (state) => state.tension === 100, { step: 20 });
  await page.clock.runFor(200);
  assert.equal((await readState(page)).phase, "reeling");
  assert.equal(await page.locator("#tension-warning").isVisible(), true);
  await assertGauges(page);
  await page.mouse.up();
  const atRelease = await readState(page);
  assert.equal(atRelease.restState, "waiting");
  assert.match(atRelease.restText, /休|回復/);
  assert.match(atRelease.graceText, /残り猶予/);
  await page.clock.runFor(299);
  assert.equal((await readState(page)).phase, "reeling");
  assert.equal((await readState(page)).tension, 100);
  assert.equal((await readState(page)).graceText, atRelease.graceText);
  assert.equal((await readState(page)).restState, "waiting");
  await page.clock.runFor(51);
  const partial = await readState(page);
  assert.equal(partial.restState, "recovering");
  // Only time beyond the delay recovers tension; rendering may lag by one animation frame.
  assert.ok(partial.tension >= 98 && partial.tension <= 99);
  assert.equal(partial.graceText, atRelease.graceText);
  assert.match(partial.warning, /危険.*70%|70%.*危険/);
  const safe = await advanceUntil(page, (state) => state.graceText === "", { maxMs: 2000, step: 20 });
  assert.ok(safe.tension <= 70);
  await reelSafely(page);
  assert.equal((await readState(page)).score, "300");
});

test("mouse release outside the button stops reeling and relieves tension", async (t) => {
  const page = await openGame(t);
  await hook(page);
  await mouseDown(page);
  await page.clock.runFor(200);
  const held = await readState(page);
  assert.ok(held.progress > 0);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  const atRelease = await readState(page);
  await page.clock.runFor(299);
  assert.equal((await readState(page)).tension, atRelease.tension);
  assert.equal((await readState(page)).restState, "waiting");
  await page.clock.runFor(151);
  const released = await readState(page);
  assert.ok(atRelease.progress >= held.progress);
  assert.equal(released.progress, atRelease.progress);
  assert.ok(released.tension < atRelease.tension);
  assert.equal(released.label, "長押しで巻く");
});

for (const eventType of ["pointercancel", "lostpointercapture", "blur"]) {
  test(`${eventType} event releases the active hold without a stuck reel`, async (t) => {
    const page = await openGame(t);
    await hook(page);
    await mouseDown(page);
    await page.clock.runFor(200);
    const before = await readState(page);
    // Cancellation/blur notifications are deliberately injected; actual touch cancellation is tested separately.
    await page.evaluate((type) => {
      if (type === "blur") window.dispatchEvent(new Event("blur"));
      else document.getElementById("fish-button").dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
      }));
    }, eventType);
    const atRelease = await readState(page);
    await page.clock.runFor(299);
    assert.equal((await readState(page)).tension, atRelease.tension);
    if (eventType !== "blur") assert.equal((await readState(page)).restState, "waiting");
    await page.clock.runFor(151);
    const after = await readState(page);
    assert.ok(atRelease.progress >= before.progress);
    assert.equal(after.progress, atRelease.progress);
    if (eventType === "blur") {
      assert.equal(after.phase, "paused");
      assert.equal(after.tension, atRelease.tension);
      assert.equal(after.label, "準備して再開");
    } else {
      assert.ok(after.tension < atRelease.tension);
      assert.equal(after.label, "長押しで巻く");
    }
    await page.mouse.up();
    if (eventType === "blur") await pressButton(page);
    await reelSafely(page);
    assert.equal((await readState(page)).score, "10");
  });
}

test("Space/Enter repeats and simultaneous keys cannot hook or wind without a fresh action", async (t) => {
  const page = await openGame(t);
  await page.locator("#fish-button").focus();
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.down("Enter");
  await advanceUntil(page, (state) => state.phase === "biting");
  await page.keyboard.down("Space");
  await page.keyboard.down("Enter");
  assert.equal((await readState(page)).phase, "biting");
  await page.keyboard.up("Enter");
  await page.keyboard.up("Space");
  await page.keyboard.down("Enter");
  assert.equal((await readState(page)).phase, "reeling");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Space");
  await page.clock.runFor(300);
  assert.equal((await readState(page)).progress, 0);
  assert.equal((await readState(page)).tension, 20);
  assert.equal((await readState(page)).restState, "neutral");
  await page.keyboard.up("Space");
  await page.keyboard.up("Enter");
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.down("Enter");
  await page.clock.runFor(150);
  assert.ok((await readState(page)).progress > 0);
  await page.keyboard.up("Enter");
  assert.equal((await readState(page)).label, "巻いています…");
  await page.keyboard.up("Space");
  const released = await readState(page);
  await page.clock.runFor(299);
  assert.equal((await readState(page)).tension, released.tension);
  assert.equal((await readState(page)).restState, "waiting");
  assert.equal((await readState(page)).progress, released.progress);
  assert.equal((await readState(page)).label, "長押しで巻く");
  await reelSafely(page);
  assert.equal((await readState(page)).score, "10");
});

test("keyboard focus loss and keyup outside the main button release reeling", async (t) => {
  const page = await openGame(t);
  await hook(page);
  await page.locator("#fish-button").focus();
  await page.keyboard.down("Enter");
  await page.clock.runFor(200);
  const held = await readState(page);
  await page.locator("#reset-button").focus();
  await page.keyboard.up("Enter");
  const atRelease = await readState(page);
  await page.clock.runFor(299);
  assert.equal((await readState(page)).tension, atRelease.tension);
  assert.equal((await readState(page)).restState, "waiting");
  await page.clock.runFor(151);
  const released = await readState(page);
  assert.ok(atRelease.progress >= held.progress);
  assert.equal(released.progress, atRelease.progress);
  assert.ok(released.tension < atRelease.tension);
  await page.keyboard.press("Enter");
  assert.equal((await readState(page)).phase, "idle");
  await assertEmpty(page);
});

test("Chromium touch events support casting, hooking, outside release, and touch cancellation", async (t) => {
  const page = await openGame(t, { touch: true, viewport: { width: 375, height: 812 } });
  const session = await page.context().newCDPSession(page);
  async function touch(type, point) {
    await session.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
  }
  let point = await buttonPoint(page);
  await touch("touchStart", point);
  await touch("touchEnd");
  assert.equal((await readState(page)).phase, "waiting");
  await advanceUntil(page, (state) => state.phase === "biting");
  point = await buttonPoint(page);
  await touch("touchStart", point);
  await page.clock.runFor(200);
  assert.equal((await readState(page)).phase, "reeling");
  assert.equal((await readState(page)).progress, 0);
  await touch("touchEnd");
  await touch("touchStart", point);
  await page.clock.runFor(200);
  const held = await readState(page);
  assert.ok(held.progress > 0);
  await touch("touchMove", { x: 2, y: 2 });
  await touch("touchEnd");
  const afterRelease = await readState(page);
  await page.clock.runFor(200);
  assert.ok(afterRelease.progress >= held.progress);
  assert.equal((await readState(page)).progress, afterRelease.progress);
  point = await buttonPoint(page);
  await touch("touchStart", point);
  await page.clock.runFor(100);
  const beforeCancel = await readState(page);
  await touch("touchCancel");
  const atCancel = await readState(page);
  await page.clock.runFor(200);
  assert.ok(atCancel.progress >= beforeCancel.progress);
  assert.equal((await readState(page)).progress, atCancel.progress);
  assert.equal((await readState(page)).label, "長押しで巻く");
  await assertNoOverflow(page);
  await session.detach();
});

async function preparePhase(page, phase) {
  if (phase === "failure") {
    await cast(page);
    await pressButton(page);
    return;
  }
  if (["reeling", "overload", "success", "paused"].includes(phase)) {
    await hook(page);
    if (phase === "overload") {
      await mouseDown(page);
      await advanceUntil(page, (state) => state.tension === 100, { step: 20 });
      await page.clock.runFor(200);
      assert.equal((await readState(page)).phase, "reeling");
    } else if (phase === "success") {
      await reelSafely(page);
    } else if (phase === "paused") {
      await simulateVisibility(page, true);
    }
    return;
  }
  await cast(page);
  if (phase !== "waiting") await advanceUntil(page, (state) => state.phase === phase);
}

for (const phase of ["waiting", "nibbling", "biting", "reeling", "overload", "success", "failure", "paused"]) {
  test(`reset from ${phase} clears every record and leaves no phantom result`, async (t) => {
    const page = await openGame(t, { sample: 0.175 });
    await hook(page);
    await reelSafely(page);
    assert.equal((await readState(page)).score, "10");
    await nextFish(page, phase === "overload" ? 0.99 : 0.175);
    await preparePhase(page, phase);
    // A captured/held mouse cannot click a second button; activate reset with a different real input.
    await page.locator("#reset-button").focus();
    await page.keyboard.press("Enter");
    await page.mouse.up();
    assert.equal((await readState(page)).phase, "idle");
    assert.equal((await readState(page)).label, "投げる");
    await assertEmpty(page);
    await assertGauges(page);
    assert.equal((await readState(page)).progress, 0);
    assert.equal((await readState(page)).tension, 0);
    assert.equal((await readState(page)).restState, "inactive");
    assert.equal((await readState(page)).restCountdown, "");
    assert.equal((await readState(page)).graceText, "");
    if (phase === "paused") await simulateVisibility(page, false);
    await page.clock.runFor(10000);
    assert.equal((await readState(page)).phase, "idle");
    await assertEmpty(page);
    await nextFish(page, 0.175);
    await hook(page);
    await reelSafely(page);
    assert.equal((await readState(page)).score, "10");
    assert.equal((await readState(page)).count, "1匹");
  });
}

for (const phase of ["waiting", "nibbling", "biting", "reeling", "overload"]) {
  test(`simulated visibility hiding freezes ${phase}; restoration requires an explicit consumed resume action`, async (t) => {
    const page = await openGame(t, { sample: phase === "overload" ? 0.99 : 0.175 });
    await preparePhase(page, phase);
    await simulateVisibility(page, true);
    await page.mouse.up();
    const atPause = await readState(page);
    assert.equal((await readState(page)).phase, "paused");
    assert.equal(await page.locator("#pause-notice").isVisible(), true);
    assert.equal((await readState(page)).label, "準備して再開");
    await page.clock.runFor(6000);
    const paused = await readState(page);
    assert.equal(paused.progress, atPause.progress);
    assert.equal(paused.tension, atPause.tension);
    await assertEmpty(page);
    await simulateVisibility(page, false);
    assert.equal((await readState(page)).phase, "paused");
    await page.clock.runFor(2000);
    assert.equal((await readState(page)).phase, "paused");
    await pressButton(page);
    const resumed = await readState(page);
    assert.equal(resumed.phase, phase === "overload" ? "reeling" : phase);
    assert.equal(resumed.progress, atPause.progress);
    assert.equal(resumed.tension, atPause.tension);
    if (["reeling", "overload"].includes(phase)) {
      await page.clock.runFor(200);
      assert.equal((await readState(page)).progress, atPause.progress);
      assert.equal((await readState(page)).phase, "reeling");
      await reelSafely(page);
    } else {
      if (phase !== "biting") await advanceUntil(page, (state) => state.phase === "biting");
      assert.equal((await readState(page)).phase, "biting");
      await pressButton(page);
      await reelSafely(page);
    }
    assert.equal((await readState(page)).score, phase === "overload" ? "300" : "10");
  });
}

for (const width of [375, 320]) {
  test(`${width}px mobile layout keeps gauges, warnings, and controls within the viewport through every stage`, async (t) => {
    const page = await openGame(t, { sample: 0.99, viewport: { width, height: 812 }, touch: true });
    await assertEmpty(page);
    await assertNoOverflow(page);
    await cast(page);
    for (const phase of ["nibbling", "biting"]) {
      await advanceUntil(page, (state) => state.phase === phase);
      await assertNoOverflow(page);
      await assertGauges(page);
    }
    await pressButton(page);
    await mouseDown(page);
    await advanceUntil(page, (state) => state.tension === 100, { step: 20 });
    await page.clock.runFor(200);
    assert.equal((await readState(page)).phase, "reeling");
    assert.equal(await page.locator("#tension-warning").isVisible(), true);
    assert.match((await readState(page)).graceText, /残り猶予/);
    await assertNoOverflow(page);
    await assertGauges(page);
    const boxes = await Promise.all(["#fish-button", "#catch-progress", "#line-tension", "#tension-warning", "#rest-status", "#tension-grace"].map((selector) => page.locator(selector).boundingBox()));
    for (const box of boxes) {
      assert.ok(box && box.x >= 0 && box.x + box.width <= width);
      assert.ok(box.y >= 0 && box.y + box.height <= 812, "巻くボタンとゲージを同時に表示すること");
    }
    await page.mouse.up();
    await page.clock.runFor(300);
    await simulateVisibility(page, true);
    await assertNoOverflow(page);
    await simulateVisibility(page, false);
    await pressButton(page);
    await reelSafely(page);
    assert.equal((await readState(page)).score, "300");
    await assertNoOverflow(page);
    await screenshot(page, `fishing-game-mobile-${width}.png`);
    await page.locator("#reset-button").click();
    await assertEmpty(page);
  });
}

async function inputDriver(page, type) {
  if (type === "mouse") return { down: () => mouseDown(page), up: () => page.mouse.up(), close: async () => {} };
  if (type === "Space" || type === "Enter") return {
    down: async () => {
      await page.locator("#fish-button").focus();
      await page.keyboard.down(type);
    },
    up: () => page.keyboard.up(type),
    close: async () => {},
  };
  const session = await page.context().newCDPSession(page);
  return {
    down: async () => {
      const point = await buttonPoint(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
    },
    up: () => session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
    close: () => session.detach(),
  };
}

for (const type of ["mouse", "touch", "Space", "Enter"]) {
  test(`${type}: legitimate 50/50ms taps wind for their actual duration but never combine short rests into recovery`, async (t) => {
    const page = await openGame(t, type === "touch" ? { touch: true, viewport: { width: 375, height: 812 } } : {});
    const input = await inputDriver(page, type);
    await hook(page);
    const start = await readState(page);
    for (let index = 0; index < 10; index += 1) {
      await input.down();
      assert.equal((await readState(page)).restState, "held");
      await page.clock.runFor(50);
      await input.up();
      const atRelease = await readState(page);
      assert.equal(atRelease.restState, "waiting");
      assert.match(atRelease.restCountdown, /0\.3/);
      await page.clock.runFor(50);
      const shortRest = await readState(page);
      assert.equal(shortRest.progress, atRelease.progress);
      assert.equal(shortRest.tension, atRelease.tension);
      assert.equal(shortRest.restState, "waiting");
    }
    const taps = await readState(page);
    assert.equal(taps.phase, "reeling");
    assert.ok(taps.progress >= 8 && taps.progress <= 10);
    assert.ok(taps.tension - start.tension >= 6 && taps.tension - start.tension <= 8);
    await assertEmpty(page);

    await page.locator("#reset-button").click();
    await nextFish(page, 0.175);
    await hook(page);
    const beforeHold = await readState(page);
    await input.down();
    await page.clock.runFor(500);
    await input.up();
    const hold = await readState(page);
    // Both patterns contain 500ms of real winding in the same calm state.
    assert.ok(Math.abs(hold.progress - taps.progress) <= 1);
    assert.ok(Math.abs((hold.tension - beforeHold.tension) - (taps.tension - start.tension)) <= 1);
    await page.clock.runFor(299);
    assert.equal((await readState(page)).tension, hold.tension);
    assert.equal((await readState(page)).restState, "waiting");
    await page.clock.runFor(151);
    const recovery = await readState(page);
    assert.equal(recovery.restState, "recovering");
    assert.equal(recovery.progress, hold.progress);
    assert.ok(recovery.tension < hold.tension);
    await input.close();
  });
}

async function bankDanger(page) {
  await hook(page);
  await mouseDown(page);
  // アジ reaches 100% tension at 4320ms; 5020ms uses 700 of the 900ms grace.
  await page.clock.runFor(5020);
  await page.mouse.up();
  const state = await readState(page);
  assert.equal(state.phase, "reeling");
  assert.equal(state.tension, 100);
  assert.match(state.graceText, /0\.2秒/);
  return state;
}

test("700ms of banked danger survives a short release and partial recovery below 100%, then winding uses the remaining grace", async (t) => {
  const page = await openGame(t);
  const danger = await bankDanger(page);
  await page.clock.runFor(299);
  assert.equal((await readState(page)).tension, 100);
  assert.equal((await readState(page)).graceText, danger.graceText);
  assert.equal((await readState(page)).restState, "waiting");
  await page.clock.runFor(51);
  const partial = await readState(page);
  assert.ok(partial.tension >= 98 && partial.tension <= 99);
  assert.equal(partial.graceText, danger.graceText);
  assert.match(partial.warning, /危険.*70%|70%.*危険/);
  await mouseDown(page);
  await page.clock.runFor(300);
  assert.equal((await readState(page)).phase, "failure");
  await page.mouse.up();
  await assertEmpty(page);
});

test("zero-time accessible clicks and duplicate release notifications grant neither recovery nor a fresh danger budget", async (t) => {
  const page = await openGame(t);
  const before = await bankDanger(page);
  await page.evaluate(() => {
    const button = document.getElementById("fish-button");
    for (let index = 0; index < 10; index += 1) {
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      button.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, pointerType: "mouse", isPrimary: true }));
      button.click();
    }
  });
  const after = await readState(page);
  assert.equal(after.progress, before.progress);
  assert.equal(after.tension, before.tension);
  assert.equal(after.graceText, before.graceText);
  assert.equal(after.restState, "waiting");
  await mouseDown(page);
  await page.clock.runFor(220);
  assert.equal((await readState(page)).phase, "failure");
  await page.mouse.up();
  await assertEmpty(page);
});

test("winding during struggle moves progress back over elapsed time, while rest preserves it and zero remains clamped", async (t) => {
  const page = await openGame(t);
  await hook(page);
  await mouseDown(page);
  await page.clock.runFor(1200);
  await page.mouse.up();
  const built = await readState(page);
  assert.ok(built.progress >= 21 && built.progress <= 22);
  await advanceUntil(page, (state) => state.fishState === "warning");
  assert.match(await page.locator("#fish-state").textContent(), /予兆/);
  await advanceUntil(page, (state) => state.fishState === "struggling");
  const before = await readState(page);
  assert.equal(before.progress, built.progress);
  assert.match(await page.locator("#fish-state").textContent(), /ゲージが戻る/);
  await mouseDown(page);
  await page.clock.runFor(1000);
  await page.mouse.up();
  const regressed = await readState(page);
  assert.ok(before.progress - regressed.progress >= 3 && before.progress - regressed.progress <= 5);
  assert.ok(regressed.tension > before.tension);
  await page.clock.runFor(800);
  assert.equal((await readState(page)).progress, regressed.progress);
  await assertEmpty(page);

  await page.locator("#reset-button").click();
  await nextFish(page, 0.175);
  await hook(page);
  await advanceUntil(page, (state) => state.fishState === "struggling");
  await mouseDown(page);
  await page.clock.runFor(400);
  await page.mouse.up();
  assert.equal((await readState(page)).progress, 0);
  await assertGauges(page);
});

test("pause and a held resume freeze both partially elapsed recovery delay and banked danger", async (t) => {
  const page = await openGame(t);
  await bankDanger(page);
  await page.clock.runFor(200);
  await simulateVisibility(page, true);
  const paused = await readState(page);
  assert.equal(paused.phase, "paused");
  assert.equal(paused.restState, "paused");
  assert.match(paused.restCountdown, /0\.1秒/);
  assert.match(paused.graceText, /0\.2秒/);
  await page.clock.runFor(5000);
  const hidden = await readState(page);
  assert.equal(hidden.tension, paused.tension);
  assert.equal(hidden.progress, paused.progress);
  assert.equal(hidden.restCountdown, paused.restCountdown);
  assert.equal(hidden.graceText, paused.graceText);
  await simulateVisibility(page, false);
  assert.equal((await readState(page)).phase, "paused");
  await mouseDown(page);
  assert.equal((await readState(page)).restState, "neutral");
  await page.clock.runFor(1000);
  const heldResume = await readState(page);
  assert.equal(heldResume.tension, paused.tension);
  assert.equal(heldResume.progress, paused.progress);
  assert.equal(heldResume.graceText, paused.graceText);
  await page.mouse.up();
  assert.match((await readState(page)).restCountdown, /0\.1秒/);
  await page.clock.runFor(90);
  assert.equal((await readState(page)).tension, 100);
  assert.equal((await readState(page)).graceText, paused.graceText);
  await page.clock.runFor(70);
  assert.ok((await readState(page)).tension < 100);
  assert.equal((await readState(page)).graceText, paused.graceText);
  await mouseDown(page);
  await page.clock.runFor(400);
  assert.equal((await readState(page)).phase, "failure");
  await page.mouse.up();
  await assertEmpty(page);
});

for (const boundary of ["waiting", "recovering", "safe", "paused"]) {
  test(`reset at ${boundary} recovery/danger boundary starts the next fight with a fresh budget`, async (t) => {
    const page = await openGame(t);
    await bankDanger(page);
    if (boundary === "waiting" || boundary === "paused") await page.clock.runFor(200);
    if (boundary === "recovering") await page.clock.runFor(350);
    if (boundary === "safe") await advanceUntil(page, (state) => state.graceText === "", { maxMs: 2000, step: 20 });
    if (boundary === "paused") await simulateVisibility(page, true);
    await page.locator("#reset-button").focus();
    await page.keyboard.press("Enter");
    const reset = await readState(page);
    assert.equal(reset.phase, "idle");
    assert.equal(reset.restState, "inactive");
    assert.equal(reset.restCountdown, "");
    assert.equal(reset.graceText, "");
    await assertEmpty(page);
    if (boundary === "paused") await simulateVisibility(page, false);
    await nextFish(page, 0.175);
    await hook(page);
    await mouseDown(page);
    await page.clock.runFor(4420);
    await page.mouse.up();
    const fresh = await readState(page);
    assert.equal(fresh.phase, "reeling");
    assert.equal(fresh.tension, 100);
    assert.match(fresh.graceText, /0\.8秒/);
    assert.equal(fresh.restState, "waiting");
    await assertEmpty(page);
  });
}

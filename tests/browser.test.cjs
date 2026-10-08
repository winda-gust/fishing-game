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

async function openGame(t, { samples = [0], viewport = { width: 1440, height: 1100 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await context.addInitScript((values) => {
    const remaining = [...values];
    Math.random = () => {
      if (remaining.length === 0) throw new Error("テスト用の乱数を使い切りました。");
      return remaining.shift();
    };
  }, samples);
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
  await page.goto(entrypoint);
  await page.locator("#fish-catalog > li").nth(5).waitFor();
  return page;
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
  assert.equal(await page.locator("#fish-button").isEnabled(), true);
  assert.equal(await page.locator("#fish-button-label").textContent(), "釣りをはじめる");
  assert.equal(await page.locator("#collection-progress strong").textContent(), "0 / 6");
  assert.deepEqual(await page.locator(".catalog-status").allTextContents(), Array(6).fill("未発見"));
}

async function startAndWait(page) {
  await page.getByRole("button", { name: "釣りをはじめる", exact: true }).click();
  assert.equal(await page.locator("#fish-button").isDisabled(), true);
  assert.equal(await page.locator("#fish-button-label").textContent(), "魚を待っています…");
  assert.equal(await page.locator("#scene-state").textContent(), "アタリを待っています");
  assert.equal(await page.locator("#reset-button").isEnabled(), true);
  assert.equal(await page.locator("#scene").evaluate((scene) => scene.classList.contains("is-fishing")), true);
  await assertNoOverflow(page);
  await page.waitForFunction(() => !document.getElementById("fish-button").disabled, undefined, { timeout: 5000 });
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

test("Japanese UI loads, all six weighted catches update history, score, collection, and reset", async (t) => {
  const page = await openGame(t, { samples: [0.175, 0.475, 0.7, 0.86, 0.95, 0.99] });
  assert.equal(await page.locator("html").getAttribute("lang"), "ja");
  assert.match(await page.title(), /釣り日和/);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "今日も、いい一匹に出会おう。");
  assert.equal(await page.locator("#fish-catalog > li").count(), 6);
  assert.deepEqual(await page.locator("#fish-catalog h3").allTextContents(),
    ["アジ", "イワシ", "サバ", "タイ", "マグロ", "金の魚"]);
  assert.deepEqual(await page.locator(".catalog-points").allTextContents(),
    ["10 pt", "15 pt", "20 pt", "50 pt", "100 pt", "300 pt"]);
  await assertEmpty(page);
  await assertNoOverflow(page);

  const catches = [
    { id: "aji", name: "アジ", points: 10 },
    { id: "iwashi", name: "イワシ", points: 15 },
    { id: "saba", name: "サバ", points: 20 },
    { id: "tai", name: "タイ", points: 50 },
    { id: "maguro", name: "マグロ", points: 100 },
    { id: "gold", name: "金の魚", points: 300 },
  ];
  let score = 0;
  for (const [index, fish] of catches.entries()) {
    await startAndWait(page);
    score += fish.points;
    assert.equal(await page.locator("#result-title").textContent(), `${fish.name}が釣れた！ +${fish.points} pt`);
    assert.equal(await page.locator("#total-score").textContent(), score.toLocaleString("ja-JP"));
    assert.equal(await page.locator("#catch-count").textContent(), `${index + 1}匹`);
    assert.equal(await page.locator("#catch-list > li").count(), index + 1);
    assert.equal(await page.locator("#empty-catch").isVisible(), false);
    assert.equal(await page.locator("#catch-pop").isVisible(), true);
    assert.deepEqual(await historyNames(page), catches.slice(0, index + 1).reverse().map((entry) => entry.name));
    assert.equal(await page.locator(".catch-row").first().locator(".catch-points").textContent(), `+${fish.points}pt`);
    assert.equal(await page.locator(".catch-row").first().locator(".catch-number").textContent(), `${index + 1}匹目`);
    assert.equal(await page.locator(`[data-fish-id="${fish.id}"] .catalog-status`).textContent(), "1匹 釣れた！");
    assert.equal(await page.locator("#collection-progress strong").textContent(), `${index + 1} / 6`);
  }
  assert.equal(await page.locator("#total-score").textContent(), "495");
  await assertNoOverflow(page);
  await screenshot(page, "fishing-game-desktop.png");
  await page.getByRole("button", { name: "リセット", exact: true }).click();
  await assertEmpty(page);
  assert.match(await page.locator("#result-title").textContent(), /リセットしました/);
});

test("reset during the real pending timer produces no phantom catch and fishing can resume", async (t) => {
  const page = await openGame(t, { samples: [0.175, 0.99] });
  await startAndWait(page);
  assert.equal(await page.locator("#total-score").textContent(), "10");
  await page.getByRole("button", { name: "釣りをはじめる", exact: true }).click();
  assert.equal(await page.locator("#fish-button").isDisabled(), true);
  await page.getByRole("button", { name: "リセット", exact: true }).click();
  await assertEmpty(page);
  // Keep the page alive beyond the original 1.8-second timeout to prove cancellation.
  await page.waitForTimeout(2000);
  await assertEmpty(page);
  await startAndWait(page);
  assert.equal(await page.locator("#total-score").textContent(), "300");
  assert.deepEqual(await historyNames(page), ["金の魚"]);
  assert.equal(await page.locator("#catch-count").textContent(), "1匹");
});

test("keyboard Tab and Enter operate the game with visible focus and a live result announcement", async (t) => {
  const page = await openGame(t, { samples: [0.86] });
  assert.equal(await page.locator(".message-area").getAttribute("aria-live"), "polite");
  assert.equal(await page.locator(".message-area").getAttribute("aria-atomic"), "true");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".brand").evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#fish-button").evaluate((element) => element === document.activeElement), true);
  const focusStyle = await page.locator("#fish-button").evaluate((element) => ({
    visible: element.matches(":focus-visible"),
    outlineStyle: getComputedStyle(element).outlineStyle,
    outlineWidth: getComputedStyle(element).outlineWidth,
  }));
  assert.equal(focusStyle.visible, true);
  assert.equal(focusStyle.outlineStyle, "solid");
  assert.equal(focusStyle.outlineWidth, "3px");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#fish-button").isDisabled(), true);
  await page.waitForFunction(() => !document.getElementById("fish-button").disabled, undefined, { timeout: 5000 });
  assert.equal(await page.locator("#result-title").textContent(), "タイが釣れた！ +50 pt");
  assert.equal(await page.locator("#total-score").textContent(), "50");
  await page.locator("#reset-button").focus();
  await page.keyboard.press("Enter");
  await assertEmpty(page);
  assert.equal(await page.locator("#reset-button").evaluate((element) => element === document.activeElement), true);
});

for (const width of [375, 320]) {
  test(`${width}px mobile fits without horizontal overflow before, during, and after fishing`, async (t) => {
    const page = await openGame(t, { samples: [0.99], viewport: { width, height: 812 } });
    await assertEmpty(page);
    await assertNoOverflow(page);
    await startAndWait(page);
    assert.equal(await page.locator("#result-title").textContent(), "金の魚が釣れた！ +300 pt");
    assert.equal(await page.locator("#total-score").textContent(), "300");
    assert.equal(await page.locator("#catch-count").textContent(), "1匹");
    await assertNoOverflow(page);
    await screenshot(page, `fishing-game-mobile-${width}.png`);
    await page.getByRole("button", { name: "リセット", exact: true }).click();
    await assertEmpty(page);
    await assertNoOverflow(page);
  });
}

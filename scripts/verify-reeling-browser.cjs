#!/usr/bin/env node
"use strict";

// Real wall-clock browser checks; deterministic first fish draw lives only here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");
const EVIDENCE = path.join(REPORTS, "evidence");
const sourceNames = ["index.html", "styles.css", "game-core.js", "app.js"];
const sourceHashes = () => Object.fromEntries(sourceNames.map(name => [name,
  createHash("sha256").update(fs.readFileSync(path.join(ROOT, name))).digest("hex")]));

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const hashes = sourceHashes();
  const files = new Map(sourceNames.concat("favicon.svg").map(name => ["/" + name, name]));
  files.set("/", "index.html");
  const server = http.createServer((request, response) => {
    const name = files.get(new URL(request.url, "http://127.0.0.1").pathname);
    if (!name) { response.writeHead(404).end(); return; }
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    response.writeHead(200, { "Content-Type": types[path.extname(name)] + "; charset=utf-8" });
    response.end(fs.readFileSync(path.join(ROOT, name)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
    const url = `http://127.0.0.1:${server.address().port}/`;
    async function scenario(id, { input = "mouse", sample = 0.175, width = 1440, height = 1100 } = {}, play) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: input === "touch", isMobile: input === "touch", reducedMotion: "reduce" });
      await context.addInitScript(value => {
        let first = true;
        const original = Math.random;
        Math.random = () => { if (first) { first = false; return value; } return original(); };
      }, sample);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      const session = input === "touch" ? await context.newCDPSession(page) : null;
      const key = input === "space" ? "Space" : "Enter";
      let inputHeld = false;
      async function read() {
        return page.evaluate(() => ({
          phase: document.querySelector("#scene").dataset.phase,
          fishState: document.querySelector("#fish-state").dataset.state,
          progress: Number(document.querySelector("#catch-progress").getAttribute("aria-valuenow")),
          tension: Number(document.querySelector("#line-tension").getAttribute("aria-valuenow")),
          exactProgress: parseFloat(document.querySelector("#progress-fill").style.width),
          exactTension: parseFloat(document.querySelector("#tension-fill").style.width),
          restState: document.querySelector("#rest-status").dataset.state,
          restText: document.querySelector("#rest-status").textContent,
          grace: document.querySelector("#tension-grace").textContent,
          warning: document.querySelector("#tension-warning").textContent,
          title: document.querySelector("#result-title").textContent,
          count: document.querySelector("#catch-count").textContent,
          score: document.querySelector("#total-score").textContent
        }));
      }
      async function down() {
        if (inputHeld) return;
        const button = page.locator("#fish-button");
        await button.scrollIntoViewIfNeeded();
        if (input === "space" || input === "enter") {
          await button.focus();
          await page.keyboard.down(key);
        } else {
          const box = await button.boundingBox();
          const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          if (session) await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
          else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
        }
        inputHeld = true;
      }
      async function up() {
        if (!inputHeld) return;
        inputHeld = false;
        if (session) await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        else if (input === "space" || input === "enter") await page.keyboard.up(key);
        else await page.mouse.up();
      }
      async function press() { await down(); await up(); }
      async function until(predicate, maxMs = 10000) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
          const state = await read();
          if (predicate(state)) return state;
          await page.waitForTimeout(20);
        }
        throw new Error(`Timeout in ${id}: ${JSON.stringify(await read())}`);
      }
      try {
        await page.goto(url);
        await press();
        await until(state => state.phase === "biting", 6000);
        await press();
        assert.equal((await read()).phase, "reeling");
        const started = Date.now();
        const extra = await play({ page, read, down, up, until, started });
        await up();
        assert.deepEqual(errors, [], "No JavaScript or console errors");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false);
        const result = { id, input, viewport: { width, height }, fishDraw: "test-only first sample", sample, elapsedMs: Date.now() - started, ...await read(), ...extra, errors };
        results.push(result);
        console.log(JSON.stringify(result));
      } finally { await context.close(); }
    }
    for (const input of ["mouse", "touch", "space", "enter"]) {
      await scenario(`${input}-50/50ms`, { input, width: input === "touch" ? 375 : 1440, height: input === "touch" ? 812 : 1100 }, async ({ page, read, down, up, started }) => {
        let taps = 0;
        const intervals = [];
        while (Date.now() - started < 25000 && (await read()).phase === "reeling") {
          await down();
          const at = Date.now();
          await page.waitForTimeout(50);
          await up();
          intervals.push(Date.now() - at);
          taps += 1;
          await page.waitForTimeout(50);
        }
        assert.match((await read()).title, /糸が切れた/);
        assert.equal((await read()).score, "0");
        return { requestedHoldMs: 50, requestedRestMs: 50, taps, measuredHoldMs: [Math.min(...intervals), Math.max(...intervals)] };
      });
    }
    for (const [id, input, sample, width, height] of [
      ["mouse-adaptive-aji-200ms", "mouse", 0.175, 1440, 1100],
      ["touch-adaptive-gold-200ms", "touch", 0.99, 375, 812]
    ]) await scenario(id, { input, sample, width, height }, async ({ page, read, down, up, started }) => {
      let held = false, target = false, observed = false, pending = false, pendingAt = Infinity, screenshot = false;
      while (Date.now() - started < 60000) {
        const state = await read();
        if (state.phase === "success") {
          assert.equal(state.count, "1匹");
          assert.equal(state.score, sample === 0.99 ? "300" : "10");
          return { requestedReactionDelayMs: 200 };
        }
        assert.equal(state.phase, "reeling");
        if (state.fishState !== "calm" || state.tension >= 75 || state.grace) target = false;
        else if (state.tension <= 40) target = true;
        if (target !== observed) { observed = target; pending = target; pendingAt = Date.now() + 200; }
        if (Date.now() >= pendingAt) {
          if (pending && !held) { await down(); held = true; }
          else if (!pending && held) { await up(); held = false; }
          pendingAt = Infinity;
        }
        if (sample === 0.99 && state.fishState === "warning" && !screenshot && !held) {
          await page.screenshot({ path: path.join(EVIDENCE, "reeling-mobile-375-warning.png") });
          screenshot = true;
        }
        await page.waitForTimeout(25);
      }
      throw new Error("Adaptive play did not succeed within observation limit");
    });
    await scenario("danger-short-release-320px", { width: 320, height: 812 }, async ({ page, read, down, up, until }) => {
      await down();
      await until(state => /残り猶予 0\.2秒/.test(state.grace), 12000);
      await up();
      const released = await read();
      await page.waitForTimeout(100);
      const shortRest = await read();
      assert.equal(shortRest.exactTension, released.exactTension);
      assert.equal(shortRest.grace, released.grace);
      assert.equal(shortRest.restState, "waiting");
      await page.waitForTimeout(350);
      const recovering = await read();
      assert.ok(recovering.exactTension < released.exactTension);
      assert.equal(recovering.grace, released.grace);
      assert.match(recovering.warning, /70%以下/);
      await page.screenshot({ path: path.join(EVIDENCE, "reeling-mobile-320-danger.png") });
      await until(state => state.tension <= 70 && state.grace === "", 2000);
      return { timeline: { released, shortRest100ms: shortRest, after450ms: recovering, safe: await read() } };
    });
    await scenario("struggle-regression", {}, async ({ page, read, down, up, until }) => {
      await down(); await page.waitForTimeout(1500); await up();
      await until(state => state.fishState === "struggling");
      const before = await read();
      await down(); await page.waitForTimeout(200); await up();
      const regressed = await read();
      assert.ok(regressed.exactProgress < before.exactProgress);
      await page.waitForTimeout(150);
      const rested = await read();
      assert.equal(rested.exactProgress, regressed.exactProgress);
      return { timeline: { before, held200ms: regressed, released150ms: rested } };
    });
    assert.deepEqual(sourceHashes(), hashes, "Source must not change during real-time verification");
    fs.writeFileSync(path.join(REPORTS, "reeling-browser-realtime.json"), JSON.stringify({
      environment: { browser: "Chromium", version: browser.version(), headless: true, physicalPhone: false, nativeClock: true, visibilityLifecycle: "not tested by this real-time script" },
      input: "automated real browser mouse/keyboard/CDP touch events; no virtual clock", sourceSha256: hashes, results
    }, null, 2) + "\n");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

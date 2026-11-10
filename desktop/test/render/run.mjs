import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import axe from "axe-core";
import { nativeStub, scenarios } from "./fixtures.mjs";

const root = resolve(fileURLToPath(new URL("../../dist/", import.meta.url)));
const output = resolve(process.env.SHOTS ?? "test/render/artifacts");
const config = JSON.parse(await readFile(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
await mkdir(output, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  try {
    response.setHeader("Content-Security-Policy", config.app.security.csp);
    if (request.url === "/axe.js") { response.setHeader("Content-Type", "text/javascript"); response.end(axe.source); return; }
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname}`);
    assert.ok(path.startsWith(`${root}/`));
    response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--no-sandbox"] });
let count = 0;
const cases = scenarios.filter(scenario => !process.env.CASES || process.env.CASES.split(",").includes(scenario.name));
try {
  for (const theme of ["light"]) for (const width of [880, 560]) for (const scenario of cases) {
      const motionModes = process.env.MOTION ? ["no-preference", "reduce"] : ["no-preference"];
      for (const reducedMotion of motionModes) {
      const name = `${scenario.name}-${theme}-${width}${reducedMotion === "reduce" ? "-reduced" : ""}`;
      const context = await browser.newContext({ viewport: { width, height: 660 }, colorScheme: theme, reducedMotion });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.addInitScript(nativeStub, scenario.state);
      await page.goto(address);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(80);
      if (scenario.prepare) { await scenario.prepare(page); await page.waitForTimeout(300); }
      if (scenario.act && process.env.MOTION) {
        await page.evaluate(() => {
          window.__motion = [];
          window.__captureMotion = () => {
            for (const animation of document.getAnimations().filter(a => a.playState !== "finished" && a.effect?.target?.closest?.(".connection-card"))) {
              if (window.__motion.includes(animation)) continue;
              window.__motion.push(animation);
              animation.pause(); animation.currentTime = 0;
            }
          };
          window.__motionObserver = new MutationObserver(window.__captureMotion);
          window.__motionObserver.observe(document.querySelector(".connection-card"), { attributes: true, childList: true, subtree: true });
        });
      }
      const initialTop = await page.locator(".connection-card").evaluate(el => el.getBoundingClientRect().top);
      if (scenario.act) await scenario.act(page);
      if (scenario.act && process.env.MOTION) {
        const animations = await page.evaluate(() => {
          window.__captureMotion();
          window.__motionObserver.disconnect();
          const current = document.getAnimations();
          window.__motion = window.__motion.filter(a => current.includes(a));
          return window.__motion.map(a => ({
            target: a.effect.target.id || a.effect.target.className.baseVal || a.effect.target.className,
            name: a.animationName || a.transitionProperty,
            duration: a.effect.getTiming().duration,
            iterations: a.effect.getTiming().iterations === Infinity ? "infinite" : a.effect.getTiming().iterations,
          }));
        });
        if (reducedMotion === "no-preference") assert.ok(animations.some(a => a.iterations !== "infinite"), `${name}: finite transition captured`);
        await writeFile(`${output}/${name}-motion.json`, JSON.stringify(animations, null, 2));
        const requiredAnimation = { "details-open": "grid-template-rows", "progress-done": "draw", ready: "success", notice: "grid-template-rows" }[scenario.name];
        if (requiredAnimation && reducedMotion === "no-preference") assert.ok(animations.some(a => a.name === requiredAnimation), `${name}: ${requiredAnimation} captured`);
        for (const time of [0, 80, 160, 240]) {
          await page.evaluate(time => { for (const a of window.__motion) a.currentTime = time; }, time);
          await page.screenshot({ path: `${output}/${name}-${time}ms.png` });
          const top = await page.locator(".connection-card").evaluate(el => el.getBoundingClientRect().top);
          const contained = await page.locator(".connection-card").evaluate(el => !el.classList.contains("height-changing") || getComputedStyle(el).overflowY === "clip");
          assert.ok(contained, `${name}: growing card contains incoming content at ${time}ms`);
          const opacity = await page.locator("#connection-title").evaluate(el => Number(getComputedStyle(el).opacity));
          assert.ok(opacity >= .3, `${name}: nonblank content at ${time}ms`);
          assert.ok(scenario.name === "notice" || top === initialTop, `${name}: card anchor at ${time}ms`);
        }
        await page.evaluate(() => { for (const a of window.__motion) a.cancel(); });
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
      if (scenario.expect) await scenario.expect(page);
      assert.deepEqual(errors, [], `${name}: browser errors`);
      const geometry = await page.evaluate(() => {
        const failures = [];
        const root = document.documentElement;
        if (root.scrollHeight > innerHeight || root.scrollWidth > innerWidth) failures.push(`page scroll ${root.scrollWidth}×${root.scrollHeight}`);
        for (const el of document.querySelectorAll("[style]")) if (el.getAttribute("style")?.trim()) failures.push(`inline style attribute: ${el.outerHTML.slice(0, 180)}`);
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr-only");
        for (const el of document.querySelectorAll("body *")) {
          if (!visible(el) || el instanceof SVGElement || !el.textContent?.trim()) continue;
          if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) failures.push(`horizontal overflow: ${el.id || el.tagName}`);
          for (const node of el.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            const box = el.getBoundingClientRect();
            for (const rect of range.getClientRects()) if (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.bottom > box.bottom + 1) failures.push(`clipped text: ${el.id || el.tagName}`);
          }
        }
        const controls = [...document.querySelectorAll("button,input,select,summary")].filter(el => visible(el) && !el.disabled);
        for (const [i, a] of controls.entries()) {
          const x = a.getBoundingClientRect();
          if (x.height < 32 || x.width < 32) failures.push(`small target: ${a.id || a.tagName}`);
          for (const b of controls.slice(i + 1)) {
            const y = b.getBoundingClientRect();
            if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1) failures.push(`overlap: ${a.id} / ${b.id}`);
          }
        }
        return failures;
      });
      assert.deepEqual(geometry, [], `${name}: geometry`);
      await page.addScriptTag({ url: `${address}/axe.js` });
      const violations = await page.evaluate(async () => (await axe.run(document)).violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, [], `${name}: accessibility`);
      const expected = await page.locator("button:visible:enabled,input:visible:enabled,select:visible:enabled,summary:visible").evaluateAll(elements => elements.map(el => el.id || el.tagName));
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      // A click on the non-focusable shell resets the sequential navigation starting point.
      await page.locator(".brand").click();
      const visited = [];
      for (let i = 0; i < expected.length; i++) {
        await page.keyboard.press("Tab");
        visited.push(await page.evaluate(() => document.activeElement.id || document.activeElement.tagName));
      }
      assert.deepEqual(visited, expected, `${name}: keyboard order`);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running").length), 0, `${name}: reduced motion`);
      count++;
      console.log(`PASS ${name}`);
    } finally { await context.close(); }
    }
  }
  console.log(`${count} screen renders passed. Screenshots: ${output}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

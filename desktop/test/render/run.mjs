import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import axe from "axe-core";
import { nativeStub, scenarios } from "./fixtures.mjs";
import { sidebarScenarios } from "./sidebar.mjs";
import { normalRun, recordMotion, reducedRun, reducedViolations } from "./motion.mjs";

const root = resolve(process.env.RENDER_DIST ?? fileURLToPath(new URL("../../dist/", import.meta.url)));
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
const motion = { normal: 0, normalElements: 0, reduced: 0, reducedStill: 0 };
const failed = [];
const matrix = process.env.SIDEBAR_ONLY ? sidebarScenarios(scenarios) : [...scenarios, ...(scenarios.some(({ name }) => name === "welcome") ? sidebarScenarios(scenarios) : [])];
const cases = matrix.filter(scenario => !process.env.CASES || process.env.CASES.split(",").includes(scenario.name));
assert.ok(cases.length, "no render scenarios match");
try {
  const initial = await browser.newContext();
  try {
    const page = await initial.newPage();
    await page.route("**/assets/*.css", route => route.abort());
    await page.goto(address);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), "rgb(255, 252, 238)", "paper before bundled styles");
  } finally { await initial.close(); }
  const hidden = await browser.newContext();
  try {
    const page = await hidden.newPage();
    page.on("pageerror", error => console.error("hidden page:", error.message));
    await page.addInitScript({ content: `(${nativeStub.toString()})({ loading: true }); (${(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
      Object.defineProperty(document, "hidden", { get: () => true });
      // Emulate a hidden webview's suspended frame clock, not a foreground tab.
      window.requestAnimationFrame = () => 1;
      const proof = window.__paintProof = { events: [], daemonPending: false, fontsResolved: false };
      const fonts = new Promise(() => {});
      Object.defineProperty(document.fonts, "ready", { get: () => fonts });
      fonts.then(() => { proof.fontsResolved = true; });
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        if (!this.matches(".brand-mark")) return;
        proof.events.push("decoded");
        await new Promise(resolve => { window.__releaseBrandDecode = resolve; });
      };
      const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", { get() {
        const value = height.get.call(this);
        if (this.matches(".sidebar")) proof.events.push("layout");
        return value;
      } });
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "daemon_request" && args.request.op === "about") proof.daemonPending = true;
        if (command === "first_paint") proof.events.push("report");
        const result = await invoke(command, args);
        if (command === "daemon_request" && args.request.op === "about") proof.daemonPending = false;
        return result;
      };
    }).toString()})();` });
    await page.goto(address);
    // Watchdogs detect hangs only. Scheduling latency is not a paint contract.
    await page.waitForFunction(() => window.__releaseBrandDecode, null, { polling: 5, timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__renderState.paintReports ?? 0), 0, "decode must finish before reporting");
    await page.evaluate(() => window.__releaseBrandDecode());
    await page.waitForFunction(() => window.__renderState.paintReports === 1 && window.__paintProof.daemonPending, null, { polling: 5, timeout: 30000 });
    assert.deepEqual(await page.evaluate(() => ({
      hidden: document.hidden && document.visibilityState === "hidden",
      daemonPending: window.__paintProof.daemonPending,
      fontsResolved: window.__paintProof.fontsResolved,
      events: window.__paintProof.events,
      reports: window.__renderState.paintReports,
    })), { hidden: true, daemonPending: true, fontsResolved: false, events: ["decoded", "layout", "report"], reports: 1 });
  } finally { await hidden.close(); }
  const widths = process.env.RENDER_WIDTH ? [Number(process.env.RENDER_WIDTH)] : [880, 560];
  assert.ok(widths.every(width => width === 880 || width === 560), "unsupported render width");
  for (const theme of ["light"]) for (const width of widths) for (const scenario of cases) {
      const motionModes = process.env.MOTION ? ["no-preference", "reduce"] : ["no-preference"];
      for (const reducedMotion of motionModes) {
      const name = `${scenario.name}-${theme}-${width}${reducedMotion === "reduce" ? "-reduced" : ""}`;
      const context = await browser.newContext({ viewport: { width, height: 660 }, colorScheme: theme, reducedMotion });
    try {
      const page = await context.newPage();
      const errors = [];
      const requests = [];
      page.on("request", request => requests.push(request.url()));
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.addInitScript(recordMotion);
      await page.addInitScript(nativeStub, scenario.state);
      await page.goto(address);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(80);
      await page.waitForFunction(() => window.__renderState.paintReports === 1);
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
        await writeFile(`${output}/${name}-motion.json`, JSON.stringify(animations, null, 2));
        if (scenario.name === "connecting" && reducedMotion === "no-preference") {
          assert.ok(animations.some(a => a.name === "spin" && a.iterations === "infinite"), `${name}: progress spinner captured`);
        }
        if (reducedMotion === "reduce") assert.deepEqual(animations, [], `${name}: no captured motion with reduced motion`);
        for (const time of [0, 80, 160, 240]) {
          await page.evaluate(time => { for (const a of window.__motion) a.currentTime = time; }, time);
          await page.screenshot({ path: `${output}/${name}-${time}ms.png` });
          const top = await page.locator(".connection-card").evaluate(el => el.getBoundingClientRect().top);
          const contained = await page.locator(".connection-card").evaluate(el => !el.classList.contains("height-changing") || getComputedStyle(el).overflowY === "clip");
          assert.ok(contained, `${name}: growing card contains incoming content at ${time}ms`);
          const opacity = await page.locator("#connection-title").evaluate(el => Number(getComputedStyle(el).opacity));
          assert.ok(opacity >= .3, `${name}: nonblank content at ${time}ms`);
          const mainTop = await page.locator("main").evaluate(el => el.getBoundingClientRect().top);
          assert.ok(top >= mainTop, `${name}: card clears main top at ${time}ms`);
        }
        await page.evaluate(() => { for (const a of window.__motion) a.cancel(); });
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
      if (scenario.expect) { await scenario.expect(page); await page.waitForTimeout(300); }
      assert.equal(await page.evaluate(() => window.__renderState.paintReports), 1, `${name}: first paint reported once, including while daemon status waits`);
      assert.deepEqual(errors, [], `${name}: browser errors`);
      assert.ok(requests.every(url => new URL(url).origin === address), `${name}: same-origin requests only`);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([document.fonts.load('800 32px "Bricolage Grotesque"'), document.fonts.load('400 14px "Geist"'), document.fonts.load('600 28px "Geist Mono"')]);
        await document.fonts.ready;
      });
      const brand = await page.evaluate(async () => {
        await Promise.all([document.fonts.load('800 32px "Bricolage Grotesque"'), document.fonts.load('400 14px "Geist"'), document.fonts.load('600 28px "Geist Mono"')]);
        const style = selector => getComputedStyle(document.querySelector(selector));
        const colors = ["--paper", "--card", "--sidebar", "--ink", "--dim", "--rule", "--green", "--amber", "--red", "--gold"];
        const probe = document.createElement("span"); probe.id = "brand-color-probe";
        const sheet = [...document.styleSheets].find(sheet => sheet.href?.startsWith(location.origin));
        const rule = sheet.insertRule("#brand-color-probe { transition: none !important; }", sheet.cssRules.length);
        document.body.append(probe);
        const allowed = new Set(["rgba(0, 0, 0, 0)"]);
        for (const token of colors) { probe.style.color = `var(${token})`; allowed.add(getComputedStyle(probe).color); }
        probe.remove(); sheet.deleteRule(rule);
        await document.fonts.ready;
        await Promise.all([document.fonts.load('800 32px "Bricolage Grotesque"'), document.fonts.load('400 14px "Geist"'), document.fonts.load('600 28px "Geist Mono"')]);
        const invalid = [];
        for (const el of document.querySelectorAll("body *")) {
          for (const pseudo of [null, "::before", "::after"]) {
            const s = getComputedStyle(el, pseudo);
            for (const property of ["color", "backgroundColor"]) if (!allowed.has(s[property])) invalid.push(`${el.id || el.tagName}${pseudo || ""}: ${property} ${s[property]}`);
          }
        }
        return { title: style("#connection-title").fontFamily, body: style("body").fontFamily, code: style(".version").fontFamily,
          loaded: ['800 32px "Bricolage Grotesque"', '400 14px "Geist"', '600 28px "Geist Mono"'].every(font => document.fonts.check(font)),
          background: style(":root").backgroundColor,
          primary: [...document.querySelectorAll(".primary:not(:disabled)")].map(el => getComputedStyle(el).backgroundColor), invalid };
      });
      assert.ok(brand.title.startsWith('"Bricolage Grotesque"'), `${name}: display font`);
      assert.ok(brand.body.startsWith('Geist') || brand.body.startsWith('"Geist"'), `${name}: body font`);
      assert.ok(brand.code.startsWith('"Geist Mono"'), `${name}: code font`);
      assert.ok(brand.loaded, `${name}: all three fonts loaded ${JSON.stringify(await page.evaluate(() => [...document.fonts].map(f => ({family:f.family,status:f.status,weight:f.weight}))))}`);
      assert.equal(brand.background, "rgb(255, 252, 238)", `${name}: paper background`);
      assert.ok(brand.primary.every(color => color === "rgb(32, 43, 67)"), `${name}: navy primary buttons`);
      assert.deepEqual(brand.invalid, [], `${name}: token-only colors`);
      assert.ok(["bricolage-grotesque", "geist-latin", "geist-mono"].every(font => requests.some(url => url.includes(font) && url.endsWith(".woff2"))), `${name}: local font files requested`);
      const geometry = await page.evaluate(() => {
        const failures = [];
        const root = document.documentElement;
        if (root.scrollHeight > innerHeight || root.scrollWidth > innerWidth) failures.push(`page scroll ${root.scrollWidth}×${root.scrollHeight}`);
        for (const el of document.querySelectorAll("[style]")) if (el.getAttribute("style")?.trim()) failures.push(`inline style attribute: ${el.outerHTML.slice(0, 180)}`);
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr-only") && getComputedStyle(el).clipPath !== "inset(50%)";
        for (const el of document.querySelectorAll("body *")) {
          if (!visible(el) || el instanceof SVGElement || !el.textContent?.trim()) continue;
          if (el.id === "machine-name" && getComputedStyle(el).textOverflow === "ellipsis") {
            if (el.title !== el.textContent) failures.push("truncated machine name lacks full title");
            const box = el.getBoundingClientRect();
            if (box.right > innerWidth || box.left < 0) failures.push("machine name outside viewport");
            continue;
          }
          // Other deliberately truncated text passes only while it carries its full text as a tooltip.
          if (getComputedStyle(el).textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
            if (el.title !== el.textContent) failures.push(`truncated text lacks full title: ${el.id || el.className || el.tagName}`);
            continue;
          }
          if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) failures.push(`horizontal overflow: ${el.id || el.tagName}`);
          for (const node of el.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            const box = el.getBoundingClientRect();
            for (const rect of range.getClientRects()) if (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.bottom > box.bottom + 1) failures.push(`clipped text: ${el.id || el.tagName} text=${JSON.stringify(rect.toJSON())} box=${JSON.stringify(box.toJSON())}`);
          }
        }
        // A control scrolled wholly out of its scroller is not on screen, so it can neither overlap nor be tapped.
        const scrolledAway = el => {
          const box = el.getBoundingClientRect();
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (style.overflowX === "visible" && style.overflowY === "visible") continue;
            const clip = parent.getBoundingClientRect();
            if (box.bottom <= clip.top || box.top >= clip.bottom || box.right <= clip.left || box.left >= clip.right) return true;
          }
          return false;
        };
        const controls = [...document.querySelectorAll("button,input,select,summary")].filter(el => visible(el) && !el.disabled && !scrolledAway(el));
        for (const [i, a] of controls.entries()) {
          const x = a.getBoundingClientRect();
          if (x.height < 24 || x.width < 24) failures.push(`small target: ${a.id || a.tagName}`);
          for (const b of controls.slice(i + 1)) {
            const y = b.getBoundingClientRect();
            if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1) failures.push(`overlap: ${a.id} / ${b.id}`);
          }
        }
        return failures;
      });
      const reachability = await page.evaluate(() => {
        const failures = [];
        for (const card of document.querySelectorAll('main [role="tabpanel"]:not([hidden])')) {
          for (const control of card.querySelectorAll('h1,a[href],button,input,select,summary,.switch,.settings-row p')) {
            const closed = control.closest('details:not([open])');
            if (!control.getClientRects().length || control.closest('[hidden]') || closed && control !== closed.querySelector('summary')) continue;
            control.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            const box = control.getBoundingClientRect();
            if (box.top < -1 || box.bottom > innerHeight + 1 || box.left < -1 || box.right > innerWidth + 1) failures.push(`${control.id || control.tagName} outside viewport`);
            for (let parent = control.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
              if (!['auto','scroll','hidden','clip'].includes(getComputedStyle(parent).overflowY)) continue;
              const clip = parent.getBoundingClientRect();
              if (box.top < clip.top - 1 || box.bottom > clip.bottom + 1) failures.push(`${control.id || control.tagName} clipped by ${parent.id || parent.className} ${JSON.stringify({top:box.top,bottom:box.bottom,clipTop:clip.top,clipBottom:clip.bottom,scroll:parent.scrollTop,height:parent.clientHeight})}`);
            }
          }
          for (const scroller of [document.querySelector('main'), card, ...card.querySelectorAll('*')]) if (scroller.scrollTop) scroller.scrollTop = 0;
        }
        return failures;
      });
      assert.deepEqual(reachability, [], `${name}: G reachable controls and Settings text`);
      assert.ok(await page.locator("footer").evaluate(el => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), `${name}: footer inside viewport`);
      assert.deepEqual(geometry, [], `${name}: geometry`);
      await page.addScriptTag({ url: `${address}/axe.js` });
      const violations = await page.evaluate(async () => (await axe.run(document)).violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, [], `${name}: accessibility`);
      const expected = await page.locator("button:visible:enabled,input:visible:enabled,select:visible:enabled,summary:visible,[tabindex]:visible").evaluateAll(elements => elements.filter(el => el.tabIndex >= 0).map(el => el.id || el.tagName));
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      // A click on the non-focusable shell resets the sequential navigation starting point.
      await page.locator(".brand").click();
      const visited = [];
      for (let i = 0; i < expected.length; i++) {
        await page.keyboard.press("Tab");
        visited.push(await page.evaluate(() => document.activeElement.id || document.activeElement.tagName));
      }
      assert.deepEqual(visited, expected, `${name}: keyboard order`);
      // Reduce Motion turned on while the app is open: whatever was running must settle, and nothing may run forever.
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (scenario.name === 'audit-account-refusal-agents') {
        await page.waitForTimeout(350);
        const viewport = page.viewportSize();
        await page.setViewportSize({ width: viewport.width, height: Math.round(viewport.height * .7) });
        await page.waitForTimeout(40);
        const sizingAnimations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.target?.id === 'agent-list').map(a => a.transitionProperty || a.animationName));
        assert.deepEqual(sizingAnimations, [], `${name}: delayed resize has no agent sizing motion under reduce`);
      }
      // Turning reduced motion on restarts the short enter fade. One sample at 300ms races that restart.
      const reduced = await page.waitForFunction(() => {
        const running = document.getAnimations().filter(animation => animation.playState === "running").map(animation => {
          const timing = animation.effect?.getTiming?.() ?? {};
          return { target: animation.effect?.target?.id, name: animation.animationName || animation.transitionProperty, iterations: timing.iterations, duration: timing.duration };
        });
        const endless = running.filter(animation => animation.iterations === Infinity || animation.duration === Infinity);
        if (endless.length) return { endless, running };
        return running.length === 0 ? { endless, running } : false;
      }, null, { timeout: 2000, polling: 50 });
      const settled = await reduced.jsonValue();
      assert.deepEqual(settled.endless, [], `${name}: reduced motion`);
      assert.deepEqual(settled.running, [], `${name}: reduced motion`);
      // Reduce Motion already on when the app opens, as a person's setting usually is: every animation that starts only fades.
      // Both motion checks load a fresh window, because the MOTION capture above pauses and cancels this page's animations.
      if (reducedMotion === "no-preference") {
        const control = await normalRun(browser, address, nativeStub, scenario, { width, height: 660 }, theme);
        assert.equal(control.moving, control.shown, `${name}: spinner and progress bar animate in normal motion`);
        motion.normal += control.entries.length;
        motion.normalElements += control.shown;
        const fromLoad = await reducedRun(browser, address, nativeStub, scenario, { width, height: 660 }, theme);
        assert.deepEqual(reducedViolations(fromLoad.entries), [], `${name}: reduced motion only fades and never repeats`);
        motion.reduced += fromLoad.entries.length;
        motion.reducedStill += fromLoad.still;
      }
      count++;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed.push(name);
      console.error(`FAIL ${name}`, error);
    } finally { await context.close(); }
    }
  }
  console.log(`${count} screen renders passed. Screenshots: ${output}`);
  console.log(`Motion: normal ${motion.normal} animations (${motion.normalElements} spinner or progress bar shown); reduced ${motion.reduced} animations, ${motion.reducedStill} spinner or progress bar held still.`);
  assert.deepEqual(failed, [], "failed screen renders");
  if (motion.normalElements) assert.ok(motion.reducedStill > 0, "reduced motion: the spinner and progress bar shown in normal motion are present and still under reduce");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

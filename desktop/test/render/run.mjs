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
    await page.addInitScript(nativeStub, { loading: true });
    await page.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
      Object.defineProperty(document, "hidden", { get: () => true });
      // Emulate a hidden webview's suspended frame clock, not a foreground tab.
      window.requestAnimationFrame = () => 1;
      window.__paintStart = performance.now();
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "first_paint") window.__paintDelay = performance.now() - window.__paintStart;
        return invoke(command, args);
      };
    });
    await page.goto(address);
    await page.waitForFunction(() => window.__renderState.paintReports === 1, null, { polling: 5, timeout: 1000 });
    assert.equal(await page.evaluate(() => document.visibilityState), "hidden");
    assert.ok(await page.evaluate(() => window.__paintDelay < 100), "hidden page reports within 100 ms without a frame clock");
  } finally { await hidden.close(); }
  for (const theme of ["light"]) for (const width of [880, 560]) for (const scenario of cases) {
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
          const headerBottom = await page.locator(".sidebar").evaluate(el => el.getBoundingClientRect().bottom);
          assert.ok(top >= headerBottom, `${name}: centered card clears header at ${time}ms`);
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
        const colors = ["--paper", "--card", "--ink", "--ink-2", "--dim", "--faint", "--rule", "--blue", "--yellow", "--orange", "--green", "--green-ink", "--gold", "--gold-ink", "--red", "--red-ink", "--blue-ink", "--orange-ink", "--t-gold", "--t-teal", "--t-violet", "--t-blue", "--t-orange", "--t-green", "--t-red", "--on-ink", "--on-ink-dim"];
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
        return { title: style("#connection-title").fontFamily, body: style("body").fontFamily, code: style("#approval-code").fontFamily,
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
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr-only");
        for (const el of document.querySelectorAll("body *")) {
          if (!visible(el) || el instanceof SVGElement || !el.textContent?.trim()) continue;
          if (el.id === "machine-name" && getComputedStyle(el).textOverflow === "ellipsis") {
            if (el.title !== el.textContent) failures.push("truncated machine name lacks full title");
            const box = el.getBoundingClientRect();
            if (box.right > innerWidth || box.left < 0) failures.push("machine name outside viewport");
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
      const headerRows = await page.evaluate(() => {
        if (innerWidth > 460 || document.querySelector('#open-settings').hidden) return 0;
        const boxes = ['.brand', '.machine', '.status-pill', '#open-settings'].map(s => document.querySelector(s).getBoundingClientRect());
        boxes.sort((a,b) => a.top - b.top);
        let rows = 0, bottom = -Infinity;
        for (const box of boxes) { if (box.top >= bottom) { rows++; bottom = box.bottom; } else bottom = Math.min(bottom, box.bottom); }
        return rows;
      });
      assert.ok(headerRows <= 2, `${name}: header uses at most two rows (${headerRows})`);
      const primaryVisible = await page.evaluate(() => {
        const panel = document.querySelector('#connected-panel');
        const action = document.querySelector('#dashboard');
        if (panel.hidden || !action.getClientRects().length || action.hidden) return true;
        panel.scrollTop = 0;
        const card = panel.closest('.connection-card').getBoundingClientRect();
        const box = action.getBoundingClientRect();
        const thumb = document.querySelector('[data-scroll-thumb="connected-panel"]');
        return (box.top >= card.top && box.bottom <= card.bottom - 2) || !!(thumb && !thumb.hidden && thumb.getClientRects().length);
      });
      assert.ok(primaryVisible, `${name}: primary action visible at rest or panel overflow thumb visible`);
      const initialClips = await page.evaluate(() => {
        const failures = [];
        for (const card of document.querySelectorAll('.connection-card:has(#connected-panel:not([hidden])),#settings-panel:not([hidden])')) {
          const edge = card.getBoundingClientRect();
          for (const item of card.querySelectorAll('button,.switch,.agent-row,.settings-row p')) {
            if (!item.getClientRects().length || item.closest('[hidden]')) continue;
            const box = item.getBoundingClientRect();
            let top = box.top, bottom = box.bottom;
            for (let parent = item.parentElement; parent && parent !== card; parent = parent.parentElement) {
              if (['auto','scroll','hidden','clip'].includes(getComputedStyle(parent).overflowY)) { const bounds = parent.getBoundingClientRect(); top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
            }
            if (bottom <= top) continue;
            if (top < edge.bottom - 2 && bottom > edge.bottom - 2 && top >= edge.top) failures.push(`${item.id || item.className || item.tagName}: ${JSON.stringify({top,bottom,edge:edge.bottom,scroll:card.scrollTop,height:card.clientHeight,max:getComputedStyle(card).maxHeight,rules:document.adoptedStyleSheets.flatMap(s=>[...s.cssRules].map(r=>r.cssText)),parent:item.parentElement.outerHTML.slice(0,350)})}`);
          }
        }
        return failures;
      });
      assert.deepEqual(initialClips, [], `${name}: G initial card edge never slices content`);
      const reachability = await page.evaluate(() => {
        const failures = [];
        for (const card of document.querySelectorAll('.connection-card:has(#connected-panel:not([hidden])), #settings-panel:not([hidden])')) {
          for (const control of card.querySelectorAll('button,input,select,.switch,.settings-row p')) {
            if (!control.getClientRects().length || control.closest('[hidden]')) continue;
            control.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            const box = control.getBoundingClientRect();
            for (let parent = control.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
              if (!['auto','scroll','hidden','clip'].includes(getComputedStyle(parent).overflowY)) continue;
              const clip = parent.getBoundingClientRect();
              if (box.top < clip.top - 1 || box.bottom > clip.bottom + 1) failures.push(`${control.id || control.tagName} clipped by ${parent.id || parent.className} ${JSON.stringify({top:box.top,bottom:box.bottom,clipTop:clip.top,clipBottom:clip.bottom,scroll:parent.scrollTop,height:parent.clientHeight})}`);
            }
          }
          for (const scroller of [card, ...card.querySelectorAll('*')]) if (scroller.scrollTop) scroller.scrollTop = 0;
        }
        return failures;
      });
      assert.deepEqual(reachability, [], `${name}: G reachable controls and Settings text`);
      const layoutChecks = await page.evaluate(() => {
        const failures = { rows: [], thumbs: [], rhythm: [] };
        const visible = el => el && el.getClientRects().length && !el.closest("[hidden]");
        for (const selector of [".connected-spaces-scroll", "#agent-list", "#connected-panel", "#settings-panel"]) {
          const list = document.querySelector(selector);
          if (!visible(list)) continue;
          const box = list.getBoundingClientRect();
          const scrolling = list.scrollHeight > list.clientHeight + 1;
          const thumb = document.querySelector(`[data-scroll-thumb="${list.id || 'spaces'}"]`);
          if (scrolling !== !!visible(thumb)) failures.thumbs.push(`${selector}: scrolling=${scrolling}, thumb=${!!visible(thumb)}`);
          if (selector === "#agent-list" && list.children.length) {
            const height = list.clientHeight;
            if (Math.abs(height / 36 - Math.round(height / 36)) > .03) failures.rows.push(`agent list height ${height} is not whole rows`);
          }
          if (!list.children.length && parseFloat(getComputedStyle(list).borderBottomWidth)) failures.rhythm.push(`${selector}: empty list has rule`);
          if (box.height < 0) failures.rows.push(selector);
        }
        const spaces = document.querySelector(".connected-spaces-scroll");
        const agents = document.querySelector("#running-agents");
        const applications = document.querySelector("#applications-summary");
        if (visible(spaces) && visible(agents) && visible(applications) && applications.textContent.trim()) {
          const before = agents.getBoundingClientRect().top - spaces.getBoundingClientRect().bottom;
          const after = applications.getBoundingClientRect().top - agents.getBoundingClientRect().bottom;
          const note = document.querySelector("#dashboard-spaces-note");
          if (visible(note)) {
            const captionGap = note.getBoundingClientRect().top - spaces.getBoundingClientRect().bottom;
            if (Math.abs(captionGap - 4) > 1) failures.rhythm.push(`caption gap ${captionGap}, expected 4`);
          }
          const dashboard = document.querySelector('#dashboard');
          if (visible(dashboard) && !dashboard.hidden) {
            const actionGap = dashboard.getBoundingClientRect().top - applications.getBoundingClientRect().bottom;
            if (Math.abs(actionGap - 12) > 1) failures.rhythm.push(`action gap ${actionGap}, expected 12`);
          }
          if (!visible(note) && Math.abs(before - after) > 1) failures.rhythm.push(`section gaps ${before}/${after}`);
        }
        return failures;
      });
      for (const [check, failures] of Object.entries(layoutChecks)) assert.deepEqual(failures, [], `${name}: G ${check}`);
      if (await page.locator("#connected-panel").isVisible()) {
        const padding = await page.locator(".connection-card").evaluate(card => {
          const panel = card.querySelector("#connected-panel");
          const controls = [...panel.querySelectorAll("button,input,select,summary")].filter(el => el.getClientRects().length);
          const last = controls.at(-1);
          if (!last) return null;
          const style = getComputedStyle(card);
          const before = panel.scrollTop;
          panel.scrollTop = panel.scrollHeight;
          const remaining = card.getBoundingClientRect().bottom - parseFloat(style.borderBottomWidth) - last.getBoundingClientRect().bottom;
          panel.scrollTop = before;
          return { remaining, required: parseFloat(style.paddingBottom) };
        });
        assert.ok(!padding || padding.remaining >= padding.required - 1, `${name}: connected last control keeps card bottom padding ${JSON.stringify(padding)}`);
      }
      assert.ok(await page.locator("footer").evaluate(el => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), `${name}: footer inside viewport`);
      assert.deepEqual(geometry, [], `${name}: geometry`);
      await page.addScriptTag({ url: `${address}/axe.js` });
      const violations = await page.evaluate(async () => (await axe.run(document)).violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, [], `${name}: accessibility`);
      const expected = await page.locator("button:visible:enabled,input:visible:enabled,select:visible:enabled,summary:visible,[tabindex]:visible:not([tabindex='-1'])").evaluateAll(elements => elements.map(el => el.id || el.tagName));
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
      if (scenario.name === 'audit-account-refusal-agents') {
        await page.waitForTimeout(350);
        const viewport = page.viewportSize();
        await page.setViewportSize({ width: viewport.width, height: Math.round(viewport.height * .7) });
        await page.waitForTimeout(40);
        const sizingAnimations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.target?.id === 'agent-list').map(a => a.transitionProperty || a.animationName));
        assert.deepEqual(sizingAnimations, [], `${name}: delayed resize has no agent sizing motion under reduce`);
      }
      await page.waitForTimeout(300);
      const runningAnimations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running").map(a => ({ target: a.effect?.target?.id, name: a.animationName || a.transitionProperty })));
      assert.deepEqual(runningAnimations, [], `${name}: reduced motion`);
      count++;
      console.log(`PASS ${name}`);
    } finally { await context.close(); }
    }
  }
  console.log(`${count} screen renders passed. Screenshots: ${output}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

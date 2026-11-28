import assert from "node:assert/strict";

const panes = [
  ["connection", "#connection-title"],
  ["apps", "#apps-title"],
  ["settings", "#settings-title"],
];
const states = [
  ["welcome", "#sign-in-panel"],
  ["waiting", "#approval"],
  ["connecting", "#setup-progress"],
  ["ready", "#connected-panel"],
  ["offline", "#recovery-panel"],
];
const stableSurfaces = {
  welcome: { word: "Not set up", title: "Welcome to Cotal", tone: "waiting" },
  ready: { word: "Connected", title: "This computer is connected", tone: "ok", highlight: "connected" },
};

async function assertSurface(page, state) {
  const expected = stableSurfaces[state];
  if (!expected) return;
  assert.equal(await page.locator("#sidebar-status-word").textContent(), expected.word);
  assert.equal(await page.locator("#connection-title").textContent(), expected.title);
  assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), expected.tone);
  assert.deepEqual(await page.evaluate(() => window.__renderState.nativeConnection), { connected: expected.word === "Connected", label: expected.word });
  const highlight = page.locator("#connection-title .status-highlight");
  if (!expected.highlight) assert.equal(await highlight.count(), 0);
  else {
    assert.equal(await highlight.textContent(), expected.highlight);
    const underline = await highlight.evaluate(el => {
      const gold = getComputedStyle(el).getPropertyValue("--gold").trim();
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.fillStyle = gold;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return getComputedStyle(el).backgroundImage.includes(`rgb(${r}, ${g}, ${b})`);
    });
    assert.ok(underline, "status phrase uses the gold highlight token");
  }
}

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: expected ${expected}px, got ${actual}px`);
}

async function assertTopAligned(page, name, title) {
  const [sidebar, main, heading] = await Promise.all([
    page.locator(".sidebar").boundingBox(), page.locator("main").boundingBox(), title.boundingBox(),
  ]);
  const wide = page.viewportSize().width === 880;
  closeTo(heading.y, 30, `${name}: title top`);
  closeTo(sidebar.x, 0, `${name}: sidebar left`);
  closeTo(sidebar.width, wide ? 208 : 56, `${name}: sidebar width`);
  closeTo(main.x, sidebar.x + sidebar.width, `${name}: main beside sidebar`);
  closeTo(main.y, 0, `${name}: main top`);
  closeTo(heading.x, wide ? 244 : 76, `${name}: title left`);
  return heading.y;
}

async function assertPaneReachable(page, name) {
  const geometry = await page.locator("main").evaluate(main => {
    const box = main.getBoundingClientRect();
    const nav = document.querySelector(".sidebar");
    const before = nav.getBoundingClientRect();
    const initialScroll = main.scrollTop;
    const range = main.scrollHeight - main.clientHeight;
    main.scrollTop = main.scrollHeight;
    const endScroll = main.scrollTop;
    const after = nav.getBoundingClientRect();
    main.scrollTop = initialScroll;
    return { initialScroll, endScroll, range, overflowY: getComputedStyle(main).overflowY,
      right: box.right, horizontalOverflow: main.scrollWidth - main.clientWidth,
      viewport: innerWidth, navMoved: before.y !== after.y || before.x !== after.x };
  });
  assert.equal(geometry.initialScroll, 0, `${name}: pane enters at its top`);
  closeTo(geometry.right, geometry.viewport, `${name}: main ends at window edge`);
  assert.ok(geometry.horizontalOverflow <= 1, `${name}: no horizontal overflow`);
  assert.equal(geometry.navMoved, false, `${name}: scrolling keeps sidebar fixed`);
  if (geometry.range > 1) {
    assert.match(geometry.overflowY, /^(auto|scroll)$/, `${name}: user can scroll main`);
    closeTo(geometry.endScroll, geometry.range, `${name}: bottom of main reachable`);
  }
}

async function assertScrollAndReset(page, name) {
  const viewport = page.viewportSize();
  await page.setViewportSize({ ...viewport, height: 300 });
  try {
    const last = page.locator('#release-notes');
    await last.scrollIntoViewIfNeeded();
    const { didScroll, visible } = await last.evaluate(el => {
      const main = el.closest('main');
      const bounds = main.getBoundingClientRect();
      const row = el.getBoundingClientRect();
      return { didScroll: main.scrollTop > 0, visible: row.top >= bounds.top && row.bottom <= bounds.bottom };
    });
    assert.ok(didScroll && visible, `${name}: About action reached by scrolling main`);
    await page.click('#view-connection');
    await page.click('#view-settings');
    await assertTopAligned(page, `${name}: after scrolling and returning`, page.locator('#settings-title'));
  } finally {
    await page.setViewportSize(viewport);
  }
}

export function sidebarScenarios(fixtures) {
  return states.flatMap(([state, stage]) => panes.map(([pane, titleSelector]) => {
    const original = fixtures.find(fixture => fixture.name === state);
    assert.ok(original, `missing Connection fixture: ${state}`);
    const name = `sidebar-${state}-${pane}`;
    let connectionY;
    return {
      ...original, name, state: { ...original.state, aboutMachine: "Studio computer" },
      async act(page) {
        await original.act?.(page);
        await page.locator(`${stage}:visible`).waitFor();
        if (process.env.SIDEBAR_LEGACY_PADDING === "1") {
          await page.evaluate(() => {
            const sheet = [...document.styleSheets].find(sheet => sheet.href?.includes("/assets/"));
            sheet.insertRule("main { padding: 32px 0 0 !important; }", sheet.cssRules.length);
          });
        }
        connectionY = await assertTopAligned(page, `${name}: initial Connection`, page.locator("#connection-title"));
        if (pane !== "connection") await page.click(`#view-${pane}`);
        if (pane === "apps") await page.locator("#app-list .app-row").first().waitFor();
      },
      async expect(page) {
        const title = page.locator(titleSelector);
        assert.equal(await page.locator(`#view-${pane}`).getAttribute("aria-selected"), "true", name);
        assert.equal(await page.getByRole("tabpanel").count(), 1, `${name}: one active pane`);
        assert.equal(await page.locator("#journey").evaluate(el => el.closest("#connection-view") !== null), true, `${name}: journey belongs to Connection`);
        if (pane !== "connection") assert.equal(await page.locator("#journey").isVisible(), false, `${name}: no journey outside Connection`);
        const titleY = await assertTopAligned(page, name, title);
        closeTo(titleY, connectionY, `${name}: same title y as Connection`);
        await assertSurface(page, state);
        await assertPaneReachable(page, name);
        if (state === "ready" && pane === "settings") await assertScrollAndReset(page, name);
      },
    };
  }));
}

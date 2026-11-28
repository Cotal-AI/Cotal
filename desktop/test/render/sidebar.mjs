import assert from "node:assert/strict";

const panes = [
  ["connection", "#connection-title"],
  ["apps", "#apps-title"],
  ["settings", "#settings-title"],
];
const cloud = "https://cotal.cloud/api/auth";
const readyCloud = {
  signedInProviders: [cloud],
  catalogSpaces: [{ space: "acme-team", label: "Acme team", idp: cloud, mode: "user", catalogId: "sp_acme", kind: "team", role: "owner" }],
};
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

async function paneDescription(page, name, titleY) {
  const description = page.getByRole("tabpanel").locator(".pane-description:visible");
  assert.equal(await description.count(), 1, `${name}: one visible pane description`);
  assert.ok((await description.textContent()).trim(), `${name}: description is not empty`);
  const box = await description.boundingBox();
  assert.ok(box, `${name}: visible description has geometry`);
  closeTo(box.y - titleY, 39.2, `${name}: shared title-to-description offset`);
  return box;
}

async function assertFirstContent(page, name, pane, state, description) {
  const panel = page.getByRole("tabpanel");
  const selector = pane === "apps" ? "#apps-actions" : pane === "settings" ? "#computer-heading" : state === "ready" ? "#connected-actions" : undefined;
  const top = selector ? await panel.locator(selector).evaluate(el => {
    const bounds = el.getBoundingClientRect();
    return bounds.height ? bounds.top + parseFloat(getComputedStyle(el).paddingTop) : null;
  }) : await panel.locator(".pane-description").evaluate(el => {
    for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
      const bounds = next.getBoundingClientRect();
      if (bounds.height > 1 && getComputedStyle(next).visibility === "visible") return bounds.top;
    }
    return null;
  });
  assert.ok(top !== null, `${name}: first content is visible`);
  const gap = top - description.y - description.height;
  assert.ok(gap >= -1 && gap <= 24, `${name}: first content gap ${gap}px must be between 0 and 24px`);

  if (pane === "apps") {
    const refresh = panel.locator("#apps-actions #apps-refresh:visible");
    assert.equal(await refresh.count(), 1, `${name}: refresh is in the first action row`);
    assert.ok(await refresh.evaluate(el => {
      const style = getComputedStyle(el);
      return parseFloat(style.borderTopWidth) > 0 && style.borderTopColor !== "rgba(0, 0, 0, 0)";
    }), `${name}: refresh has an outline`);
    const [actions, heading, list, footnote] = await Promise.all(["#apps-actions", "#apps-group-heading", "#app-list", ".apps-footer"].map(id => panel.locator(id).boundingBox()));
    assert.ok(actions.y + actions.height <= heading.y + 1 && list.y + list.height <= footnote.y + 1, `${name}: Apps actions precede the list and the footnote follows it`);
  }
  if (pane === "connection" && state === "ready") {
    const actions = panel.locator("#connected-panel > #connected-actions:first-child");
    assert.equal(await actions.locator("#dashboard:visible, #another-space:visible").count(), 2, `${name}: both Connection actions follow the description`);
    const [row, heading] = await Promise.all([actions.boundingBox(), panel.locator("#spaces-heading").boundingBox()]);
    assert.ok(row.y + row.height <= heading.y + 1, `${name}: Connection actions precede Spaces`);
  }
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
    let connectionY, connectionDescriptionY;
    return {
      ...original, name, state: { ...original.state, aboutMachine: "Studio computer", ...(state === "ready" ? readyCloud : {}) },
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
        connectionDescriptionY = (await paneDescription(page, name, connectionY)).y;
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
        const description = await paneDescription(page, name, titleY);
        closeTo(description.y, connectionDescriptionY, `${name}: same description y as Connection`);
        await assertFirstContent(page, name, pane, state, description);
        await assertSurface(page, state);
        await assertPaneReachable(page, name);
        if (state === "ready" && pane === "settings") {
          assert.equal(await page.locator("#settings-spaces:visible").textContent(), "Signed in · 1 space");
          await assertScrollAndReset(page, name);
        }
      },
    };
  }));
}

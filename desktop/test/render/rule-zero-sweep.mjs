// Rule 0 render sweep: every state in desktop/test/rule-zero-cases.ts, rendered through the production
// renderer at both widths. Each one must show a title and, where the state has a fix, exactly one enabled
// action, and nothing a person reads may be terminal text, a web address or a file path. Status-field
// states also assert the shared word in the pill and the approved title.
//
// Run: pnpm --dir desktop build && node --import tsx desktop/test/render/rule-zero-sweep.mjs
// Narrow it with CASES=rule0-disk-full,rule0-code-CONFLICT (names below).
import assert from "node:assert/strict";
import { scenarios } from "./fixtures.mjs";
import { ADDRESS_TEXT, COMMAND_TEXT, REFUSAL_CODES, STATUS_FIELD_CASES } from "../rule-zero-cases.ts";

const visibleText = page => page.evaluate(() => {
  const read = id => document.getElementById(id)?.textContent ?? "";
  const rows = [...document.querySelectorAll('[data-testid="connected-space-row"]')].map(row => row.textContent ?? "").join("\n");
  return { title: read("connection-title"), description: read("connection-description"), details: read("refusal-detail"), rows, pill: read("sidebar-status-word") };
});
const enabledActions = page => page.evaluate(() => {
  const panel = document.getElementById("recovery-panel");
  if (!panel || panel.hidden) return [];
  return [...panel.querySelectorAll("button, a")].filter(el => !el.hidden && !el.disabled).map(el => el.textContent?.trim() ?? "");
});
const noTerminalOrAddress = (name, text) => {
  for (const [part, value] of Object.entries(text)) {
    if (part === "pill") continue;
    assert.doesNotMatch(value, COMMAND_TEXT, `${name}: ${part} carries terminal text`);
    assert.doesNotMatch(value, ADDRESS_TEXT, `${name}: ${part} names a web address or path`);
  }
};

// Codes whose single button the owner has named. NO_AVAILABLE_CONNECTOR (decided 2026-11-28): the
// window re-reads by itself when the person comes back from Agent apps, so there is no Check again.
const DECIDED_LABEL = { NO_AVAILABLE_CONNECTOR: "Set up agent apps" };

const refusalCases = Object.entries(REFUSAL_CODES).map(([code, action]) => ({
  name: `rule0-code-${code}`,
  // A bare NOT_RUNNING means nothing is set up yet, and the welcome steps show by design; its error
  // screen is the installed-but-stopped service, which the stub serves through serviceStopped.
  state: code === "NOT_RUNNING" ? { installed: true, serviceStopped: true } : { installed: true, offline: true, offlineCode: code },
  expect: async page => {
    const text = await visibleText(page);
    assert.ok(text.title.trim(), `${code}: the screen has a title`);
    const actions = await enabledActions(page);
    if (action === "none") assert.deepEqual(actions, [], `${code}: no button is offered`);
    else if (DECIDED_LABEL[code]) assert.deepEqual(actions, [DECIDED_LABEL[code]], `${code}: the one action`);
    else assert.equal(actions.length, 1, `${code}: exactly one enabled action, got ${JSON.stringify(actions)}`);
    noTerminalOrAddress(code, text);
  },
}));

const statusCases = STATUS_FIELD_CASES.map(item => ({
  name: `rule0-${item.name}`,
  state: item.state,
  expect: async page => {
    const text = await visibleText(page);
    console.log(`RULE0 ${item.name}: ${JSON.stringify({ pill: text.pill, title: text.title })}`);
    assert.equal(text.pill, item.word, `${item.name}: pill word`);
    assert.equal(text.title, item.title, `${item.name}: title`);
    const actions = await enabledActions(page);
    if (item.action) assert.deepEqual(actions, [item.action], `${item.name}: the one action`);
    noTerminalOrAddress(item.name, text);
  },
}));

scenarios.splice(0, scenarios.length, ...refusalCases, ...statusCases);
await import("./run.mjs");

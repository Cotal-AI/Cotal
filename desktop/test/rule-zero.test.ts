import { test } from "node:test";
import assert from "node:assert/strict";
import { refusalView, requireResult, DaemonRefusal } from "../src/model.ts";
import { COMMAND_TEXT, REFUSAL_CODES } from "./rule-zero-cases.ts";

/** Rule 0: every error screen offers one button that fixes the cause from inside the app, and a
 *  command line is never the only next step nor shown in Details. The table is shared with the render
 *  sweep; the window shows `native ?? code`. */
const expected = { ...REFUSAL_CODES, NO_AVAILABLE_CONNECTOR: "apps" };
const commandText = COMMAND_TEXT;

for (const [code, action] of Object.entries(expected)) {
  test(`rule 0: ${code} offers one ${action} action and no command line`, () => {
    const view = refusalView(code, ["Claude Code"]);
    assert.equal(view.action, action);
    if (action === "apps") assert.equal(view.label, "Set up agent apps");
    if (action === "none") assert.equal(view.label, "", "no button that cannot work");
    else assert.ok(view.label.trim(), "the screen has one labelled button");
    assert.doesNotMatch(view.title, commandText);
    assert.doesNotMatch(view.description, commandText);
  });
}

test("rule 0: an unknown code still gets Repair, never a status re-read", () => {
  const view = refusalView("SOMETHING_NEW");
  assert.equal(view.action, "repair");
  assert.ok(view.label.trim());
});

test("rule 0: Details never carries a command line from a daemon remedy", () => {
  const remedies = [
    "run setup from /Applications/Cotal.app/Contents/Resources/runtime/dist/cotal.js",
    "run `cotal daemon uninstall` then setup from /usr/lib/node_modules/cotal-ai/dist/cotal.js",
    "inspect `cotal daemon status --space team`; restore its connection, then run `cotal daemon setup --space team`",
    "remove it with `cotal daemon uninstall`, enable linger with loginctl enable-linger ada and run this again",
  ];
  for (const remedy of remedies) {
    let refusal: unknown;
    try { requireResult({ v: 1, event: "result", ok: false, error: { code: "CONFLICT", message: "the background service was set up by another Cotal installation, so this one cannot refresh it", remedy } }); }
    catch (error) { refusal = error; }
    assert.ok(refusal instanceof DaemonRefusal);
    assert.doesNotMatch(refusal.message, commandText, remedy);
    assert.doesNotMatch(refusal.message, /\/(?:Applications|usr)\//, remedy);
  }
  // Some daemon messages embed the command themselves (bin/daemon/install.ts:381, :283).
  for (const message of [
    "linger could not be enabled for ada, so the recorded unit was not enabled or started. Remove it with `cotal daemon uninstall`, enable linger with loginctl enable-linger ada and run this again",
    "the daemon service has an unfinished repair; run `cotal daemon status` to finish it",
  ]) {
    let refusal: unknown;
    try { requireResult({ v: 1, event: "result", ok: false, error: { code: "PERMISSION_DENIED", message } }); }
    catch (error) { refusal = error; }
    assert.ok(refusal instanceof DaemonRefusal);
    assert.doesNotMatch(refusal.message, commandText, message);
  }
});

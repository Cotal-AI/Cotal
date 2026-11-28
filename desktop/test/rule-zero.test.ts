import { test } from "node:test";
import assert from "node:assert/strict";
import { refusalView, requireResult, DaemonRefusal } from "../src/model.ts";

/** Rule 0: every error screen offers one button that fixes the cause from inside the app, and a
 *  command line is never the only next step nor shown in Details. Each code below is one the app's
 *  daemon bridge or the window itself can raise; the window shows `native ?? code`. */
const expected: Record<string, "repair" | "login" | "install" | "connect" | "spaces" | "refresh" | "installer"> = {
  // The service belongs to another installation, answers without a unit, or cannot be verified.
  CONFLICT: "repair", RUNNING_WITHOUT_UNIT: "repair", LOCK_HELD: "repair", PEER_NOT_LOCK_OWNER: "repair", PEER_UID_MISMATCH: "repair",
  // The service was started and does not answer, stopped mid-operation, or its native state is unknown.
  NOT_ANSWERING: "repair", DAEMON_LOST: "repair", OPERATION_UNKNOWN: "repair", TARGET_UNAVAILABLE: "repair", TARGET_NOT_FOUND: "repair",
  // Generic failures the catch-all used to answer with a status re-read.
  OPERATION_FAILED: "repair", OPERATION_PARTIAL: "repair", DEPENDENCY_UNAVAILABLE: "repair", LIFECYCLE_BLOCKED: "repair",
  MANAGER_UNAVAILABLE: "repair", GENERATION_PENDING: "repair", PERMISSION_DENIED: "repair", NO_RUNTIME_DIR: "repair",
  UNSUPPORTED_PLATFORM: "repair", UNSUPPORTED: "repair", USAGE_INVALID: "repair", BAD_REQUEST: "repair",
  // Causes with their own working fix.
  NOT_RUNNING: "install", DENIED: "login", EXPIRED: "login", CREDENTIAL_EXPIRED: "login", AUTH_REQUIRED: "login", NOT_SIGNED_IN: "login",
  NO_AVAILABLE_CONNECTOR: "connect", SEATS_ACTIVE: "connect", VERSION_MISMATCH: "connect", NO_SPACES: "spaces",
  // Waiting on someone or something outside this computer; checking again is the fix.
  APPROVAL_PENDING: "refresh", UNREACHABLE: "refresh",
  // This copy of the app is incomplete; only its installer can fix it.
  SETUP_INTERRUPTED: "installer",
};

const commandText = /`|\bcotal\s|systemctl|loginctl|launchctl|schtasks/;

for (const [code, action] of Object.entries(expected)) {
  test(`rule 0: ${code} offers one ${action} action and no command line`, () => {
    const view = refusalView(code, ["Claude Code"]);
    assert.equal(view.action, action);
    assert.ok(view.label.trim(), "the screen has one labelled button");
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

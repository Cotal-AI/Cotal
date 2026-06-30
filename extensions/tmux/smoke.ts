/**
 * E2E smoke test for @cotal-ai/tmux.
 * Run from the repo root: pnpm exec tsx extensions/tmux/smoke.ts
 * Uses a real tmux session; cleans up on pass or fail.
 */
import * as tmux from "./src/driver.js";
import { TmuxRuntime, tmuxRuntimeProvider, tmuxTerminalProvider } from "./src/runtime.js";
import { registry } from "@cotal-ai/core";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const SESSION = "cotal-tmux-smoke";
let passed = 0;
let failed = 0;

function ok(label: string, val: unknown) {
  if (val) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function throws(label: string, fn: () => unknown) {
  try {
    fn();
    console.error(`  ✗ FAIL: ${label} — expected throw, got none`);
    failed++;
  } catch {
    console.log(`  ✓ ${label}`);
    passed++;
  }
}

function cleanup() {
  try {
    execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
  } catch { /* already gone */ }
}

// Needs a real tmux. Skip cleanly where it isn't installed (local `pnpm check` on a tmux-less box);
// CI installs tmux explicitly so this runs there.
if (!tmux.available()) {
  console.log("• tmux extension smoke skipped — tmux not installed (install tmux to run it)");
  process.exit(0);
}

cleanup(); // start fresh

console.log("\n── driver ──────────────────────────────────────");

ok("available() returns true", tmux.available());

console.log(`\n── session: ${SESSION} ──────────────────────────`);
tmux.ensureSession(SESSION, "/tmp");
// This throwaway session is never attached. `window-size manual` makes tmux honor the session's
// explicit -x/-y size with no client, so headless `split-window` doesn't fail "size missing" on CI.
// (Production per-space sessions keep the default `latest` so they resize to the user on attach.)
execFileSync("tmux", ["set-option", "-t", SESSION, "window-size", "manual"], { stdio: "ignore" });
ok("ensureSession creates session", true);

// openWindow returns stable IDs (window @N + initial pane %N), not session:name
const { windowId, paneId } = tmux.openWindow(SESSION, "test-win", "sleep 10", "/tmp", { focus: false });
ok(`openWindow returns a window ID (starts with @)`, windowId.startsWith("@"));
ok(`openWindow returns an initial pane ID (starts with %)`, paneId.startsWith("%"));
ok("windowAliveRef returns true for the open window ID", tmux.windowAliveRef(windowId));
ok("windowAlive returns true for open window", tmux.windowAlive(SESSION, "test-win"));

// listWindows / windowRefs
const wins = tmux.listWindows(SESSION);
ok("listWindows includes test-win", wins.includes("test-win"));

const refs = tmux.windowRefs(SESSION, "test-win");
ok("windowRefs returns one entry", refs.length >= 1);
ok("windowRefs entry starts with @", refs[0]!.startsWith("@"));

// send / sendKey
tmux.send("echo hello", `${SESSION}:test-win`);
tmux.sendKey("Enter", `${SESSION}:test-win`);
ok("send + sendKey don't throw", true);

// closeWindow by stable ID
tmux.closeWindow(windowId);
ok("windowAliveRef returns false after closeWindow", !tmux.windowAliveRef(windowId));
ok("windowAlive returns false after closeWindow", !tmux.windowAlive(SESSION, "test-win"));

// idempotent close
tmux.closeWindow(windowId);
ok("closeWindow is idempotent (no throw on already-gone)", true);

console.log("\n── layout: stable %pane ids under pane-base-index 1 ──");

// Reproduce the config that broke the old `<win>.0`/`.1` confirm targeting: panes display from 1,
// not 0. Stable %pane ids are config-independent, so the layout path must key off them. Scope the
// option to THIS throwaway window (`-w`), never the user's global tmux server.
const lay = tmux.openWindow(SESSION, "lay-win", "sleep 30", "/tmp", { focus: false });
execFileSync("tmux", ["set-option", "-w", "-t", lay.windowId, "pane-base-index", "1"], { stdio: "ignore" });
// Headless/CI: no client means split-window can't size the new pane ("size missing"). Force a
// concrete window size first (window-size manual, set above, lets the resize stick).
try {
  execFileSync("tmux", ["resize-window", "-t", lay.windowId, "-x", "200", "-y", "50"], { stdio: "ignore" });
} catch { /* older tmux without resize-window -x/-y */ }
const secondPane = tmux.splitWindow(lay.windowId, "sleep 30", "/tmp", "vertical", 0.34);
ok("splitWindow returns a new %pane id", secondPane.startsWith("%"));
ok("first + second pane ids differ", lay.paneId !== secondPane);

const paneIdx = execFileSync("tmux", ["list-panes", "-t", lay.windowId, "-F", "#{pane_index}"], { encoding: "utf8" })
  .split("\n").map((l) => l.trim()).filter(Boolean);
ok("pane display indexes honor pane-base-index 1 (no '.0')", !paneIdx.includes("0"));

// The fix: confirm-Enter targets the stable %ids and lands on both panes…
tmux.sendKey("Enter", lay.paneId);
tmux.sendKey("Enter", secondPane);
ok("sendKey to both %pane ids succeeds (the confirm path)", true);

// …whereas the OLD `<session>:<win>.0` index target is invalid here (the reported hang).
throws("old `<win>.0` index target is invalid under pane-base-index 1", () =>
  execFileSync("tmux", ["send-keys", "-t", `${SESSION}:lay-win.0`, "--", "Enter"], { stdio: "pipe" }));

tmux.closeWindow(lay.windowId);
ok("layout window closes by stable id", !tmux.windowAliveRef(lay.windowId));

console.log("\n── regression: numeric session name (#131) ──────");

// A default `tmux new` session is named "0". `new-window -t` takes a target-*window*, so a bare
// numeric name was read as window-index 0 → "create window failed: index 0 in use"; openWindow now
// targets the session (`-t "0:"`). A numeric session shares the default tmux server, so guard the
// user's real session "0": skip if one already exists (never touch it), and only kill the one we make.
const NUMERIC = "0";
const numericPreexists = (() => {
  try { execFileSync("tmux", ["has-session", "-t", NUMERIC], { stdio: "ignore" }); return true; }
  catch { return false; }
})();
if (numericPreexists) {
  console.log(`  • skipped — a tmux session named "${NUMERIC}" already exists (won't touch it)`);
} else {
  tmux.ensureSession(NUMERIC, "/tmp");
  let numWinId: string | undefined;
  try {
    numWinId = tmux.openWindow(NUMERIC, "num-regression", "sleep 10", "/tmp", { focus: false }).windowId;
  } catch { /* pre-fix bug: `new-window -t 0` → "index 0 in use" */ }
  ok("openWindow opens a window in a numeric-named session (pre-fix: 'index 0 in use')",
    numWinId?.startsWith("@") ?? false);
  if (numWinId) tmux.closeWindow(numWinId);
  try { execFileSync("tmux", ["kill-session", "-t", NUMERIC], { stdio: "ignore" }); } catch { /* gone */ }
}

console.log("\n── runtime ─────────────────────────────────────");

const runtime = new TmuxRuntime(SESSION);
const SECRET_CANARY = "leak-canary-tmux-DO-NOT-LEAK";
const handle = runtime.spawn("smoke-agent", {
  command: "sleep",
  args: ["30"],
  env: { TEST_VAR: "hello", COTAL_CONTROL_TOKEN: SECRET_CANARY },
}, "/tmp");
ok(`handle.name = "smoke-agent"`, handle.name === "smoke-agent");
ok(`handle.kind = "tmux"`, handle.kind === "tmux");
ok("handle.status() = running", handle.status() === "running");
ok("window alive after spawn", tmux.windowAlive(SESSION, "smoke-agent"));

// E2E no-leak: the LIVE pane's start command must NOT contain the secret env VALUE — it rides the
// 0o600 launcher script (privateLaunch), so tmux only ever sees `bash <path>`. This fails on the old
// inline-`env -i KEY='value'` path (the canary would appear in pane_start_command).
const paneStartCmd = execFileSync(
  "tmux",
  ["list-panes", "-t", `${SESSION}:smoke-agent`, "-F", "#{pane_start_command}"],
  { encoding: "utf8" },
);
ok("live tmux pane command is `bash <script>` (not inline env)", paneStartCmd.includes("bash "));
ok("live tmux pane command does NOT leak the env secret", !paneStartCmd.includes(SECRET_CANARY));

handle.interrupt();
ok("interrupt() doesn't throw", true);

throws("attach() throws", () => handle.attach());

handle.stop({ graceful: false });
await new Promise(r => setTimeout(r, 200));
ok("window gone after hard stop", !tmux.windowAlive(SESSION, "smoke-agent"));
ok("handle.status() = exited after stop (id-based, survives rename)", handle.status() === "exited");

console.log("\n── registry registration ────────────────────────");

const resolvedRuntime = registry.resolve("runtime", "tmux");
ok("tmuxRuntimeProvider registered as 'runtime/tmux'", resolvedRuntime != null);
ok("tmuxRuntimeProvider.available() returns true", tmuxRuntimeProvider.available());

const resolvedTerminal = registry.resolve("terminal", "tmux");
ok("tmuxTerminalProvider registered as 'terminal/tmux'", resolvedTerminal != null);
ok("tmuxTerminalProvider.available() returns true", tmuxTerminalProvider.available());

// refs() throws when not in tmux (no $TMUX env)
throws("refs() throws when not in tmux", () => tmuxTerminalProvider.refs("anything"));

console.log("\n── command builders ─────────────────────────────");

const isolated = tmux.isolatedCommand({ FOO: "bar baz", X: "1" }, "/usr/bin/env", ["sh"]);
ok("isolatedCommand starts with 'env -i'", isolated.startsWith("env -i"));
ok("isolatedCommand contains FOO=", isolated.includes("FOO="));
ok("isolatedCommand contains quoted command", isolated.includes("'/usr/bin/env'"));

const merged = tmux.mergedCommand({ FOO: "bar" }, "echo", ["hello"]);
ok("mergedCommand starts with 'env'", merged.startsWith("env"));
ok("mergedCommand does NOT contain '-i'", !merged.includes("env -i"));

// privateLaunch keeps secret env VALUES off tmux's command line: the rendered body (with the secret)
// goes into an owner-only (0o600) launcher script, and tmux only ever sees `bash <path>`.
const secretBody = tmux.isolatedCommand({ COTAL_CONTROL_TOKEN: "s3cr3t-token" }, "/bin/echo", ["hi"]);
const launch = tmux.privateLaunch(secretBody);
const launchPath = launch.replace(/^bash\s+'?|'?$/g, ""); // strip `bash '` … `'`
ok("privateLaunch returns a `bash <path>` invocation", launch.startsWith("bash ") && launchPath.endsWith(".sh"));
ok("privateLaunch does NOT leak the secret into the returned command", !launch.includes("s3cr3t-token"));
ok("privateLaunch script is 0o600 (owner-only)", (statSync(launchPath).mode & 0o777) === 0o600);
ok("privateLaunch script contains the secret body (read from the file, not argv)", readFileSync(launchPath, "utf8").includes("s3cr3t-token"));

console.log("\n────────────────────────────────────────────────");
console.log(`\n${passed} passed, ${failed} failed\n`);

cleanup();

if (failed > 0) process.exit(1);

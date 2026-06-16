/**
 * Issue #34 regression: a managed (pty) Claude session hangs at "starting…" on Claude Code
 * ≥ 2.1.178 because startup now shows TWO back-to-back "Enter to confirm" screens (workspace
 * trust, then the dev-channels warning) and the old one-shot auto-confirm cleared only the first.
 *
 * This drives the REAL PtyRuntime with the connector's LaunchSpec against a real `claude`, in a
 * fresh (untrusted) workspace so both prompts appear, and asserts the session gets past them to
 * the live UI instead of stalling on the channels warning.
 *
 * Run: COTAL_TEST_CLAUDE_BIN=/path/to/claude-2.1.178 pnpm smoke:channels
 * Skips cleanly if no claude binary is available (e.g. CI without auth).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyRuntime } from "./src/runtime/pty.js";

const claudeBin = process.env.COTAL_TEST_CLAUDE_BIN ?? "claude";
const probe = spawnSync(claudeBin, ["--version"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.log(`SKIP channels-confirm smoke — no runnable claude at "${claudeBin}"`);
  process.exit(0);
}
console.log(`claude: ${probe.stdout.trim()}`);

const strip = (s: string): string =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");

// Mirrors the claude connector's launch recipe (origin/main): the dev-channels flag (which on a
// fresh workspace triggers trust + warning prompts) and the confirm token the runtime auto-clears.
const spec = {
  command: claudeBin,
  args: ["--dangerously-load-development-channels", "plugin:cotal@cotal-mesh"],
  env: { COTAL_SPACE: "smoke34", COTAL_NAME: "smoke34", COTAL_CHANNEL: "1" },
  confirm: "Enter to confirm",
};
const cwd = mkdtempSync(join(tmpdir(), "cotal-ch34-")); // fresh dir ⇒ untrusted ⇒ trust prompt fires

const handle = new PtyRuntime().spawn("smoke34", spec, cwd);
let out = "";
const att = handle.attach();
att.onData((b) => (out += b.toString("utf8")));

// TUIs position text with cursor moves, so once ANSI is stripped the words run together
// ("auto mode on" → "automodeon"). Match against a whitespace-collapsed view, like the runtime does.
const flat = (s: string): string => strip(s).replace(/\s+/g, "");
const STARTED = /automode|foragents|esctointerrupt/i; // only present once the live UI is up
const BLOCKED = /Loadingdevelopmentchannels/i; // the warning screen we must get past

await new Promise((r) => setTimeout(r, 18_000));
const tail = strip(out).replace(/\n{2,}/g, "\n").slice(-700);
handle.stop({ graceful: false });

const started = STARTED.test(flat(out));
const stuck = BLOCKED.test(flat(out.slice(-4000))); // still showing the warning at the end = stalled
if (started && !stuck) {
  console.log("✓ session cleared both startup prompts and reached the live UI");
  console.log(`\nchannels-confirm smoke: passed`);
  process.exit(0);
}
console.error("✗ session did not reach the live UI past the startup prompts");
console.error(`started=${started} stuckOnWarning=${stuck}`);
console.error("--- final screen tail ---\n" + tail);
process.exit(1);

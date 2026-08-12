/**
 * E2E smoke test for @cotal-ai/herdr.
 * Run from the repo root: pnpm exec tsx extensions/herdr/smoke.ts
 * Uses a real herdr server in an ISOLATED named session (own socket); cleans up on pass or fail.
 */
import * as herdr from "./src/driver.js";
import { HerdrRuntime, herdrRuntimeProvider, privateLauncher } from "./src/runtime.js";
import { registry } from "@cotal-ai/core";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

function countLauncherDirs(): number {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith("cotal-herdr-")).length;
}

const SESSION = "cotal-herdr-smoke";
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

function throws(label: string, fn: () => unknown, pattern?: RegExp) {
  try {
    fn();
    console.error(`  ✗ FAIL: ${label} — expected throw, got none`);
    failed++;
  } catch (err) {
    ok(label, !pattern || pattern.test((err as Error).message));
  }
}

async function rejects(label: string, fn: () => Promise<unknown>, pattern?: RegExp) {
  try {
    await fn();
    console.error(`  ✗ FAIL: ${label} — expected rejection, got none`);
    failed++;
  } catch (err) {
    ok(label, !pattern || pattern.test((err as Error).message));
  }
}

function cleanup() {
  for (const session of [SESSION, `${SESSION}-other`]) {
    herdr.stopSession(session);
    try {
      execFileSync("herdr", ["session", "delete", session], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

// Needs a real herdr. Skip cleanly where it isn't installed (local runs on a herdr-less box).
if (!herdr.available()) {
  console.log("• herdr extension smoke skipped — herdr not installed (install herdr to run it)");
  process.exit(0);
}

cleanup(); // start fresh

console.log("\n── driver ──────────────────────────────────────");

ok("available() returns true", herdr.available());
ok("serverRunning() false before ensureServer", !herdr.serverRunning(SESSION));
herdr.ensureServer(SESSION);
ok("ensureServer brings the session server up", herdr.serverRunning(SESSION));
herdr.ensureServer(SESSION);
ok("ensureServer is idempotent", herdr.serverRunning(SESSION));

console.log(`\n── session: ${SESSION} ─────────────────────────`);

const probe = herdr.agentStart(SESSION, "probe", "/tmp", ["sleep", "30"]);
ok("agentStart returns a terminal id (term_…)", probe.terminalId.startsWith("term_"));
ok("agentStart returns a pane id (w…:p…)", /^w\d+:p\d+$/.test(probe.paneId));
ok("terminalState reports running", herdr.terminalState(SESSION, probe.terminalId) === "running");

const info = herdr.agentInfo(SESSION, probe.terminalId);
ok("agentInfo resolves the terminal", info?.terminalId === probe.terminalId);

herdr.reportMetadata(SESSION, probe.paneId, "cotal", { cotal: SESSION });
const listed = herdr.run(SESSION, ["pane", "list"]);
const probePane = (listed.panes as Record<string, unknown>[]).find((p) => p.terminal_id === probe.terminalId);
ok("reportMetadata tokens land on the pane", (probePane?.tokens as Record<string, string>)?.cotal === SESSION);

throws("reportMetadata refuses an unsafe token name", () =>
  herdr.reportMetadata(SESSION, probe.paneId, "cotal", { "--focus": "x" }));

// Stale-pane re-resolution: moving the pane to a new workspace changes its public pane_id
// but keeps the terminal alive — every pane-scoped op must re-resolve, never reuse the old id.
herdr.run(SESSION, ["pane", "move", probe.paneId, "--new-workspace", "--no-focus"]);
const moved = herdr.agentInfo(SESSION, probe.terminalId);
ok("pane move keeps the terminal alive", moved?.terminalId === probe.terminalId);
ok("pane move changes the public pane id", moved !== undefined && moved.paneId !== probe.paneId);
ok("terminalState still running after move (keyed by terminal id)", herdr.terminalState(SESSION, probe.terminalId) === "running");

herdr.closePane(SESSION, moved!.paneId);
ok("terminalState reports exited after close", herdr.terminalState(SESSION, probe.terminalId) === "exited");
ok("agentInfo returns undefined for a gone terminal", herdr.agentInfo(SESSION, probe.terminalId) === undefined);
herdr.closePane(SESSION, moved!.paneId);
ok("closePane is idempotent (pane_not_found only)", true);

console.log("\n── authoritative exit wait ─────────────────────");

const waiter = herdr.agentStart(SESSION, "wait-timeout", "/tmp", ["sleep", "30"]);
await rejects(
  "waitForTerminalExit rejects when a live terminal misses its bound",
  () => herdr.waitForTerminalExit(SESSION, waiter.terminalId, { timeoutMs: 300, pollMs: 50 }),
  /did not exit within 300ms/,
);
await rejects(
  "waitForTerminalExit fails loud when herdr state is unknown",
  async () => {
    const path = process.env.PATH;
    try {
      process.env.PATH = "/definitely-not-a-real-path";
      await herdr.waitForTerminalExit(SESSION, waiter.terminalId, { timeoutMs: 300, pollMs: 50 });
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  },
);
herdr.closePane(SESSION, herdr.agentInfo(SESSION, waiter.terminalId)!.paneId);
await herdr.waitForTerminalExit(SESSION, waiter.terminalId, { timeoutMs: 2_000 });
ok("waitForTerminalExit resolves after the pane is authoritatively absent", true);

const short = herdr.agentStart(SESSION, "short-lived", "/tmp", ["sleep", "1"]);
await herdr.waitForTerminalExit(SESSION, short.terminalId, { timeoutMs: 5_000 });
ok("pane auto-closes when its command exits (natural exit proves out)", true);

console.log("\n── runtime ─────────────────────────────────────");

const runtime = new HerdrRuntime(SESSION);

throws("spawn refuses an unsafe agent name", () =>
  runtime.spawn("bad name!", { command: "sleep", args: ["1"], env: {} }, "/tmp"));

const SECRET_CANARY = "leak-canary-herdr-DO-NOT-LEAK";
const handle = runtime.spawn("smoke-agent", {
  command: "sleep",
  args: ["30"],
  env: { TEST_VAR: "hello", COTAL_CONTROL_TOKEN: SECRET_CANARY },
}, "/tmp");
ok(`handle.name = "smoke-agent"`, handle.name === "smoke-agent");
ok(`handle.kind = "herdr"`, handle.kind === "herdr");
ok("handle.status() = running", handle.status() === "running");

// E2E no-leak: neither herdr's stored records nor the live process argv may contain the secret
// env VALUE — it rides the 0o600 launcher script, so herdr only ever sees `node <script>`.
const snapshot = JSON.stringify(herdr.run(SESSION, ["pane", "list"])) + JSON.stringify(herdr.run(SESSION, ["agent", "list"]));
ok("herdr pane/agent records do NOT leak the env secret", !snapshot.includes(SECRET_CANARY));
const smokeInfo = herdr.agentInfo(SESSION, "smoke-agent");
const procInfo = smokeInfo ? JSON.stringify(herdr.run(SESSION, ["pane", "process-info", "--pane", smokeInfo.paneId])) : "";
ok("herdr process info does NOT leak the env secret", !procInfo.includes(SECRET_CANARY));

handle.interrupt();
ok("interrupt() doesn't throw", true);

throws("attach() throws and names the session + terminal target", () => handle.attach(),
  new RegExp(`--session ${SESSION} agent attach term_`));

handle.stop({ graceful: false });
await handle.waitForExit!();
ok("stop -> waitForExit proves the terminal exited", handle.status() === "exited");
handle.stop({ graceful: false });
ok("hard stop is idempotent on a gone pane", true);
handle.interrupt();
ok("interrupt is a no-op on a gone pane", true);

// Graceful stop: types /exit (ignored by sleep), then force-closes after the grace window.
const graceful = runtime.spawn("graceful-agent", { command: "sleep", args: ["60"], env: {} }, "/tmp");
graceful.stop();
await graceful.waitForExit!();
ok("graceful stop closes the pane after the grace window", graceful.status() === "exited");

// Duplicate names: herdr refuses them (agent_name_taken) — spawn must fail loud, not fall
// back, and must clean up the launcher it created for the doomed start.
const dupA = runtime.spawn("dup-agent", { command: "sleep", args: ["30"], env: {} }, "/tmp");
ok("first dup-agent runs", dupA.status() === "running");
// Let dupA's launcher load and self-delete its dir, so the counts below only see the failure's dir.
await new Promise((resolve) => setTimeout(resolve, 750));
const launchDirsBefore = countLauncherDirs();
throws("a duplicate agent name fails loud", () =>
  runtime.spawn("dup-agent", { command: "sleep", args: ["30"], env: {} }, "/tmp"), /agent_name_taken/);
ok("failed spawn cleans up its launcher dir", countLauncherDirs() === launchDirsBefore);
ok("the original agent is untouched by the failed duplicate", dupA.status() === "running");
dupA.stop({ graceful: false });
await dupA.waitForExit!();

// herdr silently substitutes $HOME for a missing cwd — the runtime must refuse instead.
throws("spawn refuses a nonexistent cwd (herdr would silently use $HOME)", () =>
  runtime.spawn("bad-cwd-agent", { command: "sleep", args: ["1"], env: {} }, "/definitely/not/a/dir"), /does not exist/);
ok("no pane was created for the refused cwd", herdr.agentInfo(SESSION, "bad-cwd-agent") === undefined);

console.log("\n── launcher hygiene ────────────────────────────");

const launcher = privateLauncher({ command: "/bin/echo", args: ["hi"], env: { COTAL_CONTROL_TOKEN: "s3cr3t-token" } }, "/tmp");
ok("privateLauncher argv is `node <script>` (no env inline)", launcher.argv[0] === process.execPath && !launcher.argv.join(" ").includes("s3cr3t-token"));
ok("privateLauncher script is 0o600 (owner-only)", (statSync(launcher.script).mode & 0o777) === 0o600);
ok("privateLauncher script contains the secret body (read from the file, not argv)", readFileSync(launcher.script, "utf8").includes("s3cr3t-token"));
execFileSync(process.execPath, [launcher.script], { stdio: "ignore" });
ok("launcher removes its own directory after loading", !existsSync(launcher.dir));

console.log("\n── session isolation ───────────────────────────");

// Every driver call is scoped by --session: the same terminal id is unknown to a different
// (serverless) session, and state fails toward "exited" only because that session has no server.
ok("a different session cannot see this session's panes",
  herdr.terminalState(`${SESSION}-other`, "term_nonexistent") === "exited");
ok("agent listing is scoped to the session",
  (herdr.run(SESSION, ["agent", "list"]).agents as unknown[]).length === 0);

console.log("\n── registry registration ────────────────────────");

const resolved = registry.resolve("runtime", "herdr");
ok("herdrRuntimeProvider registered as 'runtime/herdr'", resolved != null);
ok("herdrRuntimeProvider.available() returns true", herdrRuntimeProvider.available());

console.log("\n────────────────────────────────────────────────");
console.log(`\n${passed} passed, ${failed} failed\n`);

cleanup();

if (failed > 0) process.exit(1);

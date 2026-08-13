/**
 * E2E smoke test for @cotal-ai/herdr.
 * Run from the repo root: pnpm exec tsx extensions/herdr/smoke.ts
 * Uses a real herdr server in an ISOLATED named session (own socket); cleans up on pass or fail.
 */
import * as herdr from "./src/driver.js";
import { HerdrRuntime, herdrRuntimeProvider, privateLauncher } from "./src/runtime.js";
import { registry } from "@cotal-ai/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// herdr silently substitutes $HOME for a bad cwd — the runtime must refuse instead, and a
// regular file is just as bad (the launcher would die invisibly at chdir).
throws("spawn refuses a nonexistent cwd (herdr would silently use $HOME)", () =>
  runtime.spawn("bad-cwd-agent", { command: "sleep", args: ["1"], env: {} }, "/definitely/not/a/dir"), /is not a directory/);
throws("spawn refuses a regular file as cwd", () =>
  runtime.spawn("bad-cwd-agent", { command: "sleep", args: ["1"], env: {} }, "/etc/hosts"), /is not a directory/);
ok("no pane was created for the refused cwd", herdr.agentInfo(SESSION, "bad-cwd-agent") === undefined);

console.log("\n── layout ──────────────────────────────────────");

// Default: every agent gets its own name-labeled tab. COTAL_HERDR_LAYOUT=split opts back into
// herdr's native same-tab split; an unknown value fails loud before any side effects.
const tabOf = (name: string): string =>
  ((herdr.run(SESSION, ["agent", "get", name]).agent as Record<string, unknown>).tab_id as string);
const layoutA = runtime.spawn("layout-a", { command: "sleep", args: ["30"], env: {} }, "/tmp");
const layoutB = runtime.spawn("layout-b", { command: "sleep", args: ["30"], env: {} }, "/tmp");
ok("by default each agent lands in its own tab", tabOf("layout-a") !== tabOf("layout-b"));
const tabs = herdr.run(SESSION, ["tab", "list"]).tabs as Record<string, unknown>[];
ok("agent tabs are labeled with the agent name",
  tabs.some((t) => t.label === "layout-a") && tabs.some((t) => t.label === "layout-b"));

process.env.COTAL_HERDR_LAYOUT = "split";
const layoutC = runtime.spawn("layout-c", { command: "sleep", args: ["30"], env: {} }, "/tmp");
const layoutD = runtime.spawn("layout-d", { command: "sleep", args: ["30"], env: {} }, "/tmp");
ok("COTAL_HERDR_LAYOUT=split shares one tab", tabOf("layout-c") === tabOf("layout-d"));

process.env.COTAL_HERDR_LAYOUT = "bogus";
throws("an unknown COTAL_HERDR_LAYOUT fails loud (nothing spawned)", () =>
  runtime.spawn("layout-e", { command: "sleep", args: ["30"], env: {} }, "/tmp"), /COTAL_HERDR_LAYOUT/);
ok("no pane was created for the refused layout", herdr.agentInfo(SESSION, "layout-e") === undefined);
delete process.env.COTAL_HERDR_LAYOUT;

for (const h of [layoutA, layoutB, layoutC, layoutD]) {
  h.stop({ graceful: false });
  await h.waitForExit!();
}
ok("layout agents torn down", herdr.agentInfo(SESSION, "layout-a") === undefined);

console.log("\n── launcher hygiene ────────────────────────────");

const launcher = privateLauncher({ command: "/bin/echo", args: ["hi"], env: { COTAL_CONTROL_TOKEN: "s3cr3t-token" } }, "/tmp");
ok("privateLauncher argv is `node <script>` (no env inline)", launcher.argv[0] === process.execPath && !launcher.argv.join(" ").includes("s3cr3t-token"));
ok("privateLauncher script is 0o600 (owner-only)", (statSync(launcher.script).mode & 0o777) === 0o600);
ok("privateLauncher script contains the secret body (read from the file, not argv)", readFileSync(launcher.script, "utf8").includes("s3cr3t-token"));
execFileSync(process.execPath, [launcher.script], { stdio: "ignore" });
ok("launcher removes its own directory after loading", !existsSync(launcher.dir));

console.log("\n── error classification ────────────────────────");

// The gone-terminal idempotency exception is exactly one structured code; every other
// not-found (or unstructured error) must propagate.
ok("isAgentGone accepts agent_not_found", herdr.isAgentGone(new herdr.HerdrCliError("agent_not_found", "x")));
ok("isAgentGone rejects workspace_not_found", !herdr.isAgentGone(new herdr.HerdrCliError("workspace_not_found", "x")));
ok("isAgentGone rejects session_not_found", !herdr.isAgentGone(new herdr.HerdrCliError("session_not_found", "x")));
ok("isAgentGone rejects pane_not_found (agent get never returns it for a terminal target)",
  !herdr.isAgentGone(new herdr.HerdrCliError("pane_not_found", "x")));
ok("isAgentGone rejects unstructured errors", !herdr.isAgentGone(new Error("agent_not_found")));

console.log("\n── server provisioning failure ─────────────────");

// Deterministic ensureServer failure: a fake `herdr` on PATH whose `server` subcommand dies
// with a diagnostic on stderr. ensureServer must detect the dead child (not wait out the full
// window) and surface the server's own words.
const fakeDir = mkdtempSync(join(tmpdir(), "cotal-herdr-fakebin-"));
writeFileSync(
  join(fakeDir, "herdr"),
  `#!/bin/sh\n` +
    `[ "$1" = "--version" ] && { echo "herdr 0.0.0-fake"; exit 0; }\n` +
    `[ "$3" = "status" ] && { echo "status: not running"; exit 0; }\n` +
    `[ "$3" = "server" ] && { echo "fake: Operation not permitted" >&2; exit 1; }\n` +
    `exit 1\n`,
  { mode: 0o755 },
);
{
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${realPath}`;
  const started = Date.now();
  try {
    throws("ensureServer surfaces the dead server's stderr", () =>
      herdr.ensureServer("cotal-herdr-fake"), /failed to start.*Operation not permitted/);
  } finally {
    process.env.PATH = realPath;
  }
  ok("dead server child is detected early, not waited out", Date.now() - started < 3_000);
}

// No-`ps` path (Windows, ps-less containers): a failed `ps` proves NOTHING, so a dead child
// must never be misread as dead early — ensureServer waits out the bounded window and still
// fails loud with the captured stderr. PATH holds ONLY the fake bin dir: `herdr` resolves,
// `ps` cannot (the fake script's `#!/bin/sh` shebang is PATH-independent).
{
  const realPath = process.env.PATH;
  process.env.PATH = fakeDir;
  const started = Date.now();
  try {
    throws("without ps, a dead start still fails loud with the server's stderr", () =>
      herdr.ensureServer("cotal-herdr-fake2"), /did not come up.*Operation not permitted/);
  } finally {
    process.env.PATH = realPath;
    rmSync(fakeDir, { recursive: true, force: true });
  }
  ok("without ps, death is never assumed — the full window is waited out", Date.now() - started >= 4_500);
}

console.log("\n── session isolation ───────────────────────────");

// Every driver call is scoped by --session: a different session has no server behind its
// socket, so it can neither see this session's panes nor prove anything — it fails closed.
throws("a serverless session cannot prove terminal state (fails closed)", () =>
  herdr.terminalState(`${SESSION}-other`, "term_nonexistent"), /couldn't prove/);
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

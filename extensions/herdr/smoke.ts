/**
 * E2E smoke test for @cotal-ai/herdr.
 * Run from the repo root: pnpm exec tsx extensions/herdr/smoke.ts
 * Uses a real herdr server in ISOLATED named sessions (own sockets).
 *
 * Teardown is registered BEFORE the first session is created and runs on every exit path —
 * normal end, assertion failure, uncaught throw, or signal. An earlier revision called cleanup()
 * only at the bottom of the file, so any throw leaked a live herdr server; that is the single
 * most important structural property of this file.
 */
import * as herdr from "./src/driver.js";
import { HerdrRuntime, herdrRuntimeProvider, privateLauncher } from "./src/runtime.js";
import { registry } from "@cotal-ai/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION = "cotal-herdr-smoke";
const OTHER = `${SESSION}-other`;
const PEER = `${SESSION}-peer`;

/** Every session this run may have created, recorded at declaration so teardown never has to
 *  re-derive or pattern-match its targets. */
const OWNED_SESSIONS = [SESSION, OTHER, PEER, `${SESSION}-fake`, `${SESSION}-fake2`, `${SESSION}-leak`];
/** Scratch dirs recorded as they are created, so teardown removes exactly these. */
const OWNED_DIRS: string[] = [];

let passed = 0;
let failed = 0;
/** Cells whose absence should be visible: a suite that silently skips a section reports the same
 *  green as one that proved everything, so the count is asserted against an expected floor. */
const EXPECTED_MIN_CELLS = 96;

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
    const msg = (err as Error).message;
    if (pattern && !pattern.test(msg)) {
      console.error(`  ✗ FAIL: ${label} — threw, but message did not match ${pattern}: ${msg}`);
      failed++;
    } else {
      ok(label, true);
    }
  }
}

async function rejects(label: string, fn: () => Promise<unknown>, pattern?: RegExp) {
  try {
    await fn();
    console.error(`  ✗ FAIL: ${label} — expected rejection, got none`);
    failed++;
  } catch (err) {
    const msg = (err as Error).message;
    if (pattern && !pattern.test(msg)) {
      console.error(`  ✗ FAIL: ${label} — rejected, but message did not match ${pattern}: ${msg}`);
      failed++;
    } else {
      ok(label, true);
    }
  }
}

/** Count ONLY launcher dirs. The prefix is deliberately the full `cotal-herdr-launch-`: a
 *  `cotal-herdr-` glob also matches this suite's own srv-/proxybin-/fakebin- scratch, so the
 *  measurement would be wider than the claim it makes. */
function countLauncherDirs(): number {
  return readdirSync(tmpdir()).filter((e) => e.startsWith("cotal-herdr-launch-")).length;
}

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  OWNED_DIRS.push(dir);
  return dir;
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // Each step independently guarded: a throw in one must not strand the rest. A finalizer that
  // fails open is worse than none, because the suite still prints its verdict.
  for (const session of OWNED_SESSIONS) {
    try {
      herdr.stopSession(session);
    } catch {
      /* not running */
    }
    try {
      execFileSync("herdr", ["session", "delete", session], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  for (const dir of OWNED_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// Registered BEFORE anything is created, so no exit path can skip it.
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}
process.on("uncaughtException", (err) => {
  console.error("\n✗ UNCAUGHT:", err);
  cleanup();
  process.exit(1);
});

// Needs a real, CURRENT herdr. Skip cleanly where it isn't installed — but say so loudly enough
// that a skip is never mistaken for a pass in a CI log.
if (!herdr.available()) {
  const found = herdr.versionText();
  console.log(
    `• herdr extension smoke SKIPPED — needs herdr >= ${herdr.MIN_HERDR.join(".")}` +
      (found ? ` (found "${found}")` : " (herdr not on PATH)"),
  );
  console.log("  NOTE: this suite proves nothing when skipped. CI must install herdr for it to gate anything.");
  process.exit(0);
}

cleanup(); // start fresh
cleaned = false; // ...and re-arm for the real teardown

console.log("\n── version floor ───────────────────────────────");

ok("parseVersion reads a herdr version banner", JSON.stringify(herdr.parseVersion("herdr 0.8.0")) === "[0,8,0]");
ok("parseVersion returns undefined for unparseable output", herdr.parseVersion("herdr incompatible") === undefined);
ok("available() is true for the installed herdr", herdr.available());
{
  // A binary-only probe reported 0.7.x as usable, so `cotal runtimes` advertised the runtime as
  // ready and every spawn then died on `unknown option: --cwd`. available() must read the VERSION.
  const oldDir = scratch("cotal-herdr-oldbin-");
  writeFileSync(join(oldDir, "herdr"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "herdr 0.7.4"; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const unparsableDir = scratch("cotal-herdr-badbin-");
  writeFileSync(join(unparsableDir, "herdr"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "herdr incompatible"; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const realPath = process.env.PATH;
  try {
    process.env.PATH = oldDir;
    ok("available() is FALSE for herdr 0.7.4 (the version this driver cannot drive)", !herdr.available());
    ok("versionText surfaces what was actually found", herdr.versionText() === "herdr 0.7.4");
    process.env.PATH = unparsableDir;
    ok("available() is FALSE when the version cannot be parsed (uncertainty ≠ ready)", !herdr.available());
    process.env.PATH = "/definitely-not-a-real-path";
    ok("available() is FALSE when herdr is absent entirely", !herdr.available());
    ok("versionText is empty when herdr is absent", herdr.versionText() === "");
  } finally {
    process.env.PATH = realPath;
  }
}

console.log("\n── shell quoting ───────────────────────────────");

// `pane run` hands its argument to the pane's SHELL — the one place in this driver where a value
// is not argv. Anything unquoted here is a word-splitting or substitution bug.
ok("shellQuote wraps a plain word", herdr.shellQuote("abc") === "'abc'");
ok("shellQuote neutralises spaces", herdr.shellQuote("a b") === "'a b'");
ok("shellQuote escapes embedded single quotes", herdr.shellQuote("it's") === `'it'\\''s'`);
ok("shellQuote neutralises $(…) substitution", herdr.shellQuote("$(touch /tmp/pwn)").startsWith("'$("));
{
  // Prove it by execution, not by inspection: a path containing a space, a quote and a $ must
  // survive the shell intact.
  const nasty = scratch("cotal-herdr-nasty-");
  const dir = join(nasty, `we ird's $dir`);
  execFileSync("mkdir", ["-p", dir]);
  const marker = join(dir, "ran.txt");
  // ONE level of shell interpretation, exactly as `pane run` performs it. `touch` is resolved
  // through PATH: it lives in /usr/bin on macOS and /bin on many Linuxes.
  // Caught, not bare: a broken shellQuote must redden THIS named cell rather than crash the run.
  try {
    execFileSync("sh", ["-c", `touch ${herdr.shellQuote(marker)}`], { stdio: "ignore" });
  } catch {
    /* the assertion below reports it */
  }
  ok("a quoted path with space/quote/$ survives a real shell", existsSync(marker));
  // And the same string unquoted must NOT produce the file — otherwise the cell above would pass
  // even if shellQuote returned its input unchanged.
  const naive = join(dir, "naive.txt");
  try {
    execFileSync("sh", ["-c", `touch ${naive}`], { stdio: "ignore" });
  } catch {
    /* expected: word-splits into several bogus paths */
  }
  ok("negative control: the unquoted path does NOT create the file", !existsSync(naive));
}

// ── the process-info shape differs BY PLATFORM ────────────────────────────────
// These two payloads are real `pane process-info` output captured from herdr 0.8.0. macOS carries
// `argv0`; Linux does not carry it at all. The driver used to read `argv0` alone, so readiness
// matched on macOS and never on Linux — the runtime could not start a single agent there, and a
// macOS-only test run reported 87/87 green while doing it.
//
// Both shapes are asserted on EVERY platform precisely because a live run only ever exercises the
// local one. That is the regression this section exists to prevent.
console.log("\n── process-info shape (both platforms) ─────────");
{
  const MACOS = { argv0: "node", argv: ["/opt/homebrew/bin/node", "launch.mjs"], name: "node", pid: 4242 };
  const LINUX = { argv: ["sleep", "30"], cmdline: "sleep 30", name: "sleep", pid: 834047 };
  const LINUX_NODE = { argv: ["/usr/bin/node", "launch.mjs"], cmdline: "/usr/bin/node launch.mjs", name: "node", pid: 99 };

  ok("macOS shape: matches via argv0", herdr.processIsCommand(MACOS, "node"));
  ok("macOS shape: matches an absolute interpreter path by basename",
    herdr.processIsCommand(MACOS, "/usr/local/bin/node"));
  ok("LINUX shape (no argv0 key at all): still matches via argv[0]", herdr.processIsCommand(LINUX, "sleep"));
  ok("LINUX shape: an absolute argv[0] matches a bare command by basename",
    herdr.processIsCommand(LINUX_NODE, "node"));
  ok("LINUX shape: matches when the caller passes process.execPath",
    herdr.processIsCommand(LINUX_NODE, "/some/other/prefix/bin/node"));

  ok("negative: a different command does NOT match", !herdr.processIsCommand(LINUX, "node"));
  ok("negative: the truncated/versioned `name` field is NOT used to match",
    !herdr.processIsCommand({ name: "node", pid: 1 }, "node"));
  ok("negative: a record with no usable name matches nothing", !herdr.processIsCommand({ pid: 1 }, "node"));
  ok("negative: a non-object matches nothing",
    !herdr.processIsCommand(null, "node") && !herdr.processIsCommand("node", "node"));
  ok("processNames prefers argv0 then argv[0]",
    JSON.stringify(herdr.processNames(MACOS)) === JSON.stringify(["node", "/opt/homebrew/bin/node"]));
  ok("processNames on the Linux shape yields argv[0] alone",
    JSON.stringify(herdr.processNames(LINUX)) === JSON.stringify(["sleep"]));
}

console.log("\n── driver ──────────────────────────────────────");

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
ok("agentInfo resolves the terminal", herdr.agentInfo(SESSION, probe.terminalId)?.terminalId === probe.terminalId);
{
  // agentStart's readiness wait must prove the PROCESS started, not merely that `pane run`
  // accepted the keystrokes — a shell that ate the command would otherwise read as a live agent.
  const fg = herdr.foregroundProcesses(SESSION, probe.paneId);
  ok("the requested command is actually the pane's foreground process",
    fg.some((p) => herdr.processIsCommand(p, "sleep")));
  ok("foregroundPid resolves the started process's pid on THIS platform",
    (herdr.foregroundPid(SESSION, probe.paneId, "sleep") ?? 0) > 0,
    JSON.stringify(fg));
}
{
  // Each agent lands in its own workspace, so the cwd is honoured per agent.
  const info = herdr.run(SESSION, ["pane", "process-info", "--pane", probe.paneId]);
  const cwd = (info.process_info as Record<string, unknown>).pane_id ? true : false;
  ok("process-info resolves for the started pane", cwd);
}

herdr.reportMetadata(SESSION, probe.paneId, "cotal", { cotal: SESSION });
const probePane = (herdr.run(SESSION, ["pane", "list"]).panes as Record<string, unknown>[])
  .find((p) => p.terminal_id === probe.terminalId);
ok("reportMetadata tokens land on the pane", (probePane?.tokens as Record<string, string>)?.cotal === SESSION);
throws("reportMetadata refuses an unsafe token name", () =>
  herdr.reportMetadata(SESSION, probe.paneId, "cotal", { "--focus": "x" }));

// Stale-pane re-resolution: moving the pane to a new workspace changes its public pane_id but
// keeps the terminal alive — every pane-scoped op must re-resolve, never reuse the old id.
herdr.run(SESSION, ["pane", "move", probe.paneId, "--new-workspace", "--no-focus"]);
const moved = herdr.agentInfo(SESSION, probe.terminalId);
ok("pane move keeps the terminal alive", moved?.terminalId === probe.terminalId);
ok("pane move changes the public pane id", moved !== undefined && moved.paneId !== probe.paneId);
ok("agentInfo finds a pane that moved workspaces (inventory is session-wide)", moved !== undefined);
ok("terminalState still running after move (keyed by terminal id)", herdr.terminalState(SESSION, probe.terminalId) === "running");

herdr.closePane(SESSION, moved!.paneId);
ok("terminalState reports exited after close", herdr.terminalState(SESSION, probe.terminalId) === "exited");
ok("agentInfo returns undefined for a gone terminal", herdr.agentInfo(SESSION, probe.terminalId) === undefined);
herdr.closePane(SESSION, moved!.paneId);
ok("closePane is idempotent (pane_not_found only)", true);

console.log("\n── exec semantics (the exit proof rests on this) ─");

{
  // A plain `pane run` leaves the pane's SHELL alive after the command exits, so the pane would
  // outlive the agent and no exit could ever be proven. agentStart exec's for exactly this reason.
  // The wait is caught rather than awaited bare: dropping the `exec` must redden THIS named cell,
  // not crash the run — a mutation that kills the harness reports that something died, not what.
  const shortLived = herdr.agentStart(SESSION, "exec-proof", "/tmp", ["sleep", "1"]);
  let exited = false;
  try {
    await herdr.waitForTerminalExit(SESSION, shortLived.terminalId, { timeoutMs: 10_000 });
    exited = herdr.terminalState(SESSION, shortLived.terminalId) === "exited";
  } catch {
    exited = false; // the shell outlived the command: the pane never closed
  }
  ok("pane closes when its command exits (exec replaced the shell)", exited);
  if (!exited) {
    try {
      herdr.closePane(SESSION, herdr.agentInfo(SESSION, shortLived.terminalId)!.paneId);
    } catch {
      /* best effort so the rest of the suite still runs */
    }
  }
}

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
throws(
  "agentInfo also fails loud on an unreachable herdr (uncertainty is never 'gone')",
  () => {
    const path = process.env.PATH;
    try {
      process.env.PATH = "/definitely-not-a-real-path";
      return herdr.agentInfo(SESSION, waiter.terminalId);
    } finally {
      process.env.PATH = path;
    }
  },
);
herdr.closePane(SESSION, herdr.agentInfo(SESSION, waiter.terminalId)!.paneId);
await herdr.waitForTerminalExit(SESSION, waiter.terminalId, { timeoutMs: 5_000 });
ok("waitForTerminalExit resolves after the pane is authoritatively absent", true);

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

// E2E no-leak: neither herdr's stored records, its live snapshot, nor the pane's own scrollback
// may contain the secret env VALUE — it rides the 0600 launcher, so herdr only sees `node <script>`.
const snapshot = JSON.stringify(herdr.run(SESSION, ["pane", "list"])) + JSON.stringify(herdr.run(SESSION, ["agent", "list"]));
ok("herdr pane/agent records do NOT leak the env secret", !snapshot.includes(SECRET_CANARY));
const smokeInfo = herdr.agentInfo(SESSION, handle.name === "smoke-agent" ? (handle as unknown as { terminalId?: string }).terminalId ?? "" : "");
const livePane = (herdr.run(SESSION, ["pane", "list"]).panes as Record<string, unknown>[])
  .find((p) => (p.tokens as Record<string, string> | undefined)?.cotal === SESSION && p.pane_id !== undefined);
const procInfo = livePane
  ? JSON.stringify(herdr.run(SESSION, ["pane", "process-info", "--pane", livePane.pane_id as string]))
  : "";
ok("herdr process info does NOT leak the env secret", procInfo !== "" && !procInfo.includes(SECRET_CANARY));
ok("the launcher argv herdr sees is `node <script>` only", procInfo.includes("node") || procInfo.includes(".mjs"));
{
  // Scrollback is the leak channel herdr's own `--env KEY=VALUE` would have used (verified: an
  // `--env` value shows up verbatim in `pane read`). Prove the launcher keeps it clean, with a
  // positive control first so an empty read cannot pass silently.
  // `pane read` emits raw terminal text, not the JSON envelope every other command uses.
  const read = execFileSync("herdr", ["--session", SESSION, "pane", "read", livePane!.pane_id as string], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  ok("positive control: pane read returns the launcher command line", read.includes("launch.mjs"));
  ok("pane scrollback does NOT contain the env secret", !read.includes(SECRET_CANARY));
}
void smokeInfo;

handle.interrupt();
ok("interrupt() doesn't throw", true);

throws("attach() throws and names the session target", () => handle.attach(),
  new RegExp(`herdr session attach ${SESSION}`));

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

// Duplicate labels are allowed by herdr workspaces, but a failed spawn must still clean up.
const dupA = runtime.spawn("dup-agent", { command: "sleep", args: ["30"], env: {} }, "/tmp");
ok("first dup-agent runs", dupA.status() === "running");
dupA.stop({ graceful: false });
await dupA.waitForExit!();

// herdr silently substitutes $HOME for a bad cwd — the runtime must refuse instead, and a
// regular file is just as bad (the launcher would die invisibly at chdir).
{
  const before = countLauncherDirs();
  throws("spawn refuses a nonexistent cwd (herdr would silently use $HOME)", () =>
    runtime.spawn("bad-cwd-agent", { command: "sleep", args: ["1"], env: {} }, "/definitely/not/a/dir"), /is not a directory/);
  throws("spawn refuses a regular file as cwd", () =>
    runtime.spawn("bad-cwd-agent", { command: "sleep", args: ["1"], env: {} }, "/etc/hosts"), /is not a directory/);
  ok("a cwd-refused spawn creates no launcher dir at all", countLauncherDirs() === before);
}

console.log("\n── spawn readiness fails loud ──────────────────");
{
  // The readiness wait's contract is about the argv handed to herdr: it turns "keystrokes
  // delivered" into "that process is running". Exercised at the driver level with an argv0 the
  // shell cannot exec at all, which is deterministic.
  //
  // Deliberately NOT tested through runtime.spawn with a bogus spec.command: there the argv IS the
  // launcher (`node <script>`), which starts fine and only then fails to exec the inner command —
  // so whether readiness observes a live `node` first is a race with how fast the launcher dies.
  // That version of this cell passed or failed depending on machine load.
  const panesBefore = (herdr.run(SESSION, ["pane", "list"]).panes as unknown[]).length;
  throws("agentStart fails loud when its argv can never start", () =>
    herdr.agentStart(SESSION, "never-starts", "/tmp", ["/definitely/not/an/executable"]),
    /exited immediately|did not start/);
  ok("a failed start leaves no pane behind",
    (herdr.run(SESSION, ["pane", "list"]).panes as unknown[]).length === panesBefore);
}
{
  // Launcher cleanup on the runtime's own failure path, driven by a cause that cannot race:
  // a refused cwd throws before any launcher is written at all.
  const before = countLauncherDirs();
  throws("a refused spawn throws before writing a launcher", () =>
    runtime.spawn("no-launcher", { command: "sleep", args: ["1"], env: {} }, "/definitely/not/a/dir"),
    /is not a directory/);
  ok("a refused spawn leaves no launcher dir", countLauncherDirs() === before);
}

console.log("\n── layout ──────────────────────────────────────");

// AgentHandle deliberately does not expose herdr's terminal id, so identify each spawned agent by
// diffing the pane inventory around the spawn. Positional guessing (`.at(-1)`) is wrong here:
// `split` MOVES a pane, which reorders the list.
const terminalIds = (): Set<string> =>
  new Set((herdr.run(SESSION, ["pane", "list"]).panes as Record<string, unknown>[]).map((p) => p.terminal_id as string));
function spawnTracked(name: string): { handle: ReturnType<typeof runtime.spawn>; terminalId: string } {
  const before = terminalIds();
  const handle = runtime.spawn(name, { command: "sleep", args: ["30"], env: {} }, "/tmp");
  const added = [...terminalIds()].filter((t) => !before.has(t));
  if (added.length !== 1) throw new Error(`smoke: expected exactly 1 new terminal for ${name}, got ${added.length}`);
  return { handle, terminalId: added[0]! };
}
const tabOfTerminal = (terminalId: string): string | undefined =>
  (herdr.run(SESSION, ["pane", "list"]).panes as Record<string, unknown>[])
    .find((p) => p.terminal_id === terminalId)?.tab_id as string | undefined;

const a = spawnTracked("layout-a");
const b = spawnTracked("layout-b");
ok("by default each agent lands in its own tab", tabOfTerminal(a.terminalId) !== tabOfTerminal(b.terminalId));
{
  // The tab strip is what an operator reads; `workspace create --label` names only the workspace,
  // so agentStart renames the tab explicitly. Without that every agent shows as a bare number.
  const tabs = herdr.run(SESSION, ["tab", "list"]).tabs as Record<string, unknown>[];
  ok("agent tabs are labeled with the agent name",
    tabs.some((t) => t.label === "layout-a") && tabs.some((t) => t.label === "layout-b"));
}

process.env.COTAL_HERDR_LAYOUT = "split";
const c = spawnTracked("layout-c");
const cTab = tabOfTerminal(c.terminalId);
ok("COTAL_HERDR_LAYOUT=split folds the agent into a pre-existing tab",
  cTab !== undefined && (cTab === tabOfTerminal(a.terminalId) || cTab === tabOfTerminal(b.terminalId)));
ok("split does not create a tab of its own",
  (herdr.run(SESSION, ["tab", "list"]).tabs as unknown[]).length === 2);
const layoutA = a.handle, layoutB = b.handle, layoutC = c.handle;

process.env.COTAL_HERDR_LAYOUT = "bogus";
{
  const panesBefore = (herdr.run(SESSION, ["pane", "list"]).panes as unknown[]).length;
  throws("an unknown COTAL_HERDR_LAYOUT fails loud", () =>
    runtime.spawn("layout-e", { command: "sleep", args: ["30"], env: {} }, "/tmp"), /COTAL_HERDR_LAYOUT/);
  ok("nothing was spawned for the refused layout",
    (herdr.run(SESSION, ["pane", "list"]).panes as unknown[]).length === panesBefore);
}
delete process.env.COTAL_HERDR_LAYOUT;

for (const h of [layoutA, layoutB, layoutC]) {
  h.stop({ graceful: false });
  await h.waitForExit!();
}
ok("layout agents torn down", true);

console.log("\n── launcher hygiene ────────────────────────────");

const launcher = privateLauncher({ command: "/bin/echo", args: ["hi"], env: { COTAL_CONTROL_TOKEN: "s3cr3t-token" } }, "/tmp");
ok("privateLauncher argv is `node <script>` (no env inline)", launcher.argv[0] === process.execPath && !launcher.argv.join(" ").includes("s3cr3t-token"));
ok("privateLauncher script is 0o600 (owner-only)", (statSync(launcher.script).mode & 0o777) === 0o600);
ok("privateLauncher dir is 0o700 (owner-only)", (statSync(launcher.dir).mode & 0o777) === 0o700);
ok("privateLauncher script contains the secret body (read from the file, not argv)", readFileSync(launcher.script, "utf8").includes("s3cr3t-token"));
execFileSync(process.execPath, [launcher.script], { stdio: "ignore" });
ok("launcher removes its own directory after loading", !existsSync(launcher.dir));

console.log("\n── result/error precedence ─────────────────────");
{
  // A response carrying a RESULT succeeded, whatever else it printed. parseError scans EVERY
  // line, so checking errors first meant one informational JSON line (a deprecation notice)
  // failed a command that actually worked — the result line was never reached.
  const warnDir = scratch("cotal-herdr-warnbin-");
  writeFileSync(
    join(warnDir, "herdr"),
    `#!/bin/sh\n` +
      `[ "$1" = "--version" ] && { echo "herdr 0.8.0"; exit 0; }\n` +
      `echo '{"error":{"code":"deprecation_warning","message":"informational only"}}'\n` +
      `echo '{"id":"x","result":{"panes":[],"type":"pane_list"}}'\n` +
      `exit 0\n`,
    { mode: 0o755 },
  );
  const realPath = process.env.PATH;
  try {
    process.env.PATH = `${warnDir}:${realPath}`;
    let out: Record<string, unknown> | undefined;
    try {
      out = herdr.run("precedence-probe", ["pane", "list"]);
    } catch {
      out = undefined;
    }
    ok("an informational error line does NOT fail a command that returned a result",
      out !== undefined && Array.isArray((out as Record<string, unknown>).panes));
  } finally {
    process.env.PATH = realPath;
  }
}
{
  // The converse must still hold: an error with NO result present still throws.
  const errDir = scratch("cotal-herdr-errbin-");
  writeFileSync(
    join(errDir, "herdr"),
    `#!/bin/sh\n` +
      `[ "$1" = "--version" ] && { echo "herdr 0.8.0"; exit 0; }\n` +
      `echo '{"error":{"code":"pane_not_found","message":"nope"}}'\n` +
      `exit 0\n`,
    { mode: 0o755 },
  );
  const realPath = process.env.PATH;
  try {
    process.env.PATH = `${errDir}:${realPath}`;
    throws("an error with no result still throws", () => herdr.run("precedence-probe", ["pane", "list"]),
      /pane_not_found/);
  } finally {
    process.env.PATH = realPath;
  }
}

console.log("\n── stopSession error classification ────────────");

ok("stopSession absorbs 'not running' (the desired end state)", (() => {
  try {
    herdr.stopSession(`${SESSION}-never-existed`);
    return true;
  } catch {
    return false;
  }
})());
{
  // Every OTHER structured error must propagate. A teardown that cannot report failure is worse
  // than none, because it reports success either way.
  const denyDir = scratch("cotal-herdr-denybin-");
  writeFileSync(
    join(denyDir, "herdr"),
    `#!/bin/sh\n` +
      `[ "$1" = "--version" ] && { echo "herdr 0.8.0"; exit 0; }\n` +
      `echo '{"error":{"code":"permission_denied","message":"nope"}}'\n` +
      `exit 23\n`,
    { mode: 0o755 },
  );
  const realPath = process.env.PATH;
  try {
    process.env.PATH = `${denyDir}:${realPath}`;
    throws("stopSession propagates permission_denied instead of swallowing it",
      () => herdr.stopSession("whatever"), /permission_denied/);
  } finally {
    process.env.PATH = realPath;
  }
}

console.log("\n── server provisioning failure ─────────────────");

const fakeDir = scratch("cotal-herdr-fakebin-");
writeFileSync(
  join(fakeDir, "herdr"),
  `#!/bin/sh\n` +
    `[ "$1" = "--version" ] && { echo "herdr 0.8.0"; exit 0; }\n` +
    `[ "$3" = "status" ] && { echo "status: not running"; exit 0; }\n` +
    `[ "$3" = "server" ] && { echo "fake: Operation not permitted" >&2; exit 1; }\n` +
    `exit 1\n`,
  { mode: 0o755 },
);
{
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${realPath}`;
  try {
    throws("ensureServer surfaces the dead server's stderr", () =>
      herdr.ensureServer(`${SESSION}-fake`), /failed to start.*Operation not permitted/);
  } finally {
    process.env.PATH = realPath;
  }
}

// No-`ps` path (Windows, ps-less containers): a failed `ps` proves NOTHING, so a dead child must
// never be misread as dead early — ensureServer waits out the bounded window and still fails loud.
{
  const realPath = process.env.PATH;
  process.env.PATH = fakeDir;
  try {
    throws("without ps, a dead start still fails loud with the server's stderr", () =>
      herdr.ensureServer(`${SESSION}-fake2`), /did not come up.*Operation not permitted/);
  } finally {
    process.env.PATH = realPath;
  }
}

console.log("\n── ensureServer leaks nothing on a throwing probe ──");
{
  // The regression this guards: serverRunning wraps execFileSync with no catch, so a probe that
  // times out or exits nonzero THROWS out of the poll loop. Without a finally that path leaked the
  // log fd, the scratch dir, and a detached server child that also kept the process alive.
  const leakDir = scratch("cotal-herdr-leakbin-");
  const stateFile = join(leakDir, "probe-count");
  writeFileSync(
    join(leakDir, "herdr"),
    `#!/bin/sh\n` +
      `[ "$1" = "--version" ] && { echo "herdr 0.8.0"; exit 0; }\n` +
      `if [ "$3" = "status" ]; then\n` +
      `  n=$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(stateFile)}\n` +
      `  if [ "$n" -le 1 ]; then echo "status: not running"; exit 0; else echo "forced probe failure" >&2; exit 23; fi\n` +
      `fi\n` +
      `[ "$3" = "server" ] && { exec sleep 300; }\n` +
      `exit 1\n`,
    { mode: 0o755 },
  );
  const dirsBefore = readdirSync(tmpdir()).filter((e) => e.startsWith("cotal-herdr-srv-")).length;
  const realPath = process.env.PATH;
  let threw = false;
  try {
    process.env.PATH = `${leakDir}:${realPath}`;
    herdr.ensureServer(`${SESSION}-leak`);
  } catch {
    threw = true;
  } finally {
    process.env.PATH = realPath;
  }
  ok("a throwing status probe fails the provisioning loudly", threw);
  ok("no server scratch dir is left behind after the throw",
    readdirSync(tmpdir()).filter((e) => e.startsWith("cotal-herdr-srv-")).length === dirsBefore);
  const strays = execFileSync("sh", ["-c", `pgrep -f "sleep 300" | wc -l || true`], { encoding: "utf8" }).trim();
  ok(`no detached server child survives the throw (found ${strays})`, strays === "0");
}

console.log("\n── session isolation ───────────────────────────");

// Every driver call is scoped by --session. Prove SCOPING, not emptiness: a live pane in one
// session must be invisible from another. Asserting `length === 0` after teardown would pass even
// with scoping completely broken.
herdr.ensureServer(PEER);
const peerAgent = herdr.agentStart(PEER, "peer-agent", "/tmp", ["sleep", "30"]);
ok("positive control: the peer session sees its own pane", herdr.agentInfo(PEER, peerAgent.terminalId) !== undefined);
ok("the peer's pane is INVISIBLE from our session (real scoping, not emptiness)",
  herdr.agentInfo(SESSION, peerAgent.terminalId) === undefined);
ok("terminalState in our session reports the peer's terminal as exited, never as ours",
  herdr.terminalState(SESSION, peerAgent.terminalId) === "exited");
herdr.closePane(PEER, herdr.agentInfo(PEER, peerAgent.terminalId)!.paneId);
// The contract is FAIL CLOSED — never "exited" for a session it cannot reach. herdr reports this
// as a structured `server_not_running`, so the driver rethrows that rather than wrapping it; either
// shape is correct, silently returning "exited" is not.
throws("a serverless session cannot prove terminal state (fails closed)", () =>
  herdr.terminalState(OTHER, "term_nonexistent"), /couldn't prove|server_not_running/);

console.log("\n── registry registration ────────────────────────");

ok("herdrRuntimeProvider registered as 'runtime/herdr'", registry.resolve("runtime", "herdr") != null);
ok("herdrRuntimeProvider.available() returns true", herdrRuntimeProvider.available());

console.log("\n────────────────────────────────────────────────");
console.log(`\n${passed} passed, ${failed} failed  (${passed + failed} cells ran)\n`);

// A suite that silently skipped half its sections reports the same green as one that proved
// everything. Assert the size of what ran, not just the absence of failures.
if (passed + failed < EXPECTED_MIN_CELLS) {
  console.error(`✗ only ${passed + failed} cells ran, expected >= ${EXPECTED_MIN_CELLS} — a section was skipped`);
  process.exit(1);
}
if (failed > 0) process.exit(1);

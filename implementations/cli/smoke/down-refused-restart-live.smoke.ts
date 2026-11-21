/**
 * LIVE: a restart refused for a busy broker port keeps the completed stop on record, so the
 * stop preview before and after the refusal reports the same no-op.
 *
 * Before the fix the refused `up` wrote its own operation into the stack journal before the
 * occupied-address check, replacing the completed `down`; the next `down --dry-run` then printed
 * a whole-stack stop plan for a stack that was still stopped. The journal is now written only
 * once the broker address checks pass, so a refusal there leaves the recorded completed stop
 * in place and both previews report the stack is not running.
 *
 * Driven through the REAL binary as a subprocess, against a REAL broker. The failing case mirrors
 * the reported sequence exactly (foreground start, external stop, a non-NATS listener takes the
 * old address, stop preview, refused restart, stop preview again), and the journal on disk is
 * read back to confirm the recorded operation is still the completed stop.
 *
 * Sandboxes COTAL_HOME and a project root under a scratch base with proven-clean `.cotal` ancestry;
 * kills only its own children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:down-refused-restart:live  (BUILD FIRST - the subprocess runs built dist.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const scratch = makeScratch("cotal-down-refused-restart-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
process.env.COTAL_HOME = home;

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
// Loading tsx into node makes the child the CLI itself; the `.bin/tsx` shim would relay only SIGINT
// and SIGTERM and orphan it.
const TSX_IMPORT = import.meta.resolve("tsx");

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** The ambient environment with every `COTAL_` key stripped, then this smoke's own sandbox put
 *  back: a suite run from a mesh-joined session would otherwise point the real CLI at the caller's
 *  mesh and pass while doing it. Enforced by bin/smoke/suite-ambient-env.smoke.ts. */
const sandboxEnv = (() => {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) if (key.startsWith("COTAL_")) delete copy[key];
  return { ...copy, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
})();

const kids: ChildProcess[] = [];
async function run(args: string[]): Promise<{ status: number | null; out: string }> {
  const options = { cwd: root, env: sandboxEnv, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(sandbox, args, options);
  const cp = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  kids.push(cp);
  let out = "";
  cp.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { out += b.toString(); });
  await once(cp, "exit");
  return { status: cp.exitCode, out };
}

/** A foreground `up` that stays alive until the stack stops; the caller waits for readiness on
 *  its output and for its exit after an external stop. The exit promise is attached at spawn:
 *  attaching it after the stop would miss an exit that already fired. */
function runForeground(args: string[]): { cp: ChildProcess; out: () => string; exited: Promise<unknown> } {
  const cp = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], { cwd: root, env: sandboxEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(cp);
  let out = "";
  cp.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { out += b.toString(); });
  return { cp, out: () => out, exited: once(cp, "exit") };
}

/** Whether the loopback listener answers a TCP connect right now. */
function serving(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    const done = (v: boolean) => { try { sock.destroy(); } catch { /* already gone */ } res(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on("error", () => done(false));
    sock.on("connect", () => done(true));
  });
}

async function waitServing(port: number, want: boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await serving(port)) === want) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitFor(text: () => string, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (text().includes(needle)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The recorded operation in the root's stack journal. */
function journalOperation(): { kind: string; phase: string } {
  const journal = JSON.parse(readFileSync(join(root, ".cotal", "stack-controller.json"), "utf8")) as { operation: { kind: string; phase: string } };
  return journal.operation;
}

let listener: net.Server | undefined;
try {
  assertScratchHeld(root, "down refused-restart fixture");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;

  const created = await run(["space", "create", "lifecycle-stress", "--plain"]);
  ok("space is created", created.status === 0, created.out.slice(-500));

  const fg = runForeground(["up", "--foreground", "--server", server]);
  ok("foreground stack starts and reports readiness",
    await waitFor(fg.out, "Controller stack started", 120_000) && await waitServing(port, true), fg.out().slice(-800));

  const stopped = await run(["down", "--yes"]);
  ok("external down stops the stack", stopped.status === 0, stopped.out.slice(-800));
  await fg.exited;
  ok("foreground launcher exits after the stop", fg.cp.exitCode === 0, `exit ${fg.cp.exitCode}: ${fg.out().slice(-500)}`);
  ok("loopback listener closes after the stop", await waitServing(port, false));
  ok("the completed stop is on record", (() => { const op = journalOperation(); return op.kind === "down" && op.phase === "completed"; })(), JSON.stringify(journalOperation()));

  listener = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { listener!.once("error", reject); listener!.listen(port, "127.0.0.1", () => resolve()); });
  ok("a non-NATS listener holds the old address", await serving(port));

  const first = await run(["down", "--dry-run"]);
  ok("first stop preview exits 0 and reports the no-op",
    first.status === 0 && first.out.includes("is not running") && first.out.includes("Nothing was stopped"), first.out.slice(-800));

  const refused = await run(["up", "--foreground"]);
  ok("refused restart exits 2 with the occupied-address refusal",
    refused.status === 2 && refused.out.includes("started no member") && refused.out.includes("CONFLICT") && refused.out.includes("address already in use"), refused.out.slice(-1200));

  const second = await run(["down", "--dry-run"]);
  ok("second stop preview exits 0 and reports the same no-op",
    second.status === 0 && second.out.includes("is not running") && second.out.includes("Nothing was stopped"), second.out.slice(-800));
  ok("second stop preview shows no whole-stack stop plan",
    !second.out.includes("Whole-stack stop plan"), second.out.slice(-800));
  ok("the refused restart left the completed stop on record",
    (() => { const op = journalOperation(); return op.kind === "down" && op.phase === "completed"; })(), JSON.stringify(journalOperation()));

  console.log(`\ndown-refused-restart live smoke: OK - ${pass} checks`);
} finally {
  if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
  for (const cp of kids) { try { cp.kill("SIGKILL"); } catch { /* already gone */ } }
}

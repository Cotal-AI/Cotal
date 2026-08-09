/**
 * `cotal meshes add | rm` and the record-origin rule they rest on.
 *
 * The registry used to be written only by `cotal up`, which meant (a) a mesh running on another
 * machine could not be registered at all, and (b) the liveness sweep deleted records nothing on
 * this machine could write back — a sleeping laptop silently unregistered a healthy remote mesh.
 * So the load-bearing assertions here are the ones about ORIGIN:
 *
 *  • an `up` record whose broker is dead is pruned; a `manual` one is KEPT and reported `offline`,
 *    on that sweep and on every later one;
 *  • `add` verifies against the real broker before recording, and records nothing when that fails;
 *  • `--force` is the explicit unverified/replace escape;
 *  • `rm` drops records, releases the `current` pointer, and refuses a mesh running here.
 *
 * Needs `nats-server` on PATH (as the rest of smoke:ci does) for the one live-broker probe.
 * Run: pnpm smoke:meshes-registry
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the machine-home BEFORE anything reads the registry — homeCotalDir() reads COTAL_HOME per
// call, so the real ~/.cotal is never touched.
const home = mkdtempSync(join(tmpdir(), "cotal-meshes-home-"));
process.env.COTAL_HOME = home;

const { isReachable } = await import("@cotal-ai/core");
const { findMesh, getCurrent, loadMeshes, pruneStaleMeshes, recordMesh, setCurrent } = await import("@cotal-ai/workspace");
const { meshes, meshesComplete } = await import("../src/commands/meshes.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** Run the command, capturing stdout/stderr and turning its `process.exit` into a code. */
async function run(positionals: string[], values: Record<string, string | boolean> = {}): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  const exit = process.exit;
  let code = 0;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  // The command exits through process.exit on every failure path; a throw unwinds to us the same
  // way the real process would stop, so the assertions below see the exact code the operator gets.
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitSignal();
  }) as never;
  try {
    await meshes({ positionals, values, raw: [] });
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log;
    console.error = err;
    process.exit = exit;
  }
  return { out: lines.join("\n"), code };
}
class ExitSignal extends Error {}

/** A free localhost port (the listener is closed before the port is handed back). */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  assert.ok(addr && typeof addr === "object");
  const { port } = addr;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const roots: string[] = [];
/** A project root that looks like a mesh checkout (a `.cotal/`, no trust material). */
function projectRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cotal-${label}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  roots.push(root);
  return root;
}

const DEAD = `nats://127.0.0.1:${await freePort()}`; // nothing listens there
const brokerPort = await freePort();
const LIVE = `nats://127.0.0.1:${brokerPort}`;
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(brokerPort)], { stdio: "ignore" });
broker.on("error", () => {
  console.error("needs nats-server on PATH");
  process.exit(1);
});
for (let i = 0; i < 50 && !(await isReachable(LIVE)); i++) await new Promise((r) => setTimeout(r, 100));

const cwd = process.cwd();
try {
  assert.ok(await isReachable(LIVE), "the test broker never came up");
  const root = projectRoot("remote");

  // ── add: verified registration of a mesh this machine did not start ────────────────────────────
  const added = await run(["add", "beta"], { server: LIVE, root });
  check("add records a verified mesh", added.code === 0 && findMesh("beta")?.server === LIVE, added.out);
  check("add records it as operator-registered", findMesh("beta")?.origin === "manual", findMesh("beta"));
  check("add infers open mode from a root with no trust material", findMesh("beta")?.mode === "open", findMesh("beta"));
  check("add adopts the default when there is no usable current", getCurrent() === "beta", getCurrent());
  check("add says what it registered", added.out.includes("registered") && added.out.includes(LIVE), added.out);

  // ── add: a failed verification records NOTHING ────────────────────────────────────────────────
  const dead = await run(["add", "ghost"], { server: DEAD, root });
  check("add against a dead address exits non-zero", dead.code === 1, dead);
  check("add against a dead address records nothing", findMesh("ghost") === undefined, loadMeshes());
  check("add says nothing was registered, and how to override", dead.out.includes("nothing was registered") && dead.out.includes("--force"), dead.out);

  const forced = await run(["add", "ghost"], { server: DEAD, root, force: true });
  check("add --force registers an unverified (currently down) mesh", forced.code === 0 && findMesh("ghost")?.origin === "manual", forced.out);
  check("add --force marks the line unverified", forced.out.includes("unverified"), forced.out);
  check("add --force does NOT steal a usable current", getCurrent() === "beta", getCurrent());

  // ── add: guards ───────────────────────────────────────────────────────────────────────────────
  const dup = await run(["add", "beta"], { server: LIVE, root });
  check("add refuses a space that is already registered", dup.code === 1 && dup.out.includes("already registered"), dup.out);
  const replaced = await run(["add", "beta"], { server: DEAD, root, force: true });
  check("add --force replaces an existing record", replaced.code === 0 && findMesh("beta")?.server === DEAD, findMesh("beta"));
  const noServer = await run(["add", "nowhere"], { root });
  check("add without --server fails loud", noServer.code === 1 && noServer.out.includes("--server"), noServer.out);
  const authless = await run(["add", "needs-auth"], { server: LIVE, root, mode: "auth" });
  check("add --mode auth without that space's trust material fails loud", authless.code === 1 && authless.out.includes("trust material"), authless.out);
  check("add --mode auth recorded nothing", findMesh("needs-auth") === undefined, loadMeshes());
  const userMode = await run(["add", "hosted"], { server: LIVE, root, mode: "user" });
  check("add --mode user is refused (IdP trust is not derivable)", userMode.code === 1 && userMode.out.includes("cotal up --user-auth"), userMode.out);
  const badMode = await run(["add", "hosted"], { server: LIVE, root, mode: "sideways" });
  check("add --mode with a junk value fails loud", badMode.code === 1 && badMode.out.includes("auth or open"), badMode.out);
  const badUsage = await run(["add"], { server: LIVE, root });
  check("add without a space name prints usage", badUsage.code === 1 && badUsage.out.includes("usage:"), badUsage.out);

  // ── THE INVARIANT: a sweep prunes an `up` record and keeps an operator-registered one ──────────
  rmSync(join(home, "meshes"), { recursive: true, force: true });
  const localRoot = projectRoot("local");
  recordMesh({ space: "local-dead", server: DEAD, root: localRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  recordMesh({ space: "legacy-dead", server: DEAD, root: localRoot, mode: "open", ts: new Date(0).toISOString() });
  recordMesh({ space: "remote-dead", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const sweep = await pruneStaleMeshes();
  check("sweep prunes a dead mesh this machine started", findMesh("local-dead") === undefined, loadMeshes());
  check("sweep prunes a dead pre-origin record (absent origin = `up`)", findMesh("legacy-dead") === undefined, loadMeshes());
  check("sweep KEEPS a dead operator-registered mesh", findMesh("remote-dead")?.space === "remote-dead", loadMeshes());
  check("sweep reports the kept one as offline", sweep.offline.includes("remote-dead") && sweep.pruned.includes("local-dead"), sweep);
  const sweep2 = await pruneStaleMeshes();
  check("a second sweep still keeps it (not a one-time reprieve)", findMesh("remote-dead") !== undefined && sweep2.offline.includes("remote-dead"), sweep2);

  const listed = await run([]);
  check("list shows the offline registered mesh", listed.out.includes("remote-dead") && listed.out.includes("offline"), listed.out);
  check("list tags it as registered", listed.out.includes("registered"), listed.out);
  check("`meshes list` is the same as bare `meshes`", (await run(["list"])).out === listed.out);

  // ── rm ────────────────────────────────────────────────────────────────────────────────────────
  setCurrent("remote-dead");
  const removed = await run(["rm", "remote-dead"]);
  check("rm drops the record", removed.code === 0 && findMesh("remote-dead") === undefined, loadMeshes());
  check("rm releases a current that pointed at it", getCurrent() === undefined, getCurrent());
  check("rm says the default is gone", removed.out.includes("no default mesh now"), removed.out);

  const unknown = await run(["rm", "never-existed"]);
  check("rm of an unknown mesh exits non-zero", unknown.code === 1 && unknown.out.includes("no mesh named"), unknown.out);

  recordMesh({ space: "a1", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  recordMesh({ space: "a2", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const multi = await run(["rm", "a1", "a2"]);
  check("rm takes several names at once", multi.code === 0 && loadMeshes().length === 0, loadMeshes());

  // A mesh RUNNING here: `rm` is the wrong verb — it would leave a live broker with no record.
  recordMesh({ space: "live-local", server: LIVE, root: localRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const refused = await run(["rm", "live-local"]);
  check("rm refuses a mesh this machine is running", refused.code === 1 && findMesh("live-local") !== undefined, refused.out);
  check("rm points at `cotal down` instead", refused.out.includes("cotal down"), refused.out);
  const dropped = await run(["rm", "live-local"], { force: true });
  check("rm --force drops a running mesh's record", dropped.code === 0 && findMesh("live-local") === undefined, loadMeshes());

  // A live mesh registered BY HAND is not this machine's to stop, so `rm` just drops it.
  recordMesh({ space: "live-remote", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const remoteRm = await run(["rm", "live-remote"]);
  check("rm drops a live operator-registered record without --force", remoteRm.code === 0 && findMesh("live-remote") === undefined, remoteRm.out);

  const noNames = await run(["rm"]);
  check("rm without a name prints usage", noNames.code === 1 && noNames.out.includes("usage:"), noNames.out);

  // ── surface ───────────────────────────────────────────────────────────────────────────────────
  const bogus = await run(["frobnicate"]);
  check("an unknown subcommand fails loud with the usage line", bogus.code === 1 && bogus.out.includes("unknown subcommand"), bogus.out);
  const empty = await run([]);
  check("an empty registry points at both ways to fill it", empty.out.includes("cotal up") && empty.out.includes("cotal meshes add"), empty.out);

  recordMesh({ space: "tabbed", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  // The kernel hands a completer the words AFTER the command name (`emitCommandCompletion`).
  check("completion offers the subcommands first", meshesComplete([""]).items.some((i) => i.value === "add"));
  check("completion offers registered spaces after `rm`", meshesComplete(["rm", ""]).items.some((i) => i.value === "tabbed"));
  check("completion offers the modes after `--mode`", meshesComplete(["add", "x", "--mode", ""]).items.map((i) => i.value).join() === "auth,open");
} finally {
  process.chdir(cwd);
  broker.kill("SIGKILL");
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`\nmeshes registry smoke: ${pass} checks passed`);
process.exit(0);

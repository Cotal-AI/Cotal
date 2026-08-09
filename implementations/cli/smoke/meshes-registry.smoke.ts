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
 *  • `--force` is the explicit record-without-verifying / replace escape;
 *  • `rm` drops records, releases the `current` pointer, and refuses a mesh running here.
 *
 * Needs `nats-server` on PATH (as the rest of smoke:ci does) for the live-broker probes.
 *
 * KNOWN LIMIT: the live broker here is open and JetStream-less, so the AUTH admission path is
 * covered only by its refusals (a broker that enforces nothing, a root whose trust does not
 * compose). A positive auth registration against a provisioned mesh belongs with the provisioning
 * smokes (`multi-space`), not here — this file must not be read as proving that path works.
 * Run: pnpm smoke:meshes-registry
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the machine-home BEFORE anything reads the registry — homeCotalDir() reads COTAL_HOME per
// call, so the real ~/.cotal is never touched.
const home = mkdtempSync(join(tmpdir(), "cotal-meshes-home-"));
process.env.COTAL_HOME = home;

// The local-process lifecycle descriptors (nats/manager/delivery pidfiles) are registered by the
// CLI composition root, and `rm`'s "is this mesh running here" check reads them — import it first,
// exactly as the real binary does, or the check silently has nothing to look at.
await import("../src/index.js");
const { createSpaceAuth, isReachable } = await import("@cotal-ai/core");
const { authDir, findMesh, getCurrent, loadMeshes, loadSpaceAuth, pruneStaleMeshes, recordMesh, removeMesh, saveSpaceAuth, setCurrent } = await import("@cotal-ai/workspace");
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
  check("add --force registers a mesh that is currently down", forced.code === 0 && findMesh("ghost")?.origin === "manual", forced.out);
  check("add --force says the record was written without verifying", forced.out.includes("without verifying"), forced.out);
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

  // MODE HONESTY. A NATS broker with no auth configured accepts a credential-bearing CONNECT and
  // ignores it, so "the creds were accepted" is not evidence of enforcement. Registering `auth`
  // against an open broker would promise JWT/ACL protection that does not exist.
  //
  // This needs REAL composed trust, not a marker file: with nothing usable on disk the compose
  // guard fires first and the mode probe is never reached — the assertion would then pass with the
  // whole mode-verification branch deleted, which is the circular-test trap this file is meant to
  // avoid. So mint an actual space auth and save it the way `cotal up` does.
  const trustRoot = projectRoot("trust");
  saveSpaceAuth(authDir(trustRoot), await createSpaceAuth("openbroker"));
  const fakeAuth = await run(["add", "openbroker"], { server: LIVE, root: trustRoot, mode: "auth" });
  check("add --mode auth is refused against a broker that enforces nothing",
    fakeAuth.code === 1 && findMesh("openbroker") === undefined, fakeAuth.out);
  check("…for the RIGHT reason: the broker accepts unauthenticated connections",
    fakeAuth.out.includes("accepts unauthenticated connections"), fakeAuth.out);
  check("…and the trust it was given really does compose (so the probe was reached)",
    loadSpaceAuth(authDir(trustRoot), "openbroker") !== undefined);
  // The compose guard is its own case: an account record with no usable trust behind it.
  const accountOnly = projectRoot("account-only");
  saveSpaceAuth(authDir(accountOnly), await createSpaceAuth("halfspace"));
  rmSync(join(authDir(accountOnly), "broker.json"), { force: true }); // account survives, trust cannot compose
  const halfTrust = await run(["add", "halfspace"], { server: LIVE, root: accountOnly, mode: "auth" });
  check("add --mode auth is refused when the root's trust does not compose",
    halfTrust.code === 1 && findMesh("halfspace") === undefined, halfTrust.out);
  check("…naming the missing half rather than a connection problem",
    halfTrust.out.includes("does not compose") || halfTrust.out.includes("trust material"), halfTrust.out);

  // CREDENTIALS IN THE URL. The record is written to disk and echoed back by add + list, so an
  // inline password would be copied into both. Refuse it without repeating the secret.
  const creddy = await run(["add", "leaky"], { server: "nats://alice:swordfish@127.0.0.1:1", root });
  check("add refuses a --server with embedded credentials", creddy.code === 1 && findMesh("leaky") === undefined, creddy.out);
  check("…and does not echo the password back", !creddy.out.includes("swordfish"), creddy.out);
  for (const [label, url] of [["a non-broker scheme", "http://127.0.0.1:4222"], ["junk", "not-a-url"]] as const) {
    const bad = await run(["add", "badurl"], { server: url, root });
    check(`add refuses ${label} in --server`, bad.code === 1 && findMesh("badurl") === undefined, bad.out);
  }

  // ROOT INFERENCE. `findCotalRoot` returns its starting directory when it finds no `.cotal`
  // up-tree, so the "outside a project" guard has to check the directory really is one — without
  // that, running this from `/` recorded `root: "/"`.
  const bare = mkdtempSync(join(tmpdir(), "cotal-noproject-")); // no .cotal anywhere in it
  roots.push(bare);
  const prevCwd2 = process.cwd();
  process.chdir(bare);
  const rootless = await run(["add", "rootless"], { server: LIVE });
  process.chdir(prevCwd2);
  check("add outside a project requires --root", rootless.code === 1 && findMesh("rootless") === undefined, rootless.out);
  check("…and names --root as the fix", rootless.out.includes("--root"), rootless.out);

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

  // …and the same rule for the paths that delete by ROOT rather than by liveness. `add` defaults
  // --root to the project you run it in, so a hand-registered remote mesh routinely shares a root
  // with the local one; `cotal down` / `cotal clean all` there must not take the remote with it.
  const { removeMeshesByRoot, localMeshesForRoot } = await import("@cotal-ai/workspace");
  const shared = projectRoot("shared");
  recordMesh({ space: "here", server: LIVE, root: shared, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  recordMesh({ space: "elsewhere", server: LIVE, root: shared, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const byRoot = removeMeshesByRoot(shared);
  check("a root teardown drops this project's own record", byRoot.includes("here") && findMesh("here") === undefined, byRoot);
  check("a root teardown KEEPS a co-rooted registered mesh", findMesh("elsewhere") !== undefined, loadMeshes());
  check("…and does not claim it removed it", !byRoot.includes("elsewhere"), byRoot);
  // `clean`'s "is this root's mesh still live" guard asks the same question: a reachable REMOTE
  // broker is not the operator's to stop, so it must not block a local wipe forever.
  check("the local-liveness guard ignores a co-rooted registered mesh",
    localMeshesForRoot(shared).every((m) => m.space !== "elsewhere"), localMeshesForRoot(shared));
  removeMesh("elsewhere");

  // `cotal up --space <name>` reclaims a dead holder's name. It must not reclaim a REGISTERED one:
  // unreachable is not proof that mesh is gone, and the reclaim happens BEFORE the broker starts,
  // so an `up` that then fails would leave the operator with neither mesh and no way back.
  const { claimSpace } = await import("../src/commands/up.js");
  recordMesh({ space: "claimed", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  let claimError: Error | undefined;
  await claimSpace("claimed", LIVE, localRoot).catch((e: Error) => void (claimError = e));
  check("`up` refuses to reclaim a registered space rather than deleting it", claimError !== undefined, claimError?.message);
  check("…and the registration survives the refusal", findMesh("claimed") !== undefined, loadMeshes());
  check("…naming `cotal meshes rm` as the way through", claimError?.message.includes("cotal meshes rm claimed") === true, claimError?.message);
  // A LIVE registered holder must reach the SAME refusal. Deciding liveness first sent the operator
  // to `cotal down`, which cannot stop a mesh this machine does not run.
  recordMesh({ space: "claimed-live", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  let liveClaimError: Error | undefined;
  await claimSpace("claimed-live", DEAD, localRoot).catch((e: Error) => void (liveClaimError = e));
  check("a LIVE registered holder gets the same refusal, not `cotal down`",
    liveClaimError?.message.includes("cotal meshes rm claimed-live") === true && !liveClaimError.message.includes("cotal down"),
    liveClaimError?.message);
  check("…and it survives", findMesh("claimed-live") !== undefined, loadMeshes());
  recordMesh({ space: "reclaimable", server: DEAD, root: localRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  await claimSpace("reclaimable", LIVE, root);
  check("a dead `up` holder is still reclaimed (unchanged)", findMesh("reclaimable") === undefined, loadMeshes());
  removeMesh("claimed");
  removeMesh("claimed-live");

  // PROVENANCE IS NOT DOWNGRADED BY A REFRESH. Several `up` paths re-record a mesh they did not
  // start (the "a broker is already on this port" branch concludes it is up from reachability
  // alone). Restamping `origin: "up"` there would quietly make a record only the operator can
  // rebuild deletable by the next sweep.
  // …and the distinction is per CALL SITE, not blanket: the refresh branch starts nothing, so it
  // preserves; a branch that actually spawned the broker (or proved a listener it owns) must claim
  // the record, or `cotal down` would leave a stale record behind and `rm` would treat a mesh this
  // machine is running as someone else's.
  const { recordOurMeshForTest } = await import("../src/commands/up.js");
  recordMesh({ space: "refreshed", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  recordOurMeshForTest({ space: "refreshed", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "refresh");
  check("an `up` refresh keeps a hand-registered record's origin", findMesh("refreshed")?.origin === "manual", findMesh("refreshed"));
  recordMesh({ space: "started-over", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  recordOurMeshForTest({ space: "started-over", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "started");
  check("a launch that STARTED the broker claims the record, even over a manual one",
    findMesh("started-over")?.origin === "up", findMesh("started-over"));
  recordOurMeshForTest({ space: "ours-now", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "started");
  check("…and still stamps `up` on a record it created", findMesh("ours-now")?.origin === "up", findMesh("ours-now"));
  removeMesh("refreshed");
  removeMesh("started-over");
  removeMesh("ours-now");

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
  // "Running here" must be LOCAL PROCESS OWNERSHIP, not a reachable address: any broker answers on
  // that port, including a reused one, and refusing on that basis prints a `cotal down` instruction
  // that would stop nothing. So the smoke gives it a real live pid, the way the mesh does.
  const ownedRoot = projectRoot("owned");
  const brokerStandIn = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
  writeFileSync(join(ownedRoot, ".cotal", "nats.pid"), String(brokerStandIn.pid), { mode: 0o600 });
  recordMesh({ space: "live-local", server: LIVE, root: ownedRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const refused = await run(["rm", "live-local"]);
  check("rm refuses a mesh this machine is running", refused.code === 1 && findMesh("live-local") !== undefined, refused.out);
  check("rm points at `cotal down` instead", refused.out.includes("cotal down"), refused.out);
  check("…and names the live process it means", /pid \d+/.test(refused.out), refused.out);
  // THE CO-ROOTED CASE this feature exists for: a registration for a remote mesh shares the root
  // with the local one (that is `add`'s default). Pidfiles are root-scoped, so the local mesh's live
  // pid is visible under that same root — and must not make `rm <remote>` claim the remote mesh is
  // running here. Safe because a mesh this machine really started is stamped `up` and does get
  // checked; only the hand-registered record skips.
  recordMesh({ space: "remote-corooted", server: DEAD, root: ownedRoot, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const corooted = await run(["rm", "remote-corooted"]);
  check("rm drops a co-rooted registration despite the local mesh's live pid",
    corooted.code === 0 && findMesh("remote-corooted") === undefined, corooted.out);
  check("…and the local mesh sharing that root is still protected",
    (await run(["rm", "live-local"])).code === 1 && findMesh("live-local") !== undefined, loadMeshes());

  // The same record with a reachable broker but NO local process is not this machine's to keep.
  recordMesh({ space: "not-ours", server: LIVE, root: localRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const foreign = await run(["rm", "not-ours"]);
  check("rm does not refuse merely because something answers on the address",
    foreign.code === 0 && findMesh("not-ours") === undefined, foreign.out);
  const dropped = await run(["rm", "live-local"], { force: true });
  check("rm --force drops a running mesh's record", dropped.code === 0 && findMesh("live-local") === undefined, loadMeshes());
  // …and --force must not be defeated by the guard it is meant to skip. The ownership probe reads
  // the root's local process state; on a root it cannot make sense of, that probe throws, and
  // running it anyway would make the documented override unusable exactly when it is needed.
  const brokenRoot = projectRoot("broken");
  saveSpaceAuth(authDir(brokenRoot), await createSpaceAuth("tenant-a"));
  writeFileSync(join(authDir(brokenRoot), "account.deadbeef.json"), "{ not json"); // unreadable tenant
  writeFileSync(join(brokenRoot, ".cotal", "nats.pid"), String(process.pid), { mode: 0o600 });
  recordMesh({ space: "tenant-a", server: LIVE, root: brokenRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const forcedOnBroken = await run(["rm", "tenant-a"], { force: true });
  check("rm --force works on a root whose space cannot be resolved",
    forcedOnBroken.code === 0 && findMesh("tenant-a") === undefined, forcedOnBroken.out);
  brokerStandIn.kill("SIGKILL");

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

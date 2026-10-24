/**
 * `cotal clean` local-state targets (`store`/`all`) — hermetic, no broker needed.
 * Run: pnpm smoke:clean
 *
 * Covers: the live-process guard (a running recorded pid refuses cleanup; a STALE or corrupt
 * pidfile does not; an EPERM-unsignalable pid DOES), the `store` removal set (JetStream store
 * only), the `all` removal set (store + auth + every derived local cred + crash residue: stale
 * pidfiles, run/), that personas/logs survive, the `--store-dir` override, the store the last broker
 * served when `.cotal/nats` holds none, the refusal of a store directory that holds anything else
 * (with nothing in it removed) and `up`'s warning about one, the refusal of a store folder another
 * space's streams or registration name, the dry run, the already-clean no-op,
 * that `clean all` drops only registry entries rooted at THIS project (a named open mesh must never
 * delete the default space's entry), and that a `clean all` removing the space trust says earlier
 * full backups no longer restore into the root.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the machine-home BEFORE importing anything registry-touching (`clean all` mutates
// ~/.cotal/meshes) - homeCotalDir() reads COTAL_HOME per call, so the real one is never touched.
const home = mkdtempSync(join(tmpdir(), "cotal-clean-home-"));
process.env.COTAL_HOME = home;

await import("../src/index.js"); // register the base local-process lifecycle descriptors
// The binary also imports @cotal-ai/delivery, which registers delivery over the workspace's custody
// descriptor. This package does not depend on it, so the suite registers that descriptor itself, and
// `clean` and bare `down` see the delivery daemon as the binary's do.
const { registry } = await import("@cotal-ai/core");
registry.register((await import("@cotal-ai/workspace")).DELIVERY_PROCESS);
const { clean, liveMeshProcess, removeLocalState } = await import("../src/commands/clean.js");
const { warnForeignStoreEntries } = await import("../src/lib/store-dir.js");
const { down, pidfileState } = await import("../src/commands/down.js");
const { isReachable } = await import("@cotal-ai/core");
const { findCotalRoot, getCurrent, loadMeshes, recordMesh, removeMesh, setCurrent, spaceMaterialDir, spaceSegment, renewalRecordPath, defaultStartToken } = await import("@cotal-ai/workspace");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** Every identity-derived file `clean all` must sweep (mirrors removeLocalState's list). The
 *  per-space renewal record is NOT here: it lives at `renewal.<spaceKey>.json` beside the pidfiles,
 *  and the cells below stage and assert it through the workspace seam (#1850). The root-scoped
 *  `renewal.json` stays: it is the pre-per-space spelling `clean all` still sweeps. */
const DERIVED = [
  "delivery.creds",
  "manager.delivery-aware",
  "membership-observer.creds",
  "membership-rw.creds",
  "connection-evictor.creds",
  "membership.json",
  "renewal.json",
];

/** A project root whose `.cotal/` looks like a CRASHED mesh's leftovers: store, identity, every
 *  derived cred, a stale (dead-pid) pidfile, and transient launch artifacts. */
function meshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cotal-clean-"));
  const dot = join(root, ".cotal");
  mkdirSync(join(dot, "nats", "jetstream"), { recursive: true });
  writeFileSync(join(dot, "nats", "jetstream", "stream.dat"), "x");
  mkdirSync(join(dot, "auth", "creds"), { recursive: true });
  // One spawned agent's standing secrets (all three migrated kinds) + its non-secret health file.
  for (const f of ["worker.creds", "worker.actor-token", "worker.sentinel.creds", "worker.auth-health.json"])
    writeFileSync(join(dot, "auth", "creds", f), "x");
  writeFileSync(join(dot, "auth", "auth.json"), JSON.stringify({ space: "demo" }));
  mkdirSync(join(dot, "agents"), { recursive: true });
  writeFileSync(join(dot, "agents", "default.md"), "# default\n");
  mkdirSync(join(dot, "run"), { recursive: true });
  writeFileSync(join(dot, "run", "launch.json"), "{}");
  for (const f of [...DERIVED, "nats.log"]) writeFileSync(join(dot, f), "x");
  return root;
}

try {
  // --- live-process guard --------------------------------------------------------------------
  const guarded = meshRoot();
  // A real live pid we own: a sleeping child stands in for a running nats-server.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  writeFileSync(join(guarded, ".cotal", "nats.pid"), String(child.pid));
  check("a live recorded pid blocks cleanup", /nats-server, pid \d+/.test(liveMeshProcess(guarded) ?? ""), liveMeshProcess(guarded));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  check("a STALE pidfile (dead pid) does not block", liveMeshProcess(guarded) === undefined);
  // A corrupt/empty pidfile parses to 0 - POSIX kill(0, 0) probes our own process group, which
  // must NOT read as a phantom live mesh (it would wedge cleanup forever).
  writeFileSync(join(guarded, ".cotal", "nats.pid"), "");
  check("a corrupt/empty pidfile does not block", liveMeshProcess(guarded) === undefined);
  rmSync(guarded, { recursive: true, force: true });

  const reachableRoot = meshRoot();
  const listener = createServer((socket) => socket.write('INFO {"server_id":"live-clean-smoke"}\r\n'));
  await new Promise<void>((resolveListen) => listener.listen(0, "127.0.0.1", resolveListen));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const reachableCanonicalRoot = realpathSync.native(reachableRoot);
  recordMesh({
    space: "reachable-clean",
    server: `nats://127.0.0.1:${address.port}`,
    root: reachableCanonicalRoot,
    mode: "open",
    ts: "2026-07-14T00:00:00.000Z",
  });
  check("reachable cleanup fixture is recorded", loadMeshes().some((mesh) => mesh.root === reachableCanonicalRoot));
  check("reachable cleanup fixture serves NATS INFO", await isReachable(`nats://127.0.0.1:${address.port}`));
  const reachableCwd = process.cwd();
  process.chdir(reachableRoot);
  try {
    // The recorded root is canonical; the ACTIVE root is whatever spelling cwd hands back — the same
    // directory under an 8.3 short name on Windows (`C:\Users\RUNNER~1\…`). The refusal below must
    // hold across that mismatch, which is what makes this a regression test for canonical matching
    // and not just a happy-path check: a raw `===` reads as "no mesh recorded" and cleans anyway.
    check("reachable cleanup fixture resolves as the active root", realpathSync.native(findCotalRoot()) === reachableCanonicalRoot, findCotalRoot());
    await assert.rejects(
      () => clean({ positionals: ["store"], values: { force: true }, raw: [] }),
      /recorded mesh endpoint .* is reachable/,
    );
  } finally {
    process.chdir(reachableCwd);
    await new Promise<void>((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()));
    removeMesh("reachable-clean");
  }
  check("a reachable recorded broker blocks cleanup even without a pidfile", existsSync(join(reachableRoot, ".cotal", "nats")));
  rmSync(reachableRoot, { recursive: true, force: true });

  // --- `store` removes exactly the JetStream store -------------------------------------------
  const storeRoot = meshRoot();
  const removedStore = await removeLocalState(storeRoot, { includeAuth: false });
  check("store: removes the JetStream store", removedStore.some((r) => r.includes("nats")) && !existsSync(join(storeRoot, ".cotal", "nats")));
  check("store: auth + derived creds survive", existsSync(join(storeRoot, ".cotal", "auth", "auth.json")) && existsSync(join(storeRoot, ".cotal", "delivery.creds")));
  check("store: per-agent standing secrets survive", existsSync(join(storeRoot, ".cotal", "auth", "creds", "worker.creds")));
  check("store: personas survive", existsSync(join(storeRoot, ".cotal", "agents", "default.md")));
  rmSync(storeRoot, { recursive: true, force: true });

  // --- `all` removes store + identity + derived creds + crash residue ------------------------
  const allRoot = meshRoot();
  writeFileSync(join(allRoot, ".cotal", "nats.pid"), "999999"); // stale pidfile from a crash
  // `demo` is the space meshRoot's auth.json names; the record is per-space (#1850).
  writeFileSync(renewalRecordPath(allRoot, "demo"), "x");
  const removedAll = await removeLocalState(allRoot, { includeAuth: true });
  check("all: removes store + auth", !existsSync(join(allRoot, ".cotal", "nats")) && !existsSync(join(allRoot, ".cotal", "auth")));
  for (const f of DERIVED) check(`all: removes derived ${f}`, !existsSync(join(allRoot, ".cotal", f)));
  check("all: removes this space's per-space renewal record (#1850)", !existsSync(renewalRecordPath(allRoot, "demo")), renewalRecordPath(allRoot, "demo"));
  // The per-agent kinds go through the SEAM (reported as store keys), never the raw auth rm —
  // the same migrated-kind discipline as delivery.creds; the health file falls to the raw rm.
  for (const k of ["auth/creds/worker.creds", "auth/creds/worker.actor-token", "auth/creds/worker.sentinel.creds"])
    check(`all: sweeps ${k} through the seam`, removedAll.includes(`.cotal/${k}`), removedAll);
  check("all: sweeps stale pidfiles", !existsSync(join(allRoot, ".cotal", "nats.pid")));
  check("all: sweeps run/ launch artifacts", !existsSync(join(allRoot, ".cotal", "run")));
  check("all: personas survive", existsSync(join(allRoot, ".cotal", "agents", "default.md")));
  check("all: logs are left alone", existsSync(join(allRoot, ".cotal", "nats.log")));
  check("all: reports what it removed", removedAll.length >= 9, removedAll);

  // --- P7 §5: the segment is swept BY IDENTITY, not by a list of literals ---------------------
  // This list used to name each derived cred, so it was a hand-kept copy of the set
  // `provisionMembershipCreds` writes, and the two drifted apart every time a kind was added — a
  // cred minted by `up` and never swept by the reset survives an operator's "full local reset" and
  // is then re-adopted by the next boot under the OLD identity. As of P7 those kinds live in this
  // space's own segment and the reset removes the DIRECTORY, which ends the coupling by
  // construction. The sixth file below is the whole proof: it is named in no list anywhere in this
  // repo, including `DERIVED` above, and it must still be gone.
  const segRoot = meshRoot();
  const segDir = spaceMaterialDir(segRoot, "demo"); // `demo` is the space meshRoot's auth.json names
  mkdirSync(segDir, { recursive: true });
  for (const f of [...DERIVED, "a-kind-no-list-names.creds"]) writeFileSync(join(segDir, f), "x");
  // A SECOND tenant's segment on the same root. `clean all` resets ONE space, so a sweep spelled
  // `.cotal/space.*` — the obvious shape, and the one a reader reaches for after seeing the
  // directory removal — would take a neighbour's live material with it and report success.
  const neighbourDir = spaceMaterialDir(segRoot, "neighbour");
  mkdirSync(neighbourDir, { recursive: true });
  writeFileSync(join(neighbourDir, "delivery.creds"), "x");
  const removedSeg = await removeLocalState(segRoot, { includeAuth: true });
  check("P7: `all` removes this space's segment entirely", !existsSync(segDir));
  check("P7: ...including a kind NO removal list names (swept by construction, not by literal)",
    !existsSync(join(segDir, "a-kind-no-list-names.creds")));
  check("P7: the operator is told the segment went, by name", removedSeg.some((r) => r.includes(spaceSegment("demo"))), removedSeg);
  check("P7: the OTHER tenant's segment is untouched (a reset owns one space, not the root)",
    existsSync(join(neighbourDir, "delivery.creds")));
  // The legacy FLAT copies still go too: a root no post-P7 `up` has touched keeps old-operator $SYS
  // material at the pre-P7 spelling, and a reset that swept only the segment would leave it.
  for (const f of DERIVED) check(`P7: the legacy flat ${f} is swept as well`, !existsSync(join(segRoot, ".cotal", f)));
  rmSync(segRoot, { recursive: true, force: true });

  // --- HIGH-3: the space-NAMER (auth.json) dies LAST, after every fallible cleanup ------------
  // If a late removal fails (an immutable/locked derived file, pidfile, or run/ artifact), auth.json
  // must still be present so a re-run resolves THIS space, not the default. Force a deterministic
  // late failure via a read-only `run/` dir (its child cannot be unlinked) and prove auth survives.
  // POSIX-only: on win32 read-only-dir semantics differ (rmSync force overrides), so the probe is
  // skipped there — the ORDERING in removeLocalState is unconditional; only this failure injection is.
  if (process.platform !== "win32") {
    // (a) a locked artifact OUTSIDE .cotal/auth (a read-only run/ dir) — removed before the namer.
    const stuckRoot = meshRoot();
    chmodSync(join(stuckRoot, ".cotal", "run"), 0o500); // read-only dir: unlinking run/launch.json throws
    let threw = false;
    try { await removeLocalState(stuckRoot, { includeAuth: true }); } catch { threw = true; }
    check("HIGH-3: a failed late cleanup (read-only run/) throws", threw);
    check("HIGH-3: auth.json (the space-namer) SURVIVES the failed cleanup", existsSync(join(stuckRoot, ".cotal", "auth", "auth.json")));
    chmodSync(join(stuckRoot, ".cotal", "run"), 0o700);
    rmSync(stuckRoot, { recursive: true, force: true });
    // (b) a locked stray UNDER .cotal/auth itself — auth.json's siblings are removed before it, so
    // this throws with auth.json still present (the raw `rm(.cotal/auth)` this replaced would have
    // stranded a wrong-space retry once auth.json had already gone).
    const authStuck = meshRoot();
    const lockedDir = join(authStuck, ".cotal", "auth", "locked-stray");
    mkdirSync(lockedDir, { recursive: true });
    writeFileSync(join(lockedDir, "held"), "x");
    chmodSync(lockedDir, 0o500); // read-only dir: its child cannot be unlinked
    let threwAuth = false;
    try { await removeLocalState(authStuck, { includeAuth: true }); } catch { threwAuth = true; }
    check("HIGH-3b: a locked stray UNDER .cotal/auth throws", threwAuth);
    check("HIGH-3b: auth.json SURVIVES a stray locked under its own dir", existsSync(join(authStuck, ".cotal", "auth", "auth.json")));
    chmodSync(lockedDir, 0o700);
    rmSync(authStuck, { recursive: true, force: true });
  } else {
    console.log("  · HIGH-3 read-only-dir probe skipped on win32 (chmod dir semantics differ); the namer-last ordering is unconditional");
  }

  // --- `--store-dir` override + already-clean no-op ------------------------------------------
  const customRoot = meshRoot();
  const customStore = mkdtempSync(join(tmpdir(), "cotal-store-"));
  mkdirSync(join(customStore, "jetstream"));
  writeFileSync(join(customStore, "jetstream", "stream.dat"), "x");
  // Cleanup resolves its target before deleting it, and REPORTS what it actually removed — so the
  // report names the resolved store, which is the spelling that matters for a destructive op. Pin
  // the canonical form now, while the dir still exists to resolve. (A substring check against the
  // as-passed spelling only ever passed on POSIX by luck: "/private/var/x" contains "/var/x". A
  // Windows 8.3 short name is not a substring of its long form, so it caught this honestly.)
  const customStoreResolved = realpathSync.native(customStore);
  const removedCustom = await removeLocalState(customRoot, { includeAuth: false, storeDir: customStore });
  check("--store-dir: removes the OVERRIDE dir, not .cotal/nats", !existsSync(customStore) && existsSync(join(customRoot, ".cotal", "nats")));
  check("--store-dir: reports the resolved path it removed", removedCustom.some((r) => r.includes(customStoreResolved)), removedCustom);
  await assert.rejects(
    () => removeLocalState(customRoot, { includeAuth: false, storeDir: customRoot }),
    /unsafe store cleanup target/,
  );
  const controlTree = join(customRoot, ".cotal", "manifests");
  mkdirSync(join(controlTree, "jetstream"), { recursive: true });
  await assert.rejects(
    () => removeLocalState(customRoot, { includeAuth: false, storeDir: controlTree }),
    /unsafe store cleanup target/,
  );
  rmSync(customRoot, { recursive: true, force: true });

  // --- a store directory that holds anything else is refused, and nothing in it is removed -----
  // `up --store-dir` starts on a folder that already holds files, so a store cleanup must not take
  // them with the store. A planted `jetstream/` beside them does not make the folder a store.
  const foreignRoot = meshRoot();
  const shared = mkdtempSync(join(tmpdir(), "cotal-shared-"));
  mkdirSync(join(shared, "jetstream", "$G"), { recursive: true });
  writeFileSync(join(shared, "report.txt"), "keep");
  mkdirSync(join(shared, "photos"));
  writeFileSync(join(shared, "photos", "a.jpg"), "keep");
  const sharedEntries = ["jetstream", "report.txt", join("photos", "a.jpg")];
  for (const dryRun of [false, true])
    await assert.rejects(
      () => removeLocalState(foreignRoot, { includeAuth: false, storeDir: shared, dryRun }),
      /also holds photos, report\.txt, which no Cotal store writes; nothing was removed/,
    );
  check("foreign entries: clean store and its dry run refuse, naming them, and remove nothing", sharedEntries.every((entry) => existsSync(join(shared, entry))));
  const decoy = mkdtempSync(join(tmpdir(), "cotal-decoy-"));
  mkdirSync(join(decoy, "jetstream"));
  writeFileSync(join(decoy, "jetstream", "stream.dat"), "x");
  writeFileSync(join(decoy, "notes.txt"), "keep");
  await assert.rejects(() => removeLocalState(foreignRoot, { includeAuth: false, storeDir: decoy }), /also holds notes\.txt/);
  check("foreign entries: a planted jetstream/ beside a file is not a store", existsSync(join(decoy, "notes.txt")) && existsSync(join(decoy, "jetstream", "stream.dat")));
  if (process.platform !== "win32") {
    const linked = mkdtempSync(join(tmpdir(), "cotal-linked-"));
    writeFileSync(join(linked, ".cotal-store-id"), `${randomUUID()}\n`);
    symlinkSync(shared, join(linked, "jetstream"));
    await assert.rejects(() => removeLocalState(foreignRoot, { includeAuth: false, storeDir: linked }), /also holds jetstream,/);
    check("foreign entries: a jetstream link is not a store entry", existsSync(join(linked, "jetstream")) && existsSync(join(shared, "report.txt")));
    rmSync(linked, { recursive: true, force: true });
  }
  writeFileSync(join(foreignRoot, ".cotal", "nats", "notes.txt"), "keep");
  await assert.rejects(() => removeLocalState(foreignRoot, { includeAuth: true }), /also holds notes\.txt/);
  check("foreign entries: in .cotal/nats, clean all removes nothing, identity included", existsSync(join(foreignRoot, ".cotal", "nats", "notes.txt")) && existsSync(join(foreignRoot, ".cotal", "auth", "auth.json")));
  const warnings: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    warnForeignStoreEntries(shared);
    warnForeignStoreEntries(join(foreignRoot, ".cotal", "agents", "missing"));
    rmSync(join(foreignRoot, ".cotal", "nats", "notes.txt"));
    warnForeignStoreEntries(join(foreignRoot, ".cotal", "nats"));
  } finally {
    console.error = consoleError;
  }
  check("up --store-dir: warns once, naming the entries beside the store, and not for a store or a new path", warnings.length === 1 && /--store-dir .* also holds photos, report\.txt; /.test(warnings[0] ?? ""), warnings);
  rmSync(foreignRoot, { recursive: true, force: true });
  rmSync(shared, { recursive: true, force: true });
  rmSync(decoy, { recursive: true, force: true });

  // --- a store folder another space uses is refused, and nothing in it is removed -------------
  // nats-server takes no lock on its store folder, so another space's broker can share one. That
  // space's streams in it, or its registration naming it, make a cleanup refuse.
  const tenantRoot = meshRoot();
  const tenancy = mkdtempSync(join(tmpdir(), "cotal-tenancy-"));
  for (const [account, space] of [["ACDEMO", "demo"], ["ACOTHER", "other"]])
    for (const stream of ["CHAT", "DM", "TASK"]) mkdirSync(join(tenancy, "jetstream", account, "streams", `${stream}_${space}`), { recursive: true });
  for (const dryRun of [false, true])
    await assert.rejects(
      () => removeLocalState(tenantRoot, { includeAuth: false, space: "demo", storeDir: tenancy, dryRun }),
      /also belongs to space other \(streams CHAT_other, DM_other, TASK_other\), and removing it would delete that data too; nothing was removed/,
    );
  await assert.rejects(() => removeLocalState(tenantRoot, { includeAuth: true, storeDir: tenancy }), /space other \(streams CHAT_other/);
  check("another space's streams: clean store, its dry run and clean all refuse, naming them, and remove nothing", existsSync(join(tenancy, "jetstream", "ACOTHER")) && existsSync(join(tenantRoot, ".cotal", "auth", "auth.json")));
  rmSync(join(tenancy, "jetstream", "ACOTHER"), { recursive: true });
  const tenantRegistered = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-tenancy-root-")));
  recordMesh({ space: "regd", server: "nats://127.0.0.1:1", root: tenantRegistered, mode: "auth", origin: "up", storeDir: tenancy, ts: "2026-10-24T00:00:00.000Z" });
  await assert.rejects(() => removeLocalState(tenantRoot, { includeAuth: false, space: "demo", storeDir: tenancy }), (error: Error) => error.message.includes(`also belongs to space regd at ${tenantRegistered},`));
  removeMesh("regd");
  const removedOwn = await removeLocalState(tenantRoot, { includeAuth: false, space: "demo", storeDir: tenancy });
  check("another space's registration naming the folder refuses too; a folder with only this space's streams is removed", !existsSync(tenancy) && removedOwn.length === 1, removedOwn);
  rmSync(tenantRoot, { recursive: true, force: true });
  rmSync(tenantRegistered, { recursive: true, force: true });

  // --- the broker's own ocsp folder is part of the store ----------------------------------------
  // nats-server makes `ocsp` in its store directory on every configuration reload, as a restore's
  // does, so `up` does not warn about it and `clean store` removes it with the store.
  const ocspRoot = meshRoot();
  mkdirSync(join(ocspRoot, ".cotal", "nats", "ocsp"));
  const ocspWarnings: string[] = [];
  console.error = (...args: unknown[]) => { ocspWarnings.push(args.join(" ")); };
  try { warnForeignStoreEntries(join(ocspRoot, ".cotal", "nats")); }
  finally { console.error = consoleError; }
  const ocspRemoved = await removeLocalState(ocspRoot, { includeAuth: false });
  check("ocsp: up does not warn about the broker's ocsp folder, and clean store removes it with the store",
    ocspWarnings.length === 0 && ocspRemoved[0] === ".cotal/nats (JetStream store: jetstream, ocsp)" && !existsSync(join(ocspRoot, ".cotal", "nats")), { ocspWarnings, ocspRemoved });
  rmSync(ocspRoot, { recursive: true, force: true });

  // --- --dry-run lists what store/all would remove and removes nothing ------------------------
  const dryRoot = meshRoot();
  writeFileSync(join(dryRoot, ".cotal", "nats", ".cotal-store-id"), `${randomUUID()}\n`);
  const listed = await removeLocalState(dryRoot, { includeAuth: true, dryRun: true });
  check("dry run: lists the store with its entries", listed[0] === ".cotal/nats (JetStream store: .cotal-store-id, jetstream)", listed);
  check("dry run: removes nothing", existsSync(join(dryRoot, ".cotal", "nats", "jetstream", "stream.dat")) && existsSync(join(dryRoot, ".cotal", "auth", "auth.json")) && DERIVED.every((f) => existsSync(join(dryRoot, ".cotal", f))));
  const removedAfterDry = await removeLocalState(dryRoot, { includeAuth: true });
  check("dry run: lists what the real run then removes", JSON.stringify(listed) === JSON.stringify(removedAfterDry), { listed, removedAfterDry });
  await assert.rejects(() => clean({ positionals: ["history"], values: { "dry-run": true }, raw: [] }), /--dry-run previews clean store and clean all only/);
  rmSync(dryRoot, { recursive: true, force: true });

  const empty = mkdtempSync(join(tmpdir(), "cotal-empty-"));
  check("already clean: removes nothing, throws nothing", (await removeLocalState(empty, { includeAuth: true })).length === 0);
  check("already clean: no live process reported", liveMeshProcess(empty) === undefined);
  rmSync(empty, { recursive: true, force: true });

  // --- seam ordering: a failed store delete must abort BEFORE the identity is wiped -----------
  // Force the failure the way the store actually fails: `delivery.creds` (a MIGRATED kind, so
  // `clean all` deletes it through the SecretStore, never a raw rm) as a NON-EMPTY DIRECTORY —
  // FsSecretStore.delete's non-recursive rmSync throws. The reset must throw, leave the local
  // identity (auth.json) intact for the retry, and name the retry.
  const seamRoot = meshRoot();
  rmSync(join(seamRoot, ".cotal", "delivery.creds"));
  mkdirSync(join(seamRoot, ".cotal", "delivery.creds"));
  writeFileSync(join(seamRoot, ".cotal", "delivery.creds", "occupant"), "x");
  let seamErr = "";
  try {
    await removeLocalState(seamRoot, { includeAuth: true });
  } catch (e) {
    seamErr = (e as Error).message;
  }
  check("seam: a failed store delete throws, naming the retry", /deprovision failed/.test(seamErr) && /re-run/.test(seamErr), seamErr);
  check("seam: the local identity survives the failed reset (no split authority)", existsSync(join(seamRoot, ".cotal", "auth", "auth.json")));
  // The RAW identity removal (auth + the raw-rm derived list) must not run once a seam delete fails.
  // Proxy on a RAW kind (`membership-observer.creds`, a static $SYS cred still swept by rm): `delivery.creds`
  // and `membership-rw.creds` are MIGRATED kinds deleted in the same seam loop, so — like the per-agent
  // seam kinds — they may be swept before the abort; only the identity + raw list are gated (checked here).
  check("seam: the raw identity removal never ran (a raw-swept cred survives)", existsSync(join(seamRoot, ".cotal", "membership-observer.creds")));
  rmSync(seamRoot, { recursive: true, force: true });

  // --- the ONE shared pidfile probe (down/clean/status all ride pidfileState) -----------------
  // Empty/corrupt parses to 0 or NaN -> "bad pidfile", never `running (pid 0)` (POSIX kill(0, 0)
  // probes our own process group); EPERM -> ALIVE (POSIX pid 1 always exists; as non-root the
  // probe raises EPERM, and deleting state under a process we merely can't signal breaks the
  // core guarantee - while `status` must not call it stale and contradict `clean`'s refusal).
  const probeDir = mkdtempSync(join(tmpdir(), "cotal-probe-"));
  check("probe: missing pidfile", pidfileState(join(probeDir, "nope.pid")).note === "no pidfile");
  writeFileSync(join(probeDir, "empty.pid"), "");
  check("probe: empty pidfile is 'bad pidfile', not pid 0", pidfileState(join(probeDir, "empty.pid")).note === "bad pidfile");
  writeFileSync(join(probeDir, "junk.pid"), "abc");
  check("probe: garbage pidfile is 'bad pidfile'", pidfileState(join(probeDir, "junk.pid")).note === "bad pidfile");
  writeFileSync(join(probeDir, "self.pid"), String(process.pid));
  check("probe: a live pid reads alive", pidfileState(join(probeDir, "self.pid")).liveness === "alive");
  // The probe reads through the shared `readPidfile`, so a record it cannot read throws naming it.
  mkdirSync(join(probeDir, "dir.pid"));
  let unreadable = "";
  try { pidfileState(join(probeDir, "dir.pid")); } catch (e) { unreadable = (e as Error).message; }
  check("probe: an unreadable pidfile throws naming its path", unreadable.includes(join(probeDir, "dir.pid")), unreadable);
  if (process.platform !== "win32") {
    writeFileSync(join(probeDir, "init.pid"), "1");
    check("probe: an unsignalable pid (EPERM) reads ALIVE", pidfileState(join(probeDir, "init.pid")).liveness === "alive");
    const epermRoot = meshRoot();
    writeFileSync(join(epermRoot, ".cotal", "nats.pid"), "1");
    check("a pid we cannot signal (EPERM) still blocks cleanup", /pid 1$/.test(liveMeshProcess(epermRoot) ?? ""), liveMeshProcess(epermRoot));
    rmSync(epermRoot, { recursive: true, force: true });
  }
  rmSync(probeDir, { recursive: true, force: true });

  // --- `clean all` drops ONLY registry entries rooted at THIS project -------------------------
  // A named OPEN mesh has no .cotal/auth, so a space-name lookup would resolve to the default
  // space ("main") and delete an unrelated mesh's registry entry - the drop must key on root.
  const openRoot = mkdtempSync(join(tmpdir(), "cotal-open-"));
  mkdirSync(join(openRoot, ".cotal", "nats", "jetstream"), { recursive: true });
  writeFileSync(join(openRoot, ".cotal", "nats", "jetstream", "s.dat"), "x");
  const otherRoot = mkdtempSync(join(tmpdir(), "cotal-other-"));
  const entry = (space: string, root: string) =>
    ({ space, server: "nats://127.0.0.1:1", root, mode: "open" as const, ts: "2026-07-09T00:00:00.000Z" });
  recordMesh(entry("named-open", openRoot));
  recordMesh(entry("main", otherRoot));
  setCurrent("named-open");
  const cwd = process.cwd();
  const consoleWarn = console.error;
  const notes: string[] = [];
  console.error = (...args: unknown[]) => { notes.push(args.map(String).join(" ")); };
  process.chdir(openRoot);
  try {
    await clean({ positionals: ["all"], values: { force: true }, raw: [] });
  } finally {
    console.error = consoleWarn;
    process.chdir(cwd); // chdir out BEFORE the rm (Windows EBUSY on a deleted cwd)
  }
  check("all: drops THIS root's registry entry, not the default space's", loadMeshes().map((m) => m.space).join(",") === "main", loadMeshes());
  check("all: releases the `current` pointer it held", getCurrent() !== "named-open", getCurrent());
  check("all: an open root holds no space trust, so it says nothing about backups", !notes.some((note) => note.includes("full backups")), notes);
  rmSync(openRoot, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });

  // A full backup is bound to the space trust, so a `clean all` that removes it says, in its dry run
  // and in its receipt, that the full backups taken before it no longer restore into this root.
  const trustRoot = meshRoot();
  notes.length = 0;
  console.error = (...args: unknown[]) => { notes.push(args.map(String).join(" ")); };
  process.chdir(trustRoot);
  try {
    await clean({ positionals: ["all"], values: { "dry-run": true }, raw: [] });
    await clean({ positionals: ["all"], values: { force: true }, raw: [] });
  } finally {
    console.error = consoleWarn;
    process.chdir(cwd);
  }
  check("all: removing the space trust says, in the dry run and the receipt, that earlier full backups no longer restore here",
    notes.length === 2 && /full backups taken before this clean would no longer restore into this root/.test(notes[0] ?? "") && /full backups taken before this clean no longer restore into this root.*Take a new full backup/.test(notes[1] ?? ""), notes);
  rmSync(trustRoot, { recursive: true, force: true });

  // A user-auth space's state directory holds its pinned IdP and its actor ledger. `clean all` names
  // them, in its dry run and in its receipt, with what a later up needs.
  const userAuthRoot = meshRoot();
  const userAuthDir = join(userAuthRoot, ".cotal", "auth", spaceSegment("demo"));
  mkdirSync(join(userAuthDir, "actors"), { recursive: true });
  writeFileSync(join(userAuthDir, "idp.json"), "{}");
  writeFileSync(join(userAuthDir, "actors", "u_a.anna.json"), "{}");
  const userAuthOut: string[] = [];
  notes.length = 0;
  const consoleOut = console.log;
  console.log = (...args: unknown[]) => { userAuthOut.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { notes.push(args.map(String).join(" ")); };
  process.chdir(userAuthRoot);
  try {
    await clean({ positionals: ["all"], values: { "dry-run": true }, raw: [] });
    await clean({ positionals: ["all"], values: { force: true }, raw: [] });
  } finally {
    console.log = consoleOut;
    console.error = consoleWarn;
    process.chdir(cwd);
  }
  const labeled = `.cotal/auth/${spaceSegment("demo")} (IdP trust and actor ledger)`;
  check("all: a user-auth space's state directory is named as its IdP trust and actor ledger, in the dry run and the receipt",
    userAuthOut.some((line) => line.includes(`would remove ${labeled}`)) && userAuthOut.some((line) => line.includes(`removed ${labeled}`)), userAuthOut);
  check("all: the dry run and the receipt say every actor grant is lost and what a later up needs",
    /would remove the IdP trust and the actor ledger.*would need cotal up --user-auth --idp <auth base URL>/.test(notes[0] ?? "") && /removed the IdP trust and the actor ledger.*every actor grant is lost.*needs cotal up --user-auth --idp <auth base URL>/.test(notes[2] ?? ""), notes);
  check("all: the receipt names the up a user-auth space needs for its fresh identity",
    userAuthOut.some((line) => line.includes("minted on the next `cotal up --user-auth --idp <auth base URL>`")), userAuthOut);
  check("all: the user-auth state directory is gone", !existsSync(userAuthDir));
  rmSync(userAuthRoot, { recursive: true, force: true });

  // Without --store-dir, clean reads the record a start reads: while the default store holds no data,
  // the store the last broker served, named in the broker config `up` wrote, is this root's store.
  const printed: string[] = [];
  const consoleLog = console.log;
  const cleanStore = async (root: string, values: Record<string, boolean>) => {
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
    process.chdir(root);
    try { await clean({ positionals: ["store"], values, raw: [] }); }
    finally { console.log = consoleLog; process.chdir(cwd); }
  };
  const servedStore = (root: string) => {
    const store = mkdtempSync(join(tmpdir(), "cotal-served-"));
    mkdirSync(join(store, "jetstream"));
    writeFileSync(join(store, "jetstream", "stream.dat"), "x");
    writeFileSync(join(root, ".cotal", "auth", "server.conf"), `jetstream { store_dir: ${JSON.stringify(store)} }\n`);
    return realpathSync.native(store);
  };
  const servedRoot = meshRoot();
  rmSync(join(servedRoot, ".cotal", "nats"), { recursive: true });
  const served = servedStore(servedRoot);
  await cleanStore(servedRoot, { "dry-run": true });
  check("store: with no data in .cotal/nats, the dry run names the store the last broker served", printed.some((line) => line.includes(`would remove ${served} (JetStream store`)) && existsSync(served), printed);
  printed.length = 0;
  await cleanStore(servedRoot, { force: true });
  check("store: and removes it, instead of saying there is nothing to clean", !existsSync(served) && printed.some((line) => line.includes(`removed ${served}`)), printed);
  rmSync(servedRoot, { recursive: true, force: true });
  const bothRoot = meshRoot();
  const other = servedStore(bothRoot);
  printed.length = 0;
  await cleanStore(bothRoot, { force: true });
  check("store: while .cotal/nats holds data, as a start would open, that store is removed and the other is kept", !existsSync(join(bothRoot, ".cotal", "nats")) && existsSync(join(other, "jetstream", "stream.dat")), printed);
  rmSync(bothRoot, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });

  // A retained bare `down` reaches its pidfile sweep only for one registration that `cotal up`
  // started at this root, and refuses when another registration names the same broker address
  // (docs/cli.md, `down`). `up` records `origin: "up"` and the broker it started, so every stack the
  // `down` cells below stop is recorded that way, each on its own closed loopback port. "main" keeps
  // port 1 from the `clean all` cells above.
  const upEntry = (space: string, root: string, port: number) =>
    ({ ...entry(space, root), server: `nats://127.0.0.1:${port}`, origin: "up" as const });

  // --- `down` must NOT erase the record of a process it cannot stop (EPERM) -------------------
  // The e2e chain the cleanup guard protects: an unsignalable live broker + `cotal down` +
  // `cotal clean store` must end in a REFUSAL - if `down` swallowed the EPERM and dropped the
  // pidfile ("was not running"), the later clean would delete the store under the live process.
  if (process.platform !== "win32") {
    const downRoot = meshRoot();
    writeFileSync(join(downRoot, ".cotal", "nats.pid"), "1"); // pid 1: alive, unsignalable as non-root
    writeFileSync(join(downRoot, ".cotal", "nats.pid.identity"), `1 ${defaultStartToken(1)}`); // #969: pin what a real up pins, so the graded refusal is the EPERM one
    recordMesh(upEntry("eperm-mesh", downRoot, 2));
    process.exitCode = 0;
    const cwd2 = process.cwd();
    process.chdir(downRoot);
    try {
      await down({ positionals: [], values: {}, raw: [] });
    } finally {
      process.chdir(cwd2); // chdir out BEFORE the rm (Windows EBUSY on a deleted cwd)
    }
    check("down: a failed stop sets a failing exit code", process.exitCode === 1);
    process.exitCode = 0; // reset - the smoke's own verdict decides the final exit
    check("down: keeps the unsignalable process's pidfile", existsSync(join(downRoot, ".cotal", "nats.pid")));
    check("down: keeps the registry entry", loadMeshes().some((m) => m.space === "eperm-mesh"));
    check("down: keeps control-plane artifacts", existsSync(join(downRoot, ".cotal", "delivery.creds")));
    check("down: subsequent cleanup still refuses", /nats-server, pid 1$/.test(liveMeshProcess(downRoot) ?? ""), liveMeshProcess(downRoot));
    removeMesh("eperm-mesh");
    rmSync(downRoot, { recursive: true, force: true });

    const blockedRoot = meshRoot();
    const blockedBroker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    writeFileSync(join(blockedRoot, ".cotal", "manager.pid"), "1");
    writeFileSync(join(blockedRoot, ".cotal", "manager.pid.identity"), `1 ${defaultStartToken(1)}`);
    writeFileSync(join(blockedRoot, ".cotal", "nats.pid"), String(blockedBroker.pid));
    recordMesh(upEntry("blocked-down", blockedRoot, 3));
    process.exitCode = 0;
    process.chdir(blockedRoot);
    try {
      await down({ positionals: [], values: {}, raw: [] });
    } finally {
      process.chdir(cwd2);
    }
    check("down: a failed dependent prevents the broker stop", blockedBroker.exitCode === null);
    check("down: a failed dependent preserves the mesh registry", loadMeshes().some((m) => m.space === "blocked-down"));
    blockedBroker.kill("SIGKILL");
    await new Promise((resolve) => blockedBroker.once("exit", resolve));
    process.exitCode = 0;
    removeMesh("blocked-down");
    rmSync(blockedRoot, { recursive: true, force: true });
  }

  // --- successful `down` drops registry entries by ROOT, not by resolved space ----------------
  // Same class as the `clean all` fix: a named OPEN mesh (no .cotal/auth) resolves to the
  // default space, so a space-name key would delete the unrelated "main" entry and leave the
  // stopped mesh recorded (and `current`) as a ghost.
  const openRoot2 = mkdtempSync(join(tmpdir(), "cotal-open2-"));
  mkdirSync(join(openRoot2, ".cotal", "nats"), { recursive: true });
  writeFileSync(join(openRoot2, ".cotal", "nats", "s.dat"), "x");
  writeFileSync(join(openRoot2, ".cotal", "delivery.creds"), "x");
  const broker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  writeFileSync(join(openRoot2, ".cotal", "nats.pid"), String(broker.pid));
  // #969: a real `up` pins the pid to its process start; the planted record must match that shape
  // or the identity gate correctly refuses it as a legacy record.
  writeFileSync(join(openRoot2, ".cotal", "nats.pid.identity"), `${broker.pid} ${defaultStartToken(broker.pid ?? 0)}`);
  recordMesh(upEntry("named-open-2", openRoot2, 4)); // "main" (unrelated root) is still recorded from above
  setCurrent("named-open-2");
  process.exitCode = 0;
  const cwd3 = process.cwd();
  process.chdir(openRoot2);
  try {
    await down({ positionals: [], values: {}, raw: [] });
  } finally {
    process.chdir(cwd3); // chdir out BEFORE the rm (Windows EBUSY on a deleted cwd)
  }
  check("down: a clean stop keeps a zero exit code", (process.exitCode ?? 0) === 0, process.exitCode);
  check("down: drops THIS root's registry entry on success", !loadMeshes().some((m) => m.space === "named-open-2"), loadMeshes());
  check("down: leaves the unrelated default-space entry alone", loadMeshes().some((m) => m.space === "main"));
  check("down: releases the `current` pointer", getCurrent() !== "named-open-2", getCurrent());
  check("down: sweeps control-plane artifacts on success", !existsSync(join(openRoot2, ".cotal", "delivery.creds")));
  rmSync(openRoot2, { recursive: true, force: true });

  console.log(`\nCLEAN SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exit(1);
}

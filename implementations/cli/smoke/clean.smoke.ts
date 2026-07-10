/**
 * `cotal clean` local-state targets (`store`/`all`) — hermetic, no broker needed.
 * Run: pnpm smoke:clean
 *
 * Covers: the live-process guard (a running recorded pid refuses cleanup; a STALE or corrupt
 * pidfile does not; an EPERM-unsignalable pid DOES), the `store` removal set (JetStream store
 * only), the `all` removal set (store + auth + every derived local cred + crash residue: stale
 * pidfiles, run/), that personas/logs survive, the `--store-dir` override, the already-clean
 * no-op, and that `clean all` drops only registry entries rooted at THIS project (a named open
 * mesh must never delete the default space's entry).
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the machine-home BEFORE importing anything registry-touching (`clean all` mutates
// ~/.cotal/meshes) - homeCotalDir() reads COTAL_HOME per call, so the real one is never touched.
const home = mkdtempSync(join(tmpdir(), "cotal-clean-home-"));
process.env.COTAL_HOME = home;

const { clean, liveMeshProcess, removeLocalState } = await import("../src/commands/clean.js");
const { down, pidfileState } = await import("../src/commands/down.js");
const { getCurrent, loadMeshes, recordMesh, removeMesh, setCurrent } = await import("@cotal-ai/workspace");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** Every identity-derived file `clean all` must sweep (mirrors removeLocalState's list). */
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

  // --- `store` removes exactly the JetStream store -------------------------------------------
  const storeRoot = meshRoot();
  const removedStore = removeLocalState(storeRoot, { includeAuth: false });
  check("store: removes the JetStream store", removedStore.some((r) => r.includes("nats")) && !existsSync(join(storeRoot, ".cotal", "nats")));
  check("store: auth + derived creds survive", existsSync(join(storeRoot, ".cotal", "auth", "auth.json")) && existsSync(join(storeRoot, ".cotal", "delivery.creds")));
  check("store: personas survive", existsSync(join(storeRoot, ".cotal", "agents", "default.md")));
  rmSync(storeRoot, { recursive: true, force: true });

  // --- `all` removes store + identity + derived creds + crash residue ------------------------
  const allRoot = meshRoot();
  writeFileSync(join(allRoot, ".cotal", "nats.pid"), "999999"); // stale pidfile from a crash
  const removedAll = removeLocalState(allRoot, { includeAuth: true });
  check("all: removes store + auth", !existsSync(join(allRoot, ".cotal", "nats")) && !existsSync(join(allRoot, ".cotal", "auth")));
  for (const f of DERIVED) check(`all: removes derived ${f}`, !existsSync(join(allRoot, ".cotal", f)));
  check("all: sweeps stale pidfiles", !existsSync(join(allRoot, ".cotal", "nats.pid")));
  check("all: sweeps run/ launch artifacts", !existsSync(join(allRoot, ".cotal", "run")));
  check("all: personas survive", existsSync(join(allRoot, ".cotal", "agents", "default.md")));
  check("all: logs are left alone", existsSync(join(allRoot, ".cotal", "nats.log")));
  check("all: reports what it removed", removedAll.length >= 9, removedAll);

  // --- `--store-dir` override + already-clean no-op ------------------------------------------
  const customRoot = meshRoot();
  const customStore = mkdtempSync(join(tmpdir(), "cotal-store-"));
  writeFileSync(join(customStore, "stream.dat"), "x");
  const removedCustom = removeLocalState(customRoot, { includeAuth: false, storeDir: customStore });
  check("--store-dir: removes the OVERRIDE dir, not .cotal/nats", !existsSync(customStore) && existsSync(join(customRoot, ".cotal", "nats")));
  check("--store-dir: reports the explicit path", removedCustom.some((r) => r.includes(customStore)));
  rmSync(customRoot, { recursive: true, force: true });

  const empty = mkdtempSync(join(tmpdir(), "cotal-empty-"));
  check("already clean: removes nothing, throws nothing", removeLocalState(empty, { includeAuth: true }).length === 0);
  check("already clean: no live process reported", liveMeshProcess(empty) === undefined);
  rmSync(empty, { recursive: true, force: true });

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
  check("probe: a live pid reads alive", pidfileState(join(probeDir, "self.pid")).live === true);
  if (process.platform !== "win32") {
    writeFileSync(join(probeDir, "init.pid"), "1");
    check("probe: an unsignalable pid (EPERM) reads ALIVE", pidfileState(join(probeDir, "init.pid")).live === true);
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
  mkdirSync(join(openRoot, ".cotal", "nats"), { recursive: true });
  writeFileSync(join(openRoot, ".cotal", "nats", "s.dat"), "x");
  const otherRoot = mkdtempSync(join(tmpdir(), "cotal-other-"));
  const entry = (space: string, root: string) =>
    ({ space, server: "nats://127.0.0.1:1", root, mode: "open" as const, ts: "2026-07-09T00:00:00.000Z" });
  recordMesh(entry("named-open", openRoot));
  recordMesh(entry("main", otherRoot));
  setCurrent("named-open");
  const cwd = process.cwd();
  process.chdir(openRoot);
  try {
    await clean({ positionals: ["all"], values: { force: true }, raw: [] });
  } finally {
    process.chdir(cwd); // chdir out BEFORE the rm (Windows EBUSY on a deleted cwd)
  }
  check("all: drops THIS root's registry entry, not the default space's", loadMeshes().map((m) => m.space).join(",") === "main", loadMeshes());
  check("all: releases the `current` pointer it held", getCurrent() !== "named-open", getCurrent());
  rmSync(openRoot, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });

  // --- `down` must NOT erase the record of a process it cannot stop (EPERM) -------------------
  // The e2e chain the cleanup guard protects: an unsignalable live broker + `cotal down` +
  // `cotal clean store` must end in a REFUSAL - if `down` swallowed the EPERM and dropped the
  // pidfile ("was not running"), the later clean would delete the store under the live process.
  if (process.platform !== "win32") {
    const downRoot = meshRoot();
    writeFileSync(join(downRoot, ".cotal", "nats.pid"), "1"); // pid 1: alive, unsignalable as non-root
    recordMesh(entry("eperm-mesh", downRoot));
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
  }

  console.log(`\nCLEAN SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exit(1);
}

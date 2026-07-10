/**
 * `cotal clean` local-state targets (`store`/`all`) — hermetic, no broker needed.
 * Run: pnpm smoke:clean
 *
 * Covers: the live-process guard (a running recorded pid refuses cleanup; a STALE pidfile does
 * not), the `store` removal set (JetStream store only), the `all` removal set (store + auth +
 * every derived local cred), that personas/logs survive, the `--store-dir` override, and the
 * already-clean no-op.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { liveMeshProcess, removeLocalState } = await import("../src/commands/clean.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** A project root whose `.cotal/` looks like a stopped mesh's leftovers. */
function meshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cotal-clean-"));
  const dot = join(root, ".cotal");
  mkdirSync(join(dot, "nats", "jetstream"), { recursive: true });
  writeFileSync(join(dot, "nats", "jetstream", "stream.dat"), "x");
  mkdirSync(join(dot, "auth", "creds"), { recursive: true });
  writeFileSync(join(dot, "auth", "auth.json"), JSON.stringify({ space: "demo" }));
  mkdirSync(join(dot, "agents"), { recursive: true });
  writeFileSync(join(dot, "agents", "default.md"), "# default\n");
  for (const f of ["delivery.creds", "membership-rw.creds", "membership.json", "renewal.json", "nats.log"])
    writeFileSync(join(dot, f), "x");
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
  rmSync(guarded, { recursive: true, force: true });

  // --- `store` removes exactly the JetStream store -------------------------------------------
  const storeRoot = meshRoot();
  const removedStore = removeLocalState(storeRoot, { includeAuth: false });
  check("store: removes the JetStream store", removedStore.some((r) => r.includes("nats")) && !existsSync(join(storeRoot, ".cotal", "nats")));
  check("store: auth + derived creds survive", existsSync(join(storeRoot, ".cotal", "auth", "auth.json")) && existsSync(join(storeRoot, ".cotal", "delivery.creds")));
  check("store: personas survive", existsSync(join(storeRoot, ".cotal", "agents", "default.md")));
  rmSync(storeRoot, { recursive: true, force: true });

  // --- `all` removes store + identity + derived creds ----------------------------------------
  const allRoot = meshRoot();
  const removedAll = removeLocalState(allRoot, { includeAuth: true });
  check("all: removes store + auth", !existsSync(join(allRoot, ".cotal", "nats")) && !existsSync(join(allRoot, ".cotal", "auth")));
  for (const f of ["delivery.creds", "membership-rw.creds", "membership.json", "renewal.json"])
    check(`all: removes derived ${f}`, !existsSync(join(allRoot, ".cotal", f)));
  check("all: personas survive", existsSync(join(allRoot, ".cotal", "agents", "default.md")));
  check("all: logs are left alone", existsSync(join(allRoot, ".cotal", "nats.log")));
  check("all: reports what it removed", removedAll.length >= 6, removedAll);

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

  console.log(`\nCLEAN SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exit(1);
}

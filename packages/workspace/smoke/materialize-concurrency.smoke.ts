/**
 * Concurrency + idempotency smoke for importInstalledExtension (no NATS). Run:
 * pnpm smoke:materialize-concurrency
 *
 * A factory publishes its whole scope once. Concurrent callers for that scope must both succeed,
 * and sequential callers must reuse it, without accepting a factory that omits an advertised key.
 *
 * Writes factory packages and an installed manifest in an isolated cotal config home.
 */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { registry, type ExtensionRef } from "@cotal-ai/core";
import {
  breakLock,
  claimExtensionMutationLockAsync,
  claimExtensionUpdatePass,
  extensionMutationLockPath,
  extensionsDir,
  importInstalledExtension,
  installedExtensionPackage,
  loadExtensionsManifest,
  readPluginDeclaration,
  reconcileExtensionScopes,
  saveExtensionsManifest,
  type InstalledExtension,
} from "@cotal-ai/workspace";
import { writePluginFixture } from "../../../scripts/plugin-fixture.mjs";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const tmp = mkdtempSync(join(import.meta.dirname, ".mat-concurrency-"));
process.env.XDG_CONFIG_HOME = tmp;

/** Spawn a child that runs `body` (after `release` is bound) and print "held" once it holds the lock for `ms`. */
function spawnHolder(lockExpr: string, ms: number) {
  const child = spawn(
    process.execPath,
    [
      "--import", "tsx", "--input-type=module", "-e",
      `import { rmSync, writeFileSync } from "node:fs";
       import { acquireLock, extensionMutationLockPath, processStartToken } from "@cotal-ai/workspace";
       const held = ${lockExpr};
       console.log("held");
       setTimeout(() => { held.release(); process.exit(0); }, ${ms});`,
    ],
    { cwd: import.meta.dirname, env: process.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("held") && resolve());
    child.on("error", reject);
    child.on("exit", () => reject(new Error("holder exited before holding the lock")));
  });
  return { child, ready };
}

/** A writer-lock record whose owner is dead, so the next acquirer must reclaim it. */
function writeStaleWriterRecord(lockPath: string): void {
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  mkdirSync(join(lockPath, ".."), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({ pid: deadPid, nonce: "stale", ts: Date.now() })}\n`);
}

/** Holder body: publish a live `.reclaim` sentinel (a reclaimer mid-reclaim) and remove it on release. */
const sentinelHolderExpr = `(() => {
  const sentinel = extensionMutationLockPath() + ".reclaim";
  writeFileSync(sentinel, JSON.stringify({ pid: process.pid, start: processStartToken(process.pid), nonce: "reclaimer", ts: Date.now() }) + "\\n");
  return { release: () => rmSync(sentinel, { force: true }) };
})()`;

let seq = 0;
/** Write a factory package and publish its cached declarations in the installed manifest. */
function fakePackage(declared: ExtensionRef[], registered = declared): InstalledExtension {
  const installId = `mat-${++seq}`;
  const pkg = `@fake/${installId}`;
  const metadata = (ref: ExtensionRef) => ({ ...ref, ...(ref.kind === "command" ? { summary: "Fixture command" } : {}) });
  const dir = join(extensionsDir(), "node_modules", ...pkg.split("/"));
  const version = "1.0.0";
  const entries = registered.map((ref) => {
    const json = JSON.stringify(metadata(ref));
    return ref.kind === "command" ? `{ ...${json}, run: async () => {} }` : json;
  });
  writePluginFixture(dir, {
    name: pkg, version, provides: declared.map(metadata),
    factorySource: `export default (host) => host.register(${entries.join(", ")});\n`,
  });
  const { provides, commands, connectors, localProcesses, servicePresets } = readPluginDeclaration(installedExtensionPackage(pkg)?.cotal);
  const row = { pkg, version, installId, spec: ".", provides, commands, connectors, localProcesses, servicePresets };
  saveExtensionsManifest({ extensions: [...loadExtensionsManifest().extensions, row] });
  return row;
}

function prefixIdentity(path: string) {
  const stat = lstatSync(path);
  return { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs };
}

async function assertPromotionKeepsScope(): Promise<void> {
  const ref: ExtensionRef = { kind: "connector", name: "during-promotion" };
  const ext = fakePackage([ref]);
  await importInstalledExtension(ext, ref);
  const loaded = registry.resolve(ref.kind, ref.name);
  const root = extensionsDir();
  const config = dirname(root);
  const stage = join(config, ".extensions.stage-smoke0.ready");
  const old = join(config, ".extensions.rollback-smoke");
  const journal = join(config, ".extensions-promotion.json");
  const release = await claimExtensionMutationLockAsync({ label: "promotion test" });
  try {
    cpSync(root, stage, { recursive: true });
    // Stop at the publication boundary: the verified stage and journal exist, but live has moved aside.
    writeFileSync(journal, JSON.stringify({ v: 1, root, stage, old, stageIdentity: prefixIdentity(stage), oldIdentity: prefixIdentity(root) }), { mode: 0o600 });
    renameSync(root, old);
    const snapshot = loadExtensionsManifest().extensions;
    assert.deepEqual(snapshot, [], "the live manifest is absent during promotion");
    assert.equal(reconcileExtensionScopes(), false, "the pending promotion must not retire the loaded scope");
    assert.equal(reconcileExtensionScopes(snapshot), false, "a supplied empty snapshot must also preserve the scope");
    assert.equal(registry.resolve(ref.kind, ref.name), loaded);
    renameSync(stage, root);
    rmSync(old, { recursive: true });
    rmSync(journal);
  } finally {
    release();
  }
  await importInstalledExtension(ext, ref);
  assert.equal(registry.resolve(ref.kind, ref.name), loaded, "an unchanged install keeps its scope after publication");
  saveExtensionsManifest({ extensions: loadExtensionsManifest().extensions.filter((row) => row.pkg !== ext.pkg) });
  assert.equal(reconcileExtensionScopes(), true, "an actual manifest removal retires the scope");
  assert.equal(registry.has(ref.kind, ref.name), false);
}

try {
  // 1. Two simultaneous first loads of the same provider reuse one factory scope.
  {
    const ref: ExtensionRef = { kind: "connector", name: "same" };
    const ext = fakePackage([ref]);
    const results = await Promise.allSettled([importInstalledExtension(ext, ref), importInstalledExtension(ext, ref)]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], `concurrent same-ref: ${JSON.stringify(results)}`);
    assert.equal(registry.resolve("connector", "same").name, "same");
  }

  // 2. Concurrent requests for distinct providers share the same package's complete scope.
  {
    const c: ExtensionRef = { kind: "connector", name: "dual" };
    const cmd: ExtensionRef = { kind: "command", name: "dual" };
    const ext = fakePackage([c, cmd]);
    const results = await Promise.allSettled([importInstalledExtension(ext, c), importInstalledExtension(ext, cmd)]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], `concurrent two-ref: ${JSON.stringify(results)}`);
    assert.equal(registry.resolve("connector", "dual").name, "dual");
    assert.equal(registry.resolve("command", "dual").name, "dual");
  }

  // 3. A sequential repeat keeps the original registration.
  {
    const ref: ExtensionRef = { kind: "connector", name: "repeat" };
    const ext = fakePackage([ref]);
    await importInstalledExtension(ext, ref);
    const loaded = registry.resolve(ref.kind, ref.name);
    await assert.doesNotReject(importInstalledExtension(ext, ref), "sequential repeat must be idempotent");
    assert.equal(registry.resolve(ref.kind, ref.name), loaded);
  }

  // 4. A factory that omits an advertised key publishes none of its registrations.
  {
    const present: ExtensionRef = { kind: "connector", name: "provided" };
    const absent: ExtensionRef = { kind: "connector", name: "absent" };
    const ext = fakePackage([present, absent], [present]);
    await assert.rejects(importInstalledExtension(ext, absent), /plugin factory does not match its cotal declaration/);
    assert.throws(() => registry.resolve(present.kind, present.name), /no connector registered/, "rejected factory leaked a key");
  }

  // 5. Materialization follows the same pass -> writer order as add/remove. This process holds the
  //    pass, so the load waits out its lock bound before refusing.
  {
    const ref: ExtensionRef = { kind: "connector", name: "pass-excluded" };
    const ext = fakePackage([ref]);
    const release = claimExtensionUpdatePass();
    try {
      await assert.rejects(
        importInstalledExtension(ext, ref),
        /another extension update or mutation is in progress/,
      );
    } finally {
      release();
    }
  }

  // 6. A load that meets a LIVE short-held mutation lock (another CLI process mid-load) queues behind it
  //    instead of refusing at once.
  {
    const ref: ExtensionRef = { kind: "connector", name: "queued" };
    const ext = fakePackage([ref]);
    const holder = spawnHolder(`acquireLock(extensionMutationLockPath(), { waitMs: 0 })`, 1500);
    try {
      await holder.ready;
      // The wait must not block the event loop: a 50 ms timer keeps firing while the load is queued.
      let ticks = 0;
      const timer = setInterval(() => ticks++, 50);
      try {
        await assert.doesNotReject(importInstalledExtension(ext, ref), "load must wait for a briefly held lock");
      } finally {
        clearInterval(timer);
      }
      assert.ok(ticks >= 10, `event loop was blocked while waiting for the lock (${ticks} timer ticks)`);
      assert.equal(registry.resolve("connector", "queued").name, "queued");
    } finally {
      holder.child.kill();
    }
  }

  // 7. One deadline covers the pass AND writer acquisitions. The pass is free after ~0.6 s but the writer
  //    stays held for 3 s, so a 1.5 s bound must refuse at ~1.5 s, not restart the clock for the writer.
  {
    const passHolder = spawnHolder(`acquireLock(extensionMutationLockPath() + ".update", { waitMs: 0 })`, 600);
    const writerHolder = spawnHolder(`acquireLock(extensionMutationLockPath(), { waitMs: 0 })`, 3000);
    try {
      await Promise.all([passHolder.ready, writerHolder.ready]);
      const started = Date.now();
      await assert.rejects(
        claimExtensionMutationLockAsync({ waitMs: 1500, label: "deadline test" }),
        /another extension mutation is in progress/,
      );
      const took = Date.now() - started;
      assert.ok(took >= 1400 && took < 2000, `refusal came after ${took} ms instead of the 1500 ms bound`);
    } finally {
      passHolder.child.kill();
      writerHolder.child.kill();
    }
  }

  // 8. A stale writer record behind a LIVE `.reclaim` sentinel (another process mid-reclaim) is contention
  //    too: the load waits for the reclaimer with awaited timers instead of spinning inside the synchronous
  //    acquire loop, so the event loop keeps running and the stale record is reclaimed afterwards.
  {
    const ref: ExtensionRef = { kind: "connector", name: "behind-reclaimer" };
    const ext = fakePackage([ref]);
    const lockPath = extensionMutationLockPath();
    writeStaleWriterRecord(lockPath);
    const reclaimer = spawnHolder(sentinelHolderExpr, 700);
    try {
      await reclaimer.ready;
      let ticks = 0;
      const timer = setInterval(() => ticks++, 50);
      try {
        await assert.doesNotReject(importInstalledExtension(ext, ref), "load must wait out a live reclaimer");
      } finally {
        clearInterval(timer);
      }
      assert.ok(ticks >= 8, `event loop was blocked behind the reclaimer (${ticks} timer ticks)`);
      assert.equal(registry.resolve("connector", "behind-reclaimer").name, "behind-reclaimer");
    } finally {
      reclaimer.child.kill();
      breakLock(lockPath);
    }
  }

  // 9. The same contention honours the deadline: a reclaimer outlasting a 1 s bound is refused at ~1 s with
  //    the timers still running, not after the reclaimer finishes.
  {
    const lockPath = extensionMutationLockPath();
    writeStaleWriterRecord(lockPath);
    const reclaimer = spawnHolder(sentinelHolderExpr, 4000);
    try {
      await reclaimer.ready;
      let ticks = 0;
      const timer = setInterval(() => ticks++, 50);
      const started = Date.now();
      try {
        await assert.rejects(
          claimExtensionMutationLockAsync({ waitMs: 1000, label: "reclaimer deadline test" }),
          /another extension mutation is in progress/,
        );
      } finally {
        clearInterval(timer);
      }
      const took = Date.now() - started;
      assert.ok(took >= 900 && took < 1500, `refusal came after ${took} ms instead of the 1000 ms bound`);
      assert.ok(ticks >= 10, `event loop was blocked behind the reclaimer (${ticks} timer ticks)`);
    } finally {
      reclaimer.child.kill();
      breakLock(lockPath);
    }
  }

  // 10. Lock-free readers must distinguish the transient promotion gap from a removal.
  await assertPromotionKeepsScope();

  console.log("materialize-concurrency.smoke: all assertions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
emitSentinel({ passed: cells(), failed: 0 });

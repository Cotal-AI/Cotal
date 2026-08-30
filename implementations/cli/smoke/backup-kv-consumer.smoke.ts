/**
 * Backup inventory must distinguish the stopped ordered consumer left by the sanctioned whole-KV
 * scan from an unsupported lookalike. Uses only a disposable broker and a manually completed
 * maintenance cut; it never starts or stops a Cotal stack.
 *
 * Run: pnpm smoke:backup-kv-consumer
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Bucket, KvWatchInclude } from "@nats-io/kv/internal";
import {
  isReachable,
  liveKvEntries,
  openChannelRegistry,
  setupSpaceStreams,
} from "@cotal-ai/core";
import {
  acquireMaintenanceLock,
  beginMaintenanceCut,
  completeMaintenanceCut,
  recordPreservationManagerCommit,
  releaseMaintenanceLock,
  writeMaintenanceResumeDocument,
} from "@cotal-ai/workspace";
import { backup } from "../src/commands/backup.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve((address as { port: number }).port));
  });
});
const awaitExit = (proc: ChildProcess, timeoutMs = 5_000): Promise<void> => new Promise((resolve) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
  proc.once("exit", () => resolve());
  setTimeout(resolve, timeoutMs);
});

type Residue = "kv-scan" | "wrong-filter";

async function preservedFixture(label: string, residue: Residue): Promise<{
  root: string;
  artifact: string;
  cleanup(): Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}backup-kv-${label}-`));
  const store = join(root, ".cotal", "nats");
  mkdirSync(store, { recursive: true });
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = `backup_kv_${label}`;
  const config = join(root, "server.conf");
  writeFileSync(config, `host: "127.0.0.1"\nport: ${port}\njetstream { store_dir: ${JSON.stringify(store)} }\n`);
  const broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
  const releaseBroker = teardownOnSignal(broker, root);
  let stopped = false;
  const stopBroker = async () => {
    if (stopped) return;
    stopped = true;
    broker.kill("SIGTERM");
    await awaitExit(broker);
    if (broker.exitCode === null && broker.signalCode === null) {
      broker.kill("SIGKILL");
      await awaitExit(broker);
    }
  };
  try {
    for (let i = 0; i < 100 && !(await isReachable(server)); i++) await wait(50);
    if (!(await isReachable(server))) throw new Error(`fixture broker did not start on ${server}`);
    await setupSpaceStreams({ servers: server, space });

    const nc = await connect({ servers: server, inboxPrefix: `_INBOX_${label}`, maxReconnectAttempts: 0 });
    const kv = await openChannelRegistry(nc, space);
    await kv.put("general", new TextEncoder().encode('{"description":"fixture"}'));
    if (!(kv instanceof Bucket)) throw new Error("channel registry is not the pinned Bucket implementation");
    const bucket = kv as Bucket;
    const realGet = bucket.js.consumers.getPushConsumer.bind(bucket.js.consumers);
    const victim = Object.create(bucket) as Bucket;
    Object.defineProperty(victim, "js", {
      value: {
        ...bucket.js,
        consumers: {
          ...bucket.js.consumers,
          getPushConsumer: async (...args: Parameters<typeof realGet>) => {
            const stream = args[0];
            const config = bucket._buildCC(">", KvWatchInclude.AllHistory, { headers_only: false });
            if (residue === "wrong-filter") config.filter_subject = "$KV.not_the_channel_registry.>";
            const consumer = await realGet(stream, config);
            // Simulate a process disappearing before its best-effort cleanup reaches the broker. The
            // consumer and every config field are real; only this fixture's delete is suppressed so
            // backup can inspect the residue after the connection is gone.
            return Object.assign(Object.create(consumer as object), {
              delete: async () => true,
            });
          },
        },
      },
    });
    await liveKvEntries(victim);
    await nc.close();
    await stopBroker();

    const lock = acquireMaintenanceLock(root);
    try {
      const resume = writeMaintenanceResumeDocument(lock, {
        version: 1,
        inventory: [],
        launch: { server, root, store, space },
      });
      const attemptId = `cut-${label}`;
      beginMaintenanceCut(lock, {
        attemptId,
        space,
        mode: "open",
        sourcePath: store,
        resume,
        launch: { server, root, store },
      });
      const managerCommit = { operation: "commitPreservation" as const, attemptId, state: "preserved" as const };
      recordPreservationManagerCommit(lock, managerCommit);
      completeMaintenanceCut(lock, {
        attemptId,
        observedAt: new Date().toISOString(),
        managerCommit,
        stopped: { manager: true, broker: true, localProcesses: true },
        listener: { endpoint: server, unreachable: true },
      });
    } finally {
      releaseMaintenanceLock(lock);
    }
    return {
      root,
      artifact: join(root, "artifact"),
      async cleanup() {
        await stopBroker();
        rmSync(root, { recursive: true, force: true });
        releaseBroker();
      },
    };
  } catch (error) {
    await stopBroker();
    rmSync(root, { recursive: true, force: true });
    releaseBroker();
    throw error;
  }
}

const originalCwd = process.cwd();
let passed = 0, failed = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
try {
  const healthy = await preservedFixture("healthy", "kv-scan");
  try {
    process.chdir(healthy.root);
    let healthyError: unknown;
    await backup({ positionals: ["create", healthy.artifact], values: {}, raw: [] })
      .catch((error) => { healthyError = error; });
    check(
      "backup accepts a healthy stamp with stopped kv-scan residue",
      healthyError === undefined,
      healthyError instanceof Error ? healthyError.message : healthyError,
    );
  } finally {
    process.chdir(originalCwd);
    await healthy.cleanup();
  }

  const unhealthy = await preservedFixture("unhealthy", "wrong-filter");
  try {
    process.chdir(unhealthy.root);
    let unhealthyError: unknown;
    await backup({ positionals: ["create", unhealthy.artifact], values: {}, raw: [] })
      .catch((error) => { unhealthyError = error; });
    check(
      "backup still refuses an unhealthy ordered-consumer lookalike",
      unhealthyError instanceof Error && /unsupported stopped KV watcher config/.test(unhealthyError.message),
      unhealthyError instanceof Error ? unhealthyError.message : unhealthyError,
    );
  } finally {
    process.chdir(originalCwd);
    await unhealthy.cleanup();
  }

  console.log(`\nBACKUP KV CONSUMER SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
  if (failed) process.exitCode = 1;
} finally {
  process.chdir(originalCwd);
}

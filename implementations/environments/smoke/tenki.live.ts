/** Opt-in billable provider check. Takes key-file, profile-file and evidence-file arguments.
 * Uses an isolated broker solely for host-private lifecycle records; guests never connect to it.
 * The profile must contain no workload authority: this check records an empty-workload receipt. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, lstat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { awaitBrokerReady, freePort, teardownOnSignal, killAndAwaitExit, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { contractDigest, isReachable, type EnvironmentProvisionProfile } from "@cotal-ai/core";
import { openTenki } from "../../../extensions/tenki/src/index.js";
import { EnvironmentService, environmentKvStore, type EnvironmentView } from "../src/index.js";

if (process.env.COTAL_TENKI_LIVE !== "empty-workload") throw new Error("set COTAL_TENKI_LIVE=empty-workload to authorize a billable empty-workload probe");
const [keyPath, profilePath, evidencePath, mode, ...extra] = process.argv.slice(2);
if (!keyPath || !profilePath || !evidencePath || (mode !== undefined && mode !== "--force-close") || extra.length)
  throw new Error("expected key-file profile-file evidence-file [--force-close]");
const forceClose = mode === "--force-close";
const keyInfo = await lstat(keyPath);
if (!keyInfo.isFile() || (keyInfo.mode & 0o777) !== 0o600 || keyInfo.uid !== process.getuid?.()) throw new Error("unsafe key file");
const profile = JSON.parse(await readFile(profilePath, "utf8")) as EnvironmentProvisionProfile;
const driver = openTenki({ apiKey: (await readFile(keyPath, "utf8")).trim(), timeoutMs: 30_000 });
driver.validate(profile);
const directory = await mkdtemp(join(tmpdir(), `${SMOKE_BROKER_TOKEN}-tenki-`));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", directory], { stdio: "ignore" });
// Keep the private store after exit for forensic recovery, even when the process is signalled.
const release = teardownOnSignal(broker);
let nc: Awaited<ReturnType<typeof connect>> | undefined;
let service: EnvironmentService | undefined;
let view: EnvironmentView | undefined;
const caller = { owner: "local", actor: "live-test", uid: "a".repeat(26) };
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), storeDirectory: directory, checks: [] };
const save = () => writeFile(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
const wait = () => new Promise((resolve) => setTimeout(resolve, 1500));
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 60, delayMs: 50 });
  nc = await connect({ servers });
  const kv = await new Kvm(nc).create("environment_live", { history: 1, ttl: 0, storage: "file", allow_direct: false });
  const jsm = await jetstreamManager(nc);
  await jsm.streams.update("KV_environment_live", { allow_rollup_hdrs: false });
  const store = await environmentKvStore(kv);
  const host = {
    async authorize(c: typeof caller) { return c.owner === "local"; },
    async retainAndRetire() {
      if (forceClose) throw new Error("probe retention host unavailable");
      await save(); return "empty-workload:no-authority-issued";
    },
    async retireTerminated() { await save(); return "empty-workload:no-authority-issued"; },
  };
  service = new EnvironmentService(store, [profile], [driver], host);
  const args = { operationId: `live-${Date.now()}-single`, profile: profile.name, profileDigest: contractDigest(profile) };
  view = await service.create(caller, args);
  evidence.created = view;
  await save();
  assert.ok(view.record.environment, "create must return a persisted provider-issued reference");
  // A new service object must recover the same provider binding without another creation.
  service = new EnvironmentService(await environmentKvStore(kv), [profile], [driver], host);
  const repeat = await service.create(caller, args);
  assert.deepEqual(repeat.record.environment, view.record.environment);
  await assert.rejects(() => service!.destroy({ ...caller, uid: "b".repeat(26) }, view!.record.id), /not found/);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    view = await service.inspect(caller, view.record.id);
    if (view.observation?.state === "running") break;
    if (view.observation?.state === "terminated") throw new Error("provider terminated before running");
    await wait();
  }
  assert.equal(view.observation?.state, "running", "real provider must reach RUNNING within the observation bound");
  evidence.running = view;
  if (forceClose) {
    const pending = await service.destroy(caller, view.record.id);
    assert.equal(pending.problem, "retention-unconfirmed", "failed graceful retention must remain explicit before forced close");
    evidence.gracefulPending = pending;
  }
  evidence.checks = ["provider-issued binding persisted", "same-operation retry retained one reference", "service reconstruction retained ownership", "foreign lifecycle destruction rejected", "provider observed RUNNING"];
  await save();
} finally {
  try {
    if (view?.record.environment && service) {
      const id = view.record.id;
      const deadline = Date.now() + 120_000;
      do {
        view = await service.destroy(caller, id, forceClose);
        evidence.cleanup = view;
        await save();
        if (view.record.terminatedAt !== undefined) break;
        await wait();
      } while (Date.now() < deadline);
      assert.ok(view.record.terminatedAt, "provider termination remains unconfirmed; inspect the retained evidence and store");
      assert.equal(view.cleanup?.retirement, "retired", "empty workload retirement must be recorded independently");
      if (forceClose) assert.equal(view.cleanup?.retention, "unknown", "forced termination must not fabricate result retention");
      evidence.finishedAt = new Date().toISOString();
      await save();
      console.log(`Cleanup observed TERMINATED: ${view.record.environment?.id}`);
    }
  } finally {
    driver.close();
    await nc?.close();
    await killAndAwaitExit(broker);
    release();
  }
}
console.log("PASS real Tenki create, persisted retry, caller isolation, running observation and verified termination");

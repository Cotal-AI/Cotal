/** Native workflow census: real runtime records, checkpoint transitions and scoped reader denials. */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { createSuite } from "@cotal-ai/smoke-kit";
import { SimHandler } from "@cotal-ai/lang";
import { isPermissionDenied, mintCheckpoint, mintCreds, mintLifecycleUid, newIdentity, readRunRecord,
  recordAtomicKey, recordSpecKey, recordStatusKey, recordsBucket, RECORD_KINDS, resumeCheckpoint,
  setupSpaceStreams, standaloneConnectOpts, writeRunStatus, type MintOpts, type Profile } from "@cotal-ai/core";
import { startRun } from "../../runtime/src/run-driver.js";
import { observeWorkflowQuiescence } from "../src/quiescence-workflows.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("quiet-workflows", 1);
const account = fx.accounts[0]!, space = account.space, endpoint = "org.example.runner", runId = "observed-run";
const connections: NatsConnection[] = [];
const open = async (profile: Profile, options: MintOpts = {}) => {
  const creds = await mintCreds(account.auth, newIdentity(), profile, options);
  const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  connections.push(nc);
  return nc;
};
const bind = (nc: NatsConnection) => new Kvm(nc).open(recordsBucket(space), { allow_direct: false });
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  const reader = await bind(await open("space-quiescence-reader"));
  const observe = () => observeWorkflowQuiescence(reader);
  const clear = async () => { const value = await observe(); return !value.unknown && value.activeRuns === 0 && value.waitingCheckpoints === 0; };
  const empty = await observe();
  check("fresh records have no unresolved workflow", !empty.unknown && empty.recordsEnumerated === 0 && empty.activeRuns === 0 && empty.waitingCheckpoints === 0);
  const initialized = empty;

  const grant = { endpoint, runId, takeoverId: "initial", instanceId: mintLifecycleUid(), epoch: 1 };
  const driver = await open("run-driver", { runDriver: grant });
  const host = await open("run-mediator", { runMediator: grant });
  const records = await bind(host);
  const out = await startRun(jetstream(driver), await jetstreamManager(driver), {
    space, endpoint, runId, kv: records, source: 'await sleep("1s");', handler: new SimHandler(),
    lease: { holder: "fixture", epoch: 1, fencingToken: 1, takeoverId: grant.takeoverId },
  });
  const completed = await readRunRecord(records, endpoint, runId);
  if (!completed?.status) throw new Error("runtime wrote no complete run record");
  check("the real runtime's completed run and resolved pins are accepted", out.status === "completed" && await clear() && !initialized.unknown && initialized.recordsEnumerated === 0 && (await observe()).recordsEnumerated === initialized.recordsEnumerated + 3);
  const writeState = async (state: "running" | "released" | "completed") => {
    const current = await readRunRecord(records, endpoint, runId);
    if (!current?.status) throw new Error("run status missing");
    await writeRunStatus(records, endpoint, runId, { ...current.status.value, state }, current.status.revision);
  };
  await writeState("running");
  check("a running workflow prevents quiescence", (await observe()).activeRuns === 1 && !(await observe()).unknown);
  await writeState("released");
  check("a released workflow still has no terminal result", (await observe()).activeRuns === 1 && !(await observe()).unknown);
  await writeState("completed");
  check("terminal status clears the workflow blocker", await clear());

  const statusKey = recordStatusKey(RECORD_KINDS.run, [endpoint, runId]);
  const specKey = recordSpecKey(RECORD_KINDS.run, [endpoint, runId]);
  const programKey = recordAtomicKey(RECORD_KINDS.program, [endpoint, runId]);
  const badRecord = async (label: string, key: string, change: (kv: KV, key: string, value: Record<string, unknown>) => Promise<unknown>) => {
    const original = await records.get(key);
    if (!original) throw new Error("positive record missing");
    await change(records, key, original.json<Record<string, unknown>>());
    check(`${label} makes the observation unknown`, (await observe()).unknown);
    const revision = await records.put(key, original.value);
    if (key === specKey) {
      const current = await records.get(statusKey);
      if (!current) throw new Error("status missing after spec repair");
      await records.put(statusKey, JSON.stringify({ ...current.json(), observedSpecRevision: revision }));
    }
    check(`${label} has an independent repaired positive control`, await clear());
  };
  await badRecord("a missing status holder", statusKey, (kv, key, value) => { delete value.holder; return kv.put(key, JSON.stringify(value)); });
  await badRecord("an unknown status field", statusKey, (kv, key, value) => kv.put(key, JSON.stringify({ ...value, unexpected: true })));
  await badRecord("a stale spec revision", statusKey, (kv, key, value) => kv.put(key, JSON.stringify({ ...value, observedSpecRevision: 0 })));
  await badRecord("a program under another run identity", programKey, (kv, key, value) => kv.put(key, JSON.stringify({ ...value, run: "foreign" })));
  await badRecord("a deleted program marker", programKey, (kv, key) => kv.delete(key));
  await badRecord("invalid resolved pins", specKey, (kv, key, value) => kv.put(key, JSON.stringify({ ...value, pins: {} })));

  const ref = { endpoint, token: "checkpoint" };
  const holder = { id: "local.worker", lifecycleUid: mintLifecycleUid() };
  await mintCheckpoint(records, jetstream(host), space, { ref, holder, instanceId: grant.instanceId, epoch: 1, now: 100, deadline: 10_000 });
  const waiting = await observe();
  check("a real waiting checkpoint prevents quiescence", !waiting.unknown && waiting.waitingCheckpoints === 1);
  await resumeCheckpoint(records, jetstream(host), await jetstreamManager(host), space, { ref, presenter: holder, now: 200 });
  check("native checkpoint settlement clears its blocker", await clear());
  const cpStatusKey = recordStatusKey(RECORD_KINDS.cp, [endpoint, ref.token]);
  await badRecord("an incomplete checkpoint settlement", cpStatusKey, (kv, key, value) => { delete value.settledHolder; return kv.put(key, JSON.stringify(value)); });

  const deniedWrite = await reader.put(statusKey, "{}").then(() => false, error => { if (!isPermissionDenied(error)) throw error; return true; });
  check("the quiescence credential cannot alter workflow status", deniedWrite && await clear());
  const unavailable = await observeWorkflowQuiescence(await bind(await open("probe")));
  check("a denied workflow read is unknown, never empty", unavailable.unknown && unavailable.recordsEnumerated === 0);
} catch (error) {
  check(`harness: ${error instanceof Error ? error.message : "unknown failure"}`, false);
} finally {
  for (const nc of connections) await nc.close();
  await fx.close();
  if (passed() + failed() !== 23) check(`cell count: ran ${passed() + failed()}, expected 23`, false);
  finish();
}
process.exit(process.exitCode ?? 0);

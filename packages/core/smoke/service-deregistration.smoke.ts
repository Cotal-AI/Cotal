/**
 * SERVICE DEREGISTRATION smoke (SPEC §13.5: a deleted `svc` spec IS the deregistration).
 *
 * THE DEFECT THIS EXISTS FOR. The service registry records REGISTRATION, and nothing in the model
 * expires a row. An instance registers, its host dies without writing anything, and the record goes
 * on claiming a live instance forever — so every class scatter in the space freezes that slot in and
 * waits out its whole deadline for an answer that can never come. Registration had no way OUT that
 * did not depend on the dead instance's cooperation. This suite is the way out and the four things
 * that make it safe.
 *
 * 1. ORDER. Status first, then spec. The half-deleted state a reader can catch is then "spec without
 *    status", which §13.4 already defines and which the freeze already skips. The other order
 *    produces "status without spec", the TORN state readers REFUSE — a deregistration would hand
 *    every concurrent reader a `failed-precondition` for the width of one round trip. Both halves
 *    are asserted below against a real reader, not argued.
 *
 * 2. REVISION PINNING. A blind delete removes whatever is there NOW, and what is there now may be a
 *    successor that re-registered under the same instanceId microseconds ago. Both deletes are
 *    pinned to the revisions this function itself read.
 *
 * 3. RE-REGISTRABILITY, which is what makes deregistration a door rather than a cliff.
 *    `createRecordEntry` fences against a key's ENTIRE history, so a create over a tombstone is a
 *    conflict — correct for the never-deleted lifecycle families and fatal here, because a manager
 *    that deregisters on a clean stop would never be able to start again. The cell that proves this
 *    is the one that would have caught it in review.
 *
 * 4. IDEMPOTENCE. Deregistering twice is not an error, and neither is deregistering something that
 *    was never registered — both are `absent`, so a shutdown path racing an operator cannot fail.
 *
 * THE COUNT WAS PREDICTED AT 21 AND IS 19. Recorded rather than quietly re-cut: two of the
 * predicted cells were the same assertions counted twice while sketching sections 4 and 5, not
 * cells that were dropped. Every claim written down before the first run is still asserted below.
 *
 * WHAT THE FIRST RUN FOUND, which is the reason to write the recovery cells before the code: the
 * spec key's create-only fence had an exact twin on the STATUS key. With only the spec side fixed,
 * a deregistered instance registered again and then could not converge — a manager that starts,
 * writes nothing, and is invisible to every scatter. Section 6 is what caught it.
 *
 * Run: pnpm smoke:service-dereg   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { KV } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, openRecordsBucket, registerServiceInstance, deregisterServiceInstance, writeServiceStatus,
  freezeExpectedSet, readRecord, deleteRecordEntry, recordSpecKey, recordStatusKey, RECORD_KINDS,
  SERVICE_READY, EpEnvelopeError, compileContract, contractDigest, VOID_SCHEMA,
  type EpIssuanceBarrier, type ServiceNameAuthority, type ServiceSpec,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 19;

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log("  ✗ FAIL:", n, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errOf = async (fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try { await fn(); return { message: "NO THROW" }; }
  catch (e) { return { code: (e as EpEnvelopeError).code, message: (e as Error).message }; }
};

const SPACE = "deregsmoke";
const ENDPOINT = "manager";
const IID_LIVE = "a".repeat(26);
const IID_DEAD = "b".repeat(26);
const IID_NEVER = "c".repeat(26);

// The registration ceremony, exactly as `endpoint-serve.smoke.ts` builds it: a faithful in-memory
// §13.1 barrier per (endpoint, instance), and an authority that admits this one core name.
// One minimal §13.7 cluster, content-addressed exactly as a real registration's is: the registered
// CLOSURE digest names a manifest whose root names the document. The surface itself is irrelevant
// here (this suite is about the record's lifecycle), but a spec with no cluster is not a spec.
const D_VOID = contractDigest(VOID_SCHEMA);
const DOC = {
  urn: "ai.cotal.dereg", revision: 1, attributes: [], events: [],
  commands: [{ name: "ping", class: "ephemeral", targeted: false, capability: "manager.call", inputDigest: D_VOID, outputDigest: D_VOID }],
};
const MANIFEST = { v: 1, root: contractDigest(DOC), members: [] as string[] };
const CLOSURE = contractDigest(MANIFEST);
const artifacts = new Map<string, unknown>([[contractDigest(DOC), DOC], [CLOSURE, MANIFEST], [D_VOID, VOID_SCHEMA]]);
const spec: ServiceSpec = { endpoint: ENDPOINT, owner: "u_op", clusterDigests: [CLOSURE], protocol: { v: 1 } };
const authority: ServiceNameAuthority = { authorize: (name, owner) => ({ authorized: name === ENDPOINT && owner === "u_op", revision: 0 }) };
type Gate = { space: string; endpoint: string; lifecycleUid: string; principal: string; state: "open" | "frozen" | "retired"; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number; revision: number };
const gates = new Map<string, Gate>();
function barrierFor(instanceId: string): EpIssuanceBarrier {
  const key = `${ENDPOINT}/${instanceId}`;
  if (!gates.has(key)) gates.set(key, { space: SPACE, endpoint: ENDPOINT, lifecycleUid: instanceId, principal: "u_op.mgr", state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, revision: 1 });
  const g = gates.get(key)!;
  return {
    observe: () => ({ ...g }),
    freeze: (rev) => { if (g.state !== "open" || g.revision !== rev) return null; g.state = "frozen"; g.revision++; return g.revision; },
    enumerate: () => [],
    revoke: () => {},
    evict: () => true,
    reopen: (token, succ) => { if (g.state !== "frozen" || g.revision !== token) return false; g.state = "open"; g.generation = succ.generation; g.processEpoch = succ.processEpoch; g.registrationRevision = succ.registrationRevision; g.nameAuthorityRevision = succ.nameAuthorityRevision; g.revision++; return true; },
  };
}
const register = (kv: KV, instanceId: string) =>
  registerServiceInstance(kv, { space: SPACE, spec, instanceId, registrant: { owner: "u_op" }, authority, barrier: barrierFor(instanceId), readClusterArtifact: (d: string) => artifacts.get(d) });
/** Converge an instance so the freeze counts it: `ready` at the current registration + gate epoch. */
const converge = async (kv: KV, instanceId: string, registrationRevision: number) => {
  const epoch = gates.get(`${ENDPOINT}/${instanceId}`)!.processEpoch;
  await writeServiceStatus(kv, {
    endpoint: ENDPOINT, instanceId, epoch, readProcessEpoch: () => gates.get(`${ENDPOINT}/${instanceId}`)!.processEpoch,
    status: { state: SERVICE_READY, epoch, observedSpecRevision: registrationRevision },
  });
};

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const kv = await openRecordsBucket(nc, SPACE, { create: true });
  const jsm = await jetstreamManager(nc);

  console.log("1. the corpse: a registration with nothing behind it, and what it costs");
  const live = await register(kv, IID_LIVE);
  await converge(kv, IID_LIVE, live.registrationRevision);
  const dead = await register(kv, IID_DEAD);
  await converge(kv, IID_DEAD, dead.registrationRevision);
  const frozen0 = new Set((await freezeExpectedSet(jsm, SPACE, ENDPOINT)).map((f) => f.instanceId));
  c("both registrations are frozen into the class - a record is liveness as far as the freeze knows",
    frozen0.has(IID_LIVE) && frozen0.has(IID_DEAD), [...frozen0]);

  console.log("2. deregistration removes the record, and says exactly what it removed");
  const removed = await deregisterServiceInstance(kv, { endpoint: ENDPOINT, instanceId: IID_DEAD });
  c("it reports removed with the spec revision it deleted", removed.removed === true && removed.specRevision > 0, removed);
  c("...and the status revision, so a caller can say what is gone rather than that something is",
    removed.removed === true && removed.statusRevision !== undefined, removed);
  const specEntry = await kv.get(recordSpecKey(RECORD_KINDS.svc, [ENDPOINT, IID_DEAD]));
  const statusEntry = await kv.get(recordStatusKey(RECORD_KINDS.svc, [ENDPOINT, IID_DEAD]));
  c("the spec key carries a deletion marker (§13.5: a deleted spec IS the deregistration)", specEntry?.operation === "DEL", specEntry?.operation);
  c("the status key does too", statusEntry?.operation === "DEL", statusEntry?.operation);
  const frozen1 = new Set((await freezeExpectedSet(jsm, SPACE, ENDPOINT)).map((f) => f.instanceId));
  c("THE POINT: the deregistered instance is gone from the freeze, so no later scatter waits on it",
    !frozen1.has(IID_DEAD) && frozen1.has(IID_LIVE), [...frozen1]);

  console.log("3. idempotence - a shutdown racing an operator must not fail");
  const twice = await deregisterServiceInstance(kv, { endpoint: ENDPOINT, instanceId: IID_DEAD });
  c("a second deregistration is ABSENT, not an error", twice.removed === false && twice.reason === "absent", twice);
  const never = await deregisterServiceInstance(kv, { endpoint: ENDPOINT, instanceId: IID_NEVER });
  c("deregistering something never registered is ABSENT too", never.removed === false && never.reason === "absent", never);

  console.log("4. THE ORDER: which half-deleted state a concurrent reader can catch");
  // Both directions are exercised against the real merged reader, because the whole justification
  // for deleting the status first is a claim about what THAT reader does with each half-state.
  const halfLive = await register(kv, IID_NEVER);
  await converge(kv, IID_NEVER, halfLive.registrationRevision);
  const statusKey = recordStatusKey(RECORD_KINDS.svc, [ENDPOINT, IID_NEVER]);
  const specKey = recordSpecKey(RECORD_KINDS.svc, [ENDPOINT, IID_NEVER]);
  const statusRev = (await kv.get(statusKey))!.revision;
  await deleteRecordEntry(kv, statusKey, statusRev); // the state produced by deleting status FIRST
  const merged = await readRecord(kv, RECORD_KINDS.svc, [ENDPOINT, IID_NEVER], { deadlineMs: 1_000 });
  c("spec-without-status (the state THIS order passes through) reads cleanly - no status, no error",
    merged !== undefined && merged.status === undefined, merged === undefined ? "absent" : Object.keys(merged));
  const notFrozen = new Set((await freezeExpectedSet(jsm, SPACE, ENDPOINT)).map((f) => f.instanceId));
  c("...and the freeze already skips it: registered, not converged, never a live member", !notFrozen.has(IID_NEVER), [...notFrozen]);
  // Now the OTHER order's half-state, built by hand: a status with its spec gone.
  await converge(kv, IID_NEVER, halfLive.registrationRevision);
  await deleteRecordEntry(kv, specKey, (await kv.get(specKey))!.revision);
  const torn = await errOf(() => readRecord(kv, RECORD_KINDS.svc, [ENDPOINT, IID_NEVER], { deadlineMs: 500 }));
  c("status-without-spec (the state the OTHER order passes through) is TORN and readers REFUSE it",
    torn.code === "failed-precondition" && /torn record state/.test(torn.message), torn);

  console.log("5. revision pinning - a delete removes the record that was READ, or nothing");
  const pinned = await register(kv, IID_DEAD); // re-registers over its own tombstone (see section 6)
  await converge(kv, IID_DEAD, pinned.registrationRevision);
  const pinnedSpecKey = recordSpecKey(RECORD_KINDS.svc, [ENDPOINT, IID_DEAD]);
  const staleRev = (await kv.get(pinnedSpecKey))!.revision;
  await converge(kv, IID_DEAD, pinned.registrationRevision); // something wrote after the read
  const lost = await errOf(() => deleteRecordEntry(kv, pinnedSpecKey, staleRev - 1));
  c("a delete pinned to a revision the key has moved past is a loud CONFLICT", lost.code === "conflict", lost);
  c("the conflict says the record is not the one that was inspected, and to re-read",
    /is NOT the record that was inspected/.test(lost.message) && /re-read/.test(lost.message), lost.message.slice(0, 120));
  c("and the record SURVIVES a lost CAS - nothing was removed", (await kv.get(pinnedSpecKey))?.operation === "PUT");

  console.log("6. re-registration over the tombstone: the recovery path, without which this is a cliff");
  // A create-only write fences against the key's whole history, so a manager that deregistered on a
  // clean stop could never register again. This is the cell that says it can.
  const after = await deregisterServiceInstance(kv, { endpoint: ENDPOINT, instanceId: IID_DEAD });
  c("the instance is deregistered again (setting up the tombstone)", after.removed === true, after);
  const epochBefore = gates.get(`${ENDPOINT}/${IID_DEAD}`)!.processEpoch;
  const reborn = await register(kv, IID_DEAD);
  c("THE RECOVERY: the same instance id registers again OVER the deletion marker",
    reborn.registrationRevision > 0, reborn);
  c("...and its epoch ADVANCED, so a predecessor that outlived its own deregistration is fenced",
    gates.get(`${ENDPOINT}/${IID_DEAD}`)!.processEpoch === epochBefore + 1,
    { epochBefore, now: gates.get(`${ENDPOINT}/${IID_DEAD}`)!.processEpoch });
  await converge(kv, IID_DEAD, reborn.registrationRevision);
  const frozen2 = new Set((await freezeExpectedSet(jsm, SPACE, ENDPOINT)).map((f) => f.instanceId));
  c("...and it is a live class member again", frozen2.has(IID_DEAD), [...frozen2]);

  console.log("7. the endpoint token is validated, not trusted");
  const bad = await errOf(() => deregisterServiceInstance(kv, { endpoint: ENDPOINT, instanceId: "not a valid token!" }));
  c("a malformed instance id is refused at the seam rather than widening a subject", bad.message !== "NO THROW", bad);

  await nc.drain().catch(() => nc.close());
} finally {
  try { broker.kill("SIGKILL"); } catch { /* best effort */ }
  await wait(200);
  rmSync(sd, { recursive: true, force: true });
  releaseBroker?.();
}

const counted = ok + fail;
if (counted !== EXPECTED_CELLS) {
  console.log(`  ✗ FAIL: expected ${EXPECTED_CELLS} cells, ran ${counted} - a cell that stops running stops guarding`);
  fail++;
}
console.log(`\n${fail === 0 ? "SERVICE DEREGISTRATION SMOKE OK ✅" : "SERVICE DEREGISTRATION SMOKE FAILED"}  (${ok} passed, ${fail} failed, ${EXPECTED_CELLS} expected)`);
process.exit(fail === 0 ? 0 : 1);

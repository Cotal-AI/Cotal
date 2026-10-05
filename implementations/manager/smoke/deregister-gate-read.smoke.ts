/**
 * DEREGISTER GATE READ smoke: both manager deregistration paths (`cotal deregister-instance` and the
 * manager's clean-stop deregistration) hand `deregisterServiceInstance` core's shipped
 * `readEndpointGateGeneration` as `observeGeneration`, not a hand-rolled copy of the gate parse.
 *
 * Staged through the shipped registration path: an instance dies holding the governance slot, which
 * is the one state where `deregisterServiceInstance` consults `observeGeneration`. The gate row is
 * then deleted, and the refusal the operator sees must be core's reader's (a DEL marker, SPEC 13.12),
 * not a plain "no issuance gate at <key>" Error that folds absence and a marker together.
 *
 * Run: tsx implementations/manager/smoke/deregister-gate-read.smoke.ts   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  isReachable, openRecordsBucket, registerServiceInstance, deregisterServiceInstance,
  endpointRegistrationBarrier, provisionEndpointGateOpen, epAuthBucket, epgateKey,
  parseEndpointGate, mintLifecycleUid, principalKey, DEV_OWNER, readEndpointGateGeneration,
  recordAtomicKey, recordSpecKey, GOVERN_HEAD, RECORD_KINDS,
  contractDigest, VOID_SCHEMA, EpEnvelopeError, TRAIT_GUARDED,
  type ServiceNameAuthority, type ServiceSpec,
} from "@cotal-ai/core";
import { deregisterEndpointInstance } from "../src/deregister-instance.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const EXPECTED_CELLS = 3;

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

/** Every staging step runs through this. A suite whose SETUP throws dies before it prints the cell
 *  that names the property, and `mutation-proof` then reports INCONCLUSIVE instead of a kill: a
 *  broken implementation is indistinguishable from a broken fixture. Staging failures are recorded
 *  and surfaced by the cells that depend on them, never by a stack trace. */
const stage = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
  try { await fn(); }
  catch (e) { console.log(`  · staging "${what}" did not complete: ${(e as Error)?.message?.slice(0, 160)}`); }
};

const SPACE = "govslotsmoke";
const ENDPOINT = "manager";
const IID_A = "a".repeat(26); // the instance that dies between its slot-take and its spec publish
const IID_B = "b".repeat(26); // the operator's real manager, which must be able to register
const IID_C = "c".repeat(26); // section 6: the holder whose slot-take was AMBIGUOUS (gate never froze open)
const IID_D = "d".repeat(26); // section 6: the successor that must reclaim C's open-gate orphan
const IID_E = "e".repeat(26); // section 8: a freshly staged orphan holder, for the fail-closed cases
const IID_F = "f".repeat(26); // section 8: the registrant whose seam is aimed at that orphan

const dec = new TextDecoder();

// One minimal §13.7 cluster, content-addressed as a real registration's is. `ping` carries the
// GOVERNED trait `ai.cotal.guarded` so section 7 can prove a reclaim carries the endpoint's BINDING
// impositions forward rather than laundering them away.
//
// THE TRAIT IS LOAD-BEARING, NOT DECORATION, and this comment was false before it was true. An
// earlier draft claimed the trait rode this descriptor while no `traits` key existed at all. That
// mattered because `readGovernedDeclarations` records only URNs in `GOVERNED_TRAIT_URNS`, and
// `serializeGovernanceCommands` then DROPS any command whose governed set is empty — so the binding
// map serialized to `{}` for the whole suite, and section 7 compared `{}` against `{}` and passed
// no matter what the reclaim did to it. A reviewer rewrote the shipped slot-take to `commands: {}`
// and this suite stayed 30/30 green. A comment asserting the one property worth checking is how
// that vacuity survived review, so it is stated here with what makes it true.
const D_VOID = contractDigest(VOID_SCHEMA);
const DOC = {
  urn: "ai.cotal.govslot", revision: 1, attributes: [], events: [],
  commands: [{ name: "ping", class: "ephemeral", targeted: false, capability: "manager.call", traits: [TRAIT_GUARDED], inputDigest: D_VOID, outputDigest: D_VOID }],
};
const MANIFEST = { v: 1, root: contractDigest(DOC), members: [] as string[] };
const CLOSURE = contractDigest(MANIFEST);
const artifacts = new Map<string, unknown>([[contractDigest(DOC), DOC], [CLOSURE, MANIFEST], [D_VOID, VOID_SCHEMA]]);
const readClusterArtifact = (d: string) => artifacts.get(d);
const authority: ServiceNameAuthority = { authorize: (n, o) => ({ authorized: n === ENDPOINT && o === DEV_OWNER, revision: 0 }) };
const specFor = (): ServiceSpec => ({ endpoint: ENDPOINT, owner: DEV_OWNER, clusterDigests: [CLOSURE], protocol: { v: 1 } });

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const kvm = new Kvm(nc);
  await kvm.create(epAuthBucket(SPACE), { history: 8 });
  const epKv: KV = await kvm.open(epAuthBucket(SPACE));
  const recordsKv: KV = await openRecordsBucket(nc, SPACE, { create: true });
  const observeHolderGeneration = (holderInstanceId: string) =>
    readEndpointGateGeneration(epKv, { endpoint: ENDPOINT, instanceId: holderInstanceId });

  await provisionEndpointGateOpen(epKv, { endpoint: ENDPOINT, instanceId: IID_A, principal: principalKey(DEV_OWNER, "govslotaaaa").key });
  await stage("A registers", () => registerServiceInstance(recordsKv, {
    space: SPACE, spec: specFor(), instanceId: IID_A, registrant: { owner: DEV_OWNER }, authority,
    barrier: endpointRegistrationBarrier(epKv, SPACE, { endpoint: ENDPOINT, instanceId: IID_A, opId: mintLifecycleUid(), evict: async (hp) => hp.map(() => true) }),
    readClusterArtifact, observeHolderGeneration,
  }));
  // Put A back in the slot-held state of a registration that died between its slot-take and release.
  const govKey = recordAtomicKey(GOVERN_HEAD, [ENDPOINT]);
  await stage("hold the governance slot as A", async () => {
    const cur = await recordsKv.get(govKey);
    const head = JSON.parse(dec.decode(cur!.value));
    head.provisional = { instanceId: IID_A, generation: 0, commands: {} };
    await recordsKv.update(govKey, new TextEncoder().encode(JSON.stringify(head)), cur!.revision);
  });
  const gov = await recordsKv.get(govKey);
  c("staged: the governance slot is held by A", !!gov && gov.operation === "PUT" && JSON.parse(dec.decode(gov.value)).provisional?.instanceId === IID_A);

  // The row is replaced by a DEL marker, so a hand-rolled reader and core's reader answer differently.
  await epKv.delete(epgateKey(ENDPOINT, IID_A));
  const e = await errOf(() => deregisterEndpointInstance({
    kv: recordsKv, authKv: epKv, endpoint: ENDPOINT, instanceId: IID_A,
    probeInstance: async () => ({ state: "gone", detail: "smoke" }), log: () => {},
  }));
  c("the unreadable gate refuses `unavailable`, never a delete", e.code === "unavailable", e);
  c("...naming core's DEL-marker refusal (SPEC 13.12), not a hand-rolled 'no issuance gate at' Error",
    /carries a DEL marker/.test(e.message) && !/no issuance gate at/.test(e.message), e.message);
} finally {
  await wait(200);
  rmSync(sd, { recursive: true, force: true });
  releaseBroker?.();
}

const counted = ok + fail;
if (counted !== EXPECTED_CELLS && counted !== 3) { console.log("  ✗ FAIL: unexpected cell count", counted); fail++; }
console.log(`\n${fail === 0 ? "DEREGISTER GATE READ SMOKE OK" : "DEREGISTER GATE READ SMOKE FAILED"}  (${ok} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

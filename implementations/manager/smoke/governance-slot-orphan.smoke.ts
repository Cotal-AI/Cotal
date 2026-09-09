/**
 * GOVERNANCE-SLOT ORPHAN RECLAIM (#1393) — SPEC §13.7's endpoint registration linearization point.
 *
 * THE STATE THIS EXISTS FOR. An operator ran a broker-only node in a split topology. `cotal up`
 * forces a manager, so they stopped it within seconds of boot — between its taking the endpoint
 * governance slot in PHASE 1 and finishing its PHASE-3 spec publication. That is not an exotic
 * window: the shipped path reports it as `[unavailable] the re-registration spec-write outcome is
 * ambiguous (it may have committed); the gate is left frozen for reconciliation`, an outcome the
 * code already anticipates by name. It left the slot HELD with no registration behind it, and both
 * documented exits then reported something true while freeing nothing:
 *
 *   - `cotal reconcile-gate` verified the holder gone, reopened the gate, printed
 *     `✓ gate … reopened at generation=1` — and the next instance failed with the same conflict.
 *   - `cotal deregister-instance` observed the holder gone and refused `not-registered`, because
 *     the slot is held by a SPEC PUBLICATION and not by a service registration. The tool that
 *     removes registrations had nothing to act on while the slot stayed held.
 *
 * Their fleet was down about two hours across ~25 restarts. Only reviving the stale instance so it
 * reclaimed its own slot, then stopping it cleanly, recovered it.
 *
 * THE FIX IS A COMPLETION, NOT AN INVENTION, and that is why the shape below is the shape it is.
 * The registration path already trusted this predicate twice: `promoteHeldGovernance` promotes only
 * when `slot.generation === the frozen gate's generation`, and `deregisterServiceInstance` already
 * classifies a slot against a live gate on the same `<` / `===` / `>` triad. Only the FOREIGN-slot
 * branch refused unconditionally, while the same function's OWN-instance branch two lines below it
 * already reclaimed on the identical evidence. That asymmetry was the defect.
 *
 * WHAT MAKES A FOREIGN SLOT PROVABLY DEAD. The slot is stamped with the generation of the gate its
 * holder had frozen when it took the slot. A freeze preserves the generation; only a token-pinned
 * reopen advances it, and a reopen releases the freeze. So a holder gate reading ABOVE the stamp
 * proves no barrier holds a freeze at the stamped generation — which proves the equality
 * `promoteHeldGovernance` requires can never hold for that slot again. It is unpromotable by its
 * holder, by a reconciler, and by anyone else. It binds nothing and never will.
 *
 * THE TWO CELLS THAT CARRY THE CHANGE ARE A MATCHED PAIR, section 3 and section 5. Same two
 * instances, same slot, same endpoint, and ONE variable: the holder's gate coordinate.
 *
 *   section 3 — holder's gate FROZEN at generation 0, slot stamped 0. Indistinguishable from a
 *               genuinely in-flight registration, so B MUST REFUSE. The negative control, and the
 *               reason this fix cannot be a slot-stealing regression.
 *   section 5 — holder's gate OPEN at generation 1 (a real `reconcileEndpointGate` moved it), slot
 *               still stamped 0. Provably orphaned, so B MUST SUCCEED.
 *
 * A NEGATIVE CONTROL THAT WOULD SURVIVE A LOOSENED PREDICATE PROVES NOTHING, which is the failure
 * mode most likely to sail through review. Section 4 therefore attacks it directly, in-process:
 * it re-runs section 3's exact observation through a LOOSENED copy of the predicate (`<` widened to
 * `<=`, the single most plausible off-by-one a future edit introduces) and asserts that the copy
 * ADMITS what the shipped one refused. That is what makes section 3 a discriminator rather than a
 * cell that happens to be green. `mutation-proof` grades the shipped predicate from outside; this
 * grades the control itself.
 *
 * SECTION 6 IS THE RESIDUE `reconcile-gate` STRUCTURALLY CANNOT REACH, and it is why this fix
 * belongs in the registration path rather than in the repair tool. When the slot-take CAS is
 * AMBIGUOUS, the outer catch abort-reopens at `generation + 1` — so the slot is stamped `g` while
 * its holder's gate is already OPEN at `g+1`. `reconcileEndpointGate` refuses that with
 * `not-frozen`, correctly: there is no frozen gate to reconcile. Same orphan, no repair-tool exit
 * at all. The registration-path predicate covers both residues with one rule.
 *
 * Run: pnpm smoke:governance-slot-orphan   (needs nats-server on PATH; part of smoke:ci)
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
  contractDigest, VOID_SCHEMA, EpEnvelopeError,
  type ServiceNameAuthority, type ServiceSpec,
} from "@cotal-ai/core";
import { reconcileEndpointGate } from "../src/reconcile-gate.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const EXPECTED_CELLS = 30;

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

// One minimal §13.7 cluster, content-addressed as a real registration's is. A GOVERNED trait rides
// it so section 7 can prove a reclaim carries the endpoint's BINDING impositions forward rather
// than laundering them away.
const D_VOID = contractDigest(VOID_SCHEMA);
const DOC = {
  urn: "ai.cotal.govslot", revision: 1, attributes: [], events: [],
  commands: [{ name: "ping", class: "ephemeral", targeted: false, capability: "manager.call", inputDigest: D_VOID, outputDigest: D_VOID }],
};
const MANIFEST = { v: 1, root: contractDigest(DOC), members: [] as string[] };
const CLOSURE = contractDigest(MANIFEST);
const artifacts = new Map<string, unknown>([[contractDigest(DOC), DOC], [CLOSURE, MANIFEST], [D_VOID, VOID_SCHEMA]]);
const readClusterArtifact = (d: string) => artifacts.get(d);
const authority: ServiceNameAuthority = { authorize: (n, o) => ({ authorized: n === ENDPOINT && o === DEV_OWNER, revision: 0 }) };
const specFor = (): ServiceSpec => ({ endpoint: ENDPOINT, owner: DEV_OWNER, clusterDigests: [CLOSURE], protocol: { v: 1 } });

const PORT = await pickFreePort();
const sd = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), SMOKE_BROKER_TOKEN));
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

  const govKey = recordAtomicKey(GOVERN_HEAD, [ENDPOINT]);
  const readGov = async (): Promise<{ commands: Record<string, string[]>; provisional?: { instanceId: string; generation: number } } | null> => {
    const e = await recordsKv.get(govKey);
    return e && e.operation === "PUT" ? JSON.parse(dec.decode(e.value)) : null;
  };
  const readGate = async (iid: string) => {
    const e = await epKv.get(epgateKey(ENDPOINT, iid));
    return e && e.operation === "PUT" ? { ...parseEndpointGate(e.value, epgateKey(ENDPOINT, iid)), revision: e.revision } : null;
  };

  // THE SEAM, wired exactly as the shipped manager wires it (`manager.ts` / `remote-register.ts`):
  // the SHIPPED core reader over the auth bucket. A suite that hand-rolled this read would be
  // grading a copy while the shipped one drifted.
  const observeHolderGeneration = (holderInstanceId: string) =>
    readEndpointGateGeneration(epKv, { endpoint: ENDPOINT, instanceId: holderInstanceId });

  const register = (kv: KV, instanceId: string, opts?: { seam?: boolean }) =>
    registerServiceInstance(kv, {
      space: SPACE, spec: specFor(), instanceId, registrant: { owner: DEV_OWNER }, authority,
      barrier: endpointRegistrationBarrier(epKv, SPACE, { endpoint: ENDPOINT, instanceId, opId: mintLifecycleUid(), evict: async () => true }),
      readClusterArtifact,
      ...(opts?.seam === false ? {} : { observeHolderGeneration }),
    });

  /** Fault ONE key's write at the store boundary. `mode` decides WHICH half of the boundary fails,
   *  and the distinction is the whole point of section 6:
   *    - "before": throw INSTEAD of writing. The write never commits. This is the process dying
   *      before the store saw it.
   *    - "after": perform the write, THEN throw. The write COMMITS and the ack is lost. This is the
   *      committed-but-unacked case the shipped slot-take comment describes, and it is the only way
   *      to produce a real orphan slot through the ambiguous path rather than by hand.
   *  Either way the residue is staged through the SHIPPED registration path; nothing writes the
   *  governance head or a gate row directly. */
  const faulting = (kv: KV, faultKey: string, mode: "before" | "after" = "before"): KV => new Proxy(kv, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if ((prop === "create" || prop === "update" || prop === "put") && typeof v === "function") {
        return async (key: string, ...rest: unknown[]) => {
          if (key !== faultKey) return (v as (...a: unknown[]) => unknown).call(target, key, ...rest);
          if (mode === "before") throw new Error("simulated store fault: the process died before this write committed");
          await (v as (...a: unknown[]) => unknown).call(target, key, ...rest);
          throw new Error("simulated store fault: the write COMMITTED and its ack was lost");
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });

  console.log("1. stage the operator's residue through the SHIPPED registration path");
  await provisionEndpointGateOpen(epKv, { endpoint: ENDPOINT, instanceId: IID_A, principal: principalKey(DEV_OWNER, "govslotaaaa").key });
  const specKeyA = recordSpecKey(RECORD_KINDS.svc, [ENDPOINT, IID_A]);
  const staged = await errOf(() => register(faulting(recordsKv, specKeyA), IID_A));
  c("A's registration dies at the PHASE-3 spec publish with the documented ambiguous outcome",
    staged.code === "unavailable" && /spec-write outcome is ambiguous/.test(staged.message), staged);

  const gateA0 = await readGate(IID_A);
  const gov0 = await readGov();
  const specA0 = await recordsKv.get(specKeyA);
  c("residue: A's gate is FROZEN under a registration op", gateA0?.state === "frozen" && gateA0?.op?.kind === "registration", gateA0);
  c("residue: the governance slot is HELD by A", gov0?.provisional?.instanceId === IID_A, gov0);
  c("residue: A published NO spec, so a deregistration has nothing to remove",
    !specA0 || specA0.operation !== "PUT", specA0?.operation);
  c("residue: the slot's stamp EQUALS the holder's frozen gate generation - the in-flight coordinate",
    gov0?.provisional?.generation === gateA0?.generation, { slot: gov0?.provisional?.generation, gate: gateA0?.generation });

  console.log("2. `cotal deregister-instance` still cannot reach a slot held by a spec publication");
  const dereg = await deregisterServiceInstance(recordsKv, {
    endpoint: ENDPOINT, instanceId: IID_A,
    observeGeneration: async () => (await readGate(IID_A))!.generation,
  });
  c("deregistration answers `absent` - correct, and still not an exit from this state",
    dereg.removed === false && dereg.reason === "absent", dereg);

  console.log("3. NEGATIVE CONTROL: the holder's gate is FROZEN at the slot's stamp, so B must REFUSE");
  await provisionEndpointGateOpen(epKv, { endpoint: ENDPOINT, instanceId: IID_B, principal: principalKey(DEV_OWNER, "govslotbbbb").key });
  const inFlight = await errOf(() => register(recordsKv, IID_B));
  c("B REFUSES while A's registration is genuinely in flight - a live slot is never stolen",
    inFlight.code === "conflict" && /holds the governance slot through its spec publication/.test(inFlight.message), inFlight);
  c("...and the refusal says the gate is still at the slot's generation, naming WHY it refused",
    /still at generation 0/.test(inFlight.message) && /IN FLIGHT/.test(inFlight.message), inFlight.message);
  c("...and names a remedy that reaches THIS state: reopen the holder's gate first",
    /cotal reconcile-gate --instance/.test(inFlight.message), inFlight.message);
  const govDuringFlight = await readGov();
  c("the in-flight slot is untouched by the refusal - still A's, still stamped 0",
    govDuringFlight?.provisional?.instanceId === IID_A && govDuringFlight?.provisional?.generation === 0, govDuringFlight);
  // HONEST ACCOUNTING for the matched pair. B's refusal above abort-reopened B's OWN gate, so by
  // section 5 B sits at a different generation than it did here. That is the operator's real
  // sequence (they retried), and it is not an input to the decision: the predicate reads the SLOT's
  // stamp against the HOLDER's gate, never the registrant's. Asserted rather than claimed, so the
  // pair is not credited with holding one variable fixed when a second one moved.
  const gateBAfterRefusal = await readGate(IID_B);
  c("the registrant's OWN gate moved between the pair's two halves, and is not an input to the predicate",
    gateBAfterRefusal?.generation === 1 && gateBAfterRefusal.state === "open", gateBAfterRefusal);

  console.log("4. is that control a DISCRIMINATOR? re-run its observation through a LOOSENED predicate");
  // The single most plausible off-by-one a future edit introduces: `<` widened to `<=`, which reads
  // an in-flight slot as orphaned. If section 3 would stay green under this, it is guarding nothing.
  {
    const slotGen = govDuringFlight!.provisional!.generation;
    const liveGen = await observeHolderGeneration(IID_A);
    const shipped = liveGen > slotGen;          // the predicate the fix ships
    const loosened = liveGen >= slotGen;        // the off-by-one
    c("at section 3's exact coordinate the SHIPPED predicate refuses and the LOOSENED one admits",
      shipped === false && loosened === true, { slotGen, liveGen, shipped, loosened });
    c("...so section 3 is a real discriminator: a loosened predicate turns THAT cell red, not this one",
      loosened !== shipped, { shipped, loosened });
  }

  console.log("5. THE FIX: reconciliation reopens the holder's gate, and B's own start reclaims the slot");
  const reconcileA = await errOf(() => reconcileEndpointGate({
    kv: epKv, space: SPACE, endpoint: ENDPOINT, instanceId: IID_A,
    probeHolder: async () => ({ state: "gone", detail: "smoke: CONNZ sweep proves the holder absent" }),
    evict: async () => true,
    log: () => {},
    recordsKv,
  }) as Promise<{ reopenedAtGeneration: number }>);
  c("reconciliation reopens A's gate at the successor generation",
    reconcileA.message === "NO THROW", reconcileA);
  const gateA1 = await readGate(IID_A);
  const govBefore = await readGov();
  c("the slot is NOW provably orphaned: still stamped 0 while its holder's gate is OPEN at 1",
    gateA1?.state === "open" && gateA1.generation === gateA0!.generation + 1
    && govBefore?.provisional?.generation !== undefined
    && govBefore.provisional.generation < gateA1.generation,
    { slot: govBefore?.provisional?.generation, gate: gateA1?.generation, state: gateA1?.state });

  const reclaimed = await errOf(() => register(recordsKv, IID_B));
  c("B REGISTERS - the state the operator could not exit is now exited by B's ordinary start",
    reclaimed.message === "NO THROW", reclaimed);
  const govAfter = await readGov();
  c("the slot is released after B's completing reopen, not left held by the dead instance",
    govAfter?.provisional === undefined, govAfter);
  const specB = await recordsKv.get(recordSpecKey(RECORD_KINDS.svc, [ENDPOINT, IID_B]));
  c("B's spec is published, so the endpoint is actually serviceable again", specB?.operation === "PUT", specB?.operation);

  console.log("6. the residue `reconcile-gate` CANNOT reach: an AMBIGUOUS slot-take, holder gate left OPEN");
  // ONE registration produces this whole residue, through the shipped path, with no hand-staging.
  // The slot-take COMMITS and its ack is lost, so `registerServiceInstance` classifies it as the
  // ambiguous slot-take, and its own outer catch abort-reopens C's gate at generation+1. What is
  // left is exactly the state the shipped comment describes: a committed-but-unacked slot stamped
  // at the generation the reopen advanced PAST. Nothing here writes the head or a gate row.
  await provisionEndpointGateOpen(epKv, { endpoint: ENDPOINT, instanceId: IID_C, principal: principalKey(DEV_OWNER, "govslotcccc").key });
  const stagedC = await errOf(() => register(faulting(recordsKv, govKey, "after"), IID_C));
  c("C's slot-take COMMITS but its ack is lost, so the registration reports the ambiguous slot-take",
    stagedC.code === "unavailable" && /governance slot-take .* is ambiguous/.test(stagedC.message), stagedC);
  const gateC = await readGate(IID_C);
  const govC = await readGov();
  c("the shipped abort-reopen left C's gate OPEN at generation 1 - nothing is frozen to reconcile",
    gateC?.state === "open" && gateC.generation === 1, gateC);
  c("...and the committed slot survives, stamped at 0, behind the gate the reopen advanced",
    govC?.provisional?.instanceId === IID_C && govC.provisional.generation === 0, govC);
  const refusedByReconciler = await errOf(() => reconcileEndpointGate({
    kv: epKv, space: SPACE, endpoint: ENDPOINT, instanceId: IID_C,
    probeHolder: async () => ({ state: "gone", detail: "smoke: holder proven absent" }),
    evict: async () => true, log: () => {}, recordsKv,
  }));
  c("`reconcile-gate` REFUSES this residue `not-frozen`, so it has no repair-tool exit at all",
    /not "frozen"/.test(refusedByReconciler.message), refusedByReconciler.message);

  await provisionEndpointGateOpen(epKv, { endpoint: ENDPOINT, instanceId: IID_D, principal: principalKey(DEV_OWNER, "govslotdddd").key });
  const dReg = await errOf(() => register(recordsKv, IID_D));
  c("a successor reclaims an orphan whose holder gate is OPEN - the residue with no repair-tool exit",
    dReg.message === "NO THROW", dReg);

  console.log("7. a reclaim carries the endpoint's BINDING impositions forward, never launders them");
  const govFinal = await readGov();
  const govBeforeReclaim = govBefore!;
  c("the binding command map survived every reclaim above unchanged - only `provisional` is replaced",
    JSON.stringify(govFinal?.commands) === JSON.stringify(govBeforeReclaim.commands), { before: govBeforeReclaim.commands, after: govFinal?.commands });

  console.log("8. every doubtful observation FAILS CLOSED (AGENTS.md: throw, never silently degrade)");
  // Re-stage a genuine orphan, then aim a doubtful seam at it. Each case below WOULD be reclaimed
  // on a good observation, so a green cell here is the refusal and never an incidental block.
  await provisionEndpointGateOpen(epKv, { endpoint: ENDPOINT, instanceId: IID_E, principal: principalKey(DEV_OWNER, "govsloteeee").key });
  const specKeyE = recordSpecKey(RECORD_KINDS.svc, [ENDPOINT, IID_E]);
  const healE = () => stage("reopen E's gate", () => reconcileEndpointGate({
    kv: epKv, space: SPACE, endpoint: ENDPOINT, instanceId: IID_E,
    probeHolder: async () => ({ state: "gone", detail: "smoke: holder proven absent" }),
    evict: async () => true, log: () => {}, recordsKv,
  }));
  // Staged TWICE on purpose, so the orphan's stamp lands at generation 1 rather than 0. A stamp of
  // 0 has nothing below it, so the `behind the stamp` case could not be expressed against it and
  // that fail-closed branch would go ungraded while its cell still read green.
  await errOf(() => register(faulting(recordsKv, specKeyE), IID_E));
  await healE();
  await errOf(() => register(faulting(recordsKv, specKeyE), IID_E));
  await healE();
  const govOrphan = await readGov();
  const gateOrphan = await readGate(IID_E);
  c("an orphan is staged for section 8: slot behind its holder's live gate, and its stamp is above 0",
    govOrphan?.provisional?.instanceId === IID_E && gateOrphan !== null
    && govOrphan.provisional!.generation > 0 && govOrphan.provisional!.generation < gateOrphan.generation,
    { slot: govOrphan?.provisional?.generation, gate: gateOrphan?.generation });

  await provisionEndpointGateOpen(epKv, { endpoint: ENDPOINT, instanceId: IID_F, principal: principalKey(DEV_OWNER, "govslotffff").key });
  const withSeam = (seam: (h: string) => Promise<number> | number) =>
    errOf(() => registerServiceInstance(recordsKv, {
      space: SPACE, spec: specFor(), instanceId: IID_F, registrant: { owner: DEV_OWNER }, authority,
      barrier: endpointRegistrationBarrier(epKv, SPACE, { endpoint: ENDPOINT, instanceId: IID_F, opId: mintLifecycleUid(), evict: async () => true }),
      readClusterArtifact, observeHolderGeneration: seam,
    }));

  const noSeam = await errOf(() => register(recordsKv, IID_F, { seam: false }));
  c("NO SEAM wired -> refuses exactly as today, so no caller silently gains a reclaim it never asked for",
    noSeam.code === "conflict" && /cannot observe that instance's issuance gate/.test(noSeam.message), noSeam);
  const threw = await withSeam(() => { throw new Error("auth store unreachable"); });
  c("the observation THROWS -> `unavailable`; unreadable is not absent",
    threw.code === "unavailable" && /could not be observed/.test(threw.message), threw);
  const garbled = await withSeam(() => "7" as unknown as number);
  c("a non-integer observation -> `unavailable`; a garbled generation is never coerced",
    garbled.code === "unavailable" && /not an unsigned generation/.test(garbled.message), garbled);
  const behind = await withSeam(() => 0);
  c("an observation BEHIND the slot's stamp -> `unavailable`; ahead-or-garbled never licenses a reclaim",
    behind.code === "unavailable" && /ahead of its observed live gate generation/.test(behind.message), behind);
  // The positive control for this whole section: the SAME registrant against the SAME orphan, with
  // a truthful seam, SUCCEEDS. Without it every refusal above could be an incidental block rather
  // than the fail-closed branch it names.
  const truthful = await withSeam(observeHolderGeneration);
  c("...while a TRUTHFUL observation of that same orphan reclaims it - the refusals above are the guard, not a block",
    truthful.message === "NO THROW", truthful);

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
console.log(`\n${fail === 0 ? "GOVERNANCE SLOT ORPHAN SMOKE OK ✅" : "GOVERNANCE SLOT ORPHAN SMOKE FAILED"}  (${ok} passed, ${fail} failed, ${EXPECTED_CELLS} expected)`);
process.exit(fail === 0 ? 0 : 1);

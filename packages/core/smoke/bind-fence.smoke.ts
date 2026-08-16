/**
 * THE BOUND-INCARNATION FENCE: A REFUSAL THAT HAPPENS BEFORE THE EFFECT (SPEC §13.2/§13.3).
 *
 * A class-anycast caller resolves one incarnation and then invokes through a queue that may pick a
 * different one. Until now the mismatch was only ever noticed by the CALLER, on the reply — by
 * which time the responder had already run the command. That is why `EP_UNBOUND_RESPONDER` has to
 * say "THIS SAYS NOTHING ABOUT WHETHER THE COMMAND RAN": a check on a reply is a report, not a
 * guard. `bind` moves the question to the only party that can answer it in time.
 *
 * WHAT THIS SUITE HAS TO PROVE, AND HOW IT KNOWS. The claim is not "a refusal is produced" — the
 * old behaviour produced one too. The claim is "and nothing ran". So every refusal cell is graded
 * against an OBSERVABLE EFFECT: each serving instance counts its own handler entries, and the
 * refusal cells assert that count did not move. A count that never moves is also what a broken
 * fixture produces, so each is twinned with a cell that drives the SAME request without the bind
 * and requires the count TO move. Neither half is evidence on its own.
 *
 * THE SEAM ORDER IS PART OF THE CLAIM. "Nothing ran" is only true while the fence stays ahead of
 * everything in `handle` that can cause anything — including the governed gate, which awaits a
 * guard and may consume a one-use priced proof. Two cells send hand-built requests that are ALSO
 * invalid in another way (bad args, wrong contract digest) and require the bind refusal, not the
 * other error: a fence that had drifted below those checks would answer with the other code and
 * they would redden. What they do NOT reach is the governed gate itself; that ordering is
 * argued from position in `handle`, not measured here.
 *
 * Live: real broker, real registry records, real `serveEndpoint`, real rails. Needs `nats-server`
 * on PATH. Run: pnpm smoke:bind-fence
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { randomBytes } from "node:crypto";
import {
  EpEnvelopeError, EP_BIND_REFUSED, replyRefusedBeforeEffect,
  openRecordsBucket, registerServiceInstance, writeServiceStatus, authorizeServeGrant,
  serveEndpoint, epCall, epRequestSubject, epCallerReplyFilter, parseEpSubject,
  compileContract, contractDigest, parseEndpointRequest, checkRequestSubjectAgreement,
  SERVICE_READY,
  type EpCaller, type EpCommandDef, type EpIssuanceBarrier, type EndpointReply,
  type ParsedEpRequest, type ServiceNameAuthority, type ServiceSpec,
} from "../src/index.js";
import type { KV } from "@nats-io/kv";
import { pickFreePort } from "./_free-port.js";

let pass = 0, fail = 0;
/** A cell RECORDS its verdict and never throws: one throwing cell would take every cell below it
 *  with it, and a suite that stops early still exits 0 unless the count below catches it. The tick
 *  is the repo's `✓` — `mutation-proof` counts those to tell "failed at my assertion" from "died
 *  before reaching it", and a suite with its own glyph reports 0 marks and loses that silently. */
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const rejects = async (name: string, fn: () => Promise<unknown>, code?: string) => {
  try { await fn(); c(name, false, "did not throw"); }
  catch (e) { c(name, code === undefined || (e instanceof EpEnvelopeError && e.code === code), (e as EpEnvelopeError).code ?? (e as Error).message); }
};
const throws = (name: string, fn: () => unknown, code?: string) => {
  try { fn(); c(name, false, "did not throw"); }
  catch (e) { c(name, code === undefined || (e instanceof EpEnvelopeError && e.code === code), (e as EpEnvelopeError).code ?? (e as Error).message); }
};

/** Declared, not implied: a live suite can end early in ways that redden no cell — a broker that
 *  never came up, a hang the runner kills, a top-level rejection — and `fail === 0` reads as PASS
 *  in every one of them, with the exit code to match. */
const EXPECTED_CELLS = 18;
process.on("exit", () => {
  const ran = pass + fail;
  if (ran !== EXPECTED_CELLS) {
    console.log(`\nSUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
    process.exitCode = 1;
  }
});

const SPACE = "bindfence";
const EP = "manager";
const IID_A = "a".repeat(26);
const IID_B = "b".repeat(26);
const IID_LIAR = "c".repeat(26);
const GHOST = "g".repeat(26); // a well-formed instance id that serves nothing
const EPOCH = 1;
const caller: EpCaller = { owner: "u_op", actor: "cli", uid: "u".repeat(26) };
const asOp = { owner: "u_op" };

const argsContract = compileContract({ root: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false } });
const outContract = compileContract({ root: { type: "object", properties: { which: { type: "string" } }, required: ["which"], additionalProperties: false } });
const contract = { input: argsContract, output: outContract };

const DOC = {
  urn: "ai.cotal.manager", revision: 1, attributes: [], events: [],
  commands: [{ name: "poke", class: "ephemeral", targeted: false, capability: "manager.call", inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest }],
};
const store = new Map<string, unknown>();
const rootDigest = contractDigest(DOC);
const manifest = { v: 1, root: rootDigest, members: [] as string[] };
const DC = contractDigest(manifest);
store.set(rootDigest, DOC);
store.set(DC, manifest);
const readClusterArtifact = (d: string) => store.get(d);
const authority: ServiceNameAuthority = { authorize: (_n, owner) => ({ authorized: owner === "u_op", revision: 0 }) };
const spec: ServiceSpec = { endpoint: EP, owner: "u_op", clusterDigests: [DC], protocol: { v: 1 } };

// A faithful freeze -> (spec write) -> reopen writer; the fence internals are proven elsewhere.
const gates = new Map<string, { space: string; endpoint: string; lifecycleUid: string; principal: string; state: "open" | "frozen" | "retired"; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number; revision: number }>();
function barrierFor(instanceId: string): EpIssuanceBarrier {
  if (!gates.has(instanceId))
    gates.set(instanceId, { space: SPACE, endpoint: EP, lifecycleUid: instanceId, principal: "u_op.mgr", state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, revision: 1 });
  const g = gates.get(instanceId)!;
  return {
    observe: () => ({ ...g }),
    freeze: (rev) => { if (g.state !== "open" || g.revision !== rev) return null; g.state = "frozen"; g.revision++; return g.revision; },
    enumerate: () => [],
    revoke: () => {},
    evict: () => true,
    reopen: (token, succ) => { if (g.state !== "frozen" || g.revision !== token) return false; g.state = "open"; g.generation = succ.generation; g.processEpoch = succ.processEpoch; g.registrationRevision = succ.registrationRevision; g.nameAuthorityRevision = succ.nameAuthorityRevision; g.revision++; return true; },
  };
}

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "bindfence-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));

const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const enc = new TextEncoder(), dec = new TextDecoder();
try {
  const kv = await openRecordsBucket(nc, SPACE, { create: true });

  /** Bring one instance up: register, publish READY, authorize the serve artifact, serve `poke`
   *  with a handler that COUNTS its entries. The count is the whole instrument — it is what turns
   *  "a refusal came back" into "and the command did not run". */
  const runs: Record<string, number> = { [IID_A]: 0, [IID_B]: 0, [IID_LIAR]: 0 };
  const bring = async (instanceId: string, handler?: EpCommandDef["handler"]) => {
    const reg = await registerServiceInstance(kv as KV, { spec, instanceId, registrant: asOp, authority, space: SPACE, barrier: barrierFor(instanceId), readClusterArtifact });
    await writeServiceStatus(kv as KV, { endpoint: EP, instanceId, epoch: EPOCH, readProcessEpoch: () => EPOCH, status: { epoch: EPOCH, state: SERVICE_READY, observedSpecRevision: reg.registrationRevision } });
    const grant = await authorizeServeGrant(kv as KV, { space: SPACE, endpoint: EP, instanceId, epoch: EPOCH, holder: asOp, authority, readProcessEpoch: () => EPOCH, readClusterArtifact });
    const def: EpCommandDef = {
      command: "poke", contract,
      handler: handler ?? (() => { runs[instanceId]++; return { which: instanceId }; }),
    };
    return serveEndpoint(nc, SPACE, grant, [def], { public: true });
  };

  const served = [await bring(IID_A)];

  // The currency hook is a REGISTRY read (every live instance is at EPOCH), which is deliberate:
  // it means the caller-side currency check accepts a reply from any current member, so it can
  // never be the thing that refuses below. Whatever refuses, the responder refused.
  const registryEpoch = () => EPOCH;
  const call = (bind?: { instanceId: string; epoch: number }, args: Record<string, unknown> = { n: 1 }) =>
    epCall(nc, SPACE, { mode: "one" }, { endpoint: EP, command: "poke", contract, caller, args, ...(bind ? { bind } : {}) }, { deadlineMs: 8000, currentEpoch: registryEpoch });

  console.log("\n1. the twin: the same call, with and without a bind it cannot satisfy");
  // WITHOUT the bind this request runs. That is not a warm-up: it is the control that makes every
  // "did not run" below mean something, and it is also exactly the pre-fence behaviour — a caller
  // that resolved elsewhere still gets its effect executed by whoever the queue picked.
  const control = await call();
  c("an UNBOUND call is served and the handler runs", control.reply.ok === true && runs[IID_A] === 1, { reply: control.reply, runs: runs[IID_A] });

  const refused = await call({ instanceId: GHOST, epoch: EPOCH });
  c("a call bound to another incarnation comes back ok:false failed-precondition",
    refused.reply.ok === false && refused.reply.error?.code === "failed-precondition", refused.reply);
  c("...carrying the bind-refused marker (what a caller keys on, never the code)",
    replyRefusedBeforeEffect(refused.reply.error), refused.reply.error);
  c("...AND THE HANDLER DID NOT RUN — the count is unmoved from the control's 1",
    runs[IID_A] === 1, runs[IID_A]);
  c("...the reply is still attributed to the instance that refused, off the SUBJECT",
    refused.responder.instanceId === IID_A && refused.responder.epoch === EPOCH, refused.responder);

  console.log("\n2. the same instance at another epoch is a different incarnation");
  const stale = await call({ instanceId: IID_A, epoch: EPOCH + 7 });
  c("a bind to a later epoch of the SAME instance is expired, not failed-precondition",
    stale.reply.ok === false && stale.reply.error?.code === "expired" && replyRefusedBeforeEffect(stale.reply.error), stale.reply);
  c("...and it too ran nothing", runs[IID_A] === 1, runs[IID_A]);
  const exact = await call({ instanceId: IID_A, epoch: EPOCH });
  c("a bind to the EXACT incarnation is served (the fence admits, it does not just refuse)",
    exact.reply.ok === true && runs[IID_A] === 2, { reply: exact.reply, runs: runs[IID_A] });

  console.log("\n3. the fence is AHEAD of the checks whose codes would otherwise answer");
  /** Publish a hand-built request and read its reply. The caller-side verbs refuse a bad request
   *  before publishing it (which is correct, and which is why the seam order below cannot be
   *  reached through them): to grade what the RESPONDER checks first, the request has to go out
   *  malformed. */
  const raw = async (env: Record<string, unknown>, command = "poke"): Promise<EndpointReply> => {
    const nonce = randomBytes(24).toString("base64url");
    const subject = epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: EP, command, caller, nonce });
    const body = {
      v: 1, id: nonce.slice(0, 60), op: { endpoint: EP, command, inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest },
      class: "ephemeral", replyExpected: true, deadlineMs: 8000,
      from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor }, ...env,
    };
    const sub = nc.subscribe(epCallerReplyFilter(SPACE, caller));
    try {
      nc.publish(subject, enc.encode(JSON.stringify(body)));
      const deadline = Date.now() + 8000;
      for await (const m of sub) {
        const p = parseEpSubject(m.subject);
        if (p?.plane === "reply" && p.nonce === nonce) return JSON.parse(dec.decode(m.data)) as EndpointReply;
        if (Date.now() > deadline) break;
      }
      throw new Error("no reply");
    } finally { sub.unsubscribe(); }
  };

  const badArgs = await raw({ bind: { instanceId: GHOST, epoch: EPOCH }, args: { n: "not a number" } });
  c("a bind mismatch with INVALID ARGS answers the bind refusal, not bad-request",
    badArgs.ok === false && badArgs.error?.code === "failed-precondition" && replyRefusedBeforeEffect(badArgs.error), badArgs.error);
  const badDigest = await raw({
    bind: { instanceId: GHOST, epoch: EPOCH }, args: { n: 1 },
    op: { endpoint: EP, command: "poke", inputDigest: `sha256:${"f".repeat(64)}`, outputDigest: outContract.closureDigest },
  });
  c("a bind mismatch with a WRONG CONTRACT DIGEST answers the bind refusal, not contract-mismatch",
    badDigest.ok === false && badDigest.error?.code === "failed-precondition" && replyRefusedBeforeEffect(badDigest.error), badDigest.error);
  c("...and neither malformed request ran anything either", runs[IID_A] === 2, runs[IID_A]);

  console.log("\n4. where a bind has no reading, it is refused rather than ignored");
  throws("describe carries no bind (it is what PRODUCES one)",
    () => parseEndpointRequest({ v: 1, id: "x", op: { endpoint: EP, command: "describe" }, class: "ephemeral", replyExpected: true, deadlineMs: 100, bind: { instanceId: IID_A, epoch: 1 }, from: { id: "u_op.cli", name: "cli" } }), "bad-request");
  {
    // The scatter rule lives in the subject-agreement half — the route is only knowable there —
    // so it is graded against a real parsed scatter subject, not a hand-declared route.
    const scatterSubject = parseEpSubject(epRequestSubject(SPACE, { route: { mode: "all" }, endpoint: EP, command: "poke", caller, nonce: randomBytes(24).toString("base64url") })) as ParsedEpRequest;
    const env = parseEndpointRequest({
      v: 1, id: "x", op: { endpoint: EP, command: "poke", inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest },
      class: "ephemeral", replyExpected: true, deadlineMs: 100, args: { n: 1 },
      bind: { instanceId: IID_A, epoch: 1 }, from: { id: "u_op.cli", name: "cli" },
    });
    throws("a scatter carrying a bind is refused: it addresses every incarnation by construction",
      () => checkRequestSubjectAgreement(env, scatterSubject), "bad-request");
  }
  await rejects("an inst-rail bind that names a DIFFERENT instance than the subject is refused at the caller",
    () => epCall(nc, SPACE, { mode: "inst", instanceId: IID_A, epoch: EPOCH },
      { endpoint: EP, command: "poke", contract, caller, args: { n: 1 }, bind: { instanceId: IID_B, epoch: EPOCH } },
      { deadlineMs: 100, currentEpoch: registryEpoch }), "bad-request");

  console.log("\n5. a responder does not get to contradict its own attribution");
  // A LIAR: it serves, and its handler claims the bind refusal for an incarnation that IS itself.
  // The marker is a body field, so a responder could always emit one after doing the work; what
  // stops that from becoming a free "nothing ran" is the caller cross-checking it against the
  // reply SUBJECT, which the broker pins.
  const liar = await bring(IID_LIAR, () => {
    runs[IID_LIAR]++;
    throw new EpEnvelopeError("failed-precondition", "I did not run this (I did)", [
      { kind: EP_BIND_REFUSED, endpoint: EP, command: "poke", boundTo: { instanceId: IID_LIAR, epoch: EPOCH }, servedBy: { instanceId: GHOST, epoch: EPOCH } },
    ]);
  });
  // Address the liar directly so the class queue cannot hand this to A.
  await rejects("a bind refusal from the very incarnation the caller bound is internal, never honored",
    () => epCall(nc, SPACE, { mode: "inst", instanceId: IID_LIAR, epoch: EPOCH },
      { endpoint: EP, command: "poke", contract, caller, args: { n: 1 }, bind: { instanceId: IID_LIAR, epoch: EPOCH } },
      { deadlineMs: 8000, currentEpoch: registryEpoch }), "internal");
  c("...and the liar did run, which is the point: the marker alone is not proof", runs[IID_LIAR] === 1, runs[IID_LIAR]);
  // Off the class queue before section 6, or it wins some of those calls and answers them with
  // its fake refusal — which would be counted as neither served-by-A nor refused-by-B.
  await liar.stop();

  console.log("\n6. a real two-member class queue");
  served.push(await bring(IID_B));
  const before = { ...runs };
  let servedByA = 0, refusedByB = 0;
  for (let i = 0; i < 12; i++) {
    const r = await call({ instanceId: IID_A, epoch: EPOCH });
    if (r.reply.ok === true) servedByA++;
    else if (replyRefusedBeforeEffect(r.reply.error) && r.responder.instanceId === IID_B) refusedByB++;
  }
  // AN OBSERVATION, NOT THE CLAIM. Which member the queue picks is the broker's business, and
  // `smoke:queue-win` measured it as sticky on one box — so this cell is VACUOUS on a run where
  // every request went to A, and the printed split is what says which run this was. The invariant
  // it does assert holds either way: B never executed a request bound to A.
  c(`B executed nothing bound to A (observed: ${servedByA} served by A, ${refusedByB} refused by B${refusedByB === 0 ? " - VACUOUS on this run, the queue never spread" : ""})`,
    runs[IID_B] === before[IID_B] && servedByA + refusedByB === 12, { runs, before });
  c("...and every request bound to A that A got, A ran", runs[IID_A] === before[IID_A] + servedByA, { runs, before, servedByA });

  await Promise.all(served.map((s) => s.stop()));
} finally {
  await nc.drain().catch(() => nc.close());
  broker.kill("SIGTERM");
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;

/**
 * v0.4 §13.10 RECEIPT smoke — the signed request→outcome binding: mint (digests computed from
 * the raw evidence), closed identity-bound parsing (caller evidence must name the subject's
 * caller triple), create-only publication on the caller- and execution-scoped subject through
 * the space-bonded store context (one execution, one receipt, forever — a different receipt on
 * the subject is a loud conflict, and the published candidate is a detached entry snapshot),
 * and UNCONDITIONAL verification (exact-raw D28 signature via the `receipts` anchor role +
 * endpoint scope + window, PLUS mandatory digest recomputation from evidence read once at
 * entry and compared before the anchor await; the explicitly weaker signature-only read is
 * its own named operation).
 *
 * Run: pnpm smoke:ep-receipt   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createUser } from "@nats-io/nkeys";
import {
  isReachable, EpEnvelopeError, contractDigest,
  createEndpointStreams,
  mintReceipt, mintReceiptFromFacts, receiptOutcomeOfGoal, parseReceipt, publishReceipt, readReceipt, verifyReceipt, verifyReceiptSignature,
  receiptSubject, receiptStoreContext,
  type EpCaller, type ReceiptRef, type Receipt, type ReceiptStoreContext, type SignerAnchor, type AnchorResolver,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "eprcpt";
const NOW = 1_000_000;
const UID = "u".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const ref: ReceiptRef = { endpoint: "manager", caller, requestId: "req-1", sourceSeq: 42 };
const kp = createUser();
const anchors = new Map<string, SignerAnchor>();
anchors.set("rcpt-1", { keyId: "rcpt-1", publicKey: kp.getPublicKey(), owner: "u_mgr", roles: ["receipts"], scope: { receipts: ["manager"] }, validFrom: 0, validTo: NOW + 10_000_000 });
anchors.set("narrow-1", { keyId: "narrow-1", publicKey: kp.getPublicKey(), owner: "u_mgr", roles: ["receipts"], scope: { receipts: ["other"] }, validFrom: 0, validTo: NOW + 10_000_000 });
const resolveAnchor: AnchorResolver = (keyId) => anchors.get(keyId);

const ARGS = { image: "app:1", replicas: 3 };
const RESULT = { deployed: true };
const EVIDENCE = { args: ARGS, result: RESULT };
const SCHEMAS = { input: contractDigest({ in: 1 }), output: contractDigest({ out: 1 }) };
const mint = (over: Record<string, unknown> = {}): Receipt => mintReceipt({
  ref, space: SPACE, command: "deploy",
  instance: { id: "u_mgr.manager", instanceId: "i".repeat(26), epoch: 2 },
  caller: { id: "u_abc.worker", lifecycleUid: UID },
  schemaDigests: SCHEMAS, args: ARGS, outcome: { ok: true }, result: RESULT, ts: NOW,
  signer: { keyId: "rcpt-1" }, ...over,
} as Parameters<typeof mintReceipt>[0], kp);

// ── mint + parse + verify (broker-free) ──
const receipt = mint();
c("mint digests the RAW evidence itself (argsDigest/resultDigest recompute)",
  receipt.argsDigest === contractDigest(ARGS) && receipt.resultDigest === contractDigest(RESULT) && receipt.sig.length > 0);
c("the receipt subject is caller- and execution-scoped",
  receiptSubject(SPACE, ref).endsWith(`.receipt.u_abc.worker.${UID}.req-1.42`));
c("parse binds the receipt to its subject coordinates", parseReceipt(receipt as unknown as Record<string, unknown>, ref, SPACE).requestId === "req-1");
await rejects("a receipt read under FOREIGN coordinates is rejected (request-mismatched receipts fail loud)",
  () => parseReceipt(receipt as unknown as Record<string, unknown>, { ...ref, requestId: "req-OTHER" }, SPACE), "internal");
await rejects("a receipt whose CALLER EVIDENCE does not name its subject's caller triple never attests (forged attribution)",
  () => parseReceipt(mint({ caller: { id: "u_evil.actor", lifecycleUid: UID } }) as unknown as Record<string, unknown>, ref, SPACE), "internal");
{
  const verified = await verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: EVIDENCE });
  c("a genuine receipt verifies: exact-raw signature + full digest recomputation", verified.outcome.ok === true);
}
// §13.10 is UNCONDITIONAL: signature PLUS digest recomputation. Evidence is mandatory.
await rejects("verification WITHOUT evidence refuses (signature + digest recomputation are both mandatory, SPEC 13.10)",
  () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor } as unknown as Parameters<typeof verifyReceipt>[1]), "failed-precondition");
await rejects("a receipt attesting a result REQUIRES the result evidence (verification recomputes every digest carried)",
  () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: { args: ARGS } }), "failed-precondition");
await rejects("a receipt whose argsDigest does not recompute from the presented args fails loud",
  () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: { args: { image: "app:1", replicas: 999 }, result: RESULT } }), "permission-denied");
await rejects("a receipt whose resultDigest does not recompute from the presented result fails loud",
  () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: { args: ARGS, result: { deployed: false } } }), "permission-denied");
{
  const noResult = mint({ result: undefined });
  await rejects("a receipt with NO resultDigest cannot attest a presented result",
    () => verifyReceipt(noResult, { ref, space: SPACE, resolveAnchor, recompute: { args: ARGS, result: RESULT } }), "permission-denied");
}
{
  const tampered = { ...receipt, outcome: { ok: false } };
  await rejects("a TAMPERED receipt (outcome flipped after signing) fails its signature",
    () => verifyReceipt(tampered, { ref, space: SPACE, resolveAnchor, recompute: EVIDENCE }), "permission-denied");
}
await rejects("a receipt signed by a key whose `receipts` scope does not cover the endpoint fails",
  () => verifyReceipt(mint({ signer: { keyId: "narrow-1" } }), { ref, space: SPACE, resolveAnchor, recompute: EVIDENCE }), "permission-denied");
await rejects("a receipt naming an UNKNOWN signing key fails closed",
  () => verifyReceipt(mint({ signer: { keyId: "ghost" } }), { ref, space: SPACE, resolveAnchor, recompute: EVIDENCE }), "permission-denied");
await rejects("a receipt signed OUTSIDE the anchor's validity window fails",
  () => verifyReceipt(mint({ ts: NOW + 20_000_000 }), { ref, space: SPACE, resolveAnchor, recompute: EVIDENCE }), "permission-denied");
await rejects("a garbled receipt (unknown field) never attests",
  () => parseReceipt({ ...receipt, rogue: 1 }, ref, SPACE), "internal");
await rejects("a STUCK anchor registry is a bounded unavailable refusal, never a hung verification",
  () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor: () => new Promise(() => { /* never settles */ }), recompute: EVIDENCE, verifyBudgetMs: 100 }), "unavailable");
await rejects("a non-positive verifyBudgetMs refuses",
  () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: EVIDENCE, verifyBudgetMs: 0 }), "failed-precondition");

// ── CF-1: a receipt minted FROM THE FACTS derives every attestation field from the acceptance
//    fact + the committed terminal, never a free param — so it cannot attest an outcome or
//    identity that disagrees with the committed record. ──
{
  const OUT_DIGEST = contractDigest(RESULT);
  const acc = {
    v: 1, id: "req-1", decision: "accepted", fingerprint: "sha256:" + "a".repeat(64),
    request: { v: 1, id: "req-1", op: { endpoint: "manager", command: "deploy", inputDigest: SCHEMAS.input, outputDigest: SCHEMAS.output }, class: "journal", replyExpected: true, args: ARGS, from: { id: "u_abc.worker", name: "w" } },
    caller: { id: "u_abc.worker", lifecycleUid: UID },
    contractDigests: SCHEMAS, authzDecision: { revision: 1, epoch: 1 }, route: "effects",
    sourceSeq: 42, ts: NOW,
  } as unknown as Parameters<typeof mintReceiptFromFacts>[0]["acceptance"];
  const instance = { id: "u_mgr.manager", instanceId: "i".repeat(26), epoch: 2 };
  const fromFacts = (over: Record<string, unknown> = {}): Receipt => mintReceiptFromFacts({
    acceptance: acc, caller, space: SPACE, terminal: receiptOutcomeOfGoal("succeeded", OUT_DIGEST),
    instance, ts: NOW, signer: { keyId: "rcpt-1" }, ...over,
  } as Parameters<typeof mintReceiptFromFacts>[0], kp);

  const rf = fromFacts();
  c("mintReceiptFromFacts derives identity from the ACCEPTANCE: requestId, sourceSeq, endpoint, command, schemas, argsDigest",
    rf.requestId === "req-1" && rf.sourceSeq === 42 && rf.endpoint === "manager" && rf.command === "deploy"
    && rf.schemaDigests.input === SCHEMAS.input && rf.argsDigest === contractDigest(ARGS));
  c("…and its OUTCOME from the committed terminal (a succeeded goal → ok, its outcomeDigest re-attested, never re-digested)",
    rf.outcome.ok === true && rf.outcome.code === undefined && rf.resultDigest === OUT_DIGEST);
  c("…and it verifies against the acceptance's own args + the terminal's own result (the receipt agrees with both facts)",
    (await verifyReceipt(rf, { ref, space: SPACE, resolveAnchor, recompute: { args: ARGS, result: RESULT } })).outcome.ok === true);

  // The outcome comes from the TERMINAL: a failed goal attests failed with its state as the code.
  const failed = mintReceiptFromFacts({ acceptance: acc, caller, space: SPACE, terminal: receiptOutcomeOfGoal("failed", OUT_DIGEST), instance, ts: NOW, signer: { keyId: "rcpt-1" } }, kp);
  c("a receipt from a FAILED terminal attests { ok: false, code: 'failed' } (the outcome is the committed state, not a caller claim)",
    failed.outcome.ok === false && failed.outcome.code === "failed");

  // Fail-closed on every disagreement the binding exists to catch:
  await rejects("a caller triple that disagrees with the acceptance body's caller never mints (no split attribution)",
    () => fromFacts({ caller: { owner: "u_evil", actor: "worker", uid: UID } }), "internal");
  await rejects("a NON-accepted fact (a rejection) never mints a receipt",
    () => mintReceiptFromFacts({ acceptance: { ...acc, decision: "rejected" } as never, caller, space: SPACE, terminal: receiptOutcomeOfGoal("succeeded", OUT_DIGEST), instance, ts: NOW, signer: { keyId: "rcpt-1" } }, kp), "internal");
  await rejects("an acceptance whose contractDigests disagree with its own embedded request op digests is garbled, never minted",
    () => mintReceiptFromFacts({ acceptance: { ...acc, contractDigests: { input: contractDigest({ x: 9 }), output: SCHEMAS.output } } as never, caller, space: SPACE, terminal: receiptOutcomeOfGoal("succeeded", OUT_DIGEST), instance, ts: NOW, signer: { keyId: "rcpt-1" } }, kp), "internal");
  await rejects("an UNKNOWN goal terminal state never attests (only the §13.6 outcome states map)",
    () => receiptOutcomeOfGoal("bogus", OUT_DIGEST), "internal");
  await rejects("mintReceipt refuses a raw result AND a pre-committed resultDigest together (one source of the result digest)",
    () => mintReceipt({ ref, space: SPACE, command: "deploy", instance, caller: { id: "u_abc.worker", lifecycleUid: UID }, schemaDigests: SCHEMAS, args: ARGS, outcome: { ok: true }, result: RESULT, resultDigest: OUT_DIGEST, ts: NOW, signer: { keyId: "rcpt-1" } } as Parameters<typeof mintReceipt>[0], kp), "failed-precondition");
  // Convergence: with the facts agreeing with the raw evidence, the fact-derived path and the
  // raw-evidence path produce the BYTE-IDENTICAL receipt (same canonical body → same signature),
  // so a fact-derived re-mint after a crash is idempotent against a raw-path emission.
  c("the fact-derived path and the raw-evidence path converge on the identical signed receipt (idempotent re-mint)",
    rf.sig === receipt.sig);
}
{
  // TOCTOU (artifact half): a caller mutating the receipt DURING the awaited anchor resolution
  // cannot split the parsed value from what the D28 signature verifies — the raw is
  // snapshotted at entry.
  const r = { ...mint() } as Record<string, unknown>;
  const verified = await verifyReceipt(r, {
    ref, space: SPACE, recompute: EVIDENCE,
    resolveAnchor: (kid: string) => new Promise<SignerAnchor | undefined>((res) => { r.argsDigest = "sha256:tampered"; setTimeout(() => res(anchors.get(kid)), 20); }),
  });
  c("a mid-verification receipt mutation does NOT break verification (the raw artifact is snapshotted at entry)",
    verified.requestId === "req-1" && verified.sourceSeq === 42);
}
{
  // TOCTOU (proof half): the presented evidence is read ONCE and digested at ENTRY, and the
  // comparison runs BEFORE the anchor await — wrong-at-entry proof values refuse even if the
  // caller would "fix" them during the anchor resolution (which is never reached).
  let resolverCalled = false;
  const evidence = { args: { image: "app:1", replicas: 999 }, result: RESULT };
  await rejects("wrong-at-entry proof values refuse BEFORE the anchor is ever consulted (digests are entry-time detached scalars)",
    () => verifyReceipt(receipt, {
      ref, space: SPACE, recompute: evidence,
      resolveAnchor: (kid: string) => { resolverCalled = true; evidence.args = ARGS; return anchors.get(kid); },
    }), "permission-denied");
  c("…and the anchor resolver was never invoked (digest recomputation precedes it)", !resolverCalled);
  let argsReads = 0;
  const shifty = { get args() { return argsReads++ === 0 ? ARGS : { evil: 1 }; }, result: RESULT };
  c("a shifting evidence getter binds exactly the FIRST-read value (single-read at entry)",
    (await verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: shifty })).outcome.ok === true && argsReads === 1);
}
{
  // HIGH (distsys c50817d): args is DIGESTED before any other property access on the recompute
  // object. A `result` getter that mutates the args object AFTER its read (but before its digest,
  // in the pre-fix ordering) cannot make foreign evidence verify. Here args starts {replicas:999}
  // and the result getter mutates it in place to {replicas:3} == ARGS, what `receipt` attests.
  const mutableArgs = { image: "app:1", replicas: 999 };
  const mutatingEvidence = { args: mutableArgs, get result() { mutableArgs.replicas = 3; return RESULT; } };
  await rejects("a result-getter mutating the args object after its read cannot make foreign evidence verify (args is digested before any other rec access)",
    () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: mutatingEvidence }), "permission-denied");
}
{
  // MEDIUM (distsys c50817d): parseReceipt detaches its input at ENTRY, so a caller's live
  // getter/Proxy can never survive on the returned receipt. (a) An accessor-bearing receipt is
  // refused outright — canonicalization rejects a getter as code-not-data, so it can never split
  // the checked principal from a later-read one. (b) The returned value is a fresh copy: mutating
  // the source object after parse never changes it (pre-fix the parser returned the live object).
  const shiftyCaller = {
    ...receipt,
    get caller() { return { id: "u_evil.actor", lifecycleUid: UID }; },
  };
  await rejects("a receipt carrying an accessor property is refused (a getter is code, not data — never parsed, never split)",
    () => parseReceipt(shiftyCaller as unknown as Record<string, unknown>, ref, SPACE), "internal");
  const src = { ...receipt } as Record<string, unknown>;
  const parsed = parseReceipt(src, ref, SPACE);
  src.requestId = "req-EVIL";
  c("parseReceipt returns a detached snapshot: mutating the source after parse never changes the returned receipt",
    parsed.requestId === "req-1");
}
{
  // The explicitly WEAKER signature-only read: authenticity + coordinates, no digest claims.
  const authentic = await verifyReceiptSignature(receipt, { ref, space: SPACE, resolveAnchor });
  c("verifyReceiptSignature proves authenticity WITHOUT evidence (the deliberately weaker, separately named read)",
    authentic.requestId === "req-1");
  await rejects("…and a tampered receipt still fails its signature there",
    () => verifyReceiptSignature({ ...receipt, outcome: { ok: false } }, { ref, space: SPACE, resolveAnchor }), "permission-denied");
}

// ── create-only publication through the space-bonded context: one execution, one receipt ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-eprcpt-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  const ctx = await receiptStoreContext(nc, SPACE);

  await rejects("a hand-assembled context never authorizes (the space bond is constructed, not asserted; resources live in a module-private WeakMap, not on the token)",
    () => publishReceipt({ space: SPACE } as ReceiptStoreContext, ref, receipt), "failed-precondition");
  c("the context token exposes NO js/jsm to rebind (resources are WeakMap-private)",
    (ctx as unknown as Record<string, unknown>).js === undefined && (ctx as unknown as Record<string, unknown>).jsm === undefined);
  c("no receipt reads undefined", (await readReceipt(ctx, ref)) === undefined);
  const pub = await publishReceipt(ctx, ref, receipt);
  c("the first publication wins its create-only CAS", pub.won);
  const dup = await publishReceipt(ctx, ref, receipt);
  c("an IDENTICAL republish loses harmlessly and returns the recorded receipt (idempotent emit)", !dup.won && dup.receipt.sig === receipt.sig);
  await rejects("a DIFFERENT receipt for the same execution is a loud conflict (one execution, one receipt, forever)",
    () => publishReceipt(ctx, ref, mint({ ts: NOW + 5 })), "conflict");
  await rejects("publishing a receipt under coordinates it does not name refuses before writing",
    () => publishReceipt(ctx, { ...ref, requestId: "req-2" }, receipt), "internal");
  const back = await readReceipt(ctx, ref);
  c("the recorded receipt reads back identity-bound and re-verifies",
    back !== undefined && (await verifyReceipt(back, { ref, space: SPACE, resolveAnchor, recompute: EVIDENCE })).ts === NOW);

  {
    // The published candidate is a DETACHED entry snapshot: mutating the live receipt object
    // across the publish await changes neither what is stored nor what is returned.
    const ref2: ReceiptRef = { endpoint: "manager", caller, requestId: "req-2", sourceSeq: 43 };
    const live = { ...mint({ ref: ref2 }) } as Record<string, unknown>;
    const publishing = publishReceipt(ctx, ref2, live as unknown as Receipt);
    live.outcome = { ok: false }; // mutate while the publish awaits — after the entry snapshot
    const pub2 = await publishing;
    const stored = await readReceipt(ctx, ref2);
    c("a mid-publish mutation of the live receipt changes NOTHING (candidate snapshot published, compared, returned)",
      pub2.won && pub2.receipt.outcome.ok === true && stored?.outcome.ok === true);
  }

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT RECEIPT SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);

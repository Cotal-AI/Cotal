/**
 * RECEIPTS (SPEC §13.10): a receipt binds a request to its outcome, signed and non-repudiable,
 * for metering, disputes, and pipeline causality; payment semantics stay opaque to core.
 *
 * The artifact is the normative `Receipt` shape, RFC 8785 canonical, Ed25519-signed (D28: the
 * signature is over the sig-absent canonical form and is VERIFIED over the exact raw presented
 * artifact, never a reconstructed projection). Lifecycle and epoch ride as EVIDENCE, never
 * redemption authority. The fact lives create-only on the caller- and execution-scoped subject
 * `epf.<endpoint>.receipt.<cOwner>.<cActor>.<cUid>.<id>.<sourceSeq>` (§13.2) — one receipt per
 * accepted execution, forever; a lost publish CAS must observe a canonically IDENTICAL winner
 * or fail loud (a foreign receipt on the subject never becomes "the" receipt). Verification is
 * signature against the anchor registry (role `receipts`, scope = the endpoints the key may
 * attest for) PLUS digest recomputation against the raw args/result where the verifier holds
 * them; forged or request-mismatched receipts fail loud. A command carrying `ai.cotal.priced`
 * MUST emit one; receipts MAY be emitted for unpriced commands. Retention: default 90d, >= the
 * idempotency horizon (§13.10) — realized by the EPF stream configuration, not per-message.
 */
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders } from "@nats-io/transport-node";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epfSubject, assertIdToken, type EpCaller } from "./endpoint-subjects.js";
import { epfStreamName, readLastFact } from "./endpoint-journal.js";
import { verifyArtifactSignature, resolveAnchorForUse, assertAnchorScopeCovers, signArtifact, type AnchorResolver } from "./endpoint-signing.js";

/** One receipt's coordinates: the accepted execution's identity (§13.2). The subject caller is
 *  the TRIPLE; the artifact's `caller` evidence carries `{id, lifecycleUid}`. */
export interface ReceiptRef {
  endpoint: string;
  caller: EpCaller;
  requestId: string;
  /** The accepted submission's stream sequence — the execution identity (§13.2/§13.10). */
  sourceSeq: number;
}

/** The normative §13.10 Receipt artifact. */
export interface Receipt {
  v: 1;
  requestId: string;
  sourceSeq: number;
  space: string;
  endpoint: string;
  command: string;
  /** The executing instance, recorded as EVIDENCE (never redemption authority). */
  instance: { id: string; instanceId: string; epoch: number };
  caller: { id: string; lifecycleUid: string };
  schemaDigests: { input: string; output: string };
  argsDigest: string;
  outcome: { ok: boolean; code?: string };
  resultDigest?: string;
  ts: number;
  signer: { keyId: string };
  sig: string;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function garbled(what: string): never { throw new EpEnvelopeError("internal", `${what}; a garbled receipt never attests (SPEC 13.10)`); }

/** The receipt-fact subject (`epf.<e>.receipt.<cO>.<cA>.<cUid>.<id>.<sourceSeq>`, §13.2). */
export function receiptSubject(space: string, ref: ReceiptRef): string {
  if (!Number.isSafeInteger(ref.sourceSeq) || ref.sourceSeq < 1)
    throw new EpEnvelopeError("failed-precondition", `a receipt's sourceSeq is the accepted submission's positive stream sequence; got ${JSON.stringify(ref.sourceSeq)} (SPEC 13.10)`);
  return epfSubject(space, ref.endpoint, ["receipt", ref.caller.owner, ref.caller.actor, ref.caller.uid, assertIdToken(ref.requestId, "requestId"), String(ref.sourceSeq)]);
}

/** Build and SIGN a receipt from the raw execution evidence: the digests are computed HERE from
 *  the actual args/result (single source — an emitted digest can never mismatch what was
 *  digested), the outcome is closed, and the artifact signs D28 over its canonical form. */
export function mintReceipt(
  args: {
    ref: ReceiptRef;
    space: string;
    command: string;
    instance: { id: string; instanceId: string; epoch: number };
    /** The caller's lifecycle evidence (`id` is the principal id, distinct from the request id). */
    caller: { id: string; lifecycleUid: string };
    schemaDigests: { input: string; output: string };
    /** The accepted submission's raw args (digested here; `undefined` digests as null). */
    args: unknown;
    outcome: { ok: boolean; code?: string };
    /** The raw result, when one exists (digested here). */
    result?: unknown;
    ts: number;
    signer: { keyId: string };
  },
  keyPair: { sign(input: Uint8Array): Uint8Array },
): Receipt {
  if (!Number.isSafeInteger(args.ts) || args.ts < 0)
    throw new EpEnvelopeError("failed-precondition", `a receipt ts must be a non-negative safe integer; got ${JSON.stringify(args.ts)}`);
  if (!isContractDigest(args.schemaDigests?.input) || !isContractDigest(args.schemaDigests?.output))
    throw new EpEnvelopeError("failed-precondition", `a receipt requires the described contract's input/output schema digests (SPEC 13.10)`);
  if (typeof args.outcome?.ok !== "boolean" || (args.outcome.code !== undefined && typeof args.outcome.code !== "string"))
    throw new EpEnvelopeError("failed-precondition", `a receipt outcome is { ok: boolean, code?: string }; got ${JSON.stringify(args.outcome)}`);
  const body: Omit<Receipt, "sig"> = {
    v: 1, requestId: args.ref.requestId, sourceSeq: args.ref.sourceSeq, space: args.space,
    endpoint: args.ref.endpoint, command: args.command, instance: args.instance, caller: args.caller,
    schemaDigests: { input: args.schemaDigests.input, output: args.schemaDigests.output },
    argsDigest: contractDigest(args.args === undefined ? null : args.args),
    outcome: { ok: args.outcome.ok, ...(args.outcome.code !== undefined ? { code: args.outcome.code } : {}) },
    ...(args.result !== undefined ? { resultDigest: contractDigest(args.result) } : {}),
    ts: args.ts, signer: { keyId: args.signer.keyId },
  };
  receiptSubject(args.space, args.ref); // validates the subject coordinates before signing
  return signArtifact(body as unknown as Record<string, unknown>, keyPair) as unknown as Receipt;
}

/** Closed shape validation, IDENTITY-BOUND to the ref/subject it was read for (§13.4/§13.10):
 *  a mis-subjected, cross-request, or garbled receipt never attests. */
export function parseReceipt(raw: unknown, ref: ReceiptRef, space: string): Receipt {
  if (!isRec(raw)) garbled("the receipt is not an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "requestId", "sourceSeq", "space", "endpoint", "command", "instance", "caller", "schemaDigests", "argsDigest", "outcome", "resultDigest", "ts", "signer", "sig"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) garbled(`the receipt carries the unknown field "${k}" (closed schema)`);
  if (o.v !== 1) garbled("the receipt version is not 1");
  if (o.requestId !== ref.requestId || o.sourceSeq !== ref.sourceSeq || o.endpoint !== ref.endpoint || o.space !== space)
    garbled(`the receipt names (${String(o.space)}, ${String(o.endpoint)}, ${String(o.requestId)}, ${String(o.sourceSeq)}), not its subject's (${space}, ${ref.endpoint}, ${ref.requestId}, ${ref.sourceSeq}) — request-mismatched receipts fail loud`);
  if (typeof o.command !== "string" || o.command.length === 0) garbled("the receipt has no command");
  const inst = o.instance as Record<string, unknown>;
  if (!isRec(inst) || typeof inst.id !== "string" || typeof inst.instanceId !== "string"
    || typeof inst.epoch !== "number" || !Number.isSafeInteger(inst.epoch) || inst.epoch < 0)
    garbled("the receipt instance evidence is not { id, instanceId, epoch }");
  const cal = o.caller as Record<string, unknown>;
  if (!isRec(cal) || typeof cal.id !== "string" || typeof cal.lifecycleUid !== "string")
    garbled("the receipt caller evidence is not { id, lifecycleUid }");
  const sd = o.schemaDigests as Record<string, unknown>;
  if (!isRec(sd) || !isContractDigest(sd.input as string) || !isContractDigest(sd.output as string))
    garbled("the receipt schemaDigests are not sha256 digests");
  if (!isContractDigest(o.argsDigest as string)) garbled("the receipt argsDigest is not a sha256 digest");
  if (o.resultDigest !== undefined && !isContractDigest(o.resultDigest as string)) garbled("the receipt resultDigest is not a sha256 digest");
  const out = o.outcome as Record<string, unknown>;
  if (!isRec(out) || typeof out.ok !== "boolean" || (out.code !== undefined && typeof out.code !== "string"))
    garbled("the receipt outcome is not { ok, code? }");
  if (typeof o.ts !== "number" || !Number.isSafeInteger(o.ts) || o.ts < 0) garbled("the receipt ts is not a non-negative safe integer");
  if (!isRec(o.signer) || typeof (o.signer as Record<string, unknown>).keyId !== "string") garbled("the receipt names no signer keyId");
  if (typeof o.sig !== "string" || o.sig.length === 0) garbled("the receipt is unsigned");
  return o as unknown as Receipt;
}

/** Publish a receipt create-only on its execution-scoped subject, with EXPLICIT subject
 *  coordinates (the artifact's caller evidence carries `{id, lifecycleUid}`, not the subject
 *  triple, and a publisher never derives one by guessing): the receipt must MATCH the supplied
 *  ref ({@link parseReceipt} binding) before it is written. A lost CAS reads the winner and
 *  PROVES canonical identity — a DIFFERENT receipt already on the subject is a loud `conflict`
 *  (one execution, one receipt, forever), never silently adopted. */
export async function publishReceipt(
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  ref: ReceiptRef,
  receipt: Receipt,
): Promise<{ won: boolean; receipt: Receipt }> {
  parseReceipt(receipt as unknown as Record<string, unknown>, ref, space); // identity-bind before writing
  const subject = receiptSubject(space, ref);
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    await js.publish(subject, new TextEncoder().encode(canonicalJson(receipt)), { headers: h });
    return { won: true, receipt };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== 10071 && code !== 10164) throw e;
    const winner = await readReceipt(jsm, space, ref);
    if (winner === undefined)
      throw new EpEnvelopeError("internal", `the receipt CAS for ${subject} was lost but no winning receipt is readable (SPEC 13.4)`);
    if (canonicalJson(winner) !== canonicalJson(receipt))
      throw new EpEnvelopeError("conflict", `a DIFFERENT receipt is already recorded for this execution (${subject}); one execution has one receipt, forever (SPEC 13.10)`);
    return { won: false, receipt: winner };
  }
}

/** Read the execution's recorded receipt (`undefined` = none emitted yet), identity-bound. */
export async function readReceipt(jsm: JetStreamManager, space: string, ref: ReceiptRef): Promise<Receipt | undefined> {
  const subject = receiptSubject(space, ref);
  const raw = await readLastFact(jsm, epfStreamName(space), subject);
  return raw === undefined ? undefined : parseReceipt(raw, ref, space);
}

/** Race the anchor resolution against the verification budget: a stuck registry is a bounded
 *  `unavailable` refusal, never a hung verification. Races `Promise.resolve(p)` unconditionally
 *  (a non-native thenable must not bypass the deadline). */
async function withVerifyBudget<T>(p: Promise<T> | T, budgetMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EpEnvelopeError("unavailable", `${what} did not answer within ${budgetMs}ms; receipt verification is bounded and fails closed (SPEC 13.10)`)), budgetMs);
  });
  try { return await Promise.race([Promise.resolve(p), deadline]); } finally { clearTimeout(timer); }
}

/** Verify a receipt (§13.10, fail loud): D28 signature over the EXACT RAW artifact against the
 *  FRESH-resolved anchor (role `receipts`, scope covering the attested endpoint, window at the
 *  receipt's `ts`, resolved within a bounded budget), plus DIGEST RECOMPUTATION for every raw
 *  value the verifier holds — supplied `args` must recompute `argsDigest`, a supplied `result`
 *  must recompute `resultDigest` (and a receipt with no resultDigest cannot attest a result).
 *  Returns the parsed receipt. */
export async function verifyReceipt(
  raw: unknown,
  opts: {
    ref: ReceiptRef;
    space: string;
    resolveAnchor: AnchorResolver;
    /** Raw values to recompute against, where held. `args` uses the undefined→null rule. */
    recompute?: { args?: unknown; result?: unknown };
    /** Budget on the anchor resolution (default 5000ms): a stuck registry is a bounded
     *  `unavailable`, never a hung verification. */
    verifyBudgetMs?: number;
  },
): Promise<Receipt> {
  const budget = opts.verifyBudgetMs ?? 5_000;
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new EpEnvelopeError("failed-precondition", `verifyBudgetMs must be a positive integer; got ${JSON.stringify(opts.verifyBudgetMs)}`);
  const receipt = parseReceipt(raw, opts.ref, opts.space);
  const anchor = await withVerifyBudget(
    resolveAnchorForUse(opts.resolveAnchor, { keyId: receipt.signer.keyId, role: "receipts", at: receipt.ts }),
    budget, `the anchor resolution for receipt signer "${receipt.signer.keyId}"`);
  assertAnchorScopeCovers(anchor, "receipts", receipt.endpoint, "the receipt's attested endpoint");
  verifyArtifactSignature(raw as Record<string, unknown>, anchor);
  if (opts.recompute !== undefined && "args" in opts.recompute) {
    const d = contractDigest(opts.recompute.args === undefined ? null : opts.recompute.args);
    if (d !== receipt.argsDigest)
      throw new EpEnvelopeError("permission-denied", `the receipt's argsDigest does not recompute from the presented args; a request-mismatched receipt fails loud (SPEC 13.10)`);
  }
  if (opts.recompute !== undefined && "result" in opts.recompute) {
    if (receipt.resultDigest === undefined)
      throw new EpEnvelopeError("permission-denied", `the receipt carries no resultDigest but a result is presented for attestation; a receipt attests only what it digested (SPEC 13.10)`);
    if (contractDigest(opts.recompute.result) !== receipt.resultDigest)
      throw new EpEnvelopeError("permission-denied", `the receipt's resultDigest does not recompute from the presented result; a forged or mismatched receipt fails loud (SPEC 13.10)`);
  }
  return receipt;
}

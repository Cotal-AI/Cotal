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
 * or fail loud (a foreign receipt on the subject never becomes "the" receipt), and the
 * candidate is a DETACHED snapshot taken at entry, so a caller mutating the receipt across the
 * publish await can neither change what is stored nor what the winner is compared against.
 * The store seams run on a space-bonded context (§13.4): JS + JSM derive from ONE connection
 * by construction, so a lost CAS can never adopt a "winner" read from a different broker.
 *
 * VERIFICATION (§13.10, unconditional): "signature against the anchor registry + digest
 * recomputation" — BOTH are mandatory. `verifyReceipt` therefore REQUIRES the raw args
 * evidence (and the raw result evidence exactly when the receipt carries a resultDigest); the
 * digests are recomputed from evidence read ONCE at entry and compared BEFORE any await, so
 * mid-verification mutation of the presented proof values can never split what was checked
 * from what is attested. A reader that does not hold the raw evidence uses the deliberately
 * weaker, separately named {@link verifyReceiptSignature} — authenticity and coordinates only,
 * never a §13.10 verification. Forged or request-mismatched receipts fail loud; the artifact's
 * caller evidence must NAME the subject's caller triple (a cross-caller receipt never attests).
 * A command carrying `ai.cotal.priced` MUST emit one; receipts MAY be emitted for unpriced
 * commands. Retention: default 90d, >= the idempotency horizon (§13.10) — realized by the EPF
 * stream configuration, not per-message.
 */
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders, type NatsConnection } from "@nats-io/transport-node";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epfSubject, assertIdToken, type EpCaller } from "./endpoint-subjects.js";
import { epfStreamName, readLastFact, type AcceptanceFact } from "./endpoint-journal.js";
import { verifyArtifactSignature, resolveAnchorForUse, assertAnchorScopeCovers, signArtifact, type AnchorResolver, type SignerAnchor } from "./endpoint-signing.js";

/** A trusted, space-bonded receipt-store context: an OPAQUE token carrying only the space. Its
 *  JS + JSM resources DERIVE from one binding-layer connection by the constructor and are held
 *  in a module-private WeakMap keyed by this token, NEVER as reachable properties (distsys
 *  c50817d MEDIUM): a caller holding the context cannot rebind its broker to split the publish
 *  from the lost-CAS winner read. Every store seam takes this context. */
export interface ReceiptStoreContext {
  readonly space: string;
}

interface ReceiptResources { js: JetStreamClient; jsm: JetStreamManager; }

/** The resources live here, unreachable from the context token itself. A structural look-alike
 *  never appears in this map, so it never authorizes; and `ctx.js`/`ctx.jsm` do not exist to be
 *  reassigned after construction. */
const RECEIPT_RESOURCES = new WeakMap<ReceiptStoreContext, ReceiptResources>();

/** Bond the resources to one space by CONSTRUCTION (frozen token + WeakMap-private resources,
 *  same discipline as the other store contexts): a hand-assembled structural look-alike is
 *  rejected at every seam, and the broker cannot be rebound out from under a live operation. */
export async function receiptStoreContext(nc: NatsConnection, space: string): Promise<ReceiptStoreContext> {
  if (nc === null || typeof nc !== "object" || typeof (nc as unknown as { close?: unknown }).close !== "function")
    throw new EpEnvelopeError("failed-precondition", "a receipt-store context is constructed from ONE binding-layer connection; separate resources are never accepted (SPEC 13.4)");
  if (typeof space !== "string" || space.length === 0)
    throw new EpEnvelopeError("failed-precondition", "a receipt-store context needs a space");
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const ctx: ReceiptStoreContext = Object.freeze({ space });
  RECEIPT_RESOURCES.set(ctx, { js, jsm });
  return ctx;
}

/** The brand check AND the resource fetch, in one: a context not minted by receiptStoreContext()
 *  is absent from the map and never authorizes. */
function resources(ctx: ReceiptStoreContext): ReceiptResources {
  const r = ctx === null || typeof ctx !== "object" ? undefined : RECEIPT_RESOURCES.get(ctx);
  if (r === undefined)
    throw new EpEnvelopeError("failed-precondition", `the receipt-store context was not constructed by receiptStoreContext(); a hand-assembled resource bundle never authorizes - the space bond is constructed, not asserted (SPEC 13.4)`);
  return r;
}

/** One receipt's coordinates: the accepted execution's identity (§13.2). The subject caller is
 *  the TRIPLE; the artifact's `caller` evidence carries `{id, lifecycleUid}`. */
export interface ReceiptRef {
  endpoint: string;
  caller: EpCaller;
  requestId: string;
  /** The accepted submission's stream sequence — the execution identity (§13.2/§13.10). */
  sourceSeq: number;
}

/** Snapshot the ref to a validated, DETACHED copy at seam entry (single-read: every property
 *  is read exactly once, so a shifting getter cannot split one operation's identity across
 *  its subject derivation and its artifact binding). */
function snapshotReceiptRef(ref: ReceiptRef): ReceiptRef {
  if (ref === null || typeof ref !== "object")
    throw new EpEnvelopeError("failed-precondition", `a receipt ref must carry endpoint, the caller triple, requestId, and sourceSeq (SPEC 13.2)`);
  const endpoint = ref.endpoint;
  const requestId = ref.requestId;
  const sourceSeq = ref.sourceSeq;
  const c = ref.caller;
  if (typeof endpoint !== "string" || typeof requestId !== "string" || c === null || typeof c !== "object")
    throw new EpEnvelopeError("failed-precondition", `a receipt ref must carry endpoint, the caller triple, requestId, and sourceSeq (SPEC 13.2)`);
  const owner = c.owner;
  const actor = c.actor;
  const uid = c.uid;
  if (typeof owner !== "string" || typeof actor !== "string" || typeof uid !== "string")
    throw new EpEnvelopeError("failed-precondition", `a receipt ref must carry endpoint, the caller triple, requestId, and sourceSeq (SPEC 13.2)`);
  return Object.freeze({ endpoint, caller: Object.freeze({ owner, actor, uid }), requestId, sourceSeq });
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
    /** The raw result, when one exists (digested here). MUTUALLY EXCLUSIVE with `resultDigest`. */
    result?: unknown;
    /** A pre-committed result digest, taken VERBATIM (the fact-derived path binds the terminal's
     *  OWN `outcomeDigest`, never re-digesting a substitute payload). Mutually exclusive with
     *  `result`. */
    resultDigest?: string;
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
  if (args.result !== undefined && args.resultDigest !== undefined)
    throw new EpEnvelopeError("failed-precondition", `a receipt takes a raw result OR a pre-committed resultDigest, never both (a single source of the result digest, SPEC 13.10)`);
  if (args.resultDigest !== undefined && !isContractDigest(args.resultDigest))
    throw new EpEnvelopeError("failed-precondition", `a receipt resultDigest is a sha256 digest; got ${JSON.stringify(args.resultDigest)}`);
  const resultDigest = args.resultDigest !== undefined ? args.resultDigest
    : args.result !== undefined ? contractDigest(args.result) : undefined;
  const body: Omit<Receipt, "sig"> = {
    v: 1, requestId: args.ref.requestId, sourceSeq: args.ref.sourceSeq, space: args.space,
    endpoint: args.ref.endpoint, command: args.command, instance: args.instance, caller: args.caller,
    schemaDigests: { input: args.schemaDigests.input, output: args.schemaDigests.output },
    argsDigest: contractDigest(args.args === undefined ? null : args.args),
    outcome: { ok: args.outcome.ok, ...(args.outcome.code !== undefined ? { code: args.outcome.code } : {}) },
    ...(resultDigest !== undefined ? { resultDigest } : {}),
    ts: args.ts, signer: { keyId: args.signer.keyId },
  };
  receiptSubject(args.space, args.ref); // validates the subject coordinates before signing
  return signArtifact(body as unknown as Record<string, unknown>, keyPair) as unknown as Receipt;
}

/** A receipt's OUTCOME, derived from the authoritative committed terminal (never a caller's free
 *  claim): `ok` + optional catalog `code`, and the terminal's own `resultDigest` (already the
 *  digest the terminal fact committed — a receipt re-attests it, it never re-digests a different
 *  payload). {@link receiptOutcomeOfGoal} maps an action goal's terminal state onto this shape. */
export interface ReceiptOutcome {
  ok: boolean;
  code?: string;
  resultDigest?: string;
}

/** Map an action goal's committed terminal (`state` + its `outcomeDigest`) onto the receipt
 *  outcome: only `succeeded` is `ok`; every other terminal state IS its own catalog code, so a
 *  receipt's `outcome.code` can never disagree with the committed goal state. The digest is the
 *  terminal fact's OWN `outcomeDigest` (the receipt attests the committed value, never re-digests
 *  a substitute). Kept generic (state + digest, not the GoalResultFact type) so the receipt
 *  module stays free of an action-composite dependency. */
export function receiptOutcomeOfGoal(state: string, outcomeDigest: string): ReceiptOutcome {
  const OK_STATES = new Set(["succeeded"]);
  const CODE_STATES = new Set(["failed", "cancelled", "expired", "uncertain"]);
  if (!OK_STATES.has(state) && !CODE_STATES.has(state))
    throw new EpEnvelopeError("internal", `goal terminal state ${JSON.stringify(state)} is not a §13.6 outcome; a receipt never attests an unknown terminal (SPEC 13.10)`);
  if (!isContractDigest(outcomeDigest))
    throw new EpEnvelopeError("internal", `a goal terminal's outcomeDigest is a sha256 digest; got ${JSON.stringify(outcomeDigest)} (SPEC 13.10)`);
  return { ok: state === "succeeded", ...(state === "succeeded" ? {} : { code: state }), resultDigest: outcomeDigest };
}

/** Build and sign a receipt whose EVERY attestation field is DERIVED from the two authoritative
 *  facts, never a caller's free parameter (distsys CF-1: an emitted receipt can no longer attest
 *  an outcome or identity that disagrees with the committed record). Identity (requestId,
 *  sourceSeq, caller, endpoint, command, schema digests, argsDigest) comes from the ACCEPTANCE
 *  fact; the outcome (ok/code/resultDigest) comes from the committed TERMINAL. The only inputs
 *  the caller supplies are the executing-instance EVIDENCE, the wall clock, the signer id, and
 *  the key. A receipt minted here is reconstructable from the two facts, so a crash between
 *  effect and emission is repaired by re-minting from the same facts (idempotent publish). */
export function mintReceiptFromFacts(
  args: {
    acceptance: AcceptanceFact;
    /** The caller triple from the acceptance's BROKER-AUTHENTICATED decision subject (§13.2):
     *  the authoritative owner/actor/uid, cross-checked against the fact body here so a receipt
     *  can never be subjected to a caller its acceptance body does not name. */
    caller: EpCaller;
    space: string;
    /** The committed terminal outcome (from the authoritative terminal fact, via
     *  {@link receiptOutcomeOfGoal} for goals, or a journaled command's own committed result). */
    terminal: ReceiptOutcome;
    /** The executing instance, recorded as EVIDENCE (never redemption authority). */
    instance: { id: string; instanceId: string; epoch: number };
    ts: number;
    signer: { keyId: string };
  },
  keyPair: { sign(input: Uint8Array): Uint8Array },
): Receipt {
  const a = args.acceptance;
  if (a === null || typeof a !== "object" || a.decision !== "accepted")
    throw new EpEnvelopeError("internal", `a receipt is minted from an ACCEPTED submission's acceptance fact; got ${JSON.stringify((a as { decision?: unknown })?.decision)} (SPEC 13.10)`);
  const op = (a.request as { op?: { endpoint?: unknown; command?: unknown; inputDigest?: unknown; outputDigest?: unknown } })?.op;
  if (op === undefined || typeof op.endpoint !== "string" || typeof op.command !== "string")
    throw new EpEnvelopeError("internal", `the acceptance fact for "${a.id}" carries no invocation binding; a receipt derives its endpoint/command from the accepted request, never a free param (SPEC 13.10)`);
  // The acceptance records the pinned contract digests twice (its `contractDigests` and the
  // embedded request's op digests); they MUST agree, else the acceptance is internally garbled
  // and a receipt built from either could disagree with the other.
  if (a.contractDigests.input !== op.inputDigest || a.contractDigests.output !== op.outputDigest)
    throw new EpEnvelopeError("internal", `the acceptance fact for "${a.id}" disagrees with its own embedded request on the pinned contract digests; a garbled acceptance never mints a receipt (SPEC 13.10)`);
  // BIND the authoritative caller triple (from the acceptance subject) to the fact body's caller
  // evidence: id = "owner.actor" and uid = lifecycleUid, else the receipt subject and its body
  // would name different principals (forged attribution, the same class parseReceipt closes on read).
  if (`${args.caller.owner}.${args.caller.actor}` !== a.caller.id || args.caller.uid !== a.caller.lifecycleUid)
    throw new EpEnvelopeError("internal", `the acceptance subject caller ${args.caller.owner}.${args.caller.actor}/${args.caller.uid} disagrees with the fact body caller ${a.caller.id}/${a.caller.lifecycleUid}; a receipt never attests split attribution (SPEC 13.10)`);
  if (typeof args.terminal?.ok !== "boolean"
    || (args.terminal.code !== undefined && typeof args.terminal.code !== "string")
    || (args.terminal.resultDigest !== undefined && !isContractDigest(args.terminal.resultDigest)))
    throw new EpEnvelopeError("internal", `a receipt terminal is { ok, code?, resultDigest? } derived from the committed terminal; got ${JSON.stringify(args.terminal)} (SPEC 13.10)`);
  return mintReceipt({
    ref: { endpoint: op.endpoint, caller: args.caller, requestId: a.id, sourceSeq: a.sourceSeq },
    space: args.space,
    command: op.command,
    instance: args.instance,
    caller: a.caller,
    schemaDigests: a.contractDigests,
    args: (a.request as { args?: unknown }).args,
    outcome: { ok: args.terminal.ok, ...(args.terminal.code !== undefined ? { code: args.terminal.code } : {}) },
    ...(args.terminal.resultDigest !== undefined ? { resultDigest: args.terminal.resultDigest } : {}),
    ts: args.ts,
    signer: args.signer,
  }, keyPair);
}

/** Closed shape validation, IDENTITY-BOUND to the ref/subject it was read for (§13.4/§13.10):
 *  a mis-subjected, cross-request, cross-caller, or garbled receipt never attests. The
 *  artifact's caller EVIDENCE must name the subject's caller triple — a receipt whose body
 *  names a different principal than its execution-scoped subject is forged attribution. */
export function parseReceipt(raw: unknown, ref: ReceiptRef, space: string): Receipt {
  // Detach to a plain tree at ENTRY (distsys c50817d MEDIUM): the exported parser validates and
  // RETURNS this snapshot, never the caller's live view. A caller getter/Proxy therefore cannot
  // pass a check with one value and then answer a different one when a later field (or the
  // returned `parsed.caller.id`) is read - the snapshot has no live accessors left.
  const snap = snapshotRawReceipt(raw);
  if (!isRec(snap)) garbled("the receipt is not an object");
  const o = snap as Record<string, unknown>;
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
  if (cal.id !== `${ref.caller.owner}.${ref.caller.actor}` || cal.lifecycleUid !== ref.caller.uid)
    garbled(`the receipt's caller evidence (${String(cal.id)}/${String(cal.lifecycleUid)}) does not name its subject's caller (${ref.caller.owner}.${ref.caller.actor}/${ref.caller.uid}); a cross-caller receipt never attests`);
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
 *  triple, and a publisher never derives one by guessing). The receipt is SNAPSHOTTED to a
 *  detached canonical candidate at entry: the identity binding ({@link parseReceipt}), the
 *  published bytes, the lost-CAS winner comparison, and the returned value are all EXACTLY
 *  that candidate — a caller mutating the receipt across the publish await can neither change
 *  what is stored nor smuggle a "winner" past the equality proof. A lost CAS reads the winner
 *  through the SAME bonded context and PROVES canonical identity — a DIFFERENT receipt already
 *  on the subject is a loud `conflict` (one execution, one receipt, forever), never adopted. */
export async function publishReceipt(
  ctx: ReceiptStoreContext,
  ref: ReceiptRef,
  receipt: Receipt,
): Promise<{ won: boolean; receipt: Receipt }> {
  const { js } = resources(ctx);
  const refSnap = snapshotReceiptRef(ref);
  let candidate: Receipt;
  try { candidate = JSON.parse(canonicalJson(receipt)) as Receipt; } // detached; the caller's live object is never read again
  catch (e) { throw new EpEnvelopeError("internal", `the receipt is not interchangeable JSON (${(e as Error).message}); garbled state is never published (SPEC 13.10)`); }
  parseReceipt(candidate as unknown as Record<string, unknown>, refSnap, ctx.space); // identity-bind before writing
  const subject = receiptSubject(ctx.space, refSnap);
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    await js.publish(subject, new TextEncoder().encode(canonicalJson(candidate)), { headers: h });
    return { won: true, receipt: candidate };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== 10071 && code !== 10164) throw e;
    const winner = await readReceipt(ctx, refSnap);
    if (winner === undefined)
      throw new EpEnvelopeError("internal", `the receipt CAS for ${subject} was lost but no winning receipt is readable (SPEC 13.4)`);
    if (canonicalJson(winner) !== canonicalJson(candidate))
      throw new EpEnvelopeError("conflict", `a DIFFERENT receipt is already recorded for this execution (${subject}); one execution has one receipt, forever (SPEC 13.10)`);
    return { won: false, receipt: winner };
  }
}

/** Read the execution's recorded receipt (`undefined` = none emitted yet), identity-bound. */
export async function readReceipt(ctx: ReceiptStoreContext, ref: ReceiptRef): Promise<Receipt | undefined> {
  const { jsm } = resources(ctx);
  const refSnap = snapshotReceiptRef(ref);
  const subject = receiptSubject(ctx.space, refSnap);
  const raw = await readLastFact(jsm, epfStreamName(ctx.space), subject);
  return raw === undefined ? undefined : parseReceipt(raw, refSnap, ctx.space);
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

function assertBudget(v: number | undefined): number {
  const budget = v ?? 5_000;
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new EpEnvelopeError("failed-precondition", `verifyBudgetMs must be a positive integer; got ${JSON.stringify(v)}`);
  return budget;
}

/** Snapshot the raw artifact to a DETACHED value at entry: the parse, the scope check, and the
 *  D28 signature all read EXACTLY these bytes, so a caller mutating the raw receipt during an
 *  awaited anchor resolution can never split what was parsed from what the signature verifies
 *  (the D28 consuming boundary). */
function snapshotRawReceipt(raw: unknown): unknown {
  try { return JSON.parse(canonicalJson(raw)); } // throws on non-interchangeable I-JSON; the detached tree is unreachable to the caller
  catch (e) { throw new EpEnvelopeError("internal", `the receipt is not interchangeable JSON (${(e as Error).message}); garbled state never verifies (SPEC 13.10)`); }
}

/** The shared authenticity core: FRESH-resolve the signer anchor (role `receipts`, scope
 *  covering the attested endpoint, window at the receipt's `ts`, bounded), then verify the D28
 *  signature over the detached snapshot. */
async function verifySignatureCore(rawSnapshot: unknown, receipt: Receipt, resolveAnchor: AnchorResolver, budget: number): Promise<SignerAnchor> {
  const anchor = await withVerifyBudget(
    resolveAnchorForUse(resolveAnchor, { keyId: receipt.signer.keyId, role: "receipts", at: receipt.ts }),
    budget, `the anchor resolution for receipt signer "${receipt.signer.keyId}"`);
  assertAnchorScopeCovers(anchor, "receipts", receipt.endpoint, "the receipt's attested endpoint");
  verifyArtifactSignature(rawSnapshot as Record<string, unknown>, anchor); // the DETACHED snapshot the parse read, not the live caller-owned raw
  return anchor;
}

/** VERIFY a receipt (§13.10, fail loud, UNCONDITIONAL): D28 signature over the EXACT RAW
 *  artifact against the FRESH-resolved anchor PLUS digest recomputation — both mandatory
 *  ("signature against the anchor registry + digest recomputation", §13.10). The raw args
 *  evidence is REQUIRED (undefined digests as null); the raw result evidence is REQUIRED
 *  exactly when the receipt carries a resultDigest (a receipt attesting a result is only
 *  verified against that result), and FORBIDDEN when it does not (a receipt with no
 *  resultDigest cannot attest a presented result). The evidence is read ONCE and its digests
 *  are computed at ENTRY, then compared BEFORE the anchor await — mutating the presented proof
 *  values mid-verification changes nothing. A reader without raw evidence uses the explicitly
 *  weaker {@link verifyReceiptSignature}. Returns the parsed receipt. */
export async function verifyReceipt(
  raw: unknown,
  opts: {
    ref: ReceiptRef;
    space: string;
    resolveAnchor: AnchorResolver;
    /** The raw evidence to recompute against (MANDATORY, §13.10). `args` uses the
     *  undefined→null rule; `result` is present exactly when the receipt digested one. */
    recompute: { args: unknown; result?: unknown };
    /** Budget on the anchor resolution (default 5000ms): a stuck registry is a bounded
     *  `unavailable`, never a hung verification. */
    verifyBudgetMs?: number;
  },
): Promise<Receipt> {
  const budget = assertBudget(opts.verifyBudgetMs);
  // ENTRY SNAPSHOTS (single-read): ref, evidence, and the raw artifact all detach here.
  const refSnap = snapshotReceiptRef(opts.ref);
  const rec = opts.recompute;
  if (rec === null || typeof rec !== "object" || Array.isArray(rec) || !("args" in rec))
    throw new EpEnvelopeError("failed-precondition", `receipt verification is signature PLUS digest recomputation (SPEC 13.10, unconditional); the raw args evidence is mandatory - a reader without evidence uses verifyReceiptSignature, the explicitly weaker authenticity read`);
  const argsEvidence = rec.args; // the ONLY read of rec.args
  let argsProof: string;
  let hasResult = false;
  let resultProof: string | undefined;
  try {
    // Digest args IMMEDIATELY after its single read, BEFORE touching `rec` again (distsys c50817d
    // HIGH): a `result` getter or Proxy has-trap must not run between the args read and its
    // digest, or it could mutate the args object to match a foreign receipt. The evidence is
    // single-read AND single-digest, not read-then-later-digest. Only once argsProof is a fixed
    // scalar do we consult `rec` for the result evidence.
    argsProof = contractDigest(argsEvidence === undefined ? null : argsEvidence);
    hasResult = "result" in rec;
    resultProof = hasResult ? contractDigest(rec.result) : undefined;
  } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the presented evidence does not digest (${(e as Error).message}); evidence that cannot digest cannot verify (SPEC 13.10)`);
  }
  const rawSnapshot = snapshotRawReceipt(raw);
  const receipt = parseReceipt(rawSnapshot, refSnap, opts.space);
  // DIGEST RECOMPUTATION BEFORE THE ANCHOR AWAIT: the proofs are entry-time detached scalars,
  // so nothing a caller mutates after entry can influence what is attested — and a mismatched
  // receipt fails fast without touching the registry.
  if (argsProof !== receipt.argsDigest)
    throw new EpEnvelopeError("permission-denied", `the receipt's argsDigest does not recompute from the presented args; a request-mismatched receipt fails loud (SPEC 13.10)`);
  if (receipt.resultDigest !== undefined) {
    if (!hasResult)
      throw new EpEnvelopeError("failed-precondition", `the receipt attests a result (resultDigest present) but no result evidence is presented; verification recomputes EVERY digest the receipt carries (SPEC 13.10)`);
    if (resultProof !== receipt.resultDigest)
      throw new EpEnvelopeError("permission-denied", `the receipt's resultDigest does not recompute from the presented result; a forged or mismatched receipt fails loud (SPEC 13.10)`);
  } else if (hasResult) {
    throw new EpEnvelopeError("permission-denied", `the receipt carries no resultDigest but a result is presented for attestation; a receipt attests only what it digested (SPEC 13.10)`);
  }
  await verifySignatureCore(rawSnapshot, receipt, opts.resolveAnchor, budget);
  return receipt;
}

/** The deliberately WEAKER, separately named authenticity read: closed identity-bound parse +
 *  D28 signature against the fresh-resolved anchor, with NO digest attestation — for a reader
 *  that does not hold the raw args/result. This is NOT the §13.10 verification (which is
 *  unconditionally signature PLUS digest recomputation, {@link verifyReceipt}); it proves the
 *  artifact is authentic and names these coordinates, nothing about what was executed. */
export async function verifyReceiptSignature(
  raw: unknown,
  opts: { ref: ReceiptRef; space: string; resolveAnchor: AnchorResolver; verifyBudgetMs?: number },
): Promise<Receipt> {
  const budget = assertBudget(opts.verifyBudgetMs);
  const refSnap = snapshotReceiptRef(opts.ref);
  const rawSnapshot = snapshotRawReceipt(raw);
  const receipt = parseReceipt(rawSnapshot, refSnap, opts.space);
  await verifySignatureCore(rawSnapshot, receipt, opts.resolveAnchor, budget);
  return receipt;
}

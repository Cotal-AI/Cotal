/**
 * v0.4 journal-contract helpers (SPEC §13.4) — the semantic fingerprint, the decision and
 * quarantine fact shapes with their consuming-boundary validators, and the create-only
 * decision CAS the canonicalizer decides with.
 *
 * The journal is an explicitly UNTRUSTED at-least-once submission log (`epj`) feeding
 * canonical accepted-fact subjects (`epf`) through ONE mediated writer, the canonicalizer.
 * Effects consume only canonical facts, never raw submissions. Submissions append PLAIN —
 * a conformant submitter never sets `Nats-Msg-Id` (native stream-wide dedupe is a
 * cross-caller suppression vector, §13.4 item 1); every transport retry simply appends again,
 * and the caller-scoped decision CAS resolves every copy to one durable decision.
 */
import { headers as natsHeaders } from "@nats-io/transport-node";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { token } from "./subjects.js";
import { contractDigest, rawDigest } from "./canonical.js";
import {
  epfSubject, parseEpSubject, endpointToken, assertBoundedOwner, assertIdToken,
  assertLifecycleToken, type EpCaller, type ParsedEpRequest,
} from "./endpoint-subjects.js";
import { EpEnvelopeError, isEpErrorCode, parseEndpointRequest, type EndpointRequest } from "./endpoint-envelope.js";
import { isCasLoss } from "./endpoint-records.js";

/** §13.12 stream names for the two journal-side streams. */
export function epjStreamName(space: string): string { return `EPJ_${token(space)}`; }
export function epfStreamName(space: string): string { return `EPF_${token(space)}`; }
/** The canonicalizer's durable (§13.9 consumer-name grammar): `canon_<e>`. Uses the fail-loud
 *  {@link endpointToken} (not the lenient `token`) so a malformed endpoint is refused, never
 *  silently sanitized into a colliding durable name. */
export function canonDurable(endpoint: string): string { return `canon_${endpointToken(endpoint)}`; }

/** Decision facts live on the caller-scoped subject — distinct callers can never squat each
 *  other's ids because the caller triple IS part of the subject (§13.4 item 3). Provenance is
 *  STRUCTURAL, as for {@link deriveReplySubject}: the builder takes the broker-authenticated
 *  PARSED submission and derives endpoint + caller internally — there is no argument through
 *  which a body-supplied `from`/`op.endpoint` could address another caller's rail (the
 *  canonicalizer holds broad `epf.<e>.dec.>` authority; the broker cannot catch a confused
 *  call site, so the API must). */
export function epfDecisionSubject(space: string, request: ParsedEpRequest, id: string): string {
  const c = request.caller;
  return epfSubject(space, request.endpoint, ["dec", c.owner, c.actor, c.uid, id]);
}
/** Quarantine facts key on the source SEQUENCE — a family disjoint from caller-chosen `dec`
 *  ids by construction, so no legal request id can collide with a quarantine key. */
export function epfQuarantineSubject(space: string, endpoint: string, sourceSeq: number): string {
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 1) throw new Error(`sourceSeq ${sourceSeq} is not a positive integer`);
  return epfSubject(space, endpoint, ["quar", String(sourceSeq)]);
}
/** The per-goal first-wins bind (§13.4 item 3): stops a second id naming one goalId BEFORE
 *  acceptance and effect. Structural provenance as {@link epfDecisionSubject}. */
export function epfGoalBindSubject(space: string, source: { endpoint: string; caller: { owner: string; actor: string; uid: string } }, goalId: string): string {
  const c = source.caller;
  return epfSubject(space, source.endpoint, ["goal", c.owner, c.actor, c.uid, goalId, "bind"]);
}
/** The non-action effects completion fact (§13.9 ack barrier):
 *  `epf.<e>.eff.<caller triple>.<id>`. */
export function epfEffectSubject(space: string, endpoint: string, caller: EpCaller, id: string): string {
  return epfSubject(space, endpoint, ["eff", caller.owner, caller.actor, caller.uid, assertIdToken(id, "effect id")]);
}

/** Default idempotency horizon (§13.4 item 6; space-configurable). The horizon is REALIZED by
 *  decision-fact retention, never by a clock: the create-only CAS returns the recorded decision
 *  for exactly as long as the fact exists. */
export const IDEMPOTENCY_HORIZON_MS_DEFAULT = 24 * 60 * 60 * 1000;

// ---- the semantic fingerprint (§13.4 item 2) -------------------------------------------------

const FINGERPRINT_FIELDS = ["id", "goalId", "class", "args"] as const;

/** Build the §13.4 fingerprint for a PARSEABLE submission: the effect-defining subset it
 *  carries — absent optional fields are OMITTED, never `null`, so two implementations digest
 *  identical bytes; an incomplete envelope fingerprints the subset it has. The caller identity
 *  and authorization mode come from the broker-authenticated SUBJECT, never the body. Throws
 *  when the carried values are not canonicalizable I-JSON (lone surrogate, duplicate names
 *  survive parsing as last-wins so cannot reach here, non-finite number) — that submission has
 *  no interoperable RFC 8785 form, hence NO fingerprint, and takes the quarantine path. */
export function submissionFingerprint(
  raw: unknown,
  subject: ParsedEpRequest,
): { object: Record<string, unknown>; fingerprint: string } {
  const body = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const op = (body.op !== null && typeof body.op === "object" && !Array.isArray(body.op) ? body.op : {}) as Record<string, unknown>;
  const object: Record<string, unknown> = {};
  if (op.endpoint !== undefined) object.endpoint = op.endpoint;
  if (op.command !== undefined) object.command = op.command;
  for (const k of FINGERPRINT_FIELDS) if (body[k] !== undefined) object[k] = body[k];
  if (op.inputDigest !== undefined) object.inputDigest = op.inputDigest;
  if (op.outputDigest !== undefined) object.outputDigest = op.outputDigest;
  if (subject.target) object.authz = subject.target.mode;
  if (body.target !== undefined) object.target = body.target;
  if (body.auth !== undefined) {
    if (typeof body.auth === "string") object.authDigest = rawDigest(body.auth); // throws on a lone surrogate → quarantine
    // Wrong-typed but canonicalizable auth is CARRIED effect-defining content: fingerprint it
    // as carried (distinct from absent auth AND from a real authDigest), never collapse it.
    else object.auth = body.auth;
  }
  object.caller = { id: `${subject.caller.owner}.${subject.caller.actor}`, lifecycleUid: subject.caller.uid };
  return { object, fingerprint: contractDigest(object) }; // contractDigest throws on non-I-JSON → quarantine
}

// ---- admission: the CLOSED outcome table (§13.4 item 2, §13.7 `admissionCeiling`) ------------------------

/** Why a submission was quarantined. CLOSED and mutually exclusive: a reader branches on the
 *  cause without knowing the order the canonicalizer evaluated its checks in.
 *
 *  `no-usable-id` is deliberately DISTINCT from the three ceiling causes. Both end in quarantine,
 *  but they are different facts about the submission — one says "you sent more than this endpoint
 *  admits", the other says "these bytes name no request at all" — and an operator who cannot tell
 *  them apart cannot tell a misconfigured caller from a corrupt one. */
export type AdmissionQuarantineCause =
  | "submission-too-large"      // raw bytes over the declared ceiling, decided BEFORE parsing
  | "submission-too-deep"
  | "submission-too-many-items"
  | "no-canonical-form"         // parses, but carries values with no interoperable RFC 8785 form
  | "no-usable-id";             // unparseable, or parseable with no `id` to address a decision to

/** The closed set of admission outcomes. Exactly three, and the third is the only one that
 *  produces a caller-addressed decision fact: a quarantine has no fingerprint to address one
 *  with, which is the whole reason the two paths differ. */
export type AdmissionOutcome =
  | { outcome: "quarantine"; cause: AdmissionQuarantineCause; detail: string }
  | { outcome: "reject"; code: "resource-exhausted"; detail: string; fingerprint: string; object: Record<string, unknown> }
  | { outcome: "admit"; fingerprint: string; object: Record<string, unknown> };

/** Depth and member/item counts of a parsed JSON value, measured in one walk.
 *  Iterative rather than recursive: the input is untrusted and a recursive walk would blow the
 *  JS stack on a deeply nested submission — which is a CRASH, not a decision, and this endpoint's
 *  entire contract is that every submission reaches a durable decision. */
function measure(value: unknown): { depth: number; items: number } {
  let depth = 0, items = 0;
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 1 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (d > depth) depth = d;
    if (Array.isArray(v)) {
      items += v.length;
      for (const child of v) stack.push({ v: child, d: d + 1 });
    } else if (v !== null && typeof v === "object") {
      const entries = Object.values(v as Record<string, unknown>);
      items += entries.length;
      for (const child of entries) stack.push({ v: child, d: d + 1 });
    }
  }
  return { depth, items };
}

/** Decide ONE submission against the endpoint's DECLARED ceiling (§13.7 `admissionCeiling`).
 *
 *  The ceiling is a parameter and never a constant, because two conforming implementations must
 *  not be able to decide the same bytes differently and durably. That is also why nothing here
 *  reads a clock: the outcome is a function of the bytes and the declaration alone, so a
 *  redelivery of the same submission reaches the same durable answer however long any worker
 *  took. A watchdog may re-deliver; it may never decide.
 *
 *  ORDER IS PART OF THE CONTRACT, and the reason is the fingerprint. The raw-byte ceiling is
 *  evaluated BEFORE parsing, because parsing is the work the ceiling exists to refuse. Everything
 *  that fails before a fingerprint exists quarantines, because there is no caller-addressed
 *  subject to write a decision to. Once a fingerprint EXISTS the caller is addressable, so a
 *  breach becomes a REJECTION — a durable, caller-visible answer rather than a message they never
 *  hear about (SPEC:1610-1612). */
/**
 * Duplicate object names in the RAW bytes, which no post-parse check can see.
 *
 * `JSON.parse('{"id":"a","id":"b"}')` yields `{id:"b"}` and reports nothing. So a submission that
 * two conforming implementations could read DIFFERENTLY — one taking the first name, one the last —
 * arrives at the decision looking perfectly ordinary. That is the precise failure the declared ceiling
 * exists to prevent: two implementations deciding the same bytes differently and DURABLY.
 *
 * The module has claimed duplicate names as a `no-canonical-form` cause since it was written, and
 * the case was UNREACHABLE — not untested, unrepresentable, because the seam handed the decision a
 * value from which the duplicate had already been erased. Found by a reviewer, not by any of the
 * mutants aimed at this file.
 *
 * A scanner, not a regex: strings can contain braces, colons and escaped quotes, and a recogniser
 * that succeeds on a prefix is a parser that lies. This walks the bytes once and tracks a name set
 * per open object. It runs only on input already inside the byte ceiling.
 */
export function hasDuplicateNames(text: string): { duplicate: true; name: string } | { duplicate: false } {
  const stack: Array<Set<string> | null> = []; // Set = object frame, null = array frame
  let i = 0;
  const n = text.length;
  let expectName = false;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // Read one complete string, honouring escapes, so its contents can never be mistaken for
      // structure. `\\` must consume both characters or a trailing `\"` reads as an open quote.
      let j = i + 1, out = "";
      while (j < n) {
        const cj = text[j];
        if (cj === "\\") { out += text[j + 1] ?? ""; j += 2; continue; }
        if (cj === '"') break;
        out += cj; j++;
      }
      if (j >= n) return { duplicate: false }; // unterminated: not our error to report
      const top = stack[stack.length - 1];
      if (expectName && top instanceof Set) {
        if (top.has(out)) return { duplicate: true, name: out };
        top.add(out);
        expectName = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") { stack.push(new Set()); expectName = true; i++; continue; }
    if (ch === "[") { stack.push(null); expectName = false; i++; continue; }
    if (ch === "}" || ch === "]") { stack.pop(); expectName = false; i++; continue; }
    if (ch === ",") { expectName = stack[stack.length - 1] instanceof Set; i++; continue; }
    i++;
  }
  return { duplicate: false };
}

/** The exact decimal value a JSON number literal denotes, as a comparable key: sign, significant
 *  digits, and scale. `1.50`, `1.5` and `15e-1` all key the same because they ARE the same number;
 *  `-0` and `0` key the same because RFC 8785 serialises both as `0`. A literal that is not a JSON
 *  number keys to itself, so it can never compare equal to a normalised one. */
function decimalValueKey(literal: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!m) return `?${literal}`;
  const [, sign, int, frac = "", exp = "0"] = m;
  const digits = (int + frac).replace(/^0+/, "");
  if (digits === "") return "0";
  const trimmed = digits.replace(/0+$/, "");
  return `${sign}${trimmed}e${Number(exp) - frac.length + (digits.length - trimmed.length)}`;
}

/**
 * Out-of-range numbers in the RAW bytes — the fourth I-JSON condition SPEC:1587-1588 names
 * ("unparseable, duplicate object names, lone surrogate, out-of-range number") and the only one
 * this module did not enforce.
 *
 * WHY RAW BYTES, and why no mutant could ever have found this. `JSON.parse('12345678901234567890')`
 * yields `12345678901234567000` and reports nothing: the caller sent one number and the durable
 * decision binds a different one. After the parse the information is GONE, so a mutant aimed at a
 * post-parse branch would have SURVIVED and read as a suite hole. This class is not reachable by
 * mutation by construction; it is reached by asking what the SPEC names and whether the code can
 * produce it at all.
 *
 * THE PREDICATE IS ROUND-TRIP STABILITY, not a safe-integer test, and the difference is not
 * academic: `1e-400` parses to exactly `0`, and `Number.isSafeInteger(0)` is `true` — the underflow
 * case does not merely escape a safe-integer test, it passes one AFFIRMATIVELY while the value it
 * came from has been destroyed. Stability is also the right criterion on its own terms: RFC 8785
 * canonicalises from the double, so two implementations agree exactly when the literal survives
 * text → double → text. `0.1` is therefore fine (it is not exactly representable, but its shortest
 * round-trip form is `0.1` in every conforming reader); `12345678901234567890` is not.
 *
 * A scanner for the same reason `hasDuplicateNames` is one: digits inside a string are not numbers,
 * and a recogniser that succeeds on a prefix is a parser that lies.
 */
export function hasOutOfRangeNumber(
  text: string,
): { outOfRange: true; literal: string; reads: string } | { outOfRange: false } {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      if (j >= n) return { outOfRange: false }; // unterminated: not our error to report
      i = j + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      if (text[j] === "-") j++;
      while (j < n && text[j] >= "0" && text[j] <= "9") j++;
      if (text[j] === ".") { j++; while (j < n && text[j] >= "0" && text[j] <= "9") j++; }
      if (text[j] === "e" || text[j] === "E") {
        j++;
        if (text[j] === "+" || text[j] === "-") j++;
        while (j < n && text[j] >= "0" && text[j] <= "9") j++;
      }
      const literal = text.slice(i, j);
      const value = Number(literal);
      // OVERFLOW AND NaN NEED NO SEPARATE TEST, and this is measured rather than argued: a mutation
      // that deleted an `!Number.isFinite(value) ||` guard here SURVIVED the whole suite with every
      // cell green, including the overflow one. `String(Infinity)` is `"Infinity"`, which is not a
      // number literal and so keys to itself — it can never equal a normalised key. The guard was
      // stating an intent the comparison already enforced, and a guard that guards nothing reads to
      // the next person as though something depends on it.
      if (decimalValueKey(literal) !== decimalValueKey(String(value)))
        return { outOfRange: true, literal, reads: String(value) };
      i = j;
      continue;
    }
    i++;
  }
  return { outOfRange: false };
}

export function decideAdmission(
  rawBytes: Uint8Array,
  parsedBody: unknown,
  subject: ParsedEpRequest,
  ceiling: { maxBytes: number; maxDepth: number; maxItems: number },
): AdmissionOutcome {
  if (rawBytes.byteLength > ceiling.maxBytes)
    return { outcome: "quarantine", cause: "submission-too-large",
      detail: `${rawBytes.byteLength} raw bytes over the declared maxBytes ${ceiling.maxBytes}` };

  if (parsedBody === undefined)
    return { outcome: "quarantine", cause: "no-usable-id", detail: "bytes do not parse as JSON" };

  const { depth, items } = measure(parsedBody);
  if (depth > ceiling.maxDepth)
    return { outcome: "quarantine", cause: "submission-too-deep",
      detail: `depth ${depth} over the declared maxDepth ${ceiling.maxDepth}` };
  if (items > ceiling.maxItems)
    return { outcome: "quarantine", cause: "submission-too-many-items",
      detail: `${items} members/items over the declared maxItems ${ceiling.maxItems}` };

  const id = (parsedBody !== null && typeof parsedBody === "object" && !Array.isArray(parsedBody))
    ? (parsedBody as Record<string, unknown>).id : undefined;
  if (typeof id !== "string" || id.length === 0)
    return { outcome: "quarantine", cause: "no-usable-id",
      detail: "no `id`: there is no caller-scoped subject to address a decision to" };
  // NON-EMPTY IS NOT USABLE. The id becomes a SUBJECT TOKEN — `epf.<e>.dec.<owner>.<actor>.<uid>.<id>`
  // — so an id outside the token grammar has no subject to address a decision to, exactly as an
  // absent one does not. This check was missing while `assertIdToken` was already imported into this
  // file and used two functions away: `bad.id` admitted here and threw at the subject builder later,
  // turning a submission defect into an internal error at a boundary that had already accepted it.
  try { assertIdToken(id, "submission id"); }
  catch (e) {
    return { outcome: "quarantine", cause: "no-usable-id",
      detail: `\`id\` is not within the token grammar, so it names no subject: ${(e as Error).message}` };
  }

  // DUPLICATE NAMES, decided from the RAW bytes because the parsed value cannot show them. Placed
  // after the id check so the causes stay ordered by what the operator can act on, and before the
  // fingerprint because a submission two implementations could read differently has no canonical
  // form to fingerprint.
  let rawText: string | undefined;
  try { rawText = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes); } catch { rawText = undefined; }
  if (rawText !== undefined) {
    const dup = hasDuplicateNames(rawText);
    if (dup.duplicate)
      return { outcome: "quarantine", cause: "no-canonical-form",
        detail: `duplicate object name ${JSON.stringify(dup.name)}: two conforming implementations `
              + `may read this submission differently, so it has no interoperable canonical form` };

    // OUT-OF-RANGE NUMBERS, same cause and the same reason: decided from the raw bytes because the
    // parsed value has already lost the evidence. This one is not a submission two implementations
    // MIGHT read differently — it is one THIS implementation has already read differently from what
    // the caller wrote, and admitting it binds the altered value durably.
    const num = hasOutOfRangeNumber(rawText);
    if (num.outOfRange)
      return { outcome: "quarantine", cause: "no-canonical-form",
        detail: `number ${num.literal} has no interoperable I-JSON value: it reads back as `
              + `${num.reads}, so the decision would bind a value the caller did not send` };
  }

  let object: Record<string, unknown>, fingerprint: string;
  try {
    ({ object, fingerprint } = submissionFingerprint(parsedBody, subject));
  } catch (e) {
    return { outcome: "quarantine", cause: "no-canonical-form", detail: (e as Error).message };
  }

  // POST-CANONICAL. The canonical form is what an acceptance embeds and what every consumer
  // re-derives, so it is the form the ceiling has to hold for. A breach here is REJECTED rather
  // than quarantined for one reason only: the fingerprint exists, so the caller can be told.
  const canonicalBytes = new TextEncoder().encode(JSON.stringify(object)).byteLength;
  if (canonicalBytes > ceiling.maxBytes)
    return { outcome: "reject", code: "resource-exhausted", fingerprint, object,
      detail: `canonical form is ${canonicalBytes} bytes, over the declared maxBytes ${ceiling.maxBytes}` };

  return { outcome: "admit", fingerprint, object };
}

// ---- fact shapes (§13.4 items 3 and 5) and their consuming-boundary validators ---------------

export interface FactCaller { id: string; lifecycleUid: string }

export interface AcceptanceFact {
  v: 1;
  id: string;
  decision: "accepted";
  fingerprint: string;
  /** The canonical EndpointRequest, args INLINE (bounded by max_payload — preflighted). */
  request: Record<string, unknown>;
  caller: FactCaller;
  target?: { owner: string; actor: string; lifecycleUid: string; mappingRevision?: number };
  contractDigests: { input: string; output: string };
  authzDecision: { revision: number; epoch: number };
  /** The acceptance's SINGLE execution route: effects consumers MUST ack a pool-routed
   *  acceptance without effect, and vice versa — no acceptance executes twice. */
  route: "effects" | `pool.${string}`;
  readinessDeadlineMs?: number;
  workExpiry?: number;
  sourceSeq: number;
  ts: number;
}

export interface RejectionFact {
  v: 1;
  id: string;
  decision: "rejected";
  fingerprint: string;
  error: { code: string; detail?: string };
  caller: FactCaller;
  authzDecision?: { revision: number; epoch: number };
  sourceSeq: number;
  ts: number;
}

export interface QuarantineFact {
  v: 1;
  decision: "quarantined";
  sourceSeq: number;
  /** `sha256:<hex>` over the RAW stored submission bytes — never the poison bytes themselves. */
  submissionDigest: string;
  error: { code: string; detail?: string };
  caller?: FactCaller;
  ts: number;
}

export type DecisionFact = AcceptanceFact | RejectionFact;

export interface EffectFact {
  v: 1;
  id: string;
  fingerprint: string;
  caller: FactCaller;
  sourceSeq: number;
  ts: number;
  /** The REQUIRED outcome discriminant (the goal union's `state` bar, applied to effects): every
   *  member of the completion union declares its outcome explicitly, so a cancelled fact is never
   *  structurally assignable to the ran type and every reader is forced to read the outcome. */
  outcome: "ran";
}

/** The RETIREMENT-CANCELLED member of the effects completion union (§13.8 option-(i) closure):
 *  the SAME identity spine as {@link EffectFact} (so every fingerprint/sourceSeq binding applies
 *  unchanged), the `outcome: "cancelled"` discriminant, and the `cancelled` block binding the
 *  acceptance to the RETIRING target and the retirement operation — a reader that sees it KNOWS
 *  the effect did not run and was cancelled by that retirement; it is never a forged success. It publishes CREATE-ONLY on the SAME completion
 *  subject the real marker would use, so first-terminal-wins is structural: a racing real
 *  completion that lands first wins and the cancel loses its create harmlessly (and vice versa).
 *  Actions need no such member: `goal.result` already carries the first-class `cancelled`
 *  terminal state, with the retirement binding in its digest-bound `data`. */
export interface EffectCancelledFact {
  v: 1;
  id: string;
  fingerprint: string;
  caller: FactCaller;
  sourceSeq: number;
  ts: number;
  outcome: "cancelled";
  cancelled: { opId: string; target: { owner: string; actor: string; lifecycleUid: string } };
}

/** The closed non-action effects completion union: ran, or retirement-cancelled. */
export type EffectCompletionFact = EffectFact | EffectCancelledFact;

/** Build the durable completion marker for one validated non-action `effects` acceptance. */
export function effectFactOf(acceptance: AcceptanceFact, ts: number): EffectFact {
  if (acceptance.route !== "effects" || typeof acceptance.request.goalId === "string")
    throw new EpEnvelopeError("failed-precondition", "an effect completion fact is only for a non-action route:effects acceptance (actions complete through goal.result)");
  if (!isDigest(acceptance.fingerprint) || !posInt(acceptance.sourceSeq) || !wireInt(ts))
    throw new EpEnvelopeError("failed-precondition", "an effect completion fact requires a validated acceptance fingerprint/sourceSeq and non-negative timestamp");
  const caller = checkCaller(acceptance.caller, "effect acceptance caller");
  return { v: 1, id: assertIdToken(acceptance.id, "effect id"), fingerprint: acceptance.fingerprint, caller, sourceSeq: acceptance.sourceSeq, ts, outcome: "ran" };
}

/** Build the retirement-cancelled completion marker for one validated non-action `effects`
 *  acceptance (§13.8 option (i)): the acceptance's own identity spine + the retirement binding.
 *  The caller supplies the retirement's `opId` and the RETIRING target; the acceptance's own
 *  `target` must name that same lifecycle (a retirement never cancels a foreign target's work). */
export function effectCancelledFactOf(
  acceptance: AcceptanceFact,
  cancelled: { opId: string; target: { owner: string; actor: string; lifecycleUid: string } },
  ts: number,
): EffectCancelledFact {
  const base = effectFactOf(acceptance, ts);
  if (typeof cancelled.opId !== "string" || cancelled.opId.length === 0 || cancelled.opId.length > 64)
    throw new EpEnvelopeError("failed-precondition", "a cancelled effect marker requires the retirement opId (SPEC 13.8)");
  const t = cancelled.target;
  if (typeof t?.owner !== "string" || t.owner.length === 0 || typeof t.actor !== "string" || t.actor.length === 0 || typeof t.lifecycleUid !== "string" || t.lifecycleUid.length === 0)
    throw new EpEnvelopeError("failed-precondition", "a cancelled effect marker requires the retiring target triple (SPEC 13.8)");
  if (acceptance.target === undefined || acceptance.target.lifecycleUid !== t.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `a retirement cancels only ITS target's accepted work: the acceptance targets ${acceptance.target?.lifecycleUid ?? "(none)"}, not ${t.lifecycleUid} (SPEC 13.8)`);
  return { ...base, outcome: "cancelled", cancelled: { opId: cancelled.opId, target: { owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid } } };
}

function factFail(what: string): never {
  throw new EpEnvelopeError("internal", `fact does not validate: ${what}`);
}
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const wireInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isDigest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);

function assertClosedKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const ok = new Set(allowed);
  for (const k of Object.keys(o)) if (!ok.has(k)) factFail(`${what} carries unknown field ${k}`);
}

function checkError(v: unknown, what: string): { code: string; detail?: string } {
  if (!isRec(v) || typeof v.code !== "string" || !isEpErrorCode(v.code)) factFail(`${what}.code`);
  if (v.detail !== undefined && (typeof v.detail !== "string" || Buffer.byteLength(v.detail, "utf8") > 256)) factFail(`${what}.detail exceeds 256 bytes`);
  return v as { code: string; detail?: string };
}
function checkCaller(v: unknown, what: string): FactCaller {
  if (!isRec(v) || typeof v.id !== "string" || typeof v.lifecycleUid !== "string") factFail(what);
  const toks = v.id.split(".");
  if (toks.length !== 2) factFail(`${what}.id is not an <owner>.<actor> principal`);
  try {
    assertBoundedOwner(toks[0], `${what} owner`);
    assertBoundedOwner(toks[1], `${what} actor`);
    assertLifecycleToken(v.lifecycleUid, `${what}.lifecycleUid`);
  } catch (e) {
    factFail(`${what}: ${(e as Error).message}`);
  }
  return v as unknown as FactCaller;
}
function checkAuthzDecision(v: unknown, what: string): void {
  if (!isRec(v) || !wireInt(v.revision) || !wireInt(v.epoch)) factFail(what);
}
function checkTarget(v: unknown): void {
  if (!isRec(v) || typeof v.owner !== "string" || typeof v.actor !== "string" || typeof v.lifecycleUid !== "string") factFail("target");
  try {
    assertBoundedOwner(v.owner, "target owner");
    assertBoundedOwner(v.actor, "target actor");
    assertLifecycleToken(v.lifecycleUid, "target lifecycleUid");
  } catch (e) {
    factFail(`target: ${(e as Error).message}`);
  }
  if (v.mappingRevision !== undefined && !wireInt(v.mappingRevision)) factFail("target.mappingRevision");
}
/** The embedded canonical request of an acceptance: it MUST be a fully valid canonical
 *  `EndpointRequest` (§13.3/§13.4), not merely a `{v,id,class,op}` shell — so it is routed
 *  through the SAME {@link parseEndpointRequest} the request boundary uses (its boundary error,
 *  a caller-facing code, maps to `internal` here because a malformed STORED request is a writer
 *  bug, not a caller error). Then it is cross-checked against the fact address so a stored
 *  acceptance can never smuggle a request for a different id/endpoint/caller into effects or
 *  replay: journal class, id, op.endpoint, and the request's own `from.id` must all agree with
 *  the broker-authenticated fact subject. Returns the parsed request for the target cross-check. */
function checkEmbeddedRequest(v: unknown, addr: FactAddress): EndpointRequest {
  let req: EndpointRequest;
  try {
    req = parseEndpointRequest(v);
  } catch (e) {
    return factFail(`request is not a canonical EndpointRequest: ${(e as Error).message}`);
  }
  if (req.class !== "journal") factFail("request.class (only journal-class submissions produce decision facts)");
  if (req.id !== addr.id) factFail("request.id disagrees with the fact address");
  if (req.op.endpoint !== addr.endpoint) factFail("request.op.endpoint disagrees with the fact address");
  if (req.from.id !== addr.caller.id) factFail("request.from.id disagrees with the authenticated fact caller");
  return req;
}

/** The authenticated ADDRESS of a decision fact: the `epf….dec.<cO>.<cA>.<cUid>.<id>` subject
 *  tokens the broker enforced on the mediated writer's publish. */
export interface FactAddress { endpoint: string; caller: FactCaller; id: string }

/** Parse a decision-fact subject into its address — the mandatory seam through which every
 *  consuming boundary proves body↔subject agreement. Throws `internal` on a non-decision
 *  subject (a consumer wired to the wrong subject family is a bug, never a data error). */
export function parseDecisionFactSubject(subject: string): FactAddress {
  const p = parseEpSubject(subject);
  if (!p || p.plane !== "fact" || p.topic.length !== 5 || p.topic[0] !== "dec")
    throw new EpEnvelopeError("internal", `${subject} is not a decision-fact subject`);
  return { endpoint: p.endpoint, caller: { id: `${p.topic[1]}.${p.topic[2]}`, lifecycleUid: p.topic[3] }, id: p.topic[4] };
}

/** Parse an effect-completion fact subject into its authenticated acceptance identity. */
export function parseEffectFactSubject(subject: string): FactAddress {
  const p = parseEpSubject(subject);
  if (!p || p.plane !== "fact" || p.topic.length !== 5 || p.topic[0] !== "eff")
    throw new EpEnvelopeError("internal", `${subject} is not an effect-completion fact subject`);
  return { endpoint: p.endpoint, caller: { id: `${p.topic[1]}.${p.topic[2]}`, lifecycleUid: p.topic[3] }, id: p.topic[4] };
}

/** Validate a decision fact at its consuming boundary (§13.3: every plane is runtime-validated;
 *  effects and replay read THE FACT, never the raw submission). The fact must be
 *  SELF-SUFFICIENT canonical authority: every field is grammar-validated (caller principal,
 *  positive source sequence/timestamp, digest forms, the embedded canonical request, the
 *  resolved target triple), and the body's id/caller/endpoint must AGREE with the
 *  broker-authenticated fact subject — a mismatch is a writer bug or corrupt store and fails
 *  loud before effects or replay can attribute the decision. */
export function parseDecisionFact(raw: unknown, subject: string): DecisionFact {
  const addr = parseDecisionFactSubject(subject);
  const o = isRec(raw) ? raw : factFail("not an object");
  if (o.v !== 1) factFail("v");
  if (typeof o.id !== "string") factFail("id");
  try {
    assertIdToken(o.id, "fact id");
  } catch {
    factFail("id grammar");
  }
  if (o.id !== addr.id) factFail("id disagrees with the fact subject");
  if (!isDigest(o.fingerprint)) factFail("fingerprint");
  // sourceSeq is a stream sequence (>= 1); ts is a wire timestamp (>= 0, §13.7).
  if (!posInt(o.sourceSeq)) factFail("sourceSeq must be a positive stream sequence");
  if (!wireInt(o.ts)) factFail("ts must be a non-negative integer");
  const caller = checkCaller(o.caller, "caller");
  if (caller.id !== addr.caller.id || caller.lifecycleUid !== addr.caller.lifecycleUid)
    factFail("caller disagrees with the fact subject");
  if (o.decision === "rejected") {
    checkError(o.error, "error");
    if (o.authzDecision !== undefined) checkAuthzDecision(o.authzDecision, "authzDecision");
    return o as unknown as RejectionFact;
  }
  if (o.decision !== "accepted") factFail(`decision ${JSON.stringify(o.decision)}`);
  const req = checkEmbeddedRequest(o.request, addr);
  // The stored acceptance must expose ONE coherent effect authority (§13.4: self-sufficient for
  // effect and replay) — target presence is EQUIVALENT to the request's (§13.3: a body target
  // exists exactly for the targeted modes): a targeted acceptance that dropped its target is not
  // replayable, and an untargeted request with a spurious fact target smuggles authority the
  // caller never asked for.
  if ((req.target !== undefined) !== (o.target !== undefined))
    factFail(req.target !== undefined
      ? "a targeted request's acceptance must persist the resolved target"
      : "an untargeted request's acceptance must not carry a target");
  if (o.target !== undefined && req.target !== undefined) {
    checkTarget(o.target);
    // The fact target must equal the request's FULL tuple. lifecycleUid is the caller's EXPECTED
    // binding, validator-checked against the current mapping (§13.3) — resolution validates it,
    // never replaces it; goals bind (principal, lifecycleUid) (§13.6), so a substituted UID
    // redirects effect/replay to a recycled alias. A caller-pinned mappingRevision pins the
    // exact observed revision; only an OMITTED one may be filled by resolution.
    const ft = o.target as { owner: string; actor: string; lifecycleUid: string; mappingRevision?: number };
    if (req.target.owner !== ft.owner || req.target.actor !== ft.actor || req.target.lifecycleUid !== ft.lifecycleUid)
      factFail("the fact target does not equal the embedded request's target tuple");
    if (req.target.mappingRevision !== undefined && ft.mappingRevision !== req.target.mappingRevision)
      factFail("the fact target does not carry the mappingRevision the request pinned");
  }
  const cd = o.contractDigests;
  if (!isRec(cd) || !isDigest(cd.input) || !isDigest(cd.output)) factFail("contractDigests");
  // Where the request pinned contract digests (§13.3: required on every command except
  // `describe`), the fact's contractDigests must EQUAL them — otherwise consumers validate and
  // effect under a different contract than the caller accepted. An omitted digest (describe)
  // is the only fill: the fact then carries the canonicalizer-resolved digest uncompared.
  if (req.op.inputDigest !== undefined && cd.input !== req.op.inputDigest)
    factFail("contractDigests.input disagrees with the embedded request's pinned op.inputDigest");
  if (req.op.outputDigest !== undefined && cd.output !== req.op.outputDigest)
    factFail("contractDigests.output disagrees with the embedded request's pinned op.outputDigest");
  checkAuthzDecision(o.authzDecision, "authzDecision");
  if (o.route !== "effects" && !(typeof o.route === "string" && /^pool\.[a-z0-9-]{1,32}$/.test(o.route))) factFail("route");
  if (o.readinessDeadlineMs !== undefined && !wireInt(o.readinessDeadlineMs)) factFail("readinessDeadlineMs must be a non-negative integer");
  if (o.workExpiry !== undefined && !posInt(o.workExpiry)) factFail("workExpiry");
  if (String(o.route).startsWith("pool.") !== (o.workExpiry !== undefined)) factFail("workExpiry is present iff the route is a pool");
  return o as unknown as AcceptanceFact;
}

/** Validate a non-action effects completion fact at the consuming boundary — the CLOSED
 *  two-member union: the effect ran ({@link EffectFact}) or it was retirement-cancelled
 *  ({@link EffectCancelledFact}; the `cancelled` discriminator, whose block must itself be
 *  closed and complete). A bare marker on the right subject is not enough: the body must bind
 *  the accepted fingerprint and source sequence so the drain can compare it to the decision
 *  that authorized this exact effect — for BOTH members. */
export function parseEffectFact(raw: unknown, subject: string): EffectCompletionFact {
  const addr = parseEffectFactSubject(subject);
  const o = isRec(raw) ? raw : factFail("effect fact is not an object");
  // The SYMMETRIC outcome discriminant (the goal union's bar): every member declares its outcome,
  // so a fact missing it — or claiming one outcome while carrying the other's fields — refuses.
  if (o.outcome !== "ran" && o.outcome !== "cancelled") factFail("effect.outcome must be \"ran\" or \"cancelled\"");
  const isCancelled = o.outcome === "cancelled";
  assertClosedKeys(o, isCancelled ? ["v", "id", "fingerprint", "caller", "sourceSeq", "ts", "outcome", "cancelled"] : ["v", "id", "fingerprint", "caller", "sourceSeq", "ts", "outcome"], `effect fact on ${subject}`);
  if (o.v !== 1) factFail("effect.v");
  if (o.id !== addr.id) factFail("effect.id disagrees with the fact subject");
  if (!isDigest(o.fingerprint)) factFail("effect.fingerprint");
  if (!posInt(o.sourceSeq)) factFail("effect.sourceSeq must be a positive stream sequence");
  if (!wireInt(o.ts)) factFail("effect.ts must be a non-negative integer");
  const caller = checkCaller(o.caller, "effect.caller");
  if (caller.id !== addr.caller.id || caller.lifecycleUid !== addr.caller.lifecycleUid)
    factFail("effect.caller disagrees with the fact subject");
  const base = { v: 1 as const, id: addr.id, fingerprint: o.fingerprint as string, caller, sourceSeq: o.sourceSeq as number, ts: o.ts as number };
  if (!isCancelled) return { ...base, outcome: "ran" };
  const c = o.cancelled;
  if (!isRec(c)) factFail("effect.cancelled is not an object");
  assertClosedKeys(c, ["opId", "target"], `effect.cancelled on ${subject}`);
  if (typeof c.opId !== "string" || c.opId.length === 0 || c.opId.length > 64) factFail("effect.cancelled.opId");
  const t = c.target;
  if (!isRec(t)) factFail("effect.cancelled.target is not an object");
  assertClosedKeys(t, ["owner", "actor", "lifecycleUid"], `effect.cancelled.target on ${subject}`);
  if (typeof t.owner !== "string" || t.owner.length === 0 || typeof t.actor !== "string" || t.actor.length === 0 || typeof t.lifecycleUid !== "string" || t.lifecycleUid.length === 0)
    factFail("effect.cancelled.target triple");
  return { ...base, outcome: "cancelled", cancelled: { opId: c.opId, target: { owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid } } };
}

/** Validate a quarantine fact at its consuming boundary; the body's source sequence must agree
 *  with the `epf….quar.<seq>` subject it was stored under. */
export function parseQuarantineFact(raw: unknown, subject: string): QuarantineFact {
  const p = parseEpSubject(subject);
  if (!p || p.plane !== "fact" || p.topic.length !== 2 || p.topic[0] !== "quar")
    throw new EpEnvelopeError("internal", `${subject} is not a quarantine-fact subject`);
  const o = isRec(raw) ? raw : factFail("not an object");
  if (o.v !== 1 || o.decision !== "quarantined") factFail("v/decision");
  if (!posInt(o.sourceSeq)) factFail("sourceSeq must be a positive integer");
  if (String(o.sourceSeq) !== p.topic[1]) factFail("sourceSeq disagrees with the fact subject");
  if (!isDigest(o.submissionDigest)) factFail("submissionDigest");
  checkError(o.error, "error");
  if (o.caller !== undefined) checkCaller(o.caller, "caller");
  if (!wireInt(o.ts)) factFail("ts must be a non-negative integer");
  return o as unknown as QuarantineFact;
}

/** Preflight a fact's SERIALIZED size against the broker's max_payload (§13.4 item 5): an
 *  acceptance that would not fit is rejected `resource-exhausted` BEFORE any decision exists
 *  (the rejection fact always fits by construction — every field bounded or fixed-size). */
export function assertFactFits(fact: DecisionFact | QuarantineFact, maxPayload: number): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(fact));
  if (bytes.length > maxPayload)
    throw new EpEnvelopeError("resource-exhausted", `the serialized decision fact is ${bytes.length} bytes (max_payload ${maxPayload}); a submission whose acceptance cannot fit is refused loudly, never spilled into storage`);
  return bytes;
}

// ---- the decision CAS (§13.4 item 3: first decision wins atomically) -------------------------

/** Append a submission PLAIN (§13.4 item 1): never a `Nats-Msg-Id`, no dedupe header of any
 *  kind — the guarantee rests on the header rule, not the window. Returns the stream ack. */
export async function appendSubmission(js: JetStreamClient, subject: string, envelope: unknown): Promise<{ seq: number }> {
  const pa = await js.publish(subject, new TextEncoder().encode(JSON.stringify(envelope)));
  return { seq: pa.seq };
}

/** Publish a fact with create-only CAS (expected last sequence ON THE SUBJECT = 0). Returns
 *  `{ won: true, seq }` or `{ won: false }` on a lost CAS — the loser then READS the winning
 *  fact ({@link readLastFact}) instead of deciding again. Any non-CAS failure propagates. */
export async function publishFactCreateOnly(
  js: JetStreamClient,
  subject: string,
  factBytes: Uint8Array,
): Promise<{ won: true; seq: number } | { won: false }> {
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    const pa = await js.publish(subject, factBytes, { headers: h });
    return { won: true, seq: pa.seq };
  } catch (e) {
    // The SHARED structured classifier (err_code, never message text): a missed classification
    // here would turn a benign concurrent decision into an unhandled throw in the mediated
    // writer — a normal race becoming an error/stall is exactly the failure text-matching risks.
    if (isCasLoss(e)) return { won: false };
    throw e;
  }
}

/** Last-by-subject read of a fact — LEADER-SERVED (`STREAM.MSG.GET`, never `DIRECT.GET`). The
 *  §13.4 loser-reads-winner contract needs read-your-writes against the leader that just
 *  rejected the CAS: a follower-served Direct Get carries no such guarantee and, after legal
 *  post-horizon id reuse, can return a STALE prior fact (semantically a DIFFERENT decision) or
 *  nothing — and no retry can distinguish a stale nonempty fact from the current winner. EPF
 *  keeps `allow_direct=true` for other trusted subject-confined reads (§13.12); the CAS-winner
 *  read is deliberately not one of them. `undefined` when no fact exists on the subject. */
export async function readLastFact(
  jsm: JetStreamManager,
  stream: string,
  subject: string,
): Promise<unknown | undefined> {
  let m;
  try {
    m = await jsm.streams.getMessage(stream, { last_by_subj: subject });
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037) return undefined; // no message found on the subject
    throw e;
  }
  if (!m) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(m.data));
  } catch (e) {
    throw new EpEnvelopeError("internal", `fact on ${subject} does not decode as JSON: ${(e as Error).message}`);
  }
}

/**
 * v0.4 endpoint control-surface subject grammar (SPEC §13.2) — builders, parsers, and token
 * validators for the `ep` request/reply rails and the endpoint-published planes
 * (`epe`/`epf`/`epj`/`ept`/`epr`/`epc`/`epw`/`eps`).
 *
 * Builders validate FAIL-LOUD (the spec's build-time boundary: bad token or an over-1024-byte
 * subject throws, never truncates). The parser mirrors {@link parseSubject}'s trust model: it
 * SPLITS AND DISPATCHES only — the broker already forge-locked the identity slots via the minted
 * grant, so a reader recovers tokens, it does not re-prove their grammar. What the parser DOES
 * enforce is SHAPE: prefix, plane, exact arity, and the §13.2 explicit-discrimination rule (the
 * token after `<command>` is either one of the six reserved authorization-mode tokens or the
 * caller's owner token). §2's owner grammar (`local` or `u_`+base32) keeps those sets disjoint
 * for every spec-conformant mint; this module's owner validator is deliberately wider (it admits
 * legacy principal tokens), so the dispatch additionally rests on each mode's pinned arity — a
 * colliding token parses to `null`, never to a confused identity. A subject matching no defined
 * shape returns `null` and MUST NOT be handled.
 */
import { ROOT, spacePrefix, assertValidOwnerToken, assertLifecycleToken } from "./subjects.js";

// One grammar bounds both `lifecycleUid` and `instanceId` (§13.1) — the definition lives in
// subjects.ts (the messaging plane lifecycle-keys resource names with it); re-exported here so the
// endpoint rails keep their import surface.
export { assertLifecycleToken, mintLifecycleUid } from "./subjects.js";

/** The v0.4 wire version this surface targets. Advertised (§6 `protocolVersion`) only at the
 *  §13.11 cutover — a change signal, not negotiation; nothing pre-cut should flip the card. */
export const PROTOCOL_VERSION_V04 = "0.4";

/** Reserved command names (§13.2): every endpoint serves `describe` (§13.7); `cancel` is the
 *  action-composite control command (§13.6). */
export const RESERVED_COMMANDS = ["describe", "cancel"] as const;

// ---- token grammars (§13.2 "Token bounds", §13.1) -----------------------------------------

const ENDPOINT_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const COMMAND = /^[a-z0-9-]{1,32}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/; // <id>, <goalId>, <timerId>, <token>, <sessionId>
const GRANT_ID = /^[a-z0-9]{1,32}$/; // <gid>: separator-free, so multi-soft-component durable names stay injective (§13.9)
const DIGEST_HEX = /^[a-f0-9]{64}$/;
const EPOCH = /^(0|[1-9][0-9]*)$/;

/** Maximum total subject size (bytes) on the endpoint rails; builders throw above it. */
export const MAX_EP_SUBJECT_BYTES = 1024;

/** Validate a dotted endpoint NAME (one or more DNS-shaped labels; `_` never appears in a label)
 *  and return its wire TOKEN (`.` → `_`, bijective because labels cannot contain `_`). Single-label
 *  names are reserved for reference-implementation endpoints; a third-party name MUST be
 *  reverse-DNS — that is an AUTHORITY rule enforced at mint (§13.9), not a shape difference, so
 *  both build here. */
export function endpointToken(name: string): string {
  const labels = name.split(".");
  for (const l of labels) {
    if (!ENDPOINT_LABEL.test(l)) throw new Error(`endpoint name label "${l}" in "${name}" is not DNS-shaped ([a-z0-9]([a-z0-9-]*[a-z0-9])?)`);
  }
  const tok = labels.join("_");
  if (tok.length > 64) throw new Error(`endpoint name token "${tok}" exceeds 64 characters`);
  return tok;
}

/** Inverse of {@link endpointToken}: recover the dotted endpoint name from its wire token. */
export function endpointNameOf(token: string): string {
  return token.split("_").join(".");
}

export function assertCommandToken(command: string): string {
  if (!COMMAND.test(command)) throw new Error(`command "${command}" is not a valid command token ([a-z0-9-]{1,32})`);
  return command;
}

export function assertNonce(nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error(`nonce is not a valid nonce token ([A-Za-z0-9_-]{22,64}; >=128 bits of CSPRNG entropy)`);
  return nonce;
}

export function assertIdToken(v: string, what = "id"): string {
  if (!ID.test(v)) throw new Error(`${what} "${v}" is not a valid id token ([A-Za-z0-9_-]{1,64})`);
  return v;
}

/** The provisioner-assigned grant id `<gid>` (§13.9). Deliberately SEPARATOR-FREE ([a-z0-9]):
 *  the `eve_<uid>-<e>-<gid>-<n>` and `rec_<uid>-<gid>-<n>` reader-durable names carry it adjacent
 *  to other soft components across `-`, so a `-` (or `_`) inside `<gid>` would make the name
 *  non-injective (`eve_<uid>-a-b-c-0` could be endpoint `a-b`/gid `c` OR endpoint `a`/gid `b-c`).
 *  Constraining `<gid>` to a separator-free grammar keeps the tuple encoding unambiguous while
 *  `<uid>` is `-`-free (leading) and `<n>` is digits (trailing). */
export function assertGrantId(v: string, what = "grantId"): string {
  if (!GRANT_ID.test(v)) throw new Error(`${what} "${v}" is not a valid grant id ([a-z0-9]{1,32}; separator-free so reader-durable names stay injective)`);
  return v;
}

/** `<pool>` uses the command-token grammar (§13.2). */
export function assertPoolToken(pool: string): string {
  if (!COMMAND.test(pool)) throw new Error(`pool "${pool}" is not a valid pool token ([a-z0-9-]{1,32})`);
  return pool;
}

function assertEpoch(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`epoch ${epoch} is not an unsigned integer`);
  return String(epoch);
}

/** The shared owner/actor token validator for this grammar (§13.2 token bounds): the base
 *  owner-token grammar plus the 64-character rail bound. Grant builders MUST route through the
 *  same validator as subject builders, so the two can never diverge on what they admit. */
export function assertBoundedOwner(v: string, what: string): string {
  assertValidOwnerToken(v);
  if (v.length > 64) throw new Error(`${what} "${v}" exceeds 64 characters`);
  return v;
}

function assertSized(subject: string): string {
  if (new TextEncoder().encode(subject).length > MAX_EP_SUBJECT_BYTES)
    throw new Error(`subject exceeds ${MAX_EP_SUBJECT_BYTES} bytes: ${subject.slice(0, 80)}…`);
  return subject;
}

// ---- caller + authorization-mode target block (§13.2) --------------------------------------

/** The three forge-locked caller tokens every request and journal submission carries:
 *  principal + lifecycle UID (§13.1). */
export interface EpCaller {
  owner: string;
  actor: string;
  uid: string;
}

/** The six reserved authorization-mode tokens. Disjoint from every spec-conformant owner token
 *  (`local` or `u_`+base32 per §2, never a bare mode word); the implementation's owner validator
 *  also admits legacy principal tokens, so the parser's discrimination rests on membership in
 *  this set PLUS each mode's pinned arity, not on the owner grammar alone. */
export const EP_AUTHZ_MODES = ["self", "owner", "any", "child", "ledger", "handle"] as const;
export type EpAuthzMode = (typeof EP_AUTHZ_MODES)[number];
const AUTHZ_SET = new Set<string>(EP_AUTHZ_MODES);

/** Per-mode pinned target-token arity: `self` carries none (the caller triple IS the target);
 *  `owner`/`any`/`child`/`ledger` pin one `<tOwner>`; `handle` pins the full redemption-minted
 *  target triple. The target's lifecycle UID is otherwise body-carried (§13.3), never a token. */
export type EpTarget =
  | { mode: "self" }
  | { mode: "owner" | "any" | "child" | "ledger"; tOwner: string }
  | { mode: "handle"; tOwner: string; tActor: string; tUid: string };

const TARGET_ARITY: Record<EpAuthzMode, number> = { self: 0, owner: 1, any: 1, child: 1, ledger: 1, handle: 3 };

function targetTokens(target: EpTarget): string[] {
  if (target.mode === "self") return ["self"];
  if (target.mode === "handle")
    return ["handle", assertBoundedOwner(target.tOwner, "target owner"), assertBoundedOwner(target.tActor, "target actor"), assertLifecycleToken(target.tUid, "target lifecycleUid")];
  return [target.mode, assertBoundedOwner(target.tOwner, "target owner")];
}

/** The caller triple as validated subject tokens — the ONE validation every caller-scoped
 *  subject and filter goes through. */
export function callerTokens(caller: EpCaller): string[] {
  return [
    assertBoundedOwner(caller.owner, "caller owner"),
    assertBoundedOwner(caller.actor, "caller actor"),
    assertLifecycleToken(caller.uid, "caller lifecycleUid"),
  ];
}

// ---- request / reply builders (§13.2 subject table) ----------------------------------------

/** Where a request routes (never which verb it is — the verb rides the envelope, §13.3/§13.5):
 *  `one` = queue-group anycast to exactly one class member; `all` = scatter to every instance;
 *  `inst` = one instance by its stable `(endpoint, instanceId)` address (single-owner endpoint
 *  names carry no owner tokens). */
export type EpRoute = { mode: "one" | "all" } | { mode: "inst"; instanceId: string };

/** Build a request subject (class, scatter, or instance form; targeted iff `target` is given). */
export function epRequestSubject(
  space: string,
  req: { route: EpRoute; endpoint: string; command: string; target?: EpTarget; caller: EpCaller; nonce: string },
): string {
  const parts = [spacePrefix(space), "ep", req.route.mode, endpointToken(req.endpoint)];
  if (req.route.mode === "inst") parts.push(assertLifecycleToken(req.route.instanceId, "instanceId"));
  parts.push(assertCommandToken(req.command));
  if (req.target) parts.push(...targetTokens(req.target));
  parts.push(...callerTokens(req.caller), assertNonce(req.nonce));
  return assertSized(parts.join("."));
}

/** Build a reply subject: the responder's own endpoint/instance/epoch prefix plus the caller
 *  triple and nonce. Use {@link deriveReplySubject} to answer a request — replies MUST derive
 *  from the authenticated request subject, never from a transport- or payload-supplied target. */
export function epReplySubject(
  space: string,
  r: { endpoint: string; instanceId: string; epoch: number; caller: EpCaller; nonce: string },
): string {
  return assertSized([
    spacePrefix(space), "ep", "reply", endpointToken(r.endpoint), assertLifecycleToken(r.instanceId, "instanceId"),
    assertEpoch(r.epoch), ...callerTokens(r.caller), assertNonce(r.nonce),
  ].join("."));
}

/** Deterministic reply derivation (§13.2 "Replies"): copy the caller triple + nonce off the
 *  broker-authenticated PARSED request and prefix the responder's own instance identity. Taking
 *  a {@link ParsedEpRequest} (not a raw string) makes the confused-deputy boundary structural:
 *  there is no argument through which a payload-supplied reply target could arrive. */
export function deriveReplySubject(
  space: string,
  request: ParsedEpRequest,
  responder: { instanceId: string; epoch: number },
): string {
  return epReplySubject(space, {
    endpoint: request.endpoint,
    instanceId: responder.instanceId,
    epoch: responder.epoch,
    caller: request.caller,
    nonce: request.nonce,
  });
}

// ---- serve / read filters (§13.2, §13.9) ----------------------------------------------------

/** The class rail's canonical queue group: the endpoint-name token. Serve subscriptions to the
 *  `one` rail are queue-qualified ONLY (§13.9) — no credential may plain-subscribe it, which is
 *  what keeps per-request nonces visible only to the queue-selected instance. */
export function epClassQueueGroup(endpoint: string): string {
  return endpointToken(endpoint);
}

/** Subscription filter for a class (`one`) or scatter (`all`) serve. */
export function epServeFilter(space: string, mode: "one" | "all", endpoint: string): string {
  return `${spacePrefix(space)}.ep.${mode}.${endpointToken(endpoint)}.>`;
}

/** Subscription filter for one instance's own request rail. */
export function epInstanceServeFilter(space: string, endpoint: string, instanceId: string): string {
  return `${spacePrefix(space)}.ep.inst.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}.>`;
}

/** A caller's reply-read filter — its OWN rail only, exact arity (no `>` tail admits subjects
 *  outside the grammar): `ep.reply.*.*.*.<owner>.<actor>.<uid>.*`. */
export function epCallerReplyFilter(space: string, caller: EpCaller): string {
  return `${spacePrefix(space)}.ep.reply.*.*.*.${callerTokens(caller).join(".")}.*`;
}

/** A responder's reply-publish pattern — its own instance triple and epoch pinned, all caller
 *  suffixes spanned (addressing is confined by nonce possession, §13.2): exact arity. */
export function epResponderReplyPattern(space: string, endpoint: string, instanceId: string, epoch: number): string {
  return `${spacePrefix(space)}.ep.reply.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}.${assertEpoch(epoch)}.*.*.*.*`;
}

// ---- endpoint-published planes (§13.2 "Event and journal subjects") -------------------------

export type EpTimerPhase = "schedule" | "armed" | "fire";
export type EpSessionDir = "in" | "out";

function topicPath(topic: string[], what: string): string {
  if (topic.length === 0) throw new Error(`${what} topic must have at least one token`);
  for (const t of topic) if (t.length === 0 || t.includes(".")) throw new Error(`${what} topic token "${t}" is empty or dotted`);
  return topic.join(".");
}

/** Events: `epe.<endpoint>.<instanceId>.<epoch>.<topic…>` — the publishing instance's identity
 *  and epoch are forge-locked subject tokens (stale-epoch events are attributably stale). */
export function epeSubject(space: string, endpoint: string, instanceId: string, epoch: number, topic: string[]): string {
  return assertSized(`${spacePrefix(space)}.epe.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}.${assertEpoch(epoch)}.${topicPath(topic, "event")}`);
}

/** Canonical facts: `epf.<endpoint>.<topic…>` — publishable only by the mediated writer (§13.9). */
export function epfSubject(space: string, endpoint: string, topic: string[]): string {
  return assertSized(`${spacePrefix(space)}.epf.${endpointToken(endpoint)}.${topicPath(topic, "fact")}`);
}

/** Journal submissions: `epj.<endpoint>.<command>[.<authz>[.<target…>]].<owner>.<actor>.<uid>` —
 *  directly publishable by capability holders and explicitly UNTRUSTED (§13.4); a targeted
 *  command carries the same authz/target block as its request forms, no nonce. */
export function epjSubject(
  space: string,
  j: { endpoint: string; command: string; target?: EpTarget; caller: EpCaller },
): string {
  const parts = [spacePrefix(space), "epj", endpointToken(j.endpoint), assertCommandToken(j.command)];
  if (j.target) parts.push(...targetTokens(j.target));
  parts.push(...callerTokens(j.caller));
  return assertSized(parts.join("."));
}

/** Timers: `ept.<endpoint>.<instanceId>.<epoch>.<timerId>.<schedule|armed|fire>` (§13.2). */
export function eptSubject(space: string, endpoint: string, instanceId: string, epoch: number, timerId: string, phase: EpTimerPhase): string {
  return assertSized(`${spacePrefix(space)}.ept.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}.${assertEpoch(epoch)}.${assertIdToken(timerId, "timerId")}.${phase}`);
}

/** Record writes: `epr.<endpoint>.<instanceId>.<epoch>.<kind>.<qualifier…>` — the instance's
 *  epoch-pinned mediated record-writer ingress (§13.9 reads the epoch off this subject). */
export function eprSubject(space: string, endpoint: string, instanceId: string, epoch: number, kind: string, qualifier: string[] = []): string {
  const tail = qualifier.length ? `.${topicPath(qualifier, "record qualifier")}` : "";
  return assertSized(`${spacePrefix(space)}.epr.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}.${assertEpoch(epoch)}.${assertIdToken(kind, "record kind")}${tail}`);
}

/** Contract artifacts: `epc.<digest-hex>` — one immutable artifact per subject; the token is the
 *  SHA-256 hex (the `sha256:` prefix is not a subject token, §13.7). */
export function epcSubject(space: string, digestHex: string): string {
  if (!DIGEST_HEX.test(digestHex)) throw new Error(`contract digest "${digestHex}" is not 64 lowercase hex chars`);
  return `${spacePrefix(space)}.epc.${digestHex}`;
}

/** Work pools: `epw.<endpoint>.<pool>.<cOwner>.<cActor>.<cUid>.<id>` — the trailing four tokens
 *  are the item's ACCEPTANCE IDENTITY (the accepted submission's caller triple + request id). */
export function epwSubject(space: string, endpoint: string, pool: string, acceptance: EpCaller & { id: string }): string {
  return assertSized(`${spacePrefix(space)}.epw.${endpointToken(endpoint)}.${assertPoolToken(pool)}.${callerTokens(acceptance).join(".")}.${assertIdToken(acceptance.id)}`);
}

/** Sessions: `eps.<endpoint>.<sessionId>.<epoch>.<in|out>` (§13.6). */
export function epsSubject(space: string, endpoint: string, sessionId: string, epoch: number, dir: EpSessionDir): string {
  return assertSized(`${spacePrefix(space)}.eps.${endpointToken(endpoint)}.${assertIdToken(sessionId, "sessionId")}.${assertEpoch(epoch)}.${dir}`);
}

// ---- parser (§13.2 explicit discrimination; exact arity; null = MUST NOT handle) ------------

export interface ParsedEpRequest {
  plane: "request";
  route: "one" | "all" | "inst";
  endpoint: string;
  /** Present iff `route === "inst"`. */
  instanceId?: string;
  command: string;
  /** `null` = untargeted form (no authz token). */
  target: EpTarget | null;
  caller: EpCaller;
  nonce: string;
}

export type ParsedEp =
  | ParsedEpRequest
  | { plane: "reply"; endpoint: string; instanceId: string; epoch: number; caller: EpCaller; nonce: string }
  | { plane: "event"; endpoint: string; instanceId: string; epoch: number; topic: string[] }
  | { plane: "fact"; endpoint: string; topic: string[] }
  | { plane: "journal"; endpoint: string; command: string; target: EpTarget | null; caller: EpCaller }
  | { plane: "timer"; endpoint: string; instanceId: string; epoch: number; timerId: string; phase: EpTimerPhase }
  | { plane: "record"; endpoint: string; instanceId: string; epoch: number; kind: string; qualifier: string[] }
  | { plane: "contract"; digestHex: string }
  | { plane: "work"; endpoint: string; pool: string; acceptance: EpCaller & { id: string } }
  | { plane: "session"; endpoint: string; sessionId: string; epoch: number; dir: EpSessionDir };

/** Read the `[.<authz>[.<target…>]].<owner>.<actor>.<uid>` tail (plus `withNonce` trailing
 *  token) starting at `i`. Dispatches on the token at `i`: a reserved mode token opens a
 *  target block of that mode's pinned arity; anything else is the caller's owner token (the
 *  two sets are disjoint by construction — never arity counting). Exact arity: returns null
 *  unless the tokens run out exactly at the end. */
function parseTail(parts: string[], i: number, withNonce: boolean): { target: EpTarget | null; caller: EpCaller; nonce?: string } | null {
  let target: EpTarget | null = null;
  const disc = parts[i];
  if (disc !== undefined && AUTHZ_SET.has(disc)) {
    const mode = disc as EpAuthzMode;
    const arity = TARGET_ARITY[mode];
    const t = parts.slice(i + 1, i + 1 + arity);
    if (t.length !== arity) return null;
    target =
      mode === "self" ? { mode }
      : mode === "handle" ? { mode, tOwner: t[0], tActor: t[1], tUid: t[2] }
      : { mode, tOwner: t[0] };
    i += 1 + arity;
  }
  const want = i + 3 + (withNonce ? 1 : 0);
  if (parts.length !== want) return null;
  const caller: EpCaller = { owner: parts[i], actor: parts[i + 1], uid: parts[i + 2] };
  return withNonce ? { target, caller, nonce: parts[i + 3] } : { target, caller };
}

function parseEpoch(tok: string): number | null {
  if (!EPOCH.test(tok)) return null;
  const n = Number(tok);
  // Mirror assertEpoch's build-side bound: past 2^53 distinct tokens would Number()-collapse
  // into one value, and epoch is the fence on every plane that carries it.
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse a v0.4 endpoint-surface subject into its typed shape, or `null` for anything that is not
 * one — including the retired v0 `ctl.>`/`control.>` planes, which this parser deliberately does
 * not know. `null` means the subject has no sender and MUST NOT be handled (§13.2).
 */
export function parseEpSubject(subject: string): ParsedEp | null {
  if (new TextEncoder().encode(subject).length > MAX_EP_SUBJECT_BYTES) return null;
  const parts = subject.split(".");
  if (parts[0] !== ROOT || parts.length < 4) return null; // cotal.<space>.<plane>.…
  const plane = parts[2];

  if (plane === "ep") {
    const route = parts[3];
    if (route === "one" || route === "all") {
      if (parts.length < 10) return null;
      const tail = parseTail(parts, 6, true);
      if (!tail) return null;
      return { plane: "request", route, endpoint: endpointNameOf(parts[4]), command: parts[5], target: tail.target, caller: tail.caller, nonce: tail.nonce! };
    }
    if (route === "inst") {
      if (parts.length < 11) return null;
      const tail = parseTail(parts, 7, true);
      if (!tail) return null;
      return { plane: "request", route, endpoint: endpointNameOf(parts[4]), instanceId: parts[5], command: parts[6], target: tail.target, caller: tail.caller, nonce: tail.nonce! };
    }
    if (route === "reply") {
      if (parts.length !== 11) return null;
      const epoch = parseEpoch(parts[6]);
      if (epoch === null) return null;
      return { plane: "reply", endpoint: endpointNameOf(parts[4]), instanceId: parts[5], epoch, caller: { owner: parts[7], actor: parts[8], uid: parts[9] }, nonce: parts[10] };
    }
    return null;
  }

  if (plane === "epe") {
    if (parts.length < 7) return null;
    const epoch = parseEpoch(parts[5]);
    if (epoch === null) return null;
    return { plane: "event", endpoint: endpointNameOf(parts[3]), instanceId: parts[4], epoch, topic: parts.slice(6) };
  }
  if (plane === "epf") {
    if (parts.length < 5) return null;
    return { plane: "fact", endpoint: endpointNameOf(parts[3]), topic: parts.slice(4) };
  }
  if (plane === "epj") {
    if (parts.length < 8) return null;
    const tail = parseTail(parts, 5, false);
    if (!tail) return null;
    return { plane: "journal", endpoint: endpointNameOf(parts[3]), command: parts[4], target: tail.target, caller: tail.caller };
  }
  if (plane === "ept") {
    if (parts.length !== 8) return null;
    const epoch = parseEpoch(parts[5]);
    const phase = parts[7];
    if (epoch === null || (phase !== "schedule" && phase !== "armed" && phase !== "fire")) return null;
    return { plane: "timer", endpoint: endpointNameOf(parts[3]), instanceId: parts[4], epoch, timerId: parts[6], phase };
  }
  if (plane === "epr") {
    if (parts.length < 7) return null;
    const epoch = parseEpoch(parts[5]);
    if (epoch === null) return null;
    return { plane: "record", endpoint: endpointNameOf(parts[3]), instanceId: parts[4], epoch, kind: parts[6], qualifier: parts.slice(7) };
  }
  if (plane === "epc") {
    if (parts.length !== 4 || !DIGEST_HEX.test(parts[3])) return null;
    return { plane: "contract", digestHex: parts[3] };
  }
  if (plane === "epw") {
    if (parts.length !== 9) return null;
    return { plane: "work", endpoint: endpointNameOf(parts[3]), pool: parts[4], acceptance: { owner: parts[5], actor: parts[6], uid: parts[7], id: parts[8] } };
  }
  if (plane === "eps") {
    if (parts.length !== 7) return null;
    const epoch = parseEpoch(parts[5]);
    const dir = parts[6];
    if (epoch === null || (dir !== "in" && dir !== "out")) return null;
    return { plane: "session", endpoint: endpointNameOf(parts[3]), sessionId: parts[4], epoch, dir };
  }
  return null;
}

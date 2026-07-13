/**
 * The CAPABILITY HANDLE (SPEC §13.6): the one passable reference type — a signed JSON grant,
 * RFC 8785 canonical, Ed25519-signed by a key in the trust-anchor registry (§13.10).
 *
 * This module owns the transport-thin CORE of the handle: the artifact shape + closed-tuple
 * validation, the NORMATIVE COMPILER (a grant entry → exactly the subjects the equivalent
 * minted capability would receive, never wider — reads and instance rails included, every
 * present signed component consumed), the ATTENUATION CONTAINMENT ORDER (a child handle MUST
 * be ⊆ its parent), and CHAIN VERIFICATION (walk every parentDigest link to a registered
 * anchor, fail closed on widening / unknown / revoked / expiry). Conferral — REDEMPTION
 * through the trusted auth path, which fresh-checks the target triple against the current
 * mapping and mints a ledgered short-lived credential — is the §9/§10 exchange's job (the D14
 * auth-path slice); a handle grants NO broker reach here, only narrows.
 *
 * Verification discipline (§13.10 D28): the signature and the parentDigest identity are
 * checked over the EXACT RAW presented artifacts, never a reconstructed projection — the
 * parsed projection is for SEMANTICS only. Issuer authority is the anchor's STRUCTURED
 * `handles` scope (ceiling entries in the handle-grant shape itself); coverage is the SAME
 * §13.6 containment order (`handle.grants ⊆ anchor.scope`). A child link's issuer key must be
 * lifecycle-bound to the parent's holder (owner text alone would let a recycled alias issue
 * off its predecessor's handles). Every link — not only the leaf — is currency-checked
 * (window, TTL ceilings clock-anchored at `now`, live-epoch), sturdy revocation is
 * strict-`false`-only (an unreadable status is REVOKED), and the whole walk is bounded
 * (chain length + per-await budget).
 *
 * Two uses, both fail-closed: ATTENUATION (presented in the `auth` slot — the handler enforces
 * effective = presenter-cred ∩ handle.grants ∩ issuer-authority, never conferring reach) and
 * CONFERRAL (redemption). Both rest on the same containment + chain verification here.
 */
import { contractDigest, isContractDigest, canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { assertBoundedOwner, assertLifecycleToken, assertCommandToken, endpointToken, EP_AUTHZ_MODES, type EpTarget, type EpAuthzMode } from "./endpoint-subjects.js";
import type { EpCapability } from "./endpoint-grants.js";
import { verifyArtifactSignature, resolveAnchorForUse, type AnchorResolver, type SignerAnchor } from "./endpoint-signing.js";

/** A per-command target tuple inside a grant entry — a CLOSED set of three legal shapes
 *  (§13.6): no components; `targetOwner` alone; or the full triple. Every other combination is
 *  schema-invalid ({@link parseGrantCommand} enforces it). */
export interface HandleGrantCommand {
  name: string;
  /** The authorization mode, meaningful only for an owner-domain entry (`owner`|`child`|`ledger`;
   *  `any` is schema-invalid in a handle; default `owner`). Schema-invalid on a no-target entry
   *  and on an actor-pinned entry (the triple IS the mode). */
  authz?: "owner" | "child" | "ledger";
  targetOwner?: string;
  targetActor?: string;
  targetLifecycleUid?: string;
}

/** One grant entry: a set of commands on one endpoint (optionally one instance), plus read
 *  subtrees. Every present signed component MUST be consumed by the compile target. */
export interface HandleGrant {
  endpoint: string;
  instanceId?: string;
  commands: HandleGrantCommand[];
  reads?: string[];
}

/** The §13.6 handle artifact (signed envelope; `sig` over the sig-absent RFC 8785 form). */
export interface CapabilityHandle {
  v: 1;
  id: string;
  space: string;
  issuer: { keyId: string };
  holder: { id: string; lifecycleUid: string };
  grants: HandleGrant[];
  iat: number;
  nbf?: number;
  exp: number;
  parentDigest?: string;
  sturdy: boolean;
  /** Present iff a LIVE handle (`sturdy: false`) — binds the current process epoch. */
  epoch?: number;
  sig: string;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function invalid(what: string): never { throw new EpEnvelopeError("contract-invalid", `${what} (SPEC 13.6 capability handle)`); }

/** The §13.6 default validity ceilings (space-configurable): live ≤ 24h, sturdy default 30d. */
export const HANDLE_MAX_LIVE_TTL_MS = 24 * 60 * 60 * 1000;
export const HANDLE_MAX_STURDY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Verification bound: the longest presentable attenuation chain. */
export const HANDLE_MAX_CHAIN_LENGTH = 16;

function parseGrantCommand(raw: unknown): HandleGrantCommand {
  if (!isRec(raw)) invalid("a grant command is not an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["name", "authz", "targetOwner", "targetActor", "targetLifecycleUid"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) invalid(`a grant command carries the unknown field "${k}" (closed schema)`);
  if (typeof o.name !== "string") invalid("a grant command has no string name");
  assertCommandToken(o.name);
  const hasOwner = o.targetOwner !== undefined, hasActor = o.targetActor !== undefined, hasUid = o.targetLifecycleUid !== undefined;
  const hasAuthz = o.authz !== undefined;
  // The closed set of three target shapes (§13.6). The parsed projection stays BYTE-FAITHFUL
  // to the signed form (no default injection — `authz ?? "owner"` applies at USE time), so the
  // projection can never diverge from the D28 signature input.
  if (!hasOwner && !hasActor && !hasUid) {
    // NO-TARGET: an `authz` field is schema-invalid.
    if (hasAuthz) invalid(`command "${o.name}" is a no-target entry but carries authz (schema-invalid: a no-target entry compiles to the untargeted/self form)`);
    return { name: o.name };
  }
  if (hasOwner && !hasActor && !hasUid) {
    // OWNER-DOMAIN: authz names owner|child|ledger (default owner); `any` is schema-invalid.
    if (typeof o.targetOwner !== "string") invalid(`command "${o.name}" targetOwner is not a string`);
    assertBoundedOwner(o.targetOwner, `command "${o.name}" targetOwner`);
    if (hasAuthz && o.authz !== "owner" && o.authz !== "child" && o.authz !== "ledger")
      invalid(`command "${o.name}" authz "${String(o.authz)}" is not owner|child|ledger ("any" is operator-ceiling authority, never conferred through a handle)`);
    return { name: o.name, ...(hasAuthz ? { authz: o.authz as "owner" | "child" | "ledger" } : {}), targetOwner: o.targetOwner };
  }
  if (hasOwner && hasActor && hasUid) {
    // ACTOR-PINNED FULL TRIPLE: `authz` is schema-invalid (the triple IS the mode).
    if (hasAuthz) invalid(`command "${o.name}" pins the full target triple but also carries authz (schema-invalid: the triple IS the handle mode)`);
    if (typeof o.targetOwner !== "string" || typeof o.targetActor !== "string" || typeof o.targetLifecycleUid !== "string")
      invalid(`command "${o.name}" target triple components must all be strings`);
    assertBoundedOwner(o.targetOwner, `command "${o.name}" targetOwner`);
    assertBoundedOwner(o.targetActor, `command "${o.name}" targetActor`);
    assertLifecycleToken(o.targetLifecycleUid, `command "${o.name}" targetLifecycleUid`);
    return { name: o.name, targetOwner: o.targetOwner, targetActor: o.targetActor, targetLifecycleUid: o.targetLifecycleUid };
  }
  // Every other combination is schema-invalid — in particular a partial tuple never weakens
  // into a broader one (§13.6): targetActor without targetLifecycleUid, or targetLifecycleUid
  // without targetActor, or owner+actor without uid.
  invalid(`command "${o.name}" has a partial target tuple (${[hasOwner && "owner", hasActor && "actor", hasUid && "uid"].filter(Boolean).join("+")}); the legal shapes are no components, targetOwner alone, or the full triple — a partial tuple never weakens into a broader grant`);
}

/** A read scope names an exact record-key or event-topic SUBTREE (§13.6): dot-separated
 *  non-empty literal tokens, never a wildcard — the subtree semantics live in the containment
 *  order (dot-prefix), not in the entry. */
function assertReadSubtree(r: unknown, endpoint: string): string {
  if (typeof r !== "string" || r.length === 0) invalid(`grant entry for "${endpoint}" has a non-string read scope`);
  const tokens = r.split(".");
  if (tokens.some((t) => t.length === 0 || t === "*" || t === ">" || /\s/.test(t)))
    invalid(`grant entry for "${endpoint}" read scope "${r}" is not a literal dot-token subtree (no wildcards, no empty tokens)`);
  return r;
}

function parseGrant(raw: unknown): HandleGrant {
  if (!isRec(raw)) invalid("a grant entry is not an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["endpoint", "instanceId", "commands", "reads"].includes(k)) invalid(`a grant entry carries the unknown field "${k}"`);
  if (typeof o.endpoint !== "string") invalid("a grant entry has no string endpoint");
  endpointToken(o.endpoint);
  if (o.instanceId !== undefined) assertLifecycleToken(o.instanceId as string, "grant instanceId");
  if (!Array.isArray(o.commands) || o.commands.length === 0) invalid(`grant entry for "${o.endpoint}" has no commands`);
  const commands = o.commands.map(parseGrantCommand);
  let reads: string[] | undefined;
  if (o.reads !== undefined) {
    if (!Array.isArray(o.reads)) invalid(`grant entry for "${o.endpoint}" has a non-array reads`);
    reads = o.reads.map((r) => assertReadSubtree(r, o.endpoint as string));
  }
  return { endpoint: o.endpoint, ...(o.instanceId !== undefined ? { instanceId: o.instanceId as string } : {}), commands, ...(reads !== undefined ? { reads } : {}) };
}

/** Validate a handle artifact's SHAPE (the closed-tuple rules + envelope), returning the typed
 *  frozen handle. This is the schema step; signature + chain + currency are the verify step
 *  ({@link verifyHandleChain}) — and those verify the RAW presented artifact, never this
 *  projection. A `sturdy: false` handle MUST carry `epoch`; a `sturdy: true` handle MUST NOT
 *  (§13.6: live binds the process epoch, sturdy binds the lifecycle UID). */
export function parseHandle(raw: unknown): CapabilityHandle {
  if (!isRec(raw)) invalid("the handle is not an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "id", "space", "issuer", "holder", "grants", "iat", "nbf", "exp", "parentDigest", "sturdy", "epoch", "sig"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) invalid(`the handle carries the unknown field "${k}" (closed envelope)`);
  if (o.v !== 1) invalid("the handle version is not 1");
  if (typeof o.id !== "string" || o.id.length === 0) invalid("the handle has no id");
  if (typeof o.space !== "string" || o.space.length === 0) invalid("the handle has no space");
  if (!isRec(o.issuer) || typeof (o.issuer as Record<string, unknown>).keyId !== "string") invalid("the handle issuer has no keyId");
  if (!isRec(o.holder) || typeof (o.holder as Record<string, unknown>).id !== "string" || typeof (o.holder as Record<string, unknown>).lifecycleUid !== "string")
    invalid("the handle holder is not a {id, lifecycleUid}");
  if (!Array.isArray(o.grants) || o.grants.length === 0) invalid("the handle has no grants");
  const grants = o.grants.map(parseGrant);
  for (const f of ["iat", "exp"]) if (typeof o[f] !== "number" || !Number.isSafeInteger(o[f]) || (o[f] as number) < 0) invalid(`the handle ${f} is not a non-negative safe integer`);
  if (o.nbf !== undefined && (typeof o.nbf !== "number" || !Number.isSafeInteger(o.nbf) || o.nbf < 0)) invalid("the handle nbf is not a non-negative safe integer");
  if ((o.exp as number) <= (o.iat as number)) invalid("the handle exp is not after iat");
  if (o.nbf !== undefined && (o.nbf as number) > (o.exp as number)) invalid("the handle nbf is after exp (an empty validity window is garbled, not a short one)");
  if (o.parentDigest !== undefined && (typeof o.parentDigest !== "string" || !isContractDigest(o.parentDigest))) invalid("the handle parentDigest is not a sha256 digest");
  if (typeof o.sturdy !== "boolean") invalid("the handle sturdy flag is not a boolean");
  if (o.sturdy === false && (typeof o.epoch !== "number" || !Number.isSafeInteger(o.epoch) || o.epoch < 0)) invalid("a LIVE handle (sturdy:false) MUST carry a non-negative integer epoch (it binds the process epoch)");
  if (o.sturdy === true && o.epoch !== undefined) invalid("a STURDY handle MUST NOT carry epoch (it binds the lifecycle UID, not a process epoch)");
  if (typeof o.sig !== "string") invalid("the handle has no sig");
  return Object.freeze({
    v: 1, id: o.id as string, space: o.space as string, issuer: { keyId: (o.issuer as { keyId: string }).keyId },
    holder: { id: (o.holder as { id: string }).id, lifecycleUid: (o.holder as { lifecycleUid: string }).lifecycleUid },
    grants, iat: o.iat as number, ...(o.nbf !== undefined ? { nbf: o.nbf as number } : {}), exp: o.exp as number,
    ...(o.parentDigest !== undefined ? { parentDigest: o.parentDigest as string } : {}), sturdy: o.sturdy as boolean,
    ...(o.epoch !== undefined ? { epoch: o.epoch as number } : {}), sig: o.sig as string,
  }) as CapabilityHandle;
}

/** The handle's content address (`sha256:<hex>` over the full artifact incl. `sig`) — the
 *  identity a child's `parentDigest` references. Chain verification computes this over the
 *  RAW presented artifact ({@link verifyHandleChain}); this export is for issuance (building
 *  a child's `parentDigest` from the parent artifact you hold). */
export function handleDigest(handle: CapabilityHandle): string {
  return contractDigest(handle);
}

// ---- the normative compiler (§13.6: grant entry → the subjects an equivalent mint receives) --

/** Compile ONE grant command to the {@link EpTarget} the equivalent minted capability carries
 *  (never wider): a no-target command → no target; an owner-domain command → its authz mode
 *  pinning `targetOwner`; an actor-pinned command → `handle`-mode with the verified triple.
 *  Every present signed component is consumed (a component the target cannot express was
 *  already refused as schema-invalid at parse). */
function compileTarget(cmd: HandleGrantCommand): EpTarget | undefined {
  if (cmd.targetOwner === undefined) return undefined; // no-target → untargeted/self per the command's contract
  if (cmd.targetActor !== undefined && cmd.targetLifecycleUid !== undefined)
    return { mode: "handle", tOwner: cmd.targetOwner, tActor: cmd.targetActor, tUid: cmd.targetLifecycleUid };
  return { mode: (cmd.authz ?? "owner") as "owner" | "child" | "ledger", tOwner: cmd.targetOwner };
}

/** The compiled equivalent-mint bundle: the request capabilities PLUS the read subtrees. Both
 *  halves are signed components; neither is ever silently dropped. */
export interface CompiledHandleGrants {
  caps: EpCapability[];
  /** The signed read subtrees (record-key / event-topic prefixes), deduplicated — the
   *  redemption mints these as read rows exactly as signed. */
  reads: string[];
}

/** Compile a handle's grants to the EpCapability set + read subtrees the equivalent minted
 *  capability would receive (§13.6). This is what a redemption mints and what attenuation
 *  intersects against; it NEVER widens and consumes EVERY signed component:
 *   - `routes` is set EXPLICITLY: an instance entry compiles to the exact `ep.inst` rails
 *     ONLY (`routes: []` — an instance pin never also grants the class rail); a class entry
 *     compiles to `routes: ["one"]` (scatter `all` is not expressible in a handle);
 *   - `journal` is set from the command's contract class via the REQUIRED `isJournalCommand`
 *     seam (the compiler is transport-thin and never guesses a class);
 *   - `reads` are returned alongside, never dropped. */
export function compileHandleGrants(
  handle: CapabilityHandle,
  opts: { isJournalCommand: (endpoint: string, command: string) => boolean },
): CompiledHandleGrants {
  if (typeof opts?.isJournalCommand !== "function")
    throw new EpEnvelopeError("failed-precondition", "compiling handle grants requires the command-class seam (isJournalCommand); the compiler never guesses whether a command submits via the journal (SPEC 13.6/13.9)");
  const caps: EpCapability[] = [];
  const reads: string[] = [];
  for (const g of handle.grants) {
    for (const cmd of g.commands) {
      const journal = opts.isJournalCommand(g.endpoint, cmd.name);
      if (typeof journal !== "boolean")
        throw new EpEnvelopeError("internal", `the command-class seam returned ${JSON.stringify(journal)} for ${g.endpoint}.${cmd.name}; a non-boolean class never compiles (SPEC 13.6)`);
      const target = compileTarget(cmd);
      caps.push({
        endpoint: g.endpoint, command: cmd.name,
        routes: g.instanceId !== undefined ? [] : ["one"],
        ...(g.instanceId !== undefined ? { instanceId: g.instanceId } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(journal ? { journal: true } : {}),
      });
    }
    for (const r of g.reads ?? []) if (!reads.includes(r)) reads.push(r);
  }
  return { caps, reads };
}

// ---- the attenuation containment order (§13.6: a child MUST be ⊆ its parent) ------------------

/** The command-mode lattice `self < owner < any`; `child`/`ledger`/`handle` are grantable in a
 *  child ONLY where the parent names the SAME mode (they are distinct validator-primary rails,
 *  never a widening of `owner`). */
const MODE_RANK: Record<EpAuthzMode, number> = { self: 0, owner: 1, child: 1, ledger: 1, handle: 1, any: 2 };

function modeOf(cmd: HandleGrantCommand): EpAuthzMode {
  if (cmd.targetOwner === undefined) return "self"; // no-target ~ self/untargeted floor
  if (cmd.targetActor !== undefined) return "handle";
  return (cmd.authz ?? "owner") as EpAuthzMode;
}

/** True iff a child command mode is ⊆ a parent command mode under the §13.6 order: never higher
 *  in `self < owner < any`, and `child`/`ledger`/`handle` only where the parent names the SAME
 *  mode. */
function modeContained(childMode: EpAuthzMode, parentMode: EpAuthzMode): boolean {
  if (childMode === parentMode) return true;
  if (childMode === "child" || childMode === "ledger" || childMode === "handle") return false; // distinct rails: only same-mode
  if (parentMode === "child" || parentMode === "ledger" || parentMode === "handle") return false; // a distinct-rail parent confers only itself
  return MODE_RANK[childMode] <= MODE_RANK[parentMode];
}

function targetComponentsContained(child: HandleGrantCommand, parent: HandleGrantCommand): boolean {
  // Each present PARENT component must be equal in the child; the child may NEWLY PIN a
  // component the parent left open, never widen a pinned one to absent.
  for (const f of ["targetOwner", "targetActor", "targetLifecycleUid"] as const)
    if (parent[f] !== undefined && parent[f] !== child[f]) return false;
  return true;
}

function readsContained(childReads: string[] | undefined, parentReads: string[] | undefined): boolean {
  if (childReads === undefined || childReads.length === 0) return true;
  const parents = parentReads ?? [];
  // Every child subtree must be subject-prefix-contained in some parent subtree (equal, or a
  // strict `.`-delimited descendant — never a token-boundary-crossing string prefix).
  return childReads.every((cr) => parents.some((pr) => cr === pr || cr.startsWith(pr + ".")));
}

/** The per-grant-entry half of the §13.6 containment order, shared by attenuation (child ⊆
 *  parent) and issuer-scope coverage (handle.grants ⊆ anchor.scope). Returns the FIRST
 *  widening as a why-string, or undefined when contained. */
function grantWidens(cg: HandleGrant, ceiling: HandleGrant[]): string | undefined {
  const pg = ceiling.find((p) => p.endpoint === cg.endpoint);
  if (pg === undefined) return `endpoint "${cg.endpoint}" is not granted`;
  if (pg.instanceId !== undefined && pg.instanceId !== cg.instanceId) return `endpoint "${cg.endpoint}" instance ${cg.instanceId ?? "(absent)"} != the pinned ${pg.instanceId}`;
  if (!readsContained(cg.reads, pg.reads)) return `endpoint "${cg.endpoint}" reads are not subtree-contained`;
  for (const cc of cg.commands) {
    const pc = pg.commands.find((p) => p.name === cc.name);
    if (pc === undefined) return `command "${cg.endpoint}.${cc.name}" is not granted`;
    if (!modeContained(modeOf(cc), modeOf(pc))) return `command "${cg.endpoint}.${cc.name}" mode ${modeOf(cc)} is not ⊆ ${modeOf(pc)}`;
    if (!targetComponentsContained(cc, pc)) return `command "${cg.endpoint}.${cc.name}" target components widen the granted ones`;
  }
  return undefined;
}

/** Assert a CHILD handle is ⊆ its PARENT under the §13.6 normative containment order. Per grant
 *  entry: endpoint equal (domain patterns are a future extension; this revision pins exact
 *  endpoints); `instanceId` equal or newly pinned (never widened to absent); commands a
 *  name-subset with per-command mode contained and target components equal-or-newly-pinned;
 *  reads subject-prefix-contained. Per envelope: same space; validity window within the
 *  parent's; `sturdy` only if the parent is sturdy. Throws `permission-denied` on any widening. */
export function assertHandleContainedIn(child: CapabilityHandle, parent: CapabilityHandle): void {
  const deny = (why: string): never => { throw new EpEnvelopeError("permission-denied", `handle "${child.id}" widens its parent "${parent.id}": ${why} (SPEC 13.6 containment: a child MUST be ⊆ its parent)`); };
  if (child.space !== parent.space) deny(`space ${child.space} != ${parent.space}`);
  if (child.exp > parent.exp) deny(`exp ${child.exp} exceeds the parent's ${parent.exp}`);
  const childNbf = child.nbf ?? child.iat, parentNbf = parent.nbf ?? parent.iat;
  if (childNbf < parentNbf) deny(`validity starts (${childNbf}) before the parent's (${parentNbf})`);
  if (child.sturdy && !parent.sturdy) deny("a sturdy child cannot descend from a live parent");
  for (const cg of child.grants) {
    const widens = grantWidens(cg, parent.grants);
    if (widens !== undefined) deny(widens);
  }
}

// ---- issuer authority: the anchor's STRUCTURED handles scope (§13.10) -------------------------

/** Parse an anchor's `handles`-role scope: each entry is a canonical-JSON-encoded
 *  {@link HandleGrant} ceiling — "the full grant dimensions, in the handle-grant shape itself"
 *  (§13.10). An absent/empty dimension is CLOSED; a garbled entry never widens into an open
 *  ceiling. */
function parseAnchorHandleScope(anchor: SignerAnchor): HandleGrant[] {
  const entries = anchor.scope?.handles;
  if (entries === undefined || entries.length === 0)
    throw new EpEnvelopeError("permission-denied", `signing key ${anchor.keyId} carries the "handles" role with no scope ceiling; an absent dimension is closed, not open (SPEC 13.10)`);
  return entries.map((e) => {
    let raw: unknown;
    try { raw = JSON.parse(e); } catch { throw new EpEnvelopeError("permission-denied", `signing key ${anchor.keyId} has a garbled handles-scope entry (not JSON); an unreadable ceiling never authorizes (SPEC 13.10)`); }
    try { return parseGrant(raw); } catch (err) {
      throw new EpEnvelopeError("permission-denied", `signing key ${anchor.keyId} has a garbled handles-scope entry (${(err as Error).message}); an unreadable ceiling never authorizes (SPEC 13.10)`);
    }
  });
}

/** Enforce §13.10 issuer authority for one handle: `handle.grants ⊆ anchor.scope` under the
 *  SAME §13.6 containment order — endpoints, per-command modes, target components, instance
 *  pins, and read subtrees are all ceiling dimensions; a flat endpoint/command list cannot
 *  express them and is exactly the laundering this refuses. */
export function assertIssuerScopeCoversHandle(anchor: SignerAnchor, handle: CapabilityHandle): void {
  const ceiling = parseAnchorHandleScope(anchor);
  for (const g of handle.grants) {
    const widens = grantWidens(g, ceiling);
    if (widens !== undefined)
      throw new EpEnvelopeError("permission-denied", `signing key ${anchor.keyId}'s handles scope does not cover handle "${handle.id}": ${widens} (SPEC 13.10/13.6: handle.grants ⊆ anchor.scope, containment never widening)`);
  }
}

// ---- chain verification (§13.6: walk every link to a registered anchor, fail closed) ---------

/** The revocation reader for STURDY handles: the `handle.<issuerKeyId>.<id>` record's status
 *  side (monotonic revocation state, §13.9). ONLY the literal `false` means "not revoked":
 *  `true`, `undefined`, or an unreadable status all FAIL CLOSED as revoked. */
export type HandleRevocationReader = (issuerKeyId: string, id: string) => Promise<boolean> | boolean;

/** Race an await against the verification budget: a stuck registry/revocation authority is a
 *  bounded `unavailable` refusal, never a hung verification. Races `Promise.resolve(p)`
 *  unconditionally (a non-native thenable must not bypass the deadline). */
async function withVerifyBudget<T>(p: Promise<T> | T, budgetMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EpEnvelopeError("unavailable", `${what} did not answer within ${budgetMs}ms; verification is bounded and fails closed (SPEC 13.10)`)), budgetMs);
  });
  try { return await Promise.race([Promise.resolve(p), deadline]); } finally { clearTimeout(timer); }
}

/** Verify a presented handle CHAIN inline (§13.6): the leaf plus every `parentDigest`-linked
 *  ancestor, presented together (no ambient fetch). Signature and digest identity are checked
 *  over the EXACT RAW presented artifacts (D28), never the parsed projection. For each link,
 *  leaf to root:
 *   - its `parentDigest` (if any) equals the digest of the NEXT presented RAW artifact (the
 *     chain is the one presented, not a forgeable claim);
 *   - each child is ⊆ its parent ({@link assertHandleContainedIn});
 *   - the ISSUER of a child is the PARENT's holder — anchor-registered with a `handles` role
 *     whose STRUCTURED scope covers the link ({@link assertIssuerScopeCoversHandle}) AND
 *     lifecycle-bound to the parent's holder (`ownerLifecycleUid`; owner text alone would let
 *     a recycled alias issue off its predecessor's handles — absent binding fails closed);
 *   - the signature verifies against the resolved anchor, within the anchor's window;
 *   - EVERY link is currency-checked: window (`nbf ≤ now ≤ exp`), no future `iat`, TTL span
 *     within the live/sturdy ceiling AND `exp ≤ now + ceiling` (clock-anchored: a backdated
 *     `nbf`/forward-dated `iat` cannot manufacture validity beyond the ceiling), space match;
 *   - EVERY sturdy link's revocation status is strict-`false`-checked (unreadable = revoked);
 *   - a LIVE leaf binds `presenterEpoch`; a LIVE ANCESTOR requires `resolveHolderEpoch` to
 *     fresh-check ITS holder's current epoch (a restarted intermediate kills the chain).
 *  The walk is bounded: chain length ≤ {@link HANDLE_MAX_CHAIN_LENGTH}, every await within
 *  `verifyBudgetMs` (default 5000). A ROOT handle (no parentDigest) is issued by an anchor
 *  whose owner is the handle's issuer principal. Returns the leaf and its compiled
 *  equivalent-mint bundle (never wider than any ancestor). */
export async function verifyHandleChain(
  chain: unknown[],
  opts: {
    resolveAnchor: AnchorResolver;
    now: number;
    space: string;
    presenter: { id: string; lifecycleUid: string; epoch?: number };
    readRevocation: HandleRevocationReader;
    /** The command-class seam the compiled bundle needs ({@link compileHandleGrants}). */
    isJournalCommand: (endpoint: string, command: string) => boolean;
    /** REQUIRED when the chain contains a LIVE non-leaf link: the link holder's CURRENT
     *  process epoch from trusted authority (null = retired/unknown). */
    resolveHolderEpoch?: (holder: { id: string; lifecycleUid: string }) => Promise<number | null> | number | null;
    maxLiveTtlMs?: number;
    maxSturdyTtlMs?: number;
    verifyBudgetMs?: number;
  },
): Promise<{ leaf: CapabilityHandle; compiled: CompiledHandleGrants }> {
  if (!Array.isArray(chain) || chain.length === 0)
    throw new EpEnvelopeError("permission-denied", "a handle chain is empty (SPEC 13.6: present the leaf plus every ancestor inline)");
  if (chain.length > HANDLE_MAX_CHAIN_LENGTH)
    throw new EpEnvelopeError("permission-denied", `the presented chain has ${chain.length} links; verification is bounded at ${HANDLE_MAX_CHAIN_LENGTH} (SPEC 13.6)`);
  if (!Number.isSafeInteger(opts.now) || opts.now < 0)
    throw new EpEnvelopeError("failed-precondition", `now must be a non-negative safe integer; got ${JSON.stringify(opts.now)}`);
  const budget = opts.verifyBudgetMs ?? 5_000;
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new EpEnvelopeError("failed-precondition", `verifyBudgetMs must be a positive integer; got ${JSON.stringify(opts.verifyBudgetMs)}`);
  const raws = chain.map((r) => { if (!isRec(r)) invalid("a chain element is not an object"); return r; });
  const handles = raws.map(parseHandle);
  const leaf = handles[0];

  // The presented chain must be leaf → … → root by parentDigest identity over the RAW
  // artifacts (no ambient fetch, no forgeable parent claim, no reconstructed projection).
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    const rawParent = raws[i + 1];
    if (h.parentDigest === undefined) {
      if (rawParent !== undefined)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" is a root (no parentDigest) but the chain presents further ancestors; a chain must terminate at its root (SPEC 13.6)`);
    } else {
      if (rawParent === undefined)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" names a parentDigest but no parent is presented; chains are presented inline in full (SPEC 13.6)`);
      if (contractDigest(rawParent) !== h.parentDigest)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" parentDigest does not match the presented parent "${handles[i + 1].id}" (SPEC 13.6: the chain is the one presented, not a claim)`);
    }
  }

  // Leaf holder binding (the presenter IS the leaf's holder).
  if (leaf.holder.id !== opts.presenter.id || leaf.holder.lifecycleUid !== opts.presenter.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", `handle "${leaf.id}" is holder-bound to ${leaf.holder.id}/${leaf.holder.lifecycleUid}; the presenter ${opts.presenter.id}/${opts.presenter.lifecycleUid} is not the holder — a recycled alias cannot present its predecessor's handles (SPEC 13.6)`);

  // Walk every link: currency, containment, issuer authority, signature, revocation.
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    const parent = handles[i + 1];

    // Per-link currency (§13.6: expiry/ceilings fail closed on EVERY link, not only the leaf).
    if (h.space !== opts.space)
      throw new EpEnvelopeError("permission-denied", `handle "${h.id}" is bound to space ${h.space}, not ${opts.space} (SPEC 13.6)`);
    const nbf = h.nbf ?? h.iat;
    if (opts.now < nbf || opts.now > h.exp)
      throw new EpEnvelopeError("permission-denied", `handle "${h.id}" is outside its validity window [${nbf}, ${h.exp}] at now ${opts.now} (SPEC 13.6: expiry fails closed on every link)`);
    if (h.iat > opts.now)
      throw new EpEnvelopeError("permission-denied", `handle "${h.id}" claims a FUTURE signing time (iat ${h.iat} > now ${opts.now}); a forward-dated artifact never verifies (SPEC 13.10)`);
    const ttlCeiling = h.sturdy ? (opts.maxSturdyTtlMs ?? HANDLE_MAX_STURDY_TTL_MS) : (opts.maxLiveTtlMs ?? HANDLE_MAX_LIVE_TTL_MS);
    if (h.exp - Math.min(h.iat, nbf) > ttlCeiling)
      throw new EpEnvelopeError("permission-denied", `handle "${h.id}" validity span ${h.exp - Math.min(h.iat, nbf)}ms exceeds the ${h.sturdy ? "sturdy" : "live"} ceiling ${ttlCeiling}ms (SPEC 13.6)`);
    if (h.exp > opts.now + ttlCeiling)
      throw new EpEnvelopeError("permission-denied", `handle "${h.id}" remains valid ${h.exp - opts.now}ms past now, beyond the clock-anchored ${h.sturdy ? "sturdy" : "live"} ceiling ${ttlCeiling}ms; a dated-in-the-future artifact cannot outlive its ceiling (SPEC 13.6)`);
    if (!h.sturdy) {
      if (i === 0) {
        if (h.epoch !== opts.presenter.epoch)
          throw new EpEnvelopeError("permission-denied", `live handle "${h.id}" binds process epoch ${h.epoch}; the presenter epoch is ${opts.presenter.epoch} (live authority dies on restart, SPEC 13.1/13.6)`);
      } else {
        // A LIVE ANCESTOR binds ITS holder's process epoch: fresh-check it (a restarted
        // intermediate kills every descendant, exactly like a revoked sturdy ancestor).
        if (typeof opts.resolveHolderEpoch !== "function")
          throw new EpEnvelopeError("failed-precondition", `the chain contains a LIVE ancestor ("${h.id}") but no resolveHolderEpoch seam was supplied; a live link's epoch currency is never assumed (SPEC 13.6)`);
        const current = await withVerifyBudget(opts.resolveHolderEpoch(h.holder), budget, `the holder-epoch resolver for "${h.id}"`);
        if (current !== null && (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0))
          throw new EpEnvelopeError("internal", `the holder-epoch resolver returned ${JSON.stringify(current)}; a non-integer epoch never authorizes (SPEC 13.6)`);
        if (current === null || current !== h.epoch)
          throw new EpEnvelopeError("permission-denied", `live ancestor "${h.id}" binds its holder's process epoch ${h.epoch} but the current epoch is ${current === null ? "retired/unknown" : current}; live authority dies on restart, on every link (SPEC 13.6)`);
      }
    }

    if (parent !== undefined) assertHandleContainedIn(h, parent);

    const anchor = await withVerifyBudget(
      resolveAnchorForUse(opts.resolveAnchor, { keyId: h.issuer.keyId, role: "handles", at: opts.now }),
      budget, `the anchor-registry read for ${h.issuer.keyId}`);
    // The issuer of a CHILD is the PARENT's holder — bound by LIFECYCLE, not owner text: a
    // recycled alias (same id, new lifecycleUid) re-registering a key must never issue off its
    // predecessor's handles. An anchor without the lifecycle binding fails closed here.
    if (parent !== undefined) {
      if (anchor.owner !== parent.holder.id)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" issuer key ${h.issuer.keyId} belongs to ${anchor.owner}, not the parent's holder ${parent.holder.id} (SPEC 13.6/13.10)`);
      if (anchor.ownerLifecycleUid === undefined)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" issuer key ${h.issuer.keyId} is not lifecycle-bound in the anchor registry; child issuance requires the key's owning lifecycle so a recycled alias cannot issue off its predecessor's handles (SPEC 13.6/13.10: fail closed)`);
      if (anchor.ownerLifecycleUid !== parent.holder.lifecycleUid)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" issuer key ${h.issuer.keyId} belongs to lifecycle ${anchor.ownerLifecycleUid}, not the parent holder's ${parent.holder.lifecycleUid}; a recycled alias cannot issue off its predecessor's handles (SPEC 13.6/13.10)`);
    }
    // A ROOT's issuer is the anchor's own owner (the root of trust): the handle carries no
    // separate issuer-principal claim, so the root binding IS the resolved key — handles-roled,
    // in-window, scope-covering; registry ownership semantics live in D18.
    // The issuer key's STRUCTURED handles scope must cover this link's full grant dimensions.
    assertIssuerScopeCoversHandle(anchor, h);
    // D28: the signature verifies over the EXACT RAW presented artifact, never a projection.
    verifyArtifactSignature(raws[i], anchor);

    if (h.sturdy) {
      const revoked = await withVerifyBudget(opts.readRevocation(h.issuer.keyId, h.id), budget, `the revocation read for "${h.id}"`);
      if (revoked !== false)
        throw new EpEnvelopeError("permission-denied", `a sturdy link in the chain is not provably unrevoked (handle "${h.id}", issuer ${h.issuer.keyId}, status ${JSON.stringify(revoked)}); ONLY a literal false is "not revoked" — an unreadable/undefined status fails closed, and every sturdy link is checked, not only the leaf (SPEC 13.6)`);
    }
  }

  return { leaf, compiled: compileHandleGrants(leaf, { isJournalCommand: opts.isJournalCommand }) };
}

/** Serialize a handle to its canonical bytes (the wire/store form). Throws if the artifact is
 *  not interchangeable I-JSON (the strict canonical path), so a non-canonicalizable handle can
 *  never be persisted or presented. The parsed projection is byte-faithful to the signed form
 *  (parse injects nothing and drops nothing), so these bytes re-verify. */
export function serializeHandle(handle: CapabilityHandle): Uint8Array {
  return new TextEncoder().encode(canonicalJson(handle));
}

// re-export so a caller can spell the modes without reaching into subjects
export { EP_AUTHZ_MODES };

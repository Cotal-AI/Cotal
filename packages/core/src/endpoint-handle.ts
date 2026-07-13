/**
 * The CAPABILITY HANDLE (SPEC §13.6): the one passable reference type — a signed JSON grant,
 * RFC 8785 canonical, Ed25519-signed by a key in the trust-anchor registry (§13.10).
 *
 * This module owns the transport-thin CORE of the handle: the artifact shape + closed-tuple
 * validation, the NORMATIVE COMPILER (a grant entry → exactly the subjects the equivalent
 * minted capability would receive, never wider), the ATTENUATION CONTAINMENT ORDER (a child
 * handle MUST be ⊆ its parent), and CHAIN VERIFICATION (walk every parentDigest link to a
 * registered anchor, fail closed on widening / unknown / revoked / expiry). Conferral —
 * REDEMPTION through the trusted auth path, which fresh-checks the target triple against the
 * current mapping and mints a ledgered short-lived credential — is the §9/§10 exchange's job
 * (the D14 auth-path slice); a handle grants NO broker reach here, only narrows.
 *
 * Two uses, both fail-closed: ATTENUATION (presented in the `auth` slot — the handler enforces
 * effective = presenter-cred ∩ handle.grants ∩ issuer-authority, never conferring reach) and
 * CONFERRAL (redemption). Both rest on the same containment + chain verification here.
 */
import { contractDigest, isContractDigest, canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { assertBoundedOwner, assertLifecycleToken, assertCommandToken, endpointToken, EP_AUTHZ_MODES, type EpTarget, type EpAuthzMode } from "./endpoint-subjects.js";
import type { EpCapability } from "./endpoint-grants.js";
import { verifyArtifactSignature, resolveAnchorForUse, assertAnchorScopeCovers, type AnchorResolver } from "./endpoint-signing.js";

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

function parseGrantCommand(raw: unknown): HandleGrantCommand {
  if (!isRec(raw)) invalid("a grant command is not an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["name", "authz", "targetOwner", "targetActor", "targetLifecycleUid"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) invalid(`a grant command carries the unknown field "${k}" (closed schema)`);
  if (typeof o.name !== "string") invalid("a grant command has no string name");
  assertCommandToken(o.name);
  const hasOwner = o.targetOwner !== undefined, hasActor = o.targetActor !== undefined, hasUid = o.targetLifecycleUid !== undefined;
  const hasAuthz = o.authz !== undefined;
  // The closed set of three target shapes (§13.6):
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
    return { name: o.name, authz: (o.authz as "owner" | "child" | "ledger" | undefined) ?? "owner", targetOwner: o.targetOwner };
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
    if (!Array.isArray(o.reads) || !o.reads.every((r) => typeof r === "string" && r.length > 0)) invalid(`grant entry for "${o.endpoint}" has a non-string-array reads`);
    reads = o.reads as string[];
  }
  return { endpoint: o.endpoint, ...(o.instanceId !== undefined ? { instanceId: o.instanceId as string } : {}), commands, ...(reads !== undefined ? { reads } : {}) };
}

/** Validate a handle artifact's SHAPE (the closed-tuple rules + envelope), returning the typed
 *  frozen handle. This is the schema step; signature + chain + currency are the verify step
 *  ({@link verifyHandleChain}). A `sturdy: false` handle MUST carry `epoch`; a `sturdy: true`
 *  handle MUST NOT (§13.6: live binds the process epoch, sturdy binds the lifecycle UID). */
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
 *  identity a child's `parentDigest` references. */
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

/** Compile a handle's grants to the EpCapability set the equivalent minted capability would
 *  receive (§13.6). This is what a redemption mints and what attenuation intersects against;
 *  it NEVER widens (a component the compile target cannot express is schema-invalid, refused at
 *  parse, never silently dropped). */
export function compileHandleGrants(handle: CapabilityHandle): EpCapability[] {
  const caps: EpCapability[] = [];
  for (const g of handle.grants)
    for (const cmd of g.commands)
      caps.push({
        endpoint: g.endpoint, command: cmd.name,
        ...(g.instanceId !== undefined ? { instanceId: g.instanceId } : {}),
        ...(compileTarget(cmd) !== undefined ? { target: compileTarget(cmd) } : {}),
      });
  return caps;
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
    const pg = parent.grants.find((p) => p.endpoint === cg.endpoint);
    if (pg === undefined) deny(`endpoint "${cg.endpoint}" is not in the parent`);
    if (pg!.instanceId !== undefined && pg!.instanceId !== cg.instanceId) deny(`endpoint "${cg.endpoint}" instance ${cg.instanceId ?? "(absent)"} != the parent's pinned ${pg!.instanceId}`);
    if (!readsContained(cg.reads, pg!.reads)) deny(`endpoint "${cg.endpoint}" reads are not subtree-contained in the parent's`);
    for (const cc of cg.commands) {
      const pc = pg!.commands.find((p) => p.name === cc.name);
      if (pc === undefined) deny(`command "${cg.endpoint}.${cc.name}" is not in the parent`);
      if (!modeContained(modeOf(cc), modeOf(pc!))) deny(`command "${cg.endpoint}.${cc.name}" mode ${modeOf(cc)} is not ⊆ the parent's ${modeOf(pc!)}`);
      if (!targetComponentsContained(cc, pc!)) deny(`command "${cg.endpoint}.${cc.name}" target components widen the parent's`);
    }
  }
}

// ---- chain verification (§13.6: walk every link to a registered anchor, fail closed) ---------

/** The revocation reader for STURDY handles: the `handle.<issuerKeyId>.<id>` record's status
 *  side (monotonic revocation state, §13.9). `true` = revoked, fail closed if unreadable
 *  (`undefined` MUST be treated as revoked by the caller's reader, never as "not revoked"). */
export type HandleRevocationReader = (issuerKeyId: string, id: string) => Promise<boolean> | boolean;

/** Verify a presented handle CHAIN inline (§13.6): the leaf plus every `parentDigest`-linked
 *  ancestor, presented together (no ambient fetch). For each link, in order from leaf to root:
 *   - its `parentDigest` (if any) equals the NEXT presented artifact's digest (the chain is the
 *     one presented, not a forgeable claim);
 *   - each child is ⊆ its parent ({@link assertHandleContainedIn});
 *   - the ISSUER of a child is the PARENT's holder, anchor-registered with a `handles` role
 *     whose scope covers the child (the same containment order defines issuer-scope coverage);
 *   - the signature verifies against the resolved anchor, within the anchor's window;
 *   - EVERY sturdy link's revocation status is checked (not only the leaf), failing closed on
 *     a revoked ancestor;
 *   - the handle's own window is current (`nbf ≤ now ≤ exp`), the TTL within the live/sturdy
 *     ceiling, the space matches, and (live) the holder epoch matches `presenterEpoch`.
 *  A ROOT handle (no parentDigest) is issued by an anchor whose owner is the handle's issuer
 *  principal — the issuer key is the root of trust, not a parent holder. Returns the compiled
 *  effective grants of the LEAF (never wider than any ancestor). */
export async function verifyHandleChain(
  chain: unknown[],
  opts: {
    resolveAnchor: AnchorResolver;
    now: number;
    space: string;
    presenter: { id: string; lifecycleUid: string; epoch?: number };
    readRevocation: HandleRevocationReader;
    maxLiveTtlMs?: number;
    maxSturdyTtlMs?: number;
  },
): Promise<{ leaf: CapabilityHandle; grants: EpCapability[] }> {
  if (!Array.isArray(chain) || chain.length === 0)
    throw new EpEnvelopeError("permission-denied", "a handle chain is empty (SPEC 13.6: present the leaf plus every ancestor inline)");
  const handles = chain.map(parseHandle);
  const leaf = handles[0];

  // The presented chain must be leaf → … → root by parentDigest identity (no ambient fetch,
  // no forgeable parent claim): each artifact's parentDigest equals the next's digest.
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    const parent = handles[i + 1];
    if (h.parentDigest === undefined) {
      if (parent !== undefined)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" is a root (no parentDigest) but the chain presents further ancestors; a chain must terminate at its root (SPEC 13.6)`);
    } else {
      if (parent === undefined)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" names a parentDigest but no parent is presented; chains are presented inline in full (SPEC 13.6)`);
      if (handleDigest(parent) !== h.parentDigest)
        throw new EpEnvelopeError("permission-denied", `handle "${h.id}" parentDigest does not match the presented parent "${parent.id}" (SPEC 13.6: the chain is the one presented, not a claim)`);
    }
  }

  // Leaf-level currency: space, holder binding, window, TTL ceiling, live epoch.
  if (leaf.space !== opts.space)
    throw new EpEnvelopeError("permission-denied", `handle "${leaf.id}" is bound to space ${leaf.space}, not ${opts.space} (SPEC 13.6)`);
  if (leaf.holder.id !== opts.presenter.id || leaf.holder.lifecycleUid !== opts.presenter.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", `handle "${leaf.id}" is holder-bound to ${leaf.holder.id}/${leaf.holder.lifecycleUid}; the presenter ${opts.presenter.id}/${opts.presenter.lifecycleUid} is not the holder — a recycled alias cannot present its predecessor's handles (SPEC 13.6)`);
  const nbf = leaf.nbf ?? leaf.iat;
  if (opts.now < nbf || opts.now > leaf.exp)
    throw new EpEnvelopeError("permission-denied", `handle "${leaf.id}" is outside its validity window [${nbf}, ${leaf.exp}] at now ${opts.now} (SPEC 13.6: expiry fails closed)`);
  const ttlCeiling = leaf.sturdy ? (opts.maxSturdyTtlMs ?? HANDLE_MAX_STURDY_TTL_MS) : (opts.maxLiveTtlMs ?? HANDLE_MAX_LIVE_TTL_MS);
  if (leaf.exp - leaf.iat > ttlCeiling)
    throw new EpEnvelopeError("permission-denied", `handle "${leaf.id}" TTL ${leaf.exp - leaf.iat}ms exceeds the ${leaf.sturdy ? "sturdy" : "live"} ceiling ${ttlCeiling}ms (SPEC 13.6)`);
  if (!leaf.sturdy && leaf.epoch !== opts.presenter.epoch)
    throw new EpEnvelopeError("permission-denied", `live handle "${leaf.id}" binds process epoch ${leaf.epoch}; the presenter epoch is ${opts.presenter.epoch} (live authority dies on restart, SPEC 13.1/13.6)`);

  // Walk every link: containment, issuer authority, signature, revocation.
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    const parent = handles[i + 1];
    if (parent !== undefined) assertHandleContainedIn(h, parent);

    const anchor = await resolveAnchorForUse(opts.resolveAnchor, { keyId: h.issuer.keyId, role: "handles", at: opts.now });
    // The issuer of a CHILD is the PARENT's holder; a ROOT's issuer is the anchor's own owner.
    const expectedIssuerOwner = parent !== undefined ? parent.holder.id : anchor.owner;
    if (anchor.owner !== expectedIssuerOwner)
      throw new EpEnvelopeError("permission-denied", `handle "${h.id}" issuer key ${h.issuer.keyId} belongs to ${anchor.owner}, not ${parent !== undefined ? `the parent's holder ${expectedIssuerOwner}` : `the root issuer principal ${expectedIssuerOwner}`} (SPEC 13.6/13.10)`);
    // The issuer key must carry a `handles` role whose scope covers this handle's widest reach.
    for (const scopeSubject of handleScopeSubjects(h))
      assertAnchorScopeCovers(anchor, "handles", scopeSubject, `handle "${h.id}"`);
    verifyArtifactSignature(h as unknown as Record<string, unknown>, anchor);

    if (h.sturdy) {
      const revoked = await opts.readRevocation(h.issuer.keyId, h.id);
      if (revoked)
        throw new EpEnvelopeError("permission-denied", `a sturdy link in the chain is revoked (handle "${h.id}", issuer ${h.issuer.keyId}); chain verification checks EVERY sturdy link, not only the leaf, and fails closed (SPEC 13.6)`);
    }
  }

  return { leaf, grants: compileHandleGrants(leaf) };
}

/** The subjects a handle's `handles`-role issuer scope must cover — one per (endpoint, command)
 *  the handle grants, in the §13.10 domain-scope form the anchor's scope ceiling is checked
 *  against. */
function handleScopeSubjects(handle: CapabilityHandle): string[] {
  const out: string[] = [];
  for (const g of handle.grants)
    for (const cmd of g.commands)
      out.push(`${endpointToken(g.endpoint)}.${cmd.name}`);
  return out;
}

/** Serialize a handle to its canonical bytes (the wire/store form). Throws if the artifact is
 *  not interchangeable I-JSON (the strict canonical path), so a non-canonicalizable handle can
 *  never be persisted or presented. */
export function serializeHandle(handle: CapabilityHandle): Uint8Array {
  return new TextEncoder().encode(canonicalJson(handle));
}

// re-export so a caller can spell the modes without reaching into subjects
export { EP_AUTHZ_MODES };

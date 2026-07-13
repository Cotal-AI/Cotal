/**
 * v0.4 governed traits (SPEC §13.7 "Traits", §13.9 "Trait seam", §13.10) — the trait
 * definition and attachment artifacts, their fail-closed verification, and the pre-effect
 * enforcement gate the serve boundary runs for the two traits this revision governs,
 * `ai.cotal.guarded` and `ai.cotal.priced`.
 *
 * The authority model has TWO distinct signatures (§13.7): a trait DEFINITION
 * `{ urn, valueSchema, selector, breakingChanges, authority }` is content-addressed and
 * signed by a key whose anchor's traits-scope covers the urn's reverse-DNS domain (the
 * space-operator key carries `ai.cotal`; a third party registers under its own domain
 * claim); every governed ATTACHMENT is SEPARATELY signed by the definition's NAMED
 * authority over `{ endpoint, command, contractDigest, traitUrn, value }` — so a
 * self-published descriptor cannot strip, forge, or downgrade a governed annotation
 * (the annotation's authority is the attachment, bound to the cluster document's complete
 * closure digest, never the descriptor's own bytes). Removal or downgrade is an authorized
 * contract revision, enforced at the trusted registration write (registerServiceInstance's
 * governed-continuity seam) against the registry's prior spec, so a surviving command cannot
 * drop a governed trait.
 *
 * Core owns exactly the fail-closed verification interfaces (§13.9 trait seam): the guard
 * call and priced-proof hooks are SEAMS — policy engines, token formats, and payment rails
 * are extensions behind them, and the test implementations live in smokes, never here.
 * Non-governed traits are unsigned vocabulary: declared in the cluster document, carried
 * in describe, never gated here.
 */
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { ContractInvalidError, compileContract } from "./schema-profile.js";
import { verifyClusterManifest, isReverseDnsUrn } from "./endpoint-cluster.js";
import { assertServeGrantAuthorized, type EpServeGrant } from "./endpoint-service.js";
import type { EpCaller } from "./endpoint-subjects.js";
import {
  resolveAnchorForUse, verifyArtifactSignature, assertAnchorScopeCovers, type AnchorResolver,
} from "./endpoint-signing.js";

/** The pre-effect authorization trait (§13.6 "Guard checkpoint"): the command MUST NOT
 *  effect until the guard endpoint named by the trait value answered allow. */
export const TRAIT_GUARDED = "ai.cotal.guarded";
/** The payment trait (§13.10): the command MUST verify an independently verifiable payment
 *  proof in the `auth` slot before effect — never a bare "settled" assertion. */
export const TRAIT_PRICED = "ai.cotal.priced";
/** This revision governs EXACTLY these two (§13.7); everything else is vocabulary. */
export const GOVERNED_TRAIT_URNS: readonly string[] = Object.freeze([TRAIT_GUARDED, TRAIT_PRICED]);

/** What a trait definition may attach to (§13.7). */
export const TRAIT_SELECTORS = ["cluster", "command", "attribute", "event"] as const;
export type TraitSelector = (typeof TRAIT_SELECTORS)[number];

/** The §13.7 trait definition artifact: content-addressed (its identity is
 *  {@link traitDefinitionDigest} over the FULL artifact, signature included) and signed
 *  (`v`/`signer`/`sig` are the §13.10 signing envelope around the normative five-field
 *  tuple). `authority` NAMES the key that must sign every attachment of this trait —
 *  attachment authority is distinct from definition authority by design. */
export interface TraitDefinition {
  v: 1;
  urn: string;
  /** CLOSURE digest of the schema bundle every attachment `value` validates against. */
  valueSchema: string;
  selector: readonly TraitSelector[];
  breakingChanges: boolean;
  authority: { keyId: string };
  signer: { keyId: string };
  sig: string;
}

/** The §13.10 trait-attachment artifact (replay matrix row: revision-bound evidence,
 *  replaced only by an authorized contract revision). `contractDigest` is the declaring
 *  cluster document's complete CLOSURE digest — the binding that makes an attachment for
 *  one revision unusable for any other. */
export interface TraitAttachment {
  v: 1;
  space: string;
  endpoint: string;
  command: string;
  contractDigest: string;
  traitUrn: string;
  value: unknown;
  signer: { keyId: string };
  ts: number;
  sig: string;
}

/** Fetch one contract-store artifact by digest (the same read seam serve authorization
 *  uses): `undefined` = not readable (fail closed at the caller). */
export type TraitArtifactReader = (digest: string) => Promise<unknown> | unknown;

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

// Provenance brands (the compiled-contract / serve-grant pattern): the consuming seams check
// the brand, never structure, so a hand-built artifact that skipped verification can never
// enter an enforcement path.
const VERIFIED_DEFINITIONS = new WeakSet<TraitDefinition>();
const VERIFIED_ATTACHMENTS = new WeakSet<TraitAttachment>();

function invalid(what: string): never {
  throw new ContractInvalidError(`trait artifact does not validate: ${what}`);
}

/** Deep-copy a received artifact into a PRIVATE, deep-frozen snapshot BEFORE any await: the
 *  parse, the signature, the value-schema validation, and the brand must all attest the SAME
 *  bytes. A parsed artifact that aliases caller-reachable objects (`att.value` ← `raw.value`)
 *  can otherwise be mutated DURING the awaited anchor/schema reads AFTER the signature verified
 *  — branding a value nobody signed (finding: signed "warden", branded "evil").
 *
 *  The snapshot is built through the STRICT RFC 8785 / I-JSON canonical path
 *  ({@link canonicalJson}), NOT `JSON.stringify`: `JSON.stringify` is a LENIENT projection that
 *  silently DROPS `undefined`/function/symbol object properties and coerces non-finite numbers
 *  to `null`, so snapshotting through it would verify the signature over a NORMALIZED artifact
 *  rather than the exact received bytes — the same D28 field-dropping class the 2c6d071 fold
 *  closed for nested `{keyId}` (finding: an unsigned `value.unsignedExtra: undefined` that
 *  refuses against the exact raw would ride once `JSON.stringify` drops it). `canonicalJson`
 *  THROWS on any non-interchangeable value (undefined anywhere, non-finite number, lone
 *  surrogate), so a non-I-JSON artifact REFUSES here instead of being normalized; and the
 *  snapshot's canonical form is byte-identical to what {@link verifyArtifactSignature} checks. */
function snapshotArtifact(raw: unknown, what: string): Record<string, unknown> {
  let copy: unknown;
  try {
    copy = JSON.parse(canonicalJson(raw));
  } catch (e) {
    invalid(`${what} is not strict interchangeable JSON (${(e as Error)?.message ?? String(e)}); a signed artifact must canonicalize exactly, never through a value-dropping projection (SPEC 13.10 D28)`);
  }
  if (!isRec(copy)) invalid(`${what} is not an object`);
  return deepFreeze(copy);
}

/** A closed `{ keyId: <non-empty string> }` object, nothing else (§13.10, D28): the nested
 *  signer/authority shapes are part of the signed artifact, so an UNKNOWN nested field must
 *  refuse — otherwise it would ride UNSIGNED under a field-dropping projection and the recomputed
 *  signature would still verify over the clean version. */
function assertClosedKeyId(v: unknown, what: string): { keyId: string } {
  if (!isRec(v) || typeof (v as Record<string, unknown>).keyId !== "string" || (v as Record<string, unknown>).keyId === "")
    invalid(`${what} is not { keyId } (a non-empty string)`);
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "keyId")
    invalid(`${what} carries fields other than keyId (${keys.sort().join(",")}); a nested object is a CLOSED shape so no unsigned field can ride under it (SPEC 13.10 D28)`);
  return { keyId: (v as { keyId: string }).keyId };
}

function parseTraitDefinitionShape(raw: unknown): TraitDefinition {
  const o = isRec(raw) ? raw : invalid("definition is not an object");
  if (o.v !== 1) invalid(`definition v ${JSON.stringify(o.v)} is not 1`);
  if (typeof o.urn !== "string" || !isReverseDnsUrn(o.urn)) invalid(`definition urn ${JSON.stringify(o.urn)} is not a reverse-DNS trait URN`);
  if (typeof o.valueSchema !== "string" || !isContractDigest(o.valueSchema)) invalid("definition valueSchema is not a sha256 closure digest");
  if (!Array.isArray(o.selector) || o.selector.length === 0) invalid("definition selector must be a non-empty array");
  const seen = new Set<string>();
  for (const s of o.selector) {
    if (typeof s !== "string" || !(TRAIT_SELECTORS as readonly string[]).includes(s)) invalid(`definition selector entry ${JSON.stringify(s)} is not one of ${TRAIT_SELECTORS.join("|")}`);
    if (seen.has(s)) invalid(`definition selector lists "${s}" twice`);
    seen.add(s);
  }
  if (typeof o.breakingChanges !== "boolean") invalid("definition breakingChanges is not a boolean");
  const authority = assertClosedKeyId(o.authority, "definition authority");
  const signer = assertClosedKeyId(o.signer, "definition signer");
  if (typeof o.sig !== "string") invalid("definition sig is absent");
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "authority,breakingChanges,selector,sig,signer,urn,v,valueSchema")
    invalid(`definition carries unknown/missing fields (${keys}); the artifact is a closed discriminated schema (SPEC 13.10)`);
  return {
    v: 1, urn: o.urn, valueSchema: o.valueSchema, selector: [...(o.selector as TraitSelector[])],
    breakingChanges: o.breakingChanges, authority, signer, sig: o.sig,
  };
}

/**
 * Verify a trait DEFINITION (§13.7/§13.10), fail closed: shape (closed schema), the signer
 * resolved FRESH in the anchor registry (role `traits`, window at verification time — a
 * definition is timeless content, its authority must be live), the signer's traits-scope
 * covering the urn's reverse-DNS domain (this is what makes `ai.cotal.*` operator-only and
 * a third-party urn its registered owner's), and the D28 signature. Returns the frozen,
 * provenance-branded definition; every attachment verifier REQUIRES the brand.
 */
export async function verifyTraitDefinition(
  raw: unknown,
  opts: { resolveAnchor: AnchorResolver; now?: number },
): Promise<TraitDefinition> {
  // Snapshot FIRST (before the anchor await): the parse, the signature, and the returned
  // artifact all attest one immutable copy — a caller mutating `raw` mid-verification races
  // nothing (§13.10 D28: the verified bytes ARE the branded bytes).
  const artifact = snapshotArtifact(raw, "trait definition");
  const def = parseTraitDefinitionShape(artifact); // closed schema incl. closed nested {keyId}
  const anchor = await resolveAnchorForUse(opts.resolveAnchor, { keyId: def.signer.keyId, role: "traits", at: opts.now ?? Date.now() });
  assertAnchorScopeCovers(anchor, "traits", def.urn, "trait definition urn");
  // §13.10 D28: verify over the EXACT received artifact as snapshot at entry (minus sig),
  // never a field-dropping reconstruction — the closed nested-shape checks above already
  // guarantee the snapshot and the parsed projection agree, so an unsigned field can neither
  // survive nor change the verified bytes.
  verifyArtifactSignature(artifact, anchor);
  const frozen = deepFreeze(def);
  VERIFIED_DEFINITIONS.add(frozen);
  return frozen;
}

/** True iff this exact object came out of {@link verifyTraitDefinition}. */
export function isVerifiedTraitDefinition(def: unknown): def is TraitDefinition {
  return typeof def === "object" && def !== null && VERIFIED_DEFINITIONS.has(def as TraitDefinition);
}

/** The definition's content address (§13.7): the artifact digest over its FULL RFC 8785
 *  canonical form, signature included — the value a by-digest reference names. */
export function traitDefinitionDigest(def: TraitDefinition): string {
  return contractDigest(def);
}

function parseTraitAttachmentShape(raw: unknown): TraitAttachment {
  const o = isRec(raw) ? raw : invalid("attachment is not an object");
  if (o.v !== 1) invalid(`attachment v ${JSON.stringify(o.v)} is not 1`);
  for (const f of ["space", "endpoint", "command", "traitUrn"] as const)
    if (typeof o[f] !== "string" || o[f] === "") invalid(`attachment ${f} is not a non-empty string`);
  if (typeof o.contractDigest !== "string" || !isContractDigest(o.contractDigest)) invalid("attachment contractDigest is not a sha256 closure digest");
  if (!("value" in o) || o.value === undefined) invalid("attachment value is absent (validate against the definition's value schema, even when void)");
  const signer = assertClosedKeyId(o.signer, "attachment signer");
  if (typeof o.ts !== "number" || !Number.isSafeInteger(o.ts) || o.ts <= 0) invalid("attachment ts is not a positive integer timestamp");
  if (typeof o.sig !== "string") invalid("attachment sig is absent");
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "command,contractDigest,endpoint,sig,signer,space,traitUrn,ts,v,value")
    invalid(`attachment carries unknown/missing fields (${keys}); the artifact is a closed discriminated schema (SPEC 13.10)`);
  return {
    v: 1, space: o.space as string, endpoint: o.endpoint as string, command: o.command as string,
    contractDigest: o.contractDigest, traitUrn: o.traitUrn as string, value: o.value,
    signer, ts: o.ts, sig: o.sig,
  };
}

/**
 * Verify one governed trait ATTACHMENT against its verified definition and the EXPECTED
 * binding coordinates (§13.7/§13.10), fail closed on every §13-acceptance adversarial class:
 *  - substitute: `space`/`endpoint`/`command` must equal the expected target — an attachment
 *    signed for one command can never gate (or satisfy) another;
 *  - stale digest: `contractDigest` must equal the CURRENT declaring cluster's closure
 *    digest — a prior revision's attachment is revision-bound evidence, never carried over;
 *  - forge: the signer MUST BE the definition's NAMED authority, resolved fresh (role
 *    `traits`, window checked at VERIFICATION time — never the signer-asserted `ts`, which is
 *    self-attested and would let an expired predecessor key backdate or a not-yet-valid
 *    successor future-date past rotation, §13.10 — revocation immediate), its traits-scope
 *    must cover the urn, and the D28 signature must verify over the exact received bytes;
 *  - downgrade: within a digest the value is signature-bound; a value the schema rejects
 *    fails here, and cross-revision weakening is caught at the trusted registration write
 *    (registerServiceInstance's governed-continuity seam), not from a caller-supplied prior;
 *  - selector: the definition must admit a `command` target.
 * The `value` is validated against the definition's `valueSchema` bundle, read and compiled
 * through the SAME digest-verified path serve authorization uses.
 */
export async function verifyTraitAttachment(
  raw: unknown,
  opts: {
    definition: TraitDefinition;
    expect: { space: string; endpoint: string; command: string; contractDigest: string };
    resolveAnchor: AnchorResolver;
    readArtifact: TraitArtifactReader;
    /** Verification time (ms epoch) the anchor window is checked at; defaults to `Date.now()`.
     *  NEVER the attachment's self-attested `ts` (§13.10: rotation closes a key's window, and a
     *  signer cannot be trusted to timestamp its own signing act). */
    now?: number;
  },
): Promise<TraitAttachment> {
  if (!isVerifiedTraitDefinition(opts.definition))
    throw new EpEnvelopeError("failed-precondition", "the supplied trait definition is not a verified artifact (verifyTraitDefinition); an unverified definition carries no attachment authority (SPEC 13.7)");
  // Snapshot FIRST (before any await): `att.value` below references the snapshot, so a caller
  // mutating `raw.value` during the awaited anchor/schema reads cannot change what gets
  // signature-verified, schema-validated, or branded (finding: signed "warden" branded as
  // "evil" via the alias). The verified bytes ARE the branded bytes (§13.10 D28).
  const artifact = snapshotArtifact(raw, "trait attachment");
  const att = parseTraitAttachmentShape(artifact);
  const def = opts.definition;
  if (att.traitUrn !== def.urn)
    throw new EpEnvelopeError("failed-precondition", `attachment traitUrn "${att.traitUrn}" is not the definition's "${def.urn}"; an attachment verifies only against its own trait's definition (SPEC 13.7)`);
  if (!def.selector.includes("command"))
    throw new EpEnvelopeError("failed-precondition", `trait "${def.urn}" selector [${def.selector.join(", ")}] does not admit a command target; an attachment outside its definition's selector never verifies (SPEC 13.7)`);
  if (att.space !== opts.expect.space)
    throw new EpEnvelopeError("failed-precondition", `attachment space "${att.space}" is not "${opts.expect.space}"; trust roots never merge across spaces (SPEC 13.10)`);
  if (att.endpoint !== opts.expect.endpoint || att.command !== opts.expect.command)
    throw new EpEnvelopeError("failed-precondition", `attachment is bound to ${att.endpoint}/${att.command}, not ${opts.expect.endpoint}/${opts.expect.command}; a substituted attachment never verifies (SPEC 13.7)`);
  if (att.contractDigest !== opts.expect.contractDigest)
    throw new EpEnvelopeError("failed-precondition", `attachment is bound to contractDigest ${att.contractDigest}, not the current declaring closure ${opts.expect.contractDigest}; a stale revision's attachment is evidence for ITS revision only (SPEC 13.10: replaced only by an authorized contract revision)`);
  if (att.signer.keyId !== def.authority.keyId)
    throw new EpEnvelopeError("permission-denied", `attachment is signed by ${att.signer.keyId}, not the definition's named authority ${def.authority.keyId}; attachment authority is the definition's to name (SPEC 13.7)`);
  const anchor = await resolveAnchorForUse(opts.resolveAnchor, { keyId: att.signer.keyId, role: "traits", at: opts.now ?? Date.now() });
  assertAnchorScopeCovers(anchor, "traits", att.traitUrn, "trait attachment urn");
  // §13.10 D28: verify over the EXACT received artifact as snapshot at entry (minus sig),
  // never a reconstruction — and never the caller's still-mutable `raw`.
  verifyArtifactSignature(artifact, anchor);
  // Value-schema validation through the digest-verified two-step read (§13.7): manifest at the
  // closure digest, root at manifest.root, profile-compiled; the compiled closure digest must
  // round-trip to the definition's valueSchema, so no unverified byte enters the validator.
  const readSchema = async (digest: string, what: string): Promise<unknown> => {
    let bytes: unknown;
    try {
      bytes = await opts.readArtifact(digest);
    } catch (e) {
      throw new EpEnvelopeError("unavailable", `the contract-store read seam failed for the ${what} ${digest}; attachment verification fails closed (SPEC 13.7): ${(e as Error)?.message ?? String(e)}`);
    }
    if (bytes === undefined)
      throw new EpEnvelopeError("failed-precondition", `the ${what} ${digest} is not readable from the contract store; an unverifiable value schema never verifies an attachment (SPEC 13.7)`);
    return bytes;
  };
  const manifestRaw = await readSchema(def.valueSchema, "trait value-schema manifest");
  const { root } = verifyClusterManifest(def.valueSchema, manifestRaw);
  const rootRaw = await readSchema(root, "trait value-schema document");
  const compiled = compileContract({ root: rootRaw });
  if (compiled.closureDigest !== def.valueSchema)
    throw new EpEnvelopeError("internal", `the compiled value schema's closure digest ${compiled.closureDigest} does not round-trip to the definition's ${def.valueSchema}; a store/manifest inconsistency never verifies (SPEC 13.7)`);
  if (!compiled.validate(att.value)) {
    const first = compiled.validate.errors?.[0];
    throw new EpEnvelopeError("failed-precondition", `attachment value does not validate against trait "${def.urn}"'s value schema${first ? `: ${first.instancePath || "/"} ${first.message ?? ""}` : ""} (SPEC 13.7)`);
  }
  const frozen = deepFreeze(att);
  VERIFIED_ATTACHMENTS.add(frozen);
  return frozen;
}

/** True iff this exact object came out of {@link verifyTraitAttachment}. */
export function isVerifiedTraitAttachment(att: unknown): att is TraitAttachment {
  return typeof att === "object" && att !== null && VERIFIED_ATTACHMENTS.has(att as TraitAttachment);
}

// ---- the governed surface (what the serve boundary consumes) ------------------------------------

/** The verified governed surface of ONE serve grant: command → governed traitUrn → its
 *  verified attachment. Opaque to construction — only {@link verifyGovernedSurface} brands
 *  one, and the serve boundary refuses anything unbranded or bound to a different grant.
 *
 *  A DEEP-FROZEN, NULL-PROTOTYPE nested record, never a `Map`: `Object.freeze` does not disable
 *  a Map's `set`/`delete`/`clear`, so a WeakMap brand over a mutable Map would attest provenance
 *  WITHOUT integrity — a caller could delete a governed command after verification and the gate
 *  would then see it as ungoverned and run the handler unguarded. And a plain `{}` record would
 *  resolve the valid command token "constructor" through `Object.prototype`, landing attachment
 *  state on the GLOBAL `Object` function instead of an own frozen entry. The frozen null-proto
 *  record is genuinely immutable and every lookup an own-property read, so the brand means
 *  integrity. */
export interface EpGovernedSurface {
  commands: Readonly<Record<string, Readonly<Record<string, TraitAttachment>>>>;
}

interface GovernedBond {
  space: string;
  endpoint: string;
  instanceId: string;
  epoch: number;
  registrationRevision: number;
  grantCommands: ReadonlySet<string>;
}
const VERIFIED_GOVERNED = new WeakMap<EpGovernedSurface, GovernedBond>();

/**
 * Verify a serve grant's WHOLE governed surface (§13.7, fail closed, both strip directions):
 * every granted command's DECLARED governed traits must each have exactly one verified
 * attachment bound to that command's declaring closure digest (a declared-but-unattached
 * governed trait is a strip or an unverifiable annotation — refuse before effect), and every
 * supplied attachment must land on a command that DECLARES its trait (an attached-but-
 * undeclared governed trait means the self-published descriptor dropped an authority's
 * annotation — equally a strip). Duplicates, unknown commands, non-governed urns, and
 * missing definitions all refuse. Returns the branded surface, bound to exactly this grant's
 * identity coordinates; {@link assertGovernedSurfaceFor} is the serve-side check.
 *
 * This verifies the CURRENT surface's declaration<->attachment coherence (both strip directions
 * WITHIN a revision). Cross-REVISION governed-continuity (a re-registration may not strip an
 * authority-imposed trait from a surviving command, §13.7) is enforced at the TRUSTED registration
 * write (registerServiceInstance's governed-continuity seam) against the registry's prior
 * spec — NOT here, and NOT from a caller-supplied prior surface, which the owner could forge by
 * claiming "first governance".
 */
export async function verifyGovernedSurface(args: {
  serve: EpServeGrant;
  definitions: readonly TraitDefinition[];
  attachments: readonly unknown[];
  resolveAnchor: AnchorResolver;
  readArtifact: TraitArtifactReader;
  now?: number;
}): Promise<EpGovernedSurface> {
  assertServeGrantAuthorized(args.serve);
  const defs = new Map<string, TraitDefinition>();
  for (const def of args.definitions) {
    if (!isVerifiedTraitDefinition(def))
      throw new EpEnvelopeError("failed-precondition", "a supplied trait definition is not a verified artifact (verifyTraitDefinition); fail closed (SPEC 13.7)");
    if (!GOVERNED_TRAIT_URNS.includes(def.urn))
      throw new EpEnvelopeError("failed-precondition", `definition "${def.urn}" is not a governed trait; this revision governs exactly ${GOVERNED_TRAIT_URNS.join(" and ")} (SPEC 13.7), and non-governed traits are unsigned vocabulary with no attachment surface`);
    if (defs.has(def.urn))
      throw new EpEnvelopeError("failed-precondition", `two definitions supplied for "${def.urn}"; a governed trait has one definition per verification (SPEC 13.7)`);
    defs.set(def.urn, def);
  }
  // NULL-PROTOTYPE dictionaries at BOTH levels: a command is caller-named text under the
  // `[a-z0-9-]{1,32}` grammar, and "constructor" is a valid token — on a plain `{}` it would
  // resolve the inherited `Object.prototype.constructor` (truthy!), so the attachment would be
  // written onto the GLOBAL `Object` function instead of an own frozen entry: coverage would
  // pass via inherited state, another surface could observe/reuse it, and deleting the global
  // property post-brand would un-govern the command (finding). `Object.create(null)` has no
  // prototype, so every lookup is an own-property read.
  const commands: Record<string, Record<string, TraitAttachment>> = Object.create(null);
  for (const raw of args.attachments) {
    // Route on minimally-read fields; full verification below binds them all over the signature.
    const o = isRec(raw) ? raw : invalid("attachment is not an object");
    const command = typeof o.command === "string" ? o.command : invalid("attachment command is not a string");
    const urn = typeof o.traitUrn === "string" ? o.traitUrn : invalid("attachment traitUrn is not a string");
    const decl = args.serve.surface[command];
    if (decl === undefined)
      throw new EpEnvelopeError("failed-precondition", `attachment names command "${command}", which is not on the granted registered surface (SPEC 13.7)`);
    if (!GOVERNED_TRAIT_URNS.includes(urn))
      throw new EpEnvelopeError("failed-precondition", `attachment names "${urn}", not a governed trait; this revision governs exactly ${GOVERNED_TRAIT_URNS.join(" and ")} (SPEC 13.7)`);
    if (!decl.traits.includes(urn))
      throw new EpEnvelopeError("failed-precondition", `command "${command}" carries a verified-authority attachment for "${urn}" that its registered declaration does not declare; a self-published descriptor cannot strip a governed annotation (SPEC 13.7)`);
    const def = defs.get(urn);
    if (def === undefined)
      throw new EpEnvelopeError("failed-precondition", `no verified definition supplied for governed trait "${urn}"; an attachment without its definition is unverifiable and refuses (SPEC 13.7)`);
    const att = await verifyTraitAttachment(raw, {
      definition: def,
      expect: { space: args.serve.space, endpoint: args.serve.endpoint, command, contractDigest: decl.clusterDigest },
      resolveAnchor: args.resolveAnchor,
      readArtifact: args.readArtifact,
      ...(args.now !== undefined ? { now: args.now } : {}),
    });
    const per = commands[command] ?? (commands[command] = Object.create(null) as Record<string, TraitAttachment>);
    if (per[urn] !== undefined)
      throw new EpEnvelopeError("failed-precondition", `two attachments supplied for ${command}/${urn}; the governed surface is one attachment per (command, trait) (SPEC 13.7)`);
    per[urn] = att;
  }
  for (const cmd of args.serve.commands) {
    for (const urn of args.serve.surface[cmd].traits) {
      if (!GOVERNED_TRAIT_URNS.includes(urn)) continue; // vocabulary: unsigned, ungated
      if (commands[cmd]?.[urn] === undefined)
        throw new EpEnvelopeError("failed-precondition", `command "${cmd}" declares governed trait "${urn}" with no verified attachment for the current contract digest; missing, unverifiable, or stale governed attachments refuse before effect (SPEC 13.7)`);
    }
  }
  // Deep-frozen: the attachments are already frozen; this locks the nested records too, so the
  // brand below attests an object no caller can mutate after verification (finding: a frozen Map
  // is still mutable; a frozen plain record is not).
  const surface: EpGovernedSurface = deepFreeze({ commands });
  VERIFIED_GOVERNED.set(surface, {
    space: args.serve.space, endpoint: args.serve.endpoint, instanceId: args.serve.instanceId,
    epoch: args.serve.epoch, registrationRevision: args.serve.registrationRevision,
    grantCommands: new Set(args.serve.commands),
  });
  return surface;
}

/** Refuse a governed surface that {@link verifyGovernedSurface} did not produce FOR THIS
 *  grant: brand first (structure carries no verification), then the identity bond — a
 *  surface verified for another instance, epoch, or registration revision never gates this
 *  one (a re-registration re-verifies; the fresh grant demands a fresh surface). */
export function assertGovernedSurfaceFor(surface: EpGovernedSurface, serve: EpServeGrant): void {
  const bond = VERIFIED_GOVERNED.get(surface);
  if (bond === undefined)
    throw new Error("the traits surface is not a verified governed surface (verifyGovernedSurface); a structural value carries no verification (SPEC 13.7)");
  if (bond.space !== serve.space || bond.endpoint !== serve.endpoint || bond.instanceId !== serve.instanceId
    || bond.epoch !== serve.epoch || bond.registrationRevision !== serve.registrationRevision)
    throw new Error(`the governed surface was verified for ${bond.endpoint}/${bond.instanceId}@${bond.epoch} rev ${bond.registrationRevision}, not this grant (${serve.endpoint}/${serve.instanceId}@${serve.epoch} rev ${serve.registrationRevision}); a re-registration demands a fresh verification (SPEC 13.7)`);
}

// §13.7 downgrade/removal continuity — "removal or downgrade is an AUTHORIZED contract
// revision" — is enforced at the TRUSTED registration write (registerServiceInstance's
// governed-continuity seam), against the registry's own prior spec. It is deliberately NOT a
// serve-side check over two caller-supplied branded surfaces: the owner controls the descriptor,
// so a caller-supplied "previous" (or a claimed first-governance) is forgeable, whereas the prior
// registered spec is not. See registerServiceInstance.

// ---- the pre-effect enforcement gate (§13.9 trait seam) ------------------------------------------

/** The reference guard/proof seam deadline (§13.8: reference default call deadline 15s;
 *  overridable, never removable) when the request carries no tighter budget. A governed gate
 *  MUST be bounded — a never-settling seam is timeout→deny, never a hung request. */
export const REFERENCE_GOVERNED_SEAM_DEADLINE_MS = 15_000;

/** Race a fail-closed seam against its deadline: a never-settling guard/proof becomes DENY
 *  (`permission-denied`) at the bound, so it can never hold the request or `serveEndpoint.stop()`
 *  open (§13.6: timeout or unreachable is deny). The seam's own throw is re-raised for the
 *  caller to map; only the timeout is synthesized here. */
async function raceSeam<T>(work: Promise<T> | T, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EpEnvelopeError("permission-denied", `${what} did not answer within the ${ms}ms bound; timeout is deny (SPEC 13.6: fail closed, never a hung request)`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A guard's answer (§13.6 "Guard checkpoint"): `allow | deny | hold`, plus optional signed
 *  obligations on allow (attenuations the endpoint MUST apply; monotonic — surfaced to the
 *  handler, whose policy engine applies them behind the seam). */
export type EpGuardVerdict =
  | { verdict: "allow"; obligations?: readonly unknown[] }
  | { verdict: "deny"; reason?: string }
  | { verdict: "hold" };

/** The guard-call SEAM (§13.9): production composes a class call (`epCall` on the `one`
 *  rail) to the guard endpoint the trait VALUE names, bounded by its own deadline; a test
 *  supplies a fake. However it is wired: a throw, a timeout, or an unreachable guard is
 *  DENY (§13.6, fail closed) — the gate never interprets a seam failure as allow. */
export type EpGuardCall = (q: {
  endpoint: string;
  command: string;
  caller: EpCaller;
  requestId: string;
  /** The verified attachment's value — it names the guard endpoint (§13.6). */
  value: unknown;
}) => Promise<EpGuardVerdict> | EpGuardVerdict;

/** The priced-proof SEAM (§13.9): verify the `auth`-slot payment proof — an INDEPENDENTLY
 *  verifiable artifact, never a bare "settled" assertion (§13.10). The verifier owns the
 *  declared replay policy (matrix default: one-use per request id — journal the redemption).
 *  Token formats and payment rails are extensions behind this seam. */
export type EpPricedProofVerify = (q: {
  endpoint: string;
  command: string;
  caller: EpCaller;
  requestId: string;
  /** The `auth` slot exactly as carried. */
  proof: string;
  /** The verified attachment's value — the priced terms. */
  value: unknown;
}) => Promise<boolean> | boolean;

/** What the serve boundary wires to enforce its governed surface: the branded surface plus
 *  the hooks its traits demand ({@link import("./endpoint-serve.js").serveEndpoint} refuses
 *  at construction if a governed command's hook is missing — fail closed at wiring time,
 *  not at first request). */
export interface EpTraitEnforcement {
  governed: EpGovernedSurface;
  guard?: EpGuardCall;
  verifyPaymentProof?: EpPricedProofVerify;
}

/**
 * The fail-closed pre-effect gate (§13.7/§13.9): run once per accepted request, AFTER args
 * validation, target currency, and mode authorization, immediately BEFORE the handler — for
 * calls and casts alike (casts have effects too). Guard FIRST, then priced (deliberate: a
 * guard deny must never burn a one-use payment proof). Every anomalous answer refuses:
 *  - guarded: seam absent, seam throw, or malformed verdict = DENY (`permission-denied`);
 *    `deny` = `permission-denied`; `hold` = `failed-precondition` (hold converts an ACTION
 *    to waiting on a guard-owned checkpoint, §13.6 — the ephemeral rail cannot wait, the
 *    action composite owns hold);
 *  - priced: absent `auth` slot, seam absent, seam throw, non-boolean or false answer =
 *    `permission-denied`; a proof is verified, never assumed.
 * Both seams are BOUNDED ({@link raceSeam}) by `deadlineMs` (the request budget, or the §13.8
 * reference default): a never-settling extension becomes deny at the bound, never a hung request.
 * Returns the guard's obligations for the handler context. Receipt emission for priced
 * commands is the §13.10 receipts slice (D9), not gated here.
 */
export async function assertGovernedPreEffect(args: {
  enforcement: EpTraitEnforcement;
  endpoint: string;
  command: string;
  caller: EpCaller;
  requestId: string;
  auth?: string;
  /** The seam bound (ms); defaults to {@link REFERENCE_GOVERNED_SEAM_DEADLINE_MS}. */
  deadlineMs?: number;
}): Promise<{ obligations?: readonly unknown[] }> {
  const governed = args.enforcement.governed.commands[args.command];
  if (governed === undefined) return {};
  const seamMs = args.deadlineMs !== undefined && Number.isSafeInteger(args.deadlineMs) && args.deadlineMs > 0
    ? args.deadlineMs : REFERENCE_GOVERNED_SEAM_DEADLINE_MS;
  let obligations: readonly unknown[] | undefined;

  const guarded = governed[TRAIT_GUARDED];
  if (guarded !== undefined) {
    const guard = args.enforcement.guard;
    if (guard === undefined)
      throw new EpEnvelopeError("permission-denied", `command "${args.command}" is guarded and this instance wired no guard seam; an unreachable guard is deny (SPEC 13.6: fail closed)`);
    let verdict: EpGuardVerdict;
    try {
      verdict = await raceSeam(guard({ endpoint: args.endpoint, command: args.command, caller: args.caller, requestId: args.requestId, value: guarded.value }), seamMs, `the guard for "${args.command}"`);
    } catch (e) {
      if (e instanceof EpEnvelopeError) throw e; // the bound's deny, already fail-closed
      throw new EpEnvelopeError("permission-denied", `the guard call failed (${(e as Error)?.message ?? String(e)}); timeout or unreachable guard is deny (SPEC 13.6: fail closed)`);
    }
    // Runtime-fence the seam's answer (an untrusted caller-supplied boundary): anything that
    // is not an explicit allow/deny/hold verdict is DENY, never fall-through.
    if (!isRec(verdict) || (verdict.verdict !== "allow" && verdict.verdict !== "deny" && verdict.verdict !== "hold"))
      throw new EpEnvelopeError("permission-denied", `the guard returned a malformed verdict; anything but an explicit allow is deny (SPEC 13.6: fail closed)`);
    if (verdict.verdict === "deny")
      throw new EpEnvelopeError("permission-denied", `the guard denied "${args.command}"${verdict.reason ? `: ${verdict.reason}` : ""} (SPEC 13.6: guard-then-effect)`);
    if (verdict.verdict === "hold")
      throw new EpEnvelopeError("failed-precondition", `the guard held "${args.command}": hold converts an action to waiting on a guard-owned checkpoint (SPEC 13.6), and the ephemeral rail cannot wait — the action composite owns hold; refusing pre-effect`);
    if (verdict.obligations !== undefined) {
      if (!Array.isArray(verdict.obligations))
        throw new EpEnvelopeError("permission-denied", "the guard's obligations are not an array; a malformed allow is deny (SPEC 13.6: fail closed)");
      obligations = verdict.obligations;
    }
  }

  const priced = governed[TRAIT_PRICED];
  if (priced !== undefined) {
    if (args.auth === undefined)
      throw new EpEnvelopeError("permission-denied", `command "${args.command}" is priced and the request carries no auth-slot payment proof; a priced command verifies an independently verifiable proof before effect, never a bare assertion (SPEC 13.10)`);
    const verify = args.enforcement.verifyPaymentProof;
    if (verify === undefined)
      throw new EpEnvelopeError("permission-denied", `command "${args.command}" is priced and this instance wired no proof verifier; an unverifiable proof never effects (SPEC 13.10: fail closed)`);
    let ok: boolean;
    try {
      ok = await raceSeam(verify({ endpoint: args.endpoint, command: args.command, caller: args.caller, requestId: args.requestId, proof: args.auth, value: priced.value }), seamMs, `the payment-proof verifier for "${args.command}"`);
    } catch (e) {
      if (e instanceof EpEnvelopeError) throw e; // the bound's deny, already fail-closed
      throw new EpEnvelopeError("permission-denied", `the payment-proof verifier failed (${(e as Error)?.message ?? String(e)}); verification fails closed (SPEC 13.10)`);
    }
    if (typeof ok !== "boolean")
      throw new EpEnvelopeError("permission-denied", "the payment-proof verifier returned a non-boolean; a malformed answer fails closed (SPEC 13.10)");
    if (!ok)
      throw new EpEnvelopeError("permission-denied", `the payment proof did not verify for "${args.command}" (SPEC 13.10: valid proof in the slot or reject)`);
  }

  return obligations !== undefined ? { obligations } : {};
}

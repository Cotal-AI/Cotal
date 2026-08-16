/**
 * v0.4 cluster artifacts (SPEC §13.7 "Clusters", "Content addressing") — the content-addressed
 * cluster document: its consuming-boundary parser, the digest verification every reader MUST
 * perform on fetched bytes, and the descriptor derivation that makes discovery a projection of
 * VERIFIED registered bytes rather than a hand-authored value.
 *
 * The cluster document is the authority for a command's whole served shape: name, contract
 * class, `targeted` (and, if targeted, the admitted authorization modes), the capability
 * requirement, and the input/output schema CLOSURE digests. Nothing downstream (serve grant,
 * serve table, descriptor) declares any of those locally — they are all derived from a document
 * whose bytes verifiably hash to a digest the REGISTERED service spec names, so substituting a
 * command list, mode set, or schema under a registered digest is a hash collision, not an API
 * call.
 *
 * P1 pins the cluster artifact as a SINGLE self-contained document: its §13.7 closure digest is
 * the manifest digest over `{ v: 1, root: <artifact digest>, members: [] }` (exactly the void
 * schema's construction). A command's schemas are referenced by closure-digest VALUE and their
 * bytes are digest-verified where they are compiled ({@link import("./schema-profile.js").compileContract}
 * verifies every bundle member), so the authority chain has no unverified link. Multi-member
 * cluster bundles are D8 contract-tooling scope.
 */
import { contractDigest } from "./canonical.js";
import { ContractInvalidError } from "./schema-profile.js";
import { endpointToken, assertCommandToken, assertBoundedOwner, isEpAuthzMode, type EpAuthzMode } from "./endpoint-subjects.js";
import type { EpClass } from "./endpoint-envelope.js";

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isDigest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
/** Reverse-DNS cluster type URN (§13.7: `ai.cotal.lifecycle`, `com.acme.deploy`). */
const URN = /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){1,15}$/;

/** True iff `s` is a bounded reverse-DNS URN — the shared form for cluster type URNs and
 *  trait URNs (§13.7: `ai.cotal.guarded`, `com.acme.deploy`). */
export function isReverseDnsUrn(s: string): boolean {
  return URN.test(s);
}

/** The pre-effect authorization trait (§13.6 "Guard checkpoint"): the command MUST NOT
 *  effect until the guard endpoint named by the trait value answered allow. */
export const TRAIT_GUARDED = "ai.cotal.guarded";
/** The payment trait (§13.10): the command MUST verify an independently verifiable payment
 *  proof in the `auth` slot before effect — never a bare "settled" assertion. */
export const TRAIT_PRICED = "ai.cotal.priced";
/** This revision governs EXACTLY these two (§13.7); everything else is vocabulary. Defined
 *  HERE (the cluster layer both the trait verifiers and the registrar depend on) so the
 *  trusted registration writer can pin the canonical set STRUCTURALLY — a caller-supplied
 *  governed set was the subset-narrowing escape the panel rejected. */
export const GOVERNED_TRAIT_URNS: readonly string[] = Object.freeze([TRAIT_GUARDED, TRAIT_PRICED]);
/** A named capability requirement (§13.7/§13.9: minting maps it to subjects). */
const CAPABILITY = /^[a-z][a-z0-9._-]{0,63}$/;

function invalid(what: string): never {
  throw new ContractInvalidError(`cluster document does not validate: ${what}`);
}

/** One command's REGISTERED declaration (§13.7): everything the serve boundary enforces about
 *  it comes from here, out of digest-verified bytes. `modes` is present exactly when
 *  `targeted` — a targeted command admits ONLY its declared modes, an untargeted command
 *  admits ONLY the untargeted form (default-deny both ways, §13.2/§13.7). */
/** The declared admission ceiling for an action command's submissions: what the canonicalizer
 *  refuses BEFORE deciding. It lives in the digest-verified registered surface rather than in a
 *  constant so that two conforming implementations cannot decide the same bytes differently and
 *  durably, and so a caller can see what will be refused before submitting. */
export interface EpAdmissionCeiling {
  maxBytes: number;
  maxDepth: number;
  maxItems: number;
}

export interface ClusterCommand {
  name: string;
  class: EpClass;
  targeted: boolean;
  modes?: EpAuthzMode[];
  capability: string;
  /** CLOSURE digests of the input/output schema bundles (§13.7: what `op` pins). */
  inputDigest: string;
  outputDigest: string;
  traits?: string[];
  /** The ACTION COMPOSITE marker. Present only as `true`; absence means "not an action". It is a
   *  command marker and NOT a class (SPEC:1446) — an action command's submissions are `journal`,
   *  but the marker is what makes `goalId` a MUST on the envelope (SPEC:1448). */
  action?: true;
  /** Declared iff `action` — the ceiling is a MUST for every command that accepts journal-class
   *  submissions, and the canonicalizer reads it from here, never from a constant. */
  admissionCeiling?: EpAdmissionCeiling;
  /** The acceptance-relative readiness bound, iff the command declares bounded readiness (§13.6).
   *  Persisted into the acceptance because it is goal state, not the request's decision deadline. */
  readinessDeadlineMs?: number;
}

/** The §13.7 cluster document: `{ urn, revision, attributes[], commands[], events[] }`.
 *  Attributes and events are carried opaquely in P1 (their consuming machinery is the record
 *  and journal contracts); commands are fully parsed — they are the serve authority. */
export interface ClusterDocument {
  urn: string;
  revision: number;
  attributes: unknown[];
  commands: ClusterCommand[];
  events: unknown[];
}

/** Parse a cluster document at its consuming boundary. Violations are `contract-invalid`
 *  (a malformed contract ARTIFACT, §13.7's registration-time class — a reader of registered
 *  state converts this to its own loud failure). */
export function parseClusterDocument(raw: unknown): ClusterDocument {
  const o = isRec(raw) ? raw : invalid("not an object");
  if (typeof o.urn !== "string" || !URN.test(o.urn)) invalid(`urn ${JSON.stringify(o.urn)} is not a reverse-DNS cluster type URN`);
  if (typeof o.revision !== "number" || !Number.isSafeInteger(o.revision) || o.revision < 0) invalid("revision is not an unsigned integer");
  if (!Array.isArray(o.attributes)) invalid("attributes is not an array");
  if (!Array.isArray(o.events)) invalid("events is not an array");
  if (!Array.isArray(o.commands) || o.commands.length === 0) invalid("commands must be a non-empty array");
  const seen = new Set<string>();
  const commands = o.commands.map((c, i): ClusterCommand => {
    const cmd = isRec(c) ? c : invalid(`commands[${i}] is not an object`);
    const name = typeof cmd.name === "string" ? cmd.name : invalid(`commands[${i}].name is not a string`);
    try {
      assertCommandToken(name);
    } catch (e) {
      invalid(`commands[${i}].name: ${(e as Error).message}`);
    }
    if (name === "describe") invalid(`commands[${i}] declares "describe": reserved, served by the machinery, never a cluster command (SPEC 13.7)`);
    if (seen.has(name)) invalid(`command "${name}" is declared twice`);
    seen.add(name);
    if (cmd.class !== "ephemeral" && cmd.class !== "journal") invalid(`command "${name}" class ${JSON.stringify(cmd.class)} is not "ephemeral" | "journal"`);
    if (typeof cmd.targeted !== "boolean") invalid(`command "${name}" must declare targeted as a boolean (SPEC 13.7)`);
    let modes: EpAuthzMode[] | undefined;
    if (cmd.targeted) {
      if (!Array.isArray(cmd.modes) || cmd.modes.length === 0)
        invalid(`targeted command "${name}" must declare its admitted authorization modes (SPEC 13.7)`);
      const uniq = new Set<string>();
      for (const m of cmd.modes) {
        if (typeof m !== "string" || !isEpAuthzMode(m)) invalid(`command "${name}" admits unknown mode ${JSON.stringify(m)}`);
        if (uniq.has(m)) invalid(`command "${name}" admits mode "${m}" twice`);
        uniq.add(m);
      }
      modes = [...(cmd.modes as EpAuthzMode[])];
    } else if (cmd.modes !== undefined) {
      invalid(`untargeted command "${name}" must not declare authorization modes`);
    }
    if (typeof cmd.capability !== "string" || !CAPABILITY.test(cmd.capability)) invalid(`command "${name}" capability is not a bounded capability token`);
    if (!isDigest(cmd.inputDigest)) invalid(`command "${name}" inputDigest is not a sha256 closure digest`);
    if (!isDigest(cmd.outputDigest)) invalid(`command "${name}" outputDigest is not a sha256 closure digest`);
    let traits: string[] | undefined;
    if (cmd.traits !== undefined) {
      if (!Array.isArray(cmd.traits)) invalid(`command "${name}" traits is not an array`);
      const tSeen = new Set<string>();
      for (const t of cmd.traits) {
        if (typeof t !== "string" || !URN.test(t)) invalid(`command "${name}" trait ${JSON.stringify(t)} is not a reverse-DNS trait URN (SPEC 13.7)`);
        if (tSeen.has(t)) invalid(`command "${name}" declares trait "${t}" twice`);
        tSeen.add(t);
      }
      traits = [...(cmd.traits as string[])];
    }
    // THE ACTION COMPOSITE. `action` is present-or-absent, never `false`: two ways to say "not an
    // action" is a second source for one fact, and the reader would have to know which one this
    // document used. Presence is CLOSED per command — a parser decides `action`, `admissionCeiling`
    // and `readinessDeadlineMs` from the current bytes with no knowledge of who wrote them.
    let action: true | undefined;
    if (cmd.action !== undefined) {
      if (cmd.action !== true)
        invalid(`command "${name}" action ${JSON.stringify(cmd.action)} is not true (the action composite is present or absent; "false" is a second way to say absent)`);
      if (cmd.class !== "journal")
        invalid(`command "${name}" declares the action composite but class "${cmd.class}": an action command's submissions are journal-class (SPEC 13.7)`);
      action = true;
    }
    // THE CEILING KEYS ON THE CLASS, NEVER ON THE MARKER (SPEC §13.7). The MUST is on an
    // endpoint that accepts JOURNAL-CLASS SUBMISSIONS, and the action composite is a marker on top
    // of that class rather than the thing that creates it — so a `class: "journal"` command with no
    // marker receives submissions exactly like an action command does. This keyed on `action` and
    // therefore did two wrong things to that command at once: it required no ceiling, and it
    // REFUSED one, on the stated ground that the command "cannot receive" submissions. That ground
    // was false two files away — `endpoint-service.ts` derives the journal rail's bind rows from
    // `class === "journal"` across the surface (`journalClass`), and refuses a non-journal class at
    // the virtual-endpoint seam; neither reads the marker.
    let admissionCeiling: EpAdmissionCeiling | undefined;
    if (cmd.class === "journal") {
      const ceil = isRec(cmd.admissionCeiling) ? cmd.admissionCeiling : invalid(`journal-class command "${name}" must declare admissionCeiling {maxBytes, maxDepth, maxItems}: the canonicalizer reads its ceilings from the digest-verified surface, never from a constant`);
      const nums: Record<string, number> = {};
      for (const f of ["maxBytes", "maxDepth", "maxItems"] as const) {
        const v = ceil[f];
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0)
          invalid(`command "${name}" admissionCeiling.${f} ${JSON.stringify(v)} is not a positive safe integer`);
        nums[f] = v;
      }
      admissionCeiling = { maxBytes: nums.maxBytes, maxDepth: nums.maxDepth, maxItems: nums.maxItems };
    } else if (cmd.admissionCeiling !== undefined) {
      invalid(`ephemeral command "${name}" declares admissionCeiling: an ephemeral command receives no journal submissions, so a ceiling on it is unreadable by anything`);
    }
    let readinessDeadlineMs: number | undefined;
    if (cmd.readinessDeadlineMs !== undefined) {
      if (!action)
        invalid(`command "${name}" declares readinessDeadlineMs without the action composite: readiness is goal state and only an action command has a goal`);
      if (typeof cmd.readinessDeadlineMs !== "number" || !Number.isSafeInteger(cmd.readinessDeadlineMs) || cmd.readinessDeadlineMs < 0)
        invalid(`command "${name}" readinessDeadlineMs ${JSON.stringify(cmd.readinessDeadlineMs)} is not a non-negative safe integer (SPEC 13.11)`);
      readinessDeadlineMs = cmd.readinessDeadlineMs;
    }
    return {
      name, class: cmd.class, targeted: cmd.targeted,
      ...(modes ? { modes } : {}),
      capability: cmd.capability, inputDigest: cmd.inputDigest, outputDigest: cmd.outputDigest,
      ...(traits ? { traits } : {}),
      ...(action ? { action } : {}),
      ...(admissionCeiling ? { admissionCeiling } : {}),
      ...(readinessDeadlineMs !== undefined ? { readinessDeadlineMs } : {}),
    };
  });
  return { urn: o.urn, revision: o.revision, attributes: [...o.attributes], commands, events: [...o.events] };
}

/** The §13.7 closure MANIFEST `{ v: 1, root: <artifactDigest>, members: [<artifactDigest>…] }`.
 *  A closure digest is the artifact digest of THIS document, never of the root cluster document
 *  ("two digests, never conflated", §13.7): a reader fetches the manifest at the registered
 *  closure digest, then fetches the root at `manifest.root`. */
export interface ClusterManifest {
  root: string;
  members: string[];
}

/** Verify fetched MANIFEST bytes against the registered closure digest and parse them (§13.7:
 *  the closure digest identifies the manifest, not the root document). P1 pins single-document
 *  clusters, so `members` MUST be empty — a non-empty closure needs the D8 multi-artifact
 *  loader and fails loud until then, never silently under-verified. */
export function verifyClusterManifest(closureDigest: string, manifest: unknown): ClusterManifest {
  if (!isDigest(closureDigest)) throw new ContractInvalidError(`${JSON.stringify(closureDigest)} is not a sha256 closure digest`);
  const actual = contractDigest(manifest);
  if (actual !== closureDigest)
    throw new ContractInvalidError(`cluster manifest does not hash to its registered closure digest ${closureDigest} (content is ${actual}); a reader MUST verify fetched bytes and fail loud (SPEC 13.7)`);
  const o = isRec(manifest) ? manifest : invalid("manifest is not an object");
  if (o.v !== 1) invalid(`manifest v ${JSON.stringify(o.v)} is not 1`);
  if (!isDigest(o.root)) invalid("manifest root is not a sha256 artifact digest");
  if (!Array.isArray(o.members)) invalid("manifest members is not an array");
  if (o.members.length !== 0)
    throw new ContractInvalidError(`cluster closure ${closureDigest} has ${o.members.length} member(s); multi-artifact closures need the D8 loader and are refused until then (SPEC 13.7), never partially verified`);
  return { root: o.root, members: [] };
}

/** Verify fetched ROOT cluster-document bytes against the manifest's `root` artifact digest and
 *  parse the command surface — the second half of the §13.7 two-digest read; a document that
 *  does not hash to `root` fails loud, never parses. */
export function verifyClusterRoot(rootDigest: string, document: unknown): ClusterDocument {
  if (!isDigest(rootDigest)) throw new ContractInvalidError(`${JSON.stringify(rootDigest)} is not a sha256 artifact digest`);
  const actual = contractDigest(document);
  if (actual !== rootDigest)
    throw new ContractInvalidError(`cluster document does not hash to its manifest root ${rootDigest} (content is ${actual}); a reader MUST verify fetched bytes and fail loud (SPEC 13.7)`);
  return parseClusterDocument(document);
}

// ---- the derived descriptor (§13.7 "Descriptor and describe") ----------------------------------

/** The authoritative describe answer's descriptor: identity plus the served clusters, each
 *  inline (`document`) or by digest (§13.7). Derived from VERIFIED registered bytes by
 *  {@link deriveDescriptor} — never hand-authored. */
export interface DescribeDescriptor {
  endpoint: string;
  owner: string;
  endpointType?: string;
  protocol: { v: 1 };
  clusters: { digest: string; commands: string[]; document?: Record<string, unknown> }[];
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

/** Derive the instance's AUTHORITATIVE descriptor from its registered identity and VERIFIED
 *  cluster documents — the FULL registered surface (SPEC §13.9: the instance credential binds
 *  its registered command set; caller-specific authorization is projected only in the
 *  response-time describe answer, §13.7, never baked into the registration). Every cluster
 *  advertises exactly its verified commands and carries its verified document inline. Deep-
 *  frozen: discovery is a projection of registered bytes, and no later mutation can change what
 *  describe publishes. */
export function deriveDescriptor(
  identity: { endpoint: string; owner: string; endpointType?: string },
  clusters: { digest: string; document: ClusterDocument; raw: Record<string, unknown> }[],
): DescribeDescriptor {
  endpointToken(identity.endpoint);
  assertBoundedOwner(identity.owner, "descriptor owner");
  if (clusters.length === 0) throw new ContractInvalidError("a descriptor needs at least one registered cluster");
  return deepFreeze({
    endpoint: identity.endpoint,
    owner: identity.owner,
    ...(identity.endpointType !== undefined ? { endpointType: identity.endpointType } : {}),
    protocol: { v: 1 as const },
    clusters: clusters.map((c) => ({
      digest: c.digest,
      commands: c.document.commands.map((cmd) => cmd.name),
      document: structuredClone(c.raw),
    })),
  });
}

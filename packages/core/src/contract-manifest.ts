/**
 * The §13.7 closure MANIFEST, its one builder and its one parser, split out of the contract store
 * so `schema-profile` can build `VOID_SCHEMA_DIGEST` with the builder at module load: the store
 * imports `endpoint-envelope`, which imports `schema-profile`, so a builder read from the store
 * there may not have evaluated yet. `endpoint-contract-store.ts` re-exports the public names here,
 * so no consumer's import path changes.
 */
import { isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";

const HEX64 = /^[0-9a-f]{64}$/;

/** Normalize a digest reference (`<hex>` or `sha256:<hex>`) to the bare subject token; a
 *  malformed reference fails loud (a garbled ref never fetches an unintended subject). */
export function contractRefToHex(ref: string): string {
  const hex = ref.startsWith("sha256:") ? ref.slice("sha256:".length) : ref;
  if (!HEX64.test(hex))
    throw new EpEnvelopeError("contract-invalid", `contract reference ${JSON.stringify(ref)} is not a sha256 digest; a garbled reference never resolves (SPEC 13.7)`);
  return hex;
}

/** The §13.7 closure MANIFEST artifact: contract identity is THIS artifact's digest (the
 *  closure digest), never the root document digest alone. Digest fields carry the one scalar
 *  shape `sha256:<hex>`. */
export interface ContractClosureManifest {
  v: 1;
  root: string;
  /** Every artifact transitively reachable through by-digest references from `root` (the root
   *  appears only if a reference re-reaches it), sorted lexicographically, deduplicated. */
  members: string[];
}

export const sha256Ref = (hex: string): string => `sha256:${hex}`;

/** Build the canonical manifest for a walked closure: refs normalize, members sort + dedup.
 *  The ROOT is named by its own field and belongs in `members` only when a reference
 *  re-reaches it (the §13.7 "reachable THROUGH references" rule, pinned here so two
 *  implementations always mint the identical manifest). */
export function buildContractClosureManifest(rootRef: string, memberRefs: readonly string[]): ContractClosureManifest {
  const root = sha256Ref(contractRefToHex(rootRef));
  const members = [...new Set(memberRefs.map((r) => sha256Ref(contractRefToHex(r))))].sort();
  return { v: 1, root, members };
}

/** The artifact-count ceiling: a walk that would exceed it fails loud, never truncates. */
export const CONTRACT_CLOSURE_MAX_ARTIFACTS = 64;

/** A manifest digest field is EXACTLY `sha256:<64-hex>` (frozen SPEC 13.7), never a
 *  bare `<hex>` or any other spelling (distsys 8dcad72 HIGH): two manifests differing only in
 *  digest spelling are both canonical JSON, receive DIFFERENT closure digests, yet verify the same
 *  walked graph - so one closure would have two identities. Normalization belongs in the BUILDER's
 *  input; the consuming parse requires the canonical prefixed form and refuses anything else. */
function assertManifestDigest(ref: unknown, what: string): void {
  if (typeof ref !== "string" || !isContractDigest(ref))
    throw new EpEnvelopeError("contract-invalid", `${what} must be exactly "sha256:<64-hex>" (SPEC 13.7); a bare-hex or otherwise-spelled digest gives one closure two identities and never names it`);
}

/** The one consuming parse of a closure manifest. Every reader goes through it, so no reader admits
 *  a manifest another refuses and one root never verifies under two closure digests. */
export function parseClosureManifest(value: unknown, what: string): ContractClosureManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new EpEnvelopeError("contract-invalid", `${what} is not a manifest object (SPEC 13.7)`);
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!["v", "root", "members"].includes(k))
      throw new EpEnvelopeError("contract-invalid", `${what} carries the unknown field "${k}"; the manifest schema is closed (SPEC 13.7)`);
  if (o.v !== 1 || typeof o.root !== "string" || !Array.isArray(o.members))
    throw new EpEnvelopeError("contract-invalid", `${what} is not { v: 1, root, members } (SPEC 13.7)`);
  assertManifestDigest(o.root, `${what} root`);
  if (o.members.length > CONTRACT_CLOSURE_MAX_ARTIFACTS)
    throw new EpEnvelopeError("contract-invalid", `${what} names ${o.members.length} members, above the ${CONTRACT_CLOSURE_MAX_ARTIFACTS}-artifact ceiling (SPEC 13.7)`);
  for (let i = 0; i < o.members.length; i++) {
    const m = o.members[i];
    assertManifestDigest(m, `${what} member ${i}`);
    // The canonical form IS sorted + deduplicated: an unsorted or duplicated members list is a
    // DIFFERENT byte sequence claiming the same closure — refused, never silently normalized.
    if (i > 0 && (o.members[i - 1] as string) >= m)
      throw new EpEnvelopeError("contract-invalid", `${what} members are not strictly sorted/deduplicated at index ${i}; a noncanonical manifest never names a closure (SPEC 13.7)`);
  }
  return { v: 1, root: o.root, members: o.members as string[] };
}

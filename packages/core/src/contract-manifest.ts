/**
 * The §13.7 closure MANIFEST and its one builder, split out of the contract store so
 * `schema-profile` can build `VOID_SCHEMA_DIGEST` with it at module load: the store imports
 * `endpoint-envelope`, which imports `schema-profile`, so a builder read from the store there may
 * not have evaluated yet. `endpoint-contract-store.ts` re-exports the public names here, so no
 * consumer's import path changes.
 */
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

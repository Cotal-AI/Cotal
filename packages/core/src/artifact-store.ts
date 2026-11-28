/**
 * The artifact store contract (artifact plane 0.4; kind name a draft). Where an artifact's bytes sit
 * is a registered store. The delivery daemon keeps every authorization decision and all three index
 * stores, and reads and writes bytes only through this contract. A space is bound to one store by
 * name. A name nobody registered refuses, and nothing falls back to another store.
 *
 * The contract knows blocks, byte ranges and digests. It names no transport: a store gets the
 * handles the daemon holds for the space as an opaque map, and reads only the entries it needs.
 */
import type { Extension } from "./registry.js";

/** Draft name, one constant so a rename is one line. */
export const ARTIFACT_STORE_KIND = "artifact-store";

/** The largest block a store may write in, and the largest range one `read` may ask for. */
export const ARTIFACT_STORE_MAX_BLOCK_BYTES = 1024 * 1024;

/** A stored artifact: what the store verified, not what any message claims. */
export interface ArtifactStoreRecord {
  /** `sha256:<hex>`. */
  digest: string;
  /** Bytes. */
  size: number;
  /** How many stored blocks hold the bytes, as recorded at commit: `ceil(size / blockBytes)`. */
  blocks: number;
  name: string;
  mediaType: string;
}

/** Called immediately before one write or removal effect. Throws to stop it. */
export type ArtifactStoreGuard = (what: string) => void;

/** One space's store, opened over the handles the daemon holds for that space. */
export interface ArtifactStoreSpace {
  /** The block size this store writes in: the value its {@link ArtifactStore.blockBytes} declares. */
  readonly blockBytes: number;
  /** Why this store cannot hold an artifact of `size` bytes now, or undefined. Takes the size only,
   *  never a digest, so it cannot answer whether an artifact exists. A size and transport check, not
   *  admission. Asked before staging and again before a commit's first write. */
  admits(size: number): string | undefined;
  /** Write bytes already hashed to `record.digest`, in blocks of `blockBytes`. `guard` runs
   *  immediately before every write. Create-only: a block already stored must hold the same bytes,
   *  else the write refuses before its commit record; an existing commit record is kept. A limit
   *  that moved since `admits` refuses with outcome unknown. */
  put(record: Omit<ArtifactStoreRecord, "blocks" | "size">, blocks: readonly Uint8Array[], guard: ArtifactStoreGuard): Promise<ArtifactStoreRecord>;
  /** The committed record, or undefined (absent, deleted, or a commit that never finished). */
  stat(digest: string): Promise<ArtifactStoreRecord | undefined>;
  /** Exactly `length` bytes of `digest` starting at byte `offset`, at any offset and any length
   *  inside the artifact, or undefined when any of those bytes is gone. `length` is a positive
   *  integer of at most {@link ARTIFACT_STORE_MAX_BLOCK_BYTES}, and `offset + length` is at most the
   *  artifact's size; a range outside that refuses rather than reading past the end. */
  read(digest: string, offset: number, length: number): Promise<Uint8Array | undefined>;
  /** Remove the commit record. Idempotent. After it, `stat` answers undefined. `guard` runs
   *  immediately before the removal's effect, after any setup the store awaits. */
  removeRecord(digest: string, guard: ArtifactStoreGuard): Promise<void>;
  /** Remove the bytes. Idempotent. `guard` runs as for {@link removeRecord}. A cut between the two
   *  removals leaves bytes that {@link digests} still finds. */
  removeBytes(digest: string, guard: ArtifactStoreGuard): Promise<void>;
  /** Every digest the store holds anything for, committed or not (a blocks-only cut included).
   *  Names only, no bytes. */
  digests(): Promise<string[]>;
  /** Prove this store is reachable with the handles it was opened over, refusing by name. */
  prove(): Promise<void>;
}

/** The opaque handles a store opens over. The daemon passes what it holds; a store reads only the
 *  entries it needs and refuses by name when one is missing. Core gives this no shape beyond a map. */
export type ArtifactStoreHandles = Readonly<Record<string, unknown>>;

/** A byte store for artifacts, registered under {@link ARTIFACT_STORE_KIND}. */
export interface ArtifactStore extends Extension {
  readonly kind: typeof ARTIFACT_STORE_KIND;
  /** The storage block size this store writes in: a positive integer of at most
   *  {@link ARTIFACT_STORE_MAX_BLOCK_BYTES}. The daemon checks it once, when it resolves the store. */
  readonly blockBytes: number;
  open(space: string, handles: ArtifactStoreHandles): ArtifactStoreSpace;
}

/** Whether `n` is a block size a store may declare. */
export function isArtifactStoreBlockBytes(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= ARTIFACT_STORE_MAX_BLOCK_BYTES;
}

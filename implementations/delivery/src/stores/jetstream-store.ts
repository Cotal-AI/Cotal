/**
 * The `jetstream` artifact store (plan section 4, C5; security S2, S10; A2): the default store, the
 * space's own object stream on the broker. It is the A1 object code, moved behind the
 * `artifact-store` contract and not rewritten.
 *
 * Layout: chunk `i` of digest `h` is the one message on `$O.<obj>.C.<h>.<i>`, every chunk but the last
 * {@link ARTIFACT_STORE_CHUNK_BYTES} long whatever transport chunks carried the bytes, and the meta
 * record `{size, chunks, digest, name, mediaType}` is the one message on the stock meta subject
 * `$O.<obj>.M.<base64url("sha256:<h>")>`. Every write is create-only. Every read is a
 * last-by-subject DIRECT.GET on a named subject: no consumer, no enumeration, and no body that can
 * select another subject (the credential holds only the subject-scoped direct-get row, never the bare
 * one a `seq` read needs).
 *
 * Bytes are hashed BEFORE the meta record is written (S2): the meta record is the commit, and it is
 * written only for bytes this service hashed to the digest the caller declared. A crash between the
 * chunks and the meta leaves chunks with no meta, which the sweep reclaims behind its reservation.
 *
 * The store opens over two handles. Reads and writes use `data` (the `artifact-data` credential). The
 * delete side (filtered purges by subject) and the inventory (`STREAM.INFO` with a subjects filter)
 * use `sweeper` (the `artifact-sweeper` credential), which holds no `$O` publish and no read of object
 * bytes. Neither handle stands in for the other.
 */
import { headers, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import {
  ARTIFACT_STORE_KIND, ARTIFACT_STORE_MAX_BLOCK_BYTES, artifactBucket, EpEnvelopeError, isCasLoss, objectStoreStream, registry,
  type ArtifactStore, type ArtifactStoreGuard, type ArtifactStoreHandles, type ArtifactStoreRecord, type ArtifactStoreSpace,
} from "@cotal-ai/core";
import { digestToken } from "../artifact-keys.js";
import { JETSTREAM_ARTIFACT_STORE } from "./jetstream-name.js";

/** The commit record: what the store verified, not what any message claims. The stored JSON keeps
 *  its `chunks` key; in memory the count is the contract's `blocks`. */
export type ArtifactMeta = ArtifactStoreRecord;

/** The size of every stored chunk but the last (E17). Storage framing is fixed and independent of how
 *  the bytes arrived: one digest names one byte string, so it names one chunk at every index, and a
 *  re-put or a retry of a partial commit writes exactly the chunks already there. */
export const ARTIFACT_STORE_CHUNK_BYTES = 64 * 1024;

/** Headroom under the data connection's `max_payload` for a chunk publish's headers. */
const STORE_HEADER_ALLOWANCE = 1024;

/** How many stored chunks an artifact of `size` bytes has, and the length of chunk `index`. */
export function storedChunkCount(size: number): number {
  return Math.ceil(size / ARTIFACT_STORE_CHUNK_BYTES);
}
export function storedChunkLength(size: number, index: number): number {
  return Math.min(ARTIFACT_STORE_CHUNK_BYTES, size - index * ARTIFACT_STORE_CHUNK_BYTES);
}

/** Base64url with padding, the stock object store's encoding for meta subject names. */
const paddedBase64Url = (text: string): string => Buffer.from(text).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

/** `$O.<obj>.C.<h>.<i>`: chunk `index` of `digest`. */
export function chunkSubject(space: string, digest: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`chunk index ${index} is not an unsigned integer`);
  return `$O.${artifactBucket(space)}.C.${digestToken(digest)}.${index}`;
}

/** `$O.<obj>.C.<h>.>`: every chunk of `digest`, the filter one purge removes them by. */
export function chunkFilter(space: string, digest: string): string {
  return `$O.${artifactBucket(space)}.C.${digestToken(digest)}.>`;
}

/** The stock meta subject for `digest`. */
export function metaSubject(space: string, digest: string): string {
  return `$O.${artifactBucket(space)}.M.${paddedBase64Url(`sha256:${digestToken(digest)}`)}`;
}

/** The digest a meta subject names, or `undefined` for one this layout did not write. */
export function digestOfMetaSubject(space: string, subject: string): string | undefined {
  const prefix = `$O.${artifactBucket(space)}.M.`;
  if (!subject.startsWith(prefix)) return undefined;
  const name = Buffer.from(subject.slice(prefix.length), "base64url").toString();
  return /^sha256:[0-9a-f]{64}$/.test(name) ? name : undefined;
}

/** The digest a chunk subject names, or `undefined` for one this layout did not write. */
export function digestOfChunkSubject(space: string, subject: string): string | undefined {
  const m = new RegExp(`^\\$O\\.${artifactBucket(space).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.C\\.([0-9a-f]{64})\\.\\d+$`).exec(subject);
  return m ? `sha256:${m[1]}` : undefined;
}

/** The store over one space's `artifact-data` and `artifact-sweeper` connections. */
export class ArtifactObjects implements ArtifactStoreSpace {
  readonly blockBytes = ARTIFACT_STORE_CHUNK_BYTES;
  private jsm?: JetStreamManager;
  private sweeperJsm?: JetStreamManager;
  constructor(private readonly nc: NatsConnection, private readonly space: string, private readonly sweeper: NatsConnection) {}

  private async manager(): Promise<JetStreamManager> {
    // `checkAPI: false`: the credential holds no account-info read beyond `$JS.API.INFO`, and needs none.
    this.jsm ??= await jetstreamManager(this.nc, { checkAPI: false });
    return this.jsm;
  }

  private async sweeperManager(): Promise<JetStreamManager> {
    this.sweeperJsm ??= await jetstreamManager(this.sweeper, { checkAPI: false });
    return this.sweeperJsm;
  }

  /** The commit record, or `undefined` when the digest has no live meta. A last-by-subject direct get. */
  async stat(digest: string): Promise<ArtifactMeta | undefined> {
    const m = await (await this.manager()).direct.getMessage(objectStoreStream(artifactBucket(this.space)), { last_by_subj: metaSubject(this.space, digest) });
    if (m === null) return undefined;
    let o: Partial<Omit<ArtifactMeta, "blocks">> & { chunks?: number; deleted?: boolean };
    try { o = JSON.parse(m.string()); } catch { return undefined; }
    if (o.deleted === true || o.digest !== digest || !Number.isSafeInteger(o.size) || !Number.isSafeInteger(o.chunks)
      || typeof o.name !== "string" || typeof o.mediaType !== "string") return undefined;
    return { digest, size: o.size!, blocks: o.chunks!, name: o.name, mediaType: o.mediaType };
  }

  /** Chunk `index` of `digest`, or `undefined` when it is gone. A last-by-subject direct get. */
  private async readChunk(digest: string, index: number): Promise<Uint8Array | undefined> {
    const m = await (await this.manager()).direct.getMessage(objectStoreStream(artifactBucket(this.space)), { last_by_subj: chunkSubject(this.space, digest, index) });
    return m === null ? undefined : m.data;
  }

  /** Bytes `[offset, offset + length)` of `digest`: one direct get per stored chunk the range touches,
   *  sliced and joined, or `undefined` as soon as one is gone. A range that is not a positive length
   *  of at most 1 MiB at a non-negative offset refuses, and so does a range past the artifact's end.
   *  The end is known without an extra read while the chunks are there: a chunk shorter than the
   *  range needs is the last one. Only when a chunk is missing does the store read the commit record,
   *  to tell a range past the end (refused) from bytes that are gone (`undefined`). So the handler's
   *  aligned read stays one direct get. */
  async read(digest: string, offset: number, length: number): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > ARTIFACT_STORE_MAX_BLOCK_BYTES)
      throw new Error(`artifacts: the jetstream store cannot read ${length} bytes at offset ${offset}`);
    const pastEnd = () => new Error(`artifacts: ${digest} ends before byte ${offset + length}; the range is past the artifact`);
    const first = Math.floor(offset / ARTIFACT_STORE_CHUNK_BYTES), last = Math.floor((offset + length - 1) / ARTIFACT_STORE_CHUNK_BYTES);
    const parts: Uint8Array[] = [];
    for (let i = first; i <= last; i++) {
      const c = await this.readChunk(digest, i);
      if (c === undefined) {
        const meta = await this.stat(digest);
        if (meta !== undefined && offset + length > meta.size) throw pastEnd();
        return undefined;
      }
      const from = i === first ? offset - i * ARTIFACT_STORE_CHUNK_BYTES : 0;
      const to = i === last ? offset + length - i * ARTIFACT_STORE_CHUNK_BYTES : c.byteLength;
      if (to > c.byteLength || (i < last && c.byteLength !== ARTIFACT_STORE_CHUNK_BYTES)) throw pastEnd();
      parts.push(from === 0 && to === c.byteLength ? c : c.subarray(from, to));
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  /** Why this connection cannot store an artifact of `size` bytes, or `undefined` when it can: the
   *  broker's message limit must carry the artifact's largest stored chunk (`size` up to
   *  {@link ARTIFACT_STORE_CHUNK_BYTES}) plus {@link STORE_HEADER_ALLOWANCE} bytes of headers (E23). Asked at
   *  `put-begin`, before any byte is staged, and again under the commit's digest lock, before its
   *  reservation. */
  admits(size: number): string | undefined {
    const max = this.nc.info?.max_payload;
    const need = Math.min(size, ARTIFACT_STORE_CHUNK_BYTES) + STORE_HEADER_ALLOWANCE;
    return typeof max === "number" && max < need
      ? `the broker's payload limit is too small for this artifact: its max_payload is ${max} bytes, and storing ${size} bytes needs at least ${need} (the largest stored chunk plus ${STORE_HEADER_ALLOWANCE} bytes of headers)`
      : undefined;
  }

  /** Write `blocks`, the bytes of `meta.digest` in storage framing, then its meta record. The caller
   *  has already hashed the bytes to the digest. `guard` runs before every publish, so the serve fence
   *  can refuse a write that has not started. Blocks not in storage framing (every block but the last
   *  exactly {@link ARTIFACT_STORE_CHUNK_BYTES}, none empty) are refused before any publish.
   *
   *  Every publish is create-only (expected last subject sequence 0), so nothing is ever stacked or
   *  replaced. A chunk subject that already holds a message is read back and must hold exactly these
   *  bytes: the framing is fixed, so an equal chunk is the same commit's, and a different one means
   *  the subject holds something this layout did not write, which refuses the commit before its meta
   *  record. A meta record already there must describe the same size and chunk count; it is kept as
   *  it is (E17). */
  async put(meta: Omit<ArtifactMeta, "blocks" | "size">, blocks: readonly Uint8Array[], guard: ArtifactStoreGuard): Promise<ArtifactMeta> {
    const size = blocks.reduce((n, b) => n + b.byteLength, 0);
    if (blocks.some((b, i) => b.byteLength !== storedChunkLength(size, i)) || blocks.length !== storedChunkCount(size))
      throw new Error(`the bytes of ${meta.digest} are not in storage framing; nothing was written`);
    // The caller checked the same limit before its reservation; a limit that moved in between is a
    // failure after that write, so it says so.
    const tooSmall = this.admits(size);
    if (tooSmall !== undefined) throw new EpEnvelopeError("resource-exhausted", tooSmall, undefined, "unknown");
    const js = jetstream(this.nc);
    const record: ArtifactMeta = { ...meta, size, blocks: blocks.length };
    // The stored JSON keeps A1's `chunks` key, so nothing already stored changes shape.
    const stored = { digest: record.digest, name: record.name, mediaType: record.mediaType, size, chunks: blocks.length };
    const createOnly = () => { const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0"); return h; };
    for (const [i, chunk] of blocks.entries()) {
      guard(`chunk ${i}`);
      try { await js.publish(chunkSubject(this.space, meta.digest, i), chunk, { headers: createOnly() }); }
      catch (e) {
        if (!isCasLoss(e)) throw e;
        const there = await this.readChunk(meta.digest, i);
        if (there === undefined || Buffer.compare(Buffer.from(there), Buffer.from(chunk)) !== 0)
          throw new Error(`chunk ${i} of ${meta.digest} already holds different bytes; nothing was committed over it`);
      }
    }
    guard("the meta record");
    try { await js.publish(metaSubject(this.space, meta.digest), JSON.stringify(stored), { headers: createOnly() }); }
    catch (e) {
      if (!isCasLoss(e)) throw e;
      const there = await this.stat(meta.digest);
      if (there === undefined || there.size !== record.size || there.blocks !== record.blocks)
        throw new Error(`the meta record of ${meta.digest} already describes ${there ? `${there.size} bytes in ${there.blocks} chunks` : "something unreadable"}; nothing was committed over it`);
      return there;
    }
    return record;
  }

  /** Purge `digest`'s meta subject on the sweeper connection. The guard runs after the manager is
   *  ready and immediately before the purge request (E18, E9). */
  async removeRecord(digest: string, guard: ArtifactStoreGuard): Promise<void> {
    const jsm = await this.sweeperManager();
    guard("the meta purge");
    await jsm.streams.purge(objectStoreStream(artifactBucket(this.space)), { filter: metaSubject(this.space, digest) });
  }

  /** Purge every chunk subject of `digest` on the sweeper connection, guarded as {@link removeRecord}. */
  async removeBytes(digest: string, guard: ArtifactStoreGuard): Promise<void> {
    const jsm = await this.sweeperManager();
    guard("the chunk purge");
    await jsm.streams.purge(objectStoreStream(artifactBucket(this.space)), { filter: chunkFilter(this.space, digest) });
  }

  /** Every digest with a chunk or a meta subject in the object stream, from `STREAM.INFO` subject
   *  counts on the sweeper connection: names only, no object bytes. */
  async digests(): Promise<string[]> {
    const jsm = await this.sweeperManager();
    const out = new Set<string>();
    const info = await jsm.streams.info(objectStoreStream(artifactBucket(this.space)), { subjects_filter: `$O.${artifactBucket(this.space)}.>` });
    for (const subject of Object.keys(info.state.subjects ?? {})) {
      const d = digestOfChunkSubject(this.space, subject) ?? digestOfMetaSubject(this.space, subject);
      if (d) out.add(d);
    }
    return [...out];
  }

  /** The object stream's `STREAM.INFO` on the data connection, with A1's refusal text. */
  async prove(): Promise<void> {
    const stream = objectStoreStream(artifactBucket(this.space));
    try { await (await this.manager()).streams.info(stream); }
    catch (e) { throw new Error(`artifact-data cannot read stream ${stream} (${(e as Error).message})`); }
  }
}

/** A handle the jetstream store needs, by name, or a refusal naming it. */
function connectionHandle(handles: ArtifactStoreHandles, name: "data" | "sweeper"): NatsConnection {
  const h = handles[name];
  if (h === null || typeof h !== "object") throw new Error(`artifacts: the jetstream store needs its "${name}" handle`);
  return h as NatsConnection;
}

/** The `jetstream` store: one space's object stream, over its `data` and `sweeper` connections. */
export const jetstreamArtifactStore: ArtifactStore = {
  kind: ARTIFACT_STORE_KIND,
  name: JETSTREAM_ARTIFACT_STORE,
  blockBytes: ARTIFACT_STORE_CHUNK_BYTES,
  open(space, handles) {
    return new ArtifactObjects(connectionHandle(handles, "data"), space, connectionHandle(handles, "sweeper"));
  },
};

registry.register(jetstreamArtifactStore);

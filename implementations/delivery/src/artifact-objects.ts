/**
 * The artifacts service's object store layer (plan section 4, C5; security S2, S10).
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
 * The delete side (filtered purges by subject) lives in the sweep, on the sweeper credential, which
 * holds no `$O` publish and no read of object bytes.
 */
import { headers, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { artifactBucket, EpEnvelopeError, isCasLoss, objectStoreStream } from "@cotal-ai/core";
import { digestToken } from "./artifact-keys.js";

/** The commit record: what the store verified, not what any message claims. */
export interface ArtifactMeta {
  digest: string;
  size: number;
  chunks: number;
  name: string;
  mediaType: string;
}

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

/** The store over one `artifact-data` connection. */
export class ArtifactObjects {
  private jsm?: JetStreamManager;
  constructor(private readonly nc: NatsConnection, private readonly space: string) {}

  private async manager(): Promise<JetStreamManager> {
    // `checkAPI: false`: the credential holds no account-info read beyond `$JS.API.INFO`, and needs none.
    this.jsm ??= await jetstreamManager(this.nc, { checkAPI: false });
    return this.jsm;
  }

  /** The commit record, or `undefined` when the digest has no live meta. A last-by-subject direct get. */
  async readMeta(digest: string): Promise<ArtifactMeta | undefined> {
    const m = await (await this.manager()).direct.getMessage(objectStoreStream(artifactBucket(this.space)), { last_by_subj: metaSubject(this.space, digest) });
    if (m === null) return undefined;
    let o: Partial<ArtifactMeta> & { deleted?: boolean };
    try { o = JSON.parse(m.string()); } catch { return undefined; }
    if (o.deleted === true || o.digest !== digest || !Number.isSafeInteger(o.size) || !Number.isSafeInteger(o.chunks)
      || typeof o.name !== "string" || typeof o.mediaType !== "string") return undefined;
    return { digest, size: o.size!, chunks: o.chunks!, name: o.name, mediaType: o.mediaType };
  }

  /** Chunk `index` of `digest`, or `undefined` when it is gone. A last-by-subject direct get. */
  async readChunk(digest: string, index: number): Promise<Uint8Array | undefined> {
    const m = await (await this.manager()).direct.getMessage(objectStoreStream(artifactBucket(this.space)), { last_by_subj: chunkSubject(this.space, digest, index) });
    return m === null ? undefined : m.data;
  }

  /** Why this connection cannot store an artifact of `size` bytes, or `undefined` when it can: the
   *  broker's message limit must carry the artifact's largest stored chunk (`size` up to
   *  {@link ARTIFACT_STORE_CHUNK_BYTES}) plus {@link STORE_HEADER_ALLOWANCE} bytes of headers (E23). Asked at
   *  `put-begin`, before any byte is staged, and again under the commit's digest lock, before its
   *  reservation. */
  storeRefusal(size: number): string | undefined {
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
  async write(meta: Omit<ArtifactMeta, "chunks" | "size">, blocks: readonly Uint8Array[], guard: (what: string) => void): Promise<ArtifactMeta> {
    const size = blocks.reduce((n, b) => n + b.byteLength, 0);
    if (blocks.some((b, i) => b.byteLength !== storedChunkLength(size, i)) || blocks.length !== storedChunkCount(size))
      throw new Error(`the bytes of ${meta.digest} are not in storage framing; nothing was written`);
    // The caller checked the same limit before its reservation; a limit that moved in between is a
    // failure after that write, so it says so.
    const tooSmall = this.storeRefusal(size);
    if (tooSmall !== undefined) throw new EpEnvelopeError("resource-exhausted", tooSmall, undefined, "unknown");
    const js = jetstream(this.nc);
    const record: ArtifactMeta = { ...meta, size, chunks: blocks.length };
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
    try { await js.publish(metaSubject(this.space, meta.digest), JSON.stringify(record), { headers: createOnly() }); }
    catch (e) {
      if (!isCasLoss(e)) throw e;
      const there = await this.readMeta(meta.digest);
      if (there === undefined || there.size !== record.size || there.chunks !== record.chunks)
        throw new Error(`the meta record of ${meta.digest} already describes ${there ? `${there.size} bytes in ${there.chunks} chunks` : "something unreadable"}; nothing was committed over it`);
      return there;
    }
    return record;
  }
}

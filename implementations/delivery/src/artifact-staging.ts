/**
 * Staged uploads of the `artifacts` endpoint, held in daemon memory until commit (A1, plan section 5;
 * engineering E17 and E20).
 *
 * Bytes are staged directly in storage framing: full blocks of {@link ARTIFACT_STORE_CHUNK_BYTES} and
 * one partly filled tail, whatever transport chunks carried them. So what is committed is independent of
 * how the caller cut its upload (E17), and the bookkeeping is bounded by the declared size, not by the
 * number of `put-chunk` calls: at most `size / ARTIFACT_STORE_CHUNK_BYTES + 1` blocks.
 *
 * The charge (E20). A caller lifecycle's uploads are charged their declared size at `put-begin`, and the
 * charge is held until the upload's buffers are released: an upload that is committing stays charged,
 * and counted, until its commit settles. So overlapping commits cannot refill the bound while earlier
 * buffers are still held. A chunk that carries no byte makes no progress and is refused.
 */
import { ARTIFACT_MAX_STAGED_BYTES, ARTIFACT_MAX_STAGED_UPLOADS, ARTIFACT_STAGE_TTL_MS } from "@cotal-ai/core";
import { ARTIFACT_STORE_CHUNK_BYTES } from "./artifact-objects.js";
import type { Caller } from "./artifact-index.js";

/** One upload: its declared metadata, the blocks staged so far, and where it stands. */
export interface StagedUpload {
  caller: Caller;
  name: string;
  mediaType: string;
  size: number;
  digest: string;
  /** Full storage blocks, then the tail block filled to `tailFill`. */
  blocks: Buffer[];
  tail: Buffer | undefined;
  tailFill: number;
  received: number;
  nextSeq: number;
  timer: ReturnType<typeof setTimeout>;
}

const sameCaller = (a: Caller, b: Caller): boolean => a.owner === b.owner && a.actor === b.actor && a.uid === b.uid;

/** Why an upload cannot take a chunk, or `undefined` when it can. */
export type AppendRefusal = "out-of-order" | "empty" | "too-large";

/** The staged uploads of one daemon, and the charge each caller lifecycle holds. */
export class StagingLedger {
  /** Uploads taking chunks. */
  private readonly open = new Map<string, StagedUpload>();
  /** Uploads whose commit has started and not settled: not addressable by id, still charged. */
  private readonly committing = new Set<StagedUpload>();

  constructor(private readonly ttlMs = ARTIFACT_STAGE_TTL_MS) {}

  /** Every upload this caller is charged for, open or committing. */
  private charged(caller: Caller): StagedUpload[] {
    return [...this.open.values(), ...this.committing].filter((s) => sameCaller(s.caller, caller));
  }

  /** The count and bytes this caller is charged for now. */
  chargeOf(caller: Caller): { uploads: number; bytes: number } {
    const mine = this.charged(caller);
    return { uploads: mine.length, bytes: mine.reduce((n, s) => n + s.size, 0) };
  }

  /** Why `caller` may not stage `size` more bytes, or `undefined` when it may. */
  refusal(caller: Caller, size: number): string | undefined {
    const { uploads, bytes } = this.chargeOf(caller);
    if (uploads >= ARTIFACT_MAX_STAGED_UPLOADS)
      return `you already have ${uploads} uploads staged or committing, the most one lifecycle may hold; commit or let one lapse first`;
    if (bytes + size > ARTIFACT_MAX_STAGED_BYTES)
      return `staging ${size} more bytes would put you over ${ARTIFACT_MAX_STAGED_BYTES} staged bytes; nothing was staged`;
    return undefined;
  }

  begin(uploadId: string, upload: Omit<StagedUpload, "blocks" | "tail" | "tailFill" | "received" | "nextSeq" | "timer">): void {
    const timer = setTimeout(() => this.drop(uploadId), this.ttlMs);
    timer.unref?.();
    this.open.set(uploadId, { ...upload, blocks: [], tail: undefined, tailFill: 0, received: 0, nextSeq: 0, timer });
  }

  /** The open upload `uploadId` owned by `caller`, or `undefined` (another caller's reads as unknown). */
  own(uploadId: string, caller: Caller): StagedUpload | undefined {
    const s = this.open.get(uploadId);
    return s !== undefined && sameCaller(s.caller, caller) ? s : undefined;
  }

  /** Drop an open upload and release its buffers. */
  drop(uploadId: string): void {
    const s = this.open.get(uploadId);
    if (s === undefined) return;
    clearTimeout(s.timer);
    this.open.delete(uploadId);
    release(s);
  }

  /** Why `bytes` cannot be appended at `seq`, or `undefined` when it can. Nothing is changed. */
  appendRefusal(s: StagedUpload, seq: number, bytes: Uint8Array, maxChunk: number): AppendRefusal | undefined {
    if (seq !== s.nextSeq) return "out-of-order";
    if (bytes.byteLength === 0) return "empty";
    if (bytes.byteLength > maxChunk || s.received + bytes.byteLength > s.size) return "too-large";
    return undefined;
  }

  /** Copy `bytes` into the upload's storage blocks. The caller checked {@link appendRefusal}. */
  append(s: StagedUpload, bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.byteLength) {
      s.tail ??= Buffer.allocUnsafe(Math.min(ARTIFACT_STORE_CHUNK_BYTES, s.size - s.blocks.length * ARTIFACT_STORE_CHUNK_BYTES));
      const n = Math.min(s.tail.byteLength - s.tailFill, bytes.byteLength - at);
      s.tail.set(bytes.subarray(at, at + n), s.tailFill);
      s.tailFill += n;
      at += n;
      if (s.tailFill === s.tail.byteLength) { s.blocks.push(s.tail); s.tail = undefined; s.tailFill = 0; }
    }
    s.received += bytes.byteLength;
    s.nextSeq += 1;
  }

  /** Take the open upload `uploadId` for commit: it stops being addressable, and stays charged until
   *  `run` settles, when its buffers are released. */
  async commit<T>(uploadId: string, run: (s: StagedUpload) => Promise<T>): Promise<T> {
    const s = this.open.get(uploadId);
    if (s === undefined) throw new Error(`no upload ${uploadId} is open`);
    clearTimeout(s.timer);
    this.open.delete(uploadId);
    this.committing.add(s);
    try { return await run(s); }
    finally { this.committing.delete(s); release(s); }
  }

  /** Drop every upload (the endpoint is closing). A commit in flight releases its own. */
  dropAll(): void {
    for (const id of [...this.open.keys()]) this.drop(id);
  }
}

function release(s: StagedUpload): void {
  s.blocks = [];
  s.tail = undefined;
  s.tailFill = 0;
}

/** The staged blocks of a complete upload, in storage framing. */
export function stagedBlocks(s: StagedUpload): Buffer[] {
  return s.tail === undefined ? s.blocks : [...s.blocks, s.tail.subarray(0, s.tailFill)];
}

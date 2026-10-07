/**
 * The resume transfer store: a carried transcript's path from the operator's host to one manager
 * instance (docs/design/resume-transfer.md sections 3 and 4).
 *
 * Objects are written in the stock Object Store layout so the stock `get` reads and verifies them,
 * but never with the stock `put`: that draws a random chunk subject per call and purges what it wrote
 * on any error, so an interrupted upload could only restart from byte zero. Here the chunk subject is
 * derived from the digest and every chunk publish is pinned to the previous one's stream sequence, so
 * the broker's chain is the checkpoint and any writer of the same bytes continues it.
 */
import { createHash } from "node:crypto";
import { headers, type NatsConnection } from "@nats-io/nats-core";
import { jetstream, jetstreamManager, type JetStreamManager, type StoredMsg } from "@nats-io/jetstream";
import { Objm } from "@nats-io/obj";
import { objectStoreStream, transferBucket } from "./subjects.js";
import { fromObjectStoreDigest } from "./artifact.js";
import { isCasLoss } from "./endpoint-records.js";

/** The stock client's default chunk, and the most a chunk carries. */
export const TRANSFER_CHUNK_MAX = 128 * 1024;
/** Room left under `max_payload` for the publish's headers. */
const HEADER_ROOM = 4 * 1024;
/** Transcript bytes acknowledged through a chunk. */
export const OFFSET_HEADER = "Cotal-Offset";
/** Chunks acknowledged through a chunk. */
export const CHUNK_HEADER = "Cotal-Chunk";
const EXPECTED_LAST_SUBJECT_SEQ = "Nats-Expected-Last-Subject-Sequence";
const HEX64 = /^[0-9a-f]{64}$/;
/** A record's chunk subject token: this protocol's hex digest or the stock client's nuid, never a wildcard. */
const STOCK_NUID = /^[0-9A-Za-z]{1,64}$/;

function assertHex(hex: string): void {
  if (!HEX64.test(hex)) throw new Error(`transfer: ${JSON.stringify(hex)} is not a 64-character lowercase hex digest`);
}

/** Base64url with its padding kept, the stock client's encoding for meta subjects and digests. */
function paddedBase64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** `$O.<bucket>.C.<hex>`: one stable chunk subject per transcript, so every attempt at the same bytes
 *  extends the same chain. */
export function transferChunkSubject(bucket: string, hex: string): string {
  assertHex(hex);
  return `$O.${bucket}.C.${hex}`;
}

/** `$O.<bucket>.M.<name>`, the name encoded as the stock client encodes it. */
export function transferMetaSubject(bucket: string, hex: string): string {
  assertHex(hex);
  return `$O.${bucket}.M.${paddedBase64Url(Buffer.from(`sha256:${hex}`))}`;
}

/**
 * Create the instance's transfer bucket, or verify one that exists, and return its name. Same
 * discipline as `ensureArtifactStore`: a store that exists under the name with other bounds is
 * refused rather than adopted. `max_age` must be 0, because a per-message age can drop the start of
 * a chain and keep its end (design section 4.5); direct get must be on, because the hit check and the
 * resume read use it.
 */
export async function ensureTransferStore(nc: NatsConnection, space: string, instanceId: string): Promise<string> {
  const bucket = transferBucket(space, instanceId);
  const stream = objectStoreStream(bucket);
  const jsm = await jetstreamManager(nc);
  await new Objm(jetstream(nc)).create(bucket, { max_bytes: -1 });
  const { config } = await jsm.streams.info(stream);
  const drift: string[] = [];
  const want = [`$O.${bucket}.C.>`, `$O.${bucket}.M.>`];
  if (JSON.stringify(config.subjects ?? []) !== JSON.stringify(want))
    drift.push(`subjects are ${JSON.stringify(config.subjects ?? [])}, expected ${JSON.stringify(want)}`);
  if (config.mirror) drift.push("it is a MIRROR of another stream");
  if (config.sources?.length) drift.push(`it SOURCES ${config.sources.length} other stream(s)`);
  if (String(config.discard) !== "new") drift.push(`discard is ${config.discard}, expected new`);
  if (String(config.storage) !== "file") drift.push(`storage is ${config.storage}, expected file`);
  if (String(config.retention) !== "limits") drift.push(`retention is ${config.retention}, expected limits`);
  if (config.allow_rollup_hdrs !== true) drift.push("allow_rollup_hdrs is false, expected true (the commit is a subject rollup)");
  if (config.allow_direct !== true) drift.push("allow_direct is false, expected true (the hit and resume reads are direct gets)");
  if (config.max_age !== 0) drift.push(`max_age is ${config.max_age}, expected 0 (an age can drop the start of a chain and keep its end)`);
  if (config.sealed === true) drift.push("the stream is SEALED (writes permanently refused)");
  for (const [field, value] of [["max_bytes", config.max_bytes], ["max_msgs", config.max_msgs],
                                ["max_msgs_per_subject", config.max_msgs_per_subject], ["max_msg_size", config.max_msg_size]] as const)
    if (value !== -1) drift.push(`${field} is ${value}, expected -1`);
  if (drift.length)
    throw new Error(`transfer store ${stream} has drifted: ${drift.join("; ")} - refusing to adopt it (delete it, or reconcile it deliberately)`);
  return bucket;
}

/**
 * The operator's transfer instrument (design section 6): publish the one object's chunk and meta
 * subjects in one instance's bucket, and read the last message of each with a direct get. It names
 * no other object, no stream API beyond those two reads, and no consumer, so a copied instrument can
 * extend or commit only the transcript the CLI hashed before minting it.
 */
export function transferWriterGrants(space: string, instanceId: string, hex: string, connId: string): { publish: string[]; subscribe: string[] } {
  const bucket = transferBucket(space, instanceId);
  const subjects = [transferChunkSubject(bucket, hex), transferMetaSubject(bucket, hex)];
  const direct = `$JS.API.DIRECT.GET.${objectStoreStream(bucket)}`;
  return { publish: [...subjects, ...subjects.map((s) => `${direct}.${s}`)], subscribe: [`_INBOX_${connId}.>`] };
}

/**
 * A manager instance's transfer reader (design section 6): create and read its own bucket's stream,
 * stream it through the stock `get`'s push consumer, and remove a transfer with the stock delete
 * marker and a filtered purge. Every row names the instance's own stream, so it reads no other
 * instance's transfers. The push consumer delivers to this connection's own inbox, and a caller-chosen
 * `deliver_subject` could only export the bucket this reader is already entitled to.
 */
export function transferReaderGrants(space: string, instanceId: string, connId: string): { publish: string[]; subscribe: string[] } {
  const bucket = transferBucket(space, instanceId);
  const stream = objectStoreStream(bucket);
  return {
    publish: [
      // The stock Object Store client opens its manager with the account API check.
      "$JS.API.INFO",
      `$JS.API.STREAM.CREATE.${stream}`,
      `$JS.API.STREAM.INFO.${stream}`,
      `$JS.API.STREAM.MSG.GET.${stream}`,
      `$JS.API.STREAM.PURGE.${stream}`,
      `$JS.API.CONSUMER.CREATE.${stream}`,
      `$JS.API.CONSUMER.CREATE.${stream}.>`,
      `$O.${bucket}.M.>`,
      // Flow control replies of the stock get's push consumer, which the broker names by stream.
      `$JS.FC.${stream}.>`,
    ],
    subscribe: [`_INBOX_${connId}.>`],
  };
}

/** How far a chain got: the last chunk's headers and stream sequence, or all zero for no chain. */
export interface ChainHead {
  offset: number;
  chunks: number;
  seq: number;
}

/** Which read a caller's grant allows: the writer holds last-by-subject direct gets on its two
 *  subjects, the target's reader holds `STREAM.MSG.GET` on its own stream (design section 6). */
export type TransferRead = "direct" | "stream";

function lastOnSubject(jsm: JetStreamManager, stream: string, subject: string, read: TransferRead): Promise<StoredMsg | null> {
  return read === "direct"
    ? jsm.direct.getMessage(stream, { last_by_subj: subject })
    : jsm.streams.getMessage(stream, { last_by_subj: subject });
}

/** Read the last chunk on the transcript's chunk subject: the writer's resume point. */
export async function readChainHead(jsm: JetStreamManager, bucket: string, hex: string): Promise<ChainHead> {
  const m = await lastOnSubject(jsm, objectStoreStream(bucket), transferChunkSubject(bucket, hex), "direct");
  if (m === null) return { offset: 0, chunks: 0, seq: 0 };
  const offset = Number(m.header.get(OFFSET_HEADER));
  const chunks = Number(m.header.get(CHUNK_HEADER));
  if (!Number.isSafeInteger(offset) || offset <= 0 || !Number.isSafeInteger(chunks) || chunks <= 0)
    throw new Error(`transfer chunk ${m.subject}#${m.seq} carries no valid ${OFFSET_HEADER}/${CHUNK_HEADER} headers`);
  return { offset, chunks, seq: m.seq };
}

/** The meta subject's last message: its sequence (0 for none) and whether it is a live record. */
export interface MetaHead {
  seq: number;
  live: boolean;
  /** The record's chunk subject token (a stock delete marker keeps it) and the live record's chunk count. */
  nuid?: string;
  chunks?: number;
  digest?: string;
}

export async function readMetaHead(jsm: JetStreamManager, bucket: string, hex: string, read: TransferRead): Promise<MetaHead> {
  const m = await lastOnSubject(jsm, objectStoreStream(bucket), transferMetaSubject(bucket, hex), read);
  if (m === null) return { seq: 0, live: false };
  const info = JSON.parse(m.string()) as { deleted?: boolean; nuid?: string; chunks?: number; digest?: string };
  if (info.deleted === true) return { seq: m.seq, live: false, nuid: info.nuid };
  return { seq: m.seq, live: true, nuid: info.nuid, chunks: info.chunks, digest: info.digest };
}

/** The connection's chunk size: the stock default, lowered to fit `max_payload`. */
function chunkSize(nc: NatsConnection): number {
  const maxPayload = nc.info?.max_payload;
  if (!maxPayload) throw new Error("transfer: the connection reports no max_payload");
  const size = Math.min(TRANSFER_CHUNK_MAX, maxPayload - HEADER_ROOM);
  if (size <= 0) throw new Error(`transfer: max_payload ${maxPayload} leaves no room for a chunk`);
  return size;
}

/** How one write pass ended. Every outcome but `live` is followed by `transcript-receive`, whose answer
 *  ends the write (design 4.3); `live` is another writer's commit, which the target fetches. */
export type WriteOutcome =
  | { state: "committed" | "refused" | "removed" | "live"; sent: number; chunks: number };

/**
 * One pass of the writer (design 4.2-4.4): skip to the target on a live record, continue the chain from
 * its head, and commit. A refused chunk expectation rereads the head and continues when a chunk is
 * left; an empty subject means the target removed the transfer, which only the target can resolve.
 * `sent` and `chunks` count what this pass published.
 */
export async function writeTransfer(nc: NatsConnection, bucket: string, bytes: Uint8Array): Promise<WriteOutcome> {
  const digest = createHash("sha256").update(bytes).digest();
  const hex = digest.toString("hex");
  // The writer's instrument holds its two direct gets and nothing else on the JetStream API.
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const js = jetstream(nc);
  const meta = await readMetaHead(jsm, bucket, hex, "direct");
  if (meta.live) return { state: "live", sent: 0, chunks: 0 };
  const subject = transferChunkSubject(bucket, hex);
  const max = chunkSize(nc);
  let head = await readChainHead(jsm, bucket, hex);
  let sent = 0;
  let published = 0;
  while (head.offset < bytes.length) {
    const end = Math.min(head.offset + max, bytes.length);
    const h = headers();
    h.set(OFFSET_HEADER, String(end));
    h.set(CHUNK_HEADER, String(head.chunks + 1));
    h.set(EXPECTED_LAST_SUBJECT_SEQ, String(head.seq));
    try {
      const ack = await js.publish(subject, bytes.subarray(head.offset, end), { headers: h });
      sent += end - head.offset;
      published++;
      head = { offset: end, chunks: head.chunks + 1, seq: ack.seq };
    } catch (e) {
      if (!isCasLoss(e)) throw e;
      head = await readChainHead(jsm, bucket, hex);
      if (head.seq === 0) return { state: "removed", sent, chunks: published };
    }
  }
  const record = {
    name: `sha256:${hex}`,
    bucket,
    nuid: hex,
    size: bytes.length,
    chunks: head.chunks,
    mtime: new Date().toISOString(),
    deleted: false,
    options: { max_chunk_size: max },
    digest: `SHA-256=${paddedBase64Url(digest)}`,
  };
  const h = headers();
  h.set("Nats-Rollup", "sub");
  h.set(EXPECTED_LAST_SUBJECT_SEQ, String(meta.seq));
  try {
    await js.publish(transferMetaSubject(bucket, hex), JSON.stringify(record), { headers: h });
  } catch (e) {
    if (!isCasLoss(e)) throw e;
    return { state: "refused", sent, chunks: published };
  }
  return { state: "committed", sent, chunks: published };
}

/** Messages held on one subject, read with `STREAM.INFO` and `subjects_filter`. */
async function subjectCount(jsm: JetStreamManager, stream: string, subject: string): Promise<number> {
  const info = await jsm.streams.info(stream, { subjects_filter: subject });
  return info.state.subjects?.[subject] ?? 0;
}

/**
 * Remove a transfer whole (design 4.5): the stock delete for a live record (its marker, then one
 * filtered purge of the record's chunk subject), otherwise the purge alone of each chunk subject that
 * holds a message: the chain's, and the one a delete marker names, whose chunks remain when a stop fell
 * between the marker and its purge (a stock put names a random one). A transfer with neither is already
 * removed and nothing is written, because a stock delete of a deleted record publishes another marker.
 */
export async function removeTransfer(nc: NatsConnection, bucket: string, hex: string): Promise<void> {
  const jsm = await jetstreamManager(nc);
  const meta = await readMetaHead(jsm, bucket, hex, "stream");
  if (meta.live) {
    await (await new Objm(jetstream(nc)).open(bucket)).delete(`sha256:${hex}`);
    return;
  }
  const stream = objectStoreStream(bucket);
  const marked = meta.nuid !== undefined && STOCK_NUID.test(meta.nuid) ? [`$O.${bucket}.C.${meta.nuid}`] : [];
  for (const subject of new Set([transferChunkSubject(bucket, hex), ...marked]))
    if ((await subjectCount(jsm, stream, subject)) > 0) await jsm.streams.purge(stream, { filter: subject });
}

/** One transfer the sweep found: its digest and when its last message was written. */
export interface TransferEntry {
  hex: string;
  lastWrite: Date;
}

/** Every transfer in the bucket, listed from the stream's subjects and the last message of each. */
export async function listTransfers(nc: NatsConnection, bucket: string): Promise<TransferEntry[]> {
  const jsm = await jetstreamManager(nc);
  const stream = objectStoreStream(bucket);
  const chunkPrefix = `$O.${bucket}.C.`;
  const metaPrefix = `$O.${bucket}.M.`;
  const info = await jsm.streams.info(stream, { subjects_filter: `$O.${bucket}.>` });
  const last = new Map<string, Date>();
  for (const subject of Object.keys(info.state.subjects ?? {})) {
    let hex: string;
    if (subject.startsWith(chunkPrefix)) hex = subject.slice(chunkPrefix.length);
    else if (subject.startsWith(metaPrefix)) {
      const name = Buffer.from(subject.slice(metaPrefix.length), "base64url").toString();
      if (!name.startsWith("sha256:")) continue;
      hex = name.slice("sha256:".length);
    } else continue;
    if (!HEX64.test(hex)) continue;
    const m = await lastOnSubject(jsm, stream, subject, "stream");
    if (m === null) continue;
    const at = m.time;
    const seen = last.get(hex);
    if (!seen || at > seen) last.set(hex, at);
  }
  return [...last].map(([hex, lastWrite]) => ({ hex, lastWrite }));
}

/** What fetching a committed object found. */
export type FetchOutcome =
  | { state: "absent" }
  | { state: "fetched"; bytes: Uint8Array }
  | { state: "invalid"; reason: string };

/**
 * Read a committed object with the stock `get` and check it against the requested digest. The chunk
 * count is checked first, because the stock `get` of a record whose chunks were swept waits for them
 * and never returns (design 4.5). The record is the writer's claim: the stock `get` recomputes the
 * digest over what it streams, and the record's own digest must name the bytes the operator asked for.
 */
export async function fetchTransfer(nc: NatsConnection, bucket: string, hex: string): Promise<FetchOutcome> {
  const jsm = await jetstreamManager(nc);
  const meta = await readMetaHead(jsm, bucket, hex, "stream");
  if (!meta.live) return { state: "absent" };
  if (meta.nuid === undefined || !HEX64.test(meta.nuid) || meta.chunks === undefined)
    return { state: "invalid", reason: "the record names no chunk subject or chunk count" };
  const held = await subjectCount(jsm, objectStoreStream(bucket), `$O.${bucket}.C.${meta.nuid}`);
  if (held !== meta.chunks) return { state: "invalid", reason: `the record names ${meta.chunks} chunks and ${held} are held` };
  let recorded: string;
  try {
    recorded = fromObjectStoreDigest(meta.digest ?? "");
  } catch (e) {
    return { state: "invalid", reason: (e as Error).message };
  }
  if (recorded !== `sha256:${hex}`) return { state: "invalid", reason: `the record's digest is ${recorded}` };
  const os = await new Objm(jetstream(nc)).open(bucket);
  try {
    const bytes = await os.getBlob(`sha256:${hex}`);
    if (bytes === null) return { state: "absent" };
    if (createHash("sha256").update(bytes).digest("hex") !== hex) return { state: "invalid", reason: "the bytes read do not hash to the name" };
    return { state: "fetched", bytes };
  } catch (e) {
    return { state: "invalid", reason: (e as Error).message };
  }
}

/**
 * The put, fetch, confirm-attach and pin handlers of the `artifacts` endpoint (A1, plan sections 5
 * and 6). `list` lives beside the bind in `artifacts-endpoint.ts`.
 *
 * Every handler runs the caller fence first. Fetch runs the channel read gate before any digest,
 * attachment or object branch, including the choice of error code (S7), so a caller who may not read
 * the channel learns nothing about any digest. Every refusal before an effect carries `not-executed`.
 *
 * One in-process lock per digest serializes commit, confirm, pin and the sweep on this daemon (the
 * N=1 lease holder), and every write re-checks the serve fence first.
 *
 * confirm-attach refuses with ONE collapsed tuple for every reason a caller is not entitled (S6): no
 * such post, someone else's post, another channel, no reference to the digest, no possession, bytes
 * gone. The tuple carries no details.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AmbiguousAclAlias, ARTIFACT_ATTACHMENT_TTL_MS, ARTIFACT_CHUNK_MAX, ARTIFACT_MAX_BYTES, ARTIFACT_MAX_STAGED_BYTES,
  ARTIFACT_MAX_STAGED_UPLOADS, ARTIFACT_RESERVATION_TTL_MS, ARTIFACT_STAGE_TTL_MS, assertLifecycleToken, EpEnvelopeError,
  principalKey,
  type ArtifactsConfirmAttachInput, type ArtifactsFetchBeginInput, type ArtifactsFetchBeginOutput, type ArtifactsFetchChunkInput,
  type ArtifactsFetchChunkOutput, type ArtifactsPinInput, type ArtifactsPutBeginInput, type ArtifactsPutBeginOutput,
  type ArtifactsPutChunkInput, type ArtifactsPutChunkOutput, type ArtifactsPutCommitInput, type ArtifactsPutCommitOutput,
  type EpCaller, type EpServeContext,
} from "@cotal-ai/core";
import type { ArtifactIndex, Caller } from "./artifact-index.js";
import type { ArtifactObjects } from "./artifact-objects.js";
import { concreteChannel } from "./artifact-keys.js";
import type { ChatEntryForConfirm } from "./artifact-chat-read.js";
import type { ServeScope } from "./endpoint-bind.js";

type Code = "permission-denied" | "bad-request" | "unavailable" | "failed-precondition" | "not-found" | "resource-exhausted";
const notExecuted = (code: Code, message: string): EpEnvelopeError => new EpEnvelopeError(code, message, undefined, "not-executed");

/** The one confirm-attach refusal (S6). Built fresh, with no details, every time. */
export const CONFIRM_REFUSAL = Object.freeze({ code: "permission-denied" as const, message: "confirm-attach: not authorized for that artifact" });
const confirmRefused = (): EpEnvelopeError => notExecuted(CONFIRM_REFUSAL.code, CONFIRM_REFUSAL.message);

/** Fetch's two digest answers, reachable only after the read gate (S7). */
export const FETCH_UNKNOWN = "unknown digest";
export const FETCH_EXPIRED = "artifact expired";

/** The largest fetch-chunk reply this handler builds; the broker's own payload limit still applies. */
const FETCH_REPLY_CEILING = 512 * 1024;

/** One in-process lock per digest. Work for one digest runs one at a time, in arrival order. */
export class DigestLocks {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(digest: string, work: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(digest) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(digest, tail);
    await prev;
    try { return await work(); }
    finally {
      release();
      if (this.tails.get(digest) === tail) this.tails.delete(digest);
    }
  }
}

/** An upload staged in daemon memory until commit. */
interface Staged {
  caller: Caller;
  name: string;
  mediaType: string;
  size: number;
  digest: string;
  chunks: Uint8Array[];
  received: number;
  nextSeq: number;
  timer: ReturnType<typeof setTimeout>;
}

/** What the handlers need from the bound endpoint: the installed stores, the caller fence and read
 *  gate, and the delivery connection's chat read. */
export interface VerbDeps {
  space: string;
  stores: () => { index: ArtifactIndex; objects: ArtifactObjects } | undefined;
  /** The caller's live lifecycle (S5): refuses unless the ACL row for the caller's alias is this uid. */
  fenceCaller: (caller: EpCaller, command: string) => Promise<Caller>;
  /** The channel read gate (S7), run before any digest-dependent branch. */
  mayReadChannel: (caller: EpCaller, channel: string, command: string) => Promise<void>;
  readChatEntry: (seq: number) => Promise<ChatEntryForConfirm | undefined>;
  locks: DigestLocks;
  now?: () => number;
}

/** Builds the handlers for one serving generation. Staged uploads outlive a generation: they are only
 *  ever committed under the generation the commit request arrives on. */
export class ArtifactVerbs {
  private readonly staged = new Map<string, Staged>();
  constructor(private readonly deps: VerbDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private stores(command: string) {
    const s = this.deps.stores();
    if (s === undefined) throw notExecuted("unavailable", `${command}: the artifacts store connection is not open; retry`);
    return s;
  }

  /** Drop every staged upload (the endpoint is closing). */
  dropStaged(): void {
    for (const s of this.staged.values()) clearTimeout(s.timer);
    this.staged.clear();
  }

  private stagedFor(caller: Caller): Staged[] {
    return [...this.staged.values()].filter((s) => s.caller.owner === caller.owner && s.caller.actor === caller.actor && s.caller.uid === caller.uid);
  }

  putBegin = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsPutBeginOutput> => {
    const caller = await this.deps.fenceCaller(sctx.subject.caller, "put-begin");
    const args = sctx.request.args as unknown as ArtifactsPutBeginInput;
    if (args.size > ARTIFACT_MAX_BYTES) throw notExecuted("resource-exhausted", `put-begin: ${args.size} bytes is over the ${ARTIFACT_MAX_BYTES}-byte artifact limit; nothing was staged`);
    const mine = this.stagedFor(caller);
    if (mine.length >= ARTIFACT_MAX_STAGED_UPLOADS)
      throw notExecuted("resource-exhausted", `put-begin: you already have ${mine.length} uploads staged, the most one lifecycle may hold; commit or let one lapse first`);
    const stagedBytes = mine.reduce((n, s) => n + s.size, 0);
    if (stagedBytes + args.size > ARTIFACT_MAX_STAGED_BYTES)
      throw notExecuted("resource-exhausted", `put-begin: staging ${args.size} more bytes would put you over ${ARTIFACT_MAX_STAGED_BYTES} staged bytes; nothing was staged`);
    scope.fence.check(scope.generation, "staging the upload");
    const uploadId = randomBytes(16).toString("hex");
    const timer = setTimeout(() => this.staged.delete(uploadId), ARTIFACT_STAGE_TTL_MS);
    timer.unref?.();
    this.staged.set(uploadId, { caller, name: args.name, mediaType: args.mediaType, size: args.size, digest: args.digest, chunks: [], received: 0, nextSeq: 0, timer });
    return { uploadId };
  };

  /** The staged upload `uploadId`, owned by this caller. Another caller's id reads as unknown. */
  private ownStaged(uploadId: string, caller: Caller, command: string): Staged {
    const s = this.staged.get(uploadId);
    if (s === undefined || s.caller.owner !== caller.owner || s.caller.actor !== caller.actor || s.caller.uid !== caller.uid)
      throw notExecuted("not-found", `${command}: no upload ${uploadId} is staged for you; begin a new one`);
    return s;
  }

  private killUpload(uploadId: string, s: Staged): void {
    clearTimeout(s.timer);
    this.staged.delete(uploadId);
  }

  putChunk = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsPutChunkOutput> => {
    const caller = await this.deps.fenceCaller(sctx.subject.caller, "put-chunk");
    const args = sctx.request.args as unknown as ArtifactsPutChunkInput;
    const s = this.ownStaged(args.uploadId, caller, "put-chunk");
    // A failed chunk ends the upload and says so: there is no resume (plan section 8).
    if (args.seq !== s.nextSeq) {
      this.killUpload(args.uploadId, s);
      throw notExecuted("failed-precondition", `put-chunk: expected chunk ${s.nextSeq}, got ${args.seq}; the upload is dead, begin a new one`);
    }
    const bytes = Buffer.from(args.data, "base64");
    if (bytes.byteLength > ARTIFACT_CHUNK_MAX || s.received + bytes.byteLength > s.size) {
      this.killUpload(args.uploadId, s);
      throw notExecuted("failed-precondition", `put-chunk: the chunk would take the upload past its declared ${s.size} bytes (or over ${ARTIFACT_CHUNK_MAX} per chunk); the upload is dead, begin a new one`);
    }
    scope.fence.check(scope.generation, "staging the chunk");
    s.chunks.push(new Uint8Array(bytes));
    s.received += bytes.byteLength;
    s.nextSeq += 1;
    return { received: s.received };
  };

  putCommit = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsPutCommitOutput> => {
    const caller = await this.deps.fenceCaller(sctx.subject.caller, "put-commit");
    const args = sctx.request.args as unknown as ArtifactsPutCommitInput;
    const s = this.ownStaged(args.uploadId, caller, "put-commit");
    this.killUpload(args.uploadId, s);
    if (s.received !== s.size)
      throw notExecuted("failed-precondition", `put-commit: ${s.received} of the declared ${s.size} bytes arrived; nothing was committed`);
    // Hash before anything is written (S2): the meta record is only ever written for bytes this
    // service hashed to the digest the caller declared.
    const hash = createHash("sha256");
    for (const c of s.chunks) hash.update(c);
    const digest = `sha256:${hash.digest("hex")}`;
    if (digest !== s.digest) throw notExecuted("failed-precondition", `put-commit: the bytes hash to ${digest}, not the declared ${s.digest}; nothing was committed`);
    const { index, objects } = this.stores("put-commit");
    await this.deps.locks.run(digest, async () => {
      // Commit order (plan section 6): reservation, chunks, meta, possession. A blob is never visible
      // to the sweep without a live reservation in front of it.
      const reservationId = randomUUID();
      scope.fence.check(scope.generation, "the reservation");
      await index.writeReservation(digest, caller, { deadline: this.now() + ARTIFACT_RESERVATION_TTL_MS, reservationId });
      await objects.write({ digest, size: s.size, chunks: s.chunks.length, name: s.name, mediaType: s.mediaType }, s.chunks,
        (what) => scope.fence.check(scope.generation, what));
      scope.fence.check(scope.generation, "the possession row");
      await index.writePossession(digest, caller, { size: s.size, name: s.name, mediaType: s.mediaType, committedAt: this.now(), reservationId });
    });
    return { digest, size: s.size };
  };

  /** Fetch's gate and digest answer, re-run on every chunk (S7). Returns the attachment's metadata. */
  private async fetchGate(sctx: EpServeContext, command: string, digest: string, rawChannel: string) {
    let channel: string;
    try { channel = concreteChannel(rawChannel); } catch (e) { throw notExecuted("bad-request", `${command}: ${(e as Error).message}`); }
    await this.deps.fenceCaller(sctx.subject.caller, command);
    // The read gate first: nothing digest-dependent is read before it.
    await this.deps.mayReadChannel(sctx.subject.caller, channel, command);
    const { index, objects } = this.stores(command);
    const row = await index.readAttachment(channel, digest);
    if (row === undefined) throw notExecuted("not-found", `${command}: ${FETCH_UNKNOWN}`);
    if (row.value.state !== "attached" || (!row.value.pinned && row.value.expiresAt <= this.now()))
      throw notExecuted("not-found", `${command}: ${FETCH_EXPIRED}`);
    const meta = await objects.readMeta(digest);
    if (meta === undefined) throw notExecuted("not-found", `${command}: ${FETCH_EXPIRED}`);
    return { row: row.value, meta, objects };
  }

  fetchBegin = (_scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsFetchBeginOutput> => {
    const args = sctx.request.args as unknown as ArtifactsFetchBeginInput;
    const { row, meta } = await this.fetchGate(sctx, "fetch-begin", args.digest, args.channel);
    return { name: row.name, mediaType: row.mediaType, size: meta.size };
  };

  fetchChunk = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsFetchChunkOutput> => {
    const args = sctx.request.args as unknown as ArtifactsFetchChunkInput;
    const { meta, objects } = await this.fetchGate(sctx, "fetch-chunk", args.digest, args.channel);
    if (args.offset > meta.size) throw notExecuted("bad-request", `fetch-chunk: offset ${args.offset} is past the ${meta.size}-byte artifact`);
    if (!sctx.replyFits) throw notExecuted("unavailable", "fetch-chunk: this serving connection cannot measure a reply, so no chunk is sent");
    const fits = sctx.replyFits;
    // Walk the stored chunks to the one holding `offset`, then append whole stored chunks while the
    // ACTUAL reply still fits. When not even the rest of the first chunk fits, send the largest prefix
    // of it that does (a measured binary search), so every call makes progress or refuses by name.
    let pos = 0, i = 0;
    for (; i < meta.chunks; i++) {
      const c = await objects.readChunk(meta.digest, i);
      if (c === undefined) throw notExecuted("not-found", `fetch-chunk: ${FETCH_EXPIRED}`);
      if (pos + c.byteLength > args.offset) break;
      pos += c.byteLength;
    }
    let collected = Buffer.alloc(0);
    for (let j = i; j < meta.chunks; j++) {
      const c = await objects.readChunk(meta.digest, j);
      if (c === undefined) throw notExecuted("not-found", `fetch-chunk: ${FETCH_EXPIRED}`);
      const from = j === i ? args.offset - pos : 0;
      const next = Buffer.concat([collected, Buffer.from(c.subarray(from))]);
      const done = args.offset + next.byteLength >= meta.size;
      // Two bounds: the contract caps one reply's data at one raw chunk, and the reply must fit the
      // broker's message as actually serialized.
      if (next.byteLength > ARTIFACT_CHUNK_MAX || !fits({ data: next.toString("base64"), complete: done }, FETCH_REPLY_CEILING)) {
        if (collected.byteLength === 0) {
          let lo = 0, hi = Math.min(c.byteLength - from, ARTIFACT_CHUNK_MAX);
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (fits({ data: Buffer.from(c.subarray(from, from + mid)).toString("base64"), complete: false }, FETCH_REPLY_CEILING)) lo = mid; else hi = mid - 1;
          }
          if (lo === 0) throw notExecuted("failed-precondition", "fetch-chunk: not one byte fits the broker's message limit, so no chunk can be sent");
          collected = Buffer.from(c.subarray(from, from + lo));
        }
        break;
      }
      collected = next;
    }
    scope.fence.check(scope.generation, "the chunk reply");
    const complete = args.offset + collected.byteLength >= meta.size;
    return { data: collected.toString("base64"), complete };
  };

  confirmAttach = (scope: ServeScope) => async (sctx: EpServeContext): Promise<Record<string, never>> => {
    const args = sctx.request.args as unknown as ArtifactsConfirmAttachInput;
    let channel: string;
    try { channel = concreteChannel(args.channel); } catch { throw confirmRefused(); }
    let caller: Caller;
    try { caller = await this.deps.fenceCaller(sctx.subject.caller, "confirm-attach"); }
    catch (e) {
      // The two refusals a caller can act on keep their own names; every other one collapses.
      if (e instanceof EpEnvelopeError && (e.code === "unavailable" || e.code === "failed-precondition")) throw e;
      throw confirmRefused();
    }
    const entry = await this.deps.readChatEntry(args.seq);
    const sender = principalKey(caller.owner, caller.actor).key;
    if (entry === undefined || entry.subject.sender !== sender || entry.subject.rest !== channel || !entry.artifactDigests.includes(args.digest))
      throw confirmRefused();
    const { index, objects } = this.stores("confirm-attach");
    await this.deps.locks.run(args.digest, async () => {
      const possession = await index.readPossession(args.digest, caller);
      if (possession === undefined) throw confirmRefused();
      // No attachment is ever created for swept bytes (plan section 6).
      if ((await objects.readMeta(args.digest)) === undefined) throw confirmRefused();
      scope.fence.check(scope.generation, "the attachment");
      const now = this.now();
      const inserted = await index.attachIfAbsent(channel, args.digest, {
        state: "attached", confirmerLifecycleUid: caller.uid, name: possession.value.name, mediaType: possession.value.mediaType,
        size: possession.value.size, createdAt: now, expiresAt: now + ARTIFACT_ATTACHMENT_TTL_MS, pinned: false,
      });
      // Re-read possession after the insert, and roll back only an insert of our own (S19).
      if (inserted && (await index.readPossession(args.digest, caller)) === undefined) {
        await index.rollbackAttach(channel, args.digest);
        throw confirmRefused();
      }
      scope.fence.check(scope.generation, "consuming the reservation");
      await index.deleteReservation(args.digest, caller);
    });
    return {};
  };

  pin = (scope: ServeScope) => async (sctx: EpServeContext): Promise<Record<string, never>> => {
    const args = sctx.request.args as unknown as ArtifactsPinInput;
    let channel: string;
    try { channel = concreteChannel(args.channel); } catch (e) { throw notExecuted("bad-request", `pin: ${(e as Error).message}`); }
    const caller = await this.deps.fenceCaller(sctx.subject.caller, "pin");
    const refused = () => notExecuted("permission-denied", "pin: not authorized for that artifact");
    const { index } = this.stores("pin");
    await this.deps.locks.run(args.digest, async () => {
      const row = await index.readAttachment(channel, args.digest);
      if (row === undefined || row.value.state !== "attached") throw refused();
      // Possession at the live lifecycle, or the caller is the lifecycle that confirmed this attachment.
      const holds = (await index.readPossession(args.digest, caller)) !== undefined || row.value.confirmerLifecycleUid === caller.uid;
      if (!holds) throw refused();
      scope.fence.check(scope.generation, "the pin");
      if (!(await index.pin(channel, args.digest))) throw refused();
    });
    return {};
  };
}

/** The caller fence (S5) as a reusable function over the daemon's alias read. */
export async function fenceCallerWith(
  aclForAlias: (principal: string) => Promise<{ lifecycleUid: string } | undefined>,
  caller: EpCaller,
  command: string,
): Promise<Caller> {
  const refused = notExecuted("permission-denied", `${command}: not authorized`);
  let uid: string;
  try { uid = assertLifecycleToken(caller.uid, "lifecycleUid"); } catch { throw refused; }
  let acl: { lifecycleUid: string } | undefined;
  try { acl = await aclForAlias(principalKey(caller.owner, caller.actor).key); }
  catch (e) {
    if (e instanceof AmbiguousAclAlias) throw notExecuted("failed-precondition", `${command}: two live lifecycles hold your alias; an operator must retire one`);
    throw notExecuted("unavailable", `${command}: the read ACL is unreadable right now; retry`);
  }
  if (acl === undefined || acl.lifecycleUid !== uid) throw refused;
  return { owner: caller.owner, actor: caller.actor, uid };
}

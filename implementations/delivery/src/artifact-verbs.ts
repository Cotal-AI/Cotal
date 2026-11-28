/**
 * The put, fetch, confirm-attach and pin handlers of the `artifacts` endpoint (A1, plan sections 5
 * and 6). `list` lives beside the bind in `artifacts-endpoint.ts`.
 *
 * Every handler runs the caller fence first. Fetch runs the channel read gate before any digest,
 * attachment or object branch, including the choice of error code (S7), so a caller who may not read
 * the channel learns nothing about any digest. Every refusal before an effect carries `not-executed`.
 *
 * One in-process lock per digest serializes commit, confirm, pin and the sweep on this daemon (the
 * N=1 lease holder).
 *
 * The serve fence (E18). Every handler checks its serving generation immediately before each store
 * write (inside the index and object layers, so a CAS retry or a rollback is checked too) and before
 * its reply. Until a request's first write lands a fence refusal says `not-executed`; after that it
 * says `unknown`, because a refusal after an effect must not claim nothing ran (SPEC 13.3). A read-only
 * handler checks before its reply, so a fetch answered across a lease loss is not sent.
 *
 * Bytes are staged in storage framing and charged until released (E17, E20; `artifact-staging.ts`).
 *
 * confirm-attach refuses with ONE collapsed tuple for every reason a caller is not entitled (S6): no
 * such post, someone else's post, another channel, no reference to the digest, no possession, bytes
 * gone. The tuple carries no details.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AmbiguousAclAlias, ARTIFACT_ATTACHMENT_TTL_MS, ARTIFACT_CHUNK_MAX, ARTIFACT_MAX_BYTES, ARTIFACT_RESERVATION_TTL_MS,
  assertLifecycleToken, EpEnvelopeError, principalKey,
  type ArtifactsConfirmAttachInput, type ArtifactsFetchBeginInput, type ArtifactsFetchBeginOutput, type ArtifactsFetchChunkInput,
  type ArtifactsFetchChunkOutput, type ArtifactsPinInput, type ArtifactsPutBeginInput, type ArtifactsPutBeginOutput,
  type ArtifactsPutChunkInput, type ArtifactsPutChunkOutput, type ArtifactsPutCommitInput, type ArtifactsPutCommitOutput,
  type ArtifactStoreSpace, type EpCaller, type EpServeContext,
} from "@cotal-ai/core";
import type { ArtifactIndex, Caller, WriteGuard } from "./artifact-index.js";
import { concreteChannel } from "./artifact-keys.js";
import type { ChatEntryForConfirm } from "./artifact-chat-read.js";
import { stagedBlocks, StagingLedger } from "./artifact-staging.js";
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

/** One request's view of the serve fence: checks before each write, and says `unknown` once any write
 *  of the request has started (E18). */
function writeFence(scope: ServeScope): { guard: WriteGuard; reply: (what: string) => void } {
  let wrote = false;
  return {
    guard: (what) => { scope.fence.check(scope.generation, what, wrote ? "unknown" : "not-executed"); wrote = true; },
    reply: (what) => scope.fence.check(scope.generation, what, wrote ? "unknown" : "not-executed"),
  };
}

/** What the handlers need from the bound endpoint: the installed stores, the caller fence and read
 *  gate, and the delivery connection's chat read. */
export interface VerbDeps {
  space: string;
  stores: () => { index: ArtifactIndex; objects: ArtifactStoreSpace } | undefined;
  /** The caller's live lifecycle (S5): refuses unless the ACL row for the caller's alias is this uid. */
  fenceCaller: (caller: EpCaller, command: string) => Promise<Caller>;
  /** The channel read gate (S7), run before any digest-dependent branch. */
  mayReadChannel: (caller: EpCaller, channel: string, command: string) => Promise<void>;
  readChatEntry: (seq: number) => Promise<ChatEntryForConfirm | undefined>;
  locks: DigestLocks;
  now?: () => number;
  /** Ordered test barriers: awaited at the named point of a real handler, so a cell holds a verb there
   *  and drives the sweep or a quiesce against it. Absent in a running daemon. */
  hold?: (point: "commit-locked" | "confirm-locked" | "fetch-gated" | "fetch-read") => Promise<void>;
}

/** Run one handler, and fence its REFUSALS at the reply boundary as its successes are fenced (E18): a
 *  handler whose generation ended while it ran answers `unavailable` instead of a stale answer such as
 *  `unknown digest`. The fence refusal keeps `not-executed` only when the handler's own refusal said
 *  so; any other refusal may follow a landed write, so it says `unknown`. */
export function fenceRefusals<T>(scope: ServeScope, run: () => Promise<T>): Promise<T> {
  return run().catch((e: unknown) => {
    scope.fence.check(scope.generation, "the refusal reply", e instanceof EpEnvelopeError && e.outcome === "not-executed" ? "not-executed" : "unknown");
    throw e;
  });
}

type HandlerFactory<O> = (scope: ServeScope) => (sctx: EpServeContext) => Promise<O>;
const fenced = <O>(raw: HandlerFactory<O>): HandlerFactory<O> => (scope) => (sctx) => fenceRefusals(scope, () => raw(scope)(sctx));

/** Builds the handlers for one serving generation. Staged uploads outlive a generation: they are only
 *  ever committed under the generation the commit request arrives on. */
export class ArtifactVerbs {
  readonly staging = new StagingLedger();
  constructor(private readonly deps: VerbDeps) {
    // Every handler's refusals pass the serve fence at the reply boundary (E18).
    this.putBegin = fenced(this.putBegin);
    this.putChunk = fenced(this.putChunk);
    this.putCommit = fenced(this.putCommit);
    this.fetchBegin = fenced(this.fetchBegin);
    this.fetchChunk = fenced(this.fetchChunk);
    this.confirmAttach = fenced(this.confirmAttach);
    this.pin = fenced(this.pin);
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private stores(command: string) {
    const s = this.deps.stores();
    if (s === undefined) throw notExecuted("unavailable", `${command}: the artifacts store connection is not open; retry`);
    return s;
  }

  /** Drop every staged upload (the endpoint is closing). */
  dropStaged(): void {
    this.staging.dropAll();
  }

  putBegin = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsPutBeginOutput> => {
    const caller = await this.deps.fenceCaller(sctx.subject.caller, "put-begin");
    const args = sctx.request.args as unknown as ArtifactsPutBeginInput;
    if (args.size > ARTIFACT_MAX_BYTES) throw notExecuted("resource-exhausted", `put-begin: ${args.size} bytes is over the ${ARTIFACT_MAX_BYTES}-byte artifact limit; nothing was staged`);
    if (args.size === 0) throw notExecuted("bad-request", "put-begin: an artifact holds at least one byte; nothing was staged");
    const over = this.staging.refusal(caller, args.size);
    if (over !== undefined) throw notExecuted("resource-exhausted", `put-begin: ${over}`);
    const { objects } = this.stores("put-begin");
    const tooSmall = objects.admits(args.size);
    if (tooSmall !== undefined) throw notExecuted("resource-exhausted", `put-begin: ${tooSmall}; nothing was staged`);
    scope.fence.check(scope.generation, "staging the upload");
    const uploadId = randomBytes(16).toString("hex");
    this.staging.begin(uploadId, { caller, name: args.name, mediaType: args.mediaType, size: args.size, digest: args.digest, blockBytes: objects.blockBytes });
    return { uploadId };
  };

  putChunk = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsPutChunkOutput> => {
    const caller = await this.deps.fenceCaller(sctx.subject.caller, "put-chunk");
    const args = sctx.request.args as unknown as ArtifactsPutChunkInput;
    const s = this.staging.own(args.uploadId, caller);
    if (s === undefined) throw notExecuted("not-found", `put-chunk: no upload ${args.uploadId} is staged for you; begin a new one`);
    // Fenced before anything touches the upload: a stale handler neither appends to it nor ends it (E18).
    scope.fence.check(scope.generation, "staging the chunk");
    const bytes = Buffer.from(args.data, "base64");
    // A failed chunk ends the upload and says so: there is no resume (plan section 8).
    const refused = this.staging.appendRefusal(s, args.seq, bytes, ARTIFACT_CHUNK_MAX);
    if (refused !== undefined) {
      this.staging.drop(args.uploadId);
      throw notExecuted("failed-precondition", refused === "out-of-order"
        ? `put-chunk: expected chunk ${s.nextSeq}, got ${args.seq}; the upload is dead, begin a new one`
        : refused === "empty"
          ? "put-chunk: the chunk carries no byte, so the upload makes no progress; the upload is dead, begin a new one"
          : `put-chunk: the chunk would take the upload past its declared ${s.size} bytes (or over ${ARTIFACT_CHUNK_MAX} per chunk); the upload is dead, begin a new one`);
    }
    this.staging.append(s, bytes);
    return { received: s.received };
  };

  putCommit = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsPutCommitOutput> => {
    const caller = await this.deps.fenceCaller(sctx.subject.caller, "put-commit");
    const args = sctx.request.args as unknown as ArtifactsPutCommitInput;
    if (this.staging.own(args.uploadId, caller) === undefined)
      throw notExecuted("not-found", `put-commit: no upload ${args.uploadId} is staged for you; begin a new one`);
    const fence = writeFence(scope);
    // Fenced before the upload is taken, and a fence refusal raised before any write puts the same
    // upload back, so a stale handler never consumes what the next generation should commit (E18).
    scope.fence.check(scope.generation, "taking the upload for commit");
    // The upload stays charged until this settles (E20).
    const committed = await this.staging.commit(args.uploadId, async (s) => {
      if (s.received !== s.size)
        throw notExecuted("failed-precondition", `put-commit: ${s.received} of the declared ${s.size} bytes arrived; nothing was committed`);
      const blocks = stagedBlocks(s);
      // Hash before anything is written (S2): the meta record is only ever written for bytes this
      // service hashed to the digest the caller declared.
      const hash = createHash("sha256");
      for (const b of blocks) hash.update(b);
      const digest = `sha256:${hash.digest("hex")}`;
      if (digest !== s.digest) throw notExecuted("failed-precondition", `put-commit: the bytes hash to ${digest}, not the declared ${s.digest}; nothing was committed`);
      const { index, objects } = this.stores("put-commit");
      await this.deps.locks.run(digest, async () => {
        await this.deps.hold?.("commit-locked");
        // The generation first: a lease lost while this commit waited for the digest is a fence
        // refusal, which keeps the upload, never a storage refusal, which would release it (E18).
        scope.fence.check(scope.generation, "the commit's storage check");
        // The limit for THIS artifact, read again right before the reservation: it can have dropped
        // since put-begin, or while this commit waited for the digest (E23).
        const tooSmall = objects.admits(s.size);
        if (tooSmall !== undefined) throw notExecuted("resource-exhausted", `put-commit: ${tooSmall}; nothing was committed`);
        // Commit order (plan section 6): reservation, chunks, meta, possession. A blob is never visible
        // to the sweep without a live reservation in front of it.
        const reservationId = randomUUID();
        await index.writeReservation(digest, caller, { deadline: this.now() + ARTIFACT_RESERVATION_TTL_MS, reservationId }, fence.guard);
        const meta = await objects.put({ digest, name: s.name, mediaType: s.mediaType }, blocks, fence.guard);
        await index.writePossession(digest, caller, { size: meta.size, name: s.name, mediaType: s.mediaType, committedAt: this.now(), reservationId }, fence.guard);
      });
      return { digest, size: s.size };
    }, (e) => e instanceof EpEnvelopeError && e.code === "unavailable" && e.outcome === "not-executed");
    fence.reply("the commit reply");
    return committed;
  };

  /** Fetch's gate and digest answer, re-run on every chunk (S7). Returns the attachment's metadata. */
  private async fetchGate(sctx: EpServeContext, command: string, digest: string, rawChannel: string) {
    let channel: string;
    try { channel = concreteChannel(rawChannel); } catch (e) { throw notExecuted("bad-request", `${command}: ${(e as Error).message}`); }
    await this.deps.fenceCaller(sctx.subject.caller, command);
    // The read gate first: nothing digest-dependent is read before it.
    await this.deps.mayReadChannel(sctx.subject.caller, channel, command);
    await this.deps.hold?.("fetch-gated");
    const { index, objects } = this.stores(command);
    const row = await index.readAttachment(channel, digest);
    if (row === undefined) throw notExecuted("not-found", `${command}: ${FETCH_UNKNOWN}`);
    if (row.value.state !== "attached" || (!row.value.pinned && row.value.expiresAt <= this.now()))
      throw notExecuted("not-found", `${command}: ${FETCH_EXPIRED}`);
    const meta = await objects.stat(digest);
    if (meta === undefined) throw notExecuted("not-found", `${command}: ${FETCH_EXPIRED}`);
    return { row: row.value, meta, objects };
  }

  fetchBegin = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsFetchBeginOutput> => {
    const args = sctx.request.args as unknown as ArtifactsFetchBeginInput;
    const { row, meta } = await this.fetchGate(sctx, "fetch-begin", args.digest, args.channel);
    scope.fence.check(scope.generation, "the fetch-begin reply");
    return { name: row.name, mediaType: row.mediaType, size: meta.size };
  };

  fetchChunk = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsFetchChunkOutput> => {
    const args = sctx.request.args as unknown as ArtifactsFetchChunkInput;
    const { meta, objects } = await this.fetchGate(sctx, "fetch-chunk", args.digest, args.channel);
    if (args.offset > meta.size) throw notExecuted("bad-request", `fetch-chunk: offset ${args.offset} is past the ${meta.size}-byte artifact`);
    if (!sctx.replyFits) throw notExecuted("unavailable", "fetch-chunk: this serving connection cannot measure a reply, so no chunk is sent");
    const fits = sctx.replyFits;
    await this.deps.hold?.("fetch-read");
    const collected = await collectChunk(objects, meta, args.offset, fits);
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
    const fence = writeFence(scope);
    await this.deps.locks.run(args.digest, async () => {
      await this.deps.hold?.("confirm-locked");
      const possession = await index.readPossession(args.digest, caller);
      if (possession === undefined) throw confirmRefused();
      // No attachment is ever created for swept bytes (plan section 6).
      if ((await objects.stat(args.digest)) === undefined) throw confirmRefused();
      const now = this.now();
      const inserted = await index.attachIfAbsent(channel, args.digest, {
        state: "attached", confirmerLifecycleUid: caller.uid, name: possession.value.name, mediaType: possession.value.mediaType,
        size: possession.value.size, createdAt: now, expiresAt: now + ARTIFACT_ATTACHMENT_TTL_MS, pinned: false,
      }, fence.guard);
      // Re-read possession after the insert, and roll back only an insert of our own (S19).
      if (inserted && (await index.readPossession(args.digest, caller)) === undefined) {
        await index.rollbackAttach(channel, args.digest, fence.guard);
        throw confirmRefused();
      }
      await index.deleteReservation(args.digest, caller, fence.guard);
    });
    fence.reply("the confirm reply");
    return {};
  };

  pin = (scope: ServeScope) => async (sctx: EpServeContext): Promise<Record<string, never>> => {
    const args = sctx.request.args as unknown as ArtifactsPinInput;
    let channel: string;
    try { channel = concreteChannel(args.channel); } catch (e) { throw notExecuted("bad-request", `pin: ${(e as Error).message}`); }
    const caller = await this.deps.fenceCaller(sctx.subject.caller, "pin");
    const refused = () => notExecuted("permission-denied", "pin: not authorized for that artifact");
    const { index } = this.stores("pin");
    const fence = writeFence(scope);
    await this.deps.locks.run(args.digest, async () => {
      const row = await index.readAttachment(channel, args.digest);
      if (row === undefined || row.value.state !== "attached") throw refused();
      // Possession at the live lifecycle, or the caller is the lifecycle that confirmed this attachment.
      const holds = (await index.readPossession(args.digest, caller)) !== undefined || row.value.confirmerLifecycleUid === caller.uid;
      if (!holds) throw refused();
      if (!(await index.pin(channel, args.digest, fence.guard))) throw refused();
    });
    fence.reply("the pin reply");
    return {};
  };
}

/** The bytes one `fetch-chunk` reply carries from `offset`: whole stored chunks while the ACTUAL reply
 *  still fits, or, when not even the rest of the first chunk fits, the largest prefix of it that does (a
 *  measured binary search), so every call makes progress or refuses by name. Stored chunks are fixed
 *  size, so the chunk holding `offset` is found without reading the ones before it. Each read asks the
 *  store for exactly one stored chunk's byte range, in stored-chunk order. */
async function collectChunk(
  objects: ArtifactStoreSpace,
  meta: { digest: string; size: number; blocks: number },
  offset: number,
  fits: (data: unknown, ceiling: number) => boolean,
): Promise<Buffer> {
  const read = async (j: number, stride: number) => {
    const from = j * stride, length = Math.min(stride, meta.size - from);
    const c = await objects.read(meta.digest, from, length);
    if (c === undefined) throw notExecuted("not-found", `fetch-chunk: ${FETCH_EXPIRED}`);
    return c;
  };
  const stride = (await read(0, objects.blockBytes)).byteLength;
  const first = Math.min(Math.floor(offset / stride), Math.max(0, meta.blocks - 1));
  let collected = Buffer.alloc(0);
  for (let j = first; j < meta.blocks; j++) {
    const c = await read(j, stride);
    const from = j === first ? offset - first * stride : 0;
    const next = Buffer.concat([collected, Buffer.from(c.subarray(from))]);
    const done = offset + next.byteLength >= meta.size;
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
  return collected;
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

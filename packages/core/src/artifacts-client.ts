/**
 * Client methods for the `artifacts` endpoint (A1, plan section 7): thin delegators over one endpoint's
 * `invokeService`. Server code lives in the delivery daemon; core holds the wire contract and this.
 *
 *  - `putArtifact` stages, sends and commits bytes, sizing every chunk inside the ACTUAL attempt that
 *    sends it (E6, E21): the envelope depends on the caller's names, the instance it binds, the deadline
 *    and a sequence that grows digits as the transfer proceeds, and a re-issue may change any of them,
 *    so the attempt measures its own frame. A call that cannot carry one raw byte under the broker's
 *    limit refuses before any publish.
 *  - `fetchArtifact` reads chunks until the daemon says the artifact is complete, then verifies the
 *    digest of what arrived. Bytes that do not hash to the digest asked for are never returned.
 *  - `listArtifacts`, `confirmAttach`, `pinArtifact`: one call each.
 *
 * A refusal is thrown as the daemon sent it (`EpEnvelopeError` with its code and outcome).
 */
import { createHash } from "node:crypto";
import {
  ARTIFACT_CHUNK_MAX, ARTIFACTS_CONFIRM_ATTACH_COMMAND, ARTIFACTS_ENDPOINT, ARTIFACTS_FETCH_BEGIN_COMMAND, ARTIFACTS_FETCH_CHUNK_COMMAND,
  ARTIFACTS_LIST_COMMAND, ARTIFACTS_PIN_COMMAND, ARTIFACTS_PUT_BEGIN_COMMAND, ARTIFACTS_PUT_CHUNK_COMMAND, ARTIFACTS_PUT_COMMIT_COMMAND,
  type ArtifactsFetchBeginOutput, type ArtifactsFetchChunkOutput, type ArtifactsListInput, type ArtifactsListOutput,
  type ArtifactsPutBeginOutput, type ArtifactsPutCommitOutput,
} from "./artifacts-contract.js";
import type { EpArgsFit, EpAttributedReply } from "./endpoint-call.js";
import { EP_ERROR_CODES, EpEnvelopeError, type EpErrorCode } from "./endpoint-error.js";

/** What these methods need from a connected endpoint. `CotalEndpoint` satisfies it. */
export interface ArtifactsCaller {
  readonly space: string;
  invokeService(endpoint: string, command: string, args?: Record<string, unknown>, opts?: { deadlineMs?: number; fitArgs?: EpArgsFit }): Promise<EpAttributedReply>;
}

async function call<T>(ep: ArtifactsCaller, command: string, args: Record<string, unknown>, fitArgs?: EpArgsFit): Promise<T> {
  const { reply } = await ep.invokeService(ARTIFACTS_ENDPOINT, command, args, fitArgs ? { fitArgs } : undefined);
  if (!reply.ok) {
    const err = reply.error;
    // A code outside the closed set (a newer responder) is reported as `internal`, never trusted as one.
    const code = (EP_ERROR_CODES as readonly string[]).includes(err?.code ?? "") ? err!.code as EpErrorCode : "internal";
    throw new EpEnvelopeError(code, err?.message ?? `${command} failed`, err?.details, err?.outcome);
  }
  return reply.data as T;
}

/** The largest raw byte count, at most `maxRaw`, whose `put-chunk` request fits `budget`, where
 *  `frame(raw)` is the bytes the actual attempt would send carrying `raw` bytes. Throws, before
 *  anything is sent, when not even one byte fits. This is the measuring function each `put-chunk`
 *  attempt runs inside `epCall` (E21), with that attempt's own frame and the connection's limit. */
export function fitPutChunk(frame: (raw: number) => number, budget: number, maxRaw: number): number {
  // The contract bounds one chunk; a larger ask is clamped to it, never sent.
  maxRaw = Math.min(maxRaw, ARTIFACT_CHUNK_MAX);
  if (maxRaw < 1) throw new RangeError(`fitPutChunk: maxRaw must be at least 1, got ${maxRaw}`);
  if (frame(1) > budget)
    throw new EpEnvelopeError("resource-exhausted", `put-chunk: the broker's message limit leaves ${budget} bytes for a request and one raw byte of this upload frames to ${frame(1)}; nothing was sent`, undefined, "not-executed");
  if (frame(maxRaw) <= budget) return maxRaw;
  let lo = 1, hi = maxRaw;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frame(mid) <= budget) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Commit `bytes` to the artifact store. Returns the digest and size the daemon verified. The bytes are
 *  not yet visible to anyone: publish a reference with `multicastWithAck` and confirm it.
 *
 *  Each `put-chunk` is sized INSIDE its own attempt (E21): the call layer hands {@link fitPutChunk} the
 *  frame that attempt would send (its route, bind, caller, nonce and deadline) and the connection's
 *  limit, and a re-resolved or re-issued attempt measures again. */
export async function putArtifact(ep: ArtifactsCaller, bytes: Uint8Array, meta: { name: string; mediaType: string }): Promise<ArtifactsPutCommitOutput> {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const { uploadId } = await call<ArtifactsPutBeginOutput>(ep, ARTIFACTS_PUT_BEGIN_COMMAND, { name: meta.name, mediaType: meta.mediaType, size: bytes.byteLength, digest });
  let offset = 0, seq = 0;
  while (offset < bytes.byteLength) {
    let sent = 0;
    const rest = Math.min(ARTIFACT_CHUNK_MAX, bytes.byteLength - offset);
    const slice = (n: number) => Buffer.from(bytes.subarray(offset, offset + n)).toString("base64");
    await call(ep, ARTIFACTS_PUT_CHUNK_COMMAND, { uploadId, seq, data: slice(rest) }, (measure, budget) => {
      sent = fitPutChunk((raw) => measure({ uploadId, seq, data: slice(raw) }), budget, rest);
      return { uploadId, seq, data: slice(sent) };
    });
    offset += sent;
    seq += 1;
  }
  return call<ArtifactsPutCommitOutput>(ep, ARTIFACTS_PUT_COMMIT_COMMAND, { uploadId });
}

/** The bytes of `digest` as attached in `channel`, verified against the digest. */
export async function fetchArtifact(ep: ArtifactsCaller, digest: string, channel: string): Promise<{ name: string; mediaType: string; bytes: Uint8Array }> {
  const head = await call<ArtifactsFetchBeginOutput>(ep, ARTIFACTS_FETCH_BEGIN_COMMAND, { digest, channel });
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const r = await call<ArtifactsFetchChunkOutput>(ep, ARTIFACTS_FETCH_CHUNK_COMMAND, { digest, channel, offset });
    const chunk = Buffer.from(r.data, "base64");
    if (chunk.byteLength === 0 && !r.complete)
      throw new EpEnvelopeError("internal", `fetch-chunk returned no bytes at offset ${offset} without completing; the transfer cannot make progress`);
    parts.push(chunk);
    offset += chunk.byteLength;
    if (offset > head.size) throw new EpEnvelopeError("internal", `fetch returned more than the ${head.size} bytes it announced`);
    if (r.complete) break;
  }
  const bytes = Buffer.concat(parts);
  const got = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (got !== digest) throw new EpEnvelopeError("internal", `the fetched bytes hash to ${got}, not ${digest}; they were discarded`);
  return { name: head.name, mediaType: head.mediaType, bytes: new Uint8Array(bytes) };
}

/** One page of the artifacts attached in `channel`. */
export function listArtifacts(ep: ArtifactsCaller, input: ArtifactsListInput): Promise<ArtifactsListOutput> {
  return call<ArtifactsListOutput>(ep, ARTIFACTS_LIST_COMMAND, { ...input });
}

/** Attach `digest` to `channel`, proving the caller published the post acknowledged at `seq`. */
export async function confirmAttach(ep: ArtifactsCaller, args: { digest: string; channel: string; seq: number }): Promise<void> {
  await call(ep, ARTIFACTS_CONFIRM_ATTACH_COMMAND, { ...args });
}

/** Clear the expiry of `digest`'s attachment in `channel`. */
export async function pinArtifact(ep: ArtifactsCaller, args: { digest: string; channel: string }): Promise<void> {
  await call(ep, ARTIFACTS_PIN_COMMAND, { ...args });
}

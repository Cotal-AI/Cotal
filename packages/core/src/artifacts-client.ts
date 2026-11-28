/**
 * Client methods for the `artifacts` endpoint (A1, plan section 7): thin delegators over one endpoint's
 * `invokeService`. Server code lives in the delivery daemon; core holds the wire contract and this.
 *
 *  - `putArtifact` stages, sends and commits bytes, sizing every chunk from the ACTUAL serialized request
 *    the real call builder produces for that very call (E6): the envelope depends on the caller's names,
 *    the instance it binds and a sequence that grows digits as the transfer proceeds, so no constant can
 *    stand in for it. A call that cannot carry one raw byte under the broker's limit refuses before any
 *    publish.
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
import { requestFrameBytes, type EpAttributedReply } from "./endpoint-call.js";
import type { ResolvedService } from "./endpoint-caller.js";
import { EP_ERROR_CODES, EpEnvelopeError, type EpErrorCode } from "./endpoint-error.js";

/** What these methods need from a connected endpoint. `CotalEndpoint` satisfies it. */
export interface ArtifactsCaller {
  readonly space: string;
  readonly maxPayload: number;
  invokeService(endpoint: string, command: string, args?: Record<string, unknown>, opts?: { deadlineMs?: number }): Promise<EpAttributedReply>;
  describeService(endpoint: string, opts?: { deadlineMs?: number }): Promise<ResolvedService>;
}

/** Headroom under `max_payload` for the headers the client adds to a request. */
const HEADER_ALLOWANCE = 256;

async function call<T>(ep: ArtifactsCaller, command: string, args: Record<string, unknown>): Promise<T> {
  const { reply } = await ep.invokeService(ARTIFACTS_ENDPOINT, command, args);
  if (!reply.ok) {
    const err = reply.error;
    // A code outside the closed set (a newer responder) is reported as `internal`, never trusted as one.
    const code = (EP_ERROR_CODES as readonly string[]).includes(err?.code ?? "") ? err!.code as EpErrorCode : "internal";
    throw new EpEnvelopeError(code, err?.message ?? `${command} failed`, err?.details, err?.outcome);
  }
  return reply.data as T;
}

/** The largest raw byte count whose `put-chunk` request fits the broker's limit, measured on the real
 *  frame for this `uploadId` and `seq`. Throws when not even one byte fits. */
export function fitPutChunk(ep: Pick<ArtifactsCaller, "space" | "maxPayload">, service: ResolvedService, uploadId: string, seq: number, maxRaw: number): number {
  const resolved = service.commands.get(ARTIFACTS_PUT_CHUNK_COMMAND);
  if (resolved === undefined) throw new EpEnvelopeError("not-found", `${ARTIFACTS_ENDPOINT} does not serve ${ARTIFACTS_PUT_CHUNK_COMMAND}`, undefined, "not-executed");
  const budget = ep.maxPayload - HEADER_ALLOWANCE;
  const frame = (raw: number) => requestFrameBytes(ep.space, { mode: "one" }, {
    endpoint: ARTIFACTS_ENDPOINT, command: ARTIFACTS_PUT_CHUNK_COMMAND, contract: resolved.contract, caller: service.caller,
    args: { uploadId, seq, data: Buffer.alloc(raw).toString("base64") },
    bind: { instanceId: service.responder.instanceId, epoch: service.responder.epoch },
  });
  if (frame(1) > budget)
    throw new EpEnvelopeError("resource-exhausted", `put-chunk: the broker's ${ep.maxPayload}-byte message limit cannot carry one raw byte of this upload (one byte frames to ${frame(1)} bytes); nothing was sent`, undefined, "not-executed");
  if (frame(maxRaw) <= budget) return maxRaw;
  let lo = 1, hi = maxRaw;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frame(mid) <= budget) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Commit `bytes` to the artifact store. Returns the digest and size the daemon verified. The bytes are
 *  not yet visible to anyone: publish a reference with `multicastWithAck` and confirm it. */
export async function putArtifact(ep: ArtifactsCaller, bytes: Uint8Array, meta: { name: string; mediaType: string }): Promise<ArtifactsPutCommitOutput> {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const service = await ep.describeService(ARTIFACTS_ENDPOINT);
  const { uploadId } = await call<ArtifactsPutBeginOutput>(ep, ARTIFACTS_PUT_BEGIN_COMMAND, { name: meta.name, mediaType: meta.mediaType, size: bytes.byteLength, digest });
  let offset = 0, seq = 0;
  while (offset < bytes.byteLength) {
    // Re-measured on every call: the frame for chunk 10 is a byte longer than the frame for chunk 9.
    const take = fitPutChunk(ep, service, uploadId, seq, Math.min(ARTIFACT_CHUNK_MAX, bytes.byteLength - offset));
    const data = Buffer.from(bytes.subarray(offset, offset + take)).toString("base64");
    await call(ep, ARTIFACTS_PUT_CHUNK_COMMAND, { uploadId, seq, data });
    offset += take;
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

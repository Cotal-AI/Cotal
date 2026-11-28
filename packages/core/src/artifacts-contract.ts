/**
 * The `artifacts` endpoint's wire contract (artifact plane 5.1; endpoint name a draft). The delivery
 * daemon serves it. Every command is untargeted and ephemeral. An agent may send a request only when it
 * was minted with the `artifacts` capability token (`ARTIFACTS_CAPABILITY` in endpoint-grants.ts); no
 * baseline credential carries these rows. The commands still authorize each call against the caller's
 * live read rule and possession, never against the grant alone.
 *
 * The commands: `put-begin`, `put-chunk`, `put-commit` stage, hash and commit bytes; `fetch-begin` and
 * `fetch-chunk` read them back for a channel the caller may read; `list` pages a channel's attachments;
 * `confirm-attach` attaches a committed artifact to the channel the caller published it on; `pin` clears
 * an attachment's expiry. Bytes ride base64 in `data`.
 */
import { buildClusterArtifacts, buildClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import type { ContractClosureManifest } from "./contract-manifest.js";
import { serviceContractTable } from "./schema-profile.js";

export const ARTIFACTS_ENDPOINT = "artifacts";
export const ARTIFACTS_CLUSTER_URN = "ai.cotal.artifacts";
export const ARTIFACTS_LIST_COMMAND = "list";
export const ARTIFACTS_PUT_BEGIN_COMMAND = "put-begin";
export const ARTIFACTS_PUT_CHUNK_COMMAND = "put-chunk";
export const ARTIFACTS_PUT_COMMIT_COMMAND = "put-commit";
export const ARTIFACTS_FETCH_BEGIN_COMMAND = "fetch-begin";
export const ARTIFACTS_FETCH_CHUNK_COMMAND = "fetch-chunk";
export const ARTIFACTS_CONFIRM_ATTACH_COMMAND = "confirm-attach";
export const ARTIFACTS_PIN_COMMAND = "pin";

/** The largest artifact one put may stage (plan section 8; a draft value, open for the owner). A named
 *  constant so A3's admission hook can replace how the limit is decided. */
export const ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
/** Concurrent staged uploads one caller lifecycle may hold. */
export const ARTIFACT_MAX_STAGED_UPLOADS = 4;
/** Bytes one caller lifecycle may hold staged across its uploads, charged at `put-begin`. */
export const ARTIFACT_MAX_STAGED_BYTES = 512 * 1024 * 1024;
/** How long an attachment lives unless pinned (plan section 7). */
export const ARTIFACT_ATTACHMENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** How long a commit's reservation protects its bytes from the sweep while its confirm is pending. */
export const ARTIFACT_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a begun, uncommitted upload is held before it is dropped. */
export const ARTIFACT_STAGE_TTL_MS = 60 * 60 * 1000;
/** The largest raw chunk one `put-chunk` or `fetch-chunk` carries, before fitting it to the broker. */
export const ARTIFACT_CHUNK_MAX = 128 * 1024;

/** The most rows one `list` page carries. A page is also cut short to fit a broker message. */
export const ARTIFACTS_LIST_PAGE_LIMIT = 100;

/** The digest form every artifact reference carries (SPEC section 5). */
const DIGEST = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } as const;
/** A policy channel's character set. The schema profile refuses a repeated group with a quantifier
 *  inside, so empty segments and wildcards are refused by the handler's `assertValidChannel` and
 *  concrete-channel check, never by this pattern alone. */
const CHANNEL = { type: "string", minLength: 1, maxLength: 4096, pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]*$" } as const;

export interface ArtifactsListInput {
  channel: string;
  limit?: number;
  /** The last digest of the previous page. */
  after?: string;
}

/** One attachment as the commit recorded it: never the carrying message's claims (plan section 3). */
export interface ArtifactsListRow {
  digest: string;
  name: string;
  mediaType: string;
  size: number;
  /** When the attachment was confirmed, epoch milliseconds. */
  attachedAt: number;
  /** When it lapses unless pinned, epoch milliseconds; absent when pinned. */
  expiresAt?: number;
  pinned: boolean;
}

export interface ArtifactsListOutput {
  rows: ArtifactsListRow[];
  next?: string;
}

const LIST_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["channel"],
  properties: {
    channel: CHANNEL,
    limit: { type: "integer", minimum: 1, maximum: ARTIFACTS_LIST_PAGE_LIMIT },
    after: DIGEST,
  },
} as const;

const LIST_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      maxItems: ARTIFACTS_LIST_PAGE_LIMIT,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["digest", "name", "mediaType", "size", "attachedAt", "pinned"],
        properties: {
          digest: DIGEST,
          name: { type: "string", minLength: 1, maxLength: 256 },
          mediaType: { type: "string", minLength: 1, maxLength: 256 },
          size: { type: "integer", minimum: 0 },
          attachedAt: { type: "integer", minimum: 0 },
          expiresAt: { type: "integer", minimum: 0 },
          pinned: { type: "boolean" },
        },
      },
    },
    next: DIGEST,
  },
} as const;

/** Base64 of one raw chunk. The upper bound is the base64 length of the largest raw chunk; the live
 *  broker limit is enforced separately, per call, by the client and by `replyFits`. */
const DATA = { type: "string", maxLength: 4 * Math.ceil(ARTIFACT_CHUNK_MAX / 3), pattern: "^[A-Za-z0-9+/]*={0,2}$" } as const;
const UPLOAD_ID = { type: "string", pattern: "^[0-9a-f]{32}$" } as const;
const NAME = { type: "string", minLength: 1, maxLength: 256 } as const;
const MEDIA_TYPE = { type: "string", minLength: 1, maxLength: 256 } as const;
const SIZE = { type: "integer", minimum: 0, maximum: ARTIFACT_MAX_BYTES } as const;
const OFFSET = { type: "integer", minimum: 0, maximum: ARTIFACT_MAX_BYTES } as const;
const SEQ = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

export interface ArtifactsPutBeginInput { name: string; mediaType: string; size: number; digest: string }
export interface ArtifactsPutBeginOutput { uploadId: string }
export interface ArtifactsPutChunkInput { uploadId: string; seq: number; data: string }
export interface ArtifactsPutChunkOutput { received: number }
export interface ArtifactsPutCommitInput { uploadId: string }
export interface ArtifactsPutCommitOutput { digest: string; size: number }
export interface ArtifactsFetchBeginInput { digest: string; channel: string }
/** Commit-time store metadata, never the carrying message's claims. */
export interface ArtifactsFetchBeginOutput { name: string; mediaType: string; size: number }
export interface ArtifactsFetchChunkInput { digest: string; channel: string; offset: number }
export interface ArtifactsFetchChunkOutput { data: string; complete: boolean }
/** `seq` is the chat stream sequence the publish acknowledged (see `multicastWithAck`). */
export interface ArtifactsConfirmAttachInput { digest: string; channel: string; seq: number }
export interface ArtifactsPinInput { digest: string; channel: string }

const closed = (required: string[], properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required, properties });
const PUT_BEGIN_INPUT = closed(["name", "mediaType", "size", "digest"], { name: NAME, mediaType: MEDIA_TYPE, size: SIZE, digest: DIGEST });
const PUT_BEGIN_OUTPUT = closed(["uploadId"], { uploadId: UPLOAD_ID });
const PUT_CHUNK_INPUT = closed(["uploadId", "seq", "data"], { uploadId: UPLOAD_ID, seq: SEQ, data: DATA });
const PUT_CHUNK_OUTPUT = closed(["received"], { received: SIZE });
const PUT_COMMIT_INPUT = closed(["uploadId"], { uploadId: UPLOAD_ID });
const PUT_COMMIT_OUTPUT = closed(["digest", "size"], { digest: DIGEST, size: SIZE });
const FETCH_BEGIN_INPUT = closed(["digest", "channel"], { digest: DIGEST, channel: CHANNEL });
const FETCH_BEGIN_OUTPUT = closed(["name", "mediaType", "size"], { name: NAME, mediaType: MEDIA_TYPE, size: SIZE });
const FETCH_CHUNK_INPUT = closed(["digest", "channel", "offset"], { digest: DIGEST, channel: CHANNEL, offset: OFFSET });
const FETCH_CHUNK_OUTPUT = closed(["data", "complete"], { data: DATA, complete: { type: "boolean" } });
const CONFIRM_ATTACH_INPUT = closed(["digest", "channel", "seq"], { digest: DIGEST, channel: CHANNEL, seq: SEQ });
const PIN_INPUT = closed(["digest", "channel"], { digest: DIGEST, channel: CHANNEL });
const EMPTY_OUTPUT = closed([], {});

const ROWS = [
  { name: ARTIFACTS_LIST_COMMAND, capability: "artifacts.list", input: LIST_INPUT, output: LIST_OUTPUT, targeted: false },
  { name: ARTIFACTS_PUT_BEGIN_COMMAND, capability: "artifacts.put", input: PUT_BEGIN_INPUT, output: PUT_BEGIN_OUTPUT, targeted: false },
  { name: ARTIFACTS_PUT_CHUNK_COMMAND, capability: "artifacts.put", input: PUT_CHUNK_INPUT, output: PUT_CHUNK_OUTPUT, targeted: false },
  { name: ARTIFACTS_PUT_COMMIT_COMMAND, capability: "artifacts.put", input: PUT_COMMIT_INPUT, output: PUT_COMMIT_OUTPUT, targeted: false },
  { name: ARTIFACTS_FETCH_BEGIN_COMMAND, capability: "artifacts.fetch", input: FETCH_BEGIN_INPUT, output: FETCH_BEGIN_OUTPUT, targeted: false },
  { name: ARTIFACTS_FETCH_CHUNK_COMMAND, capability: "artifacts.fetch", input: FETCH_CHUNK_INPUT, output: FETCH_CHUNK_OUTPUT, targeted: false },
  { name: ARTIFACTS_CONFIRM_ATTACH_COMMAND, capability: "artifacts.attach", input: CONFIRM_ATTACH_INPUT, output: EMPTY_OUTPUT, targeted: false },
  { name: ARTIFACTS_PIN_COMMAND, capability: "artifacts.pin", input: PIN_INPUT, output: EMPTY_OUTPUT, targeted: false },
];

const TABLE = serviceContractTable(ROWS);

/** The compiled input/output pair per command, compiled on first access. */
export const ARTIFACTS_CONTRACTS = TABLE.contracts;

/** Every contract artifact the endpoint publishes to the contract store at registration. */
export const artifactsContractArtifactValues = TABLE.artifactValues;

/** The command names this revision serves: the rows the `artifacts` capability token grants. */
export const ARTIFACTS_COMMANDS: readonly string[] = Object.freeze(ROWS.map((row) => row.name));

/** The cluster document for the served commands. Revision 2: all eight. */
export function artifactsClusterDocument(): ClusterDocument {
  return buildClusterDocument(ARTIFACTS_CLUSTER_URN, 2, ROWS);
}

/** The document's two digests: the root artifact and the closure manifest the service spec names. */
export function artifactsClusterArtifacts(): { document: ClusterDocument; rootDigest: string; manifest: ContractClosureManifest; closureDigest: string } {
  return buildClusterArtifacts(artifactsClusterDocument());
}

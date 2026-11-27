/**
 * The `artifacts` endpoint's wire contract (artifact plane 5.1; endpoint name a draft). The delivery
 * daemon serves it. Every command is untargeted and ephemeral and rides its own capability, and every
 * caller gets the request rows in its baseline: the commands authorize per call against the caller's
 * live read rule and possession, never against the grant alone.
 *
 * This revision serves `list`: the attachments of one concrete channel the caller may read, paged by
 * `{ limit?, after? }`. The put, fetch, confirm and pin commands join it in a later revision.
 */
import { buildClusterArtifacts, buildClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import type { ContractClosureManifest } from "./contract-manifest.js";
import { serviceContractTable } from "./schema-profile.js";

export const ARTIFACTS_ENDPOINT = "artifacts";
export const ARTIFACTS_CLUSTER_URN = "ai.cotal.artifacts";
export const ARTIFACTS_LIST_COMMAND = "list";

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

const ROWS = [
  { name: ARTIFACTS_LIST_COMMAND, capability: "artifacts.list", input: LIST_INPUT, output: LIST_OUTPUT, targeted: false },
];

const TABLE = serviceContractTable(ROWS);

/** The compiled input/output pair per command, compiled on first access. */
export const ARTIFACTS_CONTRACTS = TABLE.contracts;

/** Every contract artifact the endpoint publishes to the contract store at registration. */
export const artifactsContractArtifactValues = TABLE.artifactValues;

/** The command names this revision serves, for the baseline caller rows. */
export const ARTIFACTS_COMMANDS: readonly string[] = Object.freeze(ROWS.map((row) => row.name));

/** The cluster document for the served commands. Revision 1: `list`. */
export function artifactsClusterDocument(): ClusterDocument {
  return buildClusterDocument(ARTIFACTS_CLUSTER_URN, 1, ROWS);
}

/** The document's two digests: the root artifact and the closure manifest the service spec names. */
export function artifactsClusterArtifacts(): { document: ClusterDocument; rootDigest: string; manifest: ContractClosureManifest; closureDigest: string } {
  return buildClusterArtifacts(artifactsClusterDocument());
}

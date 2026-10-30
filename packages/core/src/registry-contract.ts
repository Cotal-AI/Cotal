/**
 * The registry's wire contract (SPEC 13.17). `registry` is a registered endpoint that answers
 * discovery questions: one untargeted, ephemeral, read-only command per question, each behind its
 * own capability so the broker checks a grant per question. Every answer is `{ rows, next?, source }`,
 * paged by `{ limit?, after? }`. This revision has one question, `endpoints`: the registered
 * endpoints the caller holds a command on, and the request forms its recorded ceiling covers.
 */
import { buildClusterArtifacts, buildClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import type { EpCapability } from "./endpoint-grants.js";
import type { ContractClosureManifest } from "./contract-manifest.js";
import { serviceContractTable } from "./schema-profile.js";

export const REGISTRY_ENDPOINT = "registry";
export const REGISTRY_CLUSTER_URN = "ai.cotal.registry";
export const REGISTRY_ENDPOINTS_COMMAND = "endpoints";
export const REGISTRY_ENDPOINTS_CAPABILITY = "registry.endpoints";

/** The most rows one `endpoints` page carries. A page is also cut short to fit a broker message. */
export const REGISTRY_PAGE_LIMIT = 100;

/** The one grant a listing needs: the `endpoints` request on the class route. */
export const REGISTRY_ENDPOINTS_GRANT: EpCapability = Object.freeze({ endpoint: REGISTRY_ENDPOINT, command: REGISTRY_ENDPOINTS_COMMAND });

/** Where a page's rows came from. `recorded-ceiling`: the caller's recorded issued publish
 *  ceiling, source liveness not checked, so the broker or the endpoint may still refuse a listed
 *  command. `no-permission-system`: an open mesh, where every registered endpoint is callable. */
export type RegistrySource = "recorded-ceiling" | "no-permission-system";

export interface RegistryEndpointsInput {
  limit?: number;
  /** The last endpoint name of the previous page. */
  after?: string;
}

/** One registered instance as its records state it. `state` is the recorded serving state, not
 *  a liveness check; `artifacts` says whether its command declarations could be read. */
export interface RegistryInstance {
  instanceId: string;
  state: string | null;
  artifacts: "verified" | "missing" | "invalid";
}

/** One covered request form: the rail, route and mode, each parameter's named literals, and the
 *  covered combinations (a literal, `null` for any value not named, `"*"` for any value). */
export interface RegistryForm {
  rail: "ep" | "ep.v1" | "epj";
  route?: "one" | "all" | "inst";
  mode?: string;
  literals: Record<string, string[]>;
  covered: Record<string, string | null>[];
}

export interface RegistryCommand {
  name: string;
  class: "ephemeral" | "journal";
  forms: RegistryForm[];
  /** The instances declaring this command, present only when not every instance does. */
  instances?: string[];
}

export interface RegistryEndpointRow {
  endpoint: string;
  instances: RegistryInstance[];
  commands: RegistryCommand[];
  /** Commands whose coverage could not be projected within the combination limit. */
  unprojected?: string[];
}

export interface RegistryEndpointsOutput {
  rows: RegistryEndpointRow[];
  next?: string;
  source: RegistrySource;
}

const NAME = { type: "string", minLength: 1, maxLength: 128 } as const;
const TOKEN = { type: "string", minLength: 1, maxLength: 64 } as const;

const ENDPOINTS_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: REGISTRY_PAGE_LIMIT },
    after: NAME,
  },
} as const;

const FORM = {
  type: "object",
  additionalProperties: false,
  required: ["rail", "literals", "covered"],
  properties: {
    rail: { enum: ["ep", "ep.v1", "epj"] },
    route: { enum: ["one", "all", "inst"] },
    mode: TOKEN,
    literals: { type: "object", additionalProperties: { type: "array", items: TOKEN } },
    covered: { type: "array", items: { type: "object", additionalProperties: { type: ["string", "null"], maxLength: 64 } } },
  },
} as const;

const ENDPOINTS_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "source"],
  properties: {
    rows: {
      type: "array",
      maxItems: REGISTRY_PAGE_LIMIT,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["endpoint", "instances", "commands"],
        properties: {
          endpoint: NAME,
          instances: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["instanceId", "state", "artifacts"],
              properties: {
                instanceId: TOKEN,
                state: { type: ["string", "null"], maxLength: 64 },
                artifacts: { enum: ["verified", "missing", "invalid"] },
              },
            },
          },
          commands: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "class", "forms"],
              properties: {
                name: TOKEN,
                class: { enum: ["ephemeral", "journal"] },
                forms: { type: "array", items: FORM },
                instances: { type: "array", items: TOKEN },
              },
            },
          },
          unprojected: { type: "array", items: TOKEN },
        },
      },
    },
    next: NAME,
    source: { enum: ["recorded-ceiling", "no-permission-system"] },
  },
} as const;

const ROWS = [
  { name: REGISTRY_ENDPOINTS_COMMAND, capability: REGISTRY_ENDPOINTS_CAPABILITY, input: ENDPOINTS_INPUT, output: ENDPOINTS_OUTPUT, targeted: false },
];

const TABLE = serviceContractTable(ROWS);

/** The compiled input/output pair per command, compiled on first access. */
export const REGISTRY_CONTRACTS = TABLE.contracts;

/** Every contract artifact the registry publishes to the contract store at registration. */
export const registryContractArtifactValues = TABLE.artifactValues;

/** The cluster document for the registry's served commands. Revision 1: `endpoints`. */
export function registryClusterDocument(): ClusterDocument {
  return buildClusterDocument(REGISTRY_CLUSTER_URN, 1, ROWS);
}

/** The document's two digests: the root artifact and the closure manifest the service spec names. */
export function registryClusterArtifacts(): { document: ClusterDocument; rootDigest: string; manifest: ContractClosureManifest; closureDigest: string } {
  return buildClusterArtifacts(registryClusterDocument());
}

// The review cluster's contracts (SPEC §13.7). Two JSON Schema 2020-12 documents — the PR-packet
// input and the findings output — compiled to provenance-branded validators, plus a cluster
// document whose commands pin those schemas by closure digest. Every reviewer instance registers
// the SAME clusterDigest, so a run that served a different contract is structurally excluded from
// the vote (§13.5 registrationRevision freeze). Replies are ajv-validated at the serving boundary
// AND caller-side by the scatter, so the orchestrator never sees a malformed finding.
import {
  compileContract,
  contractDigest,
  buildContractClosureManifest,
  type CompiledContract,
} from "@cotal-ai/core";

/** The endpoint (reverse-DNS; wire token `ai_cotal_reviewer`) and its cluster URN (§13.7). */
export const REVIEW_ENDPOINT = "ai.cotal.reviewer";
export const REVIEW_CLUSTER_URN = "ai.cotal.review";
export const REVIEW_OWNER = "u_cotal";

/** One command per persona; each is untargeted, ephemeral, scattered on the `all` rail. */
export const PERSONAS = ["bughunter", "keeper", "sweeper"] as const;
export type Persona = (typeof PERSONAS)[number];
export const commandFor = (persona: Persona): string => `review-${persona}`;

/** The PR packet a reviewer sees. The patch rides `args` (the body), never the subject (§13.4). */
export interface PrPacket {
  prUrl: string;
  title: string;
  body?: string;
  patch: string;
  context?: string;
  maxFindings?: number;
}

export interface Finding {
  path: string | null;
  line: number | null;
  severity: "HIGH" | "MED" | "LOW";
  body: string;
}

export interface ReviewFindings {
  findings: Finding[];
}

// Input (PR packet) — the patch is bounded by max_payload, not the 1 KiB subject bound (§13.2).
const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prUrl", "title", "patch"],
  properties: {
    prUrl: { type: "string", maxLength: 512 },
    title: { type: "string", maxLength: 1024 },
    body: { type: "string", maxLength: 8192 },
    patch: { type: "string", maxLength: 400000 },
    context: { type: "string", maxLength: 400000 },
    maxFindings: { type: "integer", minimum: 1, maximum: 32 },
  },
} as const;

// Output (findings) — the win that replaces the JSON-repair pass on the wire.
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["body", "severity"],
        properties: {
          path: { type: ["string", "null"], maxLength: 512 },
          line: { type: ["integer", "null"], minimum: 0 },
          severity: { enum: ["HIGH", "MED", "LOW"] },
          body: { type: "string", maxLength: 4096 },
        },
      },
    },
  },
} as const;

export const inputContract: CompiledContract = compileContract({ root: INPUT_SCHEMA });
export const outputContract: CompiledContract = compileContract({ root: OUTPUT_SCHEMA });

// The §13.7 cluster document: the content-addressed authority for every command's served shape.
// Its commands pin the input/output schemas by their compiled closure digests.
const clusterDocument = {
  urn: REVIEW_CLUSTER_URN,
  revision: 1,
  attributes: [],
  events: [],
  commands: PERSONAS.map((persona) => ({
    name: commandFor(persona),
    class: "ephemeral",
    targeted: false,
    capability: "manager.call",
    inputDigest: inputContract.closureDigest,
    outputDigest: outputContract.closureDigest,
  })),
};

// A minimal content-addressed contract store (SPEC §13.7 two-digest addressing): the cluster
// DOCUMENT lives at its artifact digest; a single-member closure MANIFEST `{v,root,members}` lives
// at the CLOSURE digest, which is what instances register and callers pin. This mirrors the proven
// register/serve path exactly; a KV-backed store (publishContractArtifact) is the production form.
const rootDigest = contractDigest(clusterDocument);
const closureManifest = buildContractClosureManifest(rootDigest, []);
export const clusterDigest = contractDigest(closureManifest);

const store = new Map<string, unknown>([
  [rootDigest, clusterDocument],
  [clusterDigest, closureManifest],
]);

/** The §13.7 content-store reader the register/serve seams resolve cluster digests through. */
export const readClusterArtifact = (digest: string): unknown => store.get(digest);

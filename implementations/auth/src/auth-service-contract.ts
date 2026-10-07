/**
 * The AUTH plane's v0.4 SERVICE CONTRACT (#399 M2): the §13.7 cluster document + compiled command
 * contract for the `retire-lifecycle` op the auth plane serves on the `ep.*` rails. Shaped like
 * `implementations/manager/src/manager-service-contract.ts` (the manager's own contract module):
 * ONE `CommandRow`, its compiled input/output pair, and the cluster-document/artifact/command-def
 * builders a `serveEndpoint` registration needs.
 *
 * This module is PURE DATA + schema (no broker, no barrier, no wire I/O): the registration and
 * serve WIRING lives in the plane (`openAuthAuthorityPlane` / `openAuthAdminListener`).
 */
import {
  compileContract,
  singleDocumentClosure,
  type CompiledContract,
  type ContractClosureManifest,
  type EpAuthzMode,
  type EpCommandDef,
  type EpServeContext,
} from "@cotal-ai/core";

/** The auth plane's endpoint NAME (matches `AUTH_ENDPOINT` in `@cotal-ai/core`). */
export const AUTH_SERVICE_ENDPOINT = "auth";

/** The auth cluster document's URN (§13.7 content-addressed authority). */
export const AUTH_CLUSTER_URN = "ai.cotal.auth";

// ---- input/output schemas (closed shape) --------------------------------------------------------

/** The `retireLifecycle` args — the shape `parseRetireArgs` (`auth-admin.ts:146`) accepts. The
 *  target (owner, actor, lifecycleUid) is never an argument: `exact` mode carries it in the
 *  subject, broker-enforced, so the handler reads it from `ctx.subject.target`. */
const RETIRE_LIFECYCLE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["opId", "serveEndpoint", "serveInstanceId", "serveEpoch"],
  properties: {
    /** The requester's stable operation id (a retry sends the SAME opId). */
    opId: { type: "string" },
    /** The serve-issuance gate's endpoint name the requester's serve grant is keyed under. */
    serveEndpoint: { type: "string" },
    /** The serve-issuance gate's instance id (lookup coordinate, not an authz input). */
    serveInstanceId: { type: "string" },
    /** The declared process epoch (a superseded predecessor is refused). */
    serveEpoch: { type: "integer", minimum: 0 },
  },
} as const;

/** The `retireLifecycle` output — the object the handler returns (`auth-admin.ts:390`). */
const RETIRE_LIFECYCLE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["retired", "lifecycleUid", "opId", "evictedPrincipals"],
  properties: {
    retired: { type: "boolean" },
    lifecycleUid: { type: "string" },
    opId: { type: "string" },
    evictedPrincipals: { type: "array", items: { type: "string" } },
  },
} as const;

interface CommandRow {
  name: string;
  capability: string;
  input: unknown;
  output: unknown;
  targeted: boolean;
  modes?: EpAuthzMode[];
  handler: keyof AuthServiceHandlers;
}

const ROWS: CommandRow[] = [
  { name: "retire-lifecycle", capability: "auth.admin", input: RETIRE_LIFECYCLE_INPUT_SCHEMA, output: RETIRE_LIFECYCLE_OUTPUT_SCHEMA, targeted: true, modes: ["exact"], handler: "retireLifecycle" },
];

type ContractPair = { input: CompiledContract; output: CompiledContract };

const COMPILED = new Map<string, ContractPair>();

function pairFor(name: string): ContractPair {
  let pair = COMPILED.get(name);
  if (!pair) {
    const r = ROWS.find((row) => row.name === name);
    if (!r) throw new Error(`unknown auth command contract "${name}"`);
    pair = { input: compileContract({ root: r.input as Record<string, unknown> }), output: compileContract({ root: r.output as Record<string, unknown> }) };
    COMPILED.set(name, pair);
  }
  return pair;
}

/** Per-command compiled contract pairs, exported for CALLERS (mirrors `MANAGER_CONTRACTS`). Lazy:
 *  a pair compiles on its first access, so importing the module alone pays no Ajv compile. */
export const AUTH_CONTRACTS: Readonly<Record<string, { input: CompiledContract; output: CompiledContract }>> =
  new Proxy({} as Record<string, ContractPair>, {
    has: (_, name: string) => ROWS.some((r) => r.name === name),
    ownKeys: () => ROWS.map((r) => r.name) as Array<string | symbol>,
    getOwnPropertyDescriptor: (_, name: string) => (ROWS.some((r) => r.name === name) ? { configurable: true, enumerable: true, get: () => pairFor(name) } : undefined),
    get: (_, name: string | symbol) => (typeof name === "string" && ROWS.some((r) => r.name === name) ? pairFor(name) : undefined),
  });

/** Every §13.7 contract artifact the auth plane PUBLISHES to the EPC store at registration: each
 *  DISTINCT schema root plus its single-member closure manifest. */
export function authContractArtifactValues(): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const r of ROWS) {
    for (const source of [r.input, r.output]) {
      const { manifest } = singleDocumentClosure(source);
      if (seen.has(manifest.root)) continue;
      seen.add(manifest.root);
      values.push(source, manifest);
    }
  }
  return values;
}

/** The §13.7 cluster DOCUMENT: the content-addressed authority for the auth plane's served
 *  command surface. Revision 1: the single `retire-lifecycle` command. */
export function authClusterDocument(): {
  urn: string;
  revision: number;
  attributes: unknown[];
  events: unknown[];
  commands: Array<{
    name: string;
    class: "ephemeral";
    targeted: boolean;
    modes?: EpAuthzMode[];
    capability: string;
    inputDigest: string;
    outputDigest: string;
  }>;
} {
  return {
    urn: AUTH_CLUSTER_URN,
    revision: 1,
    attributes: [],
    events: [],
    commands: ROWS.map((r) => ({
      name: r.name,
      class: "ephemeral" as const,
      targeted: r.targeted,
      ...(r.modes ? { modes: r.modes } : {}),
      capability: r.capability,
      inputDigest: singleDocumentClosure(r.input).closureDigest,
      outputDigest: singleDocumentClosure(r.output).closureDigest,
    })),
  };
}

/** The two-digest §13.7 content addressing for the auth document (mirrors
 *  `managerClusterArtifacts`): both artifacts publish to the `epc` store at their own digest;
 *  `clusterDigests` in the service spec carries the closure digest. */
export function authClusterArtifacts(): {
  document: ReturnType<typeof authClusterDocument>;
  rootDigest: string;
  manifest: ContractClosureManifest;
  closureDigest: string;
} {
  const document = authClusterDocument();
  const { manifest, closureDigest } = singleDocumentClosure(document);
  return { document, rootDigest: manifest.root, manifest, closureDigest };
}

/** The handler the auth plane supplies to back `retire-lifecycle`. Receives the serve CONTEXT
 *  (broker-authenticated subject shape beside the validated args/target); returns the command's
 *  output value (the compiled output contract validates it at the serve boundary). Kept as a
 *  narrow interface so the contract module stays broker-free. */
export interface AuthServiceHandlers {
  retireLifecycle(ctx: EpServeContext): unknown | Promise<unknown>;
}

/** Build the `EpCommandDef[]` `serveEndpoint` consumes. */
export function authCommandDefs(handlers: AuthServiceHandlers): EpCommandDef[] {
  // First use MATERIALIZES the compiled pairs (the Proxy compiles lazily; a compile failure
  // surfaces here, at registration, exactly where serve would need the validators).
  for (const r of ROWS) pairFor(r.name);
  return ROWS.map((r) => ({
    command: r.name,
    contract: pairFor(r.name),
    handler: (ctx: EpServeContext) => handlers[r.handler](ctx),
  }));
}

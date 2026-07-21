/**
 * The manager's v0.4 SERVICE CONTRACT (control-surface P2 item 1, slice 1a): the §13.7 cluster
 * document + compiled command contracts that let the manager register as an ordinary `service`
 * endpoint and serve typed commands on the `ep.*` rails, instead of its bespoke
 * `ctl.<tier>.<owner>.<actor>` control subjects.
 *
 * This module is PURE DATA + schema (no broker, no barrier, no wire I/O): the content-addressed
 * cluster document (the authority for every command's served shape) and the provenance-branded
 * `compileContract` pairs each `EpCommandDef` must carry. The registration/serve WIRING (contract
 * store publication, the §13.1 issuance barrier, the endpoint-serve mint, `serveEndpoint`) lives in
 * the manager and is the security-critical part; this is the low-risk, design-independent half that
 * lands first (see the P2-item-1 design note).
 *
 * SLICE 1a is a WALKING SKELETON: exactly ONE read-only, side-effect-free command (`status`,
 * manager-level health) is declared and served, DUAL-SERVED alongside the legacy `ctl` rails
 * (nothing deleted). 1b fans out the remaining ops (start/stop/attach/definePersona/purge/models/
 * launch + resume) as further commands in this document.
 */
import {
  compileContract,
  contractDigest,
  VOID_SCHEMA,
  type CompiledContract,
  type EpCommandDef,
  type EpServeContext,
} from "@cotal-ai/core";

/** The manager's endpoint NAME — a core single-label name (needs OPERATOR name authority at
 *  registration; the manager holds the space signing seed, so it self-authorizes). */
export const MANAGER_ENDPOINT = "manager";

/** The manager cluster document's URN (§13.7 content-addressed authority). */
export const MANAGER_CLUSTER_URN = "ai.cotal.manager";

/** The read-only manager-health output (slice 1a). Deliberately manager-LEVEL (no per-agent rows
 *  yet — those are the richer `ps` command in 1b): just enough to prove the register->serve->
 *  describe->invoke path end to end against the manager's real identity. */
const STATUS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["instanceId", "runtime", "agentCount", "uptimeMs"],
  properties: {
    /** The manager's stable service instance id (its per-process incarnation uid). */
    instanceId: { type: "string" },
    /** The runtime kind serving agents (pty/tmux/cmux/orca). */
    runtime: { type: "string" },
    /** How many agents this manager currently supervises. */
    agentCount: { type: "integer", minimum: 0 },
    /** Milliseconds since this manager process started serving. */
    uptimeMs: { type: "integer", minimum: 0 },
  },
} as const;

/** The typed shape a `status` invocation returns (the compiled output contract validates it). */
export interface ManagerStatus {
  instanceId: string;
  runtime: string;
  agentCount: number;
  uptimeMs: number;
}

/** Compiled contracts for the 1a command set. `status` is void-input (a manager-level read takes
 *  no arguments) and returns {@link ManagerStatus}. The closure digests here ARE the digests the
 *  cluster document pins, so a same-digest invented command is unrepresentable (§13.7). */
const STATUS_INPUT: CompiledContract = compileContract({ root: VOID_SCHEMA });
const STATUS_OUTPUT: CompiledContract = compileContract({ root: STATUS_OUTPUT_SCHEMA });

/** The capability `status` declares (enforced by the serve grant + describe view-scoping). A
 *  read-only manager-level status is the lowest tier — every control caller may reach it. */
const STATUS_CAPABILITY = "manager.read";

/** The §13.7 cluster DOCUMENT: the content-addressed authority for the manager's served command
 *  surface. 1a declares one command; 1b appends the rest (each with its own input/output digest,
 *  targeting, modes, and capability). Shape matches the endpoint-service cluster-document contract
 *  ({urn, revision, attributes, events, commands}). */
export function managerClusterDocument(): {
  urn: string;
  revision: number;
  attributes: never[];
  events: never[];
  commands: Array<{
    name: string;
    class: "ephemeral";
    targeted: boolean;
    capability: string;
    inputDigest: string;
    outputDigest: string;
  }>;
} {
  return {
    urn: MANAGER_CLUSTER_URN,
    revision: 1,
    attributes: [],
    events: [],
    commands: [
      {
        name: "status",
        class: "ephemeral",
        targeted: false,
        capability: STATUS_CAPABILITY,
        inputDigest: STATUS_INPUT.closureDigest,
        outputDigest: STATUS_OUTPUT.closureDigest,
      },
    ],
  };
}

/** The two-digest §13.7 content addressing for the manager document: the registered CLOSURE digest
 *  names a `{v:1, root:<artifactDigest>, members:[]}` manifest whose root names the DOCUMENT. Both
 *  artifacts are published to the `epc` store at their own digest; `clusterDigests` in the service
 *  spec carries the closure digest. Returned together so the manager publishes both then registers
 *  under the closure digest. */
export function managerClusterArtifacts(): {
  document: ReturnType<typeof managerClusterDocument>;
  rootDigest: string;
  manifest: { v: 1; root: string; members: string[] };
  closureDigest: string;
} {
  const document = managerClusterDocument();
  const rootDigest = contractDigest(document);
  const manifest = { v: 1 as const, root: rootDigest, members: [] as string[] };
  const closureDigest = contractDigest(manifest);
  return { document, rootDigest, manifest, closureDigest };
}

/** The handlers the manager supplies to back each served command (1a: just `status`). Each
 *  receives the serve CONTEXT (the broker-authenticated subject shape) so the manager can run its
 *  shared admission chokepoint on the caller principal. Kept as a narrow interface so the contract
 *  module stays broker-free and the manager owns all state. */
export interface ManagerServiceHandlers {
  status(ctx: EpServeContext): ManagerStatus | Promise<ManagerStatus>;
}

/** The `status` command's compiled contract pair — exported for CALLERS (`epCall` pins the same
 *  digests the cluster document registers; the generic invoke CLI later compiles these from the
 *  describe answer instead). */
export const MANAGER_STATUS_CONTRACT: { input: CompiledContract; output: CompiledContract } = {
  input: STATUS_INPUT,
  output: STATUS_OUTPUT,
};

/** Build the `EpCommandDef[]` `serveEndpoint` consumes: each command's provenance-branded compiled
 *  contracts (matching the document's pinned digests exactly) plus its handler. 1a serves only
 *  `status`; the handler takes no (void) input and returns the manager-health summary. */
export function managerCommandDefs(handlers: ManagerServiceHandlers): EpCommandDef[] {
  return [
    {
      command: "status",
      contract: { input: STATUS_INPUT, output: STATUS_OUTPUT },
      handler: (ctx: EpServeContext) => handlers.status(ctx),
    },
  ];
}

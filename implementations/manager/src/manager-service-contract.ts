/**
 * The manager's v0.4 SERVICE CONTRACT (control-surface P2 item 1): the §13.7 cluster document +
 * compiled command contracts that let the manager register as an ordinary `service` endpoint and
 * serve typed commands on the `ep.*` rails, dual-served beside its bespoke
 * `ctl.<tier>.<owner>.<actor>` control subjects until 1d deletes those.
 *
 * This module is PURE DATA + schema (no broker, no barrier, no wire I/O): the content-addressed
 * cluster document (the authority for every command's served shape) and the provenance-branded
 * `compileContract` pairs each `EpCommandDef` must carry. The registration/serve WIRING lives in
 * the manager (`registerManagerService`).
 *
 * REVISION 2 (slice 1b): the FULL op fan-out. Every served `ctl` op maps to a typed command; the
 * v0.3 op names map onto the Appendix-B caller vocabulary where one exists (`start` -> `spawn`;
 * the named `stop` -> `despawn` — on the v0.3 surface a named stop and a despawn are the same
 * terminal; the self no-name `stop` -> `stop` with authz-mode `self`; the per-agent `status`
 * read -> `inspect`, distinct from the 1a manager-level `status`). Targeting: `despawn`/`attach`
 * ride owner mode (the target block names the agent's principal + lifecycle uid; the fresh
 * resolver checks currency). `child` mode is DELIBERATELY NOT DECLARED anywhere — the panel's 1b
 * gate requires a DURABLE spawner record before child mode exists, so it fails closed by absence
 * until that record lands; own-child narrowing on despawn/attach meanwhile rides the SAME
 * `authorizeNamedControl` policy the ctl privileged tier runs (in-memory spawner, identical
 * source both doors). `ledger` mode is likewise absent (admin != ledger in static mode): every
 * admin-class command is untargeted + capability-gated — the broker grant (who holds the
 * request-publish row) stays the load-bearing tier boundary, exactly as the ctl cred layer is
 * today; the 1c migration table names who mints which capability.
 *
 * Capability labels (describe/grant vocabulary, one per tier class):
 *   manager.read     status / ps / inspect / models        (read-only)
 *   manager.spawn    spawn                                 (privileged-grade creation)
 *   manager.lifecycle despawn / attach                     (owner-mode terminal/interactive)
 *   manager.self     stop                                  (self-mode halt; baseline)
 *   manager.persona  definePersona                         (privileged-grade; ownership-checked)
 *   manager.admin    purge / launch / resume family        (operator instruments only)
 */
import {
  compileContract,
  contractDigest,
  VOID_SCHEMA,
  type CompiledContract,
  type EpAuthzMode,
  type EpCommandDef,
  type EpServeContext,
} from "@cotal-ai/core";

/** The manager's endpoint NAME — a core single-label name (needs OPERATOR name authority at
 *  registration; the manager holds the space signing seed, so it self-authorizes). */
export const MANAGER_ENDPOINT = "manager";

/** The manager cluster document's URN (§13.7 content-addressed authority). */
export const MANAGER_CLUSTER_URN = "ai.cotal.manager";

// ---- output/input schemas (closed unless the payload is genuinely open) ------------------------

/** The read-only manager-health output (1a). Manager-LEVEL — per-agent rows are `ps`/`inspect`. */
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

/** One managed-agent row (`ps`/`inspect`), the ctl `list()` shape plus `lifecycleUid` — the
 *  coordinate an ep caller needs to build a targeted (`despawn`/`attach`) request. The two
 *  auth-health fields appear only on a user-mode agent whose bearer refresh is unhealthy; `role`
 *  only when the launch profile declared one (a role-less row serializes WITHOUT the key —
 *  `JSON.stringify` drops `undefined` — so pinning it required fails the responder's own reply). */
const AGENT_ROW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "id", "agent", "space", "mode", "status", "uptimeMs", "mesh", "lifecycleUid"],
  properties: {
    name: { type: "string" },
    id: { type: "string" },
    role: { type: "string" },
    agent: { type: "string" },
    space: { type: "string" },
    mode: { type: "string" },
    status: { type: "string" },
    uptimeMs: { type: "integer", minimum: 0 },
    mesh: { type: "string" },
    lifecycleUid: { type: "string" },
    authHealth: { type: "string" },
    authReason: { type: "string" },
  },
} as const;

const PS_OUTPUT_SCHEMA = { type: "array", items: AGENT_ROW_SCHEMA } as const;
const INSPECT_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name"],
  properties: { name: { type: "string", minLength: 1 } },
} as const;

/** `spawn` input: EXACTLY the ctl `start` op's coercion surface (manager.ts `opStart`, the 1b
 *  fidelity oracle) — same fields, same types, nothing extra. Deep semantics (empty `resume`,
 *  connector-specific launchOptions keys) stay in the SHARED handler/connector validation. */
const SPAWN_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    agent: { type: "string" },
    role: { type: "string" },
    config: { type: "string" },
    identity: { type: "string" },
    model: { type: "string" },
    variant: { type: "string" },
    launchOptions: { type: "object" },
    resume: { type: "string" },
    transcript: { type: "boolean" },
    cwd: { type: "string" },
    prompt: { type: "string" },
    subscribe: { type: "array", items: { type: "string" } },
    allowSubscribe: { type: "array", items: { type: "string" } },
    allowPublish: { type: "array", items: { type: "string" } },
    shareTools: { type: "string" },
  },
} as const;

/** `spawn` success output: `startAgent`'s reply data. */
const SPAWN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "id", "mode", "lifecycleUid"],
  properties: {
    name: { type: "string" },
    id: { type: "string" },
    role: { type: "string" },
    agent: { type: "string" },
    mode: { type: "string" },
    lifecycleUid: { type: "string" },
  },
} as const;

const GRACEFUL_INPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { graceful: { type: "boolean" } },
} as const;

const STOP_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "stopped", "graceful"],
  properties: { name: { type: "string" }, stopped: { type: "boolean" }, graceful: { type: "boolean" } },
} as const;

const ATTACH_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["ws"],
  properties: { ws: { type: "string" } },
} as const;

/** `models` output, NORMALIZED: always the full catalog list ({@link ManagerServiceHandlers}
 *  wraps the ctl op's single-or-array reply). Catalog rows stay OPEN — a connector's catalog may
 *  carry host-specific fields beyond the core `ConnectorModelCatalog` shape. */
const MODELS_INPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { agent: { type: "string" }, refresh: { type: "boolean" } },
} as const;
const MODELS_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["catalogs"],
  properties: {
    catalogs: {
      type: "array",
      items: {
        type: "object",
        required: ["agent", "supported", "models"],
        properties: { agent: { type: "string" }, supported: { type: "boolean" }, models: { type: "array" }, error: { type: "string" } },
      },
    },
  },
} as const;

const PURGE_INPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { includeDms: { type: "boolean" } },
} as const;
const PURGE_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["chat"],
  properties: { chat: { type: "integer", minimum: 0 }, dm: { type: "integer", minimum: 0 } },
} as const;

const PERSONA_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "persona"],
  properties: { name: { type: "string", minLength: 1 }, persona: { type: "string", minLength: 1 }, model: { type: "string" } },
} as const;
const PERSONA_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "path"],
  properties: { name: { type: "string" }, path: { type: "string" } },
} as const;

const LAUNCH_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["runId", "name"],
  properties: { runId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 } },
} as const;
const LAUNCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "id", "mode", "lifecycleUid", "requested", "runId", "newlyStarted"],
  properties: {
    name: { type: "string" },
    id: { type: "string" },
    role: { type: "string" },
    agent: { type: "string" },
    mode: { type: "string" },
    lifecycleUid: { type: "string" },
    requested: { type: "string" },
    runId: { type: "string" },
    hash: { type: "string" },
    newlyStarted: { type: "boolean" },
  },
} as const;

// The resume/preservation family (admin maintenance coordination). Inputs pin the coordination
// keys; the INVENTORY payload and the plan/result outputs stay OPEN objects — their deep schema
// is the SHARED `parseResumeControlArgs`/plan validation in the handlers (the ctl parser is the
// single deep gate both doors run), and item 2's action model reshapes these surfaces anyway.
const ATTEMPT_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["attemptId"],
  properties: { attemptId: { type: "string", minLength: 1 } },
} as const;
const RESUME_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["attemptId", "inventory"],
  properties: { attemptId: { type: "string", minLength: 1 }, inventory: { type: "object" } },
} as const;
const FINALIZE_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["attemptId", "durableCommitToken"],
  properties: { attemptId: { type: "string", minLength: 1 }, durableCommitToken: { type: "string", minLength: 1 } },
} as const;
const OPEN_OBJECT_SCHEMA = { type: "object" } as const;
const COMMIT_RESUME_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["attemptId", "state", "durableCommitToken"],
  properties: { attemptId: { type: "string" }, state: { type: "string" }, durableCommitToken: { type: "string" } },
} as const;
const ATTEMPT_STATE_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["attemptId", "state"],
  properties: { attemptId: { type: "string" }, state: { type: "string" } },
} as const;

// ---- the command table (ONE source for the document, the defs, the caller contracts, AND the
// ---- published store artifacts) ----------------------------------------------------------------

/** Handler key per command (the {@link ManagerServiceHandlers} method that backs it). Rows carry
 *  the SOURCE schemas; the compiled pairs AND the store artifacts derive from them, so the served
 *  validator, the registered digest, and the fetchable artifact can never drift apart. */
interface CommandRow {
  name: string;
  capability: string;
  input: unknown;
  output: unknown;
  targeted: boolean;
  modes?: EpAuthzMode[];
  handler: keyof ManagerServiceHandlers;
}

const ROWS: CommandRow[] = [
  { name: "status", capability: "manager.read", input: VOID_SCHEMA, output: STATUS_OUTPUT_SCHEMA, targeted: false, handler: "status" },
  { name: "ps", capability: "manager.read", input: VOID_SCHEMA, output: PS_OUTPUT_SCHEMA, targeted: false, handler: "ps" },
  { name: "inspect", capability: "manager.read", input: INSPECT_INPUT_SCHEMA, output: AGENT_ROW_SCHEMA, targeted: false, handler: "inspect" },
  { name: "models", capability: "manager.read", input: MODELS_INPUT_SCHEMA, output: MODELS_OUTPUT_SCHEMA, targeted: false, handler: "models" },
  { name: "spawn", capability: "manager.spawn", input: SPAWN_INPUT_SCHEMA, output: SPAWN_OUTPUT_SCHEMA, targeted: false, handler: "spawn" },
  // `owner` = the caller's own domain (the spawn capability's standing mint); `any` = the operator
  // instrument's cross-agent reach (rev 3, the 1c admin-reach decision): the any-mode subject row
  // is mintable only under operator policy (§13.2), so the broker grant is the tier boundary and
  // the handler maps mode `any` to its admin authorization path — no wire synonym command.
  { name: "despawn", capability: "manager.lifecycle", input: GRACEFUL_INPUT_SCHEMA, output: STOP_OUTPUT_SCHEMA, targeted: true, modes: ["owner", "any"], handler: "despawn" },
  { name: "attach", capability: "manager.lifecycle", input: VOID_SCHEMA, output: ATTACH_OUTPUT_SCHEMA, targeted: true, modes: ["owner", "any"], handler: "attach" },
  { name: "stop", capability: "manager.self", input: GRACEFUL_INPUT_SCHEMA, output: STOP_OUTPUT_SCHEMA, targeted: true, modes: ["self"], handler: "stopSelf" },
  { name: "define-persona", capability: "manager.persona", input: PERSONA_INPUT_SCHEMA, output: PERSONA_OUTPUT_SCHEMA, targeted: false, handler: "definePersona" },
  { name: "purge", capability: "manager.admin", input: PURGE_INPUT_SCHEMA, output: PURGE_OUTPUT_SCHEMA, targeted: false, handler: "purge" },
  { name: "launch", capability: "manager.admin", input: LAUNCH_INPUT_SCHEMA, output: LAUNCH_OUTPUT_SCHEMA, targeted: false, handler: "launch" },
  { name: "resume-preserved", capability: "manager.admin", input: RESUME_INPUT_SCHEMA, output: OPEN_OBJECT_SCHEMA, targeted: false, handler: "resumePreserved" },
  { name: "commit-resume", capability: "manager.admin", input: ATTEMPT_INPUT_SCHEMA, output: COMMIT_RESUME_OUTPUT_SCHEMA, targeted: false, handler: "commitResume" },
  { name: "finalize-resume", capability: "manager.admin", input: FINALIZE_INPUT_SCHEMA, output: ATTEMPT_STATE_OUTPUT_SCHEMA, targeted: false, handler: "finalizeResume" },
  { name: "prepare-preservation", capability: "manager.admin", input: ATTEMPT_INPUT_SCHEMA, output: OPEN_OBJECT_SCHEMA, targeted: false, handler: "preparePreservation" },
  { name: "commit-preservation", capability: "manager.admin", input: ATTEMPT_INPUT_SCHEMA, output: OPEN_OBJECT_SCHEMA, targeted: false, handler: "commitPreservation" },
  { name: "abort-preservation", capability: "manager.admin", input: ATTEMPT_INPUT_SCHEMA, output: ATTEMPT_STATE_OUTPUT_SCHEMA, targeted: false, handler: "abortPreservation" },
];

const cc = (root: unknown): CompiledContract => compileContract({ root: root as Record<string, unknown> });
const COMPILED: Record<string, { input: CompiledContract; output: CompiledContract }> =
  Object.fromEntries(ROWS.map((r) => [r.name, { input: cc(r.input), output: cc(r.output) }]));

/** Per-command compiled contract pairs, exported for CALLERS (`epCall` pins the same digests the
 *  cluster document registers; the generic invoke CLI compiles these from the STORE instead). */
export const MANAGER_CONTRACTS: Readonly<Record<string, { input: CompiledContract; output: CompiledContract }>> =
  Object.freeze(COMPILED);

/** Every §13.7 contract artifact the manager PUBLISHES to the EPC store at registration (P2 item
 *  1, 1c): each DISTINCT schema root plus its single-member closure manifest — the two artifacts
 *  a caller fetches at a command's input/output CLOSURE digest (`fetchContractClosure` walks
 *  manifest → root) to recompile the digest-matching validators. The cluster document + ITS
 *  manifest ride separately ({@link managerClusterArtifacts}). */
export function managerContractArtifactValues(): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const r of ROWS) {
    for (const source of [r.input, r.output]) {
      const rootDigest = contractDigest(source);
      if (seen.has(rootDigest)) continue;
      seen.add(rootDigest);
      values.push(source, { v: 1, root: rootDigest, members: [] });
    }
  }
  return values;
}

/** The 1a `status` pair, kept as a named export (existing callers/smokes). */
export const MANAGER_STATUS_CONTRACT: { input: CompiledContract; output: CompiledContract } = MANAGER_CONTRACTS.status;

/** The §13.7 cluster DOCUMENT: the content-addressed authority for the manager's served command
 *  surface (revision 3: the 1c any-mode despawn/attach admission). All commands are ephemeral
 *  (request/reply ops; the spawn-as-action journal model is item 2). */
export function managerClusterDocument(): {
  urn: string;
  revision: number;
  attributes: never[];
  events: never[];
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
    urn: MANAGER_CLUSTER_URN,
    revision: 3,
    attributes: [],
    events: [],
    commands: ROWS.map((r) => ({
      name: r.name,
      class: "ephemeral" as const,
      targeted: r.targeted,
      ...(r.modes ? { modes: r.modes } : {}),
      capability: r.capability,
      inputDigest: COMPILED[r.name].input.closureDigest,
      outputDigest: COMPILED[r.name].output.closureDigest,
    })),
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

/** The handlers the manager supplies to back each served command. Each receives the serve
 *  CONTEXT (the broker-authenticated subject shape beside the validated args/target) so the
 *  manager can run its shared admission chokepoint and derive the caller principal; each returns
 *  the command's output value (the compiled output contract validates it at the serve boundary).
 *  Kept as a narrow interface so the contract module stays broker-free. */
export interface ManagerServiceHandlers {
  status(ctx: EpServeContext): ManagerStatus | Promise<ManagerStatus>;
  ps(ctx: EpServeContext): unknown | Promise<unknown>;
  inspect(ctx: EpServeContext): unknown | Promise<unknown>;
  models(ctx: EpServeContext): unknown | Promise<unknown>;
  spawn(ctx: EpServeContext): unknown | Promise<unknown>;
  despawn(ctx: EpServeContext): unknown | Promise<unknown>;
  attach(ctx: EpServeContext): unknown | Promise<unknown>;
  stopSelf(ctx: EpServeContext): unknown | Promise<unknown>;
  definePersona(ctx: EpServeContext): unknown | Promise<unknown>;
  purge(ctx: EpServeContext): unknown | Promise<unknown>;
  launch(ctx: EpServeContext): unknown | Promise<unknown>;
  resumePreserved(ctx: EpServeContext): unknown | Promise<unknown>;
  commitResume(ctx: EpServeContext): unknown | Promise<unknown>;
  finalizeResume(ctx: EpServeContext): unknown | Promise<unknown>;
  preparePreservation(ctx: EpServeContext): unknown | Promise<unknown>;
  commitPreservation(ctx: EpServeContext): unknown | Promise<unknown>;
  abortPreservation(ctx: EpServeContext): unknown | Promise<unknown>;
}

/** Build the `EpCommandDef[]` `serveEndpoint` consumes: each command's provenance-branded compiled
 *  contracts (matching the document's pinned digests exactly) plus its handler. */
export function managerCommandDefs(handlers: ManagerServiceHandlers): EpCommandDef[] {
  return ROWS.map((r) => ({
    command: r.name,
    contract: COMPILED[r.name],
    handler: (ctx: EpServeContext) => handlers[r.handler](ctx),
  }));
}

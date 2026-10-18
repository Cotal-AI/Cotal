/**
 * The manager's `spawn`, `despawn`, `stop` and `inspect` command contracts.
 *
 * They live in core so the manager and every suite that serves a manager-shaped endpoint compile
 * the same objects: implementations never import each other, and a private copy keeps passing
 * after the manager's contract changes.
 */

/** One managed-agent row (`ps`/`inspect`), the ctl `list()` shape plus `lifecycleUid` — the
 *  coordinate an ep caller needs to build a targeted (`despawn`/`attach`) request. The two
 *  auth-health fields appear only on a user-mode agent whose bearer refresh is unhealthy; `role`
 *  only when the launch profile declared one (a role-less row serializes WITHOUT the key —
 *  `JSON.stringify` drops `undefined` — so pinning it required fails the responder's own reply). */
export const AGENT_ROW_SCHEMA = {
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
    // The roster's harness-reported condition beside `mesh` (SPEC §6), its four fields projected. Optional:
    // absent when the connector reported none, and on rows from managers that predate it.
    condition: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string" },
        source: { type: "string" },
        message: { type: "string" },
        since: { type: "number" },
      },
    },
    // The roster's `activeAt` (SPEC §6): epoch ms of the seat's last harness-reported work progress.
    // Optional: absent when the connector reports none, and on rows from managers that predate it.
    activeAt: { type: "number" },
    // The observing manager's presence-view state at the time of the read: `current` (the mesh
    // column is a verdict), `stale` (its watch has been silent past TTL; `mesh` is last-known),
    // or `unpopulated` (its watch has not replayed the bucket yet; `absent` means nothing).
    // Optional so a v0.47 manager's rows still validate; a reader treats absence as `current`.
    meshView: { type: "string", enum: ["current", "stale", "unpopulated"] },
    // Epoch ms of the seat's last presence heartbeat, present only when `mesh` is `offline` and
    // `meshView` is `current`: when the offline verdict began (#1208). Optional so an older
    // manager's rows still validate.
    offlineSince: { type: "integer", minimum: 0 },
    lifecycleUid: { type: "string" },
    authHealth: { type: "string" },
    authReason: { type: "string" },
    // #651 enrichment, all OPTIONAL: per-seat facts the manager already records, surfaced by
    // `cotal ps --wide`/`--json`. Optional because absence is real state: a launch may pin no
    // model, and a runtime that does not own a real process (tmux/cmux/orca/herdr) has no pid.
    // The row serializes a fact only when this backend recorded one - absent never means zero,
    // empty, or fabricated. `spawner` is the authenticated requester id (`id`-shaped: an nkey or
    // an owner.actor principal key); the owning manager's instance/host ride per-row so a
    // multi-manager scatter view can attribute seats (#579 records the spawner's RAIL when it is
    // itself a managed seat - not carried here, the manager does not hold it).
    model: { type: "string" },
    variant: { type: "string" },
    // The connector-reported provider from presence (#785): absent when the connector reported none.
    provider: { type: "string" },
    cwd: { type: "string" },
    pid: { type: "integer", minimum: 1 },
    spawner: { type: "string" },
    instanceId: { type: "string" },
    host: { type: "string" },
    // #1500: present only on a `--resume` seat. `source` is the session it forked; `title` and
    // `transcriptSha256` appear once the seat has recorded its fork, and `title` only when the source
    // has one. A carried resume (#1499) also names the source `host` and when its bytes were staged.
    resume: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: { type: "string" }, title: { type: "string" }, transcriptSha256: { type: "string" },
        host: { type: "string" }, transferredAt: { type: "string" },
      },
    },
  },
} as const;

export const INSPECT_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name"],
  properties: { name: { type: "string", minLength: 1 } },
} as const;

/** An optional `spawn` field that is present must say something: the persona fills an omitted
 *  field, so a blank one read as omitted would launch on a value the caller did not ask for. A
 *  fresh object per field, because the canonical serializer refuses a shared reference as circular. */
const nonBlank = () => ({ type: "string", pattern: "^\\s*\\S" }) as const;

/** `spawn` input: EXACTLY the ctl `start` op's coercion surface (manager.ts `opStart`, the
 *  fidelity oracle) — same fields, same types, nothing extra. Deep semantics (connector-specific
 *  launchOptions keys) stay in the SHARED handler/connector validation. */
export const SPAWN_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    agent: nonBlank(),
    defaultAgent: nonBlank(),
    role: nonBlank(),
    config: nonBlank(),
    identity: nonBlank(),
    model: nonBlank(),
    variant: nonBlank(),
    launchOptions: { type: "object" },
    resume: nonBlank(),
    // #1499: the one-time claim `transcript-receive` issued for carried bytes of `resume`, and the
    // agent the CLI found them with.
    resumeClaim: nonBlank(),
    resumeAgent: nonBlank(),
    events: { type: "boolean" },
    cwd: nonBlank(),
    prompt: nonBlank(),
    subscribe: { type: "array", items: { type: "string" } },
    allowSubscribe: { type: "array", items: { type: "string" } },
    allowPublish: { type: "array", items: { type: "string" } },
    shareTools: { type: "array", items: { type: "string" } },
    supervise: {
      type: "object",
      additionalProperties: false,
      required: ["restarts", "windowMs"],
      properties: {
        restarts: { type: "integer", minimum: 1 },
        windowMs: { type: "integer", minimum: 1 },
      },
    },
  },
} as const;

/** `spawn` success output: the ACTION ACCEPTANCE floor — the ALLOCATED agent identity
 *  (name + the owner/actor/uid addressing triple) plus the goal coordinates
 *  (goalId = the request id), the accepted readiness budget a synchronous follower must outlive,
 *  and the executor coordinate (the manager incarnation its terminal fences on). No secret material.
 *  The spawned identity + outcome ride the goal's progress + terminal, not this reply. */
export const SPAWN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // Additive for mixed-version readers: current managers always emit readinessDeadlineMs, while a
  // new follower accepts an older acceptance without it and falls back to its caller deadline.
  required: ["name", "owner", "actor", "uid", "goalId", "fingerprint", "executor"],
  properties: {
    name: { type: "string" },
    owner: { type: "string" },
    actor: { type: "string" },
    uid: { type: "string" },
    goalId: { type: "string" },
    fingerprint: { type: "string" },
    readinessDeadlineMs: { type: "integer", minimum: 1 },
    executor: {
      type: "object",
      additionalProperties: false,
      required: ["lifecycleUid", "epoch"],
      properties: { lifecycleUid: { type: "string" }, epoch: { type: "integer", minimum: 0 } },
    },
  },
} as const;

export const GRACEFUL_INPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { graceful: { type: "boolean" } },
} as const;

export const STOP_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "stopped", "graceful"],
  properties: { name: { type: "string" }, stopped: { type: "boolean" }, graceful: { type: "boolean" } },
} as const;

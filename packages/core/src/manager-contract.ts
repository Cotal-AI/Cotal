/**
 * The manager's spawn, stop and inspect schemas, shared with runtime stand-ins.
 * Keeping one definition makes those suites validate the commands the manager actually serves.
 */

/** Optional spawn strings must be nonblank when present. Omission can inherit a value;
 *  a blank string must not silently select that value. A fresh object per field is needed because
 *  the canonical serializer refuses a shared reference as circular. */
const nonBlank = () => ({ type: "string", pattern: "^\\s*\\S" }) as const;

/** One managed-agent row (`ps`/`inspect`), the ctl `list()` shape plus `lifecycleUid` — the
 *  coordinate an ep caller needs to build a targeted (`despawn`/`attach`) request. The two
 *  auth-health fields appear only on a user-mode agent whose bearer refresh is unhealthy; `role`
 *  only when the launch profile declared one (a role-less row serializes WITHOUT the key —
 *  `JSON.stringify` drops `undefined` — so pinning it required fails the responder's own reply). */
export const AGENT_ROW_SCHEMA = deepFreeze({
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
    // A bounded launch wait elapsed without the exact incarnation joining. Process status stays
    // separate, and a later observed join clears this optional diagnostic.
    joinHealth: {
      type: "object", additionalProperties: false, required: ["state", "reason"],
      properties: {
        state: { type: "string", const: "degraded" },
        reason: { type: "string" },
      },
    },
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
    // The connector's clause when the seat's startup showed that mesh traffic does not wake it while
    // idle (SPEC §13.6 item 6). Optional: absent when it does, or when the manager could not tell.
    startupNotice: { type: "string", minLength: 1, maxLength: 1024 },
    // The roster's `activeAt` (SPEC §6): epoch ms of the seat's last harness-reported work progress.
    // Optional: absent when the connector reports none, and on rows from managers that predate it.
    activeAt: { type: "number" },
    // The observing manager's presence-view state at the time of the read: `current` (the mesh
    // column is a verdict), `stale` (its watch has been silent past TTL; `mesh` is last-known),
    // or `unpopulated` (its watch has not replayed the bucket yet; `absent` means nothing).
    // Optional so a v0.47 manager's rows still validate; a reader treats absence as `current`.
    meshView: { type: "string", enum: ["current", "stale", "unpopulated"] },
    // Optional proof that the name-matched roster record also matches this managed principal
    // and lifecycle UID. False is not proof the agent is absent; older managers omit the field.
    presenceIdentityVerified: { type: "boolean" },
    // Snapshot time of a current, identity-verified manager presence read, not the seat's
    // unvalidated heartbeat timestamp. Absent when the view is stale or identity differs.
    presenceObservedAt: { type: "integer", minimum: 0 },
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
} as const);

/** The name-keyed input to the manager's `inspect` command. */
export const INSPECT_INPUT_SCHEMA = deepFreeze({
  type: "object", additionalProperties: false, required: ["name"],
  properties: { name: { type: "string", minLength: 1 } },
} as const);

/** A persona's `endpoints` (SPEC 13.15): `[{ endpoint, commands, instanceId? }]`, on the inline
 *  `spawn` persona and on `define-persona`. The shape is closed here; names, reserved commands and the
 *  single-label rule are checked where the persona is read. */
export const PERSONA_ENDPOINTS_SCHEMA = deepFreeze({
  type: "array",
  items: {
    type: "object", additionalProperties: false, required: ["endpoint", "commands"],
    properties: { endpoint: { type: "string" }, commands: { type: "array", items: { type: "string" } }, instanceId: { type: "string" } },
  },
} as const);

/** `spawn` input: EXACTLY the ctl `start` op's coercion surface (manager.ts `opStart`, the
 *  fidelity oracle) — same fields, same types, nothing extra. Deep semantics (connector-specific
 *  launchOptions keys) stay in the SHARED handler/connector validation. */
export const SPAWN_INPUT_SCHEMA = deepFreeze({
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
    // An inline persona: the helper's definition, carried here instead of read from the catalog.
    // Its `prompt` is the persona body; the `prompt` above stays the first-turn kickoff.
    persona: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: nonBlank(),
        role: nonBlank(),
        model: nonBlank(),
        variant: nonBlank(),
        description: nonBlank(),
        subscribe: { type: "array", items: { type: "string" } },
        allowSubscribe: { type: "array", items: { type: "string" } },
        allowPublish: { type: "array", items: { type: "string" } },
        capabilities: { type: "array", items: { type: "string" } },
        endpoints: PERSONA_ENDPOINTS_SCHEMA,
        save: { type: "boolean" },
      },
    },
    // The workflow run whose driver sends this spawn, so a static manager that does not host the
    // run can read the run's admission and bound the helper by it (SPEC 14.8).
    runId: nonBlank(),
    subscribe: { type: "array", items: { type: "string" } },
    allowSubscribe: { type: "array", items: { type: "string" } },
    allowPublish: { type: "array", items: { type: "string" } },
    // Channels the new seat joins on top of its persona's read set (the peer door's `join`).
    join: { type: "array", items: { type: "string" } },
    // The caller's own read/post ACL. Used only when the persona file names no channel field, so
    // a helper spawned from a persona that says nothing about channels is scoped to its spawner.
    callerAcl: {
      type: "object",
      additionalProperties: false,
      required: ["allowSubscribe", "allowPublish"],
      properties: {
        allowSubscribe: { type: "array", items: { type: "string" } },
        allowPublish: { type: "array", items: { type: "string" } },
      },
    },
    shareTools: { type: "array", items: { type: "string" } },
    runtime: nonBlank(),
    supervise: {
      type: "object",
      additionalProperties: false,
      required: ["restarts", "windowMs"],
      properties: {
        restarts: { type: "integer", minimum: 1 },
        windowMs: { type: "integer", minimum: 1 },
      },
    },
    // The seat takes its prompt as one relayed turn and is stopped when that turn ends. Omitted,
    // `deadlineMs` is the manager's default; -1 means no deadline.
    once: {
      type: "object",
      additionalProperties: false,
      properties: {
        deadlineMs: { anyOf: [{ const: -1 }, { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }] },
      },
    },
  },
} as const);

/** `spawn` success output: the ACTION ACCEPTANCE floor — the ALLOCATED agent identity
 *  (name + the owner/actor/uid addressing triple) plus the goal coordinates
 *  (goalId = the request id), the accepted readiness budget a synchronous follower must outlive,
 *  and the executor coordinate (the manager incarnation its terminal fences on). No secret material.
 *  The spawned identity + outcome ride the goal's progress + terminal, not this reply. */
export const SPAWN_OUTPUT_SCHEMA = deepFreeze({
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
} as const);

/** The shared graceful-stop input for `stop` and `despawn`. */
export const GRACEFUL_INPUT_SCHEMA = deepFreeze({
  type: "object", additionalProperties: false,
  properties: { graceful: { type: "boolean" } },
} as const);

/** The manager's observed stop result, shared by `stop` and `despawn`. */
export const STOP_OUTPUT_SCHEMA = deepFreeze({
  type: "object", additionalProperties: false, required: ["name", "stopped", "graceful"],
  properties: { name: { type: "string" }, stopped: { type: "boolean" }, graceful: { type: "boolean" } },
} as const);

/** Freeze a schema and everything it holds at its declaration. `as const` is type-only, so without
 *  this an importer could change the contract every manager serves and validates against. */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

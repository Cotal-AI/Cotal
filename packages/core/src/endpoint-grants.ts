/**
 * v0.4 endpoint control-surface grant grammar (SPEC §13.9 matrix, caller + serve rows) — the
 * capability → exact allow-list builders `permissionsFor` mints from. Default-deny throughout:
 * every row is an exact-arity literal form from the §13.9 matrix; no builder emits a wildcard
 * that admits subjects outside the §13.2 grammar.
 *
 * SCOPE: the SUBJECT-space rows (core publish/subscribe grants). The `$JS.API` rows of the
 * matrix (canonicalizer/effects/pool/reader durables) bind to the §13.12 stream names and land
 * with that binding; the serve PROFILE that carries these rows to an endpoint daemon lands with
 * the service registry machinery.
 */
import { spacePrefix } from "./subjects.js";
import { epcStreamName } from "./endpoint-binding.js";
import {
  endpointToken, assertCommandToken, assertLifecycleToken, assertBoundedOwner,
  type EpCaller, type EpTarget,
  epCallerReplyFilter, epResponderReplyPattern, epClassQueueGroup,
} from "./endpoint-subjects.js";

/** A minted request capability: one endpoint command a caller may invoke, on the named rails.
 *  `routes` defaults to `["one"]`; `instanceId` additionally pins the instance form to exactly
 *  that instance. A TARGETED capability carries its authorization mode with the target tokens
 *  LITERAL as minted (§13.2): `owner`/`child` pin the caller's own owner; `any`/`ledger` may pin
 *  `"*"` (mintable only under operator/admin policy — enforced by the minting authority, not
 *  here); `handle` pins the full redemption triple and is never a standing capability (the
 *  standing rollup {@link epCallerGrantRows} refuses it; only the §13.6 redemption path builds
 *  handle rows, through {@link epRequestGrantRows} directly). */
export interface EpCapability {
  endpoint: string;
  command: string;
  routes?: ("one" | "all")[];
  instanceId?: string;
  target?: EpTarget;
  /** Also grant the matching journal-submission append row (`epj`, §13.9 matrix). */
  journal?: boolean;
}

/** Grant-row token block for a capability's authz/target segment, enforcing the §13.2 minting
 *  rules per mode: `owner`/`child` standing mints pin `<tOwner>` to the caller's own owner
 *  (never a wildcard, never a foreign owner); `any`/`ledger` accept a literal `"*"` (mintable
 *  only under operator/admin policy — enforced by the minting authority, not here) or a
 *  validated owner token; `handle` validates the full redemption triple. Every concrete token
 *  routes through the same validator the subject builders use, so a grant row can never carry
 *  a smuggled `.`/`*`/`>` that widens the minted permission beyond the grammar. */
function targetGrantTokens(target: EpTarget, caller: EpCaller): string[] {
  if (target.mode === "self") return ["self"];
  if (target.mode === "handle")
    return ["handle", assertBoundedOwner(target.tOwner, "target owner"), assertBoundedOwner(target.tActor, "target actor"), assertLifecycleToken(target.tUid, "target lifecycleUid")];
  if (target.mode === "any" || target.mode === "ledger")
    return [target.mode, target.tOwner === "*" ? "*" : assertBoundedOwner(target.tOwner, "target owner")];
  if (target.tOwner !== caller.owner)
    throw new Error(`an "${target.mode}"-mode grant pins the target owner to the caller's own owner (SPEC 13.2); got "${target.tOwner}" for caller owner "${caller.owner}"`);
  return [target.mode, assertBoundedOwner(target.tOwner, "target owner")];
}

function callerBlock(caller: EpCaller): string {
  return `${assertBoundedOwner(caller.owner, "caller owner")}.${assertBoundedOwner(caller.actor, "caller actor")}.${assertLifecycleToken(caller.uid, "caller lifecycleUid")}`;
}

/** Request-publish rows for one capability (§13.9 "Request publish"): per route,
 *  `ep.{one,all}.<endpoint>.<command>[.<mode>[.<target…>]].<cO>.<cA>.<cUid>.*` and the
 *  instance-pinned form when `instanceId` is set. The nonce is the only wildcard token. */
export function epRequestGrantRows(space: string, cap: EpCapability, caller: EpCaller): string[] {
  const e = endpointToken(cap.endpoint);
  const cmd = assertCommandToken(cap.command);
  const mid = cap.target ? `.${targetGrantTokens(cap.target, caller).join(".")}` : "";
  const tail = `${mid}.${callerBlock(caller)}.*`;
  const rows = (cap.routes ?? ["one"]).map((r) => `${spacePrefix(space)}.ep.${r}.${e}.${cmd}${tail}`);
  if (cap.instanceId)
    rows.push(`${spacePrefix(space)}.ep.inst.${e}.${assertLifecycleToken(cap.instanceId, "instanceId")}.${cmd}${tail}`);
  return rows;
}

/** Journal-submission append row (§13.9 "Journal submission append"): the same authz/target
 *  block as the request forms, caller-pinned, no nonce. Explicitly untrusted input (§13.4). */
export function epJournalGrantRow(space: string, cap: EpCapability, caller: EpCaller): string {
  const mid = cap.target ? `.${targetGrantTokens(cap.target, caller).join(".")}` : "";
  return `${spacePrefix(space)}.epj.${endpointToken(cap.endpoint)}.${assertCommandToken(cap.command)}${mid}.${callerBlock(caller)}`;
}

/** The caller's reply-rail read row (§13.9 "Reply subscribe"): its own rail only, exact arity. */
export function epCallerReplyGrantRow(space: string, caller: EpCaller): string {
  return epCallerReplyFilter(space, caller);
}

/** Per-goal live progress read row (§13.9 "Live event progress", reserved `goal` topic):
 *  `epe.<endpoint>.*.*.goal.<cO>.<cA>.<cUid>.>` — the caller identity in the subject gives
 *  mint-time read containment; delivered on the caller's own core subscription only. */
export function epGoalProgressGrantRow(space: string, endpoint: string, caller: EpCaller): string {
  return `${spacePrefix(space)}.epe.${endpointToken(endpoint)}.*.*.goal.${callerBlock(caller)}.>`;
}

/** All caller-side rows for a capability set: request-publish (+ optional journal) into
 *  `pub.allow`, the reply rail (+ the per-goal progress read for GOAL-BEARING capabilities) into
 *  `sub.allow`. This is the STANDING rollup (`permissionsFor` mints long-lived credentials from
 *  it), so a `handle`-mode capability is refused here: handle rows are redemption-minted only
 *  (§13.2/§13.6), built by the redemption path through {@link epRequestGrantRows} directly.
 *  A goal-bearing capability ({@link GOAL_BEARING_COMMANDS}: spawn/launch) adds ONE per-endpoint
 *  {@link epGoalProgressGrantRow} — the caller may follow its OWN goal to terminal (P2 item 2, Q1);
 *  it is the one read an invoke implies, because the subject pins the caller's own triple. Still
 *  NOT included: any OTHER `epe` subtree — those are minted per read capability by the granting
 *  authority (Appendix B), not implied by an invoke. */
export function epCallerGrantRows(
  space: string,
  caps: EpCapability[],
  caller: EpCaller,
): { pub: string[]; sub: string[] } {
  const pub: string[] = [];
  const progressEndpoints: string[] = [];
  for (const cap of caps) {
    if (cap.target?.mode === "handle")
      throw new Error(`a "handle"-mode capability on "${cap.endpoint}.${cap.command}" is redemption-minted only (SPEC 13.2), never a standing capability`);
    pub.push(...epRequestGrantRows(space, cap, caller));
    if (cap.journal) pub.push(epJournalGrantRow(space, cap, caller));
    if (GOAL_BEARING_SET.has(cap.command) && !progressEndpoints.includes(cap.endpoint)) progressEndpoints.push(cap.endpoint);
  }
  const sub = caps.length ? [epCallerReplyGrantRow(space, caller)] : [];
  for (const e of progressEndpoints) sub.push(epGoalProgressGrantRow(space, e, caller));
  return { pub, sub };
}

// ---- the Appendix-B BASELINE capability set (SPEC Appendix B "Agent", §13.9 agent row) ------------
// "every agent gets the baseline set (`describe` on all endpoints; the delivery endpoint's durable
// join/leave/list commands; self-targeted lifecycle commands with authz-mode `self`); the `spawn`
// capability adds the manager endpoint's lifecycle commands with authz-mode `owner`". The v0.4
// command NAMES map the served v0.3 ops 1:1: ctl.delivery durableJoin/durableLeave/listMemberships
// → delivery `join`/`leave`/`list` (untargeted: they act on the caller's own memberships, carried
// by the pinned caller triple, no target block); the self-service control tier serves exactly
// no-name self `stop` → manager `stop` with mode `self`; the privileged tier's spawn/stop/despawn/
// attach → the owner-mode spawn set. These names become the served v0.4 endpoint surfaces when the
// daemons register them; minting them ahead of serving is default-deny-safe (an unserved request
// form is a no-responder, never authority).

/** The delivery endpoint's baseline command names (Appendix B: "durable join/leave/list").
 *  All four command vocabularies below are RUNTIME-frozen (TS `as const` is type-level only)
 *  and the capability builders consult PRIVATE module-load snapshots, never these live
 *  exports: a post-import `push("attach")` here would otherwise widen every subsequently
 *  minted agent grant (the afa715b identity-vs-integrity class, executed repro). */
export const BASELINE_DELIVERY_ENDPOINT = "delivery";
export const BASELINE_DELIVERY_COMMANDS = Object.freeze(["join", "leave", "list"] as const);
/** The manager endpoint's self-lifecycle baseline (the v0.3 self-service tier serves exactly
 *  no-name self stop) and the spawn-capability owner-mode lifecycle set. */
export const BASELINE_LIFECYCLE_ENDPOINT = "manager";
export const BASELINE_SELF_LIFECYCLE_COMMANDS = Object.freeze(["stop"] as const);
/** `spawn` is CREATION: a virgin spawn has no target lifecycle UID or current mapping yet, so it
 *  CANNOT ride owner mode (§13.2 owner mode resolves a body `{owner, actor, lifecycleUid}` against
 *  the CURRENT mapping — there is nothing to resolve for a not-yet-existing child). It is minted
 *  UNTARGETED; the child-owner ceiling is the authenticated caller's own owner, carried by the
 *  pinned caller triple. `despawn` (terminal) and `attach` (interactive) act on an EXISTING agent,
 *  so they ride owner mode. Owner-mode `stop` is DELIBERATELY ABSENT: on the v0.3 surface a named
 *  stop and a despawn both free-slot + deprovision, so an owner-mode `stop` would be a wire synonym
 *  of `despawn` (distsys) — one owner-mode terminal command keeps the vocabulary single. Self-`stop`
 *  stays in the BASELINE (the v0.3 self-service tier's only op); it is the lighter self-halt. */
export const SPAWN_CREATE_COMMANDS = Object.freeze(["spawn"] as const);
export const SPAWN_OWNER_LIFECYCLE_COMMANDS = Object.freeze(["despawn", "attach"] as const);
/** The spawn capability's UNTARGETED additions (the 1c grant-migration table): the connector's
 *  persona write (`define-persona`, caller-scoped by the pinned triple) and per-agent status read
 *  (`inspect` - the responder narrows the view to the caller's owner domain, like `ps`). These
 *  ride the v0.3 privileged tier today; minting them with `spawn` keeps that tier's surface 1:1. */
export const SPAWN_SERVICE_COMMANDS = Object.freeze(["define-persona", "inspect"] as const);

// ---- operator INSTRUMENT capability sets (the 1c grant-migration table's admin row) --------------
/** The manager endpoint's read commands (`manager.read` class). */
export const MANAGER_READ_COMMANDS = Object.freeze(["status", "ps", "inspect", "models"] as const);
/** The manager endpoint's admin-class commands (`manager.admin`): capability-only + untargeted -
 *  the broker grant (who holds the row) IS the boundary; minted ONLY into operator instruments,
 *  NEVER an agent/spawn profile (the ratified 1c pin). */
export const MANAGER_ADMIN_COMMANDS = Object.freeze([
  "purge", "launch",
  "resume-preserved", "commit-resume", "finalize-resume",
  "prepare-preservation", "commit-preservation", "abort-preservation",
] as const);

/** The ACTION commands (§13.6): submitting one accepts a GOAL, so the caller may follow its OWN
 *  goal progress (P2 item 2). `spawn` (create) and `launch` (manifest) both serve as actions on
 *  the manager endpoint since 2a; a caller holding one of these capabilities is granted the
 *  per-goal live-progress read for that endpoint ({@link epGoalProgressGrantRow}), the one read an
 *  invoke DOES imply because it is bounded to the caller's OWN goal subtree. */
export const GOAL_BEARING_COMMANDS = Object.freeze(["spawn", "launch"] as const);
const GOAL_BEARING_SET: ReadonlySet<string> = new Set(GOAL_BEARING_COMMANDS);

/** RETRY SAFETY (§13.2) — the commands a client may execute a SECOND time after a
 *  responded-but-unbound split, because a second execution is observably indistinguishable from
 *  one. Consulted by {@link isRepeatSafeCommand}; see `Endpoint.invokeService` for the decision it
 *  gates.
 *
 *  THIS IS AN ALLOWLIST AND THE POLARITY IS THE WHOLE POINT. A denylist has to enumerate every
 *  destructive command correctly, forever, and it fails OPEN: the next admin command added above
 *  is auto-retried by default, and nothing goes red. This list fails CLOSED — a command nobody has
 *  classified surfaces the split to its caller instead of running twice. Surfacing costs a caller
 *  an error it can re-issue deliberately; the other direction cost `purge` a second STREAM.PURGE
 *  that deleted messages published after the first one completed (measured, adversarial review).
 *
 *  Membership is a claim about the COMMAND'S EFFECT, so it is written out literally rather than
 *  derived from a grant class. Deriving it from {@link MANAGER_READ_COMMANDS} would silently widen
 *  retry safety the day a mutating command joins the `manager.read` tier for grant reasons; the two
 *  vocabularies answer different questions and must be able to disagree.
 *
 *  A command belongs here only if re-running it is a no-op for every observer: these are reads
 *  (`status`/`ps`/`inspect`/`models`, the delivery membership `list`) and `describe` itself.
 *  Convergence is NOT sufficient on its own — `despawn` converges on a terminated agent, but its
 *  second run is still a distinct despawn of whatever now holds that name, so it stays out.
 *
 *  This is a client-side heuristic standing in for something the wire does not carry. The general
 *  fix is a safety/idempotency annotation on the command contract plus an effect-outcome in the
 *  reply, so a caller can know whether the first execution landed instead of guessing; that is a
 *  SPEC change and is deliberately not made here. */
export const REPEAT_SAFE_COMMANDS = Object.freeze([
  "describe", "status", "ps", "inspect", "models", "list",
] as const);
const REPEAT_SAFE_SET: ReadonlySet<string> = new Set(REPEAT_SAFE_COMMANDS);
/** True only for a command whose re-execution is observably harmless ({@link REPEAT_SAFE_COMMANDS}).
 *  Unknown commands are NOT repeat-safe — that is the intended default, not an oversight. */
export function isRepeatSafeCommand(command: string): boolean {
  return REPEAT_SAFE_SET.has(command);
}

// PRIVATE module-load snapshots of the command vocabularies: the builders below map over THESE,
// never the live exports, so the minted surface survives even a hypothetical defeat of the
// freezes above (the seam-snapshot half of the afa715b closure pattern).
const DELIVERY_COMMANDS_SNAP = Object.freeze([...BASELINE_DELIVERY_COMMANDS]);
const SELF_LIFECYCLE_SNAP = Object.freeze([...BASELINE_SELF_LIFECYCLE_COMMANDS]);
const SPAWN_CREATE_SNAP = Object.freeze([...SPAWN_CREATE_COMMANDS]);
const SPAWN_OWNER_SNAP = Object.freeze([...SPAWN_OWNER_LIFECYCLE_COMMANDS]);
const SPAWN_SERVICE_SNAP = Object.freeze([...SPAWN_SERVICE_COMMANDS]);
const MANAGER_READ_SNAP = Object.freeze([...MANAGER_READ_COMMANDS]);
const MANAGER_ADMIN_SNAP = Object.freeze([...MANAGER_ADMIN_COMMANDS]);

/** `describe` on ALL endpoints (Appendix B / §13.9 "describe by default"): the ONE
 *  subject-wildcard request form in the caller grammar,
 *  `ep.one.*.describe.<cO>.<cA>.<cUid>.*` — the endpoint token is the wildcard, the command is
 *  the literal reserved `describe`, and the caller triple stays pinned. DELIBERATELY not an
 *  {@link EpCapability} (whose endpoint is a validated literal): a wildcard-endpoint capability
 *  would generalize to arbitrary commands, and the baseline is the only place the wildcard form
 *  is normative. Untargeted only — describe is constructed untargeted on every serve
 *  (§13.7), so no authz/target block ever appears in the row. */
export function epDescribeAllGrantRow(space: string, caller: EpCaller): string {
  return `${spacePrefix(space)}.ep.one.*.describe.${callerBlock(caller)}.*`;
}

/** The baseline {@link EpCapability} set every agent holds (Appendix B) beyond the wildcard
 *  describe row: delivery join/leave/list (untargeted) + self-mode lifecycle. */
export function baselineCallerCapabilities(): EpCapability[] {
  return [
    ...DELIVERY_COMMANDS_SNAP.map((command) => ({ endpoint: BASELINE_DELIVERY_ENDPOINT, command })),
    ...SELF_LIFECYCLE_SNAP.map((command) => ({ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command, target: { mode: "self" } as const })),
  ];
}

/** The `spawn` capability's addition (Appendix B): the manager endpoint's lifecycle commands.
 *  `spawn` (creation) is UNTARGETED — a virgin child has no lifecycle UID to resolve against the
 *  current mapping, so an owner-mode row would be un-invokable under the verb grammar (§13.2). The
 *  three that act on an existing agent ride owner mode, target owner pinned to the CALLER's own
 *  (§13.2: an owner-mode standing mint never names a foreign owner). */
export function spawnCallerCapabilities(callerOwner: string): EpCapability[] {
  return [
    ...SPAWN_CREATE_SNAP.map((command) => ({ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command })),
    ...SPAWN_OWNER_SNAP.map((command) => ({
      endpoint: BASELINE_LIFECYCLE_ENDPOINT, command,
      target: { mode: "owner", tOwner: callerOwner } as EpTarget,
    })),
    ...SPAWN_SERVICE_SNAP.map((command) => ({ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command })),
  ];
}

/** An operator INSTRUMENT's capability set (the 1c grant-migration table's admin row), per the
 *  instrument's v0.3 control tier - the SAME mint sites that grant a `ctl.<tier>` row today
 *  (`control-caller-*` / `deployer`) consume this for the ep rails; no new minting authority.
 *
 *  `privileged` (the ps/start instrument): the manager reads + untargeted `spawn` +
 *  `define-persona` - structurally barred from cross-agent reach, exactly like its ctl row.
 *
 *  `admin` (the stop/attach/deploy instrument): everything above plus ANY-mode `despawn`/`attach`
 *  (tOwner `"*"`) and the `manager.admin` command family. The 1c admin-reach decision: operator
 *  cross-agent terminal/interactive ops ride authz-mode `any` on the SAME commands (no wire
 *  synonym) - the any-mode subject row is minted ONLY into operator-authorized credentials: the
 *  `control-caller-admin`/`deployer`/`teardown` instruments AND an agent credential explicitly
 *  granted the `admin` capability (which by design mirrors the full admin instrument set - its
 *  ctl-tier equivalent already held `ctl.<admin>`, so this is parity, not a new escalation). An
 *  ordinary agent, incl. the `spawn` capability, never carries it. So the broker grant is the tier boundary exactly as
 *  `ctl.<admin>` is today, and the responder maps mode `any` to its admin authorization path. */
export function operatorInstrumentCapabilities(tier: "privileged" | "admin"): EpCapability[] {
  const caps: EpCapability[] = [
    ...MANAGER_READ_SNAP.map((command) => ({
      endpoint: BASELINE_LIFECYCLE_ENDPOINT, command,
      // `ps` is the CLASS-SCATTER read (P2 item 3, `cotal ps` default): the instrument publishes it
      // on the `all` scatter rail to gather every instance's rows in a multi-manager space. The
      // other reads stay `one`-only (anycast, or `inst` when a resolve pins `--on`).
      ...(command === "ps" ? { routes: ["one", "all"] as ("one" | "all")[] } : {}),
    })),
    ...SPAWN_CREATE_SNAP.map((command) => ({ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command })),
    { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "define-persona" },
  ];
  if (tier === "admin") {
    caps.push(
      ...SPAWN_OWNER_SNAP.map((command) => ({
        endpoint: BASELINE_LIFECYCLE_ENDPOINT, command,
        target: { mode: "any", tOwner: "*" } as EpTarget,
      })),
      ...MANAGER_ADMIN_SNAP.map((command) => ({ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command })),
    );
  }
  return caps;
}

/** The SAME tier set, pinned to ONE instance — the issuance `--on <instanceId>` was always meant to
 *  get. These instruments are ONE-SHOT, minted per control call, and the resolve that chose the
 *  instance runs BEFORE the mint, so the exact id can be handed down and the emitter's
 *  `if (cap.instanceId)` branch produces exactly `ep.inst.<endpoint>.<iid>.<command>` for THIS
 *  invocation and nothing else. No wildcard instance is minted anywhere, which is what keeps the
 *  `inst-route-grant` boundary intact: instance addressing stays with the per-invocation operator
 *  instruments that already hold it, and a plain, spawn-capable, or observer credential still gets
 *  no instance route at all.
 *
 *  `describe` is included EXPLICITLY. The baseline describe row is class-rail only
 *  ({@link epDescribeAllGrantRow}), so without this the pinned RESOLVE that must precede a pinned
 *  invoke is refused at the broker — and refused invisibly, because the client renders that refusal
 *  as a describe timeout. Here it is a concrete endpoint+instance capability, not the normative
 *  wildcard form, so the exact-arity discipline of the caller grammar is preserved. */
export function instancePinnedInstrumentCapabilities(tier: "privileged" | "admin", instanceId: string): EpCapability[] {
  assertLifecycleToken(instanceId, "instanceId"); // fail loud at mint on a malformed id, never widen a subject
  return [
    { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "describe", instanceId },
    ...operatorInstrumentCapabilities(tier).map((cap) => ({ ...cap, instanceId })),
  ];
}

/** All BASELINE caller rows (Appendix B): the wildcard describe form + the baseline capability
 *  rollup into `pub.allow`, and the caller's reply rail into `sub.allow` — ALWAYS present (the
 *  baseline implies the reply read even when no per-capability rows are minted). The §13.7
 *  contract-store FETCH (the Direct Get API on the EPC stream) rides the baseline too: describe
 *  answers digests, and a caller that may describe may fetch-verify-compile the schemas those
 *  digests name (content-addressed public artifacts — a digest is the read capability; the
 *  per-caller authorization surface is the describe VIEW, never the schema bytes). */
export function epBaselineGrantRows(space: string, caller: EpCaller): { pub: string[]; sub: string[] } {
  const base = epCallerGrantRows(space, baselineCallerCapabilities(), caller);
  return {
    pub: [
      epDescribeAllGrantRow(space, caller),
      // ONE subject-scoped Direct Get row (the `DIRECT.GET.<stream>.<subject>` form the client's
      // last_by_subj read rides), pinned to the epc subject space — never the bare/stream-wide
      // form. The D32 matrix audit exempts exactly this row shape from the untrusted-profile
      // control-surface prohibition (the store is public content-addressed artifacts).
      `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
      ...base.pub,
    ],
    sub: [epCallerReplyGrantRow(space, caller)],
  };
}

/** One registered command's serve-subscribe rows (§13.9 "Serve subscribe"), per registered
 *  command and never a cross-command `>`:
 *   - class rail: `"ep.one.<endpoint>.<command>.> <queue>"` — QUEUE-QUALIFIED ONLY (the NATS
 *     `subject queue` grant form): no credential can plain-subscribe the class rail, which is
 *     what keeps per-request nonces visible only to the queue-selected instance;
 *   - scatter rail: `ep.all.<endpoint>.<command>.>` plain;
 *   - instance rail: `ep.inst.<endpoint>.<instanceId>.<command>.>` exact.
 *  The epoch is deliberately absent from serve subscriptions (§13.1's barrier is the fence). */
export function epServeSubscribeRows(space: string, endpoint: string, instanceId: string, command: string): string[] {
  const e = endpointToken(endpoint);
  const cmd = assertCommandToken(command);
  return [
    `${spacePrefix(space)}.ep.one.${e}.${cmd}.> ${epClassQueueGroup(endpoint)}`,
    `${spacePrefix(space)}.ep.all.${e}.${cmd}.>`,
    `${spacePrefix(space)}.ep.inst.${e}.${assertLifecycleToken(instanceId, "instanceId")}.${cmd}.>`,
  ];
}

/** A serving instance's egress rows (§13.9 matrix): reply publish (attribution-pinned instance
 *  triple + epoch), events, timer SCHEDULE requests (never `.armed`/`.fire`), and the epoch-pinned
 *  record-write ingress. Every row pins the instance's own identity and epoch. */
export function epServePublishRows(space: string, endpoint: string, instanceId: string, epoch: number): string[] {
  const e = endpointToken(endpoint);
  const iId = assertLifecycleToken(instanceId, "instanceId");
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`epoch ${epoch} is not an unsigned integer`);
  return [
    epResponderReplyPattern(space, endpoint, instanceId, epoch),
    `${spacePrefix(space)}.epe.${e}.${iId}.${epoch}.>`,
    `${spacePrefix(space)}.ept.${e}.${iId}.${epoch}.*.schedule`,
    `${spacePrefix(space)}.epr.${e}.${iId}.${epoch}.>`,
  ];
}

/** All serve-credential subject-space rows for an instance. `ephemeralCommands` is the
 *  RAIL-SERVED (ephemeral) subset only — journal commands stay in the credential's descriptor
 *  surface but ride `epj` submissions, never the §13.2 request rails, so they take no rail
 *  subscribe row here (their effects/pool durable binds ride the §13.12 stream binding). The
 *  reserved `describe` is DERIVED here — every endpoint serves it (§13.7), so this ONE assembly
 *  seam emits its rails for every serve credential (even a journal-only endpoint, whose
 *  `ephemeralCommands` is empty) and an explicit `describe` refuses (mirroring
 *  {@link import("./endpoint-serve.js").serveEndpoint}'s construction rule: there is no custom
 *  describe). The subscribe side also carries the instance's OWN epoch-pinned timer FIRE row
 *  (§13.9 "Timer fire consume": `ept.<e>.<i>.<epoch>.*.fire` — consume only; the publish side
 *  stays `.schedule`-only, no credential publishes `.armed`/`.fire`). */
export function epServeGrantRows(
  space: string,
  serve: { endpoint: string; instanceId: string; epoch: number; ephemeralCommands: string[] },
): { pub: string[]; sub: string[] } {
  if (serve.ephemeralCommands.includes("describe"))
    throw new Error(`"describe" is not a mintable serve command: it is reserved and derived here for every serve credential (SPEC 13.7/13.9)`);
  const sub: string[] = [];
  for (const cmd of [...serve.ephemeralCommands, "describe"]) sub.push(...epServeSubscribeRows(space, serve.endpoint, serve.instanceId, cmd));
  const pub = epServePublishRows(space, serve.endpoint, serve.instanceId, serve.epoch); // validates the tuple's tokens + epoch
  sub.push(`${spacePrefix(space)}.ept.${endpointToken(serve.endpoint)}.${assertLifecycleToken(serve.instanceId, "instanceId")}.${serve.epoch}.*.fire`);
  return { pub, sub };
}

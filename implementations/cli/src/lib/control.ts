import { randomUUID } from "node:crypto";
import {
  assertLifecycleToken,
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  GOAL_BEARING_COMMANDS,
  goalFollowRefusal,
  epProbeInstanceInterest,
  freezeExpectedSet,
  instancePinnedInstrumentCapabilities,
  invokeCommand,
  invokeRepairingSplit,
  issuedUserCaller,
  mintCreds,
  parseEpSubject,
  respondedButUnbound,
  unansweredRequest,
  unansweredRail,
  registryReadFailed,
  noLiveInstances,
  undeclaredArg,
  controlReplyFrom,
  controlReplyFromThrown,
  submitAndFollowGoal,
  scatterCommand,
  mintLifecycleUid,
  newIdentity,
  dialerFor,
  resolveService,
  standaloneConnectOpts,
  type ControlReply,
  type EpCaller,
  type EpInstanceLiveness,
  type EpScatterResult,
  type EpVerbTarget,
  type FlagSpec,
  type GoalResultFact,
  type Profile,
  type ResolvedService,
} from "@cotal-ai/core";
import { PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { CommandFailure, ConnectRefusal, controlCaller, loadSpaceAuth, oneLine, renderWorkspaceError, type ControlAuth, type RefusalCode } from "@cotal-ai/workspace";
import { DEV_OWNER, EP_UNANSWERED, type SpaceAuth } from "@cotal-ai/core";
import { c, staleStoreHint, stderrLine } from "../ui.js";
import { cliVersion } from "./version.js";
import { DIAL_TIMEOUT_MS, DialNotAdmitted, dialWithRetry, notAdmittedRefusal } from "./dial-retry.js";
import { nativeEndpointRefusal } from "./endpoint-errors.js";

/** The control auth shape and target resolver live in `@cotal-ai/workspace` (shared with every
 *  command surface that addresses the manager: this CLI, `cotal run`, the web dashboard). Re-exported
 *  so this module's importers keep resolving them from here. */
export { resolveControlTarget, type ControlAuth } from "@cotal-ai/workspace";

/** Client-side request window for the manager's readiness-waiting launch ops (`start`, and the
 *  manifest `launch` — both funnel into the same startAgent readiness wait). #159 B1: the manager
 *  replies only on a REAL outcome — presence join, process exit, or its ~30s readiness backstop —
 *  so these requests must OUTLIVE that window, not the 5s op default. The tier rule forbids
 *  importing the manager's READINESS_TIMEOUT_MS here; the launch-parity smoke enforces the
 *  relation by test. */
export const START_TIMEOUT_MS = 40_000;

/** v0.3 ctl op → v0.4 typed command (P2 item 1, 1c.2b): the wire names the manager REGISTERS
 *  (manager-service-contract ROWS). `start` is creation (`spawn`), a NAMED `stop` is the one
 *  owner/any-mode terminal (`despawn`), the per-agent `status` read is `inspect`; the camelCase
 *  admin family maps to its kebab-case wire names. `targeted` marks the three commands whose
 *  `{name}` argument becomes a §13.2 target block (resolved to the agent's principal triple via
 *  the name-keyed `inspect` read — it rides the spawn capability arm, so resolution reach equals
 *  despawn/attach reach; the wire target is (owner, actor, lifecycleUid), never an alias). */
const EP_COMMANDS: Record<string, { command: string; targeted?: boolean; self?: boolean }> = {
  managerStatus: { command: "status" },
  start: { command: "spawn" },
  resolveAgent: { command: "resolve-agent" },
  resolveCwd: { command: "resolve-cwd" },
  stop: { command: "despawn", targeted: true },
  stopSelf: { command: "stop", self: true },
  attach: { command: "attach", targeted: true },
  input: { command: "input", targeted: true },
  status: { command: "inspect" },
  ps: { command: "ps" },
  slots: { command: "slots" },
  models: { command: "models" },
  listPersonas: { command: "list-personas" },
  launch: { command: "launch" },
  purge: { command: "purge" },
  resumePreserved: { command: "resume-preserved" },
  commitResume: { command: "commit-resume" },
  finalizeResume: { command: "finalize-resume" },
  preparePreservation: { command: "prepare-preservation" },
  commitPreservation: { command: "commit-preservation" },
  abortPreservation: { command: "abort-preservation" },
  transcriptReceive: { command: "transcript-receive" },
  chatSessionOpen: { command: "chat-session-open" },
  chatSessionRetire: { command: "chat-session-retire" },
  runPs: { command: "run-ps" },
  runStatus: { command: "run-status" },
};

/** Operator reach for one targeted control call: `owner` rides the caller's own-domain verb rows
 *  (the spawn capability's standing mint), `any` the admin instrument's cross-agent rows (§13.2
 *  any-mode). Replaces the deleted manager ctl tiers as the CLI's mode selector (1d). */
export type ControlReach = "owner" | "any";

/** The ep-rail control call — since 1d {@link askManager}'s ONLY path: one short-lived raw
 *  connection, a fresh `resolveService` (describe → §13.7 store fetch → digest-verified recompile
 *  — the generic item-5 caller, no hand-imported manager schemas), then the mapped command.
 *  Targeted ops resolve the alias to its CURRENT principal triple through the name-keyed
 *  `inspect` read first and ride mode `any` (admin instruments) or `owner` per {@link
 *  ControlReach}.
 *
 *  `standaloneConnectOpts` handles static credentials, a user bearer plus sentinel, and bare open
 *  meshes. The selected dialer matters: a user mesh behind an HTTPS edge has a `wss://` URL, which
 *  the raw node transport refuses even though endpoint, send, and spawn rails can reach it.
 *  A connect the broker refuses or does not complete in time sends nothing, so it is tried again
 *  ({@link dialWithRetry}); when every attempt ends that way, {@link notAdmittedRefusal} is thrown. */
async function askManagerEp(
  space: string,
  server: string,
  op: string,
  args: Record<string, unknown> | undefined,
  auth: ControlAuth,
  reach: ControlReach,
  timeoutMs?: number,
  pin?: ManagerPin,
): Promise<ManagerReply> {
  if (pin?.instanceId !== undefined && auth.managerInstanceId !== undefined && pin.instanceId !== auth.managerInstanceId)
    return { ok: false, error: "the manager pin differs from this credential's instance authority", code: "permission-denied" };
  const instanceId = pin?.instanceId ?? auth.managerInstanceId;
  const mapped = EP_COMMANDS[op];
  if (!mapped) return { ok: false, error: `unknown manager op "${op}" (no v0.4 command mapping)` };
  // Each attempt is a new connection, so a user bearer's connection nonce is minted afresh with it.
  let connectOpts: Record<string, unknown> = {};
  const nc = await dialWithRetry(() => {
    connectOpts = standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: auth.tls === true } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds, tls: auth.tls === true } : { tls: auth.tls === true });
    return dialerFor(server)({ servers: server, ...connectOpts, timeout: DIAL_TIMEOUT_MS, maxReconnectAttempts: 0 });
  }).catch((e: unknown) => {
    if (!(e instanceof DialNotAdmitted)) throw e;
    throw notAdmittedRefusal(e, instanceId === undefined ? "this space's manager" : `manager instance ${instanceId}`, "nothing was sent to the manager",
      { space, ...(instanceId === undefined ? {} : { managerInstanceId: instanceId }) }, auth.bearer !== undefined);
  });
  let request: ManagerRequestReceipt | undefined;
  let intent: ManagerRequestIntent | undefined;
  let observationCause: { code?: string; outcome?: string } | undefined;
  try {
    // A logged-in user's manager view is issued at the callout (SPEC 13.15): read its generation
    // back from this connection's accepted row; a missing row refuses, never a legacy-rail retry.
    const caller = auth.bearer !== undefined && auth.managerInstanceId !== undefined
      ? await issuedUserCaller(nc, space, String(connectOpts.name), auth.epCaller!)
      : auth.epCaller!;
    // P2 item 3 `--on <instance>`: pin the resolve to the exact manager instance's `inst` route so a
    // multi-manager space addresses the intended manager, never whichever wins the class anycast.
    const followsGoal = (GOAL_BEARING_COMMANDS as readonly string[]).includes(mapped.command);
    const resolveCommands = [...new Set([mapped.command, ...(mapped.targeted ? ["inspect"] : []), ...(followsGoal ? ["goal-result"] : [])])];
    const service = await resolveService(nc, space, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: 10_000, commands: resolveCommands, ...(instanceId !== undefined ? { instanceId } : {}), ...(pin?.signal ? { signal: pin.signal } : {}) });
    let target: EpVerbTarget | undefined;
    let sendArgs = args;
    if (mapped.self) target = { mode: "self" };
    else if (mapped.targeted) {
      const name = String(args?.name ?? "").trim();
      if (!name) return { ok: false, error: `${op} requires a name` };
      // Alias -> CURRENT principal triple via the manager's name-keyed `inspect` read (§13.2: a
      // target is a triple, never an alias) - the same resolution the connector uses. `inspect`
      // rides the SPAWN capability arm as well as the instrument read set, so every caller class
      // that can despawn/attach can also resolve its target (a `ps` SCAN here broker-drops exactly
      // the spawn-scoped user bearers - the 1c.2b read narrowing - and hangs their stop/attach).
      const info = await invokeRepairingSplit(nc, space, service, "inspect", { name }, { deadlineMs: 10_000 });
      if (info.reply.ok !== true) {
        const refused = controlReplyFrom(info.reply);
        // Only the inspect read was published. Preserve its native error, but record the local
        // proof that this targeted action was never submitted.
        return { ...refused, preSubmitRefusal: true, managerInstanceId: info.responder.instanceId, managerEpoch: info.responder.epoch, error: `could not resolve "${name}": ${refused.error}` };
      }
      const row = info.reply.data as { id: string; lifecycleUid: string };
      if (pin?.expectedTarget && (row.id !== pin.expectedTarget.id || row.lifecycleUid !== pin.expectedTarget.lifecycleUid))
        return { ok: false, code: "not-found", error: "the selected agent incarnation changed; refresh the agent list before attaching" };
      // A STATIC row's `id` is the bare actor under the caller's own owner; a USER-mode row's `id`
      // is the composite `owner.actor` principal key - split it (an embedded dot would break the
      // target block's subject arity). Mode `any` spans owners (operator reach); mode `owner` pins
      // the caller's own, so a foreign-owner target is broker-denied at publish.
      const dot = row.id.indexOf(".");
      const [tOwner, tActor] = dot > 0 ? [row.id.slice(0, dot), row.id.slice(dot + 1)] : [caller.owner, row.id];
      // Target mode from the RESOLVED target owner: an own-domain target rides `owner` mode (pinned
      // to the caller's own owner); a CROSS-owner target rides `any` mode - which the broker admits
      // only for a caller holding the admin instrument rows (a static admin instrument, or a user
      // bearer whose ledger `admin` scope the callout minted them into). `reach: "any"` forces
      // any-mode for a static admin instrument even on its own domain. So a spawn-scoped caller's
      // cross-owner despawn/attach is broker-denied at publish (no any-mode row), while an
      // admin-scoped operator's is admitted and the manager's fresh ledger check governs.
      const mode = reach === "any" || tOwner !== caller.owner ? "any" : "owner";
      target = {
        mode,
        owner: tOwner,
        actor: tActor,
        lifecycleUid: row.lifecycleUid,
      };
      const { name: _dropped, ...rest } = args ?? {};
      sendArgs = Object.keys(rest).length ? rest : undefined;
    }
    const blocked = followsGoal ? goalFollowRefusal(service) : undefined;
    if (blocked) return { ...controlReplyFrom(blocked.reply), nativeOutcome: "not-executed", managerInstanceId: service.responder.instanceId, managerEpoch: service.responder.epoch };
    const id = randomUUID();
    intent = { requestId: id, ...(followsGoal ? { requestedGoalId: id } : {}) };
    if (pin?.journal) await pin.journal.beforeSubmit(intent);
    const invokeOpts = { ...(target ? { target } : {}), deadlineMs: timeoutMs ?? 10_000, id, ...(pin?.signal ? { signal: pin.signal } : {}) };
    const submit = async (signal?: AbortSignal) => {
      const answer = await invokeRepairingSplit(nc, space, service, mapped.command, sendArgs, { ...invokeOpts, ...(signal ? { signal } : {}) });
      const data = answer.reply.data as { goalId?: unknown; fingerprint?: unknown; name?: unknown; owner?: unknown; actor?: unknown; uid?: unknown } | undefined;
      request = { requestId: answer.reply.id, managerInstanceId: answer.responder.instanceId, managerEpoch: answer.responder.epoch,
        ...(answer.reply.ok && typeof data?.goalId === "string" ? { goalId: data.goalId } : {}),
        ...(answer.reply.ok && typeof data?.fingerprint === "string" ? { fingerprint: data.fingerprint } : {}),
        ...(answer.reply.ok && typeof data?.goalId === "string" && typeof data.name === "string" && typeof data.owner === "string" && typeof data.actor === "string" && typeof data.uid === "string"
          ? { allocation: { name: data.name, owner: data.owner, actor: data.actor, lifecycleUid: data.uid } } : {}),
      };
      if (answer.reply.ok && request.allocation && pin?.journal) await pin.journal.accepted(request);
      return answer;
    };
    // P2 item 2 (2b): a goal-bearing command (spawn/launch) FOLLOWS its acceptance to the goal
    // terminal, so `spawn --detach` still returns on the real outcome (join / exit / ~30s uncertain)
    // exactly like the pre-action blocking reply — UX unchanged, no --no-wait.
    const r = followsGoal
      ? await submitAndFollowGoal(nc, space, BASELINE_LIFECYCLE_ENDPOINT, caller, timeoutMs ?? START_TIMEOUT_MS, submit, {
        reconcile: async (goalId, accepted, context) => {
          // A class credential keeps its class route. An accepted instance ID grants no new rail;
          // the native follower still verifies the canonical fact against the original caller/goal.
          const current = await resolveService(nc, space, BASELINE_LIFECYCLE_ENDPOINT, context.caller, { ...(instanceId !== undefined ? { instanceId: accepted.responder.instanceId } : {}), commands: ["goal-result"], deadlineMs: context.deadlineMs, signal: context.signal });
          const answer = await invokeRepairingSplit(nc, space, current, "goal-result", { goalId }, { deadlineMs: context.deadlineMs, signal: context.signal });
          if (!answer.reply.ok) {
            observationCause = { code: answer.reply.error?.code, outcome: answer.reply.error?.outcome };
            throw new Error("the accepting manager did not provide a confirmed goal-result read");
          }
          return answer.reply.data as { goalId: string; result?: GoalResultFact };
        },
      })
      : await submit();
    if (r.reply.ok !== true) return { ...controlReplyFrom(r.reply), answered: true, managerInstanceId: r.responder.instanceId, managerEpoch: r.responder.epoch, ...(observationCause ? { observationCause } : {}), ...(intent ? { intent } : {}), ...(request ? { request } : {}), ...(r.reply.error?.outcome ? { nativeOutcome: r.reply.error.outcome } : {}) };
    // The ep `models` reply is normalized to `{catalogs}` — unwrap so call sites keep the ctl shape.
    const data = mapped.command === "models" ? (r.reply.data as { catalogs: unknown }).catalogs : r.reply.data;
    return { ok: true, managerInstanceId: r.responder.instanceId, managerEpoch: r.responder.epoch, ...(observationCause ? { observationCause } : {}), ...(intent ? { intent } : {}), ...(request ? { request } : {}), ...(data !== undefined ? { data } : {}) };
  } catch (e) {
    return { ...epRailFailure(e, instanceId === undefined ? pin : { instanceId }), ...(observationCause ? { observationCause } : {}), ...(intent ? { intent } : {}), ...(request ? { request, managerInstanceId: request.managerInstanceId, managerEpoch: request.managerEpoch } : {}), ...(e instanceof EpEnvelopeError && e.outcome ? { nativeOutcome: e.outcome } : {}) };
  } finally {
    // Drain waits for in-flight NATS work. A dead broker never finishes that, and
    // attach-auth-root hung here after spawn once nats-server exited.
    await Promise.race([
      nc.drain().catch(() => nc.close()),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
    ]);
    try {
      nc.close();
    } catch {
      /* already closed */
    }
  }
}

export interface ManagerRequestIntent {
  requestId: string;
  requestedGoalId?: string;
}

export interface ManagerRequestReceipt {
  requestId: string;
  managerInstanceId: string;
  managerEpoch: number;
  goalId?: string;
  fingerprint?: string;
  allocation?: { name: string; owner: string; actor: string; lifecycleUid: string };
}

/** {@link ControlReply} plus the one fact a caller cannot recover from the rendered message: whether
 *  the call went UNANSWERED, as core marks it (`EP_UNANSWERED`: no responder, or the reply
 *  deadline elapsed with nothing attributed to the request). `up`'s resume readiness poll keys on it;
 *  it used to key on the message prefix, which turned an operator-facing string into a control-flow
 *  predicate in another file. `answered` marks a refusal a manager responder sent itself; one the
 *  broker or this client raised leaves it unset. */
export type ManagerReply = ControlReply & { unanswered?: boolean; answered?: true; preSubmitRefusal?: true; managerInstanceId?: string; managerEpoch?: number; observationCause?: { code?: string; outcome?: string }; intent?: ManagerRequestIntent; request?: ManagerRequestReceipt; nativeOutcome?: "executed" | "not-executed" | "unknown" };

/** Classify only a proved pre-effect refusal as refused; a missing effect outcome is not proof.
 *  Every message names the agent when the target carries one and ends with the manager's own
 *  reason, kept to one line. */
export function managerFailure(reply: ManagerReply, operation: string, target: unknown): CommandFailure {
  const native = { code: reply.code, outcome: reply.nativeOutcome, ...(reply.preSubmitRefusal ? { detail: { phase: "target-resolution", actionSubmitted: false } } : reply.request || reply.intent ? { detail: { request: reply.request ?? null, intent: reply.intent ?? null, observation: reply.observationCause ?? null } } : {}) };
  const code = nativeEndpointRefusal(reply.code);
  const agent = (target as { agent?: unknown } | null)?.agent;
  const what = typeof agent === "string" ? `${operation} for agent "${oneLine(agent)}"` : operation;
  const reason = reply.error ? `: ${oneLine(reply.error)}` : "";
  if (reply.preSubmitRefusal && code) return new CommandFailure("refused", code, reply.error ? oneLine(reply.error) : `${operation} was not submitted because its target could not be resolved`, { target, native, remedy: "run `cotal ps` to check the selected manager and agent name" });
  if (reply.nativeOutcome === "not-executed" && code) return new CommandFailure("refused", code, `the manager refused ${what} before execution${reason}`, { target, native, remedy: "nothing ran; fix what the manager reported, then run the command again" });
  if (reply.nativeOutcome === "executed" && !reply.unanswered) return new CommandFailure("failed", "OPERATION_FAILED", `the manager reported that ${what} failed${reason}`, { target, native });
  return new CommandFailure("unknown", "OPERATION_UNKNOWN", `the manager did not confirm the outcome of ${what}; it was not submitted again${reason}`, { target, native, remedy: "inspect the recorded manager, request and target before retrying" });
}

/** A describe that drew no answer means the command after it was never sent, so it is refused, as
 *  `chat` and the run verbs refuse it, and not an unknown outcome. Undefined for any other failure. */
export function unansweredDescribeRefusal(reply: ManagerReply, operation: string, target: unknown): CommandFailure | undefined {
  if (!describeUnanswered(reply)) return undefined;
  const agent = (target as { agent?: unknown } | null)?.agent;
  const what = typeof agent === "string" ? `${operation} for agent "${oneLine(agent)}"` : operation;
  return new CommandFailure("refused", "TARGET_UNAVAILABLE", `the manager registered for this space did not answer, so ${what} was not sent: ${oneLine(reply.error ?? "no reply")}`, { target, native: { code: reply.code }, remedy: "cotal status shows whether this space's manager answers; a stack manager that runs but does not answer is named there with its pid and the way to end it" });
}

/** Whether the describe before a command drew no answer, so the command itself was never sent. */
export function describeUnanswered(reply: ManagerReply): boolean {
  return reply.details?.some((detail) => detail.kind === EP_UNANSWERED && detail.command === "describe") === true;
}

/** What the calling command declares about pinning. Passed ONLY by a command that offers `--on`
 *  (`ps`, `models`, `stop`, `attach`, `spawn --detach`), with `instanceId` set to what the operator
 *  typed, if anything. Its presence is what lets the renderer offer `--on` as a remedy: a command
 *  without the flag (`up`, `down`) rides the same rails, splits the same way, and must not be told
 *  to type a flag it does not have. Absence of a pin therefore never means "not passed". */
export interface ManagerPin {
  instanceId?: string;
  /** A picker-selected incarnation, checked after name resolution and before publication. */
  expectedTarget?: { id: string; lifecycleUid: string };
  /** Composite operations persist their original request before publication and the attributed
   * allocation before following a goal. A journal refusal never triggers another submission. */
  journal?: {
    beforeSubmit(intent: ManagerRequestIntent): void | Promise<void>;
    accepted(receipt: ManagerRequestReceipt): void | Promise<void>;
  };
  /** Stops the resolve and the request waiting, for a caller that no longer needs the answer. */
  signal?: AbortSignal;
}

/** `--on <instance>`: address ONE manager instance instead of the class queue. Shared by
 *  ps/stop/attach/input/describe/models so they cannot drift. For stop and attach it is the seat-locality
 *  escape hatch: the manager that can act on a seat is the one HOSTING it, which is not necessarily
 *  the one that wins the class queue. On a user-auth mesh it also takes a manager's name or host
 *  ({@link managerPin}). */
export const onFlag = { name: "on", type: "string", value: "<instance>", description: "ask only this manager, by the instance id `ps` prints or, on a user-auth mesh, by its name or host" } as const satisfies FlagSpec;

/** Read `--on` at the site that declares it. Absent stays absent (class rails). An EMPTY value
 *  (`--on=`, `--on ""`, or `--on "$INSTANCE"` with the variable unset) is refused here, up front:
 *  it is falsy, so every `if (on)` branch would treat it as absent and drop the pin (a `stop` would
 *  fall through to seat locality, an open-mesh `ps` to the scatter), while the mint and core's
 *  route builder treat it as PRESENT and refuse it as an invalid token. Two answers for one input;
 *  a dropped pin is a silent fallback, so neither branch gets to see it. A roster principal id
 *  (`local.…`) is refused here too, naming the identifier `--on` wants (#423). Any other value is an
 *  instance id, name or host, which {@link managerPin} resolves to an instance id before use. */
export function onInstance(on: string | undefined, verb: string): string | undefined {
  if (on === undefined) return undefined;
  if (on === "")
    throw new CommandFailure("refused", "USAGE_INVALID", `--on requires a manager instance id (the whole id, as \`cotal ps\` prints it), or on a user-auth mesh a manager's name or host: \`${verb} --on <instance>\`. An empty value is refused, not dropped`, { selfContained: true });
  if (on.startsWith("local."))
    throw new CommandFailure("refused", "USAGE_INVALID", `"${on}" is a principal id. --on wants the manager INSTANCE id as \`cotal ps\` prints it (the \`instance\` it lists for a manager that answered, or the \`manager <id>\` header when several did), not the roster's principal id (\`local.U…\`, as \`cotal endpoints\` shows it): \`${verb} --on <instance>\``, { selfContained: true });
  return on;
}

/** {@link onInstance} for an `--on` that takes only an instance id: an endpoint's instance, or a
 *  step that runs before the mesh can be read. The value is shape-checked against core's
 *  lifecycle-token grammar, so a malformed id is refused naming the identifier `--on` wants. */
export function onInstanceId(on: string | undefined, verb: string): string | undefined {
  const value = onInstance(on, verb);
  if (value === undefined) return undefined;
  try {
    assertLifecycleToken(value, "instanceId");
  } catch (e) {
    throw new CommandFailure("refused", "USAGE_INVALID", `${(e as Error).message}. --on wants the INSTANCE id as \`cotal ps\` prints it (the \`instance\` it lists for a manager that answered, or the \`manager <id>\` header when several did): \`${verb} --on <instance>\``, { selfContained: true });
  }
  return value;
}

/** Render an ep-rail failure for the operator. Three outcomes, told apart by core's markers and never
 *  by the catalog code: a responder's own `ok:false` describe reply is rethrown under ITS code
 *  (`unavailable` included), and a store read after an answered describe raises the same code, so
 *  the code says nothing about whether anyone answered.
 *  - UNANSWERED ({@link unansweredRequest}: no responder, or the reply deadline elapsed). The
 *    reachability verdict "no manager reachable" is stated here and only here, and only unpinned:
 *    an unanswered PINNED call names the instance instead, since three managers may be answering
 *    while the one the operator typed is not there, and "no manager reachable" sends them to the
 *    broker for a typo. Measured on a live three-manager mesh during review. The verdict is also
 *    scoped to the RAIL ({@link unansweredRail}): on the versioned rail it names that rail and says what the
 *    silence does not establish, because SPEC 13.15 keeps the two rails disjoint at the broker.
 *  - a REGISTRY READ on this side failed ({@link registryReadFailed}: the scatter's freeze or its
 *    reconcile). The managers were not the failure and may all be up; a verdict on them here sent
 *    the operator to the managers for a broker read.
 *  - everything else answered, or failed on this side with its own cause, and is printed as is.
 *    Prepending a verdict made the headline contradict the body: a describe REFUSED BY THE BROKER
 *    read as an unreachable manager, which is precisely the misreading the refusal was reworded to
 *    stop.
 *  A failure that is not an {@link EpEnvelopeError} carries no answer provenance at all, so no verdict
 *  is stated for it either: its message stands alone. */
export function epRailFailure(e: unknown, pin?: ManagerPin): ManagerReply {
  if (!(e instanceof EpEnvelopeError)) return { ok: false, unanswered: false, error: e instanceof Error ? e.message : String(e) };
  return { ...controlReplyFromThrown(e, epRailMessage(e, pin)), unanswered: unansweredRequest(e) };
}

function epRailMessage(e: EpEnvelopeError, pin?: ManagerPin): string {
  const instanceId = pin?.instanceId;
  const detail = `${e.code}: ${e.message}`;
  if (unansweredRequest(e)) {
    // The verdict is SCOPED TO THE RAIL the request rode (SPEC 13.15). The legacy and versioned rails are
    // disjoint subject spaces at the broker and an endpoint is required to serve both, so a manager
    // built before the versioned rail subscribes `ep` alone and an issued caller can never see it.
    // "No manager reachable" is then a claim about the mesh drawn from silence on one half of it,
    // and #1630 measured it against a manager that was up, idle on the roster and starting runs the
    // whole time. On the legacy rail there is no other half, so the verdict stands as it was.
    const rail = unansweredRail(e);
    const versioned = rail !== undefined && rail !== "ep" ? rail : undefined;
    // TWO CAUSES, BOTH NAMED. Silence on a versioned rail is consistent with no manager at all AND
    // with one older than the rail, and this side cannot tell them apart: the registry records no
    // package version. An earlier wording named only the skew, which sent an operator whose manager
    // was simply down to go and check a version.
    const skew = versioned === undefined ? "" :
      ` The ${versioned} and legacy ep rails are disjoint at the broker (SPEC 13.15) and an endpoint must serve both, so this does not tell no manager running apart from one older than ${versioned}, which serves ep only and cannot answer here. Check whether a manager is running, and if it is, its version.`;
    return instanceId !== undefined
      ? `manager instance ${instanceId} did not answer${versioned === undefined ? "" : ` on the ${versioned} rail`} (${detail})${skew}`
      : versioned === undefined
        ? `no manager reachable on the ep rails (${detail})`
        : `no manager answered on the ${versioned} rail (${detail})${skew}`;
  }
  if (registryReadFailed(e))
    return `the manager registry could not be read: a broker read on this side, not the managers' silence, and they may all be up. Retry; if it persists, look at the broker's JetStream (${detail})`;
  // This CLI built the args for a manager of its own release, and the two release in lockstep, so a
  // key the manager's contract does not declare means the manager runs a different release.
  const undeclared = undeclaredArg(e);
  if (undeclared !== undefined)
    return `${detail}. That is version skew: this CLI runs Cotal ${cliVersion()} and sends "${undeclared}", which the manager's contract does not declare. Run the manager at Cotal ${cliVersion()}, or use a CLI at the manager's version`;
  // The unpinned class-queue split. Core says a call that addresses one instance does not split
  // and stops there (a CLI flag name does not belong in a core error). The flag is named here only
  // when the CALLER declared it has one (`pin` present) and did not pass it: an absent `pin` is a
  // command with no `--on` at all, and telling it to type one is the same dead end one layer down.
  // A marked `expired` is the other producer (a stale-epoch bind) and its remedy is re-resolving,
  // so the flag is offered only for the split.
  const unpinnedSplit = e.code === "failed-precondition" && respondedButUnbound(e) && pin !== undefined && instanceId === undefined;
  return `${detail}${unpinnedSplit ? " Pin one manager instance with --on <instance> (the whole id, as `ps` prints it) to avoid the split." : ""}`;
}

/** Send one control command to the manager over the v0.4 service-endpoint rails and disconnect —
 *  since 1d the manager's ONLY control door (the `ctl` tiers are deleted). The target is already
 *  reachability- + auth-preflighted by {@link resolveControlTarget}. `reach` picks the operator
 *  mode for the two targeted ops (stop/attach): `owner` = the caller's own domain (the spawn
 *  capability's standing mint / a user bearer's own owner), `any` = the admin instrument's
 *  cross-agent reach. Three auth shapes reach the rails: a static instrument's caller triple, a
 *  user bearer's triple, or an OPEN mesh (no credential system — a bare connection under a
 *  synthesized DEV_OWNER triple, since the manager registered under DEV_OWNER and the broker
 *  enforces nothing). A raw `--creds` file from an older generation carries no ep rows and is
 *  refused loud (no silent ctl fallback exists anymore). */
export async function askManager(
  space: string,
  server: string,
  op: string,
  args?: Record<string, unknown>,
  auth: ControlAuth = {},
  reach: ControlReach = "owner",
  timeoutMs?: number,
  pin?: ManagerPin,
): Promise<ManagerReply> {
  const who = controlCaller(auth);
  if ("refusal" in who) return { ok: false, error: who.refusal };
  return askManagerEp(space, server, op, args, { ...auth, epCaller: who.caller }, reach, timeoutMs, pin);
}

/** What this CLI established about a silent instance's LIVENESS, as opposed to its answer. Kept
 *  separate from `reachable` because they are different questions and folding them is what let a
 *  registration outlive its host unnoticed:
 *   - `gone` — the BROKER answered no-responders on that instance's own rail. Affirmative: the
 *     record claims a live instance and there is nothing behind it, so the row can say so and name
 *     the deregistration.
 *   - `unknown` — a probe went out and nothing came back. A live-but-slow host and a wedged one are
 *     the same observation from here, so nothing is claimed.
 *   - `not-probed` — no probe was PUBLISHED for it: it is outside this credential's pinned set (it
 *     registered after the freeze this instrument was minted against), or this command had no
 *     probe path at all (user mode holds no instance rails).
 *   - `probe-refused` — the broker refused the probe publish. The grant is missing, which is a
 *     local misconfiguration and NOT a statement about the instance; it is named on stderr rather
 *     than left to expire into `unknown`. */
export type ScatterInstanceLiveness = "gone" | "unknown" | "not-probed" | "probe-refused";

/** One instance's slot in a class scatter (P2 item 3): a REACHABLE instance carries its attributed
 *  reply (`data` on ok, `error` on a per-instance failure); an UNREACHABLE one (a frozen slot that
 *  produced no on-time reply — a severed/stalled manager) is reported, NEVER omitted (SPEC §13.5 pin 3),
 *  and carries what the liveness probe established about it ({@link ScatterInstanceLiveness}). */
export interface ScatterInstanceReply {
  instanceId: string;
  reachable: boolean;
  data?: unknown;
  error?: string;
  /** The endpoint's error code beside `error`, when its refusal carried one. */
  code?: string;
  /** Set on unreachable slots only: a slot that ANSWERED needs no liveness verdict. */
  liveness?: ScatterInstanceLiveness;
  /** The host name this instance gave in its own `status` reply, when the caller asked for it.
   *  Display metadata the manager reports about itself: never checked and never a route. */
  reportedHost?: string;
}
/** A failed scatter's `noLiveManager` says the registry was read and lists no live manager. */
export type ScatterReply = { ok: true; instances: ScatterInstanceReply[] } | { ok: false; error: string; code?: string; unanswered?: boolean; noLiveManager?: true };

/** Open one short-lived control connection under whichever of the three auth shapes this command
 *  holds (static creds / user bearer + sentinel / bare open mesh) and hand it to `fn`. Extracted so
 *  the scatter's TWO connections cannot drift in their connect options: they differ in credential
 *  and in nothing else. The selected dialer matters because the raw node transport refuses a
 *  `wss://` mesh behind an HTTPS edge even when the other endpoint rails can reach it. */
export async function withControlConnection<T>(server: string, auth: ControlAuth, fn: (nc: NatsConnection) => Promise<T>): Promise<T> {
  const nc = await dialerFor(server)({
    servers: server,
    ...standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: auth.tls === true } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds, tls: auth.tls === true } : { tls: auth.tls === true }),
    maxReconnectAttempts: 0,
  });
  try {
    return await fn(nc);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** The instance a REFUSED SUBJECT names, or `undefined` when that subject is not one of this
 *  probe's requests at all.
 *
 *  The id is read as a whole subject TOKEN, through the same §13.9 grammar parser that built the
 *  subject, and never matched inside the text. Lifecycle tokens are `[a-z0-9]{26,32}`, so one
 *  frozen id can be a PREFIX of another (26 chars and the same 26 plus a suffix are both legal),
 *  and a substring test then attributes one broker refusal to two instances: the operator is told
 *  the CLI could not ask about a manager it never published for, and that instance's probe settles
 *  as `probe-refused` on evidence that belongs to a different rail. Parsing removes the class of
 *  mistake rather than one instance of it: the endpoint and the route mode must match too, so a
 *  violation on any other plane, endpoint, or route is not this probe's and is not attributed. */
function probedInstanceOf(subject: string, endpoint: string): string | undefined {
  const parsed = parseEpSubject(subject);
  if (parsed === null || parsed.plane !== "request" || parsed.route !== "inst") return undefined;
  return parsed.endpoint === endpoint ? parsed.instanceId : undefined;
}

/** Watch a connection's status stream for the broker's own PERMISSION VIOLATIONS and attribute each
 *  to the instance whose rail it names.
 *
 *  A refused publish is invisible where it matters. The violation is delivered on the CONNECTION,
 *  asynchronously, while the publish itself returns normally — so a liveness probe with no grant
 *  does not fail, it goes quiet, and quiet is exactly what a live-but-slow instance looks like. The
 *  whole probe would then read as `unknown`, the deadline would be paid in full, and the operator
 *  would be told the manager was slow when the truth was that this CLI never asked. So the
 *  violation is caught, attributed to the instance its subject names, reported on stderr once, and
 *  used to settle that probe immediately instead of letting it expire.
 *
 *  ATTRIBUTION IS STRUCTURAL, not textual. The client types a permission violation as
 *  `PermissionViolationError` and carries the refused SUBJECT as a field, so nothing here parses
 *  the broker's prose: the subject goes through {@link probedInstanceOf} and yields one exact id or
 *  none. NAMED RESIDUAL: a connection error the client does not type as a permission violation is
 *  not attributed, and that probe expires into `unknown` at its budget — the behaviour that existed
 *  before this watch, which is slower and never wrong. */
function watchProbeRefusals(
  nc: NatsConnection,
  what: { endpoint: string; ids: readonly string[] },
  report: (line: string) => void,
): { refused: (id: string) => Promise<void>; wasRefused: (id: string) => boolean } {
  const ids = new Set(what.ids);
  const settle = new Map<string, () => void>();
  const already = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const refused = (id: string): Promise<void> => {
    if (already.has(id)) return Promise.resolve();
    let p = pending.get(id);
    if (!p) {
      p = new Promise<void>((resolve) => settle.set(id, resolve));
      pending.set(id, p);
    }
    return p;
  };
  void (async () => {
    try {
      for await (const s of nc.status()) {
        if (s.type !== "error") continue;
        const err = (s as { error?: unknown }).error;
        if (!(err instanceof PermissionViolationError)) continue;
        const id = probedInstanceOf(err.subject, what.endpoint);
        if (id === undefined || !ids.has(id) || already.has(id)) continue;
        already.add(id);
        report(`! the broker refused this command's liveness probe for manager instance ${id}: ${err.message}`);
        settle.get(id)?.();
      }
    } catch {
      /* the connection closed; the scatter is over and there is nothing left to attribute */
    }
  })();
  return { refused, wasRefused: (id: string) => already.has(id) };
}

/**
 * THE §13.5 LIVENESS HOOK this CLI hands to a scatter, and the record of what it established.
 *
 * It is built HERE and not in core because it is entirely a statement about this caller's
 * CREDENTIAL. A probe publishes on an instance's own rail, and only the layer that minted the
 * credential knows which instance rails it carries; core cannot know, and a core that guessed would
 * publish requests the broker must refuse — invisibly, since a refused publish looks exactly like a
 * slow instance from the caller's side.
 *
 * TWO RULES, and both are about not asking questions this credential cannot ask:
 *  - an id OUTSIDE the pinned set gets `unknown` WITHOUT PUBLISHING. The scatter re-freezes the
 *    class on its own connection, so it can name an instance that registered after the freeze this
 *    credential was minted against. That instance is NEW, not dead, and the right answer for it is
 *    the deadline — reached without sending a request that would be refused.
 *  - an id INSIDE the set that the broker refuses anyway settles IMMEDIATELY on the violation
 *    rather than expiring into `unknown` at the budget, and is reported by name.
 *
 * Only `gone` ever licenses anything downstream, so every mistake this can make is a slower and
 * more truthful answer, never a faster wrong one.
 */
export function pinnedLivenessProbe(
  nc: NatsConnection,
  opts: {
    space: string;
    endpoint: string;
    caller: EpCaller;
    /** The exact ids this connection's credential holds `inst` rails for. */
    pinned: ReadonlySet<string>;
    probeDeadlineMs?: number;
    /** Where a refusal is announced. Defaults to stderr; the suite captures it. */
    report?: (line: string) => void;
  },
): {
  probeLiveness: (instanceId: string) => Promise<EpInstanceLiveness>;
  /** What was established about one silent slot, for the row that will describe it. */
  livenessOf: (instanceId: string) => ScatterInstanceLiveness;
} {
  const deadlineMs = opts.probeDeadlineMs ?? PROBE_DEADLINE_MS;
  const report = opts.report ?? ((line: string) => console.error(c.dim(line)));
  const refusals = watchProbeRefusals(nc, { endpoint: opts.endpoint, ids: [...opts.pinned] }, report);
  const verdicts = new Map<string, ScatterInstanceLiveness>();
  return {
    probeLiveness: async (instanceId: string): Promise<EpInstanceLiveness> => {
      if (!opts.pinned.has(instanceId)) {
        verdicts.set(instanceId, "not-probed");
        return "unknown";
      }
      const verdict = await Promise.race([
        epProbeInstanceInterest(nc, opts.space, opts.endpoint, instanceId, opts.caller, { deadlineMs }),
        refusals.refused(instanceId).then((): EpInstanceLiveness => "unknown"),
      ]);
      verdicts.set(instanceId, verdict === "gone" ? "gone" : refusals.wasRefused(instanceId) ? "probe-refused" : "unknown");
      return verdict;
    },
    // A slot with no recorded verdict was never handed to the hook at all, which is a different fact
    // from "probed and silent" and prints as one.
    livenessOf: (instanceId: string): ScatterInstanceLiveness =>
      verdicts.get(instanceId) ?? (opts.pinned.has(instanceId) ? "unknown" : "not-probed"),
  };
}

/** The tier a scatter re-mints at. Only ONE tier can scatter — the freeze read is a privileged row
 *  and the admin tier is denied it deliberately — so this is a constant rather than a parameter, and
 *  it is named here so the re-mint below can never silently widen: it reproduces the credential the
 *  caller already resolved with, pinned, never a higher one. */
const SCATTER_PROFILE: Profile = "control-caller-privileged";

/** How long a single liveness probe waits for the broker's no-responders answer. It is NOT a tuning
 *  knob and cannot make the command wrong: the only verdict that changes anything is `gone`, and
 *  giving up early yields `unknown`, which leaves the full gather deadline standing exactly as it
 *  did before the probe existed. Sized to be generous against a busy broker while still expiring
 *  well inside the gather. */
const PROBE_DEADLINE_MS = 5_000;

/** How long the host names a census shows may take, all together. They are display metadata, so an
 *  instance that has not answered by then is listed without one. */
const REPORTED_HOST_BUDGET_MS = 2_000;
const HOST_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,251}[A-Za-z0-9_])?$/;

/** Ask each instance that answered the census for its own `status`, on its `inst` route at the
 *  epoch it answered with, where this credential's pinned rails reach it. One bound covers every
 *  ask and aborts what is still out. Only a well-formed host name from that exact instance is kept;
 *  anything else leaves the instance without one, and nothing here changes what the census found. */
async function askReportedHosts(nc: NatsConnection, space: string, service: ResolvedService, answered: EpScatterResult["replies"], instances: ScatterInstanceReply[], reachable: ReadonlySet<string>): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REPORTED_HOST_BUDGET_MS);
  try {
    await Promise.all(instances.filter((slot) => slot.error === undefined && reachable.has(slot.instanceId)).map(async (slot) => {
      const epoch = answered.get(slot.instanceId)?.responder.epoch;
      if (epoch === undefined) return;
      try {
        const pinned: ResolvedService = { ...service, responder: { instanceId: slot.instanceId, epoch }, pinnedInstanceId: slot.instanceId };
        const answer = await invokeCommand(nc, space, pinned, "status", undefined, { deadlineMs: REPORTED_HOST_BUDGET_MS, signal: abort.signal });
        const host = answer.reply.ok === true ? (answer.reply.data as { host?: unknown } | undefined)?.host : undefined;
        if (answer.responder.instanceId === slot.instanceId && typeof host === "string" && HOST_NAME.test(host)) slot.reportedHost = host;
      } catch { /* display metadata only: the instance is listed without a host */ }
    }));
  } finally { clearTimeout(timer); }
}

/**
 * Whether the scatter's liveness probe rides a BARE connection, a freshly minted pinned instrument,
 * or nothing at all. The sixth seed reach on the attach path, made explicit.
 *
 * Named and exported so it is GRADABLE, because it is the one site on this path that still answers
 * "is this an open mesh?" from the absence of a credential. That inference is issue #1205 itself,
 * and it is only tolerable here because of what this answer is allowed to DO: it selects whether a
 * frozen instance's liveness is probed, so a wrong answer downgrades a row to `not-probed` and
 * never refuses an attach. A caller that ever turns this into a refusal must change this function,
 * which is the point of it having a name.
 *
 *   bare   — no credential and no bearer: an open mesh, whose connection can already publish.
 *   mint   — a sealed mesh that holds its seed AND arrived on a credential: re-mint pinned.
 *   as-is  — everything else (a user bearer, a raw off-registry cred, a sealed mesh with no seed):
 *            keep the credential it arrived with and probe nothing, which is the pre-existing
 *            behaviour and prints `not-probed` rather than degrading silently.
 */
export function scatterProbeMaterial(
  auth: ControlAuth,
  spaceAuth: SpaceAuth | undefined,
): { kind: "bare" } | { kind: "mint"; auth: SpaceAuth } | { kind: "as-is" } {
  if (!auth.creds && !auth.bearer) return { kind: "bare" };
  if (spaceAuth && auth.creds) return { kind: "mint", auth: spaceAuth };
  return { kind: "as-is" };
}

/** The ep-rail CLASS SCATTER (P2 item 3, `cotal ps` default).
 *
 * TWO connections, because a connection's permissions are fixed at authentication and this command
 * cannot know which instance rails it needs until it has read the registry:
 *
 *   0. FREEZE the live class from the records registry (the same §13.9 read the scatter itself
 *      does), then close. This yields the exact instance ids this invocation will address.
 *   1. RE-MINT the one-shot instrument LOCALLY, pinned to exactly those ids, and run the
 *      unpinned {@link resolveService} + {@link scatterCommand} on it — now the §13.5 liveness probe
 *      can publish on each frozen instance's own rail and the gather can end as soon as every slot
 *      has either answered or been affirmed gone by the broker.
 *
 * THE COST IS THE MINT, NOT A ROUND TRIP. `mintCreds` is a local JWT signature against the space
 * seed already in hand (measured at 22-45ms here); the extra connection is the only wire cost. The
 * earlier attempt at this measured 3.2s because it re-ran the whole target resolve (registry read,
 * preflight, stale-prune) to get a pinned credential, and shipped a regression to fix a hypothesis.
 * This re-mints and nothing else.
 *
 * NO WILDCARD INSTANCE ROW is minted, which is the invariant the whole two-connection shape exists
 * to preserve: the pin is a list of exact ids known before the mint, the same precondition `--on`
 * satisfies with one id.
 *
 * WHERE THERE IS NO SEED THERE IS NO PROBE, and the deadline stands. A user-mode bearer and a raw
 * off-registry cred cannot re-mint, so their frozen slots are `not-probed` and say so. This is not
 * a silent degrade: it is the pre-existing behaviour, and the row prints which of the two it is.
 */
async function askManagerScatterEp(
  space: string,
  server: string,
  op: string,
  auth: ControlAuth,
  spaceAuth: SpaceAuth | undefined,
  timeoutMs?: number,
  reportHosts = false,
): Promise<ScatterReply> {
  const mapped = EP_COMMANDS[op];
  if (!mapped) return { ok: false, error: `unknown manager op "${op}" (no v0.4 command mapping)` };
  if (mapped.targeted) return { ok: false, error: `${op} is targeted and cannot be scattered across instances` };

  // ---- connection 0: freeze the class. A registry read that fails here fails the command with the
  // registry's own verdict (never the managers'), which `epRailFailure` already words.
  let pinnedIds: string[];
  try {
    pinnedIds = await withControlConnection(server, auth, async (nc) => {
      // `checkAPI: false` for the same reason `scatterCommand` uses it: the freeze rides the scoped
      // §13.9 records rows, never an account-level JetStream probe.
      const jsm = await jetstreamManager(nc, { checkAPI: false });
      return (await freezeExpectedSet(jsm, space, BASELINE_LIFECYCLE_ENDPOINT)).map((f) => f.instanceId);
    });
  } catch (e) {
    const { error, code, unanswered } = epRailFailure(e);
    return { ok: false, error: error ?? "error", ...(code === undefined ? {} : { code }), ...(unanswered ? { unanswered } : {}), ...(noLiveInstances(e) ? { noLiveManager: true as const } : {}) };
  }

  // ---- the LOCAL pinned re-mint, decided by {@link scatterProbeMaterial} rather than inline.
  // This is the SIXTH place the attach path reaches for a seed (attach → pinForTarget → locateSeat
  // → scatterManager → here), and it is named as such because its answer is still derived from the
  // ABSENCE of a credential, which is the inference issue #1205 was about. It is safe here and it
  // is NOT safe by accident: this site only decides whether to PROBE LIVENESS, so its worst outcome
  // is a `not-probed` row, never a refusal to attach. It is extracted anyway so a future caller
  // that starts making a REFUSAL out of this answer has to pass through a named decision that says
  // so, instead of re-deriving openness from a nullable field for the second time in one path.
  const material = scatterProbeMaterial(auth, spaceAuth);
  let probeAuth = auth;
  let caller = auth.epCaller!;
  let probed: ReadonlySet<string> = material.kind === "bare" ? new Set(pinnedIds) : new Set();
  if (material.kind === "mint") {
    const identity = newIdentity();
    const uid = mintLifecycleUid();
    probeAuth = {
      ...auth,
      creds: await mintCreds(material.auth, identity, SCATTER_PROFILE, {
        lifecycleUid: uid,
        endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", pinnedIds),
      }),
    };
    caller = { owner: DEV_OWNER, actor: identity.id, uid };
    probed = new Set(pinnedIds);
  }

  // ---- connection 1: resolve + scatter, with the probe closure this credential can actually back.
  try {
    return await withControlConnection(server, probeAuth, async (nc) => {
      const { probeLiveness, livenessOf } = pinnedLivenessProbe(nc, { space, endpoint: BASELINE_LIFECYCLE_ENDPOINT, caller, pinned: probed });
      const service = await resolveService(nc, space, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: 10_000 });
      const result = await scatterCommand(nc, space, service, mapped.command, undefined, {
        deadlineMs: timeoutMs ?? 8_000,
        reconcileDeadlineMs: 3_000,
        probeLiveness,
      });
      const instances: ScatterInstanceReply[] = [];
      for (const [instanceId, ar] of result.replies) {
        if (ar.reply.ok === true) instances.push({ instanceId, reachable: true, data: ar.reply.data });
        else instances.push({ instanceId, reachable: true, error: ar.reply.error?.message ?? ar.reply.error?.code ?? "error", ...(ar.reply.error?.code ? { code: ar.reply.error.code } : {}) });
      }
      // A frozen instance that never answered is UNREACHABLE — surfaced, never silently dropped
      // (pin 3) — and now carries WHY it is silent, as far as this command could establish it.
      for (const instanceId of result.missing)
        instances.push({ instanceId, reachable: false, liveness: livenessOf(instanceId) });
      if (reportHosts) await askReportedHosts(nc, space, service, result.replies, instances, probed);
      return { ok: true, instances };
    });
  } catch (e) {
    const { error, code, unanswered } = epRailFailure(e);
    return { ok: false, error: error ?? "error", ...(code === undefined ? {} : { code }), ...(unanswered ? { unanswered } : {}) };
  }
}

/** SCATTER one untargeted read (`ps`) across EVERY registered manager instance in the space and merge
 *  the attributed results — the `cotal ps` default in a multi-manager space (P2 item 3). Auth shapes
 *  match {@link askManager}: a minted instrument or user bearer rides its own caller triple; a raw
 *  pre-1c `--creds` file is refused loud; an OPEN mesh synthesizes a DEV_OWNER triple and connects
 *  bare (the broker enforces nothing, so the records freeze reads freely). `spaceAuth` is the
 *  resolved mesh's trust material from {@link resolveControlTarget}: present ⇒ the scatter re-mints
 *  its instrument pinned to the frozen instance ids and can probe their liveness; absent ⇒ it runs
 *  exactly as it did before and every silent slot is reported `not-probed`. */
export async function scatterManager(
  space: string,
  server: string,
  op: string,
  auth: ControlAuth = {},
  spaceAuth?: SpaceAuth,
  timeoutMs?: number,
  opts: { reportHosts?: boolean } = {},
): Promise<ScatterReply> {
  const who = controlCaller(auth);
  if ("refusal" in who) return { ok: false, error: who.refusal };
  return askManagerScatterEp(space, server, op, { ...auth, epCaller: who.caller }, spaceAuth, timeoutMs, opts.reportHosts === true);
}

/** The refusal `ps` gives, raised before an unpinned operator read when the registry lists no live
 *  manager, rather than after the read's describe has waited out its whole deadline. Only the
 *  operator instrument holds the registry rows, so a caller passes a user's manager view or a pinned
 *  call straight to the read. Any other registry outcome, an unreadable registry included, leaves
 *  the read to decide. `purpose` completes "no manager is running for this space to …". Returns the
 *  live instance ids the registry listed, or undefined when it could not be read. */
export async function refuseWithoutLiveManager(space: string, server: string, auth: ControlAuth, target: unknown, purpose: string): Promise<string[] | undefined> {
  try {
    return await liveManagerIds(space, server, auth);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError) || !noLiveInstances(e)) return undefined;
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `no manager is running for this space to ${purpose}`, { target, native: { code: e.code, detail: `${e.code}: ${e.message}` }, remedy: "start the stack's manager with bare `cotal up`; a stack started with --no-manager has none" });
  }
}

/** The host one manager instance reports in its own `status`, the name `cotal ps` prints as its
 *  reported host, or undefined when it does not answer or names no well-formed host. Presence
 *  carries no instance id off a user-auth mesh, so this read is where a pinned manager's host comes
 *  from there. The view is the caller's own and is not kept.
 *
 *  It takes the ordinary control deadline, NOT {@link REPORTED_HOST_BUDGET_MS}. That budget belongs
 *  to the census above, where a host name is display metadata and a slow instance is listed without
 *  one. Here the answer decides whether a launch stops to ask the operator a question, so a read
 *  that gives up early does not lose a column, it asks about a manager that is on this host.
 *  Measured: under heavy load the 2s budget expired and the question came back. */
export async function reportedManagerHost(space: string, server: string, auth: ControlAuth, instanceId: string): Promise<string | undefined> {
  let reply: ManagerReply;
  try {
    reply = await askManager(space, server, "managerStatus", undefined, auth, "owner", undefined, { instanceId });
  } catch { return undefined; }
  const host = reply.ok ? (reply.data as { host?: unknown } | undefined)?.host : undefined;
  return typeof host === "string" && HOST_NAME.test(host) ? host : undefined;
}

/** A pinned instance the space's registry does not list has nothing behind it to answer, so the
 *  command is refused before it waits out the reply deadline, naming the managers that are running.
 *  A registry this side cannot read leaves the request to settle it. */
export async function refuseUnregisteredManager(space: string, server: string, auth: ControlAuth, on: string): Promise<void> {
  let running: string[];
  try {
    running = await liveManagerIds(space, server, auth);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError) || !noLiveInstances(e)) return;
    running = [];
  }
  if (running.includes(on)) return;
  const target = { space, requestedManagerInstance: on };
  // With none running this is the unpinned refusal, which names the same way out.
  if (running.length === 0)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `no manager is running for this space, so --on ${on} names none. Nothing was sent`, { target, remedy: "start the stack's manager with bare `cotal up`; a stack started with --no-manager has none" });
  const which = running.length === 1 ? `the one running is ${running[0]}` : `the ones running are ${running.join(", ")}`;
  throw new CommandFailure("refused", "TARGET_NOT_FOUND", `--on ${on} names no manager running for space ${space}; ${which}. Nothing was sent`, {
    target,
    remedy: running.length === 1 ? `run it again with --on ${running[0]}, or without --on` : "run it again with --on naming one of them",
  });
}

/** Whether the broker affirms that nothing is subscribed on manager `instanceId`'s own rail, so its
 *  registration outlived its host. The probe settles on the broker's no-responders answer, so a gone
 *  manager costs no reply deadline. A live manager never answers the probe, which then runs its whole
 *  budget, so a caller that also asks the manager itself passes `signal` and fires it once that
 *  answer arrives. Any other outcome, an aborted probe or one this credential cannot send included,
 *  is `false`. */
export async function managerRailGone(space: string, server: string, auth: ControlAuth, instanceId: string, signal?: AbortSignal): Promise<boolean> {
  const who = controlCaller(auth);
  if ("refusal" in who || signal?.aborted) return false;
  const aborted = new Promise<false>((resolve) => signal?.addEventListener("abort", () => resolve(false), { once: true }));
  try {
    return await withControlConnection(server, auth, (nc) => Promise.race([
      epProbeInstanceInterest(nc, space, BASELINE_LIFECYCLE_ENDPOINT, instanceId, who.caller, { deadlineMs: PROBE_DEADLINE_MS }).then((verdict) => verdict === "gone"),
      aborted,
    ]));
  } catch {
    return false;
  }
}

/** The manager instances the space's registry lists as live, frozen as a scatter freezes them. An
 *  empty registry throws the registry's own refusal. */
export async function liveManagerIds(space: string, server: string, auth: ControlAuth): Promise<string[]> {
  return withControlConnection(server, auth, async (nc) => (await freezeExpectedSet(await jetstreamManager(nc, { checkAPI: false }), space, BASELINE_LIFECYCLE_ENDPOINT)).map((f) => f.instanceId));
}

/** The stable code a refused manager READ reports, by the endpoint's catalog code. A read has no
 *  effect, so an outcome the catalog does not classify is a failed read, never an unknown one. */
const READ_REFUSALS: Readonly<Record<string, RefusalCode>> = {
  unauthenticated: "AUTH_REQUIRED",
  "permission-denied": "PERMISSION_DENIED",
  "not-found": "TARGET_NOT_FOUND",
  unavailable: "TARGET_UNAVAILABLE",
  "deadline-exceeded": "TARGET_UNAVAILABLE",
  unimplemented: "UNSUPPORTED",
  "contract-mismatch": "UNSUPPORTED",
  conflict: "CONFLICT",
};

/** A manager read that did not answer, as the classified failure a structured command reports: the
 *  same sentence, the endpoint's own code under `error.cause`, and the stale-store hint as its remedy
 *  when one applies. A request nobody answered carries `deadline-exceeded`, an unavailable target. */
export function readFailure(reply: { error?: string; code?: string; details?: unknown }, target?: unknown): CommandFailure {
  const message = reply.error ?? "the manager refused the read";
  const remedy = staleStoreHint(message);
  const native = reply.code === undefined && reply.details === undefined ? undefined : { ...(reply.code === undefined ? {} : { code: reply.code }), ...(reply.details === undefined ? {} : { detail: reply.details }) };
  const opts = { target, ...(remedy ? { remedy } : {}), ...(native ? { native } : {}) };
  const code = reply.code === undefined ? undefined : READ_REFUSALS[reply.code];
  return code ? new CommandFailure("refused", code, message, opts) : new CommandFailure("failed", "OPERATION_FAILED", message, opts);
}

export function failIfNotOk(reply: ControlReply): void {
  if (!reply.ok) {
    const msg = reply.error ?? "error";
    stderrLine("✗ ", msg, c.red);
    // A manager-side stale-store durable collision (e.g. `spawn --detach` into a store minted by
    // an older Cotal generation) names its reset - the reply error stays verbatim.
    const hint = staleStoreHint(msg);
    if (hint) stderrLine("  ↳ ", hint, c.dim);
    process.exit(1);
  }
}

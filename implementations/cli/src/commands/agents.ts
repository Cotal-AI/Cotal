import { DEV_OWNER, assertLifecycleToken, peerLabel, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs, type Presence } from "@cotal-ai/core";
import {
  codeSpan,
  CommandFailure,
  findMesh,
  isCommandFailure,
  isConnectRefusal,
  jsonFlag,
  localStackRoot,
  oneLine,
  renderReport,
  plainFlag,
  presentationOf,
  resolveSeatControlTarget,
  targetFlags,
  writeResult,
  type Block,
  type ConnectFlags,
  type Cell,
  type OutputWarning,
  type Report,
  type Section,
  type Styled,
  type Tone,
  recordOperationSpace,
  resolveControlTarget,
  connectOrThrow,
} from "@cotal-ai/workspace";
import * as prompts from "../lib/prompts.js";
import { canPrompt } from "./meshes-wizard.js";
import { presenceFacts } from "../ui.js";
import { cliControl, onInstance, onFlag } from "../lib/control.js";
import { AgentManagerUnsettled, managerPin, noLiveManager } from "../lib/manager-choice.js";
import { openTransient } from "../lib/transient.js";
import { attachSeat as attachSeatWith, detachKey, type AttachTarget, type AttachVerdict } from "@cotal-ai/workspace/attach";
import { completingFlagValue } from "../lib/completion.js";
import { displayCmd } from "../lib/self-exec.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { runningStackManagerPid, stackManagerAbsent, stackManagerStarting } from "../lib/stack-journal.js";
import { connectorHarnesses } from "../lib/status.js";
import { askManager, scatterManager, managerFailure, readFailure, refuseUnregisteredManager, unansweredDescribeRefusal, type ScatterInstanceLiveness, type ScatterInstanceReply, type ManagerPin, managersByInstance, type ManagerCandidate, askYourManagers, locateSeat, managerReadFailure, refusedManagers, seatMissRefusal } from "@cotal-ai/workspace/control";

/**
 * The manager's operator clients — thin control-plane request/reply commands (`stop`/`ps`/
 * `attach`) that drive a RUNNING manager. Moved from `@cotal-ai/manager` in stage 2a of the CLI
 * rework: they are operator client commands, not daemon code; the manager keeps `supervise`.
 * Detached LAUNCH is `cotal spawn --detach` (spawn.ts) — one launch grammar for both modes.
 */

const nameFlag = (what: string) =>
  ({ name: "name", type: "string", value: "<n>", description: what }) as const;

// #651: the same rows, two richer presentations. `--wide` stays human (one dim facts line per
// seat); `--json` is the machine form (one JSON object per line, exactly the row the manager
// sent). Mutually exclusive because they are two answers to "how should I read this".
const wideFlag = { name: "wide", type: "boolean", description: "also print the per-seat facts the manager already records: cwd, pid, spawner, lifecycle uid, host/instance" } as const;
const slotsFlag = { name: "slots", type: "boolean", description: "list the durable static slots instead of live seats; not with --wide" } as const;
export const stopFlags = [...targetFlags, nameFlag("agent name; you can name it positionally"),
  { name: "self", type: "boolean", description: "stop only the verified managed seat running this command" },
  { name: "force", type: "boolean", description: "request native hard despawn (graceful:false); does not bypass authority" },
  onFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];
export const psFlags = [...targetFlags, onFlag, wideFlag, jsonFlag, plainFlag, slotsFlag] as const satisfies readonly FlagSpec[];
/** `--no-reconnect`: one session, exit when it ends, whatever ended it. The default reconnects,
 *  which is right for a person at a terminal and wrong for a script that wants a single run with a
 *  single exit code. */
const noReconnectFlag = { name: "no-reconnect", type: "boolean", description: "exit when the session ends instead of re-establishing it" } as const;
export const attachFlags = [...targetFlags, nameFlag("agent name; you can name it positionally"), onFlag, noReconnectFlag] as const satisfies readonly FlagSpec[];
/** `cotal input`: type into a seat without holding a terminal open. `--text` is a VALUE flag, so
 *  its argument is taken verbatim and may begin with `/` or `-` (`--text "/compact"`) - which is
 *  the point: a harness command is exactly the payload that would be eaten by a positional
 *  grammar. `--no-enter` is a declared boolean literally named `no-enter` rather than a negation
 *  of an `enter` flag: node's `parseArgs` does not negate under `strict`, and the CLI already
 *  spells this shape (`--no-open`, `--no-replay`). */
export const inputFlags = [
  ...targetFlags,
  nameFlag("managed agent to type into (required)"),
  { name: "text", type: "string", value: "<text>", description: "the text to type, verbatim (required); quote it when it starts with / or -" },
  { name: "no-enter", type: "boolean", description: "type the text without pressing Enter after it" },
  onFlag, jsonFlag, plainFlag,
] as const satisfies readonly FlagSpec[];

export function managedAgentComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, attachFlags);
  if (flag?.name === "name") return { items: [], directive: "nofiles" };
  if (argv.length <= 1)
    return { items: attachFlags.map((f) => ({ value: `--${f.name}`, description: f.description })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

/** The named target grammar, checked before any command preparation. */
export function managedTarget(args: ParsedArgs, operation: "stop" | "attach", allowPicker = false): string | undefined {
  const named = typeof args.values.name === "string" ? args.values.name : undefined;
  if (args.positionals.length > 1 || (args.positionals.length && named !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", `choose one agent: \`cotal ${operation} <name>\``);
  const name = args.positionals[0] ?? named;
  if (typeof args.values.on === "string") onInstance(args.values.on, `cotal ${operation}`);
  if (name === undefined && operation === "attach" && allowPicker) {
    if (!canPrompt()) throw new CommandFailure("refused", "USAGE_INVALID", "name the agent to attach without an interactive terminal", { remedy: "run `cotal ps`, then `cotal attach <name>`", selfContained: true });
    return undefined;
  }
  if (name !== undefined && /[\u0000-\u001f\u007f]/u.test(name)) throw new CommandFailure("refused", "USAGE_INVALID", "the agent name contains terminal control characters");
  if (!name?.trim()) throw new CommandFailure("refused", "USAGE_INVALID", `name the agent to ${operation}`, { remedy: "run `cotal ps`, then `cotal " + operation + " <name>`" });
  return name;
}

export function validateStopArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.values.self) {
    if (args.positionals.length || args.values.name !== undefined || args.values.creds !== undefined)
      throw new CommandFailure("refused", "USAGE_INVALID", "stop --self takes no other agent or caller credential");
    if (args.values.on !== undefined) {
      const pin = onInstance(String(args.values.on), "cotal stop --self");
      if (pin !== process.env.COTAL_MANAGER_INSTANCE) throw new CommandFailure("refused", "CONFLICT", "stop --self cannot select a different manager than the seat's launcher");
    }
    return;
  }
  managedTarget(args, "stop");
}

export async function stop(args: ParsedArgs): Promise<void> {
  validateStopArguments(args);
  const v = args.values as FlagValues<typeof stopFlags>;
  let pin: ManagerPin = {};
  let on: string | undefined;
  let t: Awaited<ReturnType<typeof resolveControlTarget>>;
  let name: string | undefined;
  if (v.self) {
    const space = v.space ?? process.env.COTAL_SPACE;
    const manager = process.env.COTAL_MANAGER_INSTANCE;
    if (!space || !manager) throw new CommandFailure("refused", "UNSUPPORTED", "stop --self requires a managed seat's own shell, space and launcher attribution");
    on = onInstance(manager, "cotal stop --self");
    let seat: Awaited<ReturnType<typeof resolveSeatControlTarget>>;
    try { seat = await resolveSeatControlTarget({ space, server: v.server }, on); }
    catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the seat's own caller could not be verified; no operator identity was substituted"); }
    if (!seat) throw new CommandFailure("refused", "UNSUPPORTED", "this caller cannot stop itself through the CLI; missing or mismatched seat context and user-auth self impersonation never fall back to the operator");
    t = seat;
  } else {
    name = managedTarget(args, "stop");
    pin = await pinForTarget({ ...v, name } as never, "cotal stop");
    on = pin.instanceId;
    // A typed pin the registry does not list is refused at once, as spawn refuses it. Stop's admin
    // instrument holds no registry read, so the check uses the one ps reads the registry with.
    if (v.on !== undefined && on !== undefined) {
      const reader = await resolveControlTarget(v, "control-caller-privileged", on);
      if (!reader.auth.bearer) await refuseUnregisteredManager(reader.space, reader.server, reader.auth, on);
    }
    t = await resolveControlTarget(v, "control-caller-admin", on);
  }
  recordOperationSpace(t.space);
  const reply = await askManager(cliControl, t.space, t.server, v.self ? "stopSelf" : "stop", { ...(name ? { name } : {}), graceful: v.force !== true }, t.auth, t.auth.bearer ? "owner" : "any", undefined, { ...pin, instanceId: on });
  const target = { space: t.space, managerInstanceId: reply.managerInstanceId ?? on ?? null, selection: v.self ? "verified-self" : "named", ...(name ? { agent: name } : {}) };
  if (!reply.ok) throw unansweredDescribeRefusal(reply, "agent stop", target) ?? managerFailure(reply, "agent stop", target);
  const data = reply.data as { name?: unknown; stopped?: unknown; graceful?: unknown } | undefined;
  if (!data || typeof data.name !== "string" || typeof data.stopped !== "boolean" || typeof data.graceful !== "boolean")
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the manager answered, but the stop receipt could not be read; the request was not repeated", { target, ...(reply.request ? { native: { detail: { request: reply.request } } } : {}) });
  if (!data.stopped) throw new CommandFailure("failed", "OPERATION_FAILED", "the manager reported that it did not stop the selected agent", { target });
  const result = { kind: "agent-stop", name: data.name, stopped: data.stopped, graceful: data.graceful, request: reply.request ?? null, grantRevocation: t.auth.bearer ? "native user-mode stop policy" : "not asserted" };
  writeResult(presentationOf(v), { command: "stop", target, result }, (row): Report => ({ sections: [
    { title: "Agent stop acknowledged", blocks: [{ kind: "fields", rows: [["Agent", row.name], ["Space", t.space], ["Manager", reply.managerInstanceId ?? "not attributed"], ["Native mode", row.graceful ? "graceful" : "hard despawn"], ["Selection", v.self ? "this verified seat only" : "named agent's resolved incarnation"]] }, { kind: "lines", lines: [{ text: "This is the manager's stop result, not an independent process-exit measurement. No other agent was selected and no replacement was launched.", tone: "hint" }] }] },
  ] }));
}

type AgentRow = {
  name: string;
  role?: string;
  agent: string;
  mode: string;
  status: string;
  uptimeMs: number;
  mesh: string;
  joinHealth?: { state: "degraded"; reason: string };
  /** The harness-reported presence condition beside `mesh`; absent when none was reported. */
  condition?: { code: string; source?: string; message?: string; since?: number };
  /** The connector's clause when the seat's startup showed that mesh traffic does not wake it while
   *  idle; absent when it does, or when the manager could not tell. */
  startupNotice?: string;
  /** Epoch ms of the seat's last reported work progress; absent when none was reported. */
  activeAt?: number;
  /** The manager's own presence-view state when it built the row; absent from older managers. */
  meshView?: "current" | "stale" | "unpopulated";
  /** Manager's exact principal + UID comparison for the name-matched presence row. */
  presenceIdentityVerified?: boolean;
  /** Manager snapshot time, only on a current exact-identity presence row. */
  presenceObservedAt?: number;
  /** Epoch ms of the seat's last heartbeat, only beside an `offline` verdict; absent from older managers. */
  offlineSince?: number;
  authHealth?: string;
  authReason?: string;
  // #651 enrichment: present only when the manager recorded the fact (absent is real state:
  // no model pin; a runtime that owns no real process has no pid).
  model?: string;
  variant?: string;
  provider?: string;
  cwd?: string;
  pid?: number;
  spawner?: string;
  instanceId?: string;
  host?: string;
  /** A `--resume` seat's fork provenance (#1500); title and hash once the seat has recorded them. */
  resume?: { source: string; title?: string; transcriptSha256?: string; host?: string; transferredAt?: string };
  lifecycleUid: string;
  id: string;
};

/** The named status contract separates process, presence and work observations. A missing
 * manager field is null, never inferred from a process handle or an old heartbeat. */
function agentStatusProjection(row: AgentRow, managerInstanceId: string | null) {
  const principal = row.id.split(".");
  const owner = principal.length === 1 ? DEV_OWNER : principal.length === 2 && principal[0] ? principal[0] : null;
  const actor = principal.length === 1 ? principal[0] || null : principal.length === 2 && principal[1] ? principal[1] : null;
  const viewCurrent = row.meshView === undefined || row.meshView === "current";
  const exactPresence = viewCurrent && row.presenceIdentityVerified === true;
  const reportedAt = typeof row.activeAt === "number" && Number.isFinite(row.activeAt) && Math.abs(row.activeAt) <= 8.64e15
    ? new Date(row.activeAt).toISOString() : null;
  const observedAt = exactPresence && typeof row.presenceObservedAt === "number" && Number.isSafeInteger(row.presenceObservedAt) && row.presenceObservedAt >= 0 && row.presenceObservedAt <= 8.64e15
    ? new Date(row.presenceObservedAt).toISOString() : null;
  const since = row.condition?.since;
  const conditionSince = typeof since === "number" && Number.isSafeInteger(since) && since >= 0 && since <= 8.64e15
    ? new Date(since).toISOString() : null;
  return {
    identity: { name: row.name, owner, actor, lifecycleUid: row.lifecycleUid || null, source: "manager-ps" },
    execution: { managerInstanceId, host: row.host ?? null, harness: row.agent, model: row.model ?? null,
      runtime: row.mode, pid: typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0 ? row.pid : null, processState: row.status, source: "manager-ps" },
    mesh: { presenceState: exactPresence ? row.mesh : null, observedAt, nameMatchedState: !exactPresence && viewCurrent && row.mesh !== "absent" ? row.mesh : null,
      source: exactPresence ? "manager-ps-exact-principal-lifecycle-current-view" : "manager-ps-name-match-not-incarnation-verified" },
    activity: { state: exactPresence && ["idle", "working", "waiting"].includes(row.mesh) ? row.mesh : null,
      text: null, reportedAt: exactPresence ? reportedAt : null, nameMatchedWorkEventAt: exactPresence ? null : reportedAt,
      condition: exactPresence ? row.condition ?? null : null, conditionSince: exactPresence ? conditionSince : null,
      nameMatchedCondition: exactPresence ? null : row.condition ?? null,
      source: exactPresence ? "manager-ps-exact-principal-lifecycle-current-view" : "manager-ps-name-match-not-incarnation-verified" },
    details: { role: row.role ?? null, variant: row.variant ?? null, provider: row.provider ?? null,
      providerSource: row.provider ? exactPresence ? "exact-principal-lifecycle" : "name-match-unverified" : null, cwd: row.cwd ?? null,
      uptimeMs: row.uptimeMs, spawner: row.spawner ?? null, presenceView: row.meshView ?? null, presenceIdentityVerified: row.presenceIdentityVerified ?? null,
      presenceObservedAt: row.presenceObservedAt ?? null, offlineSince: row.offlineSince ?? null,
      authHealth: row.authHealth ?? null, authReason: row.authReason ?? null, joinHealth: row.joinHealth ?? null, resume: row.resume ?? null },
  };
}

/** A seat's compact runtime identity. Model is provenance, not a debugging detail, so it belongs
 *  beside the connector in the default row. `variant` is the requested override the manager
 *  recorded: when no override was requested it stays absent rather than inventing an effective
 *  provider default Cotal cannot observe. */
export function agentIdentity(r: Pick<AgentRow, "agent" | "model" | "variant" | "mode">): string {
  const parts = [r.agent];
  if (r.model) parts.push(`${r.model}${r.variant ? ` (${r.variant})` : ""}`);
  else if (r.variant) parts.push(`variant ${r.variant}`);
  parts.push(r.mode);
  return parts.join(" · ");
}

/** Compact process age for a row: `12s`, `47m`, `3.5h`, `2d 7h`. */
function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = s / 3600;
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${Math.floor(h - d * 24)}h`;
}

/** Resolve a targeted verb's manager and retain the presence-selected seat for its fresh caller. */
async function pinForTarget(v: FlagValues<typeof stopFlags>, verb: string): Promise<ManagerPin> {
  const on = await managerPin(v, verb);
  if (on !== undefined) return { instanceId: on };
  const loc = await locateSeat(cliControl, v, String(v.name));
  if (loc.kind === "pin") return { instanceId: loc.instanceId, expectedSeat: loc.expectedSeat };
  if (loc.kind === "unpinned") return {};
  // Refused before anything is sent, as `ps` refuses, rather than after a describe no manager can answer.
  if (loc.kind === "no-manager") {
    recordOperationSpace(loc.space);
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `no manager is running for this space to reach agent "${oneLine(String(v.name))}"`, { target: { space: loc.space, managerInstanceId: null, agent: String(v.name) }, native: loc.native, remedy: "start the stack's manager with bare `cotal up`; a stack started with --no-manager has none" });
  }
  // Refused before anything is sent, as the same miss with `--on` refuses: a whole space that answered
  // proves the name absent; one that did not cannot say where it is. A name held on several managers,
  // or found on none that answered, is a choice among those managers only, which a terminal is asked.
  if (loc.space !== undefined) recordOperationSpace(loc.space);
  const agent = String(v.name), message = seatMissRefusal(agent, verb, loc);
  if (loc.kind === "absent")
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", message, { target: { space: loc.space ?? null, agent, managerInstanceIds: loc.instances }, remedy: "run `cotal ps` to see the agents each manager runs" });
  const shown = oneLine(agent);
  if (loc.kind === "several")
    throw new AgentManagerUnsettled(`"${shown}" is held on each of these ${loc.instances.length} managers. Which one should run this?`, managersByInstance(loc.instances, loc.managers), "TARGET_AMBIGUOUS", message, { space: loc.space ?? null, agent, managerInstanceIds: loc.instances });
  const unanswered = [...loc.silent, ...loc.refused.map((r) => r.instanceId)];
  const question = loc.answered ? `"${shown}" was not found on the ${loc.answered === 1 ? "manager" : `${loc.answered} managers`} that answered. Which manager that did not answer should run this?` : `None of your managers answered for "${shown}". Which one should run this?`;
  throw new AgentManagerUnsettled(question, managersByInstance(unanswered, loc.managers), "TARGET_UNAVAILABLE", message, { space: loc.space ?? null, agent, answered: loc.answered, silent: loc.silent, refused: loc.refused });
}

/**
 * What one SILENT manager instance's row says. The wording lives here, in the CLI, and not in the
 * scatter that produced the fact: core reports a frozen slot that did not answer, and turning that
 * into a sentence for an operator is a rendering decision.
 *
 * "unreachable" was the old word for all four of these, and it was a network verdict this client
 * never held. What it actually knows is narrower and more useful — whether it ASKED the broker
 * about the instance, and what the broker said:
 *
 *  - `gone`: the broker itself reports nothing subscribed on that instance's rail. The registration
 *    outlived its host, which never happens on its own and never heals on its own, so the row names
 *    the verb that removes it.
 *  - `unknown`: asked, nothing came back. "Alive but slow" and "wedged" are the same observation,
 *    and neither is death — so this row still says only what happened.
 *  - `not-probed` / `probe-refused`: this command could not ask. That is a fact about the command,
 *    not the instance, and saying so is what keeps a local gap from reading as a remote fault.
 */
function silentManager(liveness: ScatterInstanceLiveness | undefined, instanceId: string, mode?: string): { state: Styled; remedy?: string } {
  // Static roots remove locally. User-auth removal is decided by the governing auth service.
  if (liveness === "gone")
    return {
      state: { text: "registration is stale (the broker reports nothing subscribed on its rail; its host is gone and never deregistered)", tone: "failed" },
      remedy: mode === "auth"
        ? `remove the record from this space's own root: \`cotal endpoint deregister manager ${instanceId} --yes\``
        : mode === "user" ? `ask this space's governing auth service to remove your registration: \`cotal endpoint deregister manager ${instanceId} --yes\`; the service requires ownership and broker-confirmed absence`
        : "if its host is still available, start that manager there again and stop it cleanly, as with `cotal service start <name>` then `cotal service stop <name> --yes`; if the host is gone, no supported command removes this record",
    };
  const why =
    liveness === "probe-refused"
      ? " (its liveness could not be probed: the broker refused this command's probe, named above)"
      : liveness === "not-probed"
        ? " (its liveness was not probed: this command holds no probe grant for it)"
        : " (either the host is alive and slow, or it died and its registration was never removed)";
  return { state: { text: `registered, no answer within the deadline${why}`, tone: "failed" } };
}

/** The mesh column of one `ps` row. A verdict needs a fresh observer: when the manager reports its
 *  own presence view as `stale` (its watch went silent past TTL) or `unpopulated` (its watch has not
 *  replayed the bucket yet), `offline` and `absent` describe the manager's watch, not the seat. Print
 *  "mesh unknown" with the reason instead of a liveness word an operator, or a watchdog, would act
 *  on. A row from a manager that predates `meshView` carries no field and renders as before.
 *  An offline verdict says how long it has stood when the row carries `offlineSince` (#1208), so a
 *  seat that dropped a minute ago reads differently from one that dropped two days ago. */
export function meshCell(r: Pick<AgentRow, "mesh" | "meshView" | "condition" | "activeAt" | "offlineSince" | "joinHealth" | "startupNotice">, now = Date.now()): Styled {
  if (r.meshView === "stale") return { text: "mesh unknown (manager's presence view is stale)", tone: "waiting" };
  if (r.meshView === "unpopulated") return { text: "mesh unknown (manager's presence view not yet populated)", tone: "waiting" };
  if (r.joinHealth?.state === "degraded")
    return { text: "join degraded (readiness deadline elapsed)", tone: "failed" };
  // The harness-reported condition and the last work progress ride beside the status, as the roster
  // renders them (#618): a turn that died upstream 40m ago reads `waiting (rate_limit for 40m) ·
  // active 40m ago`, not a bare `waiting`, and a turn that stopped advancing shows the age of its
  // last event.
  const { condition, ages } = presenceFacts(r, now);
  // The manager's word that nothing wakes this seat while idle; `--wide` and `--json` carry the clause.
  const detail = condition + ages + (r.startupNotice ? " · no idle wake" : "");
  if (r.mesh === "absent") return { text: `not in roster${detail}`, tone: "waiting" };
  if (r.mesh === "offline")
    return { text: `${r.offlineSince === undefined ? "mesh offline" : `mesh offline for ${fmtUptime(now - r.offlineSince)}`}${detail}`, tone: "hint" };
  if (r.mesh === "working") return { text: `working · progress unknown${detail}`, tone: "ok" };
  if (r.mesh === "waiting") return { text: `waiting${detail}`, tone: "waiting" };
  return { text: `${r.mesh}${detail}` };
}

/** The process column of one `ps` row, beside the mesh column and never folded into it.
 *
 *  Two facts, shown as two facts. The manager reports the PROCESS (`status` from the runtime handle,
 *  `uptimeMs` from its start) and the MESH presence separately, and they disagree in the common
 *  failure: a seat that is `running` for two days but `offline` on the mesh. Folding them into one
 *  word rendered ten live processes as "offline" and a 57h-old process with no roster entry as
 *  "starting…", both false. `mesh: absent` means exactly "not in the presence roster", so it prints
 *  as that; the process age next to it tells the reader whether it is a fresh start or a seat that
 *  never joined. */
function processCell(r: AgentRow): Styled {
  if (r.status === "running") return { text: `running ${fmtUptime(r.uptimeMs)}`, tone: "ok" };
  if (r.status === "exited") return { text: `exited after ${fmtUptime(r.uptimeMs)}`, tone: "failed" };
  return { text: `${r.status} ${fmtUptime(r.uptimeMs)}`, tone: "waiting" };
}

/** Confirmed failure is red; ambiguity/warning states (unknown/stale) are amber, so the operator
 *  triages "definitely broken" before "might be". */
const authTone = (r: AgentRow): Tone => (r.authHealth === "auth-renewal-failed" ? "failed" : "waiting");

/** Extra operational facts for `--wide`, as label and value. Model and requested variant are already
 *  in the compact identity, so repeating them here would make wide output noisier without adding
 *  provenance. Only fields the manager actually recorded appear; lifecycle uid is required on every
 *  row. */
function wideFields(r: Pick<AgentRow, "provider" | "cwd" | "pid" | "spawner" | "lifecycleUid" | "instanceId" | "host" | "resume" | "startupNotice">): [string, string][] {
  const fields: [string, string][] = [];
  if (r.startupNotice) fields.push(["idle wake", `off: ${r.startupNotice}`]);
  if (r.provider) fields.push(["provider", r.provider]);
  if (r.cwd) fields.push(["cwd", r.cwd]);
  if (r.pid !== undefined) fields.push(["pid", String(r.pid)]);
  if (r.spawner) fields.push(["spawner", r.spawner]);
  fields.push(["uid", r.lifecycleUid]);
  if (r.instanceId) fields.push(["instance", r.instanceId]);
  if (r.host) fields.push(["host", r.host]);
  if (r.resume) {
    const { source, title, transcriptSha256, host, transferredAt } = r.resume;
    fields.push(["forked from", `${host ? `${host}:` : ""}${source}${title ? ` ${JSON.stringify(title)}` : ""}${transcriptSha256 ? ` sha256:${transcriptSha256}` : ""}${transferredAt ? ` carried ${transferredAt}` : ""}`]);
  }
  return fields;
}

/** {@link wideFields} as one line of facts. */
export function agentWideFacts(r: Pick<AgentRow, "provider" | "cwd" | "pid" | "spawner" | "lifecycleUid" | "instanceId" | "host" | "resume" | "startupNotice">): string[] {
  return wideFields(r).map(([label, value]) => `${label} ${value}`);
}

/** The name a ps row shows. A blank seat or presence name is not a label, so the row uses the id. */
export function psSeatLabel(row: { name: string; id: string; role?: string }): string {
  return peerLabel({ name: row.name.trim() ? row.name : row.id, ...(row.role ? { role: row.role } : {}) });
}

/** The Agent, Identity and Manager rows a join receipt shows. A blank name is the id, as `ps` shows it. */
export function joinedAgentRows(agent: { name: string; id: string; managerInstanceId: string }): [string, string][] {
  return [["Agent", psSeatLabel({ name: agent.name, id: agent.id })], ["Identity", agent.id], ["Manager", agent.managerInstanceId]];
}

/** The seats one manager answered with: a table, or with `--wide` one labeled record per seat. A
 *  failing bearer refresh is a detached seat's only window to the operator, so the provider's own
 *  sentence follows, verbatim (it already names the repair). A record's labels read as its facts'
 *  do, and a field the seat leaves empty is left out. */
function seatBlocks(rows: readonly AgentRow[], wide: boolean): Block[] {
  const auth = rows.some((r) => r.authHealth);
  const cells = (r: AgentRow): [string, Cell][] => [
    ["NAME", psSeatLabel(r)],
    ["AGENT", { text: agentIdentity(r), tone: "hint" }],
    ["PROCESS", processCell(r)],
    ["MESH", meshCell(r)],
    ...(auth ? [["AUTH", r.authHealth ? { text: r.authHealth, tone: authTone(r) } : ""] as [string, Cell]] : []),
  ];
  const blocks: Block[] = wide
    ? rows.flatMap((r, i): Block[] => [...(i ? [{ kind: "lines", lines: [""] } as const] : []), { kind: "fields", rows: [...cells(r).filter(([, value]) => value !== "").map(([label, value]): [string, Cell] => [label.toLowerCase(), value]), ...wideFields(r)] }])
    : [{
        kind: "table",
        columns: cells(rows[0]!).map(([label]) => ({ key: label, label })),
        rows: rows.map((r) => Object.fromEntries(cells(r))),
      }];
  const reasons = rows.filter((r) => r.authHealth && r.authReason).map((r): Cell => ({ text: `${psSeatLabel(r)}: ${r.authReason}`, tone: authTone(r) }));
  if (reasons.length) blocks.push({ kind: "lines", lines: reasons });
  const joins = rows.filter((r) => r.joinHealth).map((r): Cell => ({ text: `${psSeatLabel(r)}: ${r.joinHealth!.reason}`, tone: "failed" }));
  if (joins.length) blocks.push({ kind: "lines", lines: joins });
  return blocks;
}

/** One durable static slot row, the `slots` command's answer (#1274). Unlike `AgentRow` there is
 *  no live/wide split: the row is already the full closed projection. */
type SlotRow = {
  name: string;
  owner: string;
  actor: string;
  slotLifecycleUid: string;
  slotPhase: "provisioning" | "active" | "terminalizing" | "retired";
  cleanupComplete?: boolean;
  slotRevision: number;
  headState?: "active" | "retiring" | "retired";
  headOp?: { opId: string; kind: "retirement" };
  headLifecycleUid?: string;
  headRevision?: number;
  readOrder: ["slot", "head"];
  consistency: "ordered-not-atomic";
  live: boolean;
  managerInstanceId: string;
};

/** `--slots`: one row per slot naming phase, slot uid, cleanup, head and liveness. The read order
 *  and its consistency are the same on every row, so they are stated once. */
function slotBlocks(rows: readonly SlotRow[]): Block[] {
  return [
    {
      kind: "table",
      columns: [
        { key: "name", label: "NAME" },
        { key: "phase", label: "PHASE" },
        { key: "slot", label: "SLOT" },
        { key: "cleanup", label: "CLEANUP COMPLETE" },
        { key: "head", label: "HEAD" },
        { key: "live", label: "LIVE" },
      ],
      rows: rows.map((r) => ({
        name: r.name,
        phase: r.slotPhase,
        slot: r.slotLifecycleUid,
        cleanup: r.cleanupComplete === undefined ? "unknown" : String(r.cleanupComplete),
        head: r.headState === undefined ? "absent" : `${r.headState}${r.headOp ? ` op ${r.headOp.kind}:${r.headOp.opId}` : ""}`,
        live: String(r.live),
      })),
    },
    { kind: "lines", lines: [{ text: `read order slot,head; consistency ${rows[0]!.consistency}`, tone: "hint" }] },
  ];
}

/** What one manager instance answered a `ps` census with. */
export interface ManagerAnswer {
  readonly instanceId: string;
  /** `answered`; `silent` (registered, no answer within the deadline); `refused` (it answered with an
   *  error); `contract-mismatch` (it serves a different `ps` contract, so its rows were not read). */
  readonly state: "answered" | "silent" | "refused" | "contract-mismatch";
  /** What this command established about a silent instance's liveness. */
  readonly liveness?: ScatterInstanceLiveness;
  /** A refusal's own sentence, with the endpoint's code when it carried one. */
  readonly error?: string;
  readonly code?: string;
  /** The host name an answered instance gave in its own status reply, asked within a short shared
   *  bound. What the manager says about itself, shown for reading only: never a route for `--on`. */
  readonly reportedHost?: string;
}

/** What `cotal ps` read: each seat (or, with `--slots`, each static slot) exactly as its manager
 *  returned it, and what each manager instance asked answered. A manager that did not answer is
 *  listed, never dropped, so a short list is not mistaken for a complete one. */
export interface PsResult {
  readonly kind: "seats" | "slots";
  readonly items: readonly unknown[];
  readonly managers: readonly ManagerAnswer[];
}

/** `rowsOf` is each answered instance's rows as the census received them, so a row that names no
 *  instance of its own is still listed under the manager that returned it. `noApplication` is
 *  `status`'s reading that no agent application is set up here, so an empty list's Next agrees with
 *  the one `status` gives. */
function psView(result: PsResult, wide: boolean, rowsOf: ReadonlyMap<string, readonly unknown[]> = new Map(), noApplication = false, mode?: string): Report {
  const empty = result.kind === "slots" ? "No active static slots." : "No managed agents.";
  const blocksFor = (rows: readonly unknown[]): Block[] =>
    !rows.length ? [{ kind: "lines", lines: [{ text: empty, tone: "hint" }] }]
    : result.kind === "slots" ? slotBlocks(rows as SlotRow[])
    : seatBlocks(rows as AgentRow[], wide);
  // A single manager that answered is the common case: a flat list, no per-manager grouping noise.
  // Its instance id is still shown, with or without agents, because it is what `--on` takes.
  if (result.managers.length <= 1 && result.managers.every((m) => m.state === "answered")) return { sections: [
    { title: result.kind === "slots" ? "Static slots" : "Agents", blocks: blocksFor(result.items) },
    ...result.managers.map((m): Section => ({ title: "Manager", blocks: [{ kind: "fields", rows: [["instance", m.instanceId], ...(m.reportedHost ? [["reported host", m.reportedHost] as [string, string]] : [])] }] })),
    { title: "Next", blocks: [{ kind: "commands", items: result.items.length ? [
      { command: `${displayCmd()} attach <name>`, description: "Return to an agent's terminal" },
      { command: `${displayCmd()} stop <name>`, description: "Stop one agent" },
    ] : [noApplication ? { command: `${displayCmd()} setup`, description: "Set up an agent application" } : { command: `${displayCmd()} spawn`, description: "Launch your default agent" }] }] },
  ] };
  // Several managers: one section each, named by the FULL instance id, since `--on` takes nothing
  // shorter and this is precisely where it becomes the one way to address a manager. Silent and
  // refused instances are shown, never dropped.
  return {
    sections: result.managers.map((m): Section => {
      const title = `manager ${m.instanceId}${m.reportedHost ? ` · reports host ${m.reportedHost}` : ""}`;
      if (m.state === "silent") {
        const silent = silentManager(m.liveness, m.instanceId, mode);
        return { title, blocks: [{ kind: "lines", lines: [silent.state, ...(silent.remedy ? [{ text: `↳ ${silent.remedy}`, tone: "hint" } as const] : [])] }] };
      }
      if (m.state === "contract-mismatch") return { title, blocks: [{ kind: "lines", lines: [{ text: "contract mismatch; seats not listed", tone: "failed" }] }] };
      if (m.state === "refused") return { title, blocks: [{ kind: "lines", lines: [{ text: `list refused: ${m.error}`, tone: "failed" }] }] };
      const rows = rowsOf.get(m.instanceId) ?? [];
      const count = rows.length ? `${rows.length} ${result.kind === "slots" ? "slot" : "agent"}${rows.length === 1 ? "" : "s"}` : `no ${result.kind === "slots" ? "slots" : "agents"}`;
      return { title, blocks: [{ kind: "lines", lines: [{ text: count, tone: "hint" }] }, ...(rows.length ? blocksFor(rows) : [])] };
    }),
  };
}

/** Whether no connector is installed here, as `status` reports "Agent applications: not set up".
 *  An inventory that cannot be read says nothing, so the Next stays the launch. */
function noApplicationHere(): boolean {
  try { return connectorHarnesses().length === 0; } catch { return false; }
}

export async function ps(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof psFlags>;
  // #651 presentations: --wide is a human layout and --json the document that already carries every
  // field, so the pair asks one question two ways; inventing a precedence would be a silent
  // fallback, so refuse instead.
  const presentation = presentationOf(v);
  const wide = v.wide === true;
  const slots = v.slots === true;
  if (wide && presentation === "json")
    throw new CommandFailure("refused", "USAGE_INVALID", "--wide and --json are mutually exclusive: --wide is the human layout, --json the document with every field", { remedy: "drop --wide; --json already carries every field the manager recorded" });
  if (slots && wide)
    throw new CommandFailure("refused", "USAGE_INVALID", "--slots and --wide are mutually exclusive: --slots lists durable static slot rows, --wide the live seat facts", { remedy: "pass one of them" });
  const command = slots ? "slots" : "ps";
  const kind = slots ? "slots" : "seats";
  const on = await managerPin(v, "cotal ps");
  let census: SeatCensus;
  try {
    census = await readSeats(v, command, on);
  } catch (e) {
    // On a user-auth mesh where no manager of yours answers, or none is live, your agents are read
    // from presence instead. Static slots are a manager's own records, so `--slots` keeps the refusal.
    const failure = isCommandFailure(e) ? e : isConnectRefusal(e) ? e.failure() : undefined;
    if (slots || on !== undefined || !failure || !(failure instanceof NoManagerAnswered || noLiveManager(failure))) throw e;
    return psFromPresence(v, presentation);
  }
  const view = (result: PsResult): Report => psView(result, wide, census.rowsOf, !result.items.length && noApplicationHere(), census.mode);
  writeResult(
    presentation,
    {
      command: "ps",
      target: census.target,
      result: { kind, items: census.items, managers: census.managers },
      completeness: census.partial ? "partial" : "complete",
      warnings: census.warnings,
      ...(census.partial ? { partial: census.partial } : {}),
    },
    view,
  );
}

/** `ps` on a user-auth mesh where no manager of yours answers: your agents as presence shows them,
 *  read-only. A manager stops, attaches and types into them, so the Next starts one. */
async function psFromPresence(v: FlagValues<typeof psFlags>, presentation: ReturnType<typeof presentationOf>): Promise<void> {
  const { ep, space, connection } = await openTransient(v, "ps", { throwOnRefusal: true, report: () => {} });
  let roster: Presence[];
  try { roster = ep.getRoster(); } finally { await ep.stop().catch(() => {}); }
  recordOperationSpace(space);
  const owner = connection.epCaller?.owner;
  const meta = (p: Presence, key: string): string | null => typeof p.card.meta?.[key] === "string" && p.card.meta[key] ? p.card.meta[key] as string : null;
  const items = roster
    .filter((p) => p.card.kind !== "endpoint" && (owner === undefined || p.card.id.startsWith(`${owner}.`)))
    .map((p) => ({ name: p.card.name, id: p.card.id, status: p.status, activity: p.activity ?? null, harness: meta(p, "connector"), host: meta(p, "host") }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const next = startManagerNext(connection.root, space, v.space !== undefined);
  writeResult(presentation, { command: "ps", target: { space, scope: "presence" }, result: { kind: "presence", items, managers: [] } }, (result): Report => ({ sections: [
    { title: "Agents on the mesh", blocks: [
      { kind: "lines", lines: [{ text: "No manager answered, so these are your agents as presence shows them. Stopping or attaching one needs a manager.", tone: "waiting" }] },
      result.items.length
        ? { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "status", label: "State" }, { key: "harness", label: "Application" }, { key: "host", label: "Host" }],
            rows: result.items.map((row) => ({ name: psSeatLabel(row), status: row.status, harness: row.harness ?? "-", host: row.host ?? "-" })) }
        : { kind: "lines", lines: [{ text: "No agents of yours are on the mesh.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [next] }] },
  ] }));
}

/** What gets `space` a manager that answers. On the root whose `cotal up` started the space, as `ps`
 *  refuses for a static stack: waiting for the `up` that is starting its manager, ending the stack
 *  manager that does not answer, or bare `cotal up`. Anywhere else, `cotal manager start`. */
function startManagerNext(root: string | undefined, space: string, named: boolean): { command: string; description: string } {
  const at = named ? ` --space ${space}` : "";
  if (root !== undefined && stackManagerStarting(root, space)) return { command: `cotal ps${at}`, description: "List again once `cotal up` reports the manager started" };
  const pid = root === undefined ? undefined : runningStackManagerPid(root, space);
  if (pid !== undefined) return { command: `kill -KILL ${pid}`, description: "End the stack manager that does not answer; bare `cotal up` then starts it again" };
  const entry = findMesh(space);
  if (root !== undefined && (stackManagerAbsent(root, space) || (entry?.origin === "up" && entry.root === root))) return { command: "cotal up", description: "Start the stack's manager" };
  return { command: `cotal manager start${at}`, description: "Start a manager for this space" };
}

/** Read one named seat from its presence-selected owner. User-auth keeps its authorized census. */
async function readNamedSeat(values: FlagValues<typeof psFlags>, name: string): Promise<SeatCensus> {
  const on = await managerPin(values, "cotal status");
  if (name === "manager" || (await connectOrThrow(values, "observer", { readOnly: true })).mode === "user")
    return readSeats(values, "ps", on);
  const pin = on === undefined ? await pinForTarget({ ...values, name } as never, "cotal status") : { instanceId: on };
  const t = await resolveControlTarget(values, "control-caller-privileged", pin.instanceId, { onRefusal: "throw" });
  recordOperationSpace(t.space);
  const target = { space: t.space, scope: "agent", managerInstanceId: pin.instanceId ?? null };
  const reply = await askManager(cliControl, t.space, t.server, "status", { name }, t.auth, "any", undefined, pin);
  if (!reply.ok) throw readFailure(reply, target);
  const instanceId = reply.managerInstanceId ?? pin.instanceId;
  if (!instanceId) throw new CommandFailure("failed", "OPERATION_FAILED", "the manager did not attribute its named agent read", { target });
  return { target: { ...target, managerInstanceId: instanceId }, items: [reply.data], managers: [{ instanceId, state: "answered" }], warnings: [], rowsOf: new Map([[instanceId, [reply.data]]]) };
}

/** A named-agent detail uses its holding manager's inspect read and checks the selected lifecycle. */
export async function agentStatus(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0]!;
  const values = args.values as FlagValues<typeof psFlags>;
  const census = await readNamedSeat(values, name);
  const rows = census.items.map((value): AgentRow => {
    if (!value || typeof value !== "object") throw new CommandFailure("failed", "OPERATION_FAILED", "a manager returned an invalid agent record", { target: census.target });
    const row = value as Partial<AgentRow>;
    if (typeof row.name !== "string" || typeof row.id !== "string" || typeof row.agent !== "string" || typeof row.mode !== "string" || typeof row.status !== "string" || typeof row.mesh !== "string" || typeof row.uptimeMs !== "number" || !Number.isFinite(row.uptimeMs))
      throw new CommandFailure("failed", "OPERATION_FAILED", "a manager returned an incomplete agent record", { target: census.target });
    return value as AgentRow;
  });
  const matches = census.target.scope === "agent" ? rows : rows.filter((row) => row.name === name || row.id === name);
  if (matches.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "more than one manager reports this agent; select a manager with --on", { target: { ...census.target, name, candidates: matches.map((row) => ({ name: row.name, id: row.id, instanceId: row.instanceId ?? null })) } });
  // `manager` and an answering manager's instance id name the manager itself, which runs no row of
  // its own, so the refusal says where its state is read.
  const managerItself = name === "manager" || census.managers.some((manager) => manager.state === "answered" && manager.instanceId === name);
  if (!matches.length && !census.partial) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the answering managers report no agent with that name or identity", { target: { ...census.target, name }, ...(managerItself ? { remedy: `${name} is this space's manager, which is answering, not an agent it runs; \`cotal status\` shows the manager's state, and \`cotal endpoint describe manager\` reads its commands` } : {}) });
  const item = matches[0] ?? null;
  const managerInstanceId = item ? [...census.rowsOf].find(([, rows]) => rows.includes(item))?.[0] ?? census.target.managerInstanceId ?? item.instanceId ?? null : null;
  let managerHint = "";
  if (managerInstanceId) {
    try { managerHint = ` --on ${assertLifecycleToken(managerInstanceId, "instanceId")}`; }
    catch { managerHint = " --on <manager-instance>"; }
  }
  const projected = item ? agentStatusProjection(item, managerInstanceId) : { identity: null, execution: null, mesh: null, activity: null, details: null };
  writeResult(presentationOf(values), {
    command: "status",
    target: { ...census.target, name },
    result: { kind: "agent", ...projected, managers: census.managers },
    completeness: census.partial ? "partial" : "complete",
    warnings: census.warnings,
    ...(census.partial ? { partial: census.partial } : {}),
  }, (result) => {
    const row = item;
    if (!row || !result.identity || !result.execution || !result.mesh || !result.activity || !result.details) return { sections: [
      { title: "Agent could not be located", blocks: [{ kind: "lines", lines: [{ text: "Some managers did not answer. This does not establish that the agent is gone.", tone: "waiting" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal ps", description: "See the responding and unavailable managers" }, { command: "cotal status <agent> --on <manager-instance>", description: "Address a known manager directly" }] }] },
    ] };
    const identity = result.identity, execution = result.execution, mesh = result.mesh, activity = result.activity;
    const credential: [string, Cell][] = row.authHealth ? [["Credential", { text: row.authHealth, tone: authTone(row) }]] : [];
    return { sections: [
      { title: "Identity", blocks: [
        ...(census.partial ? [{ kind: "lines" as const, lines: [{ text: "Other managers did not answer. This is one known match, not a complete uniqueness check.", tone: "waiting" as const }] }] : []),
        { kind: "fields", rows: [["Agent", psSeatLabel({ name: identity.name, id: row.id })], ["Space", census.target.space], ["Principal", row.id], ["Owner", identity.owner ?? "not established"], ["Actor", identity.actor ?? "not established"], ["Lifecycle", identity.lifecycleUid ?? "not reported"], ["Role", result.details.role ?? "not reported"]] },
      ] },
      { title: "Execution", blocks: [
        { kind: "fields", rows: [["Process", processCell(row)], ["Application", execution.harness], ["Model", execution.model ? `${execution.model} · requested, not provider-confirmed` : "not reported"], ["Variant", result.details.variant ?? "not reported"], ["Reported provider", result.details.providerSource === "exact-principal-lifecycle" ? result.details.provider ?? "not reported" : "not established"], ["Name-matched provider", result.details.providerSource === "name-match-unverified" ? result.details.provider ?? "not reported" : "none"], ["Runtime", execution.runtime], ["PID", execution.pid === null ? "not reported" : String(execution.pid)], ["Host", execution.host ?? "not reported"], ["Folder", result.details.cwd ?? "not reported"], ["Manager", execution.managerInstanceId ?? "not reported"], ...credential] },
        ...(row.authReason ? [{ kind: "lines" as const, lines: [{ text: row.authReason, tone: authTone(row) }] }] : []),
      ] },
      { title: "Mesh", blocks: [
        { kind: "fields", rows: [["Exact presence", mesh.presenceState ?? "not established"], ["Connection", mesh.presenceState === null ? "not attributable to this lifecycle" : meshCell(row)], ["Name-matched roster", mesh.nameMatchedState === null ? "none separate" : meshCell(row)], ["Observed at", mesh.observedAt ?? "not reported"], ["Presence view", result.details.presenceView ?? "not reported"]] },
        ...(mesh.presenceState === null ? [{ kind: "lines" as const, lines: [{ text: "This manager has not established a current roster record for the agent's exact principal and lifecycle UID. A matching name alone is not proof.", tone: "waiting" as const }] }] : []),
      ] },
      { title: "Last reported activity", blocks: [
        { kind: "fields", rows: [["State", activity.state ?? "not established"], ["Text", "not reported"], ["Condition", activity.condition?.code ?? "not established"], ["Condition since", activity.conditionSince ?? "not reported"], ["Work event", activity.reportedAt ?? "not reported"], ["Unverified name-match condition", activity.nameMatchedCondition?.code ?? "none"], ["Unverified name-match event", activity.nameMatchedWorkEventAt ?? "none"]] },
        { kind: "lines", lines: [{ text: "A work event is not task completion or a measured blocked duration. A name-match without the manager's exact-identity proof is not this agent's activity.", tone: "hint" }] },
      ] },
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal attach <agent>${managerHint}`, description: managerHint ? "Return to its terminal through this manager" : "Return to its terminal" }, { command: `cotal stop <agent>${managerHint}`, description: managerHint ? "Stop the named agent through this manager" : "Stop the named agent" }] }] },
    ] };
  });
}

/** One census of the managed seats (or, for `slots`, the static slots): each answered manager
 *  instance's rows as it returned them, every instance's answer, a warning for each one that did not
 *  return its rows, and the partial notice when any did not. */
export interface SeatCensus {
  readonly target: { space: string; scope: string; managerInstanceId?: string | null };
  readonly items: unknown[];
  readonly managers: ManagerAnswer[];
  readonly warnings: OutputWarning[];
  readonly rowsOf: Map<string, unknown[]>;
  readonly partial?: { message: string; remedy: string };
  /** The space's mode, which decides how a stale registration is removed. */
  readonly mode?: string;
}

/** Read the managed seats the way `ps` lists them: from one manager when `on` pins it or the caller
 *  holds a user bearer, from each of your live managers when a user-auth mesh has several and none
 *  is named, otherwise from every registered instance. Throws the classified failure when the target
 *  cannot be resolved or no manager can be asked, and {@link NoManagerAnswered} when none of your
 *  managers answered on a user-auth mesh. */
export async function readSeats(v: ConnectFlags, command: "ps" | "slots", on: string | undefined): Promise<SeatCensus> {
  // `--on` must reach the MINT, not just the invoke: the one-shot instrument is issued during
  // this resolve, and a credential cannot gain an instance rail after it is minted.
  let t: Awaited<ReturnType<typeof resolveControlTarget>>;
  try {
    t = await resolveControlTarget(v, "control-caller-privileged", on, { onRefusal: "throw" });
  } catch (e) {
    // The exchange refused to pick one of your several live managers and named them, so each is
    // read. That is the whole set it counts, not a fallback after a failed read.
    const managers = on === undefined ? await refusedManagers(cliControl, e, v) : undefined;
    if (!managers) throw e;
    return readYourManagers(v, command, managers);
  }
  recordOperationSpace(t.space);
  // A pin the registry does not list is refused at once, as spawn refuses it; only a registered manager is waited on.
  if (on !== undefined && !t.auth.bearer) await refuseUnregisteredManager(t.space, t.server, t.auth, on);

  // One manager instance: `--on <instance>` pins ps to its `inst` route on a multi-manager mesh,
  // and in USER MODE (bearer present) the borrowed manager view pins one authorized instance and
  // keeps the actor's existing command scopes. That view has no registry freeze rows and never
  // scatters; the manager answers from its in-memory roster with an owner filter, which is not a
  // complete multi-manager inventory (see docs/cli.mdx), and the target says so.
  //
  // Mode chosen UP FRONT from the connection shape. Never try-scatter-catch-degrade: a silent
  // downgrade is the bug this branch fixes, and reintroducing it in the fix would be the whole
  // night in miniature.
  if (on !== undefined || t.auth.bearer) {
    const instanceId = on ?? t.auth.managerInstanceId;
    const target = { space: t.space, scope: "manager", managerInstanceId: instanceId ?? null };
    const reply = await askManager(cliControl, t.space, t.server, command, undefined, t.auth, "owner", undefined, on !== undefined ? { instanceId: on } : {});
    if (!reply.ok) {
      // The one manager the exchange picked for you did not answer, so none of yours did.
      if (t.auth.bearer && on === undefined && reply.unanswered) throw new NoManagerAnswered(readFailure(reply, target));
      throw managerReadFailure(reply, target, command, t.auth.bearer !== undefined);
    }
    const items = (reply.data as unknown[]) ?? [];
    return { target, items, managers: instanceId ? [{ instanceId, state: "answered" }] : [], warnings: [], rowsOf: new Map() };
  }

  // STATIC/OPEN (no bearer): class scatter. The operator instrument (or bare open connect) holds the
  // freeze rows; every registered instance is attributed, and a non-answering one is labeled with
  // what this command established about it (pin 3).
  const target = { space: t.space, scope: "all-managers" };
  const scatter = await scatterManager(cliControl, t.space, t.server, command, t.auth, t.spaceAuth, undefined, { reportHosts: true });
  // An empty manager registry on this root's own controller stack, whose manager does not run, is
  // a known boundary with a remedy; the registry's own failure stays the cause. So is a registry
  // that still lists that manager after its process died: no manager answered the read. While an
  // `up` is still starting that manager, the answer is to wait for it, not to start another.
  if (!scatter.ok && (scatter.code === "failed-precondition" || scatter.unanswered === true) && t.root !== undefined) {
    const native = { code: scatter.code, ...(scatter.error ? { detail: scatter.error } : {}) };
    if (stackManagerStarting(t.root, t.space))
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the stack's manager is starting, so it has no managed agents to list yet", { target, native, remedy: "run `cotal ps` again once `cotal up` reports the manager started" });
    if (stackManagerAbsent(t.root, t.space))
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "no manager is running for this space, so it has no managed agents to list", { target, native, remedy: startStackManagerRemedy(t) });
  }
  const silentPid = !scatter.ok && scatter.unanswered === true && t.root !== undefined ? runningStackManagerPid(t.root, t.space) : undefined;
  if (!scatter.ok && silentPid !== undefined)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `this space's stack manager (pid ${silentPid}) is running but did not answer, so no agents were listed`, { target, native: { code: scatter.code, ...(scatter.error ? { detail: scatter.error } : {}) }, remedy: `if it stays unresponsive, end that process with kill -KILL ${silentPid}; then bare \`cotal up\` starts the manager again` });
  // Anywhere else, a registry that was read and lists no live manager is the same boundary: no
  // manager was asked. It is not proof that no manager process runs, since one that is starting or
  // cannot register is not listed, so the refusal says only what the registry showed.
  if (!scatter.ok && scatter.noLiveManager)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "no manager is registered for this space, so none was asked and nothing was listed. A manager that is still starting or cannot register has no registration either, so this does not show that no manager process runs", { target, native: { code: scatter.code, ...(scatter.error ? { detail: scatter.error } : {}) }, remedy: startStackManagerRemedy(t) });
  if (!scatter.ok) throw readFailure(scatter, target);
  return seatCensus(target, scatter.instances, command, t.mode);
}

/** The step that starts the space's manager when `ps` found none. Bare `cotal up` starts it only in
 *  the root of this machine's own stack, so the step names that root when the target is that stack's
 *  registration at the broker it records. A space this machine only registered, one it records no
 *  stack for, or one read at another broker runs where this machine cannot say, and a `cotal up` in
 *  the caller's folder would not start its manager, so that step names no local command. */
function startStackManagerRemedy(t: { space: string; server: string; root?: string }): string {
  const root = localStackRoot(t.space);
  return root !== undefined && root === t.root && findMesh(t.space)?.server === t.server
    ? `start the stack's manager with bare \`cotal up\` in ${root}; a stack started with --no-manager has none`
    : "start this space's manager where its stack runs; a stack started with --no-manager has none";
}

/** A census from the slots of a scatter: each answered instance's rows as it returned them, every
 *  instance's answer, a warning for each one that did not return its rows, and the partial notice
 *  when any did not. */
function seatCensus(target: SeatCensus["target"], slots: readonly ScatterInstanceReply[], command: "ps" | "slots", mode: string | undefined): SeatCensus {
  // Stable ordering: reachable instances first, then by instance id.
  const instances = [...slots].sort(
    (a, b) => Number(b.reachable) - Number(a.reachable) || a.instanceId.localeCompare(b.instanceId),
  );
  const items: unknown[] = [];
  const managers: ManagerAnswer[] = [];
  const warnings: OutputWarning[] = [];
  const mismatches: string[] = [];
  const rowsOf = new Map<string, unknown[]>();
  for (const inst of instances) {
    const at = { space: target.space, managerInstanceId: inst.instanceId };
    if (!inst.reachable) {
      // Not "unreachable": the client holds no network verdict. What it knows is which question it
      // asked about this instance and what came back, which is narrower and more useful. The four
      // cases and their wording are `silentManager`.
      managers.push({ instanceId: inst.instanceId, state: "silent", ...(inst.liveness ? { liveness: inst.liveness } : {}) });
      warnings.push({ code: "MANAGER_SILENT", target: at, message: `manager ${inst.instanceId}: ${silentManager(inst.liveness, inst.instanceId).state.text}` });
      continue;
    }
    if (inst.error) {
      const mismatch = /^pinned digests (sha256:[a-f0-9]{64})\/(sha256:[a-f0-9]{64}) do not match the served contract (sha256:[a-f0-9]{64})\/(sha256:[a-f0-9]{64});/.exec(inst.error);
      const code = inst.code === undefined ? {} : { code: inst.code };
      if (mismatch) {
        managers.push({ instanceId: inst.instanceId, state: "contract-mismatch", error: inst.error, ...code });
        mismatches.push(`manager ${inst.instanceId}: requested input/output ${mismatch[1]} / ${mismatch[2]}; served input/output ${mismatch[3]} / ${mismatch[4]}`);
        warnings.push({ code: "MANAGER_CONTRACT_MISMATCH", target: at, message: `manager ${inst.instanceId} serves a different ps contract; its seats were not listed` });
      } else {
        managers.push({ instanceId: inst.instanceId, state: "refused", error: inst.error, ...code });
        warnings.push({ code: "MANAGER_REFUSED", target: at, message: `manager ${inst.instanceId} refused the list: ${inst.error}` });
      }
      continue;
    }
    const rows = (inst.data as unknown[]) ?? [];
    managers.push({ instanceId: inst.instanceId, state: "answered", ...(inst.reportedHost ? { reportedHost: inst.reportedHost } : {}) });
    rowsOf.set(inst.instanceId, rows);
    items.push(...rows);
  }
  const unread = managers.filter((m) => m.state !== "answered").length;
  const silent = managers.filter((m) => m.state === "silent").map((m) => m.instanceId);
  const kind = command === "slots" ? "slots" : "seats";
  const partial = unread
    ? {
        message: `Incomplete manager census: ${unread} of ${managers.length} instances did not return ${kind}. Rows above are partial, not a complete list.`,
        remedy: mismatches.length
          ? `Managers in this space serve different ps contracts. ${mismatches.join("; ")}. Align the manager versions and retry.`
          : target.scope === "your-managers" && silent.length
            ? silentManagersNext(silent, target.space)
            : "retry, or read one manager with `cotal ps --on <instance>`",
      }
    : undefined;
  return { target, items, managers, warnings, rowsOf, mode, ...(partial ? { partial } : {}) };
}

/** The Next for your managers that did not answer on a user-auth mesh, each by instance id. */
function silentManagersNext(instanceIds: readonly string[], space: string): string {
  const one = instanceIds.length === 1;
  return `${one ? "manager" : "managers"} ${instanceIds.join(", ")} did not answer. If ${one ? "it is" : "one is"} still running, retry. For a computer that is gone, ask the governing auth service to remove your registration: ${instanceIds.map(id => `\`cotal endpoint deregister manager ${id} --space ${space} --yes\``).join("; ")}. The service must support guarded removal and affirm the instance rail empty; an older hosted authority must add that operation`;
}

/** None of your managers answered a read on a user-auth mesh: the one the exchange picked, or each of
 *  the several it counts live. `ps` then lists your agents as presence shows them. */
export class NoManagerAnswered extends CommandFailure {
  constructor(cause: CommandFailure) {
    super("refused", "TARGET_UNAVAILABLE", "none of your managers in this space answered", {
      target: cause.target,
      remedy: "start a manager for this space with `cotal manager start`",
      ...(cause.native ? { native: cause.native } : {}),
      cause,
    });
  }
}

/** {@link readSeats} on a user-auth mesh with several of your managers live and none named. */
async function readYourManagers(v: ConnectFlags, command: "ps" | "slots", managers: readonly ManagerCandidate[]): Promise<SeatCensus> {
  const { space, mode, instances } = await askYourManagers(cliControl, v, command, managers);
  if (space !== undefined) recordOperationSpace(space);
  if (space === undefined || !instances.some((i) => i.reachable))
    throw new NoManagerAnswered(new CommandFailure("refused", "TARGET_UNAVAILABLE", `none of the ${managers.length} managers the exchange counts live answered`, { target: { space: space ?? null, scope: "your-managers" } }));
  return seatCensus({ space, scope: "your-managers" }, instances, command, mode);
}

/** The remedy for a seat whose runtime streams no terminal, naming what does reach it in this
 *  CLI's own commands. */
function noTerminalRemedy({ space, name }: { space: string; name: string }): string {
  return `nothing was attached and the agent was not touched; follow the runtime's own guidance above, or reach the seat over the mesh with ${codeSpan(`${displayCmd()} send -t ${shellWord(name)} "<message>"`)} and ${codeSpan(`${displayCmd()} watch --space ${shellWord(space)}`)}`;
}

/**
 * The attach `cotal attach`, the console and spawn-then-attach run: the shared attach from
 * `@cotal-ai/workspace/attach`, with this CLI's control client, verb and remedy. On the command path
 * (`exit`) with no pin given, the seat is located here first, before the detach key is read and the
 * terminal is held, because that step prints and exits in the CLI's words.
 */
export async function attachSeat(
  v: AttachTarget,
  opts: { reconnect: boolean; onRefusal: "exit" | "throw"; on?: string },
): Promise<AttachVerdict> {
  const pin = opts.on === undefined && opts.onRefusal === "exit" ? await pinForTarget(v as never, "cotal attach") : { instanceId: opts.on };
  return attachSeatWith({ ...v, expectedSeat: pin.expectedSeat ?? v.expectedSeat }, { ...opts, on: pin.instanceId, control: cliControl, verb: "cotal attach", noTerminalRemedy });
}

async function pickAttach(values: FlagValues<typeof attachFlags>): Promise<{ name: string; on: string; expectedTarget: NonNullable<ManagerPin["expectedTarget"]> } | undefined> {
  const census = await readSeats(values, "ps", await managerPin(values, "cotal attach"));
  const choices = census.items.map((value) => {
    const row = value as Partial<AgentRow> | null;
    if (!row || typeof row.name !== "string" || typeof row.id !== "string" || typeof row.lifecycleUid !== "string")
      throw new CommandFailure("refused", "UNSUPPORTED", "a manager did not report the identity needed for a safe attach selection", { remedy: "align the manager versions before using the picker", target: census.target });
    const on = [...census.rowsOf].find(([, rows]) => rows.includes(value))?.[0] ?? census.target.managerInstanceId;
    if (!on) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the agent's manager instance was not established", { target: census.target });
    return { name: row.name, on, expectedTarget: { id: row.id, lifecycleUid: row.lifecycleUid }, status: typeof row.status === "string" ? row.status : "not reported" };
  });
  if (census.partial) console.error(renderReport({ space: census.target.space, sections: [{ title: "Agent list is partial", blocks: [{ kind: "lines", lines: [{ text: census.partial.message, tone: "waiting" }] }] }] }, "rich", process.stderr));
  if (!choices.length) throw new CommandFailure("refused", census.partial ? "TARGET_UNAVAILABLE" : "TARGET_NOT_FOUND", census.partial ? "no attachable agent was returned; some managers did not answer" : "the answering managers report no agents to attach", { target: census.target, remedy: "run `cotal ps`, or launch an agent with `cotal spawn`" });
  const choice = await prompts.select({
    message: `Return to an agent in ${oneLine(census.target.space)}`,
    options: choices.map((item, index) => ({ value: index, label: oneLine(`${item.name} · ${item.status}`), hint: oneLine(`${item.expectedTarget.id} · manager ${item.on}`) })),
  });
  if (prompts.isCancel(choice)) return undefined;
  const selected = choices[choice]!;
  console.error(renderReport({ space: census.target.space, sections: [{ title: "Attaching", blocks: [{ kind: "fields", rows: [["Agent", selected.name], ["Identity", selected.expectedTarget.id], ["Manager", selected.on], ["Detach", `${detachKey().label} leaves the agent running`]] }] }] }, "rich", process.stderr));
  return selected;
}

export async function attach(args: ParsedArgs): Promise<void> {
  const name = managedTarget(args, "attach", true);
  const selection = name === undefined ? await pickAttach(args.values as FlagValues<typeof attachFlags>) : undefined;
  if (name === undefined && selection === undefined) {
    console.error("Attach cancelled. No agent was stopped.");
    return;
  }
  const v = { ...args.values, name: name ?? selection!.name, ...(selection ? { on: selection.on } : {}) } as FlagValues<typeof attachFlags> & { name: string };
  const reconnecting = v["no-reconnect"] !== true;
  const on = v.on !== undefined ? (await pinForTarget(v as never, "cotal attach")).instanceId : undefined;
  // A typed pin the registry does not list is refused at once, as stop refuses it.
  if (selection === undefined && on !== undefined) {
    const reader = await resolveControlTarget(v, "control-caller-privileged", on);
    if (!reader.auth.bearer) await refuseUnregisteredManager(reader.space, reader.server, reader.auth, on);
  }
  const verdict = await attachSeat({ space: v.space, server: v.server, creds: v.creds, name: v.name, ...(selection ? { expectedTarget: selection.expectedTarget } : {}) }, { reconnect: reconnecting, onRefusal: "exit", on });
  if (verdict.kind === "failed") throw new CommandFailure("failed", "OPERATION_FAILED", verdict.message);
  const detached = verdict.kind === "ended" && verdict.reason === "detached";
  console.error(renderReport({ sections: [{ title: verdict.kind === "gone" ? "Attach target no longer available" : detached ? "Detached" : "Attach session ended", blocks: [
    { kind: "fields", rows: [["Agent", v.name]] },
    { kind: "lines", lines: [{ text: verdict.kind === "gone" ? "The selected agent or incarnation was not available to this attach request." : detached ? "Detaching did not send a stop request." : "The terminal session ended. This view sent no agent stop request; run `cotal ps` to check the agent's current state.", tone: "hint" }] },
  ] }] }, "rich", process.stderr));
}

/**
 * `cotal input --name <seat> --text <text> [--no-enter]`: deliver one line of text into a running
 * seat's terminal, as if a human had typed it. The command an external control surface needs that
 * `attach` cannot be: `attach` is a stream that holds a session and wants a pty on this side, and a
 * web request has neither.
 *
 * Routing is `attach`'s, unchanged: the seat-locality pin first (only the manager HOSTING the seat
 * can type into it), then the reach that mesh mode implies. Nothing is echoed back - the caller
 * reads the resulting turns from the event plane or the transcript, so this prints only what was
 * delivered.
 */
export function inputArguments(args: ParsedArgs): { name: string; text: string } {
  presentationOf(args.values);
  const [positionalName, positionalText, ...extra] = args.positionals;
  const values = args.values as FlagValues<typeof inputFlags>;
  if (extra.length || (positionalName !== undefined && values.name !== undefined) || (positionalText !== undefined && values.text !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "choose one agent and one text source: `cotal input <agent> <text>`, or --name and --text");
  const name = positionalName ?? values.name;
  const text = positionalText ?? values.text;
  if (!name?.trim() || /[\u0000-\u001f\u007f]/u.test(name)) throw new CommandFailure("refused", "USAGE_INVALID", "input needs one concrete agent name without terminal control characters");
  if (!text) throw new CommandFailure("refused", "USAGE_INVALID", "input needs nonempty text; use --text for a value beginning with a dash");
  if (values.on !== undefined) onInstance(values.on, "cotal input");
  return { name, text };
}

export async function input(args: ParsedArgs): Promise<void> {
  const parsed = inputArguments(args);
  const v = { ...args.values, ...parsed } as FlagValues<typeof inputFlags> & { name: string; text: string };
  const pin = await pinForTarget(v as never, "cotal input");
  const on = pin.instanceId;
  // A typed pin the registry does not list is refused at once, as stop refuses it.
  if (v.on !== undefined && on !== undefined) {
    const reader = await resolveControlTarget(v, "control-caller-privileged", on);
    if (!reader.auth.bearer) await refuseUnregisteredManager(reader.space, reader.server, reader.auth, on);
  }
  const t = await resolveControlTarget(v, "control-caller-admin", on);
  recordOperationSpace(t.space);
  const reach = t.auth.bearer ? "owner" : "any";
  const reply = await askManager(cliControl, t.space, t.server, "input", { name: v.name, text: v.text, enter: v["no-enter"] !== true }, t.auth, reach, undefined, pin);
  const target = { space: t.space, managerInstanceId: reply.managerInstanceId ?? on ?? null, agent: v.name };
  if (!reply.ok) throw unansweredDescribeRefusal(reply, "terminal input", target) ?? managerFailure(reply, "terminal input", target);
  const data = reply.data as { name?: unknown; bytes?: unknown } | undefined;
  if (!data || typeof data.name !== "string" || typeof data.bytes !== "number" || !Number.isSafeInteger(data.bytes) || data.bytes < 0)
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the manager answered, but the terminal-input receipt was unreadable; the text was not sent again", { target, ...(reply.request ? { native: { detail: { request: reply.request } } } : {}) });
  const result = { kind: "terminal-input", name: data.name, bytes: Number(data.bytes), enterRequested: v["no-enter"] !== true, request: reply.request ?? null };
  writeResult(presentationOf(v), { command: "input", target, result }, (row): Report => ({ sections: [
    { title: "Terminal input written", blocks: [{ kind: "fields", rows: [["Agent", row.name], ["Space", t.space], ["Manager", reply.managerInstanceId ?? "not attributed"], ["Bytes reported", String(row.bytes)], ["Enter requested", row.enterRequested ? "yes" : "no"]] }, { kind: "lines", lines: [{ text: "The native manager acknowledged writing to the terminal. This does not prove the application read it or completed a task. The input text is not echoed.", tone: "hint" }] }] },
  ] }));
}

/**
 * {@link Mesh} over a real space, built from the surfaces the terminal app uses: an observer that
 * reads the roster and the agents' event channels, and the manager control calls. On a user-auth
 * space the observer reads with the person's own sign-in, which reads the event channels of every
 * agent under their owner, so no admin grant is needed.
 */
import { hostname } from "node:os";
import {
  AGENT_CMD_SET_NAME,
  AGENT_CONTRACTS,
  AGENT_ENDPOINT,
  AGUI_FRAME_KIND,
  chatSubject,
  DEV_OWNER,
  EVENT_CHANNEL_PREFIX,
  eventChannel,
  eventPayloadSubject,
  eventChannelPrincipal,
  isEventChannel,
  isPermissionDenied,
  noLiveInstances,
  parsePrincipalKey,
  principalKey,
  remoteManagerActors,
  spacePrefix,
  spawnNameError,
  type CotalEndpoint,
  type CotalMessage,
  type ManagerInstanceListing,
  type Presence,
  type Profile,
  type SetNameIO,
} from "@cotal-ai/core";
import { connectTargetOrThrow, isConnectRefusal, ownManagerInstances, resolveControlTarget, resolvePreference, resolveTargetOrThrow, SignInChangedError, signInChange, userSignInAuth, type MeshTarget } from "@cotal-ai/workspace";
import { askManager, controlPs, liveManagerIds, managerCandidate, managerRailGone, reportedManagerHost, startStackManagerRemedy, START_TIMEOUT_MS, type ControlClient, type ControlCtx, type ManagerReply } from "@cotal-ai/workspace/control";
import { readManagedLaunch, requestManagedLaunch } from "@cotal-ai/workspace/launch";
import { openObserver } from "@cotal-ai/workspace/view";
import { AgentCallFailed, deregisterRemedy, LaunchListsRefused, NoLaunchManager, SignInRequired, type AgentCatalog, type AguiEventLike, type ChannelRow, type ManagerChoice, type Mesh, type PersonaRow, type RosterEntry, type SeatFrame, type SeatRef, type SeatRow, type SpawnRequest } from "./mesh.js";

const OBSERVER_NAME = "acp";
/** A seat's retained event history is read up to this many frames. */
const HISTORY_FRAMES = 1000;
/** How long an `agent` endpoint call waits for the agent's answer: longer than the agent's own 10 s
 *  bounds, as SPEC 13.22 asks of a reader. */
const AGENT_CALL_MS = 20_000;

export interface LiveMeshOptions {
  readonly space?: string;
  readonly server?: string;
  readonly log: (line: string) => void;
  /** Ends the bridge: the person's sign-in was granted again, and its reader cannot recover. */
  readonly stop: (reason: string) => void;
}

/** The manager reads whose unanswered pinned call names the deregister command on a signed-in space.
 *  An unanswered `start` may have been accepted, so it never does. */
const READS = new Set(["managerStatus", "models", "listPersonas", "ps"]);

/** Whether a reply should name the deregister command: an unanswered read of one of the person's own
 *  registered managers. The space's own manager is not theirs to remove, and a manager that answered
 *  with a refusal is not gone. */
export function namesDeregister(op: string, instanceId: string | undefined, own: ReadonlySet<string>, reply: { ok: boolean; unanswered?: boolean }): boolean {
  return instanceId !== undefined && own.has(instanceId) && READS.has(op) && !reply.ok && reply.unanswered === true;
}

/** A manager as a choice, its host read from the roster's current row for it. On a space where people
 *  sign in, `owner` is the person's, and only their own manager's row counts: another member may name
 *  an agent after it. An offline row says nothing about where the manager runs now, so it is not live
 *  and not local. */
export function managerChoice(instanceId: string, roster: readonly Presence[], here: string, owner?: string): ManagerChoice {
  const actor = remoteManagerActors(instanceId).supervisor;
  const row = roster.find((p) => (owner === undefined ? parsePrincipalKey(p.card.id)?.actor === actor : p.card.id === `${owner}.${actor}`) && p.status !== "offline");
  const seen = managerCandidate(instanceId, row).host;
  return { instanceId, ...(seen ? { host: seen } : {}), local: seen === here, live: row !== undefined };
}

/** After a connection error, how often and how many times the bridge asks whether its sign-in changed. */
const SIGN_IN_CHECK_MS = 5_000;
const SIGN_IN_CHECKS = 12;

/** The managers that listed their agents, and the ones that did not. A manager that did not hides
 *  only its own agents, is logged, and is named in `silent`. When none answered, the first failure is
 *  the answer. */
export function answeredReads<T>(reads: readonly ({ instanceId: string; rows: T[] } | { instanceId: string; error: Error })[], log: (line: string) => void): { answered: { instanceId: string; rows: T[] }[]; silent: string[] } {
  const failed = reads.filter((r): r is { instanceId: string; error: Error } => "error" in r);
  if (failed.length > 0 && failed.length === reads.length) throw failed[0]!.error;
  for (const f of failed) log(`manager ${f.instanceId} did not list its agents: ${f.error.message}`);
  return { answered: reads.filter((r): r is { instanceId: string; rows: T[] } => "rows" in r), silent: failed.map((f) => f.instanceId) };
}

/** Which of a person's managers, as the auth service lists them, a new thread may start on, and which
 *  the bridge reads agents from. A new thread may start on each of the person's registered managers
 *  that is live once they have registered any, else on the space's manager. That is the service's
 *  default rule for an unnamed call, except that several live managers are each offered where the
 *  service would refuse to choose. Every call names its manager, so a host's `local-primary` choice
 *  does not apply. Agents are read from every live one, so an agent left on the space's manager stays
 *  listed. `why` says why nothing may start. */
export function managerPlan(listed: readonly ManagerInstanceListing[]): { launch: string[]; read: string[]; own: string[]; why?: string } {
  const live = (placement: ManagerInstanceListing["placement"]) =>
    listed.filter((m) => m.placement === placement && m.state === "candidate").map((m) => m.instanceId).sort();
  const remote = live("remote");
  const local = live("local");
  const registered = listed.filter((m) => m.placement === "remote");
  const launch = registered.length > 0 ? remote : local;
  const why = launch.length > 0 ? undefined
    : registered.length > 0 ? `none of your managers is live (${registered.map((m) => `${m.instanceId}: ${m.state}`).join(", ")}); start one with \`cotal manager start\``
    : "the space lists no live manager for you";
  return { launch, read: [...remote, ...local], own: registered.map((m) => m.instanceId), ...(why ? { why } : {}) };
}

/** The order a plain `sort()` gives strings. */
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A seat id as a manager reports it: the principal in user mode, a bare actor otherwise. */
function principalOf(id: string): { owner: string; actor: string } {
  const p = parsePrincipalKey(id);
  return p ?? { owner: DEV_OWNER, actor: id };
}

function failure(reply: ManagerReply, what: string): Error {
  return new Error(`${what}: ${reply.error ?? "the manager did not answer"}`);
}

/** A launch list read's failure: {@link LaunchListsRefused} when the caller may not read it. */
function listFailure(reply: ManagerReply, what: string): Error {
  return reply.code === "permission-denied" ? new LaunchListsRefused(`${what}: ${reply.error ?? "permission denied"}`) : failure(reply, what);
}

/** The frame a message carries, or undefined when it carries none. Only the agent publishes on
 *  its own event channel and payload rail, so a frame from any other sender is none. A payload
 *  frame's envelope names the event channel it belongs to. */
export function frameOf(msg: CotalMessage, plane: SeatFrame["plane"] = "events"): SeatFrame | undefined {
  const seat = msg.channel === undefined ? null : eventChannelPrincipal(msg.channel);
  if (!seat || msg.from?.id !== principalKey(seat.owner, seat.actor).key) return undefined;
  const part = (msg.parts as readonly Record<string, unknown>[]).find((p) => p.kind === AGUI_FRAME_KIND);
  if (!part || typeof part.runId !== "string" || typeof part.threadId !== "string" || typeof part.seq !== "number" || !Array.isArray(part.events)) return undefined;
  return {
    plane,
    owner: seat.owner,
    actor: seat.actor,
    threadId: part.threadId,
    runId: part.runId,
    epoch: typeof part.epoch === "string" ? part.epoch : "",
    seq: part.seq,
    events: (part.events as unknown[]).filter((e): e is AguiEventLike => typeof e === "object" && e !== null && typeof (e as { type?: unknown }).type === "string"),
    ts: msg.ts,
  };
}

/** A workspace failure as one plain error, or {@link SignInRequired} when the client's sign-in fixes
 *  it: the space needs a login, or this machine records no space for `cotal setup` to fill. */
function plain(e: unknown): Error {
  if (!isConnectRefusal(e)) return e as Error;
  const f = e.failure();
  const message = f.remedy ? `${f.message} ${f.remedy}` : f.message;
  const noSpace = (e.cause as { code?: unknown } | undefined)?.code === "no-meshes";
  return e.code === "AUTH_REQUIRED" || noSpace ? new SignInRequired(message) : new Error(message);
}

/** The space connection: its target, the observer that reads it and, on a user-auth space, the
 *  person's sign-in. */
interface Connected {
  readonly target: MeshTarget;
  readonly observer: CotalEndpoint;
  readonly events: string;
  readonly payloads: string;
  readonly started: { owner: string; actor: string; lifecycleUid: string } | undefined;
  readonly signInNow: (() => Promise<string>) | undefined;
  readonly ownManagers: (() => Promise<ManagerInstanceListing[]>) | undefined;
}

async function connect(options: LiveMeshOptions): Promise<Connected> {
  let target: MeshTarget;
  let observer: CotalEndpoint;
  /** The event channels the observer follows, as a subject: every agent's on a static or open
   *  space, and the agents under the person's own owner on a user-auth space. */
  let events: string;
  /** The payload rails the observer follows: every agent's, or those under the person's owner. */
  let payloads: string;
  /** The person's sign-in on a user-auth space. The bridge acts as this sign-in throughout. */
  let started: { owner: string; actor: string; lifecycleUid: string } | undefined;
  /** On a user-auth space: asks the exchange for the sign-in again, and stops the bridge when it changed. */
  let signInNow: (() => Promise<string>) | undefined;
  /** On a user-auth space: the person's managers, as the space's auth service lists them. */
  let ownManagers: (() => Promise<ManagerInstanceListing[]>) | undefined;
  try {
    target = await resolveTargetOrThrow({ space: options.space, server: options.server });
    const conn = await connectTargetOrThrow(target, "admin");
    const signIn = conn.bearer ? userSignInAuth(conn) : undefined;
    // A re-grant retires the lifecycle the observer reads under. The bridge stops and says so.
    const user = signIn && {
      ...signIn,
      source: () => signIn.source().catch((e: unknown) => {
        if (e instanceof SignInChangedError) options.stop(e.message);
        throw e;
      }),
    };
    started = user && { owner: user.owner, actor: user.actor, lifecycleUid: user.lifecycleUid };
    signInNow = user?.source;
    ownManagers = user && (() => ownManagerInstances(conn));
    // Only an agent publishes on its own event channel, so on a user-auth space the sender's owner
    // is the person's too.
    events = user ? chatSubject(conn.space, user.owner, "*", `${EVENT_CHANNEL_PREFIX}${user.owner}.*`) : chatSubject(conn.space, "*", "*", `${EVENT_CHANNEL_PREFIX}*.*`);
    payloads = user ? eventPayloadSubject(conn.space, user.owner, "*") : `${spacePrefix(conn.space)}.evp.*.*`;
    observer = openObserver({ space: conn.space, server: conn.server, name: OBSERVER_NAME, ...(user ? { auth: { user }, lifecycleUid: user.lifecycleUid } : { auth: { creds: conn.creds } }) });
    // A re-grant ends the connection at once, while the endpoint renews its sign-in only mid-way
    // through the token. So a connection error asks the exchange now. The old lifecycle may still be
    // retiring, which the exchange refuses, so it asks again for a while. A changed sign-in stops
    // the bridge through the source; an unchanged one ends the checks.
    let checking = false;
    const checkSignIn = async (source: () => Promise<string>): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        for (let attempt = 1; attempt <= SIGN_IN_CHECKS; attempt++) {
          try {
            await source();
            return;
          } catch (e) {
            if (attempt === 1 || attempt === SIGN_IN_CHECKS) options.log(`could not check the sign-in (attempt ${attempt} of ${SIGN_IN_CHECKS}): ${plain(e).message}`);
          }
          await new Promise((r) => setTimeout(r, SIGN_IN_CHECK_MS));
        }
      } finally {
        checking = false;
      }
    };
    observer.on("error", (e: Error) => {
      options.log(`space connection: ${e.message}`);
      if (user) void checkSignIn(user.source);
    });
    await observer.start();
  } catch (e) {
    throw plain(e);
  }
  return { target, observer, events, payloads, started, signInNow, ownManagers };
}

/** The manager control calls, made as the person's sign-in when there is one. */
function controls(options: LiveMeshOptions, c: Connected) {
  const { target, observer, started, signInNow, ownManagers } = c;
  const ctx: ControlCtx = { space: target.space, server: target.server };

  const client: ControlClient = {
    versionSkew: (detail, undeclared, managerVersion) =>
      `${detail}. The manager does not declare "${undeclared}", so it runs another Cotal release than @cotal-ai/acp${managerVersion ? ` (the manager reports ${managerVersion})` : ""}. Run both at the same release.`,
    roster: async () => observer.getRoster(),
  };

  /** A control instrument's bearer must be the sign-in the bridge started on. One for another account
   *  or lifecycle stops the bridge before anything is sent. */
  const checked = <T extends { auth: { bearer?: string } }>(t: T): T => {
    const changed = started && t.auth.bearer ? signInChange(started, t.auth.bearer) : undefined;
    if (changed) {
      options.stop(changed.message);
      throw changed;
    }
    return t;
  };

  /** The instrument for one command, pinned to an instance when one is named. A refused instrument
   *  may be the sign-in changing under the bridge, as when another account may not use this manager,
   *  so on a user-auth space it asks once, and a changed sign-in stops the bridge as a changed bearer
   *  does. */
  const resolve = (profile: Profile, instanceId?: string) =>
    resolveControlTarget(ctx, profile, instanceId, { onRefusal: "throw" }).then(checked, async (e: unknown) => {
      if (signInNow) await signInNow().catch((c: unknown) => {
        if (c instanceof SignInChangedError) throw c;
      });
      throw plain(e);
    });

  /** The person's registered managers, as the last manager list read named them. Empty off a
   *  signed-in space. */
  let own: ReadonlySet<string> = new Set();

  /** One manager command, pinned to an instance when one is named. On a space where people sign in,
   *  one of the person's registered managers that does not answer a read may be one whose computer is
   *  gone, so the reply says how to remove it. */
  const ask = async (op: string, args?: Record<string, unknown>, instanceId?: string, timeoutMs?: number): Promise<ManagerReply> => {
    const t = await resolve("control-caller-privileged", instanceId);
    const reply = await askManager(client, t.space, t.server, op, args, t.auth, t.auth.bearer ? "owner" : "any", timeoutMs, instanceId ? { instanceId } : undefined);
    return namesDeregister(op, instanceId, own, reply) ? { ...reply, error: `${reply.error ?? "the manager did not answer"} ${deregisterRemedy(target.space, [instanceId!])}` } : reply;
  };

  /** The incarnation a seat command must reach. A manager names an open- or static-mode seat by its
   *  bare actor and a user-mode seat by its principal. */
  const expected = (seat: SeatRef) => ({ id: target.mode === "user" ? principalKey(seat.owner, seat.actor).key : seat.actor, lifecycleUid: seat.lifecycleUid });

  /** A seat command, sent to the manager that holds the seat and checked against the run the bridge
   *  bound, so nothing reaches a seat that restarted. The bridge learns the holding manager from the
   *  spawn reply or from the pinned list read, so no name lookup can pick another manager or refuse
   *  two seats whose names differ only in case. */
  const seatCommand = async (op: "stop" | "interrupt" | "input", seat: SeatRef, args: Record<string, unknown>): Promise<ManagerReply> => {
    const instanceId = seat.managerInstanceId;
    if (!instanceId) throw new Error(`${seat.name}: the manager that holds it is not known`);
    const t = await resolve("control-caller-admin", instanceId);
    const run = expected(seat);
    return askManager(client, t.space, t.server, op, args, t.auth, t.auth.bearer ? "owner" : "any", undefined, { instanceId, expectedSeat: { name: seat.name, ...run }, expectedTarget: run });
  };

  const choice = (instanceId: string): ManagerChoice => managerChoice(instanceId, observer.getRoster(), hostname(), started?.owner);

  /** On a user-auth space, the person's managers as the space's auth service lists them. The list
   *  spends no selection, a manager whose presence has not arrived is still listed, and each later
   *  call is pinned to a manager it names, which the exchange authorizes again. */
  const yourManagers = async () => {
    const plan = managerPlan(await ownManagers!().catch((e: unknown) => Promise.reject(plain(e))));
    own = new Set(plan.own);
    return plan;
  };
  return { ctx, client, resolve, ask, seatCommand, choice, yourManagers, own: (): ReadonlySet<string> => own };
}

type Controls = ReturnType<typeof controls>;

/** The reads a new thread's options come from, and the launch. */
function launchCalls(c: Connected, p: Controls, defaultPersona: string | null | undefined): Pick<Mesh, "catalogs" | "managers" | "manager" | "personas" | "spawn"> {
  const { target, started } = c;
  const { client, resolve, ask, choice, yourManagers } = p;
  return {
    async catalogs(instanceId) {
      const [status, models] = await Promise.all([ask("managerStatus", undefined, instanceId), ask("models", undefined, instanceId)]);
      if (!status.ok) throw listFailure(status, "the manager did not report its applications");
      if (!models.ok) throw listFailure(models, "the manager did not list its models");
      type Row = { agent: string; state: string; eventPlane: boolean; prompts?: boolean; askPermissions?: boolean; reasoningEvents?: boolean; reason?: string };
      const rows = (status.data as { connectors?: Row[] } | undefined)?.connectors ?? [];
      if (!Array.isArray(models.data)) throw new Error("the manager did not list its models");
      const catalogs = models.data as { agent: string; models?: { id: string; name?: string; variants?: { name: string }[] }[] }[];
      return rows.map((row): AgentCatalog => ({
        agent: row.agent,
        available: row.state === "available",
        eventPlane: row.eventPlane,
        ...(row.askPermissions && row.prompts ? { askPermissions: true } : {}),
        ...(row.reasoningEvents && row.eventPlane ? { reasoningEvents: true } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
        models: (catalogs.find((c) => c.agent === row.agent)?.models ?? []).map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          variants: (m.variants ?? []).map((v) => v.name),
        })),
      }));
    },

    async managers() {
      if (started) {
        const plan = await yourManagers();
        if (plan.why) throw new NoLaunchManager(plan.why);
        return plan.launch.map((instanceId) => choice(instanceId));
      }
      const t = await resolve("control-caller-privileged");
      const ids = await liveManagerIds(t.space, t.server, t.auth).catch((e: unknown) => {
        if (!noLiveInstances(e)) throw e;
        throw new NoLaunchManager(`The broker for ${t.space} is reachable, but no manager is registered. To open a thread, ${startStackManagerRemedy(t.space, t.server)}`);
      });
      const here = hostname();
      const choices = await Promise.all(ids.map(async (instanceId): Promise<ManagerChoice | undefined> => {
        // A per-instance call needs an instrument minted for that instance.
        const pinned = await resolve("control-caller-privileged", instanceId);
        // A registration whose host is gone has nothing subscribed on its rail, as `cotal ps`
        // reports it. It is not offered, and its host is not waited for. The probe answers only
        // for a gone rail, so a live manager's host answer ends it.
        const stop = new AbortController();
        const reported = reportedManagerHost(client, pinned.space, pinned.server, pinned.auth, instanceId).finally(() => stop.abort());
        if (await managerRailGone(pinned.space, pinned.server, pinned.auth, instanceId, stop.signal)) return undefined;
        const host = await reported;
        return { instanceId, ...(host ? { host } : {}), local: host === here, live: host !== undefined };
      }));
      return choices.filter((m): m is ManagerChoice => m !== undefined);
    },

    async manager(instanceId) {
      const seen = choice(instanceId);
      if (seen.host) return seen;
      // A manager whose presence row is not found here, such as the space's own, is asked its host.
      const t = await resolve("control-caller-privileged", instanceId);
      const host = await reportedManagerHost(client, t.space, t.server, t.auth, instanceId);
      return { instanceId, ...(host ? { host } : {}), local: host === hostname(), live: host !== undefined };
    },

    async personas(instanceId) {
      const reply = await ask("listPersonas", undefined, instanceId);
      if (!reply.ok) throw listFailure(reply, "the manager did not list its personas");
      const rows = (reply.data as { personas?: { name: string; owner?: string }[] } | undefined)?.personas ?? [];
      // The list names a persona's owner only to the caller who owns it (`list-personas`).
      return rows.map((p): PersonaRow => ({ name: p.name, ...(p.owner ? { own: true } : {}) })).sort((a, b) => byCodeUnits(a.name, b.name));
    },

    async spawn(req: SpawnRequest) {
      const reply = await requestManagedLaunch(
        { persona: req.persona ?? defaultPersona ?? "default", identity: req.name, agent: req.agent, model: req.model, variant: req.variant, cwd: req.cwd, ...(req.prompt ? { prompt: req.prompt } : {}), ...(req.subscribe ? { subscribe: [...req.subscribe] } : {}), events: true,
          ...(req.askPermissions ? { askPermissions: true } : {}), ...(req.reasoningEvents ? { reasoningEvents: true } : {}) },
        (args) => ask("start", args, req.managerInstanceId, START_TIMEOUT_MS),
      );
      if (!reply.ok) throw failure(reply, `${req.name} did not start`);
      const { result } = readManagedLaunch(reply, { space: target.space, requestedModel: req.model ?? null, detached: true }, { space: target.space });
      return { name: result.name, ...principalOf(result.id), lifecycleUid: result.lifecycleUid, managerInstanceId: result.managerInstanceId };
    },
  };
}

/** The seat's `agent` endpoint (SPEC 13.22), called as its owner. An agent serves it only under a
 *  user-auth credential (SPEC 13.21), so a space where people do not sign in has none. */
function agentCalls(c: Connected): Pick<Mesh, "agentEndpoints" | "agentCall" | "promptCounter" | "served"> {
  const { started, observer } = c;
  /** The seat's current presence row, when it is live and is the incarnation the bridge holds. */
  const row = (seat: SeatRef) => {
    const id = principalKey(seat.owner, seat.actor).key;
    return observer.getRoster().find((s) => s.card.id === id && s.lifecycleUid === seat.lifecycleUid && s.status !== "offline");
  };
  return {
    agentEndpoints: started !== undefined,

    async agentCall(seat, command, args) {
      if (!started) throw new AgentCallFailed(`${seat.name} serves no agent endpoint: agents serve it only on a space where people sign in`, "unavailable");
      const runtime = row(seat)?.runtime?.id;
      if (!runtime) throw new AgentCallFailed(`${seat.name} is not on the roster with its runtime`, "unavailable");
      const contract = AGENT_CONTRACTS[command];
      if (!contract) throw new AgentCallFailed(`the agent endpoint has no command ${command}`, "unimplemented");
      let reply;
      try {
        reply = await observer.callPrincipal({
          endpoint: AGENT_ENDPOINT,
          principal: { owner: seat.owner, actor: seat.actor, uid: seat.lifecycleUid, runtimeId: runtime },
          command,
          authority: "owner",
          args,
          deadlineMs: AGENT_CALL_MS,
          contract,
        });
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        throw new AgentCallFailed(plain(e).message, typeof code === "string" ? code : "internal");
      }
      if (!reply.ok) throw new AgentCallFailed(reply.error.message, reply.error.code, reply.error.details);
      return reply.data;
    },

    promptCounter(seat) {
      const r = row(seat);
      return r?.prompts && r.runtime ? { runtime: r.runtime.id, open: r.prompts.open, seq: r.prompts.seq } : undefined;
    },

    served(seat) {
      return started ? row(seat)?.agentEndpoint : undefined;
    },
  };
}

/** The agent list and the commands sent to one agent. */
function seatCalls(options: LiveMeshOptions, c: Connected, p: Controls, agent: ReturnType<typeof agentCalls>): Pick<Mesh, "seats" | "despawn" | "interrupt" | "input" | "rename" | "spawnNameError"> {
  const { started, observer, target } = c;
  const { ctx, client, ask, seatCommand, yourManagers } = p;
  return {
    async seats() {
      let answered: { instanceId: string; rows: unknown[] }[];
      let silent: string[];
      const removable: string[] = [];
      if (!started) {
        const reply = await controlPs(client, ctx, { readOnly: true });
        if (!reply.ok) throw new Error(reply.error);
        answered = reply.answered;
        // A registration whose host is gone never answers, so it is not one that may still hold the agent.
        for (const id of reply.gone) options.log(`manager ${id} is registered, but nothing is behind its rail; its host is gone and never deregistered`);
        silent = [...reply.silent.filter((id) => !reply.gone.includes(id)), ...reply.failed.map((f) => f.instanceId)];
      } else {
        // A user-auth bearer reads one manager per call, each pinned. A manager that does not answer
        // hides only its own agents, as `cotal ps` reports it.
        const plan = await yourManagers();
        if (plan.read.length === 0) throw new Error(plan.why ?? "the space lists no live manager for you");
        const reads = await Promise.all(plan.read.map(async (instanceId) => {
          try {
            const reply = await ask("ps", undefined, instanceId);
            if (!reply.ok) {
              if (namesDeregister("ps", instanceId, p.own(), reply)) removable.push(instanceId);
              throw failure(reply, "the manager did not list its agents");
            }
            return { instanceId, rows: (reply.data as unknown[] | undefined) ?? [] };
          } catch (e) {
            if (e instanceof SignInChangedError) throw e;
            return { instanceId, error: plain(e) };
          }
        }));
        ({ answered, silent } = answeredReads(reads, options.log));
      }
      const rows = answered.flatMap(({ instanceId, rows }) =>
        rows.map((row): SeatRow => {
          const r = row as unknown as { name: string; id: string; lifecycleUid: string; agent: string; model?: string; cwd?: string; status: string; uptimeMs?: number };
          const principal = principalOf(r.id);
          // `set-name` changes the name the agent shows, never the name its manager lists.
          const shown = observer.getRoster().find((s) => s.card.id === principalKey(principal.owner, principal.actor).key && s.lifecycleUid === r.lifecycleUid)?.card.name;
          return {
            name: r.name,
            ...(shown && shown !== r.name ? { display: shown } : {}),
            ...principal,
            lifecycleUid: r.lifecycleUid,
            managerInstanceId: instanceId,
            agent: r.agent,
            ...(r.model ? { model: r.model } : {}),
            ...(r.cwd ? { cwd: r.cwd } : {}),
            status: r.status,
            ...(r.uptimeMs !== undefined ? { uptimeMs: r.uptimeMs } : {}),
          };
        }),
      );
      return { rows, silent, removable };
    },

    async despawn(seat: SeatRef) {
      const reply = await seatCommand("stop", seat, { name: seat.name, graceful: true });
      if (!reply.ok) throw failure(reply, `${seat.name} did not stop`);
    },

    async interrupt(seat: SeatRef) {
      const reply = await seatCommand("interrupt", seat, { name: seat.name });
      if (!reply.ok) throw failure(reply, `${seat.name} was not interrupted`);
    },

    async input(seat: SeatRef, text: string) {
      const reply = await seatCommand("input", seat, { name: seat.name, text, enter: true });
      if (!reply.ok) throw failure(reply, `${seat.name} did not get the prompt`);
    },

    async rename(seat: SeatRef, name: string) {
      if (!started) throw new Error("renaming a running agent needs a space where people sign in, where the agent serves `set-name`");
      return ((await agent.agentCall(seat, AGENT_CMD_SET_NAME, { name })) as SetNameIO).name;
    },

    spawnNameError(name: string) {
      return spawnNameError(name, { userMode: target.mode === "user" });
    },
  };
}

/** What the observer reads: the agents' frames and presence, the roster and the channels. */
function spaceReads(c: Connected): Pick<Mesh, "followFrames" | "frameHistory" | "presence" | "roster" | "channels" | "close"> {
  const { observer, events, payloads, started } = c;
  return {
    followFrames(onFrame) {
      let live = true;
      observer.tap((_subject, msg) => {
        if (!live || !msg || !isEventChannel(msg.channel)) return;
        const frame = frameOf(msg);
        if (frame) onFrame(frame);
      }, { subject: events });
      observer.tap((_subject, msg) => {
        if (!live || !msg || !isEventChannel(msg.channel)) return;
        const frame = frameOf(msg, "payloads");
        if (frame) onFrame(frame);
      }, { subject: payloads });
      return () => (live = false);
    },

    async frameHistory(seat: SeatRef) {
      // A person's sign-in reads history through its own lifecycle's reader.
      const [rows, payloadRows] = await Promise.all([
        started
          ? observer.channelHistoryPage(eventChannel(seat), { limit: HISTORY_FRAMES, publisher: seat }).then((page) => page.items)
          : observer.channelHistory(eventChannel(seat), { limit: HISTORY_FRAMES, publisher: seat }),
        observer.eventPayloadHistory(seat.owner, seat.actor, { limit: HISTORY_FRAMES }).catch((e: unknown) => {
          const why = plain(e).message;
          throw new Error(`${seat.name}'s earlier tool inputs and results cannot be read from its payload history: ${isPermissionDenied(e) ? `this sign-in may not read it (${why})` : why}`);
        }),
      ]);
      // A payload frame shares its event frame's epoch and seq, and goes right before it. One whose
      // event frame the space has dropped belongs to no call the thread shows.
      const key = (f: SeatFrame) => `${f.epoch}:${f.seq}`;
      const before = new Map<string, SeatFrame[]>();
      for (const f of payloadRows.map((m) => frameOf(m, "payloads"))) if (f) before.set(key(f), [...(before.get(key(f)) ?? []), f]);
      return rows.map((m) => frameOf(m)).filter((f): f is SeatFrame => f !== undefined).flatMap((f) => [...(before.get(key(f)) ?? []), f]);
    },

    presence(seat: SeatRef) {
      const id = principalKey(seat.owner, seat.actor).key;
      const status = observer.getRoster().find((p) => p.card.id === id)?.status;
      return status === "offline" ? undefined : status;
    },

    async roster() {
      return observer.getRoster()
        .filter((p) => p.card.kind === "agent" && p.status !== "offline")
        .map((p): RosterEntry => ({ name: p.card.name, status: p.status, ...(p.card.role ? { role: p.card.role } : {}), ...(p.activity ? { activity: p.activity } : {}) }));
    },

    async channels() {
      return (await observer.listChannels())
        .filter((c) => !isEventChannel(c.channel))
        .map((c): ChannelRow => ({ channel: c.channel, messages: c.messages, ...(c.config?.description ? { description: c.config.description } : {}) }))
        .sort((a, b) => byCodeUnits(a.channel, b.channel));
    },

    async close() {
      await observer.stop();
    },
  };
}

export async function openLiveMesh(options: LiveMeshOptions): Promise<Mesh> {
  const c = await connect(options);
  const { target } = c;
  const p = controls(options, c);
  const agent = agentCalls(c);
  const defaultPersona = resolvePreference("persona", { space: target.space }).value;
  const defaultAgent = resolvePreference("harness", { space: target.space }).value;

  return {
    space: target.space,
    ...(defaultAgent ? { defaultAgent } : {}),
    ...launchCalls(c, p, defaultPersona),
    ...agent,
    ...seatCalls(options, c, p, agent),
    ...spaceReads(c),
  };
}

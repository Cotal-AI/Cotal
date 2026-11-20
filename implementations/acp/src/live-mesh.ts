/**
 * {@link Mesh} over a real space, built from the surfaces the terminal app uses: an observer that
 * reads the roster and the agents' event channels, and the manager control calls. On a user-auth
 * space the observer reads with the person's own sign-in, which reads the event channels of every
 * agent under their owner, so no admin grant is needed.
 */
import { hostname } from "node:os";
import {
  AGUI_FRAME_KIND,
  chatSubject,
  DEV_OWNER,
  EVENT_CHANNEL_PREFIX,
  eventChannel,
  eventChannelPrincipal,
  isEventChannel,
  parsePrincipalKey,
  principalKey,
  type CotalEndpoint,
  type CotalMessage,
  type Profile,
} from "@cotal-ai/core";
import { connectTargetOrThrow, isConnectRefusal, resolveControlTarget, resolvePreference, resolveTargetOrThrow, SignInChangedError, signInChange, userSignInAuth, type MeshTarget } from "@cotal-ai/workspace";
import { askManager, controlPs, liveManagerIds, managerCandidate, managerRailGone, refusedManagers, reportedManagerHost, START_TIMEOUT_MS, type ControlClient, type ControlCtx, type ManagerReply } from "@cotal-ai/workspace/control";
import { readManagedLaunch, requestManagedLaunch } from "@cotal-ai/workspace/launch";
import { openObserver } from "@cotal-ai/workspace/view";
import { LaunchListsRefused, SignInRequired, type AgentCatalog, type AguiEventLike, type ManagerChoice, type Mesh, type RosterEntry, type SeatFrame, type SeatRef, type SeatRow, type SpawnRequest } from "./mesh.js";

const OBSERVER_NAME = "acp";
/** A seat's retained event history is read up to this many frames. */
const HISTORY_FRAMES = 1000;

export interface LiveMeshOptions {
  readonly space?: string;
  readonly server?: string;
  readonly log: (line: string) => void;
  /** Ends the bridge: the person's sign-in was granted again, and its reader cannot recover. */
  readonly stop: (reason: string) => void;
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
 *  its own event channel, so a frame from any other sender is none. */
export function frameOf(msg: CotalMessage): SeatFrame | undefined {
  const seat = msg.channel === undefined ? null : eventChannelPrincipal(msg.channel);
  if (!seat || msg.from?.id !== principalKey(seat.owner, seat.actor).key) return undefined;
  const part = (msg.parts as readonly Record<string, unknown>[]).find((p) => p.kind === AGUI_FRAME_KIND);
  if (!part || typeof part.runId !== "string" || typeof part.threadId !== "string" || typeof part.seq !== "number" || !Array.isArray(part.events)) return undefined;
  return {
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

export async function openLiveMesh(options: LiveMeshOptions): Promise<Mesh> {
  let target: MeshTarget;
  let observer: CotalEndpoint;
  /** The event channels the observer follows, as a subject: every agent's on a static or open
   *  space, and the agents under the person's own owner on a user-auth space. */
  let events: string;
  /** The person's sign-in on a user-auth space. The bridge acts as this sign-in throughout. */
  let started: { owner: string; actor: string; lifecycleUid: string } | undefined;
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
    // Only an agent publishes on its own event channel, so on a user-auth space the sender's owner
    // is the person's too.
    events = user ? chatSubject(conn.space, user.owner, "*", `${EVENT_CHANNEL_PREFIX}${user.owner}.*`) : chatSubject(conn.space, "*", "*", `${EVENT_CHANNEL_PREFIX}*.*`);
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

  /** The instrument for one command, pinned to an instance when one is named. */
  const resolve = (profile: Profile, instanceId?: string) =>
    resolveControlTarget(ctx, profile, instanceId, { onRefusal: "throw" }).then(checked, (e: unknown) => Promise.reject(plain(e)));

  /** One manager command, pinned to an instance when one is named. */
  const ask = async (op: string, args?: Record<string, unknown>, instanceId?: string, timeoutMs?: number): Promise<ManagerReply> => {
    const t = await resolve("control-caller-privileged", instanceId);
    return askManager(client, t.space, t.server, op, args, t.auth, t.auth.bearer ? "owner" : "any", timeoutMs, instanceId ? { instanceId } : undefined);
  };

  /** The incarnation a seat command must reach. A manager names an open- or static-mode seat by its
   *  bare actor and a user-mode seat by its principal. */
  const expected = (seat: SeatRef) => ({ id: target.mode === "user" ? principalKey(seat.owner, seat.actor).key : seat.actor, lifecycleUid: seat.lifecycleUid });

  /** A seat command, sent to the manager that holds the seat and checked against the run the bridge
   *  bound, so nothing reaches a seat that restarted. The bridge learns the holding manager from the
   *  spawn reply or from the pinned list read, so no name lookup can pick another manager. */
  const seatCommand = async (op: "stop" | "interrupt" | "input", seat: SeatRef, args: Record<string, unknown>): Promise<ManagerReply> => {
    const instanceId = seat.managerInstanceId;
    if (!instanceId) throw new Error(`${seat.name}: the manager that holds it is not known`);
    const t = await resolve("control-caller-admin", instanceId);
    return askManager(client, t.space, t.server, op, args, t.auth, t.auth.bearer ? "owner" : "any", undefined, { instanceId, expectedTarget: expected(seat) });
  };

  /** A manager as a choice, its host read from its presence when the roster carries it. */
  const choice = (instanceId: string, host?: string | null): ManagerChoice => {
    const seen = host ?? managerCandidate(instanceId, observer.getRoster().find((p) => parsePrincipalKey(p.card.id)?.actor === `manager_${instanceId}`)).host;
    return { instanceId, ...(seen ? { host: seen } : {}), local: seen === hostname() };
  };

  /** On a user-auth space, the managers the space's exchange lets this person reach: the one it
   *  selects for an unpinned call, or each live one it names when it will not pick among several.
   *  The exchange is the authority, so a manager whose presence has not arrived is still listed, and
   *  each later call is pinned to the manager that was read. */
  const yourManagers = async (): Promise<ManagerChoice[]> => {
    let t: Awaited<ReturnType<typeof resolveControlTarget>>;
    try {
      t = await resolveControlTarget(ctx, "control-caller-privileged", undefined, { onRefusal: "throw" });
    } catch (e) {
      const named = await refusedManagers(client, e, ctx);
      if (!named) throw plain(e);
      return named.map((m) => choice(m.instanceId, m.host));
    }
    const instanceId = checked(t).auth.managerInstanceId;
    if (!instanceId) throw new Error(`the exchange for space "${t.space}" selected no manager`);
    return [choice(instanceId)];
  };

  const defaultPersona = resolvePreference("persona", { space: target.space }).value;
  const defaultAgent = resolvePreference("harness", { space: target.space }).value;

  return {
    space: target.space,
    userMode: target.mode === "user",
    ...(defaultAgent ? { defaultAgent } : {}),

    async catalogs(instanceId) {
      const [status, models] = await Promise.all([ask("managerStatus", undefined, instanceId), ask("models", undefined, instanceId)]);
      if (!status.ok) throw listFailure(status, "the manager did not report its applications");
      if (!models.ok) throw listFailure(models, "the manager did not list its models");
      const rows = (status.data as { connectors?: { agent: string; state: string; eventPlane: boolean; reason?: string }[] } | undefined)?.connectors ?? [];
      if (!Array.isArray(models.data)) throw new Error("the manager did not list its models");
      const catalogs = models.data as { agent: string; models?: { id: string; name?: string; variants?: { name: string }[] }[] }[];
      return rows.map((row): AgentCatalog => ({
        agent: row.agent,
        available: row.state === "available",
        eventPlane: row.eventPlane,
        ...(row.reason ? { reason: row.reason } : {}),
        models: (catalogs.find((c) => c.agent === row.agent)?.models ?? []).map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          variants: (m.variants ?? []).map((v) => v.name),
        })),
      }));
    },

    async managers() {
      if (started) return yourManagers();
      const t = await resolve("control-caller-privileged");
      const ids = await liveManagerIds(t.space, t.server, t.auth);
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
        return { instanceId, ...(host ? { host } : {}), local: host === here };
      }));
      return choices.filter((m): m is ManagerChoice => m !== undefined);
    },

    async personas(instanceId) {
      const reply = await ask("listPersonas", undefined, instanceId);
      if (!reply.ok) throw listFailure(reply, "the manager did not list its personas");
      const rows = (reply.data as { personas?: { name: string }[] } | undefined)?.personas ?? [];
      return rows.map((p) => p.name).sort();
    },

    async spawn(req: SpawnRequest) {
      const reply = await requestManagedLaunch(
        { persona: req.persona ?? defaultPersona ?? "default", identity: req.name, agent: req.agent, model: req.model, variant: req.variant, cwd: req.cwd, prompt: req.prompt, ...(req.subscribe ? { subscribe: [...req.subscribe] } : {}), events: true },
        (args) => ask("start", args, req.managerInstanceId, START_TIMEOUT_MS),
      );
      if (!reply.ok) throw failure(reply, `${req.name} did not start`);
      const { result } = readManagedLaunch(reply, { space: target.space, requestedModel: req.model ?? null, detached: true }, { space: target.space });
      return { name: result.name, ...principalOf(result.id), lifecycleUid: result.lifecycleUid, managerInstanceId: result.managerInstanceId };
    },

    async seats() {
      let answered: { instanceId: string; rows: unknown[] }[];
      let silent: string[];
      if (!started) {
        const reply = await controlPs(client, ctx, { readOnly: true });
        if (!reply.ok) throw new Error(reply.error);
        answered = reply.answered;
        silent = [...reply.silent, ...reply.failed.map((f) => f.instanceId)];
      } else {
        // A user-auth bearer reads one manager per call, each pinned. A manager that does not answer
        // hides only its own agents, as `cotal ps` reports it.
        const reads = await Promise.all((await yourManagers()).map(async ({ instanceId }) => {
          try {
            const reply = await ask("ps", undefined, instanceId);
            if (!reply.ok) throw failure(reply, "the manager did not list its agents");
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
          return {
            name: r.name,
            ...principalOf(r.id),
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
      return { rows, silent };
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

    followFrames(onFrame) {
      let live = true;
      observer.tap((_subject, msg) => {
        if (!live || !msg || !isEventChannel(msg.channel)) return;
        const frame = frameOf(msg);
        if (frame) onFrame(frame);
      }, { subject: events });
      return () => (live = false);
    },

    async frameHistory(seat: SeatRef) {
      // A person's sign-in reads history through its own lifecycle's reader.
      const rows = started
        ? (await observer.channelHistoryPage(eventChannel(seat), { limit: HISTORY_FRAMES, publisher: seat })).items
        : await observer.channelHistory(eventChannel(seat), { limit: HISTORY_FRAMES, publisher: seat });
      return rows.map(frameOf).filter((f): f is SeatFrame => f !== undefined);
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
      return (await observer.listChannels()).map((c) => c.channel).filter((c) => !isEventChannel(c)).sort();
    },

    async close() {
      await observer.stop();
    },
  };
}

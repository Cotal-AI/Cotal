/**
 * {@link Mesh} over a real space, built from the surfaces the terminal app uses: an admin observer
 * that reads every channel and the roster, the manager control calls, and a chat session under the
 * operator's own identity for direct messages.
 */
import { hostname } from "node:os";
import {
  AGUI_FRAME_KIND,
  chatWildcard,
  DEV_OWNER,
  eventChannel,
  eventChannelPrincipal,
  isEventChannel,
  parsePrincipalKey,
  principalKey,
  type CotalEndpoint,
  type CotalMessage,
} from "@cotal-ai/core";
import { connectTargetOrThrow, isConnectRefusal, resolveControlTarget, resolvePreference, resolveTargetOrThrow, userViewAuth, type MeshTarget } from "@cotal-ai/workspace";
import { openChatSession, resolveChatName, USER_CHAT_TTL_SEC, type AdmittedChatSession, type ChatAdmission } from "@cotal-ai/workspace/chat";
import { askManager, control, controlPs, liveManagerIds, reportedManagerHost, START_TIMEOUT_MS, type ControlClient, type ControlCtx, type ManagerReply } from "@cotal-ai/workspace/control";
import { readManagedLaunch, requestManagedLaunch } from "@cotal-ai/workspace/launch";
import { openObserver } from "@cotal-ai/workspace/view";
import { SignInRequired, type AgentCatalog, type AguiEventLike, type ManagerChoice, type Mesh, type RosterEntry, type SeatFrame, type SeatRef, type SeatRow, type SpawnRequest } from "./mesh.js";

const OBSERVER_NAME = "acp";
/** A seat's retained event history is read up to this many frames. */
const HISTORY_FRAMES = 1000;

export interface LiveMeshOptions {
  readonly space?: string;
  readonly server?: string;
  readonly log: (line: string) => void;
}

/** A seat id as a manager reports it: the principal in user mode, a bare actor otherwise. */
function principalOf(id: string): { owner: string; actor: string } {
  const p = parsePrincipalKey(id);
  return p ?? { owner: DEV_OWNER, actor: id };
}

function failure(reply: ManagerReply, what: string): Error {
  return new Error(`${what}: ${reply.error ?? "the manager did not answer"}`);
}

/** The frame a message carries, or undefined when it carries none. */
export function frameOf(msg: CotalMessage): SeatFrame | undefined {
  const seat = msg.channel === undefined ? null : eventChannelPrincipal(msg.channel);
  if (!seat) return undefined;
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

/** The admission the bridge's chat session asks for: direct messages only. The observer reads
 *  every channel, so the session reads none. */
function admission(mode: MeshTarget["mode"], label: string): ChatAdmission {
  if (mode === "open") return { mode, label, channels: [] };
  if (mode === "auth") return { mode, label, subscribe: [], allowPublish: [] };
  if (mode === "user") return { mode, label, channels: [], read: [], post: [], ttlSec: USER_CHAT_TTL_SEC };
  throw new Error(`no chat admission for a space recorded in "${String(mode)}" mode`);
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
  try {
    target = await resolveTargetOrThrow({ space: options.space, server: options.server });
    const conn = await connectTargetOrThrow(target, "admin");
    const user = conn.bearer ? await userViewAuth(conn, "admin") : undefined;
    observer = openObserver({ space: conn.space, server: conn.server, name: OBSERVER_NAME, auth: user ? { user } : { creds: conn.creds } });
    observer.on("error", (e: Error) => options.log(`space connection: ${e.message}`));
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

  /** One manager command, pinned to an instance when one is named. */
  const ask = async (op: string, args?: Record<string, unknown>, instanceId?: string, timeoutMs?: number): Promise<ManagerReply> => {
    const t = await resolveControlTarget(ctx, "control-caller-privileged", instanceId, { onRefusal: "throw" }).catch((e) => Promise.reject(plain(e)));
    return askManager(client, t.space, t.server, op, args, t.auth, t.auth.bearer ? "owner" : "any", timeoutMs, instanceId ? { instanceId } : undefined);
  };

  let chat: Promise<AdmittedChatSession> | undefined;
  const session = (): Promise<AdmittedChatSession> => {
    chat ??= (async () => {
      const name = await resolveChatName(target, { remedy: "set a name with `cotal config set name <name>`" });
      return openChatSession(target, admission(target.mode, name.name), { words: { reopen: () => "", answerOne: "" }, control: client });
    })();
    chat.catch(() => (chat = undefined));
    return chat;
  };

  const defaultPersona = resolvePreference("persona", { space: target.space }).value;
  const defaultAgent = resolvePreference("harness", { space: target.space }).value;

  return {
    space: target.space,
    userMode: target.mode === "user",
    ...(defaultAgent ? { defaultAgent } : {}),

    async catalogs(instanceId) {
      const [status, models] = await Promise.all([ask("managerStatus", undefined, instanceId), ask("models", undefined, instanceId)]);
      if (!status.ok) throw failure(status, "the manager did not report its applications");
      if (!models.ok) throw failure(models, "the manager did not list its models");
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
      const t = await resolveControlTarget(ctx, "control-caller-privileged", undefined, { onRefusal: "throw" }).catch((e) => Promise.reject(plain(e)));
      const ids = await liveManagerIds(t.space, t.server, t.auth);
      const here = hostname();
      return Promise.all(ids.map(async (instanceId): Promise<ManagerChoice> => {
        const host = await reportedManagerHost(client, t.space, t.server, t.auth, instanceId);
        return { instanceId, ...(host ? { host } : {}), local: host === here };
      }));
    },

    async personas() {
      const reply = await ask("listPersonas");
      if (!reply.ok) throw failure(reply, "the manager did not list its personas");
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
      const reply = await controlPs(client, ctx, { readOnly: true });
      if (!reply.ok) throw new Error(reply.error);
      return reply.answered.flatMap(({ instanceId, rows }) =>
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
    },

    async despawn(seat: SeatRef) {
      // A manager names an open- or static-mode seat by its bare actor; a user-mode seat by its principal.
      const id = target.mode === "user" ? principalKey(seat.owner, seat.actor).key : seat.actor;
      const reply = await control(client, ctx, "stop", { name: seat.name, graceful: true }, { expectedTarget: { id, lifecycleUid: seat.lifecycleUid } });
      if (!reply.ok) throw failure(reply, `${seat.name} did not stop`);
    },

    async dm(seat: SeatRef, text: string) {
      const s = await session();
      const storedAt = Date.now();
      const result = await s.dm({ principal: principalKey(seat.owner, seat.actor).key }, text);
      if (result.outcome !== "stored") throw new Error(`the message to ${seat.name} was not stored: ${result.message}`);
      return { storedAt };
    },

    followFrames(onFrame) {
      let live = true;
      observer.tap((_subject, msg) => {
        if (!live || !msg || !isEventChannel(msg.channel)) return;
        const frame = frameOf(msg);
        if (frame) onFrame(frame);
      }, { subject: chatWildcard(target.space) });
      return () => (live = false);
    },

    async frameHistory(seat: SeatRef) {
      const rows = await observer.channelHistory(eventChannel(seat), { limit: HISTORY_FRAMES, publisher: seat });
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
      const s = await chat?.catch(() => undefined);
      await s?.close().catch(() => undefined);
      await observer.stop();
    },
  };
}

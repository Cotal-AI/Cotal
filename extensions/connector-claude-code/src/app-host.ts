/** The local gateway for personal Claude conversations. Issuance and retirement stay in the CLI;
 * native lifecycle and transcripts stay in this adapter and are bound to an explicit session. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { ApprovalRequired, configFromEnv, eventPlaneArmed, GATEWAY_TOOLS, MeshAgent, NameTaken, type GatewayConnection, type GatewayHost, type HookEvent, type NativeTurnParticipationLease } from "@cotal-ai/connector-core";
import type { ConversationApprovalPending, ConversationGrant, ConversationPending, ConversationSelection } from "@cotal-ai/core";
import { createClaudeHandle, type ClaudeHooks } from "./hooks.js";
import { createClaudeEventPlane } from "./claude-events.js";
import { createBoundClaudeTranscriptSource } from "./agui-source.js";

const PLUMBING_MS = 60_000;
const JOIN_MS = 20_000;
/** How often a pending request is replayed to the authority while the person decides, and how long
 *  past its expiry a replay may still bring the recorded decision before the host stops asking. */
const WATCH = { pollMs: 10_000, graceMs: 60_000 };

/** What the person decided about a bound conversation's pending request. `id` is the approval the
 *  conversation already holds; an approved request is finished with `cotal_connect` and that id. */
export interface ApprovalNotice { name: string; status: "approved" | "denied" | "expired"; id: string }

export interface AppHostOptions {
  cotal: () => readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Tell the bound native session what the person decided. True when a reader heard it. */
  notify?: (session: string, notice: ApprovalNotice) => boolean;
  /** Obtain a finite authority-issued lease for this exact personal identity. */
  participate?: (connection: GatewayConnection) => Promise<NativeTurnParticipationLease>;
  /** Deliver one pending workflow turn through the bound native session wake feed. */
  turn?: (session: string, connectionId: string, text: string) => boolean;
  watch?: typeof WATCH;
}

export interface AppHost extends GatewayHost {
  closeAll(): Promise<void>;
  nativeEvent(event: Record<string, unknown>): Promise<void>;
  sessionFor(id: string): string | undefined;
}

interface NativeBinding { session: string; path: string; event: HookEvent }
interface Held {
  conn: GatewayConnection;
  dir?: string;
  session?: string;
  hooks?: ClaudeHooks;
  plane?: ReturnType<typeof createClaudeEventPlane>;
  closing?: Promise<boolean>;
  stopped?: boolean;
  /** Why the last retirement of a stopped connection did not finish. */
  unfinished?: string;
}

type Reply = { ok: true; env: Record<string, string>; retire?: { dir: string }; grant?: ConversationGrant }
  | ({ ok: false; pending: true } & ConversationPending)
  | { ok: false; pending?: false; taken?: true; error?: string; refused?: "denied" | "expired" | "refused" };

/** A bound session's request the person has not decided. The host replays it until the authority
 *  records a decision, the request expires, or the session ends; an issued identity waits here,
 *  unclaimed, for that conversation's own `cotal_connect`. */
interface Watch {
  name: string;
  args: string[];
  approval: ConversationApprovalPending;
  timer?: NodeJS.Timeout;
  /** The credential directory of an identity the authority issued that no connection has claimed. */
  issued?: string;
  stopped: boolean;
}

/** The native tools a signed-in conversation's own grant can use. The manager that serves each
 *  call still decides it from that grant. */
function grantedTools(grant: ConversationGrant): ReadonlySet<string> {
  return new Set([
    ...GATEWAY_TOOLS,
    "cotal_reconnect",
    ...(grant.scope.includes("spawn") ? ["cotal_spawn", "cotal_persona", "cotal_personas", "cotal_despawn"] : []),
    ...(grant.scope.includes("run") ? ["cotal_run", "cotal_turn_participate", "cotal_yield"] : []),
  ]);
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One state for a stopped connection whose retirement is unfinished, whichever tool meets it. */
function unfinished(id: string, why: string): string {
  return `This conversation is disconnected from the mesh, but its identity cleanup is not finished: ${why}. ` +
    `Call cotal_disconnect with connection_id ${id} to retry it now, or cotal_connect to retry it and then connect again.`;
}

function launchEnv(base: NodeJS.ProcessEnv, printed: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("COTAL_") || k === "COTAL_HOME") env[k] = v;
  return { ...env, ...printed };
}

export function createAppHost(o: AppHostOptions): AppHost {
  const held = new Map<string, Held>();
  const bindings = new Map<string, NativeBinding>();
  const pending = new Map<string, string>();
  const watches = new Map<string, Watch>();
  const watch = o.watch ?? WATCH;
  let opening: Promise<unknown> = Promise.resolve();
  /** Every CLI provision runs alone: a replay and a `cotal_connect` for one session share a record lock. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = opening.then(fn);
    opening = next.catch(() => {});
    return next;
  };
  let reaping: Promise<void> | undefined;
  let reapAgain = false;
  let reapSpace: string | undefined;
  const plumbing = (args: string[]): Promise<Reply> => new Promise((resolve, reject) => {
    const cotal = o.cotal();
    execFile(cotal[0]!, [...cotal.slice(1), "app-identity", ...args], { cwd: o.cwd, env: o.env, timeout: PLUMBING_MS }, (_error, stdout, stderr) => {
      try { resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Reply); }
      catch {
        reject(new Error(/Unknown option ['"]--require-approval['"]/.test(stderr)
          ? "The recorded Cotal CLI cannot enforce permission approval. Update Cotal, run `cotal setup`, then reopen Claude. No connection was started."
          : "the Cotal CLI did not return an identity result; any saved request was retained for recovery"));
      }
    });
  });
  const retire = async (dir?: string): Promise<void> => {
    if (!dir) return;
    const reply = await plumbing(["retire", "--dir", dir]);
    if (!reply.ok) throw new Error(("error" in reply && reply.error) || "identity retirement is unconfirmed");
  };
  // Retiring other conversations' dead identities runs after a connection and never delays one. A
  // request made while a run is in flight starts one more run when it ends.
  const reap = (space?: string): void => {
    if (reaping) { reapAgain = true; reapSpace = space; return; }
    reaping = plumbing(["reap", ...(space === undefined ? [] : ["--space", space])]).then(() => {}, () => {}).finally(() => {
      reaping = undefined;
      if (reapAgain) { reapAgain = false; const next = reapSpace; reapSpace = undefined; reap(next); }
    });
  };
  const stopWatch = (session: string): Watch | undefined => {
    const w = watches.get(session);
    if (!w) return undefined;
    w.stopped = true;
    if (w.timer) clearTimeout(w.timer);
    watches.delete(session);
    return w;
  };
  const tell = (session: string, w: Watch, status: ApprovalNotice["status"]): void => {
    let heard = false;
    try { heard = o.notify?.(session, { name: w.name, status, id: w.approval.id }) ?? false; } catch { heard = false; }
    if (!heard) process.stderr.write(`[cotal-connector] a personal connection request was ${status}, but its native session has no reader to tell\n`);
  };
  // One replay of the saved request, alone among CLI runs. Only the authority's recorded answer
  // decides anything here: an issued identity waits for the conversation's own cotal_connect, a
  // refusal is final and the CLI has already dropped the request, and a run with no result is tried
  // again. Nothing is replayed past the request's own expiry and a grace for the recorded answer.
  const replay = (session: string, w: Watch): void => {
    w.timer = undefined;
    void serial(async () => {
      if (w.stopped) return;
      let reply: Reply | undefined;
      try { reply = await plumbing(w.args); } catch { reply = undefined; }
      if (w.stopped) return;
      if (reply?.ok) {
        w.stopped = true;
        w.issued = reply.retire?.dir;
        tell(session, w, "approved");
        return;
      }
      if (reply && !reply.ok && !reply.pending && reply.refused) {
        stopWatch(session);
        tell(session, w, reply.refused === "expired" ? "expired" : "denied");
        return;
      }
      if (reply && !reply.ok && reply.pending) w.approval = reply.approval;
      if (Date.now() > Date.parse(w.approval.expiresAt) + watch.graceMs) {
        stopWatch(session);
        process.stderr.write("[cotal-connector] a personal connection request passed its expiry without a recorded decision; cotal_connect asks again\n");
        return;
      }
      w.timer = setTimeout(() => replay(session, w), watch.pollMs);
      w.timer.unref();
    });
  };
  const startWatch = (session: string, name: string, args: string[], approval: ConversationApprovalPending): void => {
    const current = watches.get(session);
    if (current && current.approval.id === approval.id && !current.stopped) { current.approval = approval; return; }
    stopWatch(session);
    const w: Watch = { name, args, approval, stopped: false };
    watches.set(session, w);
    w.timer = setTimeout(() => replay(session, w), watch.pollMs);
    w.timer.unref();
  };
  const open = async (name: string, context?: string, selection?: ConversationSelection, approvalId?: string, space?: string): Promise<GatewayConnection> => {
    const binding = context ? bindings.get(context) : undefined;
    if (context && !binding) throw new Error("the native conversation has not bound its lifecycle and transcript; no identity was requested");
    // approval_id resumes only this conversation's own pending request. It proves nothing: the CLI
    // replays the saved request and the authority's record decides.
    const watched = context ? watches.get(context) : undefined;
    if (approvalId !== undefined && watched && watched.approval.id !== approvalId)
      throw new Error("approval_id does not name this conversation's pending request; nothing was connected. Call cotal_connect with the approval_id from this conversation's own pending result, or without one");
    const prior = context ? [...held].find(([, h]) => h.session === context) : undefined;
    if (prior && !prior[1].stopped) throw new Error("this native conversation already has a connection; disconnect it before connecting again");
    // A stopped connection is this conversation's own unfinished departure: finish it first.
    if (prior) await close(prior[0]);
    const previous = context ? pending.get(context) : undefined;
    if (previous) {
      try { await retire(previous); }
      catch (error) { throw new Error(`this conversation's previous identity cleanup is not finished: ${reason(error)}. Call cotal_connect again to retry it`); }
      pending.delete(context!);
    }
    const args = ["provision", "--require-approval", "--name", name, ...(space === undefined ? [] : ["--space", space]), ...(binding ? ["--session", binding.session, "--events"] : []),
      ...(selection ? ["--selection", JSON.stringify(selection)] : [])];
    if (watched && JSON.stringify(watched.args) !== JSON.stringify(args)) {
      if (approvalId !== undefined)
        throw new Error("approval_id resumes only the unchanged request; omit it to replace the pending name or permissions");
      stopWatch(context!);
      // An approved replay may have issued an identity without the conversation claiming it yet.
      // Retire that identity before requesting anything else, never ask the person to connect it.
      if (watched.issued) {
        try { await retire(watched.issued); }
        catch (error) { pending.set(context!, watched.issued); throw error; }
      }
    }
    const reply = await plumbing(args);
    if (!reply.ok) {
      if (reply.pending) {
        // A bound session can be told the decision, so the host follows the request for it.
        if (binding) startWatch(binding.session, name, args, reply.approval);
        throw new ApprovalRequired({ requestId: reply.requestId, approval: reply.approval, proposed: reply.proposed });
      }
      if (reply.refused && binding) stopWatch(binding.session);
      if (reply.taken) throw new NameTaken(name);
      throw new Error(reply.error ?? "identity provisioning failed");
    }
    if (binding) stopWatch(binding.session);
    const dir = reply.retire?.dir;
    let agent: MeshAgent | undefined;
    let plane: ReturnType<typeof createClaudeEventPlane> | undefined;
    try {
      // Approval can take minutes. Do not publish the conversation's pre-approval transcript later.
      const source = binding ? await createBoundClaudeTranscriptSource(binding.path, "resume") : undefined;
      const env = launchEnv(o.env, reply.env);
      const config = configFromEnv(env);
      config.connector = "claude";
      // No run turn is addressed to a conversation. Its own bearer command exchanges its own
      // secret for a manager-call view, so manager calls carry only what its grant holds.
      config.turnRelay = false;
      if (eventPlaneArmed(config, env) && !binding) throw new Error("this mesh requires a bound native event source");
      agent = new MeshAgent(config, env, { withholdProcessCwd: true });
      agent.on("error", () => process.stderr.write("[cotal-connector] personal connection error; inspect cotal_connection_status\n"));
      if (eventPlaneArmed(config, env)) plane = createClaudeEventPlane(agent, config, env, source);
      // Native ingress owns messages. Lifecycle forwarding has no command-hook reply consumer,
      // so it must not acquire a second delivery hold for context that nobody can receive.
      const hooks = binding ? createClaudeHandle({ env, events: () => plane?.events, delivery: false, turns: true }) : undefined;
      hooks?.adoptTranscript(binding!.path, "resume");
      void agent.start();
      for (let waited = 0; !agent.connected && waited < JOIN_MS; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!agent.connected) throw new Error(`the personal conversation did not join within ${JOIN_MS / 1000} s; its identity was retained for exact cleanup`);
      const conn: GatewayConnection = { id: randomUUID(), agent, config, ...(reply.grant ? { tools: grantedTools(reply.grant) } : {}) };
      held.set(conn.id, { conn, dir, session: binding?.session, hooks, plane });
      if (binding && hooks) await hooks.handle(agent, binding.event);
      if (config.userAuth) reap(config.space);
      return conn;
    } catch (error) {
      plane?.stop();
      await plane?.events.close().catch(() => {});
      await agent?.stop().catch(() => {});
      try { await retire(dir); }
      catch { if (context && dir) pending.set(context, dir); }
      throw error;
    }
  };
  const close = async (id: string): Promise<boolean> => {
    const h = held.get(id);
    if (!h) return false;
    if (h.closing) return h.closing;
    h.closing = (async () => {
      if (!h.stopped) {
        h.plane?.stop();
        await h.plane?.events.close();
        await h.conn.agent.stop();
        h.stopped = true;
      }
      try { await retire(h.dir); }
      catch (error) { h.unfinished = reason(error); throw new Error(unfinished(id, h.unfinished)); }
      held.delete(id);
      return true;
    })();
    try { return await h.closing; }
    finally { h.closing = undefined; }
  };
  return {
    account: () => "local",
    open: (_account, name, context, selection, approvalId, space) => serial(() => open(name, context, selection, approvalId, space)),
    async find(_account, id) {
      const h = held.get(id);
      if (h?.stopped) throw new Error(h.closing ? "This conversation is disconnecting from the mesh." : unfinished(id, h.unfinished ?? "it was interrupted"));
      return h?.conn;
    },
    close: (_account, id) => close(id),
    ...(o.participate ? { participate: (_account: string, connection: GatewayConnection) => o.participate!(connection) } : {}),
    sessionFor: (id) => held.get(id)?.session,
    async nativeEvent(event) {
      const session = event.session_id;
      if (typeof session !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session) || typeof event.hook_event_name !== "string")
        throw new Error("invalid native session binding");
      if (event.agent_id !== undefined) return;
      const previous = bindings.get(session);
      const path = typeof event.transcript_path === "string" ? event.transcript_path : previous?.path;
      if (!path || !isAbsolute(path) || basename(path) !== `${session}.jsonl` || (previous && previous.path !== path))
        throw new Error("native transcript does not match its explicit session identity");
      const bound = { ...event, transcript_path: path } as HookEvent;
      bindings.set(session, { session, path, event: bound });
      for (const [id, h] of held) {
        if (h.session !== session || h.stopped) continue;
        // The gateway owns peer inbox consumption. An authorized run turn is the sole lifecycle
        // payload: send the hook's exact context through the bound native reader, then feed the
        // delivery verdict back to the existing two-phase turn correlation.
        const reply = await h.hooks?.handle(h.conn.agent, bound);
        const context = (reply?.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext;
        if (event.hook_event_name === "SessionStart" && typeof context === "string")
          h.hooks?.onReply(bound, o.turn?.(session, id, context) === true);
        if (event.hook_event_name === "SessionEnd") await close(id);
      }
      if (event.hook_event_name === "SessionEnd") {
        bindings.delete(session);
        // The conversation that could claim an issued identity is gone: retire it exactly. A request
        // still pending stays saved; the CLI finishes it before this session's next request.
        const w = stopWatch(session);
        if (w?.issued) {
          const dir = w.issued;
          await serial(() => retire(dir)).catch(() => pending.set(session, dir));
        }
      }
    },
    async closeAll() {
      for (const session of [...watches.keys()]) stopWatch(session);
      const results = await Promise.allSettled([...held.keys()].map(close));
      if (results.some((r) => r.status === "rejected") || pending.size)
        throw new Error("some personal identities have pending cleanup; their saved lifecycle records were retained");
    },
  };
}

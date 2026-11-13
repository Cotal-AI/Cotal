/**
 * The local gateway for a personal Codex conversation: one the person started in Codex, not one a
 * manager launched. Issuance, the person's approval and retirement stay in the Cotal CLI
 * (`cotal app-identity`). The conversation is named by Codex itself: every tool call carries the
 * thread id in its request metadata, which the model's arguments cannot reach, and Codex's own
 * thread record supplies its rollout and working directory.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ApprovalRequired, configFromEnv, eventPlaneArmed, GATEWAY_TOOLS, JsonlFileSource, MeshAgent, NameTaken, type GatewayConnection, type GatewayHost } from "@cotal-ai/connector-core";
import type { ConversationApprovalPending, ConversationGrant, ConversationPending, ConversationSelection } from "@cotal-ai/core";
import type { CodexThreadFacts } from "./native-queue.js";
import { startCodexPersonalEvents, type CodexPersonalEvents } from "./personal-events.js";

const PLUMBING_MS = 60_000;
const JOIN_MS = 20_000;
/** How often a pending request is replayed to the authority while the person decides, and how long
 *  past its expiry a replay may still bring the recorded decision. */
const WATCH = { pollMs: 10_000, graceMs: 60_000 };
const THREAD = /^[A-Za-z0-9_-]{1,128}$/;

/** What the person decided about the conversation's pending request. */
export interface ApprovalNotice { name: string; status: "approved" | "denied" | "expired" | "refused"; id: string }

export interface CodexPersonalHostOptions {
  cotal: () => readonly string[];
  env: NodeJS.ProcessEnv;
  /** Codex's own record of a thread. */
  thread: (id: string) => Promise<CodexThreadFacts>;
  /** Tell the conversation what the person decided. */
  notify?: (thread: string, notice: ApprovalNotice) => void;
  /** A connection stopped serving: withdraw anything queued for it. */
  released?: (thread: string, connection: string) => void;
  watch?: typeof WATCH;
}

export interface CodexPersonalHost extends GatewayHost {
  threadFor(connection: string): string | undefined;
  closeAll(): Promise<void>;
}

interface Held {
  conn: GatewayConnection;
  thread: string;
  dir?: string;
  events?: CodexPersonalEvents;
  closing?: Promise<boolean>;
  stopped?: boolean;
  unfinished?: string;
}

type Reply = { ok: true; env: Record<string, string>; retire?: { dir: string }; grant?: ConversationGrant }
  | ({ ok: false; pending: true } & ConversationPending)
  | { ok: false; pending?: false; taken?: true; error?: string; refused?: "denied" | "expired" | "refused"; retryable?: boolean };

interface Watch {
  name: string;
  args: string[];
  cwd: string;
  approval: ConversationApprovalPending;
  timer?: NodeJS.Timeout;
  /** An identity the authority issued that no connection has claimed. */
  issued?: string;
  stopped: boolean;
}

/** The thread a tool call came from, from the metadata Codex attaches to it. */
export function codexThreadOf(meta: Readonly<Record<string, unknown>> | undefined): string {
  const id = meta?.threadId;
  if (typeof id !== "string" || !THREAD.test(id))
    throw new Error("this call carries no Codex conversation identity; this server serves only the Codex conversation that started it");
  const turn = meta?.["x-codex-turn-metadata"];
  const named = turn && typeof turn === "object" ? (turn as Record<string, unknown>).thread_id : undefined;
  if (named !== undefined && named !== id) throw new Error("the call's Codex conversation metadata is inconsistent");
  return id;
}

/** The native tools a conversation's own grant can use. The manager that serves each call still
 *  decides it from that grant. No workflow turn is addressed to a personal conversation. */
function grantedTools(grant: ConversationGrant): ReadonlySet<string> {
  return new Set([
    ...GATEWAY_TOOLS,
    "cotal_reconnect",
    ...(grant.scope.includes("spawn") ? ["cotal_spawn", "cotal_persona", "cotal_personas", "cotal_despawn"] : []),
    ...(grant.scope.includes("run") ? ["cotal_run"] : []),
  ]);
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function unfinished(id: string, why: string): string {
  return `This conversation is disconnected from the mesh, but its identity cleanup is not finished: ${why}. ` +
    `Call cotal_disconnect with connection_id ${id} to retry it now, or cotal_connect to retry it and then connect again.`;
}

function launchEnv(base: NodeJS.ProcessEnv, printed: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("COTAL_") || k === "COTAL_HOME") env[k] = v;
  return { ...env, ...printed };
}

export function createCodexPersonalHost(o: CodexPersonalHostOptions): CodexPersonalHost {
  const held = new Map<string, Held>();
  const watches = new Map<string, Watch>();
  const refusals = new Map<string, { name: string; id: string; error: string }>();
  /** Identities whose retirement did not finish, by thread. */
  const pending = new Map<string, string>();
  const watch = o.watch ?? WATCH;
  /** The one thread this server serves: Codex starts one server per thread. */
  let served: string | undefined;
  let lastCwd = process.cwd();
  let opening: Promise<unknown> = Promise.resolve();
  /** Every CLI provision runs alone: a replay and a `cotal_connect` share a record lock. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = opening.then(fn);
    opening = next.catch(() => {});
    return next;
  };
  let reaping: Promise<void> | undefined;
  const plumbing = (args: string[], cwd: string): Promise<Reply> => new Promise((resolve, reject) => {
    const cotal = o.cotal();
    execFile(cotal[0]!, [...cotal.slice(1), "app-identity", ...args], { cwd, env: o.env, timeout: PLUMBING_MS }, (_error, stdout) => {
      try { resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Reply); }
      catch { reject(new Error("the Cotal CLI did not return an identity result; any saved request was retained for recovery")); }
    });
  });
  const retire = async (dir: string | undefined, cwd: string): Promise<void> => {
    if (!dir) return;
    const reply = await plumbing(["retire", "--dir", dir], cwd);
    if (!reply.ok) throw new Error(("error" in reply && reply.error) || "identity retirement is unconfirmed");
  };
  // Retiring other conversations' dead identities runs after a connection and never delays one.
  const reap = (space: string, cwd: string): void => {
    if (reaping) return;
    reaping = plumbing(["reap", "--space", space], cwd).then(() => {}, () => {}).finally(() => { reaping = undefined; });
  };
  const stopWatch = (thread: string): Watch | undefined => {
    const w = watches.get(thread);
    if (!w) return undefined;
    w.stopped = true;
    if (w.timer) clearTimeout(w.timer);
    watches.delete(thread);
    return w;
  };
  const tell = (thread: string, w: Watch, status: ApprovalNotice["status"]): void => {
    try { o.notify?.(thread, { name: w.name, status, id: w.approval.id }); }
    catch { process.stderr.write("[cotal-codex] the person's decision could not be queued for this conversation\n"); }
  };
  // One replay of the saved request. Only the authority's recorded answer decides anything: an
  // issued identity waits for the conversation's own cotal_connect, a refusal is final.
  const replay = (thread: string, w: Watch): void => {
    w.timer = undefined;
    void serial(async () => {
      if (w.stopped) return;
      let reply: Reply | undefined;
      try { reply = await plumbing(w.args, w.cwd); } catch { reply = undefined; }
      if (w.stopped) return;
      if (reply?.ok) {
        w.stopped = true;
        w.issued = reply.retire?.dir;
        tell(thread, w, "approved");
        return;
      }
      if (reply && !reply.ok && !reply.pending && (reply.refused || reply.retryable === false)) {
        stopWatch(thread);
        const status = reply.refused === "denied" || reply.refused === "expired" ? reply.refused : "refused";
        if (status === "refused") refusals.set(thread, { name: w.name, id: w.approval.id, error: reply.error ?? "The mesh refused this connection. No automatic retry will be made." });
        tell(thread, w, status);
        return;
      }
      if (reply && !reply.ok && reply.pending) w.approval = reply.approval;
      if (Date.now() > Date.parse(w.approval.expiresAt) + watch.graceMs) {
        stopWatch(thread);
        return;
      }
      w.timer = setTimeout(() => replay(thread, w), watch.pollMs);
      w.timer.unref();
    });
  };
  const startWatch = (thread: string, w: Omit<Watch, "stopped">): void => {
    const current = watches.get(thread);
    if (current && current.approval.id === w.approval.id && !current.stopped) { current.approval = w.approval; return; }
    stopWatch(thread);
    const next: Watch = { ...w, stopped: false };
    watches.set(thread, next);
    next.timer = setTimeout(() => replay(thread, next), watch.pollMs);
    next.timer.unref();
  };
  const open = async (thread: string, name: string, selection?: ConversationSelection, approvalId?: string, space?: string): Promise<GatewayConnection> => {
    const refusal = refusals.get(thread);
    if (approvalId !== undefined && refusal) {
      if (refusal.id !== approvalId || refusal.name !== name) throw new Error("approval_id does not name this conversation's refused request");
      throw new Error(refusal.error);
    }
    const watched = watches.get(thread);
    if (approvalId !== undefined && watched && watched.approval.id !== approvalId)
      throw new Error("approval_id does not name this conversation's pending request; nothing was connected. Call cotal_connect with the approval_id from this conversation's own pending result, or without one");
    const prior = [...held.values()].find((h) => h.thread === thread);
    if (prior && !prior.stopped) throw new Error("this Codex conversation already has a connection; disconnect it before connecting again");
    if (prior) await close(prior.conn.id);
    const facts = await o.thread(thread);
    lastCwd = facts.cwd;
    const previous = pending.get(thread);
    if (previous) {
      try { await retire(previous, facts.cwd); }
      catch (error) { throw new Error(`this conversation's previous identity cleanup is not finished: ${reason(error)}. Call cotal_connect again to retry it`); }
      pending.delete(thread);
    }
    const args = ["provision", "--require-approval", "--name", name, ...(space === undefined ? [] : ["--space", space]), "--session", thread,
      ...(facts.path ? ["--events"] : []), ...(selection ? ["--selection", JSON.stringify(selection)] : [])];
    if (watched && JSON.stringify(watched.args) !== JSON.stringify(args)) {
      if (approvalId !== undefined) throw new Error("approval_id resumes only the unchanged request; omit it to replace the pending name or permissions");
      stopWatch(thread);
      // An approved replay may have issued an identity the conversation never claimed.
      if (watched.issued) {
        try { await retire(watched.issued, facts.cwd); }
        catch (error) { pending.set(thread, watched.issued); throw error; }
      }
    }
    refusals.delete(thread);
    const reply = await plumbing(args, facts.cwd);
    if (!reply.ok) {
      if (reply.pending) {
        startWatch(thread, { name, args, cwd: facts.cwd, approval: reply.approval });
        throw new ApprovalRequired({ requestId: reply.requestId, approval: reply.approval, proposed: reply.proposed }, space);
      }
      if (reply.refused || reply.retryable === false) stopWatch(thread);
      if (reply.taken) throw new NameTaken(name);
      throw new Error(reply.error ?? "identity provisioning failed");
    }
    stopWatch(thread);
    const dir = reply.retire?.dir;
    let agent: MeshAgent | undefined;
    let events: CodexPersonalEvents | undefined;
    try {
      // Approval can take minutes: activity is published from here, never from before it.
      const start = facts.path ? await new JsonlFileSource(facts.path).end() : undefined;
      const env = launchEnv(o.env, reply.env);
      const config = configFromEnv(env);
      config.connector = "codex";
      config.turnRelay = false;
      if (eventPlaneArmed(config, env) && !facts.path) throw new Error("this mesh requires the conversation's activity, and Codex keeps no record of this conversation");
      agent = new MeshAgent(config, env, { withholdProcessCwd: true });
      agent.on("error", () => process.stderr.write("[cotal-codex] personal connection error; inspect cotal_connection_status\n"));
      void agent.start();
      for (let waited = 0; !agent.connected && waited < JOIN_MS; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!agent.connected) throw new Error(`the conversation did not join within ${JOIN_MS / 1000} s; its identity was retained for exact cleanup`);
      if (eventPlaneArmed(config, env)) events = startCodexPersonalEvents(agent, config, env, thread, facts.path!, start!);
      const conn: GatewayConnection = { id: randomUUID(), agent, config, ...(reply.grant ? { tools: grantedTools(reply.grant) } : {}) };
      held.set(conn.id, { conn, thread, dir, events });
      if (config.userAuth) reap(config.space, facts.cwd);
      return conn;
    } catch (error) {
      await events?.stop().catch(() => {});
      await agent?.stop().catch(() => {});
      try { await retire(dir, facts.cwd); }
      catch { if (dir) pending.set(thread, dir); }
      throw error;
    }
  };
  const close = async (id: string): Promise<boolean> => {
    const h = held.get(id);
    if (!h) return false;
    if (h.closing) return h.closing;
    h.closing = (async () => {
      if (!h.stopped) {
        try { o.released?.(h.thread, id); } catch { /* the queue is checked again before any later notice */ }
        await h.events?.stop();
        await h.conn.agent.stop();
        h.stopped = true;
      }
      try { await retire(h.dir, lastCwd); }
      catch (error) { h.unfinished = reason(error); throw new Error(unfinished(id, h.unfinished)); }
      held.delete(id);
      return true;
    })();
    try { return await h.closing; }
    finally { h.closing = undefined; }
  };
  const owned = (account: string, id: string): Held | undefined => {
    const h = held.get(id);
    return h && h.thread === account ? h : undefined;
  };
  return {
    account(_auth, meta) {
      const thread = codexThreadOf(meta);
      served ??= thread;
      if (thread !== served) throw new Error("this Cotal server serves another Codex conversation");
      return thread;
    },
    open: (account, name, _context, selection, approvalId, space) => serial(() => open(account, name, selection, approvalId, space)),
    async find(account, id) {
      const h = owned(account, id);
      if (h?.stopped) throw new Error(h.closing ? "This conversation is disconnecting from the mesh." : unfinished(id, h.unfinished ?? "it was interrupted"));
      return h?.conn;
    },
    close: (account, id) => (owned(account, id) ? close(id) : Promise.resolve(false)),
    threadFor: (id) => held.get(id)?.thread,
    async closeAll() {
      refusals.clear();
      const issued: string[] = [];
      for (const thread of [...watches.keys()]) { const w = stopWatch(thread); if (w?.issued) issued.push(w.issued); }
      const results = await Promise.allSettled([...held.keys()].map(close));
      // The conversation that could claim an issued identity is gone: retire it exactly.
      for (const dir of [...issued, ...pending.values()]) {
        try { await serial(() => retire(dir, lastCwd)); } catch { results.push({ status: "rejected", reason: dir }); }
      }
      if (results.some((r) => r.status === "rejected"))
        throw new Error("some personal identities have pending cleanup; their saved lifecycle records were retained");
    },
  };
}

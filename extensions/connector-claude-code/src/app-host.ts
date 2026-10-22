/** The local gateway for personal Claude conversations. Issuance and retirement stay in the CLI;
 * native lifecycle and transcripts stay in this adapter and are bound to an explicit session. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { configFromEnv, eventPlaneArmed, MeshAgent, NameTaken, type GatewayConnection, type GatewayHost, type HookEvent } from "@cotal-ai/connector-core";
import { runAgentBearer } from "@cotal-ai/core";
import { createClaudeHandle, type ClaudeHooks } from "./hooks.js";
import { createClaudeEventPlane } from "./claude-events.js";
import { createBoundClaudeTranscriptSource } from "./agui-source.js";

const PLUMBING_MS = 60_000;
const JOIN_MS = 20_000;

export interface AppHostOptions {
  cotal: () => readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
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

type Reply = { ok: true; env: Record<string, string>; retire?: { dir: string } } | { ok: false; taken?: true; error?: string };

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
  let opening: Promise<unknown> = Promise.resolve();
  let reaping: Promise<void> | undefined;
  let reapAgain = false;
  const plumbing = (args: string[]): Promise<Reply> => new Promise((resolve, reject) => {
    const cotal = o.cotal();
    execFile(cotal[0]!, [...cotal.slice(1), "app-identity", ...args], { cwd: o.cwd, env: o.env, timeout: PLUMBING_MS }, (_error, stdout) => {
      try { resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Reply); }
      catch { reject(new Error("the Cotal CLI did not return an identity result; its saved request was retained for recovery")); }
    });
  });
  const retire = async (dir?: string): Promise<void> => {
    if (!dir) return;
    const reply = await plumbing(["retire", "--dir", dir]);
    if (!reply.ok) throw new Error(reply.error ?? "identity retirement is unconfirmed");
  };
  // Retiring other conversations' dead identities runs after a connection and never delays one. A
  // request made while a run is in flight starts one more run when it ends.
  const reap = (): void => {
    if (reaping) { reapAgain = true; return; }
    reaping = plumbing(["reap"]).then(() => {}, () => {}).finally(() => {
      reaping = undefined;
      if (reapAgain) { reapAgain = false; reap(); }
    });
  };
  const open = async (name: string, context?: string): Promise<GatewayConnection> => {
    const binding = context ? bindings.get(context) : undefined;
    if (context && !binding) throw new Error("the native conversation has not bound its lifecycle and transcript; no identity was requested");
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
    // Capture the personal privacy boundary before provisioning or waiting for a network connection.
    const source = binding ? await createBoundClaudeTranscriptSource(binding.path, "resume") : undefined;
    const reply = await plumbing(["provision", "--name", name, ...(binding ? ["--session", binding.session, "--events"] : [])]);
    if (!reply.ok) {
      if (reply.taken) throw new NameTaken(name);
      throw new Error(reply.error ?? "identity provisioning failed");
    }
    const dir = reply.retire?.dir;
    let agent: MeshAgent | undefined;
    let plane: ReturnType<typeof createClaudeEventPlane> | undefined;
    try {
      const env = launchEnv(o.env, reply.env);
      const config = configFromEnv(env);
      config.connector = "claude";
      config.turnRelay = false;
      if (config.userAuth?.bearerCmd) {
        const { owner, actor, sentinelCreds, bearerCmd } = config.userAuth;
        // A personal conversation has a leaf credential, not a manager-call instrument.
        config.userAuth = { owner, actor, sentinelCreds, bearer: async () => {
          const token = await runAgentBearer(bearerCmd, { env });
          if (!token) throw new Error("the personal conversation's bearer command returned no token");
          return token;
        } };
      }
      if (eventPlaneArmed(config, env) && !binding) throw new Error("this mesh requires a bound native event source");
      agent = new MeshAgent(config, env, { withholdProcessCwd: true });
      agent.on("error", () => process.stderr.write("[cotal-connector] personal connection error; inspect cotal_connection_status\n"));
      if (eventPlaneArmed(config, env)) plane = createClaudeEventPlane(agent, config, env, source);
      const hooks = binding ? createClaudeHandle({ env, events: () => plane?.events }) : undefined;
      hooks?.adoptTranscript(binding!.path, "resume");
      void agent.start();
      for (let waited = 0; !agent.connected && waited < JOIN_MS; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!agent.connected) throw new Error(`the personal conversation did not join within ${JOIN_MS / 1000} s; its identity was retained for exact cleanup`);
      const conn: GatewayConnection = { id: randomUUID(), agent, config };
      held.set(conn.id, { conn, dir, session: binding?.session, hooks, plane });
      if (binding && hooks) await hooks.handle(agent, binding.event);
      if (config.userAuth) reap();
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
    open(_account, name, context) {
      const next = opening.then(() => open(name, context));
      opening = next.catch(() => {});
      return next;
    },
    async find(_account, id) {
      const h = held.get(id);
      if (h?.stopped) throw new Error(h.closing ? "This conversation is disconnecting from the mesh." : unfinished(id, h.unfinished ?? "it was interrupted"));
      return h?.conn;
    },
    close: (_account, id) => close(id),
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
        // The gateway owns inbox consumption. Lifecycle replies are never injected or acknowledged.
        await h.hooks?.handle(h.conn.agent, bound);
        if (event.hook_event_name === "SessionEnd") await close(id);
      }
      if (event.hook_event_name === "SessionEnd") bindings.delete(session);
    },
    async closeAll() {
      const results = await Promise.allSettled([...held.keys()].map(close));
      if (results.some((r) => r.status === "rejected") || pending.size)
        throw new Error("some personal identities have pending cleanup; their saved lifecycle records were retained");
    },
  };
}

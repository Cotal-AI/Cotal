/**
 * The local gateway host a plain Claude session serves: a Claude Code session the launcher did not
 * start, or Claude Desktop through its extension. Each `cotal_connect` runs `cotal app-identity
 * provision` with the CLI that installed the plugin, joins the mesh with the env it prints, and
 * keeps the connection in this process until `cotal_disconnect`, the end of stdin, or a signal,
 * which retire it.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { configFromEnv, MeshAgent, NameTaken, type GatewayConnection, type GatewayHost } from "@cotal-ai/connector-core";

/** How long one `app-identity` run may take, and how long a fresh agent may take to join. */
const PLUMBING_MS = 60_000;
const JOIN_MS = 20_000;

export interface AppHostOptions {
  /** The argv that runs the CLI. Read when a conversation connects, so a server whose record is
   *  missing still answers MCP and refuses `cotal_connect` with the remedy. */
  cotal: () => readonly string[];
  /** Where `app-identity` runs. A Claude Code session passes its own directory, so a project's mesh
   *  is found as `cotal spawn` finds it; Claude Desktop passes a directory that is no project. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AppHost extends GatewayHost {
  /** Disconnect and retire every connection. Safe to call more than once. */
  closeAll(): Promise<void>;
}

interface Held {
  conn: GatewayConnection;
  /** The credential directory `retire` takes; absent on a mesh with no credentials. */
  dir?: string;
}

type Reply = { ok: true; env: Record<string, string>; retire?: { dir: string } } | { ok: false; taken?: true; error?: string };

/** The connection's own launch env: the process env without a launcher identity, plus what provision
 *  printed. A plain session has no `COTAL_NAME`, but it can carry other `COTAL_*` settings. */
function launchEnv(base: NodeJS.ProcessEnv, printed: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("COTAL_") || k === "COTAL_HOME") env[k] = v;
  return { ...env, ...printed };
}

export function createAppHost(o: AppHostOptions): AppHost {
  const held = new Map<string, Held>();
  let opening: Promise<unknown> = Promise.resolve();

  const plumbing = (args: string[]): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const cotal = o.cotal();
      execFile(cotal[0]!, [...cotal.slice(1), "app-identity", ...args], { cwd: o.cwd, env: o.env, timeout: PLUMBING_MS }, (error, stdout) => {
        const line = stdout.trim().split("\n").at(-1);
        try {
          resolve(JSON.parse(line ?? "") as Reply);
        } catch {
          reject(new Error(`the Cotal CLI did not answer${error ? `: ${error.message.split("\n")[0]}` : ""}`));
        }
      });
    });

  const retire = async (dir: string | undefined): Promise<void> => {
    if (!dir) return;
    const r = await plumbing(["retire", "--dir", dir]);
    if (!r.ok) throw new Error(r.error ?? "retire failed");
  };

  const open = async (name: string): Promise<GatewayConnection> => {
    const r = await plumbing(["provision", "--name", name]);
    if (!r.ok) {
      if (r.taken) throw new NameTaken(name);
      throw new Error(r.error ?? "provision failed");
    }
    const dir = r.retire?.dir;
    let agent: MeshAgent | undefined;
    try {
      const config = configFromEnv(launchEnv(o.env, r.env));
      config.connector = "claude";
      agent = new MeshAgent(config);
      agent.on("error", (e: Error) => process.stderr.write(`[cotal-connector] ${name}: ${e.message}\n`));
      void agent.start();
      for (let waited = 0; !agent.connected && waited < JOIN_MS; waited += 100) await new Promise((r) => setTimeout(r, 100));
      if (!agent.connected) throw new Error(`${name} did not join the mesh "${config.space}" within ${JOIN_MS / 1000} s${agent.connectionIssue ? `: ${agent.connectionIssue}` : ""}`);
      const conn: GatewayConnection = { id: randomUUID(), agent, config };
      held.set(conn.id, { conn, ...(dir ? { dir } : {}) });
      return conn;
    } catch (e) {
      await agent?.stop().catch(() => {});
      await retire(dir).catch(() => {});
      throw e;
    }
  };

  const close = async (id: string): Promise<boolean> => {
    const h = held.get(id);
    if (!h) return false;
    held.delete(id);
    await h.conn.agent.stop();
    await retire(h.dir);
    return true;
  };

  return {
    account: () => "local",
    // One open at a time, so a name this process just opened is live before the next one is checked.
    open(_account, name) {
      const next = opening.then(() => open(name));
      opening = next.catch(() => {});
      return next;
    },
    async find(_account, id) {
      return held.get(id)?.conn;
    },
    close: (_account, id) => close(id),
    async closeAll() {
      await Promise.allSettled([...held.keys()].map((id) => close(id)));
    },
  };
}

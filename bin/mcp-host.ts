/** Identity custody for an MCP-only host. One stdio process owns one local mesh connection. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  configFromEnv, MeshAgent, NameTaken,
  type GatewayConnection, type GatewayHost,
} from "@cotal-ai/connector-core";
import type { ConversationSelection } from "@cotal-ai/core";
import { resolveTargetOrThrow } from "@cotal-ai/workspace";
import { retireLocalAppIdentity } from "@cotal-ai/cli/app-identity";
import { selfArgv } from "@cotal-ai/cli/self-exec";

type IdentityReply =
  | { ok: true; env: Record<string, string>; retire?: { dir: string } }
  | { ok: false; taken?: boolean; error?: string };

interface Held {
  connection?: GatewayConnection;
  dir: string;
  stopped: boolean;
}

/** The host never invents a native conversation for a signed-in space. Static identities use the
 * terminal-seat contract: the credential and generation last to its horizon, without renewal. */
export function createMcpHost(space?: string): GatewayHost & { closeAll(): Promise<void> } {
  const session = `mcp-${randomUUID()}`;
  const account = "stdio";
  const cotal = selfArgv();
  let held: Held | undefined;
  let ending = false;
  let operations: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = operations.then(fn);
    operations = next.catch(() => {});
    return next;
  };
  const plumbing = (args: string[]): Promise<IdentityReply> => new Promise((resolve, reject) => {
    execFile(cotal[0]!, [...cotal.slice(1), "app-identity", ...args], { timeout: 60_000 }, (_error, stdout) => {
      try { resolve(JSON.parse(stdout) as IdentityReply); }
      catch { reject(new Error("the CLI returned no identity result; any recovery record was retained")); }
    });
  });
  const release = async (): Promise<void> => {
    if (!held) return;
    // A failed retirement remains owned, but may never route another tool to a stopped agent.
    held.stopped = true;
    await held.connection?.agent.stop();
    try { await retireLocalAppIdentity(held.dir); }
    catch { throw new Error("identity cleanup is unfinished; call cotal_disconnect again to retry it"); }
    held = undefined;
  };
  const open = async (name: string, selection?: ConversationSelection): Promise<GatewayConnection> => {
    if (ending) throw new Error("the MCP host is shutting down");
    if (held && !held.stopped) throw new Error("this stdio host already has a connection; disconnect it before connecting again");
    await release();
    const target = await resolveTargetOrThrow(space === undefined ? {} : { space });
    if (target.mode === "user")
      throw new Error("cotal mcp has no native conversation identity for a signed-in space; use its hosted connector or a native Cotal connector instead");
    const result = await plumbing(["provision", "--name", name, "--space", target.space, "--session", session,
      ...(selection ? ["--selection", JSON.stringify(selection)] : [])]);
    if (!result.ok) {
      if (result.taken) throw new NameTaken(name);
      throw new Error(result.error ?? "identity provisioning failed");
    }
    if (!result.retire?.dir) throw new Error("the CLI returned no identity retirement handle");
    held = { dir: result.retire.dir, stopped: false };
    try {
      // Inherited launch metadata must never override the identity just issued for this host.
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
      Object.assign(env, result.env);
      const config = configFromEnv(env);
      config.connector = "mcp";
      config.turnRelay = false;
      const agent = new MeshAgent(config, env, { withholdProcessCwd: true });
      const connection = { id: randomUUID(), agent, config };
      held.connection = connection;
      agent.on("error", () => process.stderr.write("[cotal mcp] connection error; inspect cotal_connection_status\n"));
      // Keep the startup promise observed even when the bounded readiness wait fails first.
      const start = agent.start();
      void start.catch(() => {});
      await agent.waitUntilConnected(20_000);
      await start;
      if (ending) throw new Error("the MCP host is shutting down");
      return connection;
    } catch (error) {
      try { await release(); }
      catch { throw new Error("connection startup failed and identity cleanup is unfinished; connect again to retry cleanup"); }
      throw error;
    }
  };
  return {
    account: () => account,
    open: (caller, name, _context, selection) => serial(async () => {
      if (caller !== account) throw new Error("this connection belongs to another account");
      return open(name, selection);
    }),
    async find(caller, id) {
      if (caller !== account || held?.connection?.id !== id) return undefined;
      if (held.stopped || ending) throw new Error("this connection stopped serving; disconnect to finish its identity cleanup");
      return held.connection;
    },
    close: (caller, id) => serial(async () => {
      if (caller !== account || held?.connection?.id !== id) return false;
      await release();
      return true;
    }),
    closeAll() {
      ending = true;
      return serial(release);
    },
  };
}

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { selfArgv } from "@cotal-ai/cli/self-exec";
import { acquireLockAsync, assertKeySegment, mkSecretDir } from "@cotal-ai/core";
import { configFromEnv, MeshAgent, NameTaken, type GatewayConnection, type GatewayHost } from "@cotal-ai/connector-core";
import { homeCotalDir, resolveTargetOrThrow } from "@cotal-ai/workspace";

type Reply = { ok: true; env?: Record<string, string>; retire?: { dir: string } }
  | { ok: false; taken?: boolean; error?: string };
interface Held { connection: GatewayConnection; dir: string; stopped: boolean }

/** One stdio server owns its connections. Issuance and exact retirement stay in app-identity. */
export function createMcpHost(space: string | undefined, released: (id: string) => void): GatewayHost & { closeAll(): Promise<void> } {
  const invocation = selfArgv();
  // A terminal's inherited seat is never this server's identity or authority.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") ||
    ["COTAL_HOME", "COTAL_DEFAULT_PERSONA", "COTAL_NO_UPDATE_CHECK", "COTAL_SKIP_CONNECTOR_SEED"].includes(key)));
  const held = new Map<string, Held>();
  const unfinished = new Set<string>();
  let closing = false;
  let openingAgent: MeshAgent | undefined;
  let flight: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = flight.then(fn);
    flight = next.catch(() => {});
    return next;
  };
  const plumbing = (args: string[]): Promise<Reply> => new Promise((resolve, reject) => {
    execFile(invocation[0]!, [...invocation.slice(1), "app-identity", ...args], { env, timeout: 60_000 }, (error, stdout) => {
      try {
        const reply = JSON.parse(stdout.trim()) as Reply;
        if (typeof reply.ok !== "boolean" || (error && reply.ok)) throw new Error();
        resolve(reply);
      } catch { reject(new Error("identity plumbing returned no confirmed result; saved lifecycle records were retained for recovery")); }
    });
  });
  const retire = async (dir: string): Promise<void> => {
    const reply = await plumbing(["retire", "--dir", dir]);
    if (!reply.ok) throw new Error(reply.error ?? "identity retirement is unconfirmed; its record was retained");
    unfinished.delete(dir);
  };
  const close = async (id: string): Promise<boolean> => {
    const h = held.get(id);
    if (!h) return false;
    released(id);
    await h.connection.agent.stop();
    h.stopped = true;
    await retire(h.dir);
    held.delete(id);
    return true;
  };
  return {
    account: () => "local",
    open: (account, name, _context, selection, _approval, requestedSpace) => serial(async () => {
      if (closing || account !== "local") throw new Error("this MCP server is shutting down");
      for (const dir of unfinished) await retire(dir);
      const target = await resolveTargetOrThrow({ ...(requestedSpace ?? space ? { space: requestedSpace ?? space } : {}) });
      if (target.mode === "auth") assertKeySegment(name, "MCP agent name");
      // Presence alone is advisory. Keep same-machine MCP issuers out between its read and the
      // successful bind that publishes the name, including when another server process opens it.
      const locks = join(homeCotalDir(), "app-identities");
      mkSecretDir(locks);
      const key = createHash("sha256").update(JSON.stringify([target.server, target.space, name])).digest("hex");
      const admission = await acquireLockAsync(join(locks, `mcp-name-${key}.lock`), {
        waitMs: 20_000, onTimeout: () => new Error("another local MCP connection is opening this name; retry after it finishes"),
      });
      try {
        // A generic host supplies no trustworthy native session metadata. Let the shared signed-in
        // admission path refuse and point at the hosted connector instead of inventing that identity.
        const args = ["provision", "--require-approval", "--name", name, "--space", target.space,
          ...(target.mode === "user" ? [] : ["--session", randomUUID()]),
          ...(selection ? ["--selection", JSON.stringify(selection)] : [])];
        const reply = await plumbing(args);
        if (!reply.ok) {
          if (reply.taken) throw new NameTaken(name);
          throw new Error(reply.error ?? "identity provisioning failed");
        }
        if (!reply.env || !reply.retire) throw new Error("identity plumbing omitted its connection or retirement record");
        const dir = reply.retire.dir;
        unfinished.add(dir);
        let agent: MeshAgent | undefined;
        try {
          if (closing) throw new Error("this MCP server is shutting down");
          const connectionEnv = { ...env, ...reply.env };
          const config = configFromEnv(connectionEnv);
          config.connector = "mcp";
          config.turnRelay = false;
          agent = new MeshAgent(config, connectionEnv, { withholdProcessCwd: true });
          openingAgent = agent;
          agent.on("error", () => process.stderr.write("[cotal-mcp] mesh connection error; inspect cotal_connection_status\n"));
          await Promise.race([agent.start(), agent.waitUntilConnected(20_000)]);
          if (closing || !agent.connected) throw new Error("the MCP connection stopped before it became ready");
          const connection = { id: randomUUID(), agent, config };
          held.set(connection.id, { connection, dir, stopped: false });
          unfinished.delete(dir);
          return connection;
        } catch (error) {
          await agent?.stop();
          await retire(dir);
          throw error;
        } finally { openingAgent = undefined; }
      } finally { admission.release(); }
    }),
    async find(account, id) {
      if (account !== "local") return undefined;
      const h = held.get(id);
      if (h && (h.stopped || h.connection.agent.stopping))
        throw new Error("this connection is disconnected; call cotal_disconnect with its connection_id to finish retirement");
      return h?.connection;
    },
    close: (account, id) => serial(() => account === "local" ? close(id) : Promise.resolve(false)),
    async closeAll() {
      closing = true;
      await openingAgent?.stop();
      await serial(async () => {
        const results = await Promise.allSettled([
          ...[...held.keys()].map(close), ...[...unfinished].map(retire),
        ]);
        if (results.some((r) => r.status === "rejected"))
          throw new Error("some MCP identities have pending retirement; their lifecycle records were retained for recovery");
      });
    },
  };
}

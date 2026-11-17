import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type { GatewayConnection, GatewayWake } from "@cotal-ai/connector-core";

/** A notification-only socket. A reader names one connection and never receives message content. */
export async function openMcpWake(path: string, find: (id: string) => Promise<GatewayConnection | undefined>): Promise<{
  wake: GatewayWake; released(id: string): void; close(): Promise<void>;
}> {
  if (process.platform === "win32") throw new Error("--wake-socket requires Unix domain sockets");
  if (!isAbsolute(path)) throw new Error("--wake-socket needs an absolute path in an owner-private directory");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
    throw new Error("--wake-socket needs an owner-private parent directory (mode 0700)");
  if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("--wake-socket already exists; no existing entry was removed");
  const readers = new Map<Socket, string | undefined>();
  let closing = false;
  let rearm: (() => void) | undefined;
  const finish = (socket: Socket, value: object): void => {
    readers.delete(socket);
    socket.end(`${JSON.stringify(value)}\n`, () => socket.destroy());
  };
  const server = createServer((socket) => {
    if (closing || readers.size >= 64) { socket.destroy(); return; }
    readers.set(socket, undefined);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => readers.delete(socket));
    socket.setTimeout(5_000, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.length > 256) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      const id = input.trim();
      void find(id).then((connection) => {
        if (socket.destroyed || closing || !readers.has(socket)) return;
        if (!connection || connection.agent.stopping) { finish(socket, { wake: false, error: "connection is not active" }); return; }
        socket.setTimeout(0);
        readers.set(socket, id);
        rearm?.();
      }, () => finish(socket, { wake: false, error: "connection is not active" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(path, 0o600);
  const owned = lstatSync(path);
  return {
    wake: {
      attach: (callback) => { rearm = callback; },
      listening: () => "Run cotal mcp wait with this connection_id and the configured --wake-socket as a background command. A wake signals unread mail and does not consume it.",
      signal(connection) {
        let heard = false;
        for (const [socket, id] of readers) if (id === connection.id) {
          finish(socket, { wake: true, connection_id: id });
          heard = true;
        }
        return heard;
      },
    },
    released(id) {
      for (const [socket, connection] of readers) if (connection === id)
        finish(socket, { wake: false, error: "connection disconnected" });
    },
    async close() {
      closing = true;
      for (const socket of readers.keys()) finish(socket, { wake: false, error: "MCP server stopped" });
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current?.dev === owned.dev && current.ino === owned.ino) unlinkSync(path);
    },
  };
}

/** One background command completes on a notification, disconnect or socket failure. */
export async function waitMcpWake(path: string, id: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path, () => socket.write(`${id}\n`));
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.length > 1024) socket.destroy(new Error("invalid MCP wake response"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const value = JSON.parse(input) as { wake?: unknown; connection_id?: unknown; error?: unknown };
        if (value.wake !== true || value.connection_id !== id)
          throw new Error(typeof value.error === "string" ? value.error : "MCP wake ended without a notification");
        process.stdout.write(`${JSON.stringify({ wake: true, connection_id: id })}\n`);
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

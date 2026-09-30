import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PeerCredentials } from "@cotal-ai/seat";

const publicApi = await import("@cotal-ai/seat") as Record<string, unknown>;
const readPeer = publicApi.peerCredentials as (socket: Socket) => PeerCredentials;

if (process.argv[2] === "client") {
  const socket = createConnection(process.argv[3]!);
  const timeout = setTimeout(() => { socket.destroy(); process.exitCode = 1; process.disconnect?.(); }, 10_000);
  socket.on("error", () => { clearTimeout(timeout); process.exitCode = 1; process.disconnect?.(); });
  socket.once("connect", () => process.send?.(readPeer(socket)));
  process.once("message", () => { clearTimeout(timeout); socket.end(); process.disconnect?.(); });
} else {
  let passed = 0, failed = 0;
  let root: string | undefined, socket: Socket | undefined, child: ChildProcess | undefined;
  const server = createServer();
  const check = (name: string, assertion: () => void) => {
    try { assertion(); passed++; console.log(`  ✓ ${name}`); }
    catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); throw error; }
  };
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native peer credential fixture timed out")), 10_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    check("public package root exports peerCredentials", () => assert.equal(typeof publicApi.peerCredentials, "function"));
    if (process.platform !== "linux") {
      check("public peer credentials refuse unsupported transport", () => assert.throws(() => readPeer(new Socket()), {
        message: `custody transport unsupported on ${process.platform}`,
      }));
      console.log("Platform refusal only; no native Linux peer identity checks.");
    } else {
      check("public peer credentials refuse a socket without a descriptor", () => assert.throws(() => readPeer(new Socket()), /unix socket has no file descriptor/));
      root = mkdtempSync(join(tmpdir(), "peer-public-"));
      const path = join(root, "p.sock");
      server.listen(path);
      await bounded(once(server, "listening"));
      const connection = once(server, "connection");
      child = fork(fileURLToPath(import.meta.url), ["client", path], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { PATH: process.env.PATH },
      });
      const message = once(child, "message");
      const exit = once(child, "exit");
      [socket] = await bounded(connection) as [Socket];
      const remote = readPeer(socket);
      check("server observes the actual child PID, not its own PID", () => {
        assert.equal(remote.pid, child!.pid);
        assert.notEqual(remote.pid, process.pid);
      });
      check("server observes the child's real UID", () => assert.equal(remote.uid, process.getuid!()));
      check("server observes the child's real GID", () => assert.equal(remote.gid, process.getgid!()));
      const [reverse] = await bounded(message) as [PeerCredentials];
      check("child observes the actual server PID", () => assert.equal(reverse.pid, process.pid));
      check("child observes the server's real UID and GID", () => {
        assert.equal(reverse.uid, process.getuid!());
        assert.equal(reverse.gid, process.getgid!());
      });
      child.send("close");
      const [code, signal] = await bounded(exit);
      check("native peer process exits cleanly", () => { assert.equal(code, 0); assert.equal(signal, null); });
    }
  } catch (error) {
    if (failed === 0) { failed++; console.error("  ✗ fixture failed", error); }
  } finally {
    socket?.destroy();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  }
  console.log(`PUBLIC PEER CREDENTIALS (${passed} passed, ${failed} failed)`);
  if (failed) process.exitCode = 1;
}

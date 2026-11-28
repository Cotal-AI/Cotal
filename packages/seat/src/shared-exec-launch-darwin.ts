import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "@lydell/node-pty";
import { processStartTime } from "./host.js";
import { encodeSharedExecFrame, readSharedExecFrame, SHARED_EXEC_TIMEOUT_MS, type SharedExecPayload } from "./shared-exec-protocol.js";
import { checkDarwinExecAddress, checkDarwinExecSocket } from "./shared-exec-socket-darwin.js";
import { darwinSharedIdentity, type DarwinSharedIdentity } from "./shared-identity-darwin.js";
import type { PreparedSeat } from "./shared-prepared-seat.js";
import { captureDarwinPtySession } from "./shared-session-darwin.js";

interface LaunchOptions {
  socketDirectory: string;
  bootstrapCwd: string;
  cols: number;
  rows: number;
  payload: SharedExecPayload;
}

function listen(server: Server, address: string, uid: number): Promise<void> {
  return new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      try {
        chmodSync(address, 0o600);
        checkDarwinExecSocket(address, uid);
        accept();
      } catch (error) { reject(error); }
      finally { server.off("error", reject); }
    });
  });
}

function dispatch(connection: Socket, frame: Buffer): Promise<void> {
  return new Promise((accept, reject) => {
    const fail = () => reject(new Error("Darwin exec commit was not confirmed written"));
    connection.once("close", fail);
    connection.write(frame, error => {
      connection.off("close", fail);
      if (error) reject(error);
      else accept();
    });
  });
}

/** Stage a real PTY root. Neither abort nor transport failure establishes cleanup authority. */
export async function prepareDarwinExec(options: LaunchOptions): Promise<PreparedSeat<DarwinSharedIdentity>> {
  const host = darwinSharedIdentity.current();
  if (!host || typeof (process as typeof process & { execve?: unknown }).execve !== "function")
    throw new Error("Darwin exec in place unavailable");
  const { uid, pid, start, bootId } = host;
  const nonce = randomBytes(32).toString("hex");
  const address = checkDarwinExecAddress(join(options.socketDirectory, `e-${randomBytes(16).toString("hex")}.sock`), uid);
  if (lstatSync(address, { throwIfNoEntry: false })) throw new Error("Darwin exec address occupied");
  const frame = encodeSharedExecFrame({ ...options.payload, type: "COMMIT", nonce });
  let terminal: pty.IPty | undefined, socket: Socket | undefined, identity: DarwinSharedIdentity | undefined;
  let childStart: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false, attempted = false, committing = false;
  let acceptReady!: (root: DarwinSharedIdentity) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<DarwinSharedIdentity>((accept, reject) => { acceptReady = accept; rejectReady = reject; });
  void ready.catch(() => {});

  function abort(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    socket?.destroy();
    server.close();
    rejectReady(new Error("Darwin exec gate failed before readiness"));
  }

  function matchesRoot(connection: Socket, root: DarwinSharedIdentity): boolean {
    const actual = captureDarwinPtySession(root.pid);
    return !connection.destroyed && !!actual && darwinSharedIdentity.same(actual, root) &&
      darwinSharedIdentity.matchesPeer(connection, root);
  }

  function onConnection(connection: Socket): void {
    connection.on("error", () => connection.destroy());
    if (closed || socket || !terminal || !childStart) { connection.destroy(); return; }
    const root = Object.freeze({ pid: terminal.pid, start: childStart, bootId, uid });
    if (!matchesRoot(connection, root)) { connection.destroy(); return; }
    socket = connection;
    connection.once("close", abort);
    void readSharedExecFrame(connection, "READY").then(message => {
      if (closed || message.nonce !== nonce || !matchesRoot(connection, root)) throw new Error("unverified Darwin exec readiness");
      identity = root;
      acceptReady(root);
    }).catch(abort);
  }

  async function commit(beforeDispatch: () => void): Promise<void> {
    if (closed || committing || attempted || !socket || !identity || !matchesRoot(socket, identity))
      throw new Error("Darwin exec gate not ready to commit");
    committing = true;
    try {
      beforeDispatch();
      if (closed) throw new Error("Darwin exec gate closed during publication");
      attempted = true;
      // The child checks the actual peer again after receipt and closes the socket itself.
      // Close and the handshake deadline also reclaim the listener if execution is refused.
      await dispatch(socket, frame);
    } catch (error) { abort(); throw error; }
  }

  const server = createServer(onConnection);
  try {
    await listen(server, address, uid);
    server.on("error", abort);
    timer = setTimeout(abort, SHARED_EXEC_TIMEOUT_MS);
    const script = fileURLToPath(new URL("./shared-exec-gate-darwin.js", import.meta.url));
    terminal = pty.spawn(process.execPath, [script, address, String(uid), String(pid), start, bootId, nonce], {
      name: "xterm-256color", cwd: options.bootstrapCwd, env: {}, cols: options.cols, rows: options.rows,
    });
    terminal.onExit(abort);
    try { childStart = processStartTime(terminal.pid); }
    catch { /* Preserve the exact PTY handle without granting dispatch authority. */ }
    if (!childStart) abort();
    return { proc: terminal, ready, commit, abort, get commitAttempted() { return attempted; } };
  } catch (error) { abort(); throw error; }
}

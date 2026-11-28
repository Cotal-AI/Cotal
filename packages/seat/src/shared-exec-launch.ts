import { randomBytes } from "node:crypto";
import { lstatSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "@lydell/node-pty";
import { peerCredentials } from "./peercred.js";
import { bootToken, processStartToken } from "./record.js";
import { encodeSharedExecFrame, readSharedExecFrame, sharedExecGateArgs, SHARED_EXEC_TIMEOUT_MS, type SharedExecPayload } from "./shared-exec-protocol.js";
import { recordedProcess, shortSocketPath } from "./shared-record.js";

interface LaunchOptions {
  directory: string;
  leaf: { directory: string; contains(pid: number, start: string): boolean };
  cwd: string;
  cols: number;
  rows: number;
  payload: SharedExecPayload;
}

interface Identity { pid: number; start: string; boot: string }

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Host owns the leaf and PTY lifetime. Aborting only closes the handshake, it never signals. */
export async function createSharedExecLaunch(options: LaunchOptions): Promise<{
  proc: pty.IPty;
  ready: Promise<Identity>;
  commit(beforeDispatch?: () => void): Promise<void>;
  abort(): void;
  readonly commitAttempted: boolean;
}> {
  if (process.platform !== "linux" || typeof (process as typeof process & { execve?: unknown }).execve !== "function") {
    throw new Error("exec-in-place requires Linux and a Node runtime with process.execve");
  }
  const uid = process.getuid?.(), pid = process.pid, start = processStartToken(pid), boot = bootToken();
  const directory = lstatSync(options.directory);
  if (uid === undefined || !start || !boot || !directory.isDirectory() || directory.uid !== uid ||
      (directory.mode & 0o777) !== 0o700) throw new Error("shared exec host identity or private directory unavailable");
  const nonce = randomBytes(32).toString("hex");
  const commitFrame = encodeSharedExecFrame({ ...options.payload, type: "COMMIT", nonce });
  const path = join(options.directory, `exec-${randomBytes(8).toString("hex")}.sock`);
  const endpoint = shortSocketPath(path);
  let proc: pty.IPty | undefined, socket: Socket | undefined, identity: Identity | undefined;
  let gateStart: string | undefined;
  let closed = false, attempted = false, bound = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: (identity: Identity) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<Identity>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Spawn may fail before the caller receives the promise.
  void ready.catch(() => {});
  const abort = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    socket?.destroy();
    server.close();
    try { if (bound) rmSync(endpoint.path, { force: true }); }
    catch { /* Caller owns cleanup of the per-seat directory. */ }
    finally { endpoint.close(); }
    rejectReady(new Error("shared exec gate failed before readiness"));
  };
  const server = createServer(connection => {
    connection.on("error", () => {});
    if (closed || socket || !proc) { connection.destroy(); return; }
    try {
      const peer = peerCredentials(connection);
      if (peer.uid !== uid || peer.pid !== proc.pid) { connection.destroy(); return; }
      if (!gateStart || recordedProcess(peer.pid, gateStart, boot) !== "live" || !options.leaf.contains(peer.pid, gateStart)) {
        connection.destroy(); abort(); return;
      }
    } catch { connection.destroy(); abort(); return; }
    socket = connection;
    const gate = { pid: proc.pid, start: gateStart, boot };
    void readSharedExecFrame(connection, "READY").then(frame => {
      if (closed || frame.nonce !== nonce || !options.leaf.contains(gate.pid, gate.start)) throw new Error("invalid gate readiness");
      identity = gate;
      resolveReady(gate);
    }).catch(abort);
  });
  try {
    await listen(server, endpoint.path);
    bound = true;
    server.on("error", abort);
    timer = setTimeout(abort, SHARED_EXEC_TIMEOUT_MS);
    const script = fileURLToPath(new URL("./shared-exec-gate.js", import.meta.url));
    proc = pty.spawn(process.execPath, [script, ...sharedExecGateArgs({ socket: path, leaf: options.leaf.directory, uid, pid, start, boot, nonce })], {
      cwd: options.cwd, env: {}, cols: options.cols, rows: options.rows,
    });
    gateStart = processStartToken(proc.pid);
    proc.onExit(abort);
    // Return the PTY even if the pin could not be read, so the caller retains cleanup ownership.
    if (!gateStart) abort();
    return { proc, ready, abort, get commitAttempted() { return attempted; }, commit };
  } catch (error) { abort(); throw error; }

  async function commit(beforeDispatch?: () => void): Promise<void> {
    if (closed || attempted || !socket || socket.destroyed || !identity ||
        recordedProcess(identity.pid, identity.start, identity.boot) !== "live" ||
        !options.leaf.contains(identity.pid, identity.start)) throw new Error("shared exec gate not ready to commit");
    const connection = socket;
    beforeDispatch?.();
    attempted = true;
    try {
      await new Promise<void>((resolve, reject) => {
        connection.write(commitFrame, error => error ? reject(error) : resolve());
      });
    } finally { abort(); }
  }
}

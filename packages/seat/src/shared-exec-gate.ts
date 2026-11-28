import { accessSync, closeSync, constants, lstatSync, openSync, statSync, statfsSync, writeSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { peerCredentials } from "./peercred.js";
import { encodeSharedExecFrame, parseSharedExecGateArgs, readSharedExecFrame, SHARED_EXEC_TIMEOUT_MS, type SharedExecCommit } from "./shared-exec-protocol.js";
import { recordedProcess, shortSocketPath } from "./shared-record.js";

const CGROUP2_SUPER_MAGIC = 0x63677270;
type Execve = (file: string, args: string[], env: Record<string, string>) => never;

function moveToLeaf(leaf: string): void {
  const directory = openSync(leaf, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const anchored = `/proc/self/fd/${directory}`;
    if (statfsSync(anchored).type !== CGROUP2_SUPER_MAGIC) throw new Error("invalid cgroup filesystem");
    const procs = openSync(join(anchored, "cgroup.procs"), constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      if (writeSync(procs, "0") !== 1) throw new Error("incomplete cgroup move");
    } finally { closeSync(procs); }
  } finally { closeSync(directory); }
}

function waitForConnection(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(false), SHARED_EXEC_TIMEOUT_MS);
    function up(): void { done(true); }
    function down(): void { done(false); }
    function done(ok: boolean): void {
      clearTimeout(timer);
      socket.off("connect", up);
      socket.off("error", down);
      socket.off("close", down);
      if (ok) resolve();
      else reject(new Error("shared exec connection failed"));
    }
    socket.once("connect", up);
    socket.once("error", down);
    socket.once("close", down);
  });
}

/** execve has no PATH search. Do not fall back to a shell for executable text files. */
function resolveExecutable(command: string, env: Record<string, string>): string {
  if (command.includes("/")) return command;
  for (const dir of (env.PATH ?? "/bin:/usr/bin").split(":")) {
    const path = resolve(dir, command);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch { /* Not an executable candidate. */ }
  }
  throw new Error("shared exec executable not found");
}

async function runGate(args: string[]): Promise<never> {
  const execve = (process as unknown as { execve?: Execve }).execve;
  if (process.platform !== "linux" || typeof execve !== "function") {
    throw new Error("exec-in-place requires Linux and a Node runtime with process.execve");
  }
  const opt = parseSharedExecGateArgs(args);
  moveToLeaf(opt.leaf);
  const endpoint = shortSocketPath(opt.socket);
  let socket: Socket | undefined;
  const authenticate = (connection: Socket): void => {
    const peer = peerCredentials(connection);
    if (peer.uid !== opt.uid || peer.pid !== opt.pid || recordedProcess(opt.pid, opt.start, opt.boot) !== "live") {
      throw new Error("untrusted shared exec host");
    }
  };
  let commit: SharedExecCommit;
  try {
    const directory = statSync(dirname(endpoint.path));
    const entry = lstatSync(endpoint.path);
    if (!directory.isDirectory() || directory.uid !== opt.uid || (directory.mode & 0o777) !== 0o700 ||
        !entry.isSocket() || entry.uid !== opt.uid) throw new Error("untrusted shared exec socket");
    socket = createConnection(endpoint.path);
    socket.on("error", () => { /* Phase-specific handlers reject; errors must not print the path. */ });
    await waitForConnection(socket);
    authenticate(socket);
    const pending = readSharedExecFrame(socket, "COMMIT");
    socket.write(encodeSharedExecFrame({ type: "READY", nonce: opt.nonce }));
    commit = await pending;
    if (commit.nonce !== opt.nonce) throw new Error("invalid shared exec nonce");
    authenticate(socket);
  } finally {
    socket?.destroy();
    endpoint.close();
  }
  process.chdir(commit.cwd);
  const executable = resolveExecutable(commit.command, commit.env);
  return execve(executable, [commit.command, ...commit.args], commit.env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runGate(process.argv.slice(2)).catch(() => {
    // Do not emit launch details or payload through the seat PTY.
    process.exitCode = 1;
  });
}

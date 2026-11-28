import { accessSync, constants, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeSharedExecFrame, readSharedExecFrame, SHARED_EXEC_TIMEOUT_MS, type SharedExecCommit } from "./shared-exec-protocol.js";
import { checkDarwinExecSocket } from "./shared-exec-socket-darwin.js";
import { darwinSharedIdentity } from "./shared-identity-darwin.js";

type Execve = (file: string, args: string[], env: Record<string, string>) => never;

function awaitConnection(socket: Socket): Promise<void> {
  return new Promise((accept, reject) => {
    const timer = setTimeout(failure, SHARED_EXEC_TIMEOUT_MS);
    function clean(): void {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("close", failure);
    }
    function connected(): void { clean(); accept(); }
    function failure(): void { clean(); reject(new Error("Darwin exec socket connection failed")); }
    socket.once("connect", connected);
    socket.once("close", failure);
  });
}

/** Resolve only executable files, without a fallback through an implicit shell. */
function executable(command: string, env: Record<string, string>): string {
  if (command.includes("/")) return command;
  for (const directory of (env.PATH ?? "/usr/bin:/bin").split(":")) {
    const candidate = resolve(directory, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Not an executable candidate. */ }
  }
  throw new Error("Darwin exec executable not found");
}

async function receive(args: string[]): Promise<SharedExecCommit> {
  const [address, rawUid, rawPid, start, bootId, nonce] = args;
  const uid = Number(rawUid), pid = Number(rawPid);
  const self = darwinSharedIdentity.current();
  if (!self || args.length !== 6 || String(uid) !== rawUid || uid !== self.uid || String(pid) !== rawPid ||
      bootId !== self.bootId || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error("invalid Darwin exec bootstrap");
  const host = { pid, start, bootId, uid };
  const before = checkDarwinExecSocket(address, uid);
  const socket = connect(address);
  socket.on("error", () => socket.destroy());
  const authenticate = () => {
    const after = checkDarwinExecSocket(address, uid);
    if (socket.destroyed || before.dev !== after.dev || before.ino !== after.ino || !darwinSharedIdentity.matchesPeer(socket, host))
      throw new Error("unverified Darwin exec host");
  };
  try {
    await awaitConnection(socket);
    authenticate();
    const pending = readSharedExecFrame(socket, "COMMIT");
    socket.write(encodeSharedExecFrame({ type: "READY", nonce }));
    const commit = await pending;
    // The host may close the listener after writing. The connected peer, not its pathname,
    // remains the authority for this commit.
    if (commit.nonce !== nonce || !darwinSharedIdentity.matchesPeer(socket, host)) throw new Error("unverified Darwin exec commit");
    return commit;
  } finally { socket.destroy(); }
}

async function runGate(args: string[]): Promise<never> {
  const execve = (process as unknown as { execve?: Execve }).execve;
  if (process.platform !== "darwin" || typeof execve !== "function") throw new Error("Darwin exec in place unavailable");
  const { command, args: commandArgs, cwd, env } = await receive(args);
  process.chdir(cwd);
  return execve(executable(command, env), [command, ...commandArgs], env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void runGate(process.argv.slice(2)).catch(() => {
  // Launch details and errors do not belong in terminal output.
  process.exitCode = 1;
});

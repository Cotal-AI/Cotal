import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { runCustodian } from "./custodian.js";
import { lockExclusiveNb } from "./host.js";
import { DEFAULT_COLS, DEFAULT_ROWS } from "./protocol.js";
import { bootToken, capabilityToken, processStartToken } from "./record.js";
import { initializeSharedHostCgroup } from "./shared-cgroup.js";
import { readControllerClaim, sharedGenerationAcceptsLaunch, validSharedGeneration } from "./shared-controller-claim.js";
import { hostControl, type SharedManagerIdentity, type SharedSeatAcceptor } from "./shared-control-server.js";
import type { SharedLaunchPayload } from "./shared-control-protocol.js";
import { createSharedExecLaunch } from "./shared-exec-launch.js";
import { privateDirectory, readSharedHost, recordedProcess, sharedHostRecord, sharedHostSocket, sharedSeatRecord, SHARED_MULTIPLEX_VERSION, writePrivateRecord, writeSharedSeatRefusal, type SharedHostRecord } from "./shared-record.js";

function eligiblePayload(launch: SharedLaunchPayload): boolean {
  const spec = launch.spec;
  return typeof launch.name === "string" && !!launch.name && typeof launch.cwd === "string" && launch.cwd.startsWith("/") &&
    typeof launch.artifactRoot === "string" && launch.artifactRoot.startsWith("/") && typeof spec?.command === "string" &&
    Array.isArray(spec.args) && spec.args.every(arg => typeof arg === "string");
}

function clearDeadSocket(root: string, socket: string): void {
  let dead = false;
  try {
    const prior = readSharedHost(root);
    dead = recordedProcess(prior.pid, prior.start, prior.bootId) === "gone";
    if (!dead) throw new Error("shared PTY host lifetime is unknown");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stat = lstatSync(socket, { throwIfNoEntry: false });
  if (!stat) return;
  if (!dead || !stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("unknown shared PTY socket");
  rmSync(socket);
}

function logFault(error: unknown): void {
  try { console.error("shared PTY host:", error); } catch { /* The service log must not stop a host. */ }
}

function sameManager(a: SharedManagerIdentity | undefined, b: SharedManagerIdentity): boolean {
  return a?.pid === b.pid && a.start === b.start && a.bootId === b.bootId;
}

export async function serveMultiplexedHost(root: string, scope: string, owner: SharedManagerIdentity): Promise<void> {
  const generation = basename(root), lineage = dirname(root);
  if (!validSharedGeneration(generation)) throw new Error("invalid shared PTY generation");
  privateDirectory(root);
  if (!sameManager(readControllerClaim(lineage), owner) || recordedProcess(owner.pid, owner.start, owner.bootId) !== "live") return;
  process.chdir(root);
  const fd = openSync(join(root, "host.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const lock = fstatSync(fd);
    if (!lock.isFile() || lock.uid !== process.getuid?.() || (lock.mode & 0o777) !== 0o600 || !lockExclusiveNb(fd)) return;
    const cgroup = initializeSharedHostCgroup(scope), socket = sharedHostSocket(root);
    clearDeadSocket(root, socket);
    const start = processStartToken(process.pid), bootId = bootToken();
    if (!start || !bootId) throw new Error("shared PTY host identity is unavailable");
    const host: SharedHostRecord = { version: SHARED_MULTIPLEX_VERSION, protocol: SHARED_MULTIPLEX_VERSION, pid: process.pid, start, bootId, scope, token: capabilityToken() };
    const sessions = new Map<string, SharedSeatAcceptor>();
    const connections = new Set<Socket>();
    let held = 0, closing = false, idle: ReturnType<typeof setTimeout>;
    const armIdle = () => { idle = setTimeout(() => {
      if (held) return;
      closing = true;
      server.close();
      for (const connection of connections) connection.destroy();
    }, 5_000); };
    const launch = async (id: string, payload: SharedLaunchPayload, authorize: () => void): Promise<"admitted" | "not-admitted" | "unknown"> => {
      const claimant = readControllerClaim(lineage);
      const record = sharedSeatRecord(root, id), directory = dirname(record);
      if (lstatSync(directory, { throwIfNoEntry: false })) return "unknown";
      const refuse = () => {
        try { writeSharedSeatRefusal(root, id, host); } catch (error) { logFault(error); }
        return "not-admitted" as const;
      };
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch { return "not-admitted"; }
      if (closing || !sharedGenerationAcceptsLaunch(claimant, generation) || !sameManager(claimant, owner) || !eligiblePayload(payload)) return refuse();
      let leaf: ReturnType<typeof cgroup.createSeat>;
      try { leaf = cgroup.createSeat(id); }
      catch { return refuse(); }
      let gate: Awaited<ReturnType<typeof createSharedExecLaunch>> | undefined, cleaned = false;
      ++held;
      clearTimeout(idle);
      const settled = () => {
        if (cleaned) return;
        cleaned = true;
        sessions.delete(id);
        void leaf.killAndRemove().then(() => { if (--held === 0) armIdle(); }, logFault);
      };
      const { spec, name, cwd, artifactRoot } = payload;
      try {
        await runCustodian({ ...spec, id, name, cwd, artifactRoot, env: spec.env ?? {}, socket,
          token: capabilityToken(), recordPath: record, logPath: join(directory, "custodian.log") }, {
          bind: accept => sessions.set(id, accept),
          settled,
          record: row => writePrivateRecord(record, { ...row, protocol: host.protocol, scope }),
          prepare: async () => {
            const staged = gate = await createSharedExecLaunch({ directory, leaf, cwd: root, cols: DEFAULT_COLS, rows: DEFAULT_ROWS,
              payload: { command: spec.command, args: spec.args, env: { ...spec.env, PWD: cwd, TERM: spec.env?.TERM ?? "xterm-256color" }, cwd } });
            return { ...staged, get commitAttempted() { return staged.commitAttempted; }, commit(record) { return staged.commit(() => {
              authorize();
              const current = readControllerClaim(lineage);
              if (!sharedGenerationAcceptsLaunch(current, generation) || current.pid !== claimant.pid || current.start !== claimant.start ||
                  current.bootId !== claimant.bootId) throw new Error("shared PTY controller lifetime is unknown");
              // This check, publication and dispatch are one synchronous host turn. The
              // writer epoch cannot change between them in this host.
              record();
            }); } };
          },
        });
        return "admitted";
      } catch (error) {
        logFault(error);
        if (gate?.commitAttempted) return "unknown";
        gate?.abort();
        settled();
        return refuse();
      }
    };
    const handle = hostControl({ host, closing: () => closing, authorized: () => {
      const claim = readControllerClaim(lineage);
      return sameManager(claim, owner) ? claim : undefined;
    }, acceptSeat: id => sessions.get(id), launch,
      // Launch creates the private reservation synchronously before its first await. A probe
      // on this epoch is ordered after its launch frames, and a closed epoch cannot dispatch.
      launchState: id => lstatSync(dirname(sharedSeatRecord(root, id)), { throwIfNoEntry: false }) ? "unknown" : "absent",
    });
    const server = createServer(connection => {
      connections.add(connection);
      connection.once("close", () => connections.delete(connection));
      handle(connection);
    });
    server.maxConnections = 128;
    process.on("uncaughtException", logFault);
    const observeOwner = setInterval(() => {
      // systemd drains this service's whole control group when its main process exits.
      // A transport failure and an unreadable process identity are not death evidence.
      if (recordedProcess(owner.pid, owner.start, owner.bootId) === "gone") process.exit(0);
    }, 250);
    observeOwner.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.once("close", resolve);
        server.listen(basename(socket), () => {
          try { chmodSync(socket, 0o600); writePrivateRecord(sharedHostRecord(root), host); armIdle(); }
          catch (error) { server.close(); reject(error); }
        });
      });
      rmSync(sharedHostRecord(root), { force: true });
    } finally { clearInterval(observeOwner); clearTimeout(idle!); process.off("uncaughtException", logFault); }
  } finally { closeSync(fd); }
}

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lockExclusiveNb } from "./host.js";
import { DEFAULT_COLS, DEFAULT_ROWS } from "./protocol.js";
import { capabilityToken } from "./record.js";
import { initializeSharedHostCgroup } from "./shared-cgroup.js";
import { readControllerClaim, sharedGenerationAcceptsLaunch, validSharedGeneration, type SharedControllerClaim } from "./shared-controller-claim.js";
import { linuxHostTransport, linuxWriterProof } from "./shared-control-linux.js";
import type { SharedLaunchPayload } from "./shared-control-protocol.js";
import { serveSharedHost } from "./shared-host-v2.js";
import { createSharedExecLaunch } from "./shared-exec-launch.js";
import type { HostRecords } from "./shared-platform.js";
import { privateDirectory, readSharedHost, sharedHostRecord, sharedHostSocket, sharedSeatRecord, SHARED_MULTIPLEX_VERSION, writePrivateRecord, writeSharedSeatRefusal, type SharedHostRecord } from "./shared-record.js";

function eligiblePayload(launch: SharedLaunchPayload): boolean {
  const spec = launch.spec;
  return typeof launch.name === "string" && !!launch.name && typeof launch.cwd === "string" && launch.cwd.startsWith("/") &&
    typeof launch.artifactRoot === "string" && launch.artifactRoot.startsWith("/") && typeof spec?.command === "string" &&
    Array.isArray(spec.args) && spec.args.every(arg => typeof arg === "string");
}

function clearDeadSocket(root: string, socket: string): void {
  let dead = false;
  try {
    dead = linuxWriterProof.observe(readSharedHost(root)) === "gone";
    if (!dead) throw new Error("shared PTY host lifetime is unknown");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stat = lstatSync(socket, { throwIfNoEntry: false });
  if (!stat) return;
  if (!dead || !stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("unknown shared PTY socket");
  rmSync(socket);
}

function linuxHostRecords(root: string, lineage: string, host: SharedHostRecord): HostRecords<SharedControllerClaim> {
  const directoryFor = (id: string) => dirname(sharedSeatRecord(root, id));
  const reserved = (id: string) => lstatSync(directoryFor(id), { throwIfNoEntry: false }) !== undefined;
  return {
    readClaim: () => readControllerClaim(lineage),
    acceptsLaunch: sharedGenerationAcceptsLaunch,
    reserve(id) {
      const recordPath = sharedSeatRecord(root, id), directory = directoryFor(id);
      if (reserved(id)) return "unknown";
      try { mkdirSync(directory, { mode: 0o700 }); } catch { return "not-admitted"; }
      return { recordPath, directory,
        publish: row => writePrivateRecord(recordPath, { ...row, protocol: host.protocol, scope: host.scope }),
        refuse: () => writeSharedSeatRefusal(root, id, host),
      };
    },
    launchState: id => reserved(id) ? "unknown" : "absent",
    publishHost: () => writePrivateRecord(sharedHostRecord(root), host),
    removeHost: () => rmSync(sharedHostRecord(root), { force: true }),
  };
}

export async function serveLinuxSharedHost(root: string, scope: string): Promise<void> {
  const generation = basename(root), lineage = dirname(root);
  if (!validSharedGeneration(generation)) throw new Error("invalid shared PTY generation");
  privateDirectory(root);
  process.chdir(root);
  const fd = openSync(join(root, "host.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const lock = fstatSync(fd);
    if (!lock.isFile() || lock.uid !== process.getuid?.() || (lock.mode & 0o777) !== 0o600 || !lockExclusiveNb(fd)) return;
    const cgroup = initializeSharedHostCgroup(scope), socket = sharedHostSocket(root);
    clearDeadSocket(root, socket);
    const identity = linuxWriterProof.current();
    if (!identity) throw new Error("shared PTY host identity is unavailable");
    const host: SharedHostRecord = { ...identity, version: SHARED_MULTIPLEX_VERSION, protocol: SHARED_MULTIPLEX_VERSION, scope, token: capabilityToken() };
    await serveSharedHost({
      host, generation, socket, address: socket, transport: linuxHostTransport, writer: linuxWriterProof,
      records: linuxHostRecords(root, lineage, host), eligiblePayload,
      isolate(id, reservation) {
        const leaf = cgroup.createSeat(id);
        return {
          prepare: ({ spec, cwd }) => createSharedExecLaunch({ directory: reservation.directory, leaf, cwd: root, cols: DEFAULT_COLS, rows: DEFAULT_ROWS,
            payload: { command: spec.command, args: spec.args, env: { ...spec.env, PWD: cwd, TERM: spec.env?.TERM ?? "xterm-256color" }, cwd } }),
          prepareFailure: () => "not-admitted",
          drain: () => leaf.killAndRemove(),
        };
      },
    });
  } finally { closeSync(fd); }
}

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchSeatOpts } from "./launcher.js";
import type { SharedRequest } from "./shared-custodian.js";
import { SeatClient } from "./client.js";
import { peerCredentials } from "./peercred.js";
import { encodeFrame, FrameReader, PROTOCOL_VERSION } from "./protocol.js";
import { seatId } from "./record.js";
import { privateDirectory, readSharedHost, readSharedSeat, recordedProcess, sharedHostSocket, sharedScopeMatches, shortSocketPath, type SharedHostRecord, type SharedSeatRecord } from "./shared-record.js";
import type { Socket } from "node:net";

const thisEntry = fileURLToPath(import.meta.url);
const shipped = (name: string) => join(dirname(dirname(thisEntry)), "dist", name);
const runner = "/usr/bin/systemd-run";

export function linuxSharedCustodyAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    if (!lstatSync(runner).isFile() || !/^0::/m.test(readFileSync("/proc/self/cgroup", "utf8"))) return false;
    const check = spawnSync("/usr/bin/systemctl", ["--user", "show", "--property=Version", "--value"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return check.status === 0 && /^\d/.test(check.stdout);
  } catch { return false; }
}

function askHost(root: string, host: SharedHostRecord, request: SharedRequest): Promise<void> {
  if (recordedProcess(host.pid, host.start, host.bootId) !== "live" || !sharedScopeMatches(host.pid, host.scope))
    return Promise.reject(new Error("shared PTY host lifetime is unknown"));
  const short = shortSocketPath(sharedHostSocket(root));
  const socket = connect(short.path);
  socket.once("close", short.close);
  return new Promise<void>((resolve, reject) => {
    const reader = new FrameReader();
    const fail = () => { socket.destroy(); reject(new Error("shared PTY host did not confirm the request")); };
    socket.setTimeout(7500, fail);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("connect", () => {
      try {
        const peer = peerCredentials(socket);
        if (peer.uid !== process.getuid?.() || peer.pid !== host.pid || recordedProcess(host.pid, host.start, host.bootId) !== "live") return fail();
        socket.write(encodeFrame(request));
      } catch { fail(); }
    });
    socket.on("data", chunk => {
      try {
        const frames = reader.push(chunk);
        if (!frames.length) return;
        const reply = frames.length === 1 ? frames[0] as { ok?: unknown; pid?: unknown; protocol?: unknown; start?: unknown } : null;
        if (reply?.ok !== true || (request.op === "proof" && (reply.pid !== host.pid || reply.start !== host.start || reply.protocol !== host.protocol))) return fail();
        resolve();
        socket.destroy();
      } catch { fail(); }
    });
  });
}

function observedHost(root: string): SharedHostRecord | undefined {
  try {
    const host = readSharedHost(root);
    const life = recordedProcess(host.pid, host.start, host.bootId);
    if (life === "gone") return undefined;
    if (life !== "live" || !sharedScopeMatches(host.pid, host.scope)) throw new Error("shared PTY host lifetime is unknown");
    return host;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}

function ensureHost(root: string): SharedHostRecord {
  const existing = observedHost(root);
  if (existing) return existing;
  const scope = `cotal-pty-${seatId()}.service`;
  // The service's default main-process lifetime applies its stop policy when the host dies,
  // even when a seat ignores terminal hangup or has detached descendants in the unit.
  const start = spawnSync(runner, ["--user", "--quiet", "--collect", "--service-type=exec", `--unit=${scope}`,
    "--property=KillMode=control-group", "--property=TimeoutStopSec=3s", "--property=Restart=no",
    "--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH",
    "--setenv=PATH=/usr/bin:/bin", `--setenv=HOME=${homedir()}`, `--setenv=TMPDIR=${tmpdir()}`,
    ...(process.env.DO_NOT_TRACK === "1" ? ["--setenv=DO_NOT_TRACK=1"] : []),
    "--", process.execPath, shipped("shared-custodian.js"), root, scope], { timeout: 5000, stdio: "ignore" });
  if (start.status !== 0) throw new Error("shared PTY host did not start in its user service");
  const deadline = Date.now() + 7500;
  while (Date.now() < deadline) {
    const found = observedHost(root);
    if (found) return found;
    spawnSync("/usr/bin/sleep", ["0.025"], { stdio: "ignore" });
  }
  throw new Error("shared PTY host did not become ready in its user service");
}

/** Send the launch using a short-lived helper because Runtime.spawn is synchronous. The helper
 * reads connector state on stdin and never retries a request whose outcome could be unknown. */
export function launchSharedSeat(opts: LaunchSeatOpts): string {
  const id = opts.id ?? seatId(), root = resolve(opts.root);
  privateDirectory(root);
  const host = ensureHost(root);
  const { spec } = opts;
  const request: SharedRequest = { protocol: host.protocol, token: host.token, op: "launch", id, name: opts.name, cwd: opts.cwd, artifactRoot: resolve(tmpdir()),
    spec: { command: spec.command, args: spec.args, env: spec.env, confirm: spec.confirm, confirmBefore: spec.confirmBefore, confirmReady: spec.confirmReady, confirmBlockers: spec.confirmBlockers, confirmNotice: spec.confirmNotice, artifacts: spec.artifacts } };
  callControl(root, request);
  return id;
}

export function proveSharedHost(root: string, host: SharedHostRecord): void {
  callControl(root, { protocol: host.protocol, token: host.token, op: "proof" });
}

export function verifySeatPeer(row: SharedSeatRecord, socket: Socket): void {
  const peer = peerCredentials(socket);
  if (peer.uid !== process.getuid?.() || peer.pid !== row.custodianPid || recordedProcess(peer.pid, row.custodianStart, row.bootId) !== "live" || !sharedScopeMatches(peer.pid, row.scope))
    throw new Error("shared PTY seat peer does not match its recorded host");
}

export function proveSharedSeat(root: string, id: string): void {
  const result = spawnSync(process.execPath, [shipped("shared-launch.js"), root, id], { stdio: "ignore", timeout: 5000, env: {} });
  if (result.status !== 0) throw new Error("shared PTY seat did not confirm its identity");
}

async function inspectSeat(root: string, id: string): Promise<void> {
  const row = readSharedSeat(root, id);
  const client = new SeatClient(row, socket => verifySeatPeer(row, socket), () => shortSocketPath(row.socket));
  try {
    const hello = await client.connect(), health = await client.health();
    if (hello.pid !== row.childPid || health.pid !== row.childPid || health.protocol !== PROTOCOL_VERSION || health.status !== "running" ||
        !row.childStart || recordedProcess(row.childPid, row.childStart, row.bootId) !== "live") throw new Error("shared PTY seat identity is not live");
  } finally { client.close(); }
}

function callControl(root: string, request: SharedRequest): void {
  const result = spawnSync(process.execPath, [shipped("shared-launch.js"), root], { input: encodeFrame(request), stdio: ["pipe", "ignore", "ignore"], timeout: 9000, env: {} });
  if (result.status !== 0) throw new Error("shared PTY host did not confirm the request");
}

if (process.argv[1] === thisEntry) {
  try {
    const root = process.argv[2]!;
    const id = process.argv[3];
    if (id) void inspectSeat(root, id).catch(() => { process.exitCode = 1; });
    else {
      const frames = new FrameReader().push(readFileSync(0));
      if (frames.length !== 1) throw new Error("invalid shared PTY request");
      void askHost(root, readSharedHost(root), frames[0] as SharedRequest).catch(() => { process.exitCode = 1; });
    }
  } catch { process.exitCode = 1; }
}

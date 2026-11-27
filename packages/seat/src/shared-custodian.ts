import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCustodian } from "./custodian.js";
import type { SeatLaunchSpec } from "./launcher.js";
import { peerCredentials } from "./peercred.js";
import { lockExclusiveNb } from "./host.js";
import { FrameReader, encodeFrame } from "./protocol.js";
import { bootToken, capabilityToken, isSeatId, processStartToken } from "./record.js";
import { isSharedScope, privateDirectory, readPrivateRecord, readSharedHost, recordedProcess, sharedHostRecord, sharedHostSocket, sharedScopeMatches, sharedSeatRecord, sharedSeatSocket, SHARED_HOST_VERSION, SHARED_PROTOCOL_VERSION, writePrivateRecord, type SharedHostRecord } from "./shared-record.js";
import { serveLinuxSharedHost } from "./shared-host-linux.js";
import { verifySharedRuntimeClosure, verifyStagedSharedRuntime } from "./shared-runtime-closure.js";
import { acquireSharedExecutionLease } from "./shared-execution-lease.js";
import { acquireSharedClosureLease } from "./shared-closure-lease.js";

export type SharedRequest = { protocol: number; token: string } & (
  { op: "proof" } | { op: "launch"; id: string; name: string; cwd: string; spec: SeatLaunchSpec; artifactRoot: string }
);

function checkLaunch(request: Extract<SharedRequest, { op: "launch" }>): void {
  if (!isSeatId(request.id) || typeof request.name !== "string" || !request.name || typeof request.cwd !== "string" || !isAbsolute(request.cwd) ||
      typeof request.artifactRoot !== "string" || !isAbsolute(request.artifactRoot) || typeof request.spec?.command !== "string" ||
      !Array.isArray(request.spec.args) || request.spec.args.some(arg => typeof arg !== "string")) throw new Error("invalid local PTY launch");
}

function listenRequest(sock: Socket, host: SharedHostRecord, launch: (request: Extract<SharedRequest, { op: "launch" }>) => Promise<void>): void {
  sock.on("error", () => {});
  sock.setTimeout(12_000, () => sock.destroy());
  try { if (peerCredentials(sock).uid !== process.getuid?.()) { sock.destroy(); return; } }
  catch { sock.destroy(); return; }
  const reader = new FrameReader();
  sock.on("data", chunk => {
    try {
      const frames = reader.push(chunk);
      if (!frames.length) return;
      sock.removeAllListeners("data");
      const req = frames.length === 1 ? frames[0] as SharedRequest | null : null;
      if (req?.protocol !== SHARED_PROTOCOL_VERSION || req.token !== host.token) { sock.destroy(); return; }
      if (req.op === "proof") { sock.end(encodeFrame({ ok: true, protocol: host.protocol, pid: host.pid, start: host.start })); return; }
      if (req.op !== "launch") { sock.destroy(); return; }
      void launch(req).then(() => sock.end(encodeFrame({ ok: true })), () => sock.end(encodeFrame({ ok: false })));
    } catch { sock.destroy(); }
  });
}

async function serveSharedCustodian(root: string, scope: string): Promise<void> {
  if (process.platform !== "linux" || !isSharedScope(scope) || !sharedScopeMatches(process.pid, scope)) throw new Error("shared PTY host has no independent user service");
  privateDirectory(root);
  process.chdir(root);
  const lock = openSync(join(root, "host.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(lock);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error("unknown shared PTY lock");
    if (!lockExclusiveNb(lock)) return;
    const socket = sharedHostSocket(root), recordPath = sharedHostRecord(root);
    prepareHostFiles(root, socket);
    const start = processStartToken(process.pid), bootId = bootToken();
    if (!start || !bootId) throw new Error("shared PTY host identity is unavailable");
    const host: SharedHostRecord = { version: SHARED_HOST_VERSION, protocol: SHARED_PROTOCOL_VERSION, pid: process.pid, start, bootId, scope, token: capabilityToken() };
    let seats = 0;
    let closing = false;
    let idle: ReturnType<typeof setTimeout>;
    const armIdle = () => { idle = setTimeout(() => { if (!seats) { closing = true; server.close(); } }, 5000); };
    const server = createServer(sock => listenRequest(sock, host, launch));
    server.maxConnections = 128;
    const launch = async (req: Extract<SharedRequest, { op: "launch" }>): Promise<void> => {
      if (closing) throw new Error("shared PTY host is closing");
      checkLaunch(req);
      const record = sharedSeatRecord(root, req.id);
      const seatSocket = sharedSeatSocket(root, req.id);
      mkdirSync(dirname(record), { mode: 0o700 });
      seats++;
      clearTimeout(idle);
      let settledOnce = false;
      const settled = () => {
        if (settledOnce) return;
        settledOnce = true;
        if (--seats === 0) armIdle();
      };
      try {
        await runCustodian({ ...req.spec, id: req.id, name: req.name, env: req.spec.env ?? {}, cwd: req.cwd,
          socket: seatSocket, token: capabilityToken(), recordPath: record, artifactRoot: req.artifactRoot, logPath: join(dirname(record), "custodian.log") },
        { settled, listenPath: basename(seatSocket), record: row => writePrivateRecord(record, { ...row, version: SHARED_HOST_VERSION, protocol: SHARED_PROTOCOL_VERSION, scope }) });
      } catch (e) { settled(); throw e; }
    };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("close", resolve);
      server.listen(basename(socket), () => {
        try {
          chmodSync(socket, 0o600);
          writePrivateRecord(recordPath, host);
          armIdle();
        } catch (e) { server.close(); reject(e); }
      });
    });
    rmSync(recordPath, { force: true });
  } finally { closeSync(lock); }
}

function prepareHostFiles(root: string, socket: string): void {
  let knownDead = false;
  try {
    const old = readSharedHost(root);
    if (recordedProcess(old.pid, old.start, old.bootId) !== "gone") throw new Error("shared PTY host lifetime is unknown");
    knownDead = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    const found = lstatSync(socket);
    if (!knownDead || !found.isSocket() || found.uid !== process.getuid?.()) throw new Error("unknown shared PTY socket");
    rmSync(socket);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

async function runRetainedHost(root: string, scope: string, store: string, digest: string, stagedRoot?: string, inventorySha256?: string): Promise<void> {
  let hold: ReturnType<typeof acquireSharedExecutionLease> | undefined;
  const copy = acquireSharedClosureLease(store, digest);
  try {
    if (Boolean(stagedRoot) !== Boolean(inventorySha256)) throw new Error("unknown staged execution inventory");
    const pin = readPrivateRecord(join(root, "execution.json"), 4096) as { version?: number; root?: string; inventorySha256?: string; digest?: string; scope?: string;
      dev?: string; ino?: string; copyDev?: string; copyIno?: string } | null;
    if (pin?.version !== 1 || pin.digest !== digest || pin.scope !== scope || pin.copyDev !== copy.dev || pin.copyIno !== copy.ino ||
        pin.root !== stagedRoot || pin.inventorySha256 !== inventorySha256) throw new Error("unknown retained execution inventory");
    if (stagedRoot && inventorySha256) {
      hold = acquireSharedExecutionLease(stagedRoot, "shared", inventorySha256);
      if (pin.dev !== hold.dev || pin.ino !== hold.ino) throw new Error("unknown staged execution inventory");
    }
    const closure = stagedRoot && inventorySha256 ? verifyStagedSharedRuntime(store, digest, { root: stagedRoot, inventorySha256 }) : verifySharedRuntimeClosure(store, digest);
    if (closure.entryPath !== process.argv[1] || closure.nodePath !== process.execPath)
      throw new Error("shared PTY host runtime is not retained");
    hold?.assertCurrent();
    copy.assertCurrent();
    await serveLinuxSharedHost(root, scope);
  } finally { hold?.release(); copy.release(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , root, scope, store, digest, stagedRoot, inventorySha256] = process.argv;
  if (!root || !scope || !isAbsolute(root) || Boolean(store) !== Boolean(digest)) process.exitCode = 1;
  else {
    const host = store && digest ? runRetainedHost(root, scope, store, digest, stagedRoot, inventorySha256) : serveSharedCustodian(root, scope);
    void host.catch(() => { process.exitCode = 1; });
  }
}

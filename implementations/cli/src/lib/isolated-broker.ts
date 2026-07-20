import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  backupProfilePermissions,
  hardenPrivate,
  isReachable,
  restoreProfilePermissions,
  type BackupPermissionScope,
  type RestorePermissionScope,
  type SpaceAuth,
} from "@cotal-ai/core";
import type { MaintenanceAuthMode, ProcessOwner } from "@cotal-ai/workspace";
import { resolveNatsServer } from "./nats-bin.js";

const LOOPBACK = "127.0.0.1";
const BOOT_TIMEOUT_MS = 15_000;

export interface PrivateAttemptsDirectory {
  path: string;
  identity: { dev: bigint; ino: bigint };
}

export function ensurePrivateAttemptsDir(root: string): PrivateAttemptsDirectory {
  let current = resolve(root);
  for (const name of [".cotal", "maintenance", "attempts"]) {
    current = join(current, name);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`maintenance path is not a real directory: ${current}`);
    if (process.getuid && stat.uid !== BigInt(process.getuid())) throw new Error(`maintenance path is not owned by the current user: ${current}`);
    // This tree holds the store clone, quarantine, sanitized snapshots, and the broker `.conf`
    // (plaintext maintenance creds). `hardenPrivate` reasserts 0700 on POSIX and sets an
    // inheritable owner-only NTFS ACL on win32 — where both the create mode AND the getuid
    // ownership check above are no-ops — so children born here inherit the private ACL. Fails closed.
    hardenPrivate(current, "dir");
  }
  const canonical = realpathSync.native(current);
  if (canonical !== current) throw new Error(`maintenance attempt directory is not canonical: ${current}`);
  const stat = lstatSync(canonical, { bigint: true });
  return { path: canonical, identity: { dev: stat.dev, ino: stat.ino } };
}

function assertDirectoryIdentity(path: string, identity: { dev: bigint; ino: bigint }): void {
  const current = lstatSync(path, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
    throw new Error(`maintenance attempt directory identity changed: ${path}`);
}

/** With the maintenance journal at `ready` and no live claim, nothing may legitimately live in the
 *  private attempts directory: every entry is residue of a dead attempt (staging, clones, broker
 *  run files) and is removed before new maintenance work begins. Strict — a failed removal aborts
 *  the caller rather than proceeding over unowned residue. */
export function sweepAttemptResidue(root: string): void {
  const attempts = ensurePrivateAttemptsDir(root);
  for (const name of readdirSync(attempts.path)) {
    const child = join(attempts.path, name);
    const stat = lstatSync(child);
    if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(child, { recursive: true });
    else rmSync(child);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : port ? resolvePort(port) : reject(new Error("could not allocate isolated broker port")));
    });
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function owner(child: ChildProcess, id: string): ProcessOwner {
  if (!child.pid) throw new Error(`${id} process has no pid`);
  return { pid: child.pid, host: hostname(), startedAt: new Date().toISOString(), id };
}

function copyTree(source: string, destination: string): void {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`backup source store is not a real directory: ${source}`);
  mkdirSync(destination, { mode: 0o700 });
  hardenPrivate(destination, "dir"); // clone subtree is store bytes — private on win32 too
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(destination, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`backup source store contains a symlink: ${from}`);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) copyFileSync(from, to, constants.COPYFILE_FICLONE);
    else throw new Error(`backup source store contains a non-regular entry: ${from}`);
  }
}

export interface AttemptDirectory {
  path: string;
  identity: { dev: bigint; ino: bigint };
  cleanup(): void;
}

export function createAttemptClone(root: string, sourceStore: string, attemptId: string): AttemptDirectory {
  const attempts = ensurePrivateAttemptsDir(root);
  const path = join(attempts.path, `${attemptId}-clone`);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`backup attempt clone already exists: ${path}`);
    throw error;
  }
  hardenPrivate(path, "dir"); // clone root holds the full store copy — private on win32 too
  const stat = lstatSync(path, { bigint: true });
  const identity = { dev: stat.dev, ino: stat.ino };
  try {
    for (const name of readdirSync(sourceStore)) {
      const from = join(sourceStore, name);
      const to = join(path, name);
      const entry = lstatSync(from);
      if (entry.isSymbolicLink()) throw new Error(`backup source store contains a symlink: ${from}`);
      if (entry.isDirectory()) copyTree(from, to);
      else if (entry.isFile()) copyFileSync(from, to, constants.COPYFILE_FICLONE);
      else throw new Error(`backup source store contains a non-regular entry: ${from}`);
    }
  } catch (error) {
    assertDirectoryIdentity(attempts.path, attempts.identity);
    const current = lstatSync(path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error(`backup attempt clone identity changed during construction: ${path}`);
    rmSync(path, { recursive: true });
    throw error;
  }
  return {
    path,
    identity,
    cleanup() {
      // Strict: removal failures must surface so the caller retains its claim over this residue.
      assertDirectoryIdentity(attempts.path, attempts.identity);
      let current;
      try {
        current = lstatSync(path, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (!current.isDirectory() || current.isSymbolicLink() ||
          current.dev !== identity.dev || current.ino !== identity.ino) return;
      rmSync(path, { recursive: true });
    },
  };
}

export interface IsolatedRunFile {
  path: string;
  dev: string;
  ino: string;
}

export interface IsolatedBroker {
  server: string;
  initialLogin: IsolatedMaintenanceLogin;
  brokerOwner: ProcessOwner;
  watchdogOwner: ProcessOwner;
  /** Attempt-owned run files (config, broker log, pid handshake) for claim journaling. */
  runFiles: readonly IsolatedRunFile[];
  addLogin(scope: IsolatedMaintenanceScope | ((connId: string) => IsolatedMaintenanceScope)): Promise<IsolatedMaintenanceLogin>;
  stop(): Promise<void>;
}

export type IsolatedMaintenanceScope =
  | { profile: "backup"; scope: BackupPermissionScope }
  | { profile: "restore"; scope: RestorePermissionScope }
  | { profile: "infrastructure"; streams: readonly string[] };

export interface IsolatedMaintenanceLogin {
  readonly user: string;
  readonly pass: string;
  readonly connId: string;
  readonly scope: IsolatedMaintenanceScope;
}

export async function connectIsolatedBroker(
  broker: Pick<IsolatedBroker, "server">,
  login: IsolatedMaintenanceLogin,
): Promise<NatsConnection> {
  return connect({
    servers: broker.server,
    user: login.user,
    pass: login.pass,
    inboxPrefix: `_INBOX_${login.connId}`,
    maxReconnectAttempts: 0,
  });
}

function exactStreamName(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid maintenance stream name ${JSON.stringify(name)}`);
  return name;
}

function loginPermissions(space: string, connId: string, operation: IsolatedMaintenanceScope): Record<string, unknown> {
  if (operation.profile === "backup") return backupProfilePermissions(space, connId, operation.scope);
  if (operation.profile === "restore") return restoreProfilePermissions(space, connId, operation.scope);
  const streams = [...new Set(operation.streams.map(exactStreamName))];
  if (!streams.length) throw new Error("infrastructure maintenance login requires at least one stream");
  return {
    // STREAM.NAMES carries no body-read or mutation authority; it feeds the exact post-restore
    // inventory assertion before commit intent.
    pub: { allow: ["$JS.API.INFO", "$JS.API.STREAM.NAMES", ...streams.flatMap((stream) => [`$JS.API.STREAM.CREATE.${stream}`, `$JS.API.STREAM.INFO.${stream}`])] },
    sub: { allow: [`_INBOX_${connId}.>`] },
  };
}

function maintenanceLogin(
  space: string,
  requested: IsolatedMaintenanceScope | ((connId: string) => IsolatedMaintenanceScope),
): IsolatedMaintenanceLogin & { permissions: Record<string, unknown> } {
  const connId = `U${randomBytes(28).toString("hex").toUpperCase()}`;
  const scope = typeof requested === "function" ? requested(connId) : requested;
  return {
    connId,
    scope,
    user: `maintenance_${randomBytes(16).toString("hex")}`,
    pass: randomBytes(32).toString("hex"),
    permissions: loginPermissions(space, connId, scope),
  };
}

function configPermissions(value: Record<string, unknown>): Record<string, unknown> {
  const permissions = value as {
    pub?: { allow?: string[]; deny?: string[] };
    sub?: { allow?: string[]; deny?: string[] };
    resp?: { max?: number; ttl?: number };
  };
  return {
    ...(permissions.pub ? { publish: permissions.pub } : {}),
    ...(permissions.sub ? { subscribe: permissions.sub } : {}),
    ...(permissions.resp ? {
      allow_responses: {
        max: permissions.resp.max,
        expires: `${(permissions.resp.ttl ?? 0) / 1_000_000_000}s`,
      },
    } : {}),
  };
}

/** Open-mode stores keep their streams in the global account, so open mode scopes USERS inside the
 *  top-level authorization block instead of a named account; authority is identical either way. */
function authenticatedConfig(
  account: string | undefined,
  port: number,
  storeDir: string,
  logins: readonly (IsolatedMaintenanceLogin & { permissions: Record<string, unknown> })[],
): string {
  const users = logins.map((login) => ({
    user: login.user,
    password: login.pass,
    permissions: configPermissions(login.permissions),
  }));
  return `${JSON.stringify({
    host: LOOPBACK,
    port,
    max_control_line: 65536,
    jetstream: { store_dir: storeDir },
    ...(account === undefined
      ? { authorization: { users } }
      : { accounts: { [account]: { jetstream: true, users } } }),
  }, null, 2)}\n`;
}

function removeOwnedFileStrict(file: IsolatedRunFile): void {
  let stat;
  try {
    stat = lstatSync(file.path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev.toString() !== file.dev || stat.ino.toString() !== file.ino) return;
  rmSync(file.path);
}

const delay = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

export async function startIsolatedBroker(options: {
  root: string;
  storeDir: string;
  space: string;
  mode: MaintenanceAuthMode;
  auth?: SpaceAuth;
  deadline: Date;
  label: "backup" | "restore" | "quarantine";
  initialScope: IsolatedMaintenanceScope;
  /** Attempt id prefixing the run files, tying them to the journaled maintenance attempt. */
  attemptId?: string;
}): Promise<IsolatedBroker> {
  const port = await freePort();
  const server = `nats://${LOOPBACK}:${port}`;
  const { bin } = await resolveNatsServer();
  const attempts = ensurePrivateAttemptsDir(options.root);
  const runDir = attempts.path;
  // Every mode gets the same single-principal, exact-subject permission matrix. Open mode differs
  // only in its account label; it is never a full-authority token broker.
  if (options.mode !== "open") {
    if (!options.auth) throw new Error(`${options.mode} isolated broker requires existing SpaceAuth`);
    if (options.auth.space !== options.space)
      throw new Error(`isolated broker trust material belongs to space ${JSON.stringify(options.auth.space)}, not ${JSON.stringify(options.space)}`);
  }
  const account = options.mode === "open" ? undefined : options.auth!.account.pub;
  const logins: Array<IsolatedMaintenanceLogin & { permissions: Record<string, unknown> }> = [
    maintenanceLogin(options.space, options.initialScope),
  ];
  const prefix = `${options.attemptId ?? options.label}-${randomUUID()}`;
  const configPath = join(runDir, `${prefix}.conf`);
  const logPath = join(runDir, `${prefix}.log`);
  const pidsPath = join(runDir, `${prefix}.pids`);
  writeFileSync(configPath, authenticatedConfig(account, port, options.storeDir, logins), { flag: "wx", mode: 0o600 });
  writeFileSync(logPath, "", { flag: "wx", mode: 0o600 });
  writeFileSync(pidsPath, "", { flag: "wx", mode: 0o600 });
  // The `.conf` embeds the plaintext maintenance login. `wx` above keeps the exclusive create
  // (never write over a pre-planted file); harden the win32 ACL after, where mode 0o600 is a no-op.
  // The attempts dir is already hardened inheritable, but harden the secret file explicitly too.
  hardenPrivate(configPath, "file");
  const fileIdentity = (path: string): IsolatedRunFile => {
    const stat = lstatSync(path, { bigint: true });
    return { path, dev: stat.dev.toString(), ino: stat.ino.toString() };
  };
  const runFiles: readonly IsolatedRunFile[] = [fileIdentity(configPath), fileIdentity(logPath), fileIdentity(pidsPath)];
  let logOffset = 0;
  const readLogTail = (): string => {
    try {
      const content = readFileSync(logPath, "utf8");
      const tail = content.slice(logOffset);
      logOffset = content.length;
      return tail;
    } catch {
      return "";
    }
  };
  const stopByPid = async (pid: number, gracefulMs: number): Promise<void> => {
    if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* raced to exit */ } }
    const graceful = Date.now() + gracefulMs;
    while (alive(pid) && Date.now() < graceful) await delay(100);
    if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* raced to exit */ } }
    const hard = Date.now() + 3_000;
    while (alive(pid) && Date.now() < hard) await delay(100);
    if (alive(pid)) throw new Error(`process ${pid} did not exit`);
  };
  // The watchdog OWNS the broker as its child: after this single spawn there is no instant at
  // which a broker can run unwatched — coordinator death or the deadline kills it via the parent
  // check, and the broker pid reaches us only through the watchdog's durable handshake file.
  const watchdogScript = [
    "const [bin,config,log,parent,deadline,pids]=process.argv.slice(1);",
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    "const fd=fs.openSync(log,'a');",
    "const broker=spawn(bin,['-c',config],{stdio:['ignore','ignore',fd]});",
    "fs.writeFileSync(pids,JSON.stringify({broker:broker.pid,watchdog:process.pid}));",
    "const alive=p=>{try{process.kill(p,0);return true}catch{return false}};",
    "const stop=()=>{try{process.kill(broker.pid,'SIGTERM')}catch{};setTimeout(()=>{if(alive(broker.pid))try{process.kill(broker.pid,'SIGKILL')}catch{}},3000).unref();};",
    "const tick=()=>{if(!alive(Number(parent))||Date.now()>=Number(deadline))stop();};",
    "broker.on('exit',()=>process.exit(0));",
    "setInterval(tick,250);tick();",
  ].join("");
  const watchdog = spawn(
    process.execPath,
    ["-e", watchdogScript, bin, configPath, logPath, String(process.pid), String(options.deadline.getTime()), pidsPath],
    { detached: true, stdio: "ignore" },
  );
  watchdog.unref();
  const watchdogOwner = owner(watchdog, `${options.label}-watchdog-${randomUUID()}`);
  let brokerOwner: ProcessOwner | undefined;
  try {
    const handshakeDeadline = Date.now() + BOOT_TIMEOUT_MS;
    while (!brokerOwner) {
      const raw = readFileSync(pidsPath, "utf8");
      if (raw) {
        let pids: { broker?: number } | undefined;
        try { pids = JSON.parse(raw) as { broker?: number }; } catch { /* handshake still being written */ }
        if (pids) {
          if (!Number.isInteger(pids.broker) || pids.broker! <= 0)
            throw new Error(`${options.label} watchdog reported an invalid broker pid`);
          brokerOwner = { pid: pids.broker!, host: hostname(), startedAt: new Date().toISOString(), id: `${options.label}-broker-${randomUUID()}` };
          break;
        }
      }
      if (!alive(watchdogOwner.pid))
        throw new Error(`${options.label} watchdog exited before spawning the broker: ${readLogTail().trim()}`);
      if (Date.now() >= handshakeDeadline)
        throw new Error(`${options.label} watchdog did not report a broker pid`);
      await delay(50);
    }
    while (Date.now() < Math.min(options.deadline.getTime(), Date.now() + BOOT_TIMEOUT_MS)) {
      if (!alive(brokerOwner.pid))
        throw new Error(`${options.label} bootstrap broker exited during startup: ${readLogTail().trim()}`);
      if (await isReachable(server)) return {
        server,
        initialLogin: logins[0],
        brokerOwner,
        watchdogOwner,
        runFiles,
        async addLogin(scope) {
          const login = maintenanceLogin(options.space, scope);
          // Every reload retires the preceding phase. The listener accepts one maintenance principal,
          // not the union of every authority used earlier in the attempt.
          logins.splice(0, logins.length, login);
          writeFileSync(configPath, authenticatedConfig(account, port, options.storeDir, logins), { mode: 0o600 });
          readLogTail();
          try {
            process.kill(brokerOwner!.pid, "SIGHUP");
          } catch {
            throw new Error(`${options.label} broker is not running for its maintenance-login reload`);
          }
          await delay(100);
          const reloadDiagnostics = readLogTail();
          if (/Failed to reload server configuration/.test(reloadDiagnostics))
            throw new Error(`${options.label} broker rejected its maintenance-login reload: ${reloadDiagnostics.trim()}`);
          if (!/Reloaded server configuration/.test(reloadDiagnostics))
            throw new Error(`${options.label} broker did not confirm its maintenance-login reload`);
          return login;
        },
        async stop() {
          await stopByPid(brokerOwner!.pid, 8_000);
          await stopByPid(watchdogOwner.pid, 3_000);
          assertDirectoryIdentity(attempts.path, attempts.identity);
          // Strict: a failed removal surfaces so the caller keeps its claim instead of orphaning.
          for (const file of runFiles) removeOwnedFileStrict(file);
        },
      };
      await delay(100);
    }
    throw new Error(`${options.label} bootstrap broker did not become reachable: ${readLogTail().trim()}`);
  } catch (error) {
    const shutdownFailures: Error[] = [];
    if (brokerOwner) try { await stopByPid(brokerOwner.pid, 3_000); } catch (cause) {
      shutdownFailures.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
    try { await stopByPid(watchdogOwner.pid, 3_000); } catch (cause) {
      shutdownFailures.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
    if (!shutdownFailures.length) {
      assertDirectoryIdentity(attempts.path, attempts.identity);
      try {
        for (const file of runFiles) removeOwnedFileStrict(file);
      } catch (cause) {
        shutdownFailures.push(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
    if (shutdownFailures.length)
      throw new Error(`${error instanceof Error ? error.message : String(error)}; bootstrap process exit could not be proven: ${shutdownFailures.map((failure) => failure.message).join("; ")}`);
    throw error;
  }
}

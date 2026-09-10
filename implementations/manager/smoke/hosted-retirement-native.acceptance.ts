/**
 * Owner-only native hosted retirement acceptance.
 *
 * Starts a disposable authenticated broker, IdP, public auth service, real remote-authority Manager,
 * and real managed children. A real public `runDelivery` daemon supplies the retirement liveness
 * oracle. The only test collaborator is a private atomic host release journal.
 * The current scoped cells cover registry-pinned HTTPS retained validation, its stale/revoked/
 * wrong-owner refusals, release failure, and successful public terminal retirement.
 *
 * All homes, workspace roots, the broker store, and IdP state are scratch. Requires nats-server.
 * Run: COTAL_OWNER_NATIVE_ACCEPTANCE=1 tsx implementations/manager/smoke/hosted-retirement-native.acceptance.ts
 */

const subcommand = process.argv[2] ?? "";
if (subcommand === "") {
  if (process.env.COTAL_OWNER_NATIVE_ACCEPTANCE !== "1")
    throw new Error("hosted retirement native acceptance is owner-only; set COTAL_OWNER_NATIVE_ACCEPTANCE=1 on the isolated native host");
  if (process.platform !== "linux") throw new Error("hosted retirement native acceptance requires Linux");
  if (!process.env.COTAL_NATIVE_HTTPS_CA) {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const pki = mkdtempSync(join(tmpdir(), "cotal-retirement-ca-"));
    const openssl = (args: string[]): void => {
      const result = spawnSync("openssl", args, { stdio: "pipe", encoding: "utf8" });
      if (result.status !== 0) throw new Error(`openssl fixture setup failed: ${result.stderr || result.stdout}`);
    };
    let childStatus = 1;
    try {
      openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "ca.key"),
        "-out", join(pki, "ca.pem"), "-days", "2", "-subj", "/CN=cotal-native-retirement-ca",
        "-addext", "basicConstraints=critical,CA:TRUE"]);
      openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "leaf.key"),
        "-out", join(pki, "leaf.csr"), "-subj", "/CN=localhost"]);
      writeFileSync(join(pki, "leaf.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
      openssl(["x509", "-req", "-in", join(pki, "leaf.csr"), "-CA", join(pki, "ca.pem"),
        "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "leaf.pem"),
        "-days", "2", "-extfile", join(pki, "leaf.ext")]);
      const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, ...process.argv.slice(2)], {
        stdio: "inherit",
        env: {
          ...process.env,
          COTAL_NATIVE_HTTPS_CA: join(pki, "ca.pem"),
          COTAL_NATIVE_HTTPS_CERT: join(pki, "leaf.pem"),
          COTAL_NATIVE_HTTPS_KEY: join(pki, "leaf.key"),
          NODE_EXTRA_CA_CERTS: join(pki, "ca.pem"),
        },
      });
      childStatus = child.status ?? 1;
    } finally {
      rmSync(pki, { recursive: true, force: true });
    }
    process.exit(childStatus);
  }
}

// The auth daemon and managed child are real registered/public compositions dispatched by re-exec.
if (subcommand === "agent-child") {
  const { CotalEndpoint } = await import("@cotal-ai/core");
  const { readFileSync } = await import("node:fs");
  const { execFile } = await import("node:child_process");
  const bearerCommand = JSON.parse(process.env.COTAL_BEARER_CMD!) as string[];
  const bearer = () => new Promise<string>((resolve, reject) => execFile(bearerCommand[0]!, bearerCommand.slice(1), (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || error.message));
    else resolve(stdout.trim());
  }));
  const child = new CotalEndpoint({
    space: process.env.COTAL_SPACE!, servers: process.env.COTAL_SERVERS!, bearer,
    sentinelCreds: readFileSync(process.env.COTAL_SENTINEL_CREDS!, "utf8"),
    lifecycleUid: process.env.COTAL_LIFECYCLE_UID!, channels: [], consume: false,
    card: { owner: process.env.COTAL_OWNER!, actor: process.env.COTAL_ACTOR!, name: process.env.COTAL_NAME!, kind: "agent" },
  });
  child.on("error", () => {});
  await child.start();
  await new Promise(() => {});
}
if (subcommand === "delivery") {
  const { runDelivery } = await import("@cotal-ai/delivery");
  const { workspaceSecretStore } = await import("@cotal-ai/workspace");
  const root = process.env.COTAL_NATIVE_HOST_ROOT!;
  await runDelivery({
    values: { space: process.env.COTAL_SPACE!, server: process.env.COTAL_SERVERS! },
    positionals: [], raw: [],
  }, workspaceSecretStore(root));
  process.exit(0);
}
if (subcommand === "auth-service" || subcommand === "agent-bearer") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const rest = process.argv.slice(3);
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) { values[key] = next; index++; }
    else values[key] = true;
  }
  const command = registry.all<Command>("command").find((candidate) => candidate.name === subcommand);
  if (!command) throw new Error("auth-service command was not registered");
  await command.run({ values, positionals, raw: rest });
  process.exit(0);
}
if (subcommand === "tls-probe") {
  try {
    const response = await fetch(process.env.COTAL_NATIVE_TLS_PROBE_URL!, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`TLS probe returned HTTP ${response.status}`);
    process.exit(0);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error
      ? error.cause as Error & { code?: string }
      : undefined;
    process.stderr.write(`TLS_CAUSE_CODE=${cause?.code ?? "unknown"}\n`);
    process.exit(1);
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
const betterAuthRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
const { betterAuth } = await import(new URL("dist/index.mjs", betterAuthRoot).href);
const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterAuthRoot).href);
const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterAuthRoot).href);
const { deviceAuthorization } = await import(new URL("dist/plugins/device-authorization/index.mjs", betterAuthRoot).href);
const { bearer: betterAuthBearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterAuthRoot).href);
const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterAuthRoot).href);
import {
  CotalEndpoint,
  createSpaceAuth,
  managedRetirementOpId,
  mintConnectionEvictorCreds,
  mintCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  principalKey,
  provisionAgentDurables,
  rawDigest,
  recordsBucket,
  remoteManagerActors,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  waitForDeliveryLease,
  registry,
  type AgentHandle,
  type AttachSession,
  type Connector,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
} from "@cotal-ai/core";
import {
  agentLifecycleSecretFilePaths,
  agentSecretKeyForFile,
  assertUserAuthInfo,
  authDir,
  connectionEvictorCredsKey,
  deliveryCredsKey,
  hasUserAuthState,
  materializeSecretToFile,
  membershipObserverCredsKey,
  membershipRwCredsKey,
  userAuthStateDir,
  workspaceSecretStore,
} from "@cotal-ai/workspace";
import {
  authCalloutKey,
  authIssuerKey,
  cotalAuthProvider,
  establishIdpSession,
  grantActor,
  loadAuthServiceInfo,
  loadCalloutAuth,
  parseRemoteManagerAuthorityRequest,
} from "@cotal-ai/auth";
import { persistRemoteUserEntry } from "../../cli/src/commands/meshes-add.js";
import { pickFreePort } from "../../auth/smoke/_free-port.js";
import { Manager, type ManagerResumeAgent, type ManagerResumeInventory } from "@cotal-ai/manager";
// Fixture assembly only: these reproduce the published supervisor composition around the package-root
// Manager. The behavior under acceptance stays on public Manager.start/resumePreserved and endpoint
// invokeService("manager", "despawn"). Lifecycle-registry internals below are read-only observation.
import {
  currentRegistrationProof,
  loadOrCreateRemoteManagerIdentity,
  materialCredential,
  remoteManagerAuthorityRequest,
  remoteRetainedAgentValidationRequest,
  retainedAgentAuthority,
} from "../src/remote-authority.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";
import { managerClusterArtifacts } from "../src/manager-service-contract.js";
import { openLifecycleRegistry, readLifecycleHeadForOperation } from "../../auth/src/lifecycle-registry.js";

const self = process.argv[1]!;
const participantHome = mkdtempSync(join(tmpdir(), "cotal-registered-manager-home-"));
const hostRoot = mkdtempSync(join(tmpdir(), "cotal-registered-manager-host-"));
const participantRoot = mkdtempSync(join(tmpdir(), "cotal-registered-manager-participant-"));
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = participantHome;

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RetirementTarget = { owner: string; actor: string; lifecycleUid: string };
type ReleaseRow = { target: RetirementTarget; opId: string; state: "pending" | "released" };
const childHandles = new Map<string, ChildHandle>();

class TestReleaseJournal {
  constructor(readonly path: string) {}
  private read(): ReleaseRow | undefined {
    if (!existsSync(this.path)) return undefined;
    return JSON.parse(readFileSync(this.path, "utf8")) as ReleaseRow;
  }
  private write(row: ReleaseRow): void {
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    const dirfd = openSync(join(this.path, ".."), "r");
    try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
  }
  release(target: RetirementTarget, opId: string): void {
    const previous = this.read();
    if (previous && (JSON.stringify(previous.target) !== JSON.stringify(target) || previous.opId !== opId))
      throw new Error("release journal target or operation mismatch");
    if (previous?.state === "released") return;
    this.write({ target, opId, state: "pending" });
    this.write({ target, opId, state: "released" });
  }
  row(): ReleaseRow | undefined { return this.read(); }
}

class ChildHandle implements AgentHandle {
  readonly kind = "native-acceptance";
  private exited = false;
  private code: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private diagnostics: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly exits = new Set<() => void>();
  private readonly closed: Promise<void>;
  constructor(readonly name: string, private readonly child: ChildProcess) {
    const append = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const combined = this.diagnostics.length === 0 ? bytes : Buffer.concat([this.diagnostics, bytes]);
      let start = Math.max(0, combined.length - 32 * 1024);
      while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
      this.diagnostics = combined.subarray(start);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => append(`[spawn error] ${error.message}\n`));
    this.closed = new Promise((resolve) => child.once("close", (code, signal) => {
      this.exited = true; this.code = code; this.signal = signal;
      for (const listener of this.exits) listener();
      resolve();
    }));
  }
  get pid(): number | undefined { return this.child.pid; }
  status(): "running" | "exited" { return this.exited ? "exited" : "running"; }
  stop(): void { if (!this.exited) this.child.kill("SIGTERM"); }
  waitForExit(): Promise<void> { return this.closed; }
  interrupt(): void { if (!this.exited) this.child.kill("SIGINT"); }
  exitInfo(): { code?: number; signal?: number } | undefined {
    if (!this.exited) return undefined;
    return { ...(this.code !== null ? { code: this.code } : {}) };
  }
  attach(): AttachSession {
    return {
      cols: 80, rows: 24,
      backlog: () => Buffer.from(this.diagnostics.toString("utf8")
        .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted credential block]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]")),
      onData: () => () => {},
      onExit: (listener) => { this.exits.add(listener); return () => this.exits.delete(listener); },
      write: () => {}, resize: () => {},
    };
  }
  diagnostic(): string {
    return this.diagnostics.toString("utf8").trim()
      .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted credential block]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]");
  }
}

const childRuntime: Runtime = {
  kind: "native-acceptance",
  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    const env = { ...process.env, ...spec.env };
    // This acceptance owns a private CA and gives its public certificate to the child explicitly.
    // Never let a caller environment turn the proof into an insecure NODE_TLS_REJECT_UNAUTHORIZED=0
    // connection while the fixture still reports a successful remote bearer exchange.
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    const handle = new ChildHandle(name, trackChild(spawn(spec.command, spec.args, {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    })));
    childHandles.set(name, handle);
    return handle;
  },
};
let childCaFile: string | undefined;
const runtimeProvider: RuntimeProvider = {
  kind: "runtime", name: "native-acceptance", available: () => true, create: () => childRuntime,
};
const connector: Connector = {
  kind: "connector", name: "native-acceptance", readinessTimeoutMs: 20_000,
  buildLaunch(opts) {
    if (!opts.userAuth || !opts.lifecycleUid) throw new Error("native acceptance requires retained user authority");
    return {
      command: process.execPath,
      args: [...process.execArgv, self, "agent-child"],
      env: {
        COTAL_SPACE: opts.space, COTAL_SERVERS: opts.servers!, COTAL_NAME: opts.name,
        COTAL_OWNER: opts.userAuth.owner, COTAL_ACTOR: opts.userAuth.actor,
        COTAL_SENTINEL_CREDS: opts.userAuth.sentinelCredsPath,
        COTAL_BEARER_CMD: JSON.stringify(opts.userAuth.bearerCmd), COTAL_LIFECYCLE_UID: opts.lifecycleUid,
        ...(childCaFile ? { NODE_EXTRA_CA_CERTS: childCaFile } : {}),
      },
    };
  },
};
registry.register(runtimeProvider);
registry.register(connector);

const space = `registered-manager-${Math.random().toString(36).slice(2, 10)}`;
const brokerPort = await pickFreePort();
const server = `nats://127.0.0.1:${brokerPort}`;
const clientId = "registered-manager-smoke";
const hostDir = userAuthStateDir(hostRoot, space);
const participantDir = userAuthStateDir(participantRoot, space);
const hostStore = workspaceSecretStore(hostRoot);
const participantStore = workspaceSecretStore(participantRoot);
const authDiagnosticCap = 32 * 1024;
const closedChildren = new WeakSet<ChildProcess>();
let authService: ChildProcess | undefined;
let delivery: ChildProcess | undefined;
let deliveryDiagnostics: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let deliverySpawnError: Error | undefined;
let authServiceDiagnostics: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let authServiceSpawnError: Error | undefined;
let broker: ChildProcess | undefined;
let idpServer: ReturnType<typeof createServer> | undefined;
let exchangeProxy: ReturnType<typeof createHttpsServer> | undefined;
let httpsExchangeRequests = 0;
let httpsManagerAuthorityRequests = 0;
let endpoint: CotalEndpoint | undefined;
let manager: Manager | undefined;
let observerNc: Awaited<ReturnType<typeof connect>> | undefined;
let storeDir: string | undefined;
let managerDiagnostics = "";
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  managerDiagnostics = `${managerDiagnostics}\n${args.map(String).join(" ")}`.slice(-32 * 1024);
  originalConsoleError(...args);
};
const redactDiagnostics = (value: string) => value
  .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted credential block]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]");
const adoptionDiagnostic = (name: string) => ({
  child: redactDiagnostics(childHandles.get(name)?.diagnostic() ?? "no child output captured"),
  manager: redactDiagnostics(managerDiagnostics),
  exit: childHandles.get(name)?.exitInfo(),
});

function trackChild(child: ChildProcess): ChildProcess {
  child.once("close", () => closedChildren.add(child));
  return child;
}

function probeHttpsFromFreshNode(url: string, caFile?: string): Promise<{ code: number | null; diagnostic: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, COTAL_NATIVE_TLS_PROBE_URL: url };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (caFile) env.NODE_EXTRA_CA_CERTS = caFile;
  return new Promise((resolve) => {
    const probe = spawn(process.execPath, [...process.execArgv, self, "tls-probe"], {
      env, stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    probe.stderr?.on("data", (chunk: Buffer | string) => {
      diagnostic = `${diagnostic}${chunk.toString()}`.slice(-4 * 1024);
    });
    probe.once("error", (error) => resolve({ code: null, diagnostic: error.message }));
    probe.once("close", (code) => resolve({ code, diagnostic: redactDiagnostics(diagnostic) }));
  });
}

function appendAuthDiagnostic(chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const combined = authServiceDiagnostics.length === 0
    ? bytes
    : Buffer.concat([authServiceDiagnostics, bytes]);
  let start = Math.max(0, combined.length - authDiagnosticCap);
  // Never begin the retained suffix in the middle of a valid UTF-8 code point. Dropping the
  // partial prefix keeps both the byte cap and the rendered diagnostic honest.
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
  authServiceDiagnostics = combined.subarray(start);
}

function appendDeliveryDiagnostic(chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const combined = deliveryDiagnostics.length === 0 ? bytes : Buffer.concat([deliveryDiagnostics, bytes]);
  let start = Math.max(0, combined.length - authDiagnosticCap);
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
  deliveryDiagnostics = combined.subarray(start);
}

function deliveryFailure(child: ChildProcess, reason: string): Error {
  const state = deliverySpawnError
    ? `spawn error: ${deliverySpawnError.message}`
    : child.exitCode !== null ? `exit ${child.exitCode}`
      : child.signalCode !== null ? `signal ${child.signalCode}`
        : child.pid === undefined ? "no pid" : `pid ${child.pid} still running`;
  const diagnostics = deliveryDiagnostics.toString("utf8").trim()
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted credential block]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]");
  return new Error(`${reason}; child ${state}${diagnostics === "" ? "" : `\ndelivery output (last ${authDiagnosticCap} bytes, credential-shaped values redacted):\n${diagnostics}`}`);
}

function authServiceFailure(child: ChildProcess, reason: string): Error {
  const state = authServiceSpawnError
    ? `spawn error: ${authServiceSpawnError.message}`
    : child.exitCode !== null
      ? `exit ${child.exitCode}`
      : child.signalCode !== null
        ? `signal ${child.signalCode}`
        : child.pid === undefined
          ? "no pid"
          : `pid ${child.pid} still running`;
  const diagnostics = authServiceDiagnostics.toString("utf8").trim();
  return new Error(`${reason}; child ${state}${diagnostics === "" ? "" : `\nauth-service output (last ${authDiagnosticCap} bytes):\n${diagnostics}`}`);
}

function spawnAuthService(): ChildProcess {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  env.COTAL_HOME = participantHome;
  authServiceDiagnostics = Buffer.alloc(0);
  authServiceSpawnError = undefined;
  const child = spawn(process.execPath, [...process.execArgv, self, "auth-service", "--space", space, "--server", server, "--exchange-public-port", "0"], {
    cwd: hostRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", appendAuthDiagnostic);
  child.stderr?.on("data", appendAuthDiagnostic);
  child.once("error", (error) => {
    authServiceSpawnError = error;
    appendAuthDiagnostic(`[spawn error] ${error.message}\n`);
  });
  return trackChild(child);
}

async function awaitAuthService(child: ChildProcess, timeoutMs = 60_000): Promise<{ url: string; publicUrl?: string; pid: number }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (authServiceSpawnError || child.exitCode !== null || child.signalCode !== null)
      throw authServiceFailure(child, "auth service exited before readiness");
    const info = loadAuthServiceInfo(hostDir);
    if (info) {
      try {
        process.kill(info.pid, 0);
        const remaining = Math.max(1, end - Date.now());
        if ((await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(Math.min(1_000, remaining)) })).ok) return info;
      } catch { /* still booting */ }
    }
    await wait(100);
  }
  throw authServiceFailure(child, `auth service did not become ready at ${hostDir} within ${timeoutMs}ms`);
}

async function awaitChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (closedChildren.has(child)) return true;
  return new Promise((resolve) => {
    const onClose = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("close", onClose); resolve(false); }, timeoutMs);
    child.once("close", onClose);
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<boolean> {
  if (!child || closedChildren.has(child)) return true;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  if (await awaitChildClose(child, 3_000)) return true;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  return awaitChildClose(child, 3_000);
}

try {
  const asciiHead = "ascii-head-marker";
  const asciiTail = "ascii-tail-marker";
  appendAuthDiagnostic(Buffer.from(`${asciiHead}${"a".repeat(authDiagnosticCap * 2)}${asciiTail}`));
  const asciiDiagnostic = authServiceDiagnostics.toString("utf8");
  check("diagnostic retention is capped in bytes for ASCII output",
    authServiceDiagnostics.length <= authDiagnosticCap && !asciiDiagnostic.includes(asciiHead) && asciiDiagnostic.includes(asciiTail));

  authServiceDiagnostics = Buffer.alloc(0);
  const utf8Head = "utf8-head-marker";
  const utf8Tail = "utf8-tail-marker";
  appendAuthDiagnostic(Buffer.from(`${utf8Head}${"€".repeat(authDiagnosticCap)}${utf8Tail}`));
  const utf8Diagnostic = authServiceDiagnostics.toString("utf8");
  check("diagnostic retention is capped in bytes for multibyte UTF-8 output",
    authServiceDiagnostics.length <= authDiagnosticCap &&
      Buffer.byteLength(utf8Diagnostic) <= authDiagnosticCap &&
      !utf8Diagnostic.includes(utf8Head) && utf8Diagnostic.includes(utf8Tail));
  authServiceDiagnostics = Buffer.alloc(0);

  mkdirSync(join(hostRoot, ".cotal"), { recursive: true });
  mkdirSync(join(participantRoot, ".cotal"), { recursive: true });

  // Real local host authority: only this root has account signer + auth service state.
  const auth = await createSpaceAuth(space);
  const { saveSpaceAuth } = await import("@cotal-ai/workspace");
  saveSpaceAuth(authDir(hostRoot), auth);
  // Bring up the IdP before provider preparation, rather than hand-writing auth state or
  // bypassing the provider seam.
  let handler: ReturnType<typeof toNodeHandler> | undefined;
  idpServer = createServer((request, response) => handler!(request, response));
  await new Promise<void>((resolve) => idpServer!.listen(0, "127.0.0.1", resolve));
  const address = idpServer.address();
  if (address === null || typeof address === "string") throw new Error("IdP did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({
    baseURL: origin,
    secret: "registered-manager-smoke-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id: string) => id === clientId }),
      betterAuthBearer(),
    ],
  });
  handler = toNodeHandler(idp);
  const preparedHost = await cotalAuthProvider.prepareServer({
    space,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: hostStore,
    dir: hostDir,
    idpUrl,
  });
  check("host provider prepared user-auth state against the real IdP", Boolean(preparedHost));

  storeDir = mkdtempSync(join(tmpdir(), "cotal-registered-manager-js-"));
  writeFileSync(join(hostRoot, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: brokerPort,
    storeDir,
    extraAccounts: preparedHost.extraAccounts,
  }));
  broker = trackChild(spawn("nats-server", ["-c", join(hostRoot, "server.conf")], { stdio: "ignore" }));
  let brokerReady = false;
  for (let tries = 0; tries < 50 && broker.exitCode === null; tries++) {
    try {
      const nc = await connect({
        servers: server,
        ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }),
        maxReconnectAttempts: 0,
        timeout: 300,
      });
      await nc.close();
      brokerReady = true;
      break;
    } catch { await wait(100); }
  }
  check("user-auth broker is running", brokerReady && broker.exitCode === null);
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const hosted = { injected: true } as const;
  await hostStore.put(deliveryCredsKey(space, hosted), await mintCreds(auth, newIdentity(), "delivery"));
  await hostStore.put(membershipRwCredsKey(space, hosted), await mintCreds(auth, newIdentity(), "membership-rw"));
  await hostStore.put(membershipObserverCredsKey(space, hosted), await mintMembershipObserverCreds(auth, newIdentity()));
  await hostStore.put(connectionEvictorCredsKey(space, hosted), await mintConnectionEvictorCreds(auth, newIdentity()));
  deliveryDiagnostics = Buffer.alloc(0);
  deliverySpawnError = undefined;
  delivery = trackChild(spawn(process.execPath, [...process.execArgv, self, "delivery"], {
    cwd: hostRoot,
    env: { ...process.env, COTAL_NATIVE_HOST_ROOT: hostRoot, COTAL_SPACE: space, COTAL_SERVERS: server },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  delivery.stdout?.on("data", appendDeliveryDiagnostic);
  delivery.stderr?.on("data", appendDeliveryDiagnostic);
  delivery.once("error", (error) => {
    deliverySpawnError = error;
    appendDeliveryDiagnostic(`[spawn error] ${error.message}\n`);
  });
  const deliveryProbe = newIdentity();
  const deliveryReady = await waitForDeliveryLease({
    servers: server, space, creds: await mintCreds(auth, deliveryProbe, "delivery"),
    id: deliveryProbe.id, holder: undefined, timeoutMs: 30_000,
  });
  if (!deliveryReady || delivery.exitCode !== null || delivery.signalCode !== null)
    throw deliveryFailure(delivery, "real delivery daemon did not become ready before auth retirement");
  check("real delivery daemon is ready before auth retirement", true);

  authService = spawnAuthService();
  const service = await awaitAuthService(authService);
  check("host auth service exposes a public exchange", typeof service.publicUrl === "string" && service.publicUrl.startsWith("http://127.0.0.1:"), service);

  childCaFile = process.env.COTAL_NATIVE_HTTPS_CA!;
  exchangeProxy = createHttpsServer({
    cert: readFileSync(process.env.COTAL_NATIVE_HTTPS_CERT!),
    key: readFileSync(process.env.COTAL_NATIVE_HTTPS_KEY!),
  }, (req, res) => {
    if (req.url?.endsWith("/exchange")) httpsExchangeRequests++;
    if (req.url?.endsWith("/manager-service-authority")) httpsManagerAuthorityRequests++;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const upstreamUrl = new URL(service.publicUrl!);
      const upstream = httpRequest({
        host: upstreamUrl.hostname, port: Number(upstreamUrl.port), path: req.url,
        method: req.method, headers: { ...req.headers, host: upstreamUrl.host },
      }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
      upstream.on("error", (error) => { res.statusCode = 502; res.end(error.message); });
      upstream.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve) => exchangeProxy!.listen(0, "127.0.0.1", resolve));
  const proxyAddress = exchangeProxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("HTTPS exchange proxy did not bind");
  const secureExchangeUrl = `https://127.0.0.1:${proxyAddress.port}`;
  const untrustedProbe = await probeHttpsFromFreshNode(`${secureExchangeUrl}/health`);
  check("the owned HTTPS exchange rejects a fresh child on certificate verification without its CA",
    untrustedProbe.code !== 0 && /TLS_CAUSE_CODE=(SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(untrustedProbe.diagnostic), untrustedProbe);
  const trustedProbe = await probeHttpsFromFreshNode(`${secureExchangeUrl}/health`, childCaFile);
  check("the owned CA lets a fresh child verify the HTTPS exchange certificate", trustedProbe.code === 0, trustedProbe);

  const signup = await idp.api.signUpEmail({
    body: { email: "participant@example.test", password: "correct-horse-battery", name: "Participant" },
    returnHeaders: true,
  });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const approve = async (userCode: string): Promise<void> => {
    await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
    const response = await fetch(`${idpUrl}/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ userCode }),
    });
    if (!response.ok) throw new Error(`device approval failed: HTTP ${response.status}`);
  };
  const { sub } = await establishIdpSession({
    dir: participantHome,
    idpUrl,
    clientId,
    onPrompt: (prompt: { userCode: string }) => void approve(prompt.userCode),
  });
  const owner = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });
  check("participant login is established", typeof sub === "string" && sub.length > 0);
  grantActor(hostDir, { owner, actor: "cli", scope: ["spawn", "supervise", "admin"], allowSubscribe: ["general"], allowPublish: ["general"] });

  const callout = await loadCalloutAuth(hostStore, space);
  if (!callout) throw new Error("host callout material is missing after preparation");
  persistRemoteUserEntry(space, server, participantRoot, {
    space,
    server,
    tlsRequired: false,
    userAuth: assertUserAuthInfo({
      provider: "cotal",
      idp: { url: idpUrl, issuer: origin, audience: origin },
      endpoints: { url: secureExchangeUrl },
    }),
    sentinelCreds: callout.sentinelCreds,
  }, false, false);
  check("participant registry entry is remote user mode", existsSync(participantDir));
  check("participant has no local hosting marker", hasUserAuthState(participantRoot, space) === false);
  check("the registry-pinned HTTPS origin is not usable without its owned CA", untrustedProbe.code !== 0, untrustedProbe);

  // The existing provider seam is enough for an ordinary remote USER connection. This establishes
  // the control condition: the later denial is lack of manager service authority, not login/dial.
  console.log("\ncell 1/7: IdP-backed owner grant and bearer");
  const material = await cotalAuthProvider.userCredentials({
    store: participantStore,
    dir: participantDir,
    space,
    actor: "cli",
  });
  const payload = JSON.parse(Buffer.from(material.bearer.split(".")[1]!, "base64url").toString("utf8")) as {
    sub: string;
    act: { actor: string; lifecycleUid: string };
  };
  endpoint = new CotalEndpoint({
    space,
    servers: server,
    bearer: () => cotalAuthProvider.userCredentials({ store: participantStore, dir: participantDir, space, actor: "cli" }).then((value: { bearer: string }) => value.bearer),
    sentinelCreds: material.sentinelCreds,
    lifecycleUid: payload.act.lifecycleUid,
    channels: [],
    consume: false,
    watchChannels: false,
    card: { owner: payload.sub, actor: payload.act.actor, name: "registered-participant", kind: "endpoint" },
  });
  endpoint.on("error", () => {});
  await endpoint.start();
  check("existing provider bearer connects from the registry-only participant", endpoint.principal.owner === owner && endpoint.principal.actor === "cli", endpoint.principal);
  check("participant bearer exchange traverses the registry-pinned HTTPS origin", httpsExchangeRequests > 0, httpsExchangeRequests);

  check("participant store has no issuer or callout private authority",
    await participantStore.get(authIssuerKey(space)) === undefined &&
      await participantStore.get(authCalloutKey(space)) === undefined &&
      !existsSync(join(participantRoot, ".cotal", authIssuerKey(space))) &&
      !existsSync(join(participantRoot, ".cotal", authCalloutKey(space))));

  console.log("\ncell 2/7: sealed remote-manager authority registration");
  const state = loadOrCreateRemoteManagerIdentity(participantRoot, space);
  const prepareRequest = remoteManagerAuthorityRequest(state, "cli", "prepare");
  const prepare = await cotalAuthProvider.managerServiceAuthority!({ store: participantStore, dir: participantDir, request: prepareRequest });
  const actors = remoteManagerActors(state.instanceId);
  const registered = await registerRemoteManagerAuthority({
    space, server, owner, instanceId: state.instanceId, serveActor: actors.serve,
    prepareCreds: materialCredential(prepare, "executor", state.identities.executor), tlsRequired: false,
  });
  const artifacts = managerClusterArtifacts();
  // The activation door is intentionally bounded to 64 canonical values. Registration publishes the
  // complete schema closure through registerRemoteManagerAuthority; activation needs the canonical
  // manager cluster document and its closure manifest to reconstruct the scoped serve surface.
  const contractArtifacts = [artifacts.document, artifacts.manifest];
  const registrationProof = rawDigest(JSON.stringify({
    v: 1, space, owner, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, actors,
    identities: prepareRequest.identities,
    artifactDigests: contractArtifacts.map((value) => rawDigest(JSON.stringify(value))),
  }));
  const activateRequest = {
    ...remoteManagerAuthorityRequest(state, "cli", "activate", registrationProof),
    contractArtifacts,
  };
  const parsedActivate = parseRemoteManagerAuthorityRequest(activateRequest);
  check("activate request carries the complete canonical manager artifact set",
    parsedActivate.contractArtifacts?.length === contractArtifacts.length && contractArtifacts.length > 0,
    { expected: contractArtifacts.length, parsed: parsedActivate.contractArtifacts?.length });
  const activate = await cotalAuthProvider.managerServiceAuthority!({
    store: participantStore, dir: participantDir,
    request: activateRequest,
  });
  check("manager authority prepare and activate traverse the registry-pinned HTTPS origin",
    httpsManagerAuthorityRequests === 2, httpsManagerAuthorityRequests);
  const retainedRegistrationProof = currentRegistrationProof(activate);
  const terminalProof = rawDigest(JSON.stringify({
    v: 1, space, owner, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, actors,
    identities: prepareRequest.identities, artifactDigests: [],
  }));

  const releaseDir = join(participantRoot, ".cotal", "native-retirement");
  mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
  const journals = new Map<string, TestReleaseJournal>();
  const failRelease = new Set<string>();
  let retirementMints = 0;
  let retainedValidations = 0;
  const remoteAuthority: NonNullable<ConstructorParameters<typeof Manager>[0]["remoteAuthority"]> = {
    owner, actors, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, identities: state.identities,
    supervisorCreds: materialCredential(prepare, "supervisor", state.identities.supervisor),
    executorCreds: materialCredential(prepare, "executor", state.identities.executor),
    serveCreds: materialCredential(activate, "serve", state.identities.serve),
    goalWriterCreds: materialCredential(activate, "goalWriter", state.identities.goalWriter),
    sessionLedgerCreds: materialCredential(activate, "sessionLedger", state.identities.sessionLedger),
    serveGrant: registered.serveGrant,
    agentBearerExchangeUrl: secureExchangeUrl,
    mintSessionServing: async () => { throw new Error("native retirement acceptance opens no terminal sessions"); },
    mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) => {
      retirementMints++;
      const response = await cotalAuthProvider.managerServiceAuthority!({
        store: participantStore, dir: participantDir,
        request: remoteManagerAuthorityRequest(state, "cli", "retire", terminalProof, undefined, undefined, {
          id: identity.id, target, opId, serveEpoch,
        }),
      });
      return materialCredential(response, "retirementRequester", identity);
    },
    prepareAgentRetirement: async ({ target, opId }) => {
      check("host callback receives the exact lifecycle-derived operation", opId === managedRetirementOpId(target.lifecycleUid), { target, opId });
      const key = `${target.owner}.${target.actor}.${target.lifecycleUid}`;
      if (failRelease.has(target.actor)) throw new Error("injected host release failure");
      await cotalAuthProvider.revokeAgent({ dir: hostDir, owner: target.owner, actor: target.actor });
      let journal = journals.get(key);
      if (!journal) {
        journal = new TestReleaseJournal(join(releaseDir, `${createHash("sha256").update(key).digest("hex")}.json`));
        journals.set(key, journal);
      }
      journal.release(target, opId);
      journal.release(target, opId);
      const mode = (await import("node:fs")).statSync(journal.path).mode & 0o777;
      check("host release journal is private and terminally idempotent", mode === 0o600 && journal.row()?.state === "released", mode.toString(8));
    },
    validateRetainedAgent: async ({ owner: retainedOwner, actor, lifecycleUid, actorToken, sentinelCreds }) => {
      retainedValidations++;
      const request = remoteRetainedAgentValidationRequest(
        state,
        "cli",
        retainedRegistrationProof,
        registered.processEpoch,
        { owner: retainedOwner, actor, lifecycleUid },
        actorToken,
        sentinelCreds,
      );
      const result = await cotalAuthProvider.validateRemoteRetainedAgent!({
        store: participantStore,
        dir: participantDir,
        request,
      });
      return retainedAgentAuthority(result, request);
    },
  };

  manager = new Manager({
    space, servers: server, runtime: "native-acceptance", workspaceRoot: participantRoot,
    secretStore: participantStore, remoteAuthority,
  });
  await manager.start();

  const personaDir = join(participantRoot, ".cotal", "agents");
  mkdirSync(personaDir, { recursive: true });
  const personaPath = join(personaDir, "native-retained.md");
  writeFileSync(personaPath, "---\nname: native-retained\nagent: native-acceptance\n---\nnative acceptance child\n");
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

  async function provisionRetained(actor: string, lifecycleUid: string): Promise<ManagerResumeAgent> {
    const grant = await cotalAuthProvider.grantAgent({
      store: hostStore, dir: hostDir, space, owner, actor, scope: [], allowSubscribe: [], allowPublish: [],
      parent: `${owner}.cli`, lifecycleUid,
    });
    const provisioner = new CotalEndpoint({
      space, servers: server, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [],
      consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
      card: { name: "native-provisioner", kind: "endpoint" },
    });
    await provisioner.start();
    try { await provisionAgentDurables(provisioner, { owner, actor, lifecycleUid }, { subscribe: [], allowSubscribe: [] }); }
    finally { await provisioner.stop(); }
    const files = agentLifecycleSecretFilePaths(participantRoot, space, actor, lifecycleUid);
    await participantStore.put(agentSecretKeyForFile(files.actorToken, space), grant.actorToken);
    await participantStore.put(agentSecretKeyForFile(files.sentinelCreds, space), grant.sentinelCreds);
    await materializeSecretToFile(participantStore, agentSecretKeyForFile(files.actorToken, space), files.actorToken);
    await materializeSecretToFile(participantStore, agentSecretKeyForFile(files.sentinelCreds, space), files.sentinelCreds);
    return {
      space, name: actor, identity: {
        mode: "user", owner, actor, lifecycleUid,
        actorToken: { kind: "file", path: files.actorToken, sha256: digest(files.actorToken) },
        sentinelCredential: { kind: "file", path: files.sentinelCreds, sha256: digest(files.sentinelCreds) },
        health: { kind: "file", path: files.health },
      },
      launch: { connector: "native-acceptance", runtime: "native-acceptance", cwd: participantRoot,
        source: { kind: "persona", ref: "native-retained", configPath: personaPath, configSha256: digest(personaPath) },
        allowSubscribe: [], allowPublish: [], capabilities: [], events: false },
      dependencies: [personaPath], spawner: `${owner}.cli`, authorityParent: `${owner}.cli`, startedAt: new Date().toISOString(),
    };
  }
  const inventoryOf = (agent: ManagerResumeAgent): ManagerResumeInventory => ({
    version: "cotal-manager-resume/v1", space, createdAt: new Date().toISOString(), agents: [agent],
  });
  const livenessDiagnostic = (actor: string, handle: ChildHandle) => {
    const principal = `${owner}.${actor}`;
    const exit = handle.exitInfo();
    const roster = (manager as unknown as { ep: { getRoster(): Array<{
      card: { id: string; name: string };
      lifecycleUid?: string;
      status: string;
      ts: number;
    }> } }).ep.getRoster()
      .filter((presence) => presence.card.id === principal)
      .map((presence) => ({
        name: presence.card.name,
        lifecycleUid: presence.lifecycleUid,
        status: presence.status,
        ts: presence.ts,
      }));
    return {
      processPid: handle.pid,
      processStatus: handle.status(),
      exitCode: exit?.code,
      exitSignal: exit?.signal,
      roster,
    };
  };
  const awaitOwnedExit = async (actor: string, handle: ChildHandle): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        handle.waitForExit(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`owned ${actor} process did not exit within 10 seconds`)), 10_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  console.log("\ncell 3/7: retained validation rejects stale, foreign-owner, and revoked authority");
  const validationUid = mintLifecycleUid();
  const validationEntry = await provisionRetained("validation_negative", validationUid);
  if (validationEntry.identity.mode !== "user") throw new Error("native validation entry is not user mode");
  let validationActorToken = readFileSync(validationEntry.identity.actorToken.path, "utf8");
  let validationSentinel = readFileSync(validationEntry.identity.sentinelCredential.path, "utf8");
  const validateRemote = async (target: { owner: string; actor: string; lifecycleUid: string }, registration = retainedRegistrationProof) => {
    const request = remoteRetainedAgentValidationRequest(
      state, "cli", registration, registered.processEpoch, target, validationActorToken, validationSentinel,
    );
    return cotalAuthProvider.validateRemoteRetainedAgent!({ store: participantStore, dir: participantDir, request });
  };
  const refuses = async (fn: () => Promise<unknown>, pattern: RegExp): Promise<boolean> => {
    try { await fn(); return false; }
    catch (error) { return error instanceof Error && pattern.test(error.message); }
  };
  check("stale registration proof is refused through registry-pinned HTTPS",
    await refuses(
      () => validateRemote({ owner, actor: "validation_negative", lifecycleUid: validationUid }, `sha256:${"f".repeat(64)}`),
      /current host registration/,
    ));
  const wrongOwner = `u_${"b".repeat(26)}`;
  check("wrong-owner retained validation is refused through registry-pinned HTTPS",
    await refuses(
      () => validateRemote({ owner: wrongOwner, actor: "validation_negative", lifecycleUid: validationUid }),
      /authenticated owner/,
    ));
  const revokeResult = await cotalAuthProvider.revokeAgent({ dir: hostDir, owner, actor: "validation_negative" });
  const { findManagedActor } = await import("@cotal-ai/auth");
  const rowAfterRevoke = findManagedActor(hostDir, owner, "validation_negative");
  let revokedOutcome: "accepted" | "threw" = "accepted";
  let revokedError: { name?: string; code?: string; message?: string } = {};
  try {
    await validateRemote({ owner, actor: "validation_negative", lifecycleUid: validationUid });
  } catch (error) {
    revokedOutcome = "threw";
    revokedError = error instanceof Error
      ? { name: error.name, code: (error as Error & { code?: string }).code, message: error.message.slice(0, 512) }
      : { message: String(error).slice(0, 512) };
  }
  check("revoked retained authority is refused through registry-pinned HTTPS",
    revokeResult === true && rowAfterRevoke === undefined && revokedOutcome === "threw" &&
      /manager retained-agent validation was refused: agent exchange refused: unknown agent or wrong secret/.test(revokedError.message ?? ""),
    {
      outcome: revokedOutcome,
      errorName: revokedError.name,
      errorCode: revokedError.code,
      errorMessage: revokedError.message,
      revokeResult: typeof revokeResult === "object" && revokeResult !== null
        ? Object.fromEntries(Object.entries(revokeResult).filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
        : String(revokeResult),
      rowPresentAfterRevoke: rowAfterRevoke !== undefined,
      rowLifecycleUidAfterRevoke: rowAfterRevoke?.lifecycleUid,
    });
  const restoredGrant = await cotalAuthProvider.grantAgent({
    store: hostStore, dir: hostDir, space, owner, actor: "validation_negative", lifecycleUid: validationUid,
    scope: [], allowSubscribe: [], allowPublish: [], parent: `${owner}.cli`,
  });
  validationActorToken = restoredGrant.actorToken;
  validationSentinel = restoredGrant.sentinelCreds;
  check("current retained authority validates through registry-pinned HTTPS after negative controls",
    Boolean(await validateRemote({ owner, actor: "validation_negative", lifecycleUid: validationUid })));

  console.log("\ncell 4/7: managed grant and lifecycle-keyed durables");
  const blockedUid = mintLifecycleUid();
  const blockedEntry = await provisionRetained("blocked", blockedUid);
  console.log("\ncell 5/7: public resumePreserved launches agent-child");
  const beforeBlockedValidations = retainedValidations;
  const beforeBlockedHttpsValidations = httpsManagerAuthorityRequests;
  const blockedResume = await manager.resumePreserved(inventoryOf(blockedEntry));
  check("public resumePreserved adopts the exact blocked lifecycle", blockedResume.ok,
    blockedResume.ok ? undefined : { reply: blockedResume, diagnostic: adoptionDiagnostic("blocked") });
  check("blocked adoption fresh-validates through the authenticated typed host route at preflight and spawn",
    retainedValidations === beforeBlockedValidations + 2,
    { before: beforeBlockedValidations, after: retainedValidations });
  check("blocked adoption validation traverses the registry-pinned HTTPS origin twice",
    httpsManagerAuthorityRequests === beforeBlockedHttpsValidations + 2,
    { before: beforeBlockedHttpsValidations, after: httpsManagerAuthorityRequests });
  if (!blockedResume.ok) throw new Error("blocked lifecycle adoption failed before release-refusal coverage armed");
  console.log("\ncell 6/7: public targeted despawn reaches host prepare and fails closed");
  failRelease.add("blocked");
  const beforeBlockedMints = retirementMints;
  const blockedStop = await endpoint.invokeService("manager", "despawn", { graceful: false }, {
    target: { mode: "owner", owner, actor: "blocked", lifecycleUid: blockedUid },
  });
  check("public targeted despawn accepts the blocked lifecycle", blockedStop.reply.ok, blockedStop.reply);
  if (!blockedStop.reply.ok) throw new Error("blocked lifecycle despawn was refused before release-failure coverage armed");
  const blockedHandle = childHandles.get("blocked");
  if (!blockedHandle) throw new Error("blocked lifecycle child handle disappeared before exit proof");
  await awaitOwnedExit("blocked", blockedHandle);
  check("the failed-release retry observes the old blocked process exited first", blockedHandle.status() === "exited",
    JSON.stringify(livenessDiagnostic("blocked", blockedHandle)));
  check("release failure prevents terminal requester issuance", retirementMints === beforeBlockedMints, retirementMints);
  const blockedRetry = await manager.resumePreserved(inventoryOf(blockedEntry));
  check("release failure keeps the alias held", !blockedRetry.ok && /retir/.test(blockedRetry.error ?? ""), JSON.stringify({
    error: blockedRetry.error,
    liveness: livenessDiagnostic("blocked", blockedHandle),
  }));

  console.log("\ncell 7/7: durable prepare, HTTP requester issuance, and terminal rail");
  const retiredUid = mintLifecycleUid();
  const retiredEntry = await provisionRetained("retired", retiredUid);
  const beforeRetiredValidations = retainedValidations;
  const beforeRetiredHttpsValidations = httpsManagerAuthorityRequests;
  const retiredResume = await manager.resumePreserved(inventoryOf(retiredEntry));
  check("public resumePreserved adopts the exact terminal lifecycle", retiredResume.ok,
    retiredResume.ok ? undefined : { reply: retiredResume, diagnostic: adoptionDiagnostic("retired") });
  check("terminal adoption independently fresh-validates through the authenticated typed host route at preflight and spawn",
    retainedValidations === beforeRetiredValidations + 2,
    { before: beforeRetiredValidations, after: retainedValidations });
  check("terminal adoption validation traverses the registry-pinned HTTPS origin twice",
    httpsManagerAuthorityRequests === beforeRetiredHttpsValidations + 2,
    { before: beforeRetiredHttpsValidations, after: httpsManagerAuthorityRequests });
  if (!retiredResume.ok) throw new Error("terminal lifecycle adoption failed before release-success coverage armed");
  const beforeRetiredMints = retirementMints;
  const retiredStop = await endpoint.invokeService("manager", "despawn", { graceful: false }, {
    target: { mode: "owner", owner, actor: "retired", lifecycleUid: retiredUid },
  });
  check("public targeted despawn accepts the terminal lifecycle", retiredStop.reply.ok, retiredStop.reply);
  if (!retiredStop.reply.ok) throw new Error("terminal lifecycle despawn was refused before release-success coverage armed");
  const retiredHandle = childHandles.get("retired");
  if (!retiredHandle) throw new Error("terminal lifecycle child handle disappeared before exit proof");
  observerNc = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }), maxReconnectAttempts: 0 });
  const lifecycle = await openLifecycleRegistry(observerNc, space);
  let retiredHead: Awaited<ReturnType<typeof readLifecycleHeadForOperation>>;
  for (let tries = 0; tries < 200; tries++) {
    retiredHead = await readLifecycleHeadForOperation(lifecycle, owner, "retired");
    if (retiredHead?.mapping.state === "retired") break;
    await wait(100);
  }
  check("host release resolves before one real requester is issued", retirementMints === beforeRetiredMints + 1, retirementMints);
  check("real auth barrier retires the exact lifecycle", retiredHead?.mapping.state === "retired" && retiredHead.mapping.lifecycleUid === retiredUid, retiredHead?.mapping);
  await awaitOwnedExit("retired", retiredHandle);
  check("the fresh-lifecycle probe observes the retired process exited first", retiredHandle.status() === "exited",
    JSON.stringify(livenessDiagnostic("retired", retiredHandle)));
  const replacementUid = mintLifecycleUid();
  const replacementEntry = await provisionRetained("retired", replacementUid);
  const aliasProbe = await manager.resumePreserved(inventoryOf(replacementEntry));
  check("terminal confirmation releases the Manager alias for a fresh lifecycle", aliasProbe.ok, JSON.stringify({
    error: aliasProbe.error,
    agents: aliasProbe.agents.map(({ name, reply }) => ({ name, error: reply.error })),
    liveness: livenessDiagnostic("retired", retiredHandle),
  }));

} catch (error) {
  fail++;
  console.log("  ✗ FAIL: harness threw", error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await endpoint?.stop().catch(() => {});
  await manager?.stop().catch(() => {});
  await observerNc?.drain().catch(() => observerNc?.close());
  exchangeProxy?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (!exchangeProxy) { resolve(); return; }
    exchangeProxy.close(() => resolve());
  });
  const authStopped = await stopChild(authService);
  const deliveryStopped = await stopChild(delivery);
  const brokerStopped = await stopChild(broker);
  idpServer?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (!idpServer) { resolve(); return; }
    idpServer.close(() => resolve());
  });
  check("teardown stops all owned daemons before removing scratch state", authStopped && deliveryStopped && brokerStopped, {
    auth: { exitCode: authService?.exitCode, signalCode: authService?.signalCode },
    delivery: { exitCode: delivery?.exitCode, signalCode: delivery?.signalCode },
    broker: { exitCode: broker?.exitCode, signalCode: broker?.signalCode },
  });
  if (authStopped && deliveryStopped && brokerStopped) {
    rmSync(participantHome, { recursive: true, force: true });
    rmSync(participantRoot, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  }
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  console.error = originalConsoleError;
}

console.log(`\nHOSTED RETIREMENT NATIVE HTTPS VALIDATION ACCEPTANCE ${fail === 0 ? "GREEN" : "FAILED"} (${pass} passed, ${fail} failed; credentials logged: no)`);
process.exitCode = fail === 0 ? 0 : 1;

/**
 * User-mode `cotal ps` census across every one of the caller's managers (#3959):
 *   P1: User A's `ps` without `--on` lists both of A's managers' seats, grouped, exit 0.
 *   P2: One of A's managers is stopped: it shows as no answer, census is incomplete, exit non-zero, other's rows still print.
 *   P3: User B's manager is not listed and is never exchanged for (including when only B's manager is live: exact empty-owner refusal); with A1+A2+B1 live, exchange count is 1 registry-reader + 2 pinned.
 *   P4: A registry-reader credential is refused by the broker on any ep request and on a records write.
 *   P5: With a single manager, the flat list is byte-identical to the single-instance output.
 *   P6: The agent-secret arm asking for `registry-reader` is refused.
 *   P7: A human whose grant lacks `admin` exchanges `registry-reader` on the public face and is refused with the scope remedy, and that human's `ps` without `--on` fails with that remedy.
 */
const subcommand = process.argv[2];
if (subcommand === "agent-bearer" || subcommand === "auth-service") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i]!;
    if (!value.startsWith("--")) positionals.push(value);
    else if (rest[i + 1] && !rest[i + 1]!.startsWith("--")) values[value.slice(2)] = rest[++i]!;
    else values[value.slice(2)] = true;
  }
  await registry.resolve<import("@cotal-ai/core").Command>("command", subcommand).run({ values, positionals, raw: rest });
  process.exit(0);
}
if (subcommand === "seat") {
  const { CotalEndpoint } = await import("@cotal-ai/core");
  const { execFile } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const e = process.env;
  const argv = JSON.parse(e.COTAL_BEARER_CMD!) as string[];
  const bearer = () => new Promise<string>((resolve, reject) => execFile(argv[0]!, argv.slice(1), { timeout: 15_000 }, (error, stdout) => {
    if (error) reject(new Error("seat bearer exchange refused")); else resolve(stdout.trim());
  }));
  const endpoint = new CotalEndpoint({
    space: e.COTAL_SPACE!, servers: e.COTAL_SERVERS!, bearer,
    sentinelCreds: readFileSync(e.COTAL_SENTINEL_CREDS!, "utf8"), lifecycleUid: e.COTAL_LIFECYCLE_UID!,
    channels: [], consume: false, watchChannels: false,
    card: { owner: e.COTAL_OWNER!, actor: e.COTAL_ACTOR!, name: e.COTAL_NAME!, kind: "agent" },
  });
  endpoint.on("error", () => {});
  await endpoint.start();
  const stop = () => { void endpoint.stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => {});
}

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { connect, PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import {
  compileContract, createSpaceAuth, epCast, EpEnvelopeError, eventChannel, isReachable, mintCreds,
  mintLifecycleUid, newIdentity, recordsBucket, registry, remoteManagerActors,
  remoteManagerRegistrationProof, serverConfig, setupSpaceStreams, standaloneConnectOpts,
  type Connector, type EpCaller,
} from "@cotal-ai/core";
import {
  agentLifecycleSecretFilePaths, assertUserAuthInfo, authDir, recordMesh, saveSpaceAuth,
  userAuthStateDir, workspaceSecretStore,
} from "@cotal-ai/workspace";
import {
  cotalAuthProvider, deriveOwnerForIdpSubject, fetchIdpJwt, findActorUnified, grantActor,
  loadAuthServiceInfo, loadCalloutAuth, loadOwnerSecret, loadPinnedIdp, saveIdpSession,
} from "@cotal-ai/auth";
import { Manager, type ManagerOptions } from "../src/manager.js";
import { managerClusterArtifacts } from "../src/manager-service-contract.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";
import * as remote from "../src/remote-authority.js";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const ALLOWED_CHILD_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "COTAL_SKIP_CONNECTOR_SEED"] as const;
function baseChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_CHILD_ENV_KEYS) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

const here = import.meta.dirname;
const self = resolve(here, "user-ps-census.smoke.ts");
const cotalBin = join(here, "..", "..", "..", "bin", "cotal.ts");
const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}fpsall-`));
const home = join(scratch, "home");
const hostRoot = join(scratch, "host");
const rootA1 = join(scratch, "mgr-a1");
const rootA2 = join(scratch, "mgr-a2");
const rootB1 = join(scratch, "mgr-b1");
const cliHome = join(scratch, "cli-home");
const cliRoot = join(scratch, "cli-root");
for (const dir of [home, hostRoot, rootA1, rootA2, rootB1, cliHome, cliRoot]) {
  mkdirSync(join(dir, ".cotal", "agents"), { recursive: true });
}
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;

const space = `fpsall${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const hostDir = userAuthStateDir(hostRoot, space);
const hostStore = workspaceSecretStore(hostRoot);

let passed = 0, failed = 0;
const cell = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${name}`, detail !== undefined ? JSON.stringify(detail).replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]").slice(0, 1200) : "");
  }
};
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, label: string, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await fn()) {
    if (Date.now() > end) throw new Error(label);
    await wait(100);
  }
}

let broker: ChildProcess | undefined;
let authChild: ChildProcess | undefined;
let managerA1: Manager | undefined;
let managerA2: Manager | undefined;
let managerB1: Manager | undefined;
let idpServer: ReturnType<typeof createServer> | undefined;
let proxyServer: ReturnType<typeof createServer> | undefined;
const connections: NatsConnection[] = [];
const recordedExchanges: Array<{ view?: string; managerInstanceId?: string; actor?: string; owner?: string; status: number }> = [];

try {
  const betterRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
  const { betterAuth } = await import(new URL("dist/index.mjs", betterRoot).href);
  const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterRoot).href);
  const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterRoot).href);
  const { bearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterRoot).href);
  const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterRoot).href);

  let handler: ReturnType<typeof toNodeHandler>;
  idpServer = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => idpServer!.listen(0, "127.0.0.1", r));
  const idpAddress = idpServer.address();
  assert(idpAddress && typeof idpAddress === "object");
  const origin = `http://127.0.0.1:${idpAddress.port}`;
  const idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({
    baseURL: origin,
    secret: "fpsall-disposable-fixture-secret-123456",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
    emailAndPassword: { enabled: true },
    plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), bearer()],
  });
  handler = toNodeHandler(idp);

  const signupA = await idp.api.signUpEmail({ body: { email: "owner-a@example.test", password: "native-fixture-password", name: "Owner A" } });
  const signupB = await idp.api.signUpEmail({ body: { email: "owner-b@example.test", password: "native-fixture-password", name: "Owner B" } });
  assert(signupA.token && signupA.user.id && signupB.token && signupB.user.id);
  const sessionA = { token: signupA.token, sub: signupA.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const sessionB = { token: signupB.token, sub: signupB.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  saveIdpSession(home, idpUrl, sessionA);

  const auth = await createSpaceAuth(space);
  saveSpaceAuth(authDir(hostRoot), auth);
  const prepared = await cotalAuthProvider.prepareServer({
    space,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: hostStore,
    dir: hostDir,
    idpUrl,
  });
  writeFileSync(join(scratch, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port,
    storeDir: join(scratch, "js"),
    extraAccounts: prepared.extraAccounts,
  }));
  broker = spawn("nats-server", ["-c", join(scratch, "server.conf")], { stdio: "ignore" });
  teardownOnSignal(broker, scratch);
  await until(() => isReachable(servers), "broker readiness");
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  authChild = spawn(process.execPath, [...process.execArgv, self, "auth-service", "--space", space, "--server", servers, "--exchange-public-port", "0"], {
    cwd: hostRoot,
    env: { ...baseChildEnv(), COTAL_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await until(async () => {
    if (authChild!.exitCode !== null) throw new Error("stock auth service exited during boot");
    const info = loadAuthServiceInfo(hostDir);
    return !!info?.publicUrl && (await fetch(`${info.url}/health`).catch(() => undefined))?.ok === true;
  }, "stock auth service readiness");

  const info = loadAuthServiceInfo(hostDir)!;
  const pin = loadPinnedIdp(hostDir)!;
  const secret = (await loadOwnerSecret(hostStore, space))!;
  const ownerA = deriveOwnerForIdpSubject(secret, pin.issuer, signupA.user.id);
  const ownerB = deriveOwnerForIdpSubject(secret, pin.issuer, signupB.user.id);
  const rowA = grantActor(hostDir, { owner: ownerA, actor: "cli", scope: ["spawn", "run", "supervise", "admin"], allowSubscribe: [">"], allowPublish: [">"], label: "owner A cli" });
  grantActor(hostDir, { owner: ownerB, actor: "cli", scope: ["spawn", "run", "supervise", "admin"], allowSubscribe: [">"], allowPublish: [">"], label: "owner B cli" });

  // Transparent proxy in front of the real public exchange listener to count exchanges in P3.
  proxyServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    const upstream = await fetch(`${info.publicUrl}${req.url ?? ""}`, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : rawBody,
    });
    const respBytes = Buffer.from(await upstream.arrayBuffer());
    if (req.url === "/exchange" && req.method === "POST") {
      try {
        const parsed = JSON.parse(rawBody.toString("utf8")) as { view?: string; managerInstanceId?: string; actor?: string; owner?: string };
        recordedExchanges.push({
          ...(parsed.view !== undefined ? { view: parsed.view } : {}),
          ...(parsed.managerInstanceId !== undefined ? { managerInstanceId: parsed.managerInstanceId } : {}),
          ...(parsed.actor !== undefined ? { actor: parsed.actor } : {}),
          ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}),
          status: upstream.status,
        });
      } catch {
        recordedExchanges.push({ status: upstream.status });
      }
    }
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(respBytes);
  });
  await new Promise<void>((r) => proxyServer!.listen(0, "127.0.0.1", r));
  const proxyAddr = proxyServer.address();
  assert(proxyAddr && typeof proxyAddr === "object");
  const proxyOrigin = `http://127.0.0.1:${proxyAddr.port}`;

  const connector: Connector = {
    kind: "connector",
    name: "fpsall-seat",
    requires: ["node"],
    eventChannel,
    buildLaunch: (o) => {
      assert(o.userAuth && o.lifecycleUid);
      return {
        command: process.execPath,
        args: [...process.execArgv, self, "seat"],
        env: {
          ...baseChildEnv(),
          COTAL_SPACE: o.space,
          COTAL_SERVERS: servers,
          COTAL_OWNER: o.userAuth.owner,
          COTAL_ACTOR: o.userAuth.actor,
          COTAL_NAME: o.name,
          COTAL_LIFECYCLE_UID: o.lifecycleUid,
          COTAL_SENTINEL_CREDS: o.userAuth.sentinelCredsPath,
          COTAL_BEARER_CMD: JSON.stringify(o.userAuth.bearerCmd),
        },
      };
    },
  };
  registry.register(connector);

  const callArgs = { store: hostStore, dir: hostDir };
  const withSession = async <T>(session: typeof sessionA, fn: () => Promise<T>): Promise<T> => {
    saveIdpSession(home, idpUrl, session);
    try {
      return await fn();
    } finally {
      saveIdpSession(home, idpUrl, sessionA);
    }
  };

  const bootRemoteManager = async (
    workspaceRoot: string,
    mgrOwner: string,
    session: typeof sessionA,
  ): Promise<{ manager: Manager; instanceId: string }> => {
    recordMesh({ space, server: servers, root: workspaceRoot, mode: "user", userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
    const state = remote.loadOrCreateRemoteManagerIdentity(workspaceRoot, space);
    const callAuthority = (request: Parameters<NonNullable<typeof cotalAuthProvider.managerServiceAuthority>>[0]["request"]) =>
      withSession(session, () => cotalAuthProvider.managerServiceAuthority!({ ...callArgs, request }));
    const prep = await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
    const supervisorCreds = remote.materialCredential(prep, "supervisor", state.identities.supervisor);
    const executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
    const registered = await registerRemoteManagerAuthority({
      space,
      server: servers,
      owner: mgrOwner,
      instanceId: state.instanceId,
      serveActor: remoteManagerActors(state.instanceId).serve,
      prepareCreds: executorCreds,
      tlsRequired: false,
      evict: async (principals) => {
        const request = remote.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
        const result = await withSession(session, () => cotalAuthProvider.maintainRemoteManager!({ ...callArgs, request }));
        return remote.remoteManagerMaintenanceResult(result, request, mgrOwner).evictions!.map((e) => e.verifiedGone);
      },
    });
    const artifacts = managerClusterArtifacts();
    const contractArtifacts = [artifacts.document, artifacts.manifest];
    const activate = await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "activate", {
      registrationProof: remoteManagerRegistrationProof(mgrOwner, state, contractArtifacts),
      contractArtifacts,
    }));
    const proof = remote.currentRegistrationProof(activate);
    const standing = remote.remoteStandingBundleRenewal({ state, owner: mgrOwner, registrationProof: proof, supervisorCreds, call: callAuthority });
    const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
      ...standing,
      owner: mgrOwner,
      actors: remoteManagerActors(state.instanceId),
      instanceId: state.instanceId,
      lifecycleUid: state.lifecycleUid,
      identities: state.identities,
      supervisorCreds,
      executorCreds,
      serveCreds: remote.materialCredential(activate, "serve", state.identities.serve),
      goalWriterCreds: remote.materialCredential(activate, "goalWriter", state.identities.goalWriter),
      sessionLedgerCreds: remote.materialCredential(activate, "sessionLedger", state.identities.sessionLedger),
      serveGrant: registered.serveGrant,
      agentBearerExchangeUrl: info.publicUrl!,
      renewExecutor: async () => remote.materialCredential(await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
      authorizeAdmin: async (caller) => {
        const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
        const response = await withSession(session, () => cotalAuthProvider.authorizeRemoteManagerAdmin!({ ...callArgs, request }));
        return remote.remoteManagerAdminAuthorized(response, request, mgrOwner);
      },
      enrollManagedAgent: async ({ target }) => {
        const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
        return remote.remoteManagedAgentEnrollmentMaterial(await withSession(session, () => cotalAuthProvider.enrollRemoteManagedAgent!({ ...callArgs, request })), request);
      },
      prepareAgentRetirement: async ({ target, opId }) => {
        const request = remote.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, target, opId);
        remote.remoteManagedAgentRetirementPrepared(await withSession(session, () => cotalAuthProvider.prepareRemoteManagedAgentRetirement!({ ...callArgs, request })), request);
      },
      mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) =>
        remote.materialCredential(await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "retire", {
          registrationProof: remoteManagerRegistrationProof(mgrOwner, state),
          retirement: { id: identity.id, target, opId, serveEpoch },
        })), "retirementRequester", identity),
      mintSessionServing: async () => { throw new Error("fixture does not request attach sessions"); },
      validateRetainedAgent: async () => { throw new Error("fixture starts no retained seat"); },
      scanGoalIndex: async () => {
        const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
        return remote.remoteManagerGoalIndexEntries(await withSession(session, () => cotalAuthProvider.scanRemoteManagerGoalIndex!({ ...callArgs, request })), request, mgrOwner);
      },
    };
    const started = new Manager({ space, servers, workspaceRoot, runtime: "pty", remoteAuthority });
    await started.start();
    return { manager: started, instanceId: state.instanceId };
  };

  // Register User A's remote CLI entry pointing at the public-exchange proxy.
  const callout = (await loadCalloutAuth(hostStore, space))!;
  const cliStateDir = userAuthStateDir(cliRoot, space);
  mkdirSync(cliStateDir, { recursive: true });
  const sentinelCredsPath = join(cliStateDir, "sentinel.creds");
  writeFileSync(sentinelCredsPath, callout.sentinelCreds, { mode: 0o600 });
  const publicUa = assertUserAuthInfo(prepared.publicAuth);
  process.env.COTAL_HOME = cliHome;
  try {
    recordMesh({
      space,
      server: servers,
      root: cliRoot,
      mode: "user",
      origin: "manual",
      userAuth: {
        ...publicUa,
        remote: true,
        endpoints: { url: proxyOrigin },
        sentinelCredsPath,
      },
      ts: new Date().toISOString(),
    });
  } finally {
    process.env.COTAL_HOME = home;
  }
  saveIdpSession(cliHome, idpUrl, sessionA);

  const cli = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string; out: string }>((done) => {
    execFile(
      process.execPath,
      [...process.execArgv, cotalBin, ...args],
      {
        cwd: cliRoot,
        env: { ...baseChildEnv(), COTAL_HOME: cliHome, COTAL_SKIP_CONNECTOR_SEED: "1" },
        timeout: 60_000,
      },
      (error, stdout, stderr) => done({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout,
        stderr,
        out: `${stdout}${stderr}`,
      }),
    );
  });

  // Boot Manager A1 (Owner A) + Manager B1 (Owner B) and spawn one seat on each.
  for (const [r, name] of [[rootA1, "seat_a1"], [rootA2, "seat_a2"], [rootB1, "seat_b1"]] as const) {
    writeFileSync(
      join(r, ".cotal", "agents", `${name}.md`),
      `---\nname: ${name}\nagent: fpsall-seat\ncapabilities: []\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\nSeat ${name}.\n`,
    );
  }
  const mB1 = await bootRemoteManager(rootB1, ownerB, sessionB);
  managerB1 = mB1.manager;
  const iidB1 = mB1.instanceId;
  const startedSeatB1 = await managerB1.startAgent({ name: "seat_b1" }, `${ownerB}.cli`);
  assert.equal(startedSeatB1.ok, true);

  // Empty-owner census (F4): only B's manager is live in the space; A has none registered yet.
  recordedExchanges.length = 0;
  const psEmptyOwner = await cli(["ps", "--space", space]);
  const emptyOwnerOut = strip(psEmptyOwner.out).trim();
  const emptyOwnerExchanges = [...recordedExchanges];
  const expectedEmptyOwnerError = `✗ no live manager for owner ${ownerA} is registered in space "${space}"; start one with \`cotal supervise --space ${space}\`, or target a specific instance with \`--on <instance>\``;

  const mA1 = await bootRemoteManager(rootA1, ownerA, sessionA);
  managerA1 = mA1.manager;
  const iidA1 = mA1.instanceId;
  const startedSeatA1 = await managerA1.startAgent({ name: "seat_a1" }, `${ownerA}.cli`);
  assert.equal(startedSeatA1.ok, true);
  // Pin seat_a1's startedAt >60s in the past so fmtUptime renders "2m" across both P5 ps invocations.
  (managerA1 as unknown as { agents: Map<string, { startedAt: number }> }).agents.get("seat_a1")!.startedAt = Date.now() - 125_000;

  // ---- P5: With a single manager for A, the flat list is byte-identical to main's output ----
  const psPinnedSingle = await cli(["ps", "--space", space, "--on", iidA1]);
  const psUnpinnedSingle = await cli(["ps", "--space", space]);
  cell(
    "P5: with a single manager for the caller, the flat list is byte-identical to the single-manager output",
    psPinnedSingle.code === 0 &&
      psUnpinnedSingle.code === 0 &&
      psUnpinnedSingle.stdout === psPinnedSingle.stdout &&
      psUnpinnedSingle.stdout.includes("seat_a1") &&
      !psUnpinnedSingle.out.includes(`manager ${iidA1}`) &&
      !psUnpinnedSingle.out.includes("seat_b1"),
    { pinned: psPinnedSingle, unpinned: psUnpinnedSingle },
  );

  // Boot Manager A2 (Owner A's second manager) and spawn seat_a2.
  const mA2 = await bootRemoteManager(rootA2, ownerA, sessionA);
  managerA2 = mA2.manager;
  const iidA2 = mA2.instanceId;
  const startedSeatA2 = await managerA2.startAgent({ name: "seat_a2" }, `${ownerA}.cli`);
  assert.equal(startedSeatA2.ok, true);

  // ---- P1 & P3: Two live managers for A + one for B in the same space ----
  recordedExchanges.length = 0;
  const psMulti = await cli(["ps", "--space", space]);
  const multiOut = strip(psMulti.out);
  cell(
    "P1: A's ps without --on lists both of A's managers' seats, grouped, exit 0",
    psMulti.code === 0 &&
      multiOut.includes(`manager ${iidA1}`) &&
      multiOut.includes(`manager ${iidA2}`) &&
      multiOut.includes("seat_a1") &&
      multiOut.includes("seat_a2"),
    { code: psMulti.code, out: multiOut },
  );

  const registryReaderExchanges = recordedExchanges.filter((e) => e.view === "registry-reader");
  const pinnedExchanges = recordedExchanges.filter((e) => e.view === "manager-caller" && e.managerInstanceId !== undefined);
  const pinnedTargets = pinnedExchanges.map((e) => e.managerInstanceId).sort();
  const expectedTargets = [iidA1, iidA2].sort();
  cell(
    "P3: B's manager is not listed and is never exchanged for (including empty-owner refusal when only B is live); exchanges are 1 registry-reader + 2 pinned",
    psEmptyOwner.code === 1 &&
      emptyOwnerOut === expectedEmptyOwnerError &&
      !emptyOwnerOut.includes("has no live registered instances") &&
      !emptyOwnerOut.includes(iidB1) &&
      emptyOwnerExchanges.length === 1 &&
      emptyOwnerExchanges[0]?.view === "registry-reader" &&
      !multiOut.includes(iidB1) &&
      !multiOut.includes("seat_b1") &&
      recordedExchanges.length === 3 &&
      registryReaderExchanges.length === 1 &&
      pinnedExchanges.length === 2 &&
      JSON.stringify(pinnedTargets) === JSON.stringify(expectedTargets) &&
      !recordedExchanges.some((e) => e.managerInstanceId === iidB1),
    { emptyOwnerCode: psEmptyOwner.code, emptyOwnerOut, emptyOwnerExchanges, recordedExchanges, multiOut },
  );

  // ---- P2: One of A's managers is stopped (registration still live): shows as no answer, incomplete census, exit non-zero, other's rows still print ----
  (managerA2 as unknown as { leaseStopping: boolean }).leaseStopping = true;
  await ((managerA2 as unknown as { serviceServe?: { nc: NatsConnection } }).serviceServe!.nc).close();
  const psStopped = await cli(["ps", "--space", space]);
  const stoppedOut = strip(psStopped.out);
  cell(
    "P2: when one of A's managers is stopped, it shows as no answer, the census is incomplete, exit is non-zero, and the other's rows still print",
    psStopped.code !== 0 &&
      stoppedOut.includes(`manager ${iidA1}`) &&
      stoppedOut.includes("seat_a1") &&
      stoppedOut.includes(`manager ${iidA2}`) &&
      stoppedOut.includes("registered, no answer within the deadline") &&
      stoppedOut.includes("Incomplete manager census") &&
      !stoppedOut.includes(iidB1),
    { code: psStopped.code, out: stoppedOut },
  );

  // ---- P4: A registry-reader credential is refused by the broker on any ep request and on a records write ----
  const idpJwtA = await fetchIdpJwt(idpUrl, sessionA.token);
  const rrRes = await fetch(`${info.publicUrl}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idpToken: idpJwtA, actor: "cli", view: "registry-reader" }),
  });
  const rrBody = (await rrRes.json().catch(() => ({}))) as { token?: string; error?: string };
  let epClassDenied = false;
  let epInstDenied = false;
  let recordsWriteDenied = false;
  if (rrRes.status === 200 && typeof rrBody.token === "string") {
    const rrNc = await connect({
      servers,
      ...standaloneConnectOpts({ bearer: rrBody.token, sentinelCreds: callout.sentinelCreds, tls: false }),
      maxReconnectAttempts: 0,
    });
    connections.push(rrNc);
    const caller: EpCaller = { owner: ownerA, actor: "cli", uid: rowA.lifecycleUid! };
    const emptyContract = compileContract({ root: { type: "null" } });
    try {
      await epCast(rrNc, space, { mode: "one" }, {
        endpoint: "manager", command: "ps", contract: { input: emptyContract, output: emptyContract }, caller,
      });
    } catch (e) {
      epClassDenied = e instanceof EpEnvelopeError && e.code === "permission-denied";
    }
    try {
      await epCast(rrNc, space, { mode: "inst", instanceId: iidA1 }, {
        endpoint: "manager", command: "ps", contract: { input: emptyContract, output: emptyContract }, caller,
      });
    } catch (e) {
      epInstDenied = e instanceof EpEnvelopeError && e.code === "permission-denied";
    }
    const writeSubject = `$KV.${recordsBucket(space)}.svc.manager.${iidA1}.spec`;
    const writeViolation = new Promise<boolean>((resolveViolation) => {
      const timer = setTimeout(() => resolveViolation(false), 1_500);
      void (async () => {
        for await (const s of rrNc.status()) {
          if (s.type === "error" && s.error instanceof PermissionViolationError && s.error.subject === writeSubject) {
            clearTimeout(timer);
            resolveViolation(true);
            return;
          }
        }
      })().catch(() => resolveViolation(false));
    });
    rrNc.publish(writeSubject, new Uint8Array());
    await rrNc.flush().catch(() => {});
    recordsWriteDenied = await writeViolation;
  }
  cell(
    "P4: a registry-reader credential is refused by the broker on any ep request and on a records write",
    rrRes.status === 200 && epClassDenied && epInstDenied && recordsWriteDenied,
    { status: rrRes.status, rrBody, epClassDenied, epInstDenied, recordsWriteDenied },
  );

  // ---- P6: The agent-secret arm asking for `registry-reader` is refused ----
  const seatA1Row = findActorUnified(hostDir, ownerA, "seat_a1");
  assert(seatA1Row?.lifecycleUid);
  const seatA1Token = readFileSync(agentLifecycleSecretFilePaths(rootA1, space, "seat_a1", seatA1Row.lifecycleUid).actorToken, "utf8").trim();
  const seatControlRes = await fetch(`${info.publicUrl}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: ownerA, actor: "seat_a1", actorToken: seatA1Token }),
  });
  const seatRrRes = await fetch(`${info.publicUrl}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: ownerA, actor: "seat_a1", actorToken: seatA1Token, view: "registry-reader" }),
  });
  const seatRrBody = (await seatRrRes.json().catch(() => ({}))) as { error?: string };
  cell(
    "P6: the agent-secret arm asking for registry-reader is refused",
    seatControlRes.status === 200 &&
      seatRrRes.status === 400 &&
      seatRrBody.error === "the managed (agent-secret) exchange never mints elevated views - views ride a signed-in human exchange",
    { controlStatus: seatControlRes.status, status: seatRrRes.status, body: seatRrBody },
  );

  // ---- P7: A human whose grant lacks `admin` exchanges `registry-reader` on the public face and is refused with the scope remedy, and that human's `ps` without `--on` fails with that remedy ----
  const signupC = await idp.api.signUpEmail({ body: { email: "member-c@example.test", password: "native-fixture-password", name: "Member C" } });
  assert(signupC.token && signupC.user.id);
  const sessionC = { token: signupC.token, sub: signupC.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const ownerC = deriveOwnerForIdpSubject(secret, pin.issuer, signupC.user.id);
  grantActor(hostDir, { owner: ownerC, actor: "cli", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"], label: "member C cli" });
  const expectedCScopeRemedy =
    `the "registry-reader" view needs scope "admin", which your grant lacks. Ask the mesh operator to re-grant the WHOLE ROW with "admin" ADDED to its scope. This is not a scope edit: ` +
    `run exactly the line below, which already carries every other field the row holds today. ` +
    `cotal actor grant cli --owner ${ownerC} --scope 'spawn,admin' --allow-subscribe 'general' --allow-publish 'general' --label 'member C cli'  ` +
    `(every field spelled out on purpose: the upsert replaces the WHOLE row, not just the scope, and a field left off comes back as the WIDE default, \`>\` read and \`>\` post)`;
  const idpJwtC = await fetchIdpJwt(idpUrl, sessionC.token);
  const cRrRes = await fetch(`${info.publicUrl}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idpToken: idpJwtC, actor: "cli", view: "registry-reader" }),
  });
  const cRrBody = (await cRrRes.json().catch(() => ({}))) as { token?: string; error?: string };
  saveIdpSession(cliHome, idpUrl, sessionC);
  let psNoAdmin: Awaited<ReturnType<typeof cli>>;
  try {
    psNoAdmin = await cli(["ps", "--space", space]);
  } finally {
    saveIdpSession(cliHome, idpUrl, sessionA);
  }
  const noAdminOut = strip(psNoAdmin.out).trim();
  cell(
    "P7: a human whose grant lacks admin is refused registry-reader on the public face with the scope remedy, and that human's ps without --on fails with that exact remedy",
    cRrRes.status === 401 &&
      cRrBody.error === expectedCScopeRemedy &&
      psNoAdmin.code === 1 &&
      noAdminOut === `✗ signed in, but the exchange for actor "cli" (view "registry-reader") was refused: ${expectedCScopeRemedy}`,
    { status: cRrRes.status, body: cRrBody, psCode: psNoAdmin.code, psOut: noAdminOut, expectedCScopeRemedy },
  );
} finally {
  await Promise.allSettled(connections.map((nc) => nc.close()));
  await managerA1?.stop({ withAgents: true }).catch(() => {});
  await managerA2?.stop({ withAgents: true }).catch(() => {});
  await managerB1?.stop({ withAgents: true }).catch(() => {});
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  proxyServer?.close();
  idpServer?.close();
  if (authChild) await killAndAwaitExit(authChild);
  if (broker) await killAndAwaitExit(broker);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`USER PS CENSUS SMOKE: ${passed} passed, ${failed} failed`);
if (failed > 0 || passed !== 7) process.exit(1);

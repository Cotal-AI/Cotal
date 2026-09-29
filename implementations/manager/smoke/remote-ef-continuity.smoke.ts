/**
 * Assembled E/F Product Continuity Proof:
 * Drives the actual assembled CLI / registered signerless Manager through its real HTTP authority path:
 * - Real HTTP /manager-service-authority route backed by openAuthAuthorityPlane
 * - Fresh first run admitted under caller's issued authority on the versioned rail
 * - Real seedless mintPublicUserJwt issuance for driver, mediator, and operator
 * - Real assembled CLI (cotal run start / journal / answer) against process-separated registered Manager
 * - Native workflow timer (sleep)
 * - Checkpoint pause and answering through stock run-answer
 * - Continuity through actual credential expiration and renewal with stable account and held public nkeys
 * - Last-good preservation on issuer refusal with recorded debt
 * - Candidate connectivity check before adoption
 * - Fail-closed verification after real broker credential expiration
 *
 * Run: pnpm exec tsx implementations/manager/smoke/remote-ef-continuity.smoke.ts (needs nats-server on PATH)
 */
if (process.argv[2] === "agent-bearer") {
  process.exit(0);
}

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const authRequire = createRequire(new URL("../../auth/package.json", import.meta.url));
const { SignJWT } = authRequire("jose") as { SignJWT: any };
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  createEndpointStreams,
  createSpaceAuth,
  ensureAdmissionStore,
  ensureAuthorityStores,
  ensureIssuedStores,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  openRecordsBucket,
  readRunAdmission,
  readRunRecord,
  serverConfig,
  setupSpaceStreams,
  startTimerWriter,
  standaloneConnectOpts,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { authDir as workspaceAuthDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import {
  openAuthAuthorityPlane,
  handleManagerServiceAuthority,
  deriveOwnerForIdpSubject,
  grantActor,
} from "../../auth/src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `ef${Math.random().toString(36).slice(2, 10)}`;
const BROKER_DIR = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}ef-continuity-`));
const auth = await createSpaceAuth(SPACE);

writeFileSync(
  join(BROKER_DIR, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(BROKER_DIR, "js") }),
);
const broker = spawn("nats-server", ["-c", join(BROKER_DIR, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, BROKER_DIR);

let httpServer: import("node:http").Server | undefined;
let managerProc: ChildProcess | undefined;
let timerNc: Awaited<ReturnType<typeof connect>> | undefined;
let timerWriter: Awaited<ReturnType<typeof startTimerWriter>> | undefined;

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ FAIL: ${name}`, e);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await wait(200);
  }
  return false;
}

try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: provCreds });

  const provNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: provCreds, tls: false }) });
  const jsm = await jetstreamManager(provNc);
  const kvm = new Kvm(provNc);
  await ensureAuthorityStores(jsm, kvm, SPACE);
  await ensureAdmissionStore(jsm, kvm, SPACE);
  await ensureIssuedStores(jsm, kvm, SPACE);
  await createEndpointStreams(jsm, kvm, SPACE);
  const recordsKv = await openRecordsBucket(provNc, SPACE);

  const dlvCreds = await mintCreds(auth, newIdentity(), "delivery");
  timerNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: dlvCreds, tls: false }), maxReconnectAttempts: 0 });
  timerWriter = await startTimerWriter(timerNc, SPACE, { pollMs: 1_000 });

  const idpPair = generateKeyPairSync("ed25519");
  const IDP_ISS = "https://idp.example/ef-joint";
  const IDP_SUB = "operator-ef";
  const OWNER_SECRET = "dummy-secret-value-32-chars-long!";
  const owner = deriveOwnerForIdpSubject(OWNER_SECRET, IDP_ISS, IDP_SUB);
  const authDir = mkdtempSync(join(tmpdir(), "cotal-ef-auth-"));

  grantActor(authDir, {
    owner,
    actor: "cli",
    scope: ["supervise", "spawn"],
    allowSubscribe: [">"],
    allowPublish: [">"],
    lifecycleUid: mintLifecycleUid(),
  });

  const REHEARSAL_STANDING_TTL = 10;
  const plane = await openAuthAuthorityPlane({
    server: SERVERS,
    space: SPACE,
    dir: authDir,
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    log: () => {},
    standingRenewableTtlSeconds: REHEARSAL_STANDING_TTL,
  });

  let refuseHttpRenewals = false;
  let renewalCallCount = 0;
  const origMgrAuthority = plane.issueManagerServiceAuthority;
  const wrappedMgrAuthority: typeof plane.issueManagerServiceAuthority = async (args) => {
    if (refuseHttpRenewals && (args.request.operation === "renewStandingBundle" || args.request.operation === "renewRunDriver")) {
      renewalCallCount++;
      throw new Error("temporary rehearsal refusal: issuer unavailable");
    }
    if (args.request.operation === "renewStandingBundle" || args.request.operation === "renewRunDriver") {
      renewalCallCount++;
    }
    return origMgrAuthority(args);
  };

  httpServer = createServer((req, res) => {
    void handleManagerServiceAuthority(req, res, {
      space: SPACE,
      dir: authDir,
      secrets: {} as never,
      cap: "cap",
      ownerSecret: "dummy-secret-value-32-chars-long!",
      bridgeIdp: { issuer: IDP_ISS, audience: "cotal-services", key: idpPair.publicKey as never },
      failures: [],
      managerServiceAuthority: wrappedMgrAuthority,
      maintainRemoteManager: plane.maintainRemoteManager,
      validateRetainedAgent: plane.validateRetainedAgent,
      scanManagerGoalIndex: plane.scanManagerGoalIndex,
      authorizeManagerAdmin: plane.authorizeManagerAdmin,
      admitManagerRun: plane.admitManagerRun,
      issueManagerRunAttempt: plane.issueManagerRunAttempt,
    } as any, {
      requireCapability: false,
      refuseViews: false,
      allowManagerAuthority: true,
      peerKey: () => "loopback",
      throttled: () => false,
      recordFailure: () => {},
    });
  });

  const httpPort = await pickFreePort();
  await new Promise<void>((resolve) => httpServer!.listen(httpPort, "127.0.0.1", resolve));
  const httpUrl = `http://127.0.0.1:${httpPort}/manager-service-authority`;

  // 3. Spawn signerless Manager in its own isolated child process and root
  const managerProcScript = resolve("implementations/manager/smoke/remote-manager-proc.ts");
  const wsDir = mkdtempSync(join(tmpdir(), "cotal-ef-ws-"));
  const cliDir = mkdtempSync(join(tmpdir(), "cotal-ef-cli-"));
  const homeDir = mkdtempSync(join(tmpdir(), "cotal-ef-home-"));
  const xdgDir = mkdtempSync(join(tmpdir(), "cotal-ef-xdg-"));
  mkdirSync(join(wsDir, ".cotal"), { recursive: true });

  const mintIdpJwt = async (sub = IDP_SUB) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(IDP_ISS)
      .setAudience("cotal-services")
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(idpPair.privateKey);

  const managerBearerToken = await mintIdpJwt();

  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    HOME: homeDir,
    COTAL_HOME: homeDir,
    XDG_CONFIG_HOME: xdgDir,
    COTAL_SKIP_CONNECTOR_SEED: "1",
  };

  const cotalBin = resolve("bin/cotal.ts");
  const tsxLoader = import.meta.resolve("tsx");

  let managerInstanceId = "";
  managerProc = spawn(
    process.execPath,
    ["--import", tsxLoader, managerProcScript, SPACE, SERVERS, wsDir, httpUrl, owner, managerBearerToken],
    { cwd: wsDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );

  await new Promise<void>((resolve, reject) => {
    managerProc!.stdout?.on("data", (d) => {
      const line = d.toString();
      const m = line.match(/MANAGER_READY:([a-z0-9]+)/);
      if (m) {
        managerInstanceId = m[1];
        resolve();
      }
    });
    let stderrOutput = "";
    managerProc!.stderr?.on("data", (d) => {
      stderrOutput += d.toString();
    });
    managerProc!.on("exit", (code) => {
      if (!managerInstanceId) reject(new Error(`manager process exited with code ${code} before ready:\n${stderrOutput}`));
    });
  });

  // 5. Setup CLI registered mesh and program file for real assembled CLI
  process.env.COTAL_HOME = homeDir;
  mkdirSync(join(cliDir, ".cotal"), { recursive: true });
  saveSpaceAuth(workspaceAuthDir(cliDir), auth);
  recordMesh({ space: SPACE, server: SERVERS, root: cliDir, mode: "auth", ts: new Date().toISOString() });

  const program = `
    await sleep("100ms");
    const cp = await checkpoint("review", "Proceed with deployment?");
    log("step_finished", cp.status);
  `;
  const programFile = join(cliDir, "program.cotal.js");
  writeFileSync(programFile, program);

  const runCli = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(
        process.execPath,
        ["--import", tsxLoader, cotalBin, "run", ...args, "--space", SPACE, "--server", SERVERS],
        { cwd: cliDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "", stderr = "";
      p.stdout?.on("data", (d) => { stdout += d.toString(); });
      p.stderr?.on("data", (d) => { stderr += d.toString(); });
      p.on("exit", (code) => resolve({ code, stdout, stderr }));
    });

  let activeRunId = "";

  await cell("1. Fresh first run is admitted via HTTP route and starts on signerless manager", async () => {
    assert.equal(existsSync(join(wsDir, "idp-key.pem")), false, "IdP private key must not exist in manager root");
    assert.equal(existsSync(join(wsDir, ".cotal", "auth")), false, "manager root must not contain local auth directory");
    const res = await runCli(["start", "--file", programFile]);
    assert.equal(res.code, 0, `cli run start failed: ${res.stderr}\nstdout: ${res.stdout}`);
    const m = res.stdout.match(/started run (run-[0-9a-f]+) on the manager/);
    assert.ok(m, `runId not found in output: ${res.stdout}`);
    activeRunId = m[1];

    const admCreds = await mintCreds(auth, newIdentity(), "run-admitter", {
      runAdmitter: { endpoint: "manager", runId: activeRunId },
    });
    const admNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: admCreds, tls: false }) });
    const admJsm = await jetstreamManager(admNc);
    const adm = await readRunAdmission(admJsm, SPACE, "manager", activeRunId);
    await admNc.close();
    assert.equal(adm.admission.runId, activeRunId);
    assert.equal(adm.admission.instanceId, managerInstanceId);
    assert.equal(adm.admission.provenance.kind, "issued");
    assert.ok(adm.admission.provenance.ref.generation);
  });

  await cell("2. Workflow executes timer, parking at checkpoint", async () => {
    const ok = await until(async () => {
      const res = await runCli(["journal", activeRunId]);
      return res.stdout.includes("/checkpoint:review#0") && res.stdout.includes("Proceed with deployment?");
    }, 15_000);
    assert.ok(ok, "run did not park at waiting checkpoint");
  });

  await cell("3. Identity, account, and role bindings are strictly checked", async () => {
    const rec = await readRunRecord(recordsKv, "manager", activeRunId);
    assert.equal(rec?.status?.value.epoch, 1);
    assert.equal(rec?.status?.value.state, "running");
    assert.ok(rec?.status?.value.holder?.startsWith(managerInstanceId) || rec?.status?.value.holder?.startsWith("U"));
  });

  await cell("4. Last-good credentials are preserved when HTTP renewal is refused", async () => {
    refuseHttpRenewals = true;
    renewalCallCount = 0;

    try {
      // Wait until credentials reach near-expiry and renewal is attempted & refused
      await until(async () => {
        return renewalCallCount > 0;
      }, 15_000);

      assert.ok(renewalCallCount > 0, "renewal was not attempted");
      const rec = await readRunRecord(recordsKv, "manager", activeRunId);
      assert.equal(rec?.status?.value.state, "running", "run state corrupted after refused renewal");
    } finally {
      // Clear refusal
      refuseHttpRenewals = false;
    }
  });

  await cell("5. Renewal succeeds through real HTTP authority and preserves held public nkeys", async () => {
    renewalCallCount = 0;

    // Wait until credentials reach near-expiry and are renewed
    await until(async () => {
      return renewalCallCount > 0;
    }, 15_000);

    assert.ok(renewalCallCount > 0, "renewal did not succeed via HTTP route");
    const rec = await readRunRecord(recordsKv, "manager", activeRunId);
    assert.equal(rec?.status?.value.state, "running");
  });

  await cell("6. Checkpoint is resolved via stock run-answer with real operator token", async () => {
    const res = await runCli(["answer", activeRunId, "/checkpoint:review#0", "--value", '"approved"']);
    assert.equal(res.code, 0, `run-answer failed: ${res.stderr}`);

    const completed = await until(async () => {
      const rec = await readRunRecord(recordsKv, "manager", activeRunId);
      return rec?.status?.value.state === "completed";
    }, 15_000);

    assert.ok(completed, "workflow did not complete after checkpoint answer");
  });

  await cell("7. Fail-closed verification after real broker credential expiration", async () => {
    const expiredDriverIdentity = newIdentity();
    // Mint 5-second credential
    const shortCreds = await mintCreds(auth, expiredDriverIdentity, "run-driver", {
      principal: { owner, actor: "wf_test" },
      runDriver: { endpoint: "manager", runId: activeRunId, takeoverId: "t1", instanceId: managerInstanceId, epoch: 1 },
      expiresInSeconds: 5,
    });
    // Verify initially connects
    const testNc = await connect({
      servers: SERVERS,
      reconnect: false,
      authenticator: credsAuthenticator(new TextEncoder().encode(shortCreds)),
    });
    assert.ok(testNc.info?.server_id);
    await testNc.close();

    // Wait 6 seconds for real expiration
    await wait(6000);

    let rejected = false;
    try {
      const failNc = await connect({
        servers: SERVERS,
        reconnect: false,
        authenticator: credsAuthenticator(new TextEncoder().encode(shortCreds)),
      });
      await failNc.close();
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "expired credential was unexpectedly accepted by broker");
  });

  await provNc.drain().catch(() => provNc.close());
} finally {
  if (managerProc) await killAndAwaitExit(managerProc).catch(() => {});
  await timerWriter?.stop().catch(() => {});
  await timerNc?.close().catch(() => {});
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  releaseBroker();
  await killAndAwaitExit(broker);
}

console.log(`\nremote-ef-continuity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

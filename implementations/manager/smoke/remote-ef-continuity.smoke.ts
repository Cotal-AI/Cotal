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
const { SignJWT, jwtVerify } = authRequire("jose") as { SignJWT: any; jwtVerify: any };
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  createEndpointStreams,
  createSpaceAuth,
  credsClaims,
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
  ledgerAuthorizeGrant,
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
/** Decode a raw user JWT payload (metadata only; never printed whole). */
function jwtPayload(jwt: string): any {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}
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

  let provNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: provCreds, tls: false }) });
  const jsm = await jetstreamManager(provNc);
  const kvm = new Kvm(provNc);
  await ensureAuthorityStores(jsm, kvm, SPACE);
  await ensureAdmissionStore(jsm, kvm, SPACE);
  await ensureIssuedStores(jsm, kvm, SPACE);
  await createEndpointStreams(jsm, kvm, SPACE);
  let recordsKv = await openRecordsBucket(provNc, SPACE);

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
  // Matched controls: "run" refuses only renewRunDriver (standing stays healthy); "all" refuses both.
  const REFUSE_SCOPE = (process.env.EF_REFUSE_SCOPE ?? "all") as "run" | "all";
  if (REFUSE_SCOPE !== "run" && REFUSE_SCOPE !== "all") throw new Error(`EF_REFUSE_SCOPE must be run|all`);
  console.log(`  refusal scope: ${REFUSE_SCOPE}`);
  let renewalCallCount = 0;
  let refusedRunRenewals = 0;
  const reachedAfterClear: Record<string, number> = {};
  let lastAttemptResult: any;
  let lastRunRenewalMaterial: any;
  let lastStandingRenewalMaterial: any;

  let operatorIssuances = 0;
  let successfulRunRenewals = 0;
  const origIssueRunAttempt = plane.issueManagerRunAttempt;
  const wrappedIssueRunAttempt: typeof plane.issueManagerRunAttempt = async (args) => {
    const res = await origIssueRunAttempt(args);
    // Keep only the FIRST driver/mediator pair: later operator issuances (journal/answer) reuse this
    // route and must not overwrite the run's original duty credentials.
    const creds = (res as any).credentials;
    if (creds?.driver && creds?.mediator) lastAttemptResult ??= res;
    else operatorIssuances++;
    return res;
  };

  const origMgrAuthority = plane.issueManagerServiceAuthority;
  const wrappedMgrAuthority: typeof plane.issueManagerServiceAuthority = async (args) => {
    if (refuseHttpRenewals && (args.request.operation === "renewRunDriver" || (REFUSE_SCOPE === "all" && args.request.operation === "renewStandingBundle"))) {
      renewalCallCount++;
      if (args.request.operation === "renewRunDriver") refusedRunRenewals++;
      throw new Error("temporary rehearsal refusal: issuer unavailable");
    }
    if (args.request.operation === "renewStandingBundle" || args.request.operation === "renewRunDriver")
      reachedAfterClear[args.request.operation] = (reachedAfterClear[args.request.operation] ?? 0) + 1;
    let res: any;
    try {
      res = await origMgrAuthority(args);
    } catch (e) {
      if (args.request.operation === "renewStandingBundle" || args.request.operation === "renewRunDriver")
        console.log(`    issuer: ${args.request.operation} refused by real authority: ${(e as Error).message.slice(0, 160)}`);
      throw e;
    }
    if (args.request.operation === "renewRunDriver") {
      lastRunRenewalMaterial = res;
      successfulRunRenewals++;
    }
    if (args.request.operation === "renewStandingBundle") {
      lastStandingRenewalMaterial = res;
    }
    if (args.request.operation === "renewStandingBundle" || args.request.operation === "renewRunDriver") {
      renewalCallCount++;
    }
    return res;
  };

  // LABELLED TRUSTED FIXTURE HOST (not stock, not a production SandboxProvider): intercepts ONLY
  // managed-agent enrollment on its own path, the host-platform interception stock requires. It
  // authenticates the caller from the IdP token, derives scope from the ledger row (never from the
  // body) and asks the REAL plane's verifyManagedAgentEnrollment, the same decision the stock
  // loopback verify-enrollment door makes. Material issuance is the next step (see gap note).
  const fixtureHostEnrollments: any[] = [];
  const fixtureHostEnroll = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw) as { idpToken: string; request: any };
      if (body.request?.kind !== "manager-managed-agent-enrollment") return send(400, { error: "fixture host intercepts managed-agent enrollment only" });
      const { payload } = await jwtVerify(body.idpToken, idpPair.publicKey, { issuer: IDP_ISS, audience: "cotal-services" });
      const callerOwner = deriveOwnerForIdpSubject(OWNER_SECRET, IDP_ISS, payload.sub);
      const scope = ledgerAuthorizeGrant(authDir)(callerOwner, body.request.actor).scope ?? [];
      const verified = await plane.verifyManagedAgentEnrollment({ owner: callerOwner, scope, request: body.request });
      fixtureHostEnrollments.push({ owner: callerOwner, actor: verified.target.actor, instanceId: verified.instanceId, serveEpoch: verified.serveEpoch });
      return send(501, { error: "fixture host verified enrollment; material issuance needs a callout sentinel and agent-bearer /exchange (next step)" });
    } catch (e) {
      return send(403, { error: (e as Error).message });
    }
  };

  httpServer = createServer((req, res) => {
    if (req.url === "/fixture-host/manager-service-authority") return void fixtureHostEnroll(req, res);
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
      issueManagerRunAttempt: wrappedIssueRunAttempt,
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
    { cwd: wsDir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
  );

  // Fixture-only probe of the child's ACTUAL held run credentials (non-secret metadata only).
  const probeWaiters: ((r: any) => void)[] = [];
  const serveRedials: number[] = [];
  const enrollWaiters: ((r: any) => void)[] = [];
  let probeBuf = "";
  managerProc.stdout?.on("data", (d) => {
    probeBuf += d.toString();
    let i: number;
    while ((i = probeBuf.indexOf("\n")) >= 0) {
      const line = probeBuf.slice(0, i);
      probeBuf = probeBuf.slice(i + 1);
      const m = line.match(/^PROBE_RESULT:(.*)$/);
      if (m) probeWaiters.shift()?.(JSON.parse(m[1]!));
      const e = line.match(/^ENROLL_RESULT:(.*)$/);
      if (e) enrollWaiters.shift()?.(JSON.parse(e[1]!));
    }
  });
  const probeHeld = (runId: string) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("probe timed out")), 10_000);
      probeWaiters.push((r) => { clearTimeout(t); resolve(r); });
      managerProc!.stdin!.write(`PROBE ${runId}\n`);
    });

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
      for (const l of d.toString().split("\n")) {
        if (/renewal|refus|expired|Authorization|re-dialed|could not be restored/i.test(l)) console.log(`    mgr: ${l.slice(0, 220)}`);
        if (/manager service endpoint re-dialed/.test(l)) serveRedials.push(Date.now());
      }
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

  // The timer (12s) outlasts the rehearsal duty lifetime (10s): the run's original driver/mediator
  // JWTs expire while the native timer is pending, so resuming it needs adopted renewed credentials.
  const program = `
    await sleep("12s");
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
  let activeAdmission: any;

  // EF_EXECUTOR_SOAK=1: zero-agent real-wall-time soak across the ORIGINAL held executor's native
  // five-minute lifetime (no clock trick, no TTL knob). Cell 1's run start is then the first real
  // manager operation after that expiry.
  if (process.env.EF_EXECUTOR_SOAK === "1") {
    await cell("0. Executor soak: held executor re-adopted across its ORIGINAL 5-minute expiry (same nkey/account), broker-accepted after it", async () => {
      const start = await probeHeld("none");
      const orig = start.standing.executor;
      const t0 = Math.floor(Date.now() / 1000);
      console.log(`    evidence: soak start=${t0} originalExecutorExp=${orig.exp} lifetime~${orig.exp - t0}s sub=${orig.sub.slice(0, 6)}..`);
      assert.ok(orig.exp - t0 >= 240, "held executor lifetime is not the native five-minute class");
      let samples = 0;
      while (Date.now() / 1000 <= orig.exp + 2) { await wait(15_000); samples++; }
      const end = await probeHeld("none");
      const t1 = Math.floor(Date.now() / 1000);
      const ex = end.standing.executor;
      console.log(`    evidence: soak end=${t1} (> originalExp ${orig.exp}: ${t1 > orig.exp}) heldExecutorExp=${ex?.exp} sub=${ex?.sub?.slice(0, 6)}.. account=${ex?.account === auth.account.pub} live=${ex?.live} executorDialRefused=${end.executorDialRefused} samples=${samples} standingDebt=${JSON.stringify(end.standing.debt)}`);
      assert.ok(t1 > orig.exp, "soak did not cross the original executor expiry");
      assert.ok(ex.exp > orig.exp, "held executor was not re-adopted past its original expiry");
      assert.equal(ex.sub, orig.sub, "executor public nkey changed");
      assert.equal(ex.account, auth.account.pub, "executor account changed");
      assert.equal(end.executorDialRefused, false, "broker refused the held executor after the original expiry");
    });
    // FIXTURE setup only: the test's own one-shot provisioner reader (5-minute class) expired during
    // the soak; re-open the fixture's records reader with a fresh provisioner. No product credential.
    await provNc.close().catch(() => {});
    provNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }) });
    recordsKv = await openRecordsBucket(provNc, SPACE);
  }

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
    activeAdmission = adm;
    assert.equal(adm.admission.runId, activeRunId);
    assert.equal(adm.admission.instanceId, managerInstanceId);
    assert.equal(adm.admission.provenance.kind, "issued");
    assert.ok(adm.admission.provenance.ref.generation);
  });

  await cell("1b. Standing duties are re-adopted before their ORIGINAL expiry (actual held objects, same nkeys/account)", async () => {
    const start = (await probeHeld(activeRunId)).standing;
    const names = ["supervisor", "serve", "goalWriter", "sessionLedger", "executor"] as const;
    const origExp = Math.min(...names.filter((k) => k !== "executor").map((k) => start[k].exp as number));
    // Poll only until just before the earliest original expiry: adoption must beat it.
    const adopted = await until(async () => {
      const p = (await probeHeld(activeRunId)).standing;
      return names.every((k) => p[k]?.exp > start[k].exp);
    }, Math.max(1_000, origExp * 1000 - Date.now() - 500));
    const p = (await probeHeld(activeRunId)).standing;
    console.log(`    evidence: standing re-adoption before exp=${origExp}: ${names.map((k) => `${k} ${start[k].exp}->${p[k]?.exp}`).join(" ")} adopted=${adopted}`);
    assert.ok(adopted, "standing duty not re-adopted before its original expiry");
    for (const k of names) {
      assert.equal(p[k].sub, start[k].sub, `${k} public nkey changed across re-adoption`);
      assert.equal(p[k].account, auth.account.pub, `${k} account changed`);
    }
  });

  await cell("2. Workflow executes timer, parking at checkpoint", async () => {
    const ok = await until(async () => {
      const res = await runCli(["journal", activeRunId]);
      return res.stdout.includes("/checkpoint:review#0") && res.stdout.includes("Proceed with deployment?");
    }, 40_000);
    assert.ok(ok, "run did not park at waiting checkpoint");
    const orig = jwtPayload(lastAttemptResult.credentials.driver.jwt);
    const parkedAt = Math.floor(Date.now() / 1000);
    console.log(`    evidence: original driver exp=${orig.exp} parkedAt=${parkedAt} crossed=${parkedAt > orig.exp} runRenewals=${successfulRunRenewals}`);
    assert.ok(parkedAt > orig.exp, "native timer did not span the original run-driver expiry");
    assert.ok(successfulRunRenewals > 0, "timer resumed across expiry without any successful run renewal");
  });

  await cell("3. Identity, account, and role bindings are strictly checked", async () => {
    assert.ok(activeAdmission, "admission record must be captured");
    assert.equal(activeAdmission.admission.space, SPACE);
    assert.equal(activeAdmission.admission.endpoint, "manager");
    assert.equal(activeAdmission.admission.instanceId, managerInstanceId);
    assert.equal(activeAdmission.admission.provenance.kind, "issued");

    assert.ok(lastAttemptResult?.credentials?.driver?.jwt, "driver credential must be issued via HTTP attempt route");
    assert.ok(lastAttemptResult?.credentials?.mediator?.jwt, "mediator credential must be issued via HTTP attempt route");
    const driverClaims = jwtPayload(lastAttemptResult.credentials.driver.jwt);
    const mediatorClaims = jwtPayload(lastAttemptResult.credentials.mediator.jwt);
    // Account is nats.issuer_account (iss is the account SIGNING key).
    assert.equal(driverClaims.nats?.issuer_account, auth.account.pub, "driver must bind the space data account");
    assert.equal(mediatorClaims.nats?.issuer_account, auth.account.pub, "mediator must bind the space data account");
    assert.equal(driverClaims.iss, auth.account.signingPub, "driver must be signed by the issuer's account signing key");
    assert.match(driverClaims.sub, /^U[A-Z2-7]{55}$/, "driver must hold a public user nkey");
    assert.match(mediatorClaims.sub, /^U[A-Z2-7]{55}$/, "mediator must hold a public user nkey");
    assert.equal(driverClaims.exp - driverClaims.iat, REHEARSAL_STANDING_TTL, "driver lifetime must be the trusted-host rehearsal lifetime");
    console.log(`    evidence: driver role=${driverClaims.nats?.tags ?? driverClaims.name} mediator role=${mediatorClaims.nats?.tags ?? mediatorClaims.name} callerOwnerMatchesIdp=${activeAdmission.admission.caller.owner === owner}`);
    assert.notEqual(driverClaims.sub, mediatorClaims.sub, "driver and mediator must have distinct public nkeys");

    const rec = await readRunRecord(recordsKv, "manager", activeRunId);
    assert.equal(rec?.status?.value.epoch, 1);
    assert.equal(rec?.status?.value.state, "running");
    assert.ok(rec?.status?.value.holder?.startsWith(managerInstanceId) || rec?.status?.value.holder?.startsWith("U"));

    // Negative control: credential signed by a foreign account is refused by the space broker
    const foreignAuth = await createSpaceAuth("foreign-space");
    const foreignCreds = await mintCreds(foreignAuth, newIdentity(), "run-driver", {
      principal: { owner, actor: "wf_test" },
      runDriver: { endpoint: "manager", runId: activeRunId, takeoverId: "t1", instanceId: managerInstanceId, epoch: 1 },
    });
    let foreignRejected = false;
    try {
      const fnc = await connect({ servers: SERVERS, reconnect: false, authenticator: credsAuthenticator(new TextEncoder().encode(foreignCreds)) });
      await fnc.close();
    } catch {
      foreignRejected = true;
    }
    assert.ok(foreignRejected, "foreign account credential unexpectedly accepted by broker");
  });

  let answeredWhileExpired = false;
  await cell("4a. Refused renewRunDriver keeps the held last-good driver/mediator (same nkey and exp) and records debt", async () => {
    const pre = await probeHeld(activeRunId);
    assert.equal(pre.held, true, "run must be held by the manager");
    assert.equal(pre.debt, null, "no renewal debt before refusal");
    refuseHttpRenewals = true;
    refusedRunRenewals = 0;
    await until(() => refusedRunRenewals > 0, 15_000);
    assert.ok(refusedRunRenewals > 0, "manager never attempted renewRunDriver while refusal was active");
    await wait(300);
    const post = await probeHeld(activeRunId);
    console.log(`    evidence: pre driver sub=${pre.driver.sub.slice(0, 8)}.. exp=${pre.driver.exp}; post exp=${post.driver?.exp} mediatorExp=${post.mediator?.exp} refused=${refusedRunRenewals} debt=${JSON.stringify(post.debt)}`);
    assert.deepEqual(post.driver, pre.driver, "held driver must stay the last-good credential after refusal");
    assert.deepEqual(post.mediator, pre.mediator, "held mediator must stay the last-good credential after refusal");
    assert.equal(post.driver.account, auth.account.pub);
    assert.ok(typeof post.debt === "string" && post.debt.includes("issuer unavailable"), "refusal must be recorded as renewal debt on the held run");
    assert.equal(post.dialRefused, false, "last-good driver must still be accepted before its real expiry");
  });

  await cell("4b. Sustained refusal past the held credential's real expiry: broker refuses it and the parked run makes no progress", async () => {
    try {
      const held = await probeHeld(activeRunId);
      const heldExp = held.driver.exp as number;
      await until(() => Date.now() / 1000 > heldExp + 1, 20_000);
      const after = await probeHeld(activeRunId);
      const now = Math.floor(Date.now() / 1000);
      const st = after.standing;
      const standingLive = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"].map((k) => `${k}:${st[k]?.live}`).join(",");
      console.log(`    evidence: heldExp=${heldExp} now=${now} heldExpAfter=${after.driver.exp} dialRefused=${after.dialRefused} driverConnClosed=${after.driverConnClosed} refused=${refusedRunRenewals} standing[${standingLive}] standingDebt=${JSON.stringify(st.debt)}`);
      assert.ok(now > heldExp, "observation must be after the held credential's real expiry");
      assert.equal(after.driver.exp, heldExp, "no credential may be adopted while the issuer refuses");
      assert.equal(after.dialRefused, true, "broker must refuse the expired held run-driver credential");

      // Attempt real progress through the original parked run while its driver is expired.
      const ans = await runCli(["answer", activeRunId, "/checkpoint:review#0", "--value", '"approved"']);
      answeredWhileExpired = ans.code === 0;
      console.log(`    evidence: answerWhileExpired exit=${ans.code}`);
      await wait(6_000);
      const rec = await readRunRecord(recordsKv, "manager", activeRunId);
      assert.notEqual(rec?.status?.value.state, "completed", "parked run progressed to completion with an expired driver");
      assert.equal(rec?.status?.value.state, "running");
    } finally {
      refuseHttpRenewals = false;
    }
  });

  // Post-expiry recovery through the SHIPPED contract. A drive whose driver expired is released
  // (fail closed); the supported way back is stock `cotal run resume <runId>` on the same run id,
  // under its original admission, never an auto-revival by `run answer`.
  let resumed = false;
  await cell("5. Post-expiry recovery: standing duties re-adopted (actual held objects, same nkeys/account), then stock `run resume` retakes the same run", async () => {
    const heldBefore = await probeHeld(activeRunId);
    console.log(`    evidence: after-clear slotHeld=${heldBefore.held} standingDebt=${JSON.stringify(heldBefore.standing.debt)}`);
    const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
    const liveAll = await until(async () => {
      const p = await probeHeld(activeRunId);
      return names.every((k) => p.standing[k]?.live) && p.standing.debt === null;
    }, 20_000);
    const p = await probeHeld(activeRunId);
    const now = Math.floor(Date.now() / 1000);
    console.log(`    evidence: standing ${names.map((k) => `${k}{sub=${p.standing[k]?.sub?.slice(0, 6)} exp=${p.standing[k]?.exp} live=${p.standing[k]?.live}}`).join(" ")} now=${now} debt=${JSON.stringify(p.standing.debt)}`);
    assert.ok(liveAll, "standing duties were not re-adopted after the issuer resumed");
    for (const k of names) {
      assert.equal(p.standing[k].sub, heldBefore.standing[k].sub, `${k} public nkey changed across re-adoption`);
      assert.equal(p.standing[k].account, auth.account.pub, `${k} account changed across re-adoption`);
    }

    // If the service connection closed during the refusal, its bounded re-dial (1s/5s/30s) must
    // restore it before any control command can be answered. Record when it did.
    const clearedAt = Date.now();
    if (REFUSE_SCOPE === "all") {
      const redialed = await until(() => serveRedials.some((t) => t >= clearedAt - 60_000), 45_000);
      console.log(`    evidence: serve re-dial after clear=${redialed} at +${serveRedials.length ? Math.round((serveRedials.at(-1)! - clearedAt) / 1000) : "none"}s redials=${serveRedials.length}`);
      assert.ok(redialed, "service endpoint was not re-dialed after standing re-adoption");
    }
    const recBefore = await readRunRecord(recordsKv, "manager", activeRunId);
    const r = await runCli(["resume", activeRunId]);
    console.log(`    evidence: run resume exit=${r.code} out=${r.stdout.trim().slice(0, 120)} err=${r.stderr.trim().split("\n")[0]?.slice(0, 200)}`);
    assert.equal(r.code, 0, "stock run resume failed after the issuer resumed");
    resumed = true;
    const retaken = await until(async () => (await probeHeld(activeRunId)).held === true, 15_000);
    assert.ok(retaken, "resumed run is not held by the manager");
    const h = await probeHeld(activeRunId);
    const recAfter = await readRunRecord(recordsKv, "manager", activeRunId);
    console.log(`    evidence: resumed epoch ${recBefore?.status?.value.epoch}->${recAfter?.status?.value.epoch} holder ${recBefore?.status?.value.holder?.slice(-12)}->${recAfter?.status?.value.holder?.slice(-12)} driverExp=${h.driver?.exp} dialRefused=${h.dialRefused}`);
    assert.equal(h.dialRefused, false, "resumed driver must be broker-accepted");
    assert.ok(h.driver.exp > now - 1, "resumed driver credential must be fresh");
    assert.ok((recAfter?.status?.value.epoch ?? 0) > (recBefore?.status?.value.epoch ?? 0), "resume must fence with a new epoch");
    const j = await runCli(["journal", activeRunId]);
    assert.ok(j.stdout.includes("/sleep") || j.stdout.includes("sleep"), "resumed run must keep its native journal");
  });

  await cell("6. Resumed run (same run id) completes; the checkpoint answer is recorded once (before or after resume)", async () => {
    assert.ok(resumed, "run was not resumed");
    // An operator answer recorded while the driver was expired settles the checkpoint durably but
    // must not have advanced the run (4b); only the resumed drive may consume it.
    if (!answeredWhileExpired) {
      const res = await runCli(["answer", activeRunId, "/checkpoint:review#0", "--value", '"approved"']);
      console.log(`    evidence: answer exit=${res.code} err=${res.stderr.trim().split("\n")[0]?.slice(0, 200)}`);
      assert.equal(res.code, 0, `run-answer failed: ${res.stderr}`);
    } else console.log("    evidence: answer was recorded while expired; resumed drive consumes it");
    const completed = await until(async () => {
      const rec = await readRunRecord(recordsKv, "manager", activeRunId);
      return rec?.status?.value.state === "completed";
    }, 15_000);
    assert.ok(completed, "workflow did not complete after checkpoint answer");
  });
  // GAP REPRODUCTION (not a pass for accepted-goal): the stock authority route refuses managed-agent
  // enrollment and requires host-platform interception; a pooled spawn goal cannot be accepted
  // through stock callbacks. Recorded, not counted.
  const enrollProbe = (mode: string) => new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("enroll probe timed out")), 10_000);
    enrollWaiters.push((x) => { clearTimeout(t); resolve(x); });
    managerProc!.stdin!.write(`ENROLL_PROBE ${mode}\n`);
  });
  await cell("8a. Stock authority route still refuses managed-agent enrollment (403, host interception required)", async () => {
    const r = await enrollProbe("stock");
    console.log(`    evidence: stock status=${r.status} error=${r.error}`);
    assert.equal(r.status, 403);
    assert.match(r.error, /host platform interception/);
  });
  await cell("8b. Fixture host interception: real plane verifies the manager's own enrollment; forged proof and unledgered caller actor are refused", async () => {
    const before = fixtureHostEnrollments.length;
    const ok = await enrollProbe("host");
    const forged = await enrollProbe("host-forged");
    const intruder = await enrollProbe("host-intruder");
    console.log(`    evidence: host status=${ok.status} verified=${fixtureHostEnrollments.length - before} rec=${JSON.stringify(fixtureHostEnrollments.at(-1))}`);
    console.log(`    evidence: forged status=${forged.status} error=${forged.error.slice(0, 120)} | intruder status=${intruder.status} error=${intruder.error.slice(0, 120)}`);
    assert.equal(fixtureHostEnrollments.length - before, 1, "exactly the genuine enrollment must be verified");
    assert.equal(fixtureHostEnrollments.at(-1).instanceId, managerInstanceId);
    assert.equal(fixtureHostEnrollments.at(-1).owner, owner);
    assert.equal(fixtureHostEnrollments.at(-1).actor, "sdk_fixture");
    assert.equal(forged.status, 403);
    assert.match(forged.error, /proof does not match/);
    assert.equal(intruder.status, 403);
  });
  {
    // Drive one REAL spawn goal through the stock CLI against the registered manager, to capture the
    // exact next refusal on the accepted-goal path. Recorded as a gap, never counted as a pass.
    const before = fixtureHostEnrollments.length;
    const cliRaw = (argv: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ["--import", tsxLoader, cotalBin, ...argv, "--space", SPACE, "--server", SERVERS],
        { cwd: cliDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout?.on("data", (d) => { out += d.toString(); });
      p.stderr?.on("data", (d) => { out += d.toString(); });
      const t = setTimeout(() => p.kill("SIGTERM"), 60_000);
      p.on("exit", (code) => { clearTimeout(t); resolve({ code, out }); });
    });
    const ps = await cliRaw(["ps"]);
    console.log(`  ? GAP discriminator: same askManager rail, non-goal 'cotal ps': exit=${ps.code} out=${ps.out.replace(/\s+/g, " ").slice(0, 300)}`);
    const sp = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ["--import", tsxLoader, cotalBin, "spawn", "--detach", "--name", "sdk_fixture", "--space", SPACE, "--server", SERVERS],
        { cwd: cliDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout?.on("data", (d) => { out += d.toString(); });
      p.stderr?.on("data", (d) => { out += d.toString(); });
      const t = setTimeout(() => p.kill("SIGTERM"), 60_000);
      p.on("exit", (code) => { clearTimeout(t); resolve({ code, out }); });
    });
    console.log(`  ? GAP (accepted-goal) real CLI spawn: exit=${sp.code} hostVerified=${fixtureHostEnrollments.length - before} out=${sp.out.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  console.log("  ? GAP (accepted-goal, next exact call): enrollment MATERIAL needs a callout sentinel credential and an agent-bearer /exchange URL; this fixture broker runs static operator trust with no auth callout, so the fixture host cannot issue material without moving onto the real startAuthService daemon");

  await cell("7. Broker control: fail-closed verification after real broker credential expiration", async () => {
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

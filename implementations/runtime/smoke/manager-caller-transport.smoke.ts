/**
 * Manager-Caller Transport & Runtime Consumer Regression Suite
 *
 * Tests the shipped runtime entrypoint (`runWorkflow` / `askHost`) under a live native
 * NATS JetStream broker with genuine `startAuthCallout` per-connection authorization
 * and signed EdDSA user tokens.
 *
 * Scope & Test Doubles:
 * - Real Components: Native `nats-server` with JetStream, live `startAuthCallout` daemon
 *   verifying EdDSA JWTs and issuing exact scoped NATS permissions per connection, and the
 *   exported shipped `runWorkflow` command.
 * - Test Doubles:
 *   1. Fake AuthProvider: In user-auth mode, Cotal normally contacts an external IdP or auth
 *      service over HTTP to obtain signed user tokens. Here, an in-process AuthProvider double
 *      mints signed EdDSA user tokens directly with valid `manager-caller` claims, without
 *      real IdP HTTP infrastructure.
 *   2. Synthetic Instance Responder: A lightweight NATS responder test double responds on
 *      the instance rail (`ep.inst.manager.<IID>.describe.>` and `run-ps.>`) instead of running
 *      a full daemonized Manager process.
 *   3. Actor-Ledger / Gate Authorizer: The actor-ledger and gate authorizer in startAuthCallout
 *      are fixture no-ops (`authorizeActor: () => {}`), not a production authorization proof.
 * - Scoped Permissions: No broad wildcard grants (`sub.allow: [>]` or `pub.allow: [>]`). The
 *   callout grants only exact instance publish routes.
 *
 * Run: pnpm exec tsx implementations/runtime/smoke/manager-caller-transport.smoke.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import {
  registry,
  createSpaceAuth,
  serverConfig,
  mintCreds,
  newIdentity,
  mintLifecycleUid,
  permissionsFor,
  setupSpaceStreams,
  standaloneConnectOpts,
  isReachable,
  dialerFor,
  parseEpSubject,
  deriveReplySubject,
  contractStoreContext,
  publishContractArtifact,
  contractArtifactCanonicalBytes,
  resolveService,
  BASELINE_LIFECYCLE_ENDPOINT,
  type EpCaller,
  type AuthProvider,
} from "@cotal-ai/core";

import {
  createCalloutAuth,
  startAuthCallout,
  USER_TOKEN_VER,
  deriveOwnerToken,
} from "@cotal-ai/auth";

import {
  recordMesh,
  CLI_USER_ACTOR,
} from "@cotal-ai/workspace";

import {
  runWorkflow,
} from "../src/index.js";

import {
  SMOKE_BROKER_TOKEN,
  teardownOnSignal,
  killAndAwaitExit,
  emitSentinel,
} from "@cotal-ai/smoke-kit";

import { pickFreePort } from "./_free-port.js";

const here = dirname(fileURLToPath(import.meta.url));
const coreReq = createRequire(join(here, "../../../packages/core/src/index.js"));
const authReq = createRequire(join(here, "../../../implementations/auth/src/index.js"));

const { encodeUser, fmtCreds } = coreReq("@nats-io/jwt");
const { fromPublic, fromSeed } = coreReq("@nats-io/nkeys");
const { generateKeyPair, SignJWT } = authReq("jose");

const contractMod = await import(
  pathToFileURL(join(here, "../../../implementations/manager/src/manager-service-contract.js")).href
) as any;
const { managerClusterArtifacts, managerContractArtifactValues } = contractMod;

const EXPECTED_CELLS = 3;
let ok = 0;
let fail = 0;
const c = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) {
    ok++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

// Scrubbed isolated environment roots: remove ALL inherited COTAL_ and JCODE_COTAL_ variables
const origEnv = new Map(Object.entries(process.env));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("COTAL_") || key.startsWith("JCODE_COTAL_")) {
    delete process.env[key];
  }
}

const isolatedRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}mgr-caller-`));
const isolatedHome = join(isolatedRoot, "home");
const isolatedCotalHome = join(isolatedRoot, "cotal-home");
const isolatedCotalRoot = join(isolatedRoot, "cotal-root");
const isolatedTmp = join(isolatedRoot, "tmp");
const isolatedJs = join(isolatedRoot, "js");
const isolatedXdgConfig = join(isolatedRoot, "xdg-config");
const isolatedXdgCache = join(isolatedRoot, "xdg-cache");
const isolatedXdgData = join(isolatedRoot, "xdg-data");
const isolatedXdgState = join(isolatedRoot, "xdg-state");

mkdirSync(isolatedHome, { recursive: true });
mkdirSync(isolatedCotalHome, { recursive: true });
mkdirSync(isolatedCotalRoot, { recursive: true });
mkdirSync(isolatedTmp, { recursive: true });
mkdirSync(isolatedJs, { recursive: true });
mkdirSync(isolatedXdgConfig, { recursive: true });
mkdirSync(isolatedXdgCache, { recursive: true });
mkdirSync(isolatedXdgData, { recursive: true });
mkdirSync(isolatedXdgState, { recursive: true });

process.env.HOME = isolatedHome;
process.env.COTAL_HOME = isolatedCotalHome;
process.env.COTAL_ROOT = isolatedCotalRoot;
process.env.TMPDIR = isolatedTmp;
process.env.XDG_CONFIG_HOME = isolatedXdgConfig;
process.env.XDG_CACHE_HOME = isolatedXdgCache;
process.env.XDG_DATA_HOME = isolatedXdgData;
process.env.XDG_STATE_HOME = isolatedXdgState;

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `mc-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });

const confPath = join(isolatedRoot, "server.conf");
writeFileSync(confPath, serverConfig(auth, [auth], {
  transport: { kind: "plaintext" },
  port: PORT,
  storeDir: isolatedJs,
  extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
}));

// Broker child process: run with an explicit allowlisted environment to prevent secret leakage
const brokerEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: isolatedTmp,
  HOME: isolatedHome,
  LANG: process.env.LANG ?? "C.UTF-8",
};

const broker = spawn("nats-server", ["-c", confPath], { stdio: "ignore", env: brokerEnv });
teardownOnSignal(broker);

const dialer = dialerFor(SERVERS);

class ProcessExited extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${code})`);
  }
}

const origExit = process.exit;
const origErr = console.error;

// Tracked connections for reliable teardown
let calloutNc: any;
let respNc: any;
let pubNc: any;

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!up) throw new Error("Native broker failed to start");

  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });

  // Generate real EdDSA keypair for signing user tokens
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const ISS = "https://auth.cotal.test";

  const TARGET_IID = mintLifecycleUid();
  const callerUid = mintLifecycleUid();
  const OWNER = deriveOwnerToken("s".repeat(32), "human-test-1");

  // Connect callout service to the broker
  calloutNc = await dialer({
    servers: SERVERS,
    ...standaloneConnectOpts({ creds: callout.calloutCreds, tls: false }),
    maxReconnectAttempts: 0,
  });

  // Start real auth callout: dynamically verifies EdDSA JWT and issues strictly scoped rows per connId
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    authorizeActor: () => {},
    permissionsFor: (t, connId) => {
      const isManagerCaller = t.act.view === "manager-caller";
      if (isManagerCaller) {
        return permissionsFor(
          "manager-caller",
          space,
          { owner: t.owner, actor: t.act.actor, connId, lifecycleUid: t.act.lifecycleUid },
          { capabilities: ["run", "spawn"], lifecycleUid: t.act.lifecycleUid, managerInstanceId: t.act.managerInstanceId },
        );
      }
      return permissionsFor(
        "agent",
        space,
        { owner: t.owner, actor: t.act.actor, connId, lifecycleUid: t.act.lifecycleUid },
        { capabilities: ["chat"], lifecycleUid: t.act.lifecycleUid },
      );
    },
    log: () => {},
  });

  // Publish manager contract artifacts to the contract store
  const pubSigner = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
  const pubId = newIdentity();
  const pubJwt = await encodeUser(
    "contract-publisher",
    fromPublic(pubId.id),
    fromPublic(auth.account.pub),
    {
      pub: { allow: [`cotal.${space}.epc.>`, `$JS.API.>`] },
      sub: { allow: [`_INBOX_${pubId.id}.>`] },
    },
    { signer: pubSigner },
  );
  const pubCreds = new TextDecoder().decode(fmtCreds(pubJwt, fromSeed(new TextEncoder().encode(pubId.seed))));
  pubNc = await dialer({ servers: SERVERS, ...standaloneConnectOpts({ creds: pubCreds, tls: false }), maxReconnectAttempts: 0 });
  const storeCtx = await contractStoreContext(pubNc, space);
  const artifacts = managerClusterArtifacts();
  for (const value of [...managerContractArtifactValues(), artifacts.document, artifacts.manifest]) {
    await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
  }
  await pubNc.drain();
  pubNc = undefined;

  // Helper to mint signed EdDSA user tokens
  async function mintUserToken(view?: string) {
    const isManagerCaller = view === "manager-caller";
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: OWNER,
      scope: ["run"],
      ver: USER_TOKEN_VER,
      act: {
        owner: OWNER,
        actor: CLI_USER_ACTOR,
        lifecycleUid: callerUid,
        ...(isManagerCaller ? { view: "manager-caller", managerInstanceId: TARGET_IID } : {}),
      },
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(ISS)
      .setAudience(space)
      .setIssuedAt(now - 60)
      .setNotBefore(now - 60)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  }

  // Register in-process AuthProvider test double returning signed tokens + callout sentinel
  const testProvider = {
    kind: "auth-provider" as const,
    name: "test-caller-provider",
    async prepareServer() { throw new Error("not implemented"); },
    async preloadAccounts() { return []; },
    async userCredentials(opts: any) {
      const isManagerCaller = opts.view === "manager-caller";
      const bearer = await mintUserToken(opts.view);
      return {
        bearer,
        sentinelCreds: callout.sentinelCreds,
        ...(isManagerCaller ? { managerInstanceId: TARGET_IID } : {}),
      };
    },
  };
  registry.register(testProvider as unknown as AuthProvider);

  // Record mesh in isolated COTAL_HOME
  recordMesh({
    space,
    server: SERVERS,
    root: isolatedRoot,
    mode: "user",
    ts: new Date().toISOString(),
    userAuth: {
      provider: "test-caller-provider",
      serviceUrl: "http://127.0.0.1:0",
    } as any,
  });

  // Setup synthetic instance responder double on broker with call tracking and caller verification
  let describeCalls = 0;
  let lastDescribeCaller: EpCaller | undefined;
  let runPsCalls = 0;
  let lastRunPsCaller: EpCaller | undefined;

  const responderId = newIdentity();
  const responderJwt = await encodeUser(
    "manager-instance-responder",
    fromPublic(responderId.id),
    fromPublic(auth.account.pub),
    {
      pub: { allow: [`cotal.${space}.ep.reply.>`] },
      sub: { allow: [`cotal.${space}.ep.inst.manager.${TARGET_IID}.>`] },
    },
    { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) },
  );
  const responderCreds = new TextDecoder().decode(fmtCreds(responderJwt, fromSeed(new TextEncoder().encode(responderId.seed))));
  respNc = await dialer({ servers: SERVERS, ...standaloneConnectOpts({ creds: responderCreds, tls: false }), maxReconnectAttempts: 0 });

  respNc.subscribe(`cotal.${space}.ep.inst.manager.${TARGET_IID}.describe.>`, {
    callback: (err: unknown, msg: any) => {
      if (err || !msg) return;
      const parsed = parseEpSubject(msg.subject);
      if (!parsed || parsed.plane !== "request") return;
      describeCalls++;
      lastDescribeCaller = parsed.caller;
      const req = JSON.parse(new TextDecoder().decode(msg.data));
      const replySubj = deriveReplySubject(space, parsed as any, { instanceId: TARGET_IID, epoch: 1 });
      const resp = {
        v: 1,
        id: req.id,
        ok: true,
        data: {
          public: true,
          descriptor: {
            endpoint: "manager",
            owner: OWNER,
            clusters: [{ digest: artifacts.closureDigest, commands: ["run-ps"] }],
          },
        },
      };
      respNc.publish(replySubj, new TextEncoder().encode(JSON.stringify(resp)));
    },
  });

  respNc.subscribe(`cotal.${space}.ep.inst.manager.${TARGET_IID}.run-ps.>`, {
    callback: (err: unknown, msg: any) => {
      if (err || !msg) return;
      const parsed = parseEpSubject(msg.subject);
      if (!parsed || parsed.plane !== "request") return;
      runPsCalls++;
      lastRunPsCaller = parsed.caller;
      const req = JSON.parse(new TextDecoder().decode(msg.data));
      const replySubj = deriveReplySubject(space, parsed as any, { instanceId: TARGET_IID, epoch: 1 });
      const resp = {
        v: 1,
        id: req.id,
        ok: true,
        data: [],
      };
      respNc.publish(replySubj, new TextEncoder().encode(JSON.stringify(resp)));
    },
  });

  // Flush subscriptions to guarantee broker registration before client publishes
  await respNc.flush();

  // CELL 1: Execute shipped runWorkflow (exercises askHost -> resolveService -> invokeCommand)
  // When mutated (omitting managerInstanceId), askHost receives broker permission denial and calls process.exit(1).
  let runWorkflowFailed = false;
  let runWorkflowDiagnostic: string | undefined;

  const capturedErr: string[] = [];
  console.error = (...args: unknown[]) => {
    capturedErr.push(args.map((a) => String(a)).join(" "));
  };

  process.exit = ((code?: number | string | null) => {
    throw new ProcessExited(code);
  }) as typeof process.exit;

  try {
    await runWorkflow({
      positionals: ["ps"],
      values: { space },
      raw: ["ps", "--space", space],
    });
  } catch (e: any) {
    runWorkflowFailed = true;
    runWorkflowDiagnostic = e instanceof ProcessExited
      ? `exited with code ${e.code}${capturedErr.length > 0 ? `: ${capturedErr.join(" | ")}` : ""}`
      : String(e?.message ?? e);
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }

  const describeVerified =
    describeCalls >= 1 &&
    lastDescribeCaller?.owner === OWNER &&
    lastDescribeCaller?.actor === CLI_USER_ACTOR &&
    lastDescribeCaller?.uid === callerUid;

  const runPsVerified =
    runPsCalls >= 1 &&
    lastRunPsCaller?.owner === OWNER &&
    lastRunPsCaller?.actor === CLI_USER_ACTOR &&
    lastRunPsCaller?.uid === callerUid;

  const callerVerified = !runWorkflowFailed && describeVerified && runPsVerified;

  if (!callerVerified && !runWorkflowDiagnostic) {
    runWorkflowDiagnostic = `broker calls or caller triple mismatch: describeCalls=${describeCalls}, describeCaller=${JSON.stringify(lastDescribeCaller)}, runPsCalls=${runPsCalls}, runPsCaller=${JSON.stringify(lastRunPsCaller)}`;
  }

  c("runtime askHost connects to instance-scoped manager with valid managerInstanceId", callerVerified, runWorkflowDiagnostic);

  // CELL 2: Broker rejects class route (ep.one) publishes for manager-caller credentials
  let classRouteRefused = false;
  try {
    const callerBearer = await mintUserToken("manager-caller");
    const callerNc = await dialer({
      servers: SERVERS,
      ...standaloneConnectOpts({ bearer: callerBearer, sentinelCreds: callout.sentinelCreds, tls: false }),
      maxReconnectAttempts: 0,
    });
    const callerTriple: EpCaller = { owner: OWNER, actor: CLI_USER_ACTOR, uid: callerUid };
    try {
      await resolveService(callerNc, space, BASELINE_LIFECYCLE_ENDPOINT, callerTriple, { deadlineMs: 400 });
    } catch (e: any) {
      if (e.code === "permission-denied") {
        classRouteRefused = true;
      }
    } finally {
      await callerNc.drain();
    }
  } catch {
    // dial failure
  }

  c("broker enforces manager-caller scoped grants: class route is refused", classRouteRefused);

  // CELL 3: Broker denies sentinel credential alone without a valid bearer token
  let sentinelOnlyRefused = false;
  let sentinelErrorDiagnostic: string | undefined;
  try {
    const badNc = await dialer({
      servers: SERVERS,
      ...standaloneConnectOpts({ creds: callout.sentinelCreds, tls: false }),
      maxReconnectAttempts: 0,
    });
    await badNc.close();
    sentinelErrorDiagnostic = "sentinel-only connection unexpectedly connected";
  } catch (err: any) {
    const isAuthDenial =
      err?.name === "AuthorizationError" ||
      /authorization violation/i.test(String(err?.message ?? err));
    if (isAuthDenial) {
      sentinelOnlyRefused = true;
    } else {
      sentinelErrorDiagnostic = `expected AuthorizationError, but got ${err?.name ?? err}: ${err?.message ?? err}`;
    }
  }

  c("broker denies sentinel-only connection without bearer token", sentinelOnlyRefused, sentinelErrorDiagnostic);

  if (respNc && !respNc.isClosed()) {
    await respNc.drain();
    respNc = undefined;
  }
  if (calloutNc && !calloutNc.isClosed()) {
    await calloutNc.drain();
    calloutNc = undefined;
  }
} finally {
  process.exit = origExit;
  console.error = origErr;

  // Drain any remaining open connections on early failure
  for (const nc of [pubNc, respNc, calloutNc]) {
    if (nc && !nc.isClosed()) {
      try {
        await nc.drain();
      } catch {
        try { nc.close(); } catch {}
      }
    }
  }

  // Restore environment variables: delete keys added during run and restore all originals
  for (const k of Object.keys(process.env)) {
    if (!origEnv.has(k)) {
      delete process.env[k];
    }
  }
  for (const [k, v] of origEnv) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  await killAndAwaitExit(broker);
  rmSync(isolatedRoot, { recursive: true, force: true });
}

if (ok + fail !== EXPECTED_CELLS) {
  fail++;
  console.log(`  ✗ FAIL: executed ${ok + fail} cells, expected exactly ${EXPECTED_CELLS}`);
}

emitSentinel({ passed: ok, failed: fail, cells: EXPECTED_CELLS });
if (fail > 0) {
  process.exit(1);
}

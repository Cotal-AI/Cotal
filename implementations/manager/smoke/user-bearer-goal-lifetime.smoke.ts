/**
 * USER-BEARER GOAL LIFETIME & RECONNECT SMOKE SUITE
 *
 * Validates the mediated goal recovery contract across:
 *   1. POSITIVE CONTROL: 60s user bearer follows 4.5s delayed spawn to completion.
 *   2. COMPATIBILITY GATE: Unsupported manager (lacking goal-result) is refused before effects
 *      with failed-precondition, while non-follow commands remain usable. Exactly 0 mutation submits.
 *   3. STOP CLEANUP: ep.stop() cancels owned follow waits promptly with unavailable, clearing timers.
 *   4. LOOKUP REFUSAL PROVENANCE: Post-accept goal-result read refusal does NOT copy
 *      outcome:not-executed or EP_BIND_REFUSED onto the spawn outcome; preserves acceptance.
 *   5. FINGERPRINT & DIGEST VALIDATION: Reconciled fact must match accepted goalId and fingerprint.
 *   6. WIRE EXPIRY REBUILD & GAP RECONCILIATION: 3s user bearer expires, endpoint rebuilds
 *      a fresh NatsConnection, and reconciles the terminal committed during the gap via goal-result.
 *   7. QUERY IDENTITY: Native mediated reads retain the accepting caller and observed manager.
 *
 * The Manager, broker, signed bearer verification and expiry are real. The callout's actor-ledger
 * authorizer and permission table are fixture policy; this is not an exchange-policy proof.
 * Compatibility views and several accepted-result inputs are doubles. Instance-bound MeshAgent
 * routing is exercised separately by user-manager-transport.smoke.ts.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClosedConnectionError, type NatsConnection } from "@nats-io/transport-node";
import { createServer, type AddressInfo } from "node:net";
import {
  CotalEndpoint,
  EpEnvelopeError,
  createSpaceAuth,
  serverConfig,
  setupSpaceStreams,
  mintCreds,
  newIdentity,
  mintLifecycleUid,
  isReachable,
  type LaunchSpec,
  type LaunchOpts,
  type Connector,
  registry,
  BASELINE_LIFECYCLE_ENDPOINT,
  epCallerGrantRows,
  baselineCallerCapabilities,
  spawnCallerCapabilities,
  epcStreamName,
  spacePrefix,
  dialerFor,
  standaloneConnectOpts,
  actionContext,
  parseEpSubject,
  invokeCommand,
  replyRefusedBeforeEffect,
  EP_BIND_REFUSED,
  type EpAttributedReply,
  type GoalResultFact,
  contractDigest,
} from "@cotal-ai/core";
import {
  createCalloutAuth,
  startAuthCallout,
  createUserTokenIssuer,
  generateSigningKey,
  deriveOwnerToken,
} from "../../auth/src/index.js";
import { Manager } from "../src/manager.js";
import { saveSpaceAuth } from "../../../packages/workspace/src/auth-paths.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit, emitSentinel } from "@cotal-ai/smoke-kit";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
};

async function outcomeError(call: Promise<EpAttributedReply>) {
  try { return (await call).reply.error; }
  catch (e) { if (e instanceof EpEnvelopeError) return e.toEpError(); throw e; }
}

async function main() {
  // Restoration state is not a child-process environment.
  const originalEnv = new Map(Object.entries(process.env));
  const temporaryBase = tmpdir();
  const SEAT_ROOT = mkdtempSync(join(temporaryBase, "s-"));
  const TEST_DIR = mkdtempSync(join(temporaryBase, `${SMOKE_BROKER_TOKEN}u-`));
  process.env.HOME = join(TEST_DIR, "h");
  process.env.COTAL_HOME = join(TEST_DIR, "h", ".cotal");
  process.env.COTAL_ROOT = join(TEST_DIR, "r");
  process.env.XDG_DATA_HOME = join(TEST_DIR, "d");
  process.env.XDG_CONFIG_HOME = join(TEST_DIR, "c");
  process.env.XDG_STATE_HOME = join(TEST_DIR, "s");
  process.env.TMPDIR = join(TEST_DIR, "t");
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(process.env.COTAL_HOME, { recursive: true });
  mkdirSync(process.env.TMPDIR, { recursive: true });

  for (const k of Object.keys(process.env)) {
    if ((k.startsWith("COTAL_") && k !== "COTAL_HOME" && k !== "COTAL_ROOT") || k.startsWith("JCODE_COTAL_")) {
      delete process.env[k];
    }
  }
  process.env.COTAL_SEAT_ROOT = SEAT_ROOT;
  process.env.COTAL_SKIP_CONNECTOR_SEED = "1";
  process.env.XDG_CACHE_HOME = join(TEST_DIR, "cache");

  const WS_ROOT = join(TEST_DIR, "ws");
  mkdirSync(join(WS_ROOT, ".cotal", "agents"), { recursive: true });

  const PORT = await freePort();
  const SERVERS = `nats://127.0.0.1:${PORT}`;
  const SPACE = `ubearer-smoke-${mintLifecycleUid().slice(0, 8)}`;

  console.log(`Starting smoke broker on ${SERVERS} for space ${SPACE}...`);
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(join(WS_ROOT, ".cotal", "auth"), auth);
  const callout = await createCalloutAuth({ space: SPACE, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });

  writeFileSync(join(TEST_DIR, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: PORT,
    storeDir: join(TEST_DIR, "js"),
    extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
  }));

  const broker = spawn("nats-server", ["-c", join(TEST_DIR, "server.conf")], {
    stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  const releaseBroker = teardownOnSignal(broker, TEST_DIR);

  let mgr: InstanceType<typeof Manager> | undefined;
  let calloutNc: NatsConnection | undefined;
  const endpoints: CotalEndpoint[] = [];
  const startEndpoint = async (ep: CotalEndpoint) => { endpoints.push(ep); await ep.start(); };
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const ep of endpoints) { try { await ep.stop(); } catch (e) { errors.push(e); } }
    try { await mgr?.stop({ withAgents: true }); } catch (e) { errors.push(e); }
    try { await calloutNc?.close(); } catch (e) { errors.push(e); }
    try { await killAndAwaitExit(broker); } catch (e) { errors.push(e); }
    if (errors.length === 0) {
      rmSync(TEST_DIR, { recursive: true, force: true });
      rmSync(SEAT_ROOT, { recursive: true, force: true });
      releaseBroker();
    }
    for (const k of Object.keys(process.env)) if (!originalEnv.has(k)) delete process.env[k];
    for (const [k, v] of originalEnv) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (errors.length) throw new AggregateError(errors, "lifetime fixture cleanup failed; storage preserved");
  };

  try {
    for (let i = 0; i < 50 && !(await isReachable(SERVERS)); i++) await new Promise((r) => setTimeout(r, 100));
    check("broker is reachable on free port", await isReachable(SERVERS));

    const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: provCreds });

    // Auth Callout Service
    const key = await generateSigningKey();
    const issuer = createUserTokenIssuer({ issuer: "https://auth.cotal.test", key });
    calloutNc = await dialerFor(SERVERS)({
      servers: SERVERS,
      ...standaloneConnectOpts({ creds: callout.calloutCreds, tls: false }),
    });

    startAuthCallout(calloutNc as never, {
      xkeySeed: callout.xkey.seed,
      authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
      dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
      space: SPACE,
      token: { key: issuer.localKeySet(), issuer: "https://auth.cotal.test" },
      authorizeActor: () => {},
      permissionsFor: (t, connId) => {
        const caller = { owner: t.owner, actor: t.act.actor, uid: t.act.lifecycleUid! };
        const rows = epCallerGrantRows(SPACE, [
          { endpoint: "manager", command: "describe" },
          { endpoint: "manager", command: "status" },
          { endpoint: "manager", command: "inspect" },
          { endpoint: "manager", command: "spawn" },
          { endpoint: "manager", command: "goal-result" },
          ...baselineCallerCapabilities(),
          ...spawnCallerCapabilities(t.owner),
        ], caller);
        return {
          pub: {
            allow: [
              `$JS.API.DIRECT.GET.${epcStreamName(SPACE)}.${spacePrefix(SPACE)}.epc.>`,
              ...rows.pub,
            ],
          },
          sub: {
            allow: [
              `_INBOX_${connId}.>`,
              ...rows.sub,
            ],
          },
        };
      },
      log: () => {},
    });

    // Native delayed-join connector (4.5s delay before presence registration)
    const coreDist = join(process.cwd(), "packages/core/dist/index.js");
    const DELAYED_CHILD = [
      "const fs=require('node:fs');",
      "const{pathToFileURL}=require('node:url');",
      "const delayMs=parseInt(process.env.JOIN_DELAY_MS||'4500',10);",
      "setTimeout(()=>{",
      "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
      "const creds=process.env.COTAL_CREDS?fs.readFileSync(process.env.COTAL_CREDS,'utf8'):undefined;",
      "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,creds,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
      "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1<<30);});",
      "},delayMs);",
    ].join("");

    const envDelayed = (o: LaunchOpts): Record<string, string> => ({
      PATH: process.env.PATH ?? "",
      CORE_DIST: coreDist,
      COTAL_SPACE: o.space,
      COTAL_SERVERS: String(o.servers ?? SERVERS),
      COTAL_ID: o.id ?? "",
      COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "",
      COTAL_NAME: o.name,
      COTAL_CREDS: o.creds ?? "",
      JOIN_DELAY_MS: "4500",
    });

    const delayedCon: Connector = { kind: "connector", name: "delayed-join", requires: [], buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: ["-e", DELAYED_CHILD], env: envDelayed(o) }) };
    registry.register(delayedCon);

    writeFileSync(join(WS_ROOT, ".cotal", "agents", "pos-user.md"), "---\nname: pos-user\nrole: worker\n---\n");
    writeFileSync(join(WS_ROOT, ".cotal", "agents", "neg-user.md"), "---\nname: neg-user\nrole: worker\n---\n");
    writeFileSync(join(WS_ROOT, ".cotal", "agents", "gap-user.md"), "---\nname: gap-user\nrole: worker\n---\n");
    writeFileSync(join(WS_ROOT, ".cotal", "agents", "stop-user.md"), "---\nname: stop-user\nrole: worker\n---\n");

    mgr = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: WS_ROOT });
    (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 10_000;
    await mgr.start();
    const mgrIid = (mgr as unknown as { managerInstanceId: string }).managerInstanceId;
    check("manager booted and registered instanceId", typeof mgrIid === "string" && mgrIid.length > 0);

    const owner = deriveOwnerToken("s".repeat(32), "human-1");

    // ==================================================================
    // 1. POSITIVE CONTROL: Long-Lived User Bearer (60s TTL)
    // ==================================================================
    const callerActor1 = "caller_pos";
    const callerUid1 = mintLifecycleUid();
    const bearer1 = () => issuer.issue({
      owner,
      space: SPACE,
      actor: callerActor1,
      scope: ["spawn"],
      lifecycleUid: callerUid1,
      ttlSec: 60,
    });

    const ep1 = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(ep1);

    let posGoalId = "";
    const posStart = Date.now();
    const posReply = await ep1.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => {
        const r = await ep1.invokeService(BASELINE_LIFECYCLE_ENDPOINT, "spawn", { name: "pos-user", agent: "delayed-join", events: false });
        posGoalId = (r.reply.data as Record<string, unknown>)?.goalId as string;
        return r;
      },
      15_000,
    );
    const posDuration = Date.now() - posStart;
    check("POSITIVE: followServiceGoal resolves ok: true", posReply.reply.ok === true, posReply.reply);
    check("POSITIVE: followServiceGoal returns allocated identity", (posReply.reply.data as Record<string, unknown>)?.name === "pos-user");
    check("POSITIVE: resolved in ~5.5s (within deadline window)", posDuration < 10_000, { posDuration });
    await ep1.stop();

    // ==================================================================
    // 2. COMPATIBILITY GATE: 0.53 Legacy Manager Lacking goal-result
    // ==================================================================
    const epCompat = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epCompat);

    // Keep the real fetched contracts; only the supported-command view is a compatibility double.
    await epCompat.invokeService(BASELINE_LIFECYCLE_ENDPOINT, "status");
    const services = (epCompat as unknown as { resolvedServices: Map<string, import("@cotal-ai/core").ResolvedService> }).resolvedServices;
    const realService = services.get(BASELINE_LIFECYCLE_ENDPOINT)!;
    const legacyCommands = new Map(realService.commands);
    legacyCommands.delete("goal-result");
    services.set(BASELINE_LIFECYCLE_ENDPOINT, { ...realService, commands: legacyCommands });

    let mutationSubmits = 0;
    const compatNc = (epCompat as unknown as { nc: NatsConnection }).nc;
    const publish = compatNc.publish.bind(compatNc);
    compatNc.publish = (subject, data, options) => {
      const request = parseEpSubject(subject);
      if (request?.plane === "request" && request.command === "spawn") mutationSubmits++;
      publish(subject, data, options);
    };
    const compatError = await outcomeError(epCompat.invokeService(
      BASELINE_LIFECYCLE_ENDPOINT, "spawn", { name: "compat-test", agent: "delayed-join" }, { follow: true },
    )).finally(() => { compatNc.publish = publish; });
    check("COMPAT: missing goal-result refuses with failed-precondition", compatError?.code === "failed-precondition");
    check("COMPAT: message provides actionable upgrade notice", compatError?.message.includes("does not support \"goal-result\"") === true);
    check("COMPAT: exactly zero mutation submits occurred", mutationSubmits === 0, { mutationSubmits });
    check("COMPAT: preserves not-executed outcome", compatError?.outcome === "not-executed");
    await epCompat.stop();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    let closedCallError: unknown;
    let closedPublishes = 0;
    const closedPublish = compatNc.publish.bind(compatNc);
    compatNc.publish = (subject, data, options) => { closedPublishes++; closedPublish(subject, data, options); };
    process.on("unhandledRejection", onUnhandled);
    try {
      try { await invokeCommand(compatNc, SPACE, realService, "status", undefined, { deadlineMs: 100 }); }
      catch (e) { closedCallError = e; }
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally { process.removeListener("unhandledRejection", onUnhandled); compatNc.publish = closedPublish; }
    check("CLOSED: native call refuses a closed transport", compatNc.isClosed() && closedCallError instanceof ClosedConnectionError && closedPublishes === 0, { error: closedCallError, closedPublishes });
    check("CLOSED: failed subscription leaves no unhandled rejection", unhandled.length === 0, unhandled);

    // ==================================================================
    // 2B. PRE-EFFECT RETRY COMPATIBILITY GATE: Refreshed service lacks goal-result
    // ==================================================================
    const epRetryCompat = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epRetryCompat);

    // Candidate 1: Real service commands (with goal-result), but bound to epoch 999 (manager fences before effects)
    const cand1Service = {
      ...realService,
      responder: { instanceId: mgrIid, epoch: 999 },
    };

    // Candidate 2: Real service commands EXCEPT goal-result removed (simulating 0.53 legacy manager)
    const cand2Commands = new Map(realService.commands);
    cand2Commands.delete("goal-result");
    const cand2Service = {
      ...realService,
      commands: cand2Commands,
      responder: { instanceId: mgrIid, epoch: 0 },
    };

    const resolvedMap = new Map<string, unknown>();
    Object.defineProperty(epRetryCompat, "resolvedServices", {
      get() {
        return {
          get(k: string) {
            return resolvedMap.get(k);
          },
          set(k: string, v: unknown) {
            resolvedMap.set(k, v);
          },
          delete(k: string) {
            resolvedMap.delete(k);
            resolvedMap.set(k, cand2Service);
          },
        };
      },
    });
    resolvedMap.set(BASELINE_LIFECYCLE_ENDPOINT, cand1Service);

    const retryCompatError = await outcomeError(epRetryCompat.invokeService(
      BASELINE_LIFECYCLE_ENDPOINT,
      "spawn",
      { name: "retry-compat", agent: "delayed-join" },
      { follow: true },
    ));

    check("COMPAT-RETRY: re-resolved service lacking goal-result refuses with expired or failed-precondition", retryCompatError?.code === "expired" || retryCompatError?.code === "failed-precondition");
    check("COMPAT-RETRY: preserves original not-executed outcome", retryCompatError?.outcome === "not-executed");
    check("COMPAT-RETRY: message explains goal-result requirement", retryCompatError?.message.includes("goal-result") === true);
    check("COMPAT-RETRY: carries bind refusal detail", (retryCompatError?.details ?? []).some((d) => d.kind === EP_BIND_REFUSED));
    await epRetryCompat.stop();

    // ==================================================================
    // 3. STOP CLEANUP: ep.stop() cancels owned follow waits promptly
    // ==================================================================
    const epStop = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epStop);

    const stopFollowP = epStop.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => epStop.invokeService(BASELINE_LIFECYCLE_ENDPOINT, "spawn", { name: "stop-user", agent: "delayed-join", events: false }),
      20_000,
    );

    // Give follow time to submit and arm progress wait
    await new Promise((r) => setTimeout(r, 1000));
    const stopT0 = Date.now();
    await epStop.stop();
    const stopResult = await stopFollowP;
    const stopElapsed = Date.now() - stopT0;

    check("STOP: follow settled promptly with unavailable", stopResult.reply.ok === false && stopResult.reply.error?.code === "unavailable", stopResult.reply);
    check("STOP: settled in <200ms without waiting out deadline", stopElapsed < 200, { stopElapsed });
    check("STOP: message warns goal was accepted and forbids blind retry", stopResult.reply.error?.message.includes("THE GOAL IS UNAFFECTED") === true);

    // ==================================================================
    // 4. LOOKUP REFUSAL PROVENANCE: Post-accept lookup refusal preserves acceptance
    // ==================================================================
    const epProv = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epProv);

    const provResult = await epProv.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => ({
        reply: { v: 1 as const, id: "r-prov", ok: true as const, data: { goalId: "goal-prov-1", fingerprint: "fp-prov-1" } },
        responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 1 },
      }),
      300,
      {
        reconcile: async () => {
          const err = new Error("simulated bind refusal on read");
          (err as unknown as { isLookupRefusal: boolean }).isLookupRefusal = true;
          throw err;
        },
      },
    );

    check("PROVENANCE: lookup failure returns unavailable", provResult.reply.ok === false && provResult.reply.error?.code === "unavailable");
    check("PROVENANCE: does NOT copy not-executed or EP_BIND_REFUSED", !replyRefusedBeforeEffect(provResult.reply.error));
    check("PROVENANCE: preserves acceptance attribution", typeof provResult.responder?.instanceId === "string" && provResult.responder.instanceId.length > 0);
    await epProv.stop();

    // ==================================================================
    // 5. FINGERPRINT & DIGEST VALIDATION: Reconciled fact must match accepted fingerprint
    // ==================================================================
    const epFact = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epFact);

    let factReconcileRan = false;
    const factMismatchResult = await epFact.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => ({
        reply: { v: 1 as const, id: "r-fact", ok: true as const, data: { goalId: "goal-fact-1", fingerprint: "fp-accepted-real" } },
        responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 1 },
      }),
      300,
      {
        reconcile: async (goalId) => {
          factReconcileRan = true;
          const data = { validPayload: true };
          // Return a fact with valid outcomeDigest but mismatched fingerprint
          const badFact: GoalResultFact = {
            v: 1,
            goalId,
            fingerprint: "sha256:WRONG_FINGERPRINT",
            state: "succeeded",
            outcomeDigest: contractDigest(data),
            data,
            committer: { instanceId: mgrIid, epoch: 1 },
            ts: Date.now(),
          };
          return { goalId, result: badFact };
        },
      },
    );
    check("FACT: reconcile ran", factReconcileRan);
    check("FACT: mismatched fingerprint does not authorize", factMismatchResult.reply.ok === false);
    const digestResult = await epFact.followServiceGoal(BASELINE_LIFECYCLE_ENDPOINT, async () => ({
      reply: { v: 1, id: "r-digest", ok: true, data: { goalId: "g-digest", fingerprint: "fp-digest" } },
      responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 0 },
    }), 1000, { reconcile: async (goalId) => ({ goalId, result: {
      v: 1, goalId, fingerprint: "fp-digest", state: "succeeded", data: { name: "unsafe" },
      outcomeDigest: contractDigest({ name: "different" }), ts: Date.now(),
    } }) });
    check("FACT: digest-inconsistent terminal does not authorize", digestResult.reply.ok === false && digestResult.reply.error?.message.includes("outcomeDigest") === true && digestResult.reply.error.outcome === "unknown");
    await epFact.stop();

    // ==================================================================
    // 6. REAL WIRE EXPIRY REBUILD & LIVE RESUBSCRIBE
    // ==================================================================
    const callerActor2 = "caller_renewing";
    const callerUid2 = mintLifecycleUid();
    let bearerMintCount = 0;

    const bearerSource = async () => {
      bearerMintCount++;
      return issuer.issue({
        owner,
        space: SPACE,
        actor: callerActor2,
        scope: ["spawn"],
        lifecycleUid: callerUid2,
        ttlSec: 3,
      });
    };

    const ep2 = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearerSource,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid2,
      card: { owner, actor: callerActor2, id: callerActor2, name: "caller-renewing", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });

    let rebuildsObserved = 0;
    ep2.on("error", () => {}); // absorb expected UserAuthenticationExpiredError
    ep2.on("transport", (t) => {
      if (t.connected && bearerMintCount > 1) rebuildsObserved++;
    });

    await startEndpoint(ep2);
    const initialNc = (ep2 as unknown as { nc: { isClosed: () => boolean } }).nc;

    const queryCallers: Array<{ owner: string; actor: string; uid: string }> = [];
    let queryIdentityMatches = true;
    let expiredBeforeSettlement = false;
    const expiryFollowStarted = Date.now();
    let expiryFollowElapsed = 0;
    const expFollowP = ep2.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async (signal) => ep2.invokeService(BASELINE_LIFECYCLE_ENDPOINT, "spawn", { name: "neg-user", agent: "delayed-join", events: false }, { signal }),
      15_000,
      {
        reconcile: async (goalId, attributed, context) => {
          const nc = (ep2 as unknown as { nc: NatsConnection }).nc;
          const publish = nc.publish.bind(nc);
          nc.publish = (subject, data, options) => {
            const request = parseEpSubject(subject);
            if (request?.plane === "request" && request.command === "goal-result") queryCallers.push(request.caller);
            publish(subject, data, options);
          };
          try {
            const q = await ep2.invokeService(BASELINE_LIFECYCLE_ENDPOINT, "goal-result", { goalId }, {
              signal: context.signal, deadlineMs: Math.min(5000, context.deadlineMs),
            });
            queryIdentityMatches &&= attributed.responder.instanceId === mgrIid && q.responder.instanceId === mgrIid
              && context.caller.owner === owner && context.caller.actor === callerActor2 && context.caller.uid === callerUid2;
            if (!q.reply.ok) throw new Error(q.reply.error?.message ?? "goal-result refused");
            return q.reply.data as { goalId: string; result?: GoalResultFact };
          } finally { nc.publish = publish; }
        },
      },
    ).then((result) => { expiredBeforeSettlement = initialNc.isClosed(); expiryFollowElapsed = Date.now() - expiryFollowStarted; return result; });

    // Wait 7.0s so wire expiry drops connection at 3s, rebuilds at ~3.5s, child joins at ~4.5s, and manager commits
    await new Promise((r) => setTimeout(r, 7000));

    // WITNESS 1: Connection instance was replaced
    const currentNc = (ep2 as unknown as { nc: unknown }).nc;
    check("REBUILD: initial connection closed by broker wire expiry", initialNc.isClosed() === true);
    check("REBUILD: endpoint running on replaced NatsConnection instance", currentNc !== initialNc);
    check("REBUILD: self-heal rebuilds observed", rebuildsObserved >= 1, { rebuildsObserved, bearerMintCount });

    // Await follow outcome (resolves succeeded across wire expiry rebuild!)
    const expResult = await expFollowP;
    check("LIFETIME: followServiceGoal resolves ok: true across wire expiry", expResult.reply.ok === true, expResult.reply);
    check("LIFETIME: wire expiry preceded goal settlement", expiredBeforeSettlement);
    check("LIFETIME: outcome observed promptly after wire expiry", expiryFollowElapsed < 10_000, { expiryFollowElapsed });
    check("QUERY: real mediated reads retain the accepting caller and manager", queryIdentityMatches && queryCallers.length > 0 && queryCallers.every((c) => c.owner === owner && c.actor === callerActor2 && c.uid === callerUid2), queryCallers);
    await ep2.stop();

    // Hold renewal until a separate authorized caller has read the real canonical terminal.
    // No private Manager state or raw EPF reader is used to supply the follower's result.
    const gapActor = "caller_gap";
    const gapUid = mintLifecycleUid();
    let gapMints = 0;
    let releaseRenewal!: () => void;
    const renewalAllowed = new Promise<void>((resolve) => { releaseRenewal = resolve; });
    const gapBearer = async () => {
      if (++gapMints > 1) await renewalAllowed;
      return issuer.issue({ owner, space: SPACE, actor: gapActor, scope: ["spawn"], lifecycleUid: gapUid, ttlSec: 3 });
    };
    const epNativeGap = new CotalEndpoint({
      space: SPACE, servers: SERVERS, bearer: gapBearer, sentinelCreds: callout.sentinelCreds,
      lifecycleUid: gapUid, card: { owner, actor: gapActor, id: gapActor, name: "caller-gap", kind: "agent" },
      consume: false, watchPresence: false, registerPresence: false,
    });
    const epGapObserver = new CotalEndpoint({
      space: SPACE, servers: SERVERS,
      bearer: () => issuer.issue({ owner, space: SPACE, actor: gapActor, scope: ["spawn"], lifecycleUid: gapUid, ttlSec: 60 }),
      sentinelCreds: callout.sentinelCreds, lifecycleUid: gapUid,
      card: { owner, actor: gapActor, id: gapActor, name: "gap-observer", kind: "agent" },
      consume: false, watchPresence: false, registerPresence: false,
    });
    let gapRebound = false;
    epNativeGap.on("error", () => {});
    epNativeGap.on("connection", (event) => { if (event.connected && gapMints > 1) gapRebound = true; });
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let gapFollow: Promise<EpAttributedReply> | undefined;
    try {
      await startEndpoint(epNativeGap);
      await startEndpoint(epGapObserver);
      const oldGapNc = (epNativeGap as unknown as { nc: NatsConnection }).nc;
      let gapGoalId: string | undefined;
      let gapSubmits = 0;
      let canonicalReadRecovered = false;
      gapFollow = epNativeGap.followServiceGoal(BASELINE_LIFECYCLE_ENDPOINT, async (signal) => {
        gapSubmits++;
        const accepted = await epNativeGap.invokeService(BASELINE_LIFECYCLE_ENDPOINT, "spawn", { name: "gap-user", agent: "delayed-join", events: false }, { signal });
        gapGoalId = (accepted.reply.data as { goalId?: string })?.goalId;
        return accepted;
      }, 15_000, {
        reconcile: async (goalId, _attributed, context) => {
          const read = await epNativeGap.invokeService(BASELINE_LIFECYCLE_ENDPOINT, "goal-result", { goalId }, { signal: context.signal, deadlineMs: Math.min(5000, context.deadlineMs) });
          if (!read.reply.ok) throw new Error(read.reply.error?.message ?? "goal-result refused");
          const data = read.reply.data as { goalId: string; result?: GoalResultFact };
          canonicalReadRecovered ||= data.result?.state === "succeeded";
          return data;
        },
      });
      // Observe rejections promptly even while the fixture waits for the broker-expiry witness.
      void gapFollow.catch(() => {});
      await Promise.race([oldGapNc.closed(), new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error("wire-gap connection did not expire")), 5000);
      })]);
      if (closeTimer) clearTimeout(closeTimer);
      check("GAP-WIRE: broker expired the standing connection", oldGapNc.isClosed());
      let committed: GoalResultFact | undefined;
      const commitDeadline = Date.now() + 10_000;
      while (!committed && Date.now() < commitDeadline) {
        if (gapGoalId) {
          const read = await epGapObserver.invokeService(BASELINE_LIFECYCLE_ENDPOINT, "goal-result", { goalId: gapGoalId });
          if (!read.reply.ok) throw new Error(read.reply.error?.message ?? "observer read refused");
          committed = (read.reply.data as { result?: GoalResultFact }).result;
        }
        if (!committed) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      check("GAP-WIRE: native canonical terminal exists before renewal is released", committed?.state === "succeeded" && !gapRebound, { committed: committed?.state, gapRebound });
      releaseRenewal();
      const recovered = await Promise.race([gapFollow, new Promise<undefined>((resolve) => { recoveryTimer = setTimeout(() => resolve(undefined), 3000); })]);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      check("GAP-WIRE: recovery settles promptly after renewal", recovered !== undefined);
      check("GAP-WIRE: real goal-result recovers canonical success", recovered?.reply.ok === true && canonicalReadRecovered, recovered?.reply);
      check("GAP-WIRE: the accepted mutation is submitted only once", gapSubmits === 1, { gapSubmits });
    } finally {
      releaseRenewal();
      if (closeTimer) clearTimeout(closeTimer);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      await epNativeGap.stop();
      await epGapObserver.stop();
      await gapFollow?.catch(() => {});
    }

    // ==================================================================
    // 7. GAP TERMINAL RECONCILIATION (Terminal committed during disconnect gap)
    // ==================================================================
    const epGap = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epGap);

    const gapGoalId = "goal-gap-terminal";
    const gapFingerprint = "fp-gap-accepted";
    const gapState = { reconciled: false };

    // Simulate an accepted goal whose live progress was missed because terminal was committed during a gap
    const gapFollowResult = await epGap.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => ({
        reply: { v: 1 as const, id: "r-gap", ok: true as const, data: { goalId: gapGoalId, fingerprint: gapFingerprint } },
        responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 1 },
      }),
      400,
      {
        reconcile: async (goalId) => {
          gapState.reconciled = true;
          const payloadData = { name: "gap-user", role: "worker" };
          // Valid canonical fact committed during gap
          const validFact: GoalResultFact = {
            v: 1,
            goalId,
            fingerprint: gapFingerprint,
            state: "succeeded",
            outcomeDigest: contractDigest(payloadData),
            data: payloadData,
            committer: { instanceId: mgrIid, epoch: 1 },
            ts: Date.now(),
          };
          return { goalId, result: validFact };
        },
      },
    );

    check("GAP: goal terminal was reconciled from canonical fact", gapState.reconciled === true);
    check("GAP: followServiceGoal resolves ok: true via reconciliation", gapFollowResult.reply.ok === true, gapFollowResult.reply);
    await epGap.stop();

    // ==================================================================
    // 8. ABORT BEFORE / DURING SUBMIT
    // ==================================================================
    const epAbort = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epAbort);

    // Already-aborted signal
    const preAborted = new AbortController();
    preAborted.abort();
    let preAbortSubmitCalled = false;
    const preAbortT0 = Date.now();
    const preAbortError = await outcomeError(epAbort.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => {
        preAbortSubmitCalled = true;
        return {
          reply: { v: 1 as const, id: "r-aborted", ok: true as const, data: { goalId: "g-pre-abort" } },
          responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 1 },
        };
      },
      5000,
      { signal: preAborted.signal },
    ));
    const preAbortElapsed = Date.now() - preAbortT0;
    check("ABORT-PRE: already-aborted signal settles immediately", preAbortElapsed < 100, { preAbortElapsed });
    check("ABORT-PRE: submit was never called", preAbortSubmitCalled === false);
    check("ABORT-PRE: returns unavailable error", preAbortError?.code === "unavailable");
    check("ABORT-PRE: carries not-executed outcome", preAbortError?.outcome === "not-executed");

    // Abort during submit
    const midAbortCtrl = new AbortController();
    const midAbortT0 = Date.now();
    const midAbortError = await outcomeError(epAbort.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => {
        // Trigger abort while submit is in flight
        midAbortCtrl.abort();
        return {
          reply: { v: 1 as const, id: "r-mid", ok: true as const, data: { goalId: "g-mid-abort" } },
          responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 1 },
        };
      },
      5000,
      { signal: midAbortCtrl.signal },
    ));
    const midAbortElapsed = Date.now() - midAbortT0;
    check("ABORT-MID: abort during submit settles promptly", midAbortElapsed < 200, { midAbortElapsed });
    check("ABORT-MID: returns unavailable error", midAbortError?.code === "unavailable");
    check("ABORT-MID: carries unknown outcome, never not-executed", midAbortError?.outcome === "unknown");
    check("ABORT-MID: forbids blind retry", /do not retry/i.test(midAbortError?.message ?? ""));

    const refusalAbort = new AbortController();
    let wireRefusal: EpAttributedReply | undefined;
    const refusalResult = await epAbort.followServiceGoal(BASELINE_LIFECYCLE_ENDPOINT, async (signal) => {
      wireRefusal = await invokeCommand((epAbort as unknown as { nc: NatsConnection }).nc, SPACE,
        { ...realService, responder: { ...realService.responder, epoch: 999 } },
        "spawn", { name: "refused-before-effects", agent: "delayed-join" }, { signal, deadlineMs: 2000 });
      refusalAbort.abort();
      return wireRefusal;
    }, 5000, { signal: refusalAbort.signal });
    check("REFUSAL: stop preserves the exact attributed refusal", refusalResult === wireRefusal);
    check("REFUSAL: real manager refused before effects", refusalResult.reply.ok === false && replyRefusedBeforeEffect(refusalResult.reply.error));
    check("REFUSAL: broker attribution is retained without claiming acceptance", refusalResult.responder.instanceId === mgrIid && refusalResult.reply.error?.outcome === "not-executed" && !refusalResult.reply.error.message.includes("goal was accepted"));
    await epAbort.stop();

    // ==================================================================
    // 9. PLAIN EXCHANGE / BEARER ERRORS NOT SWALLOWED AS DEADLINE
    // ==================================================================
    const epBearerErr = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epBearerErr);

    const bearerErrResult = await epBearerErr.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => ({
        reply: { v: 1 as const, id: "r-b", ok: true as const, data: { goalId: "g-bearer-err" } },
        responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 1 },
      }),
      300,
      {
        reconcile: async () => {
          throw new Error("manager control exchange returned an invalid bearer");
        },
      },
    );
    check("BEARER-ERR: plain exchange error returns unavailable, not deadline-exceeded", bearerErrResult.reply.ok === false && bearerErrResult.reply.error?.code === "unavailable");
    check("BEARER-ERR: message preserves exchange error text", bearerErrResult.reply.error?.message.includes("manager control exchange returned an invalid bearer") === true);
    await epBearerErr.stop();

    // ==================================================================
    // 10. QUERYRES GOALID MISMATCH REJECTED AS MIS-SUBJECTED
    // ==================================================================
    const epMisSubject = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epMisSubject);

    const misSubjectResult = await epMisSubject.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => ({
        reply: { v: 1 as const, id: "r-mis", ok: true as const, data: { goalId: "g-expected" } },
        responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 1 },
      }),
      300,
      {
        reconcile: async () => ({
          goalId: "g-DIFFERENT",
          result: {
            v: 1,
            goalId: "g-DIFFERENT",
            fingerprint: "fp",
            state: "succeeded",
            outcomeDigest: contractDigest(null),
            data: null,
            committer: { instanceId: mgrIid, epoch: 1 },
            ts: Date.now(),
          },
        }),
      },
    );
    check("MIS-SUBJECT: mismatched goalId in queryRes is rejected", misSubjectResult.reply.ok === false && misSubjectResult.reply.error?.code === "unavailable" && misSubjectResult.reply.error.outcome === "unknown" && misSubjectResult.reply.error.message.includes("names a different goal"));
    await epMisSubject.stop();

    // ==================================================================
    // 11. BOUNDED PRE-DEADLINE RECONCILE (No unbounded await)
    // ==================================================================
    const epHangRec = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epHangRec);

    const hangRecT0 = Date.now();
    let readStartedAt: number | undefined;
    let readSignal: AbortSignal | undefined;
    let releaseRead!: (value: { goalId: string; result?: GoalResultFact }) => void;
    const heldRead = new Promise<{ goalId: string; result?: GoalResultFact }>((resolve) => { releaseRead = resolve; });
    const hangRecPromise = epHangRec.followServiceGoal(
      BASELINE_LIFECYCLE_ENDPOINT,
      async () => ({
        reply: { v: 1 as const, id: "r-hang", ok: true as const, data: { goalId: "g-hang-rec" } },
        responder: { endpoint: BASELINE_LIFECYCLE_ENDPOINT, instanceId: mgrIid, epoch: 1 },
      }),
      600,
      {
        reconcile: async (_goalId, _attributed, context) => {
          readStartedAt = Date.now();
          readSignal = context.signal;
          return heldRead;
        },
      },
    );
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      hangRecPromise,
      new Promise<undefined>((resolve) => { probeTimer = setTimeout(() => resolve(undefined), 700); }),
    ]);
    if (probeTimer) clearTimeout(probeTimer);
    const hangRecElapsed = Date.now() - hangRecT0;
    check("BOUNDED-REC: settles within deadline budget despite hanging reconcile", observed !== undefined, { hangRecElapsed });
    // Release only after the settlement assertion; a hung implementation cannot earn a green
    // by receiving a cooperative reply. Getters witness any forbidden late fact processing.
    let lateFactReads = 0;
    releaseRead({
      get goalId() { lateFactReads++; return "g-hang-rec"; },
      get result(): GoalResultFact { lateFactReads++; return { v: 1, goalId: "g-hang-rec", fingerprint: "fp", state: "succeeded", outcomeDigest: contractDigest(null), data: null, ts: Date.now() }; },
    });
    const hangRecResult = await hangRecPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    check("BOUNDED-REC: times out with deadline-exceeded", hangRecResult.reply.ok === false && hangRecResult.reply.error?.code === "deadline-exceeded");
    check("BOUNDED-REC: reconciliation begins before the wait deadline", readStartedAt !== undefined && readStartedAt - hangRecT0 < 600);
    check("BOUNDED-REC: completion cancels the owned read", readSignal?.aborted === true);
    check("BOUNDED-REC: late canonical reply is not processed", lateFactReads === 0, { lateFactReads });
    await epHangRec.stop();

    // ==================================================================
    // 12. REAL NATIVE MANAGER PRODUCER VALIDATION (Cherry-Picked)
    // ==================================================================
    const epProd = new CotalEndpoint({
      space: SPACE,
      servers: SERVERS,
      bearer: bearer1,
      sentinelCreds: callout.sentinelCreds,
      lifecycleUid: callerUid1,
      card: { owner, actor: callerActor1, id: callerActor1, name: "caller-pos", kind: "agent" },
      consume: false,
      watchPresence: false,
      registerPresence: false,
    });
    await startEndpoint(epProd);

    // Query real manager producer for pos-user goal
    const realProducerReply = await epProd.invokeService(
      BASELINE_LIFECYCLE_ENDPOINT,
      "goal-result",
      { goalId: posGoalId },
    );
    check("PRODUCER: real native manager responds to goal-result with ok: true", realProducerReply.reply.ok === true, realProducerReply.reply);
    const prodData = realProducerReply.reply.data as { goalId: string; result?: GoalResultFact };
    check("PRODUCER: returns requested goalId", prodData?.goalId === posGoalId);
    check("PRODUCER: committed terminal fact is succeeded", prodData?.result?.state === "succeeded");
    check("PRODUCER: committer instanceId matches manager", prodData?.result?.committer?.instanceId === mgrIid);

    // Query for unknown goal returns { goalId } without result
    const unknownReply = await epProd.invokeService(
      BASELINE_LIFECYCLE_ENDPOINT,
      "goal-result",
      { goalId: "nonexistent-goal" },
    );
    check("PRODUCER: unknown goal returns ok: true", unknownReply.reply.ok === true);
    const unkData = unknownReply.reply.data as { goalId: string; result?: GoalResultFact };
    check("PRODUCER: unknown goal has result undefined", unkData?.goalId === "nonexistent-goal" && unkData?.result === undefined);
    await epProd.stop();
  } finally {
    await cleanup();
  }

  if (pass + fail !== 63) throw new Error(`lifetime suite executed ${pass + fail} checks, expected 63`);
  console.log(`\nSmoke suite completed: ${pass} passed, ${fail} failed.`);
  emitSentinel({ passed: pass, failed: fail });
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("UNHANDLED SMOKE ERROR:", e);
  process.exit(1);
});

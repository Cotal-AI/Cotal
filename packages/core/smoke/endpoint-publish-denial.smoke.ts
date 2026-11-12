/**
 * A broker publish violation on an instance-pinned rail must surface as
 * `permission-denied` naming the refused subject, not as an unanswered deadline, a successful
 * cast, or a silent `unknown`. Covers describe, invoke/`epCall`, `epCast`, and
 * `epProbeInstanceInterest`. Does not mint `ep.inst.*` grants.
 *
 * Run: pnpm smoke:ep-publish-denial:auth
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import type { StatusStream } from "../src/endpoint-publish-denial.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import {
  compileContract, createSpaceAuth, describeEndpoint, DEV_OWNER, EpEnvelopeError, epCall, epCast,
  epProbeInstanceInterest, invokeCommand, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig,
  standaloneConnectOpts, unansweredRequest, CotalEndpoint, setupSpaceStreams,
  serviceContractTable, singleDocumentClosure, contractStoreContext, publishContractArtifact, contractArtifactCanonicalBytes,
  parseEpSubject, deriveReplySubject, epServeFilter, epClassQueueGroup, epeSubject, goalProgressTopic,
  type EpCaller, type ResolvedService,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = "eppubdenial";
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv);
const IID = "i".repeat(26);
const empty = compileContract({ root: { type: "null" } });
const DEADLINE_MS = 800;
const endpoints: CotalEndpoint[] = [];
const connections: NatsConnection[] = [];

const caught = async (fn: () => Promise<unknown>): Promise<{ code: string; message: string; elapsed: number; err: unknown }> => {
  const started = Date.now();
  try {
    await fn();
    return { code: "ok", message: "", elapsed: Date.now() - started, err: undefined };
  } catch (e) {
    return {
      code: e instanceof EpEnvelopeError ? e.code : (e as Error).name,
      message: e instanceof Error ? e.message : String(e),
      elapsed: Date.now() - started,
      err: e,
    };
  }
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");

  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  // Class-rail instrument only. Pinning `ep.inst.*` is out of scope for this cell.
  const creds = await mintCreds(auth, id, "control-caller-privileged", { lifecycleUid: uid });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });

  console.log("1. a class-rail credential's instance-addressed describe is a refused publish, not silence");
  const describe = await caught(() => describeEndpoint(nc, space, "manager", caller, { deadlineMs: DEADLINE_MS, instanceId: IID }));
  check("describe is permission-denied, not a deadline", describe.code === "permission-denied", describe);
  check("describe names the refused instance-rail subject", describe.message.includes(`.ep.inst.manager.${IID}.describe.`), describe.message.slice(0, 280));
  check("describe settles well inside the deadline (a timeout masquerade waits it out)", describe.elapsed < DEADLINE_MS / 2, describe.elapsed);
  check("describe is not marked unanswered", !unansweredRequest(describe.err), describe.err);

  console.log("2. the same hole on invoke/epCall: a pinned command publish must not wait out the budget");
  const service: ResolvedService = {
    endpoint: "manager",
    owner: DEV_OWNER,
    caller,
    responder: { instanceId: IID, epoch: 1 },
    pinnedInstanceId: IID,
    commands: new Map([["status", {
      command: "status",
      contract: { input: empty, output: empty },
      class: "ephemeral",
      targeted: false,
      modes: [],
      capability: "status",
    }]]),
  };
  const invoke = await caught(() => invokeCommand(nc, space, service, "status", undefined, { deadlineMs: DEADLINE_MS }));
  check("invoke is permission-denied, NOT a deadline", invoke.code === "permission-denied", invoke);
  check("invoke names the refused instance-rail subject", invoke.message.includes(`.ep.inst.manager.${IID}.status.`), invoke.message.slice(0, 280));
  check("invoke settles well inside the deadline", invoke.elapsed < DEADLINE_MS / 2, invoke.elapsed);
  check("invoke is not marked unanswered", !unansweredRequest(invoke.err), invoke.err);
  check("invoke says the responder may be healthy and a grant made after connecting needs a reconnect",
    /REFUSED BY THE BROKER/.test(invoke.message) && /no grant covers it, or it was granted after this connection authenticated.*reconnect and retry/.test(invoke.message),
    invoke.message.slice(0, 280));

  const direct = await caught(() => epCall(nc, space, { mode: "inst", instanceId: IID, epoch: 1 }, {
    endpoint: "manager", command: "status", contract: { input: empty, output: empty }, caller,
  }, { deadlineMs: DEADLINE_MS }));
  check("epCall on the inst rail is the same permission-denied, not a second clock",
    direct.code === "permission-denied" && direct.message.includes(`.ep.inst.manager.${IID}.status.`) && direct.elapsed < DEADLINE_MS / 2,
    direct);

  console.log("3. the call's permission watch does not leak a status listener per invoke");
  const listeners = (): number =>
    ((nc as unknown as { protocol?: { listeners?: unknown[] } }).protocol?.listeners ?? []).length;
  check("the internal listener registry is reachable (else this cell proves nothing)",
    Array.isArray((nc as unknown as { protocol?: { listeners?: unknown[] } }).protocol?.listeners), listeners());
  const before = listeners();
  const ROUNDS = 12;
  for (let i = 0; i < ROUNDS; i++)
    await invokeCommand(nc, space, service, "status", undefined, { deadlineMs: DEADLINE_MS }).catch(() => {});
  const after = listeners();
  console.log(`   listeners before=${before} after ${ROUNDS} denied invokes=${after}`);
  check(`${ROUNDS} denied invokes leave the listener count where they found it`, after === before, { before, after });

  console.log("4. the same rule on cast and liveness probe: a refused publish is a refusal, never success or silence");
  // An INDEPENDENT status iterator on the same connection records what the broker actually said,
  // so the cells assert against observed truth rather than against the verbs' own reports.
  const violations: string[] = [];
  const seen = nc.status() as StatusStream;
  void (async () => { for await (const s of seen) if (s.type === "error" && s.error instanceof PermissionViolationError) violations.push(`${s.error.subject}`); })().catch(() => {});

  const cast = await caught(() => epCast(nc, space, { mode: "inst", instanceId: IID }, {
    endpoint: "manager", command: "status", contract: { input: empty, output: empty }, caller,
  }, { deadlineMs: DEADLINE_MS }));
  const castAllowed = await caught(() => epCast(nc, space, { mode: "one" }, {
    endpoint: "manager", command: "status", contract: { input: empty, output: empty }, caller,
  }));
  check("a denied cast is permission-denied naming the refused subject, not success",
    cast.code === "permission-denied" && cast.message.includes(`.ep.inst.manager.${IID}.status.`), cast);
  check("the broker DID refuse the cast publish (independent iterator saw the subject)",
    violations.some((s) => s.includes(`.ep.inst.manager.${IID}.status.`)), violations);

  const probe = await caught(() => epProbeInstanceInterest(nc, space, "manager", IID, caller, { deadlineMs: DEADLINE_MS }));
  check("a denied probe is permission-denied naming the refused subject, not unknown",
    probe.code === "permission-denied" && probe.message.includes(`.ep.inst.manager.${IID}.describe.`), probe);
  check("a denied probe settles well inside its budget (a masquerade waits it out)",
    probe.elapsed < DEADLINE_MS / 2, probe.elapsed);
  check("the broker DID refuse the probe publish (independent iterator saw the subject)",
    violations.some((s) => s.includes(`.ep.inst.manager.${IID}.describe.`)), violations);
  seen.stop();
  await wait(50); // let the repro iterator's own teardown finish, so it cannot pollute the baseline below

  check("an ALLOWED cast on the class rail still resolves void (the watch adds no refusal of its own)",
    castAllowed.code === "ok", castAllowed);

  console.log("5. the cast's and probe's permission watches do not leak a status listener per call");
  const before2 = listeners();
  for (let i = 0; i < ROUNDS; i++) {
    await epCast(nc, space, { mode: "inst", instanceId: IID }, {
      endpoint: "manager", command: "status", contract: { input: empty, output: empty }, caller,
    }, { deadlineMs: DEADLINE_MS }).catch(() => {});
    await epProbeInstanceInterest(nc, space, "manager", IID, caller, { deadlineMs: DEADLINE_MS }).catch(() => {});
  }
  const after2 = listeners();
  console.log(`   listeners before=${before2} after ${ROUNDS} denied casts and ${ROUNDS} denied probes=${after2}`);
  check(`${ROUNDS} denied casts and ${ROUNDS} denied probes leave the listener count where they found it`, after2 === before2, { before: before2, after: after2 });

  console.log("6. permission recovery holds the entire follow setup, but not an accepted goal");
  // Wire fixture, not a Manager: real broker-enforced caller rows, published contract artifacts,
  // and attributed replies drive CotalEndpoint.invokeService without launching another agent.
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisioner });
  const storeId = newIdentity();
  const storeJwt = await encodeUser("contract-fixture", fromPublic(storeId.id), fromPublic(auth.account.pub), {
    pub: { allow: [`cotal.${space}.epc.>`] }, sub: { allow: [`_INBOX_${storeId.id}.>`] },
  }, { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) });
  const storeCreds = new TextDecoder().decode(fmtCreds(storeJwt, fromSeed(new TextEncoder().encode(storeId.seed))));
  const storeNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: storeCreds, tls: false }) });
  connections.push(storeNc);
  const table = serviceContractTable(["define-persona", "goal-result"].map(name => ({ name, input: { type: "object" }, output: { type: "object" } })));
  const doc = { urn: "ai.cotal.manager", revision: 1, attributes: [], events: [], commands: Object.entries(table.contracts).map(([name, pair]) => ({
    name, class: "ephemeral", targeted: false, capability: "manager.call", inputDigest: pair.input.closureDigest, outputDigest: pair.output.closureDigest,
  })) };
  const closure = singleDocumentClosure(doc);
  const store = await contractStoreContext(storeNc, space);
  for (const value of [...table.artifactValues(), doc, closure.manifest]) await publishContractArtifact(store, contractArtifactCanonicalBytes(value));
  const hostId = newIdentity();
  const enc = new TextEncoder();
  const hostJwt = await encodeUser("follow-fixture", fromPublic(hostId.id), fromPublic(auth.account.pub), {
    pub: { allow: [`cotal.${space}.ep.reply.manager.${IID}.1.>`, `cotal.${space}.epe.manager.${IID}.1.>`] },
    sub: { allow: [`${epServeFilter(space, "one", "manager")} ${epClassQueueGroup("manager")}`, `_INBOX_${hostId.id}.>`] },
  }, { signer: fromSeed(enc.encode(auth.account.signingSeed)) });
  const hostCreds = new TextDecoder().decode(fmtCreds(hostJwt, fromSeed(enc.encode(hostId.seed))));
  const host = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: hostCreds, tls: false }) });
  connections.push(host);
  let mutations = 0;
  let acceptHeld!: () => void;
  const heldAccepted = new Promise<void>(resolve => { acceptHeld = resolve; });
  let terminalCaller!: EpCaller;
  const terminal = (goalId: string) => host.publish(epeSubject(space, "manager", IID, 1,
    goalProgressTopic({ endpoint: "manager", caller: terminalCaller, goalId })), enc.encode(JSON.stringify({
      goalId, phase: "terminal", state: "succeeded", data: { goalId },
    })));
  host.subscribe(epServeFilter(space, "one", "manager"), { queue: epClassQueueGroup("manager"), callback: (_err, msg) => {
    const parsed = parseEpSubject(msg.subject);
    if (!parsed || parsed.plane !== "request") return;
    const request = msg.json<{ id: string; args?: { name?: string; goalId?: string } }>();
    let data: unknown;
    if (parsed.command === "describe") data = { public: true, descriptor: { endpoint: "manager", owner: DEV_OWNER, clusters: [{ digest: closure.closureDigest, commands: Object.keys(table.contracts) }] } };
    else if (parsed.command === "goal-result") data = { goalId: request.args?.goalId };
    else {
      mutations++;
      const goalId = request.args?.name ?? "flush-goal";
      terminalCaller = parsed.caller;
      data = { goalId };
      if (goalId === "held-goal") acceptHeld();
      else terminal(goalId);
    }
    host.publish(deriveReplySubject(space, parsed, { instanceId: IID, epoch: 1 }), enc.encode(JSON.stringify({ v: 1, id: request.id, ok: true, data })));
  } });
  await host.flush();
  let callerNc!: NatsConnection;
  let releaseFlush!: () => void, enteredFlush!: () => void;
  const flushHeld = new Promise<void>(resolve => { releaseFlush = resolve; });
  const flushEntered = new Promise<void>(resolve => { enteredFlush = resolve; });
  let holdProgress = false;
  const ep = new CotalEndpoint({ space, servers: SERVERS,
    creds: await mintCreds(auth, id, "agent", { lifecycleUid: uid, capabilities: ["spawn"] }), lifecycleUid: uid,
    card: { name: "follow-caller", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
    onConnection(next) {
      callerNc = next;
      const subscribe = next.subscribe.bind(next), flush = next.flush.bind(next);
      let progressSubscribed = false;
      next.subscribe = (...args) => {
        if (args[0].includes(".epe.manager.")) progressSubscribed = true;
        return subscribe(...args);
      };
      next.flush = async () => {
        if (holdProgress && progressSubscribed) { enteredFlush(); await flushHeld; }
        return flush();
      };
    },
  });
  endpoints.push(ep);
  ep.on("error", () => {});
  await ep.start();
  await ep.describeService("manager");
  let rebuilds = 0;
  ep.on("connection", ({ connected }: { connected: boolean }) => { if (connected) rebuilds++; });
  holdProgress = true;
  const followed = ep.invokeService("manager", "define-persona", { name: "flush-goal" }, { follow: true, deadlineMs: 4000 });
  const followResult = followed.then(reply => reply.reply.ok, () => false);
  let refusedResult: Promise<boolean> | undefined;
  const watch = callerNc.status() as StatusStream;
  const deniedDuringFlush = (async () => {
    try {
      for await (const event of watch) if (event.type === "error" && event.error instanceof PermissionViolationError
        && event.error.operation === "publish" && event.error.subject.includes(".describe.")) return;
      throw new Error("no broker refusal observed during follow setup");
    } finally { watch.stop(); }
  })();
  try {
    await Promise.race([flushEntered, followResult.then(() => { throw new Error("follow ended before observation readiness"); })]);
    refusedResult = ep.invokeService("manager", "define-persona", {}, { instanceId: IID, deadlineMs: 4000 })
      .then(() => false, (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied" && e.outcome === "not-executed");
    await Promise.race([deniedDuringFlush, refusedResult.then(() => { throw new Error("broker refusal was not observed during readiness"); })]);
    await wait(200);
    check("observation readiness still holds recovery before any submission", rebuilds === 0 && mutations === 0, { rebuilds, mutations });
    holdProgress = false;
    releaseFlush();
    check("the authorized follow submits once and keeps its terminal after the held flush", await followResult && mutations === 1, { mutations });
    check("the unrelated permanent denial stands after one rebuild", await refusedResult && rebuilds === 1, { rebuilds });
  } finally {
    holdProgress = false; releaseFlush(); watch.stop();
    await Promise.allSettled([followResult, refusedResult, deniedDuringFlush]);
  }
  const heldFollow = ep.invokeService("manager", "define-persona", { name: "held-goal" }, { follow: true, deadlineMs: 4000 });
  const heldResult = heldFollow.then(reply => reply.reply.ok, () => false);
  await Promise.race([heldAccepted, heldResult.then(() => { throw new Error("follow ended without acceptance"); })]);
  try {
    const denied = await caught(() => ep.invokeService("manager", "define-persona", {}, { instanceId: IID, deadlineMs: 2000 }));
    check("accepted goal observation does not block a later permission recovery", denied.code === "permission-denied" && rebuilds === 2, denied);
    terminal("held-goal");
    await host.flush();
    check("the accepted goal follows across recovery without resubmitting", await heldResult && mutations === 2, { mutations });
  } finally {
    terminal("held-goal");
    await Promise.allSettled([heldResult]);
  }

  await nc.drain().catch(() => nc.close());
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", e);
} finally {
  await Promise.all(endpoints.map(ep => ep.stop()));
  await Promise.all(connections.map(nc => nc.close()));
  await killAndAwaitExit(srv, "SIGKILL");
  releaseBroker();
  if (srv.exitCode === null && srv.signalCode === null) throw new Error("broker exit unproven; storage preserved");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nENDPOINT PUBLISH DENIAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection, type Msg } from "@nats-io/transport-node";
import { encodeUser, fmtCreds, type User } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createSpaceAuth, serverConfig, permissionsFor, isReachable, chatStream, chatSubject, channelBucket, epcStreamName } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

/**
 * Origin binding for the candidate issued rail (SPEC 678-695, 3084-3094): a JetStream read
 * delivers stored bytes to a caller-chosen destination the broker does NOT confine to the
 * requester's `pub.allow`. This measures which of those paths actually reach an endpoint's
 * REAL serve subscription shape (wildcard + queue), and whether the arriving frame is
 * distinguishable from a conforming request. Test-only; no production code is attached.
 */
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (error) { console.error(`  FAIL: ${name}`); throw error; }
  console.log(`  ok ${name}`); passed++;
}
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
interface Frame { subject: string; body: string; reply?: string; headerKeys: string[] }
const frameOf = (msg: Msg): Frame => ({
  subject: msg.subject, body: dec(msg.data), reply: msg.reply,
  headerKeys: msg.headers ? [...msg.headers].map(([key]) => key) : [],
});
const space = "issuedingress";
const auth = await createSpaceAuth(space);
const port = await pickFreePort(), server = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" } }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const exited = new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
const releaseBroker = teardownOnSignal(broker, dir);
const connections: NatsConnection[] = [];
const observations: Array<Record<string, unknown>> = [];
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(server); if (!up) await wait(50); }
  assert.ok(up, "isolated broker must start");
  async function open(permissions: Record<string, unknown>, inboxPrefix?: string) {
    const key = createUser();
    const jwt = await encodeUser("ingress-probe", fromPublic(key.getPublicKey()), fromPublic(auth.account.pub), permissions as Partial<User>, { signer: fromSeed(enc(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 600 });
    const nc = await connect({ servers: server, authenticator: credsAuthenticator(fmtCreds(jwt, key)), maxReconnectAttempts: 0, ...(inboxPrefix ? { inboxPrefix } : {}) });
    connections.push(nc); return nc;
  }
  const operator = await open({ pub: { allow: [">"] }, sub: { allow: [">"] } });
  const stream = chatStream(space);
  const jsm = await jetstreamManager(operator);
  await jsm.streams.add({ name: stream, subjects: [`cotal.${space}.chat.>`] });
  const epc = epcStreamName(space);
  await jsm.streams.add({ name: epc, subjects: [`cotal.${space}.epc.>`], allow_direct: true });
  const channels = await new Kvm(operator).create(channelBucket(space));
  await channels.put("public", enc(JSON.stringify({ description: "channel registry row" })));

  const uid = "u".repeat(26), generation = "a".repeat(32), nonce = "n".repeat(22);
  const rail = `cotal.${space}.ep.v1.one.manager.run-start.local.victim.${uid}.${generation}.${nonce}`;
  // The REAL serve shape an endpoint uses (§13.9): wildcard filter, queue-qualified.
  const serveFilter = `cotal.${space}.ep.v1.one.>`, queue = "manager";
  const frames: Frame[] = [];
  const serve = operator.subscribe(serveFilter, { queue });
  void (async () => { for await (const msg of serve) frames.push(frameOf(msg)); })();
  // An exact-subject listener alongside it, to tell "not delivered at all" from "not delivered
  // to the serve shape". Distinct queue group so it never competes with the serve subscription.
  const exactFrames: Frame[] = [];
  const exact = operator.subscribe(rail, { queue: "exact-witness" });
  void (async () => { for await (const msg of exact) exactFrames.push(frameOf(msg)); })();
  await operator.flush();
  const seen = async (list: Frame[], body: string, ms = 1200): Promise<Frame | undefined> => {
    for (let i = 0; i < ms / 20; i++) { const hit = list.find((f) => f.body.includes(body)); if (hit) return hit; await wait(20); }
    return undefined;
  };

  const principal = { owner: "local", actor: "deputy", connId: "deputy0123456789abcdef", lifecycleUid: uid };
  const perms = permissionsFor("agent", space, principal, { allowPublish: ["public"], allowSubscribe: ["public"] }) as { pub: { allow: string[] } };
  const agent = await open(perms, `_INBOX_${principal.connId}`);
  let denials = 0;
  void (async () => { for await (const event of agent.status()) if (event.type === "error" && /permission/i.test(String(event.error))) denials++; })();

  await check("the serve subscription receives a conforming request and the agent cannot publish one", async () => {
    const legitimate = `conforming-${randomBytes(6).toString("hex")}`;
    operator.publish(rail, enc(legitimate), { reply: `_INBOX_${principal.connId}.1` });
    const frame = await seen(frames, legitimate);
    assert.ok(frame, "the wildcard queue serve subscription must receive a direct request");
    assert.equal(frame.headerKeys.length, 0);
    assert.equal(frame.reply?.startsWith("$JS.ACK.") ?? false, false);
    const before = denials;
    agent.publish(rail, enc("direct-attempt"));
    await agent.flush();
    for (let i = 0; i < 60 && denials === before; i++) await wait(20);
    assert.ok(denials > before, "the stock agent profile must be denied a direct publish onto the rail");
    assert.equal(await seen(frames, "direct-attempt", 200), undefined);
  });

  await check("the discovery grant the contract adds is itself a delivery path onto the rail", async () => {
    // Section 5 of the contract requires `$SYS.REQ.USER.INFO` in every issued ceiling. That request
    // is answered to a caller-chosen reply subject, so it belongs in the delivery-class table with
    // the JetStream reads, not outside it. Measure where its response lands.
    const discoverer = await open({ ...perms, pub: { allow: [...perms.pub.allow, "$SYS.REQ.USER.INFO"] } }, `_INBOX_${principal.connId}`);
    discoverer.publish("$SYS.REQ.USER.INFO", new Uint8Array(0), { reply: rail });
    await discoverer.flush();
    const onServe = await seen(frames, "account_name");
    const onExact = await seen(exactFrames, "account_name", 200);
    observations.push({
      vector: "sys-user-info-reply", reachedServeShape: onServe !== undefined,
      reachedExactSubject: onExact !== undefined, subject: onServe?.subject,
      headerKeys: onServe?.headerKeys ?? [], reply: onServe?.reply,
      leaksOwnPermissions: (onServe?.body ?? "").includes("permissions"),
    });
    // Measured on NATS 2.14.5: it reaches the serve shape, under the rail subject, with no
    // headers. So the grant the contract adds is a fifth delivery path, and an unmarked one.
    assert.ok(onServe, "the $SYS.REQ.USER.INFO response must be observed to classify it");
    assert.equal(onServe.subject, rail);
    assert.deepEqual(onServe.headerKeys, []);
    assert.ok(onServe.body.includes("permissions"), "the response carries the connection's own ceiling");
  });

  const stored = `stored-${randomBytes(6).toString("hex")}`;
  agent.publish(chatSubject(space, principal.owner, principal.actor, "public"), enc(stored));
  await agent.flush();
  for (let i = 0; i < 60 && (await jsm.streams.info(stream)).state.messages === 0; i++) await wait(20);
  assert.equal((await jsm.streams.info(stream)).state.messages, 1, "the agent's own chat write must be stored");
  const createGrant = perms.pub.allow.find((row) => row.startsWith(`$JS.API.CONSUMER.CREATE.${stream}.`));
  assert.ok(createGrant, "the stock agent profile must carry its pinned history create");
  const durable = createGrant.split(".")[5];
  const filter = chatSubject(space, principal.owner, principal.actor, "public");

  await check("a push consumer aimed at the rail does not reach the wildcard queue serve shape", async () => {
    const response = await agent.request(`$JS.API.CONSUMER.CREATE.${stream}.${durable}.${filter}`,
      enc(JSON.stringify({ stream_name: stream, config: { name: durable, durable_name: durable, filter_subject: filter, deliver_subject: rail, deliver_group: queue, ack_policy: "none", deliver_policy: "last", replay_policy: "instant" } })), { timeout: 3000 });
    const created = JSON.parse(dec(response.data)) as { error?: unknown };
    assert.equal(created.error, undefined, JSON.stringify(created.error));
    const onServe = await seen(frames, stored);
    const onExact = await seen(exactFrames, stored, 200);
    observations.push({ vector: "push consumer deliver_subject", created: true, reachedServeShape: !!onServe, reachedExactSubject: !!onExact, frame: onServe ?? onExact ?? null });
    assert.equal(onServe, undefined, "measured: push delivery is interest-gated and did not reach the wildcard serve subscription");
    await jsm.consumers.delete(stream, durable).catch(() => undefined);
  });

  await check("a pull MSG.NEXT reply aimed at the rail reaches the real serve shape", async () => {
    const response = await agent.request(`$JS.API.CONSUMER.CREATE.${stream}.${durable}.${filter}`,
      enc(JSON.stringify({ stream_name: stream, config: { name: durable, durable_name: durable, filter_subject: filter, ack_policy: "none", deliver_policy: "last", replay_policy: "instant" } })), { timeout: 3000 });
    assert.equal((JSON.parse(dec(response.data)) as { error?: unknown }).error, undefined);
    // The reply subject is chosen in the request, not confined to the requester's pub.allow.
    agent.publish(`$JS.API.CONSUMER.MSG.NEXT.${stream}.${durable}`, enc(JSON.stringify({ batch: 1, no_wait: true })), { reply: rail });
    await agent.flush();
    const frame = await seen(frames, stored);
    observations.push({ vector: "pull MSG.NEXT reply subject", reachedServeShape: !!frame, frame: frame ?? null });
    assert.ok(frame, "the deputy's stored bytes reached the endpoint's real serve subscription");
    // SPEC 690-693 defers this to test: a redelivered message RETAINS its original captured
    // subject, so what the serve handler parses is the chat subject, never the victim rail.
    assert.equal(frame.subject, filter, "measured: the redelivered frame retains its captured subject");
    assert.notEqual(frame.subject, rail);
  });

  await check("a KV STREAM.MSG.GET reply aimed at the rail reaches the real serve shape", async () => {
    const bucket = `KV_${channelBucket(space)}`;
    const before = frames.length;
    agent.publish(`$JS.API.STREAM.MSG.GET.${bucket}`, enc(JSON.stringify({ last_by_subj: `$KV.${channelBucket(space)}.public` })), { reply: rail });
    await agent.flush();
    // The MSG.GET response is a JSON envelope whose payload is base64, so detect it structurally.
    let frame: Frame | undefined;
    for (let i = 0; i < 60 && !frame; i++) { frame = frames.slice(before).find((f) => f.body.includes("\"message\"") || f.body.includes("channel registry row")); if (!frame) await wait(20); }
    observations.push({ vector: "STREAM.MSG.GET reply subject", reachedServeShape: !!frame, frame: frame ?? null });
    assert.ok(frame, "a KV read response reached the endpoint's real serve subscription");
    // Unlike the pull path, a MSG.GET response is an ordinary request/reply publish by the
    // server's internal client, so it arrives UNDER the attacker-chosen rail subject.
    assert.equal(frame.subject, rail, "measured: the KV read response arrives under the victim rail subject");
  });

  await check("a DIRECT.GET reply delivers raw stored bytes under the rail subject", async () => {
    // DIRECT.GET returns the stored body itself, not an API envelope. Its content is bounded by
    // what the grant can read: the agent cannot publish into EPC, so it cannot choose these bytes.
    const artifact = `epc-artifact-${randomBytes(6).toString("hex")}`;
    const artifactSubject = `cotal.${space}.epc.contract.v1`;
    operator.publish(artifactSubject, enc(artifact));
    await operator.flush();
    for (let i = 0; i < 60 && (await jsm.streams.info(epc)).state.messages === 0; i++) await wait(20);
    const canWriteEpc = (perms.pub.allow as string[]).some((row) => row.startsWith(`cotal.${space}.epc.`));
    const before = frames.length;
    agent.publish(`$JS.API.DIRECT.GET.${epc}.${artifactSubject}`, new Uint8Array(0), { reply: rail });
    await agent.flush();
    let frame: Frame | undefined;
    for (let i = 0; i < 60 && !frame; i++) { frame = frames.slice(before).find((f) => f.body.includes(artifact)); if (!frame) await wait(20); }
    observations.push({ vector: "DIRECT.GET reply subject", reachedServeShape: !!frame, attackerControlsBytes: canWriteEpc, frame: frame ?? null });
    assert.ok(frame, "a DIRECT.GET response reached the endpoint's real serve subscription");
    assert.equal(frame.subject, rail, "measured: raw stored bytes arrive under the victim rail subject");
    assert.equal(canWriteEpc, false, "the stock agent cannot write the bytes this path replays");
    assert.ok(frame.headerKeys.some((key) => key.toLowerCase().startsWith("nats-")), "measured: the DIRECT.GET response carries Nats- headers");
  });

  await check("a deputy frame on the rail subject carries no JetStream marker at ingress", async () => {
    const onRail = observations
      .filter((o) => o.reachedServeShape && (o.frame as Frame | null)?.subject === rail)
      .map((o) => o.frame as Frame);
    assert.ok(onRail.length >= 1, "the claim needs a frame that arrived under the rail subject");
    for (const frame of onRail) {
      if (frame.headerKeys.length > 0) continue; // the DIRECT.GET path is marked; measured above
      const marked = frame.headerKeys.some((key) => key.toLowerCase().startsWith("nats-")) || frame.reply?.startsWith("$JS.ACK.") === true;
      observations.push({ railFrameMarker: { reply: frame.reply ?? null, headerKeys: frame.headerKeys, marked } });
      // MEASURED, and the reason a subject- or header-derived ingress rule is not sufficient here.
      assert.equal(marked, false, `a rail-subject deputy frame carried a JetStream marker: ${JSON.stringify(frame)}`);
    }
  });

  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({
    brokerVersion: operator.info?.version, serveFilter, queue, rail, observations,
    scope: "Isolated localhost broker, stock agent profile, candidate ep.v1 subject. Measures namespace delivery into an endpoint's real serve subscription shape; no endpoint handler runs and no production ingress is attached.",
  }, null, 2) + "\n");
  console.log(`issued ingress origin: ${passed} passed`);
} finally {
  for (const nc of connections) await nc.close();
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), wait(2000).then(() => false)]);
  if (!stopped) { broker.kill("SIGKILL"); await exited; }
  rmSync(dir, { recursive: true, force: true }); releaseBroker();
}

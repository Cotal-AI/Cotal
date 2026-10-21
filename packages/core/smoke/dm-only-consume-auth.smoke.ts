/**
 * DM-only consume mode (EndpointOptions.dmOnly) against a real JWT-auth nats-server.
 *
 * The narrow credential is the own-DM reader shape: publish CONSUMER.INFO and MSG.NEXT on the
 * endpoint's own `dm_` durable, publish its `$JS.ACK` subtree, subscribe its own inbox. Nothing else.
 *
 * Controls (must hold, or the rest proves nothing):
 *   P1   the stock agent profile receives one authenticated DM and publishes one.
 *   N0   the narrow credential reads and acks its own `dm_` natively, and is denied DM publish,
 *        `$JS.API.INFO` and presence STREAM.INFO, each paired with the agent credential allowed.
 *   P2c  stock consume:true with the narrow credential still fails start on `$JS.API.INFO` before
 *        any `dm_` request (the base behaviour this mode exists for).
 * Mode cells:
 *   P2   dmOnly with the same credential starts, handles that DM, acks it.
 *   U1   start + handle + ack + renewal through a creds source + stop resolves after close.
 *   U2   a spoofed `from` and an id-less envelope are term()ed and never reach the handler.
 *   U3   a missing `dm_` refuses with dm-durable-missing and is not created; a denied bind refuses
 *        with dm-bind-refused; both paired with a positive bind.
 *   U4   every native publish or request over start, a forced reconnect and stop is a `dm_`
 *        CONSUMER.INFO, MSG.NEXT or `$JS.ACK` row (wire census).
 *   S    the second DM reaches the handler only after the first handler settles; a rejecting
 *        handler leaves its copy unacked and the next DM still arrives.
 *   C    stop waits for a running handler and its ack lands; a handler that never settles makes
 *        stop throw after closing the connection, and its copy stays pending.
 *   custody  every endpoint, connection and the broker are proven closed or exited.
 * Output is cell names, PASS/FAIL and safe classes or counts. No error text, keys or creds.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { PermissionViolationError, type NatsConnection } from "@nats-io/nats-core";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  CotalEndpoint, createSpaceAuth, serverConfig, mintCreds, newIdentity, isReachable,
  setupSpaceStreams, provisionAgent, mintLifecycleUid, dmStream, dmDurable, principalKey,
  unicastSubject, presenceBucket, channelBucket, DEV_OWNER, DmDurableMissingError, DmBindRefusedError, isConsumerNotFound,
  type CotalMessage, type Delivery, type EndpointOptions, type Identity,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, killAndAwaitExit, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort(), SERVERS = `nats://127.0.0.1:${PORT}`, space = "dmonly";
const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number): Promise<T | "deadline"> => Promise.race([p, sleep(ms).then(() => "deadline" as const)]);
const { check, finish } = createSuite();
const errClass = (e: unknown): string => {
  const c = (e as { cause?: unknown })?.cause;
  if (c instanceof PermissionViolationError) return `PermissionViolation/${c.operation}`;
  if (e instanceof PermissionViolationError) return `PermissionViolation/${e.operation}`;
  return (e as Error)?.constructor?.name ?? typeof e;
};
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

// ---- owned custody, registered before anything that can fail starts ----------------------------
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const releasePath = teardownPathOnSignal(dir);
const ownedEndpoints: CotalEndpoint[] = [];
const ownedConns: NatsConnection[] = [];
let broker: ChildProcess | undefined;
let releaseBroker: (() => void) | undefined;
const own = (ep: CotalEndpoint) => { ownedEndpoints.push(ep); ep.on("error", () => {}); ep.on("warning", () => {}); return ep; };
const ownConn = async (creds: string, inboxId: string) => {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(creds)), inboxPrefix: `_INBOX_${inboxId}`, maxReconnectAttempts: 0 });
  ownedConns.push(nc);
  return nc;
};

type Probe = "denied" | "allowed" | "timeout" | "other-denial";
async function probe(nc: NatsConnection, subject: string): Promise<Probe> {
  try { await nc.request(subject, enc("{}"), { timeout: 1500 }); return "allowed"; }
  catch (e) {
    const c = (e as { cause?: unknown }).cause;
    if (c instanceof PermissionViolationError) return c.operation === "publish" && c.subject === subject ? "denied" : "other-denial";
    if (/Timeout/i.test((e as Error)?.constructor?.name ?? "")) return "timeout";
    return "allowed";
  }
}

/** Record every native publish and request subject on a connection, from before the first bind. */
function census(sink: string[]) {
  return (nc: NatsConnection) => {
    const request = nc.request.bind(nc);
    nc.request = (subject, payload, opts) => { sink.push(subject); return request(subject, payload, opts); };
    const publish = nc.publish.bind(nc);
    nc.publish = (subject, payload, opts) => { sink.push(subject); publish(subject, payload, opts); };
  };
}

try {
  const auth = await createSpaceAuth(space);
  const conf = join(dir, "server.conf");
  writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }), { mode: 0o600 });
  chmodSync(conf, 0o600);
  broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, dir);
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });

  const provId = newIdentity();
  const provCreds = await mintCreds(auth, provId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  const prov = own(new CotalEndpoint({ space, servers: SERVERS, creds: provCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } }));
  await prov.start();
  const DM = dmStream(space);

  /** The own-DM reader rows for `id`'s own durable, optionally expiring. */
  const narrowCreds = async (id: Identity, durable: string, expSeconds?: number) => {
    const jwt = await encodeUser("dm-only-reader", fromPublic(id.id), fromPublic(auth.account.pub), {
      pub: { allow: [`$JS.API.CONSUMER.INFO.${DM}.${durable}`, `$JS.API.CONSUMER.MSG.NEXT.${DM}.${durable}`, `$JS.ACK.${DM}.${durable}.>`] },
      sub: { allow: [`_INBOX_${id.id}.>`] },
    }, { signer: fromSeed(enc(auth.account.signingSeed)), ...(expSeconds ? { exp: Math.floor(Date.now() / 1000) + expSeconds } : {}) });
    return new TextDecoder().decode(fmtCreds(jwt, fromSeed(enc(id.seed))));
  };
  const recipient = async () => {
    const id = newIdentity(), uid = mintLifecycleUid();
    const agentCreds = await provisionAgent(prov, auth, id, { allowSubscribe: [], subscribe: [], lifecycleUid: uid });
    const durable = dmDurable(DEV_OWNER, id.id, uid);
    return { id, uid, durable, key: principalKey(DEV_OWNER, id.id).key, agentCreds, narrow: await narrowCreds(id, durable) };
  };
  const dmOnlyOpts = (r: { id: Identity; uid: string }, creds: EndpointOptions["creds"], dmOnly: EndpointOptions["dmOnly"], extra: Partial<EndpointOptions> = {}): EndpointOptions => ({
    space, servers: SERVERS, creds, lifecycleUid: r.uid, channels: [], consume: true,
    watchPresence: false, registerPresence: false, watchChannels: false,
    card: { id: r.id.id, name: "dm-only", kind: "agent" }, dmOnly, ...extra,
  });

  const sId = newIdentity(), sUid = mintLifecycleUid();
  const sCreds = await provisionAgent(prov, auth, sId, { allowSubscribe: [], subscribe: [], lifecycleUid: sUid });
  const sKey = principalKey(DEV_OWNER, sId.id).key;
  const sender = own(new CotalEndpoint({ space, servers: SERVERS, creds: sCreds, lifecycleUid: sUid, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { id: sId.id, name: "s", kind: "agent" } }));
  await sender.start();
  const senderNc = await ownConn(sCreds, sId.id);
  const provAgentJsm = async (agentCreds: string, id: Identity): Promise<JetStreamManager> => jetstreamManager(await ownConn(agentCreds, id.id), { checkAPI: false });
  const pending = async (jsm: JetStreamManager, durable: string) => {
    const i = await jsm.consumers.info(DM, durable);
    return { pending: i.num_pending, ackPending: i.num_ack_pending };
  };

  const R = await recipient();
  const rJsm = await provAgentJsm(R.agentCreds, R.id);

  // ---- P1: stock agent control ------------------------------------------------------------------
  {
    const ep = own(new CotalEndpoint({ space, servers: SERVERS, creds: R.agentCreds, lifecycleUid: R.uid, channels: [], consume: true, watchPresence: false, registerPresence: false, watchChannels: false, card: { id: R.id.id, name: "r", kind: "agent" } }));
    const got = new Promise<CotalMessage>((res) => ep.on("message", (m: CotalMessage, d: Delivery) => { d.ack(); res(m); }));
    await ep.start();
    await sender.unicast(R.key, "p1");
    const m = await within(got, 5000);
    check("P1.recv: stock agent profile receives an authenticated DM", m !== "deadline" && m.from.id === sKey);
    const pub = await within(ep.unicastAttributed(sKey, "p1-pub").then((x) => x.ack.seq > 0, (e) => errClass(e)), 5000);
    check("P1.dm-pub: stock agent profile publishes a DM", pub === true, { class: pub });
    await ep.stop();
  }

  // ---- N0: native sufficiency with paired denials ---------------------------------------------
  {
    await sender.unicast(R.key, "n0");
    const narrow = await ownConn(R.narrow, R.id.id);
    const agent = await ownConn(R.agentCreds, R.id.id);
    const c = await jetstream(narrow, { checkAPI: false }).consumers.get(DM, R.durable).then((x) => x, (e) => errClass(e));
    let read = typeof c === "string" ? `get=${c}` : "no message";
    if (typeof c !== "string") {
      const m = await c.next({ expires: 3000 }).catch(() => null);
      if (m) read = await m.ackAck().then(() => "ok", (e) => `ack=${errClass(e)}`);
    }
    check("N0.read: narrow creds read and ack their own dm_ natively", read === "ok", { read });
    for (const [name, subject] of [
      ["dm-pub", unicastSubject(space, DEV_OWNER, sId.id, DEV_OWNER, R.id.id)],
      ["js-info", "$JS.API.INFO"],
      ["presence", `$JS.API.STREAM.INFO.KV_${presenceBucket(space)}`],
    ] as const) {
      const n = await probe(narrow, subject), a = await probe(agent, subject);
      check(`N0.${name}.narrow-deny`, n === "denied", { narrow: n });
      check(`N0.${name}.agent-allow`, a === "allowed", { agent: a });
    }
  }

  // ---- P2c: stock consume with the narrow credential still fails (control) ----------------------
  {
    const sent: string[] = [];
    let firstDenial: string | undefined;
    const ep = own(new CotalEndpoint({
      space, servers: SERVERS, creds: R.narrow, lifecycleUid: R.uid, channels: [], consume: true, watchPresence: false, registerPresence: false, watchChannels: false,
      card: { id: R.id.id, name: "stock", kind: "agent" },
      onConnection: (nc) => {
        const request = nc.request.bind(nc);
        nc.request = (subject, payload, opts) => {
          sent.push(subject);
          const reply = request(subject, payload, opts);
          reply.catch((e: Error) => {
            const cause = (e as { cause?: unknown }).cause;
            if (firstDenial === undefined && cause instanceof PermissionViolationError && cause.operation === "publish") firstDenial = cause.subject;
          });
          return reply;
        };
      },
    }));
    const outcome = await within(ep.start().then(() => "started", () => "rejected"), 15000);
    const known: Record<string, string> = { "$JS.API.INFO": "jsm-account-info", [`$JS.API.STREAM.INFO.KV_${channelBucket(space)}`]: "registry-stream-info" };
    const cls = firstDenial === undefined ? "none" : (known[firstDenial] ?? "unexpected-subject");
    const before = sent.slice(0, firstDenial === undefined ? sent.length : sent.indexOf(firstDenial));
    check("P2c.stock-blocked: stock consume:true still refuses the narrow credential before any dm_ request",
      outcome === "rejected" && (cls === "jsm-account-info" || cls === "registry-stream-info") && !before.some((s) => s.includes(R.durable)),
      { outcome, firstDenial: cls });
    await ep.stop().catch(() => {});
  }

  // ---- P2: the same credential in DM-only mode -------------------------------------------------
  {
    const got: CotalMessage[] = [];
    const ep = own(new CotalEndpoint(dmOnlyOpts(R, R.narrow, { handler: (m, d) => { got.push(m); d.ack(); } })));
    const started = await within(ep.start().then(() => "started", (e) => `rejected:${errClass(e)}`), 10000);
    check("P2.start: dmOnly starts with the narrow credential", started === "started", { started });
    await sender.unicast(R.key, "p2");
    for (let i = 0; i < 50 && got.length === 0; i++) await sleep(100);
    check("P2.recv: the DM reaches the handler with the authenticated sender", got.length >= 1 && got.some((m) => textOf(m) === "p2" && m.from.id === sKey), { count: got.length });
    await sleep(300);
    const after = await pending(rJsm, R.durable);
    check("P2.acked: nothing is left pending or unacked", after.pending === 0 && after.ackPending === 0, after);
    await ep.stop();
  }

  // ---- U1: renewal through a creds source, then a drained stop --------------------------------
  {
    const U = await recipient();
    const uJsm = await provAgentJsm(U.agentCreds, U.id);
    let fetches = 0;
    const source = async () => { fetches++; return narrowCreds(U.id, U.durable, 4); };
    const got: string[] = [];
    const ep = own(new CotalEndpoint(dmOnlyOpts(U, source, { handler: (m, d) => { got.push(textOf(m)); d.ack(); } })));
    await ep.start();
    check("U1.start: a sourced narrow credential starts dmOnly", fetches >= 1);
    await sender.unicast(U.key, "u1-a");
    for (let i = 0; i < 50 && got.length < 1; i++) await sleep(100);
    await sleep(5000); // past the 4s credential: 75% renewal, proven, then the resident swap
    await sender.unicast(U.key, "u1-b");
    for (let i = 0; i < 50 && got.length < 2; i++) await sleep(100);
    check("U1.renew: the credential renewed through the stock source", fetches >= 2, { fetches });
    check("U1.after-renew: a DM sent after the first credential expired is still handled", got.includes("u1-a") && got.includes("u1-b"), { count: got.length });
    const stopped = await within(ep.stop().then(() => "ok", (e) => errClass(e)), 10000);
    check("U1.stop: stop resolves", stopped === "ok", { stopped });
    const after = await pending(uJsm, U.durable);
    check("U1.drained: no copy left pending or unacked after stop", after.pending === 0 && after.ackPending === 0, after);
  }

  // ---- U2: authenticity guard before any handler ------------------------------------------------
  {
    const G = await recipient();
    const gJsm = await provAgentJsm(G.agentCreds, G.id);
    const seen: string[] = [];
    const ep = own(new CotalEndpoint(dmOnlyOpts(G, G.narrow, { handler: (m, d) => { seen.push(textOf(m)); d.ack(); } })));
    await ep.start();
    const subj = unicastSubject(space, DEV_OWNER, G.id.id, DEV_OWNER, sId.id);
    const js = jetstream(senderNc, { checkAPI: false });
    await js.publish(subj, JSON.stringify({ id: "spoof-1", ts: Date.now(), space, from: { id: `${DEV_OWNER}.someone-else`, name: "x" }, to: G.key, parts: [{ kind: "text", text: "spoof" }] }));
    await js.publish(subj, JSON.stringify({ ts: Date.now(), space, from: { id: sKey, name: "s" }, to: G.key, parts: [{ kind: "text", text: "no-id" }] }));
    await sender.unicast(G.key, "genuine");
    for (let i = 0; i < 50 && !seen.includes("genuine"); i++) await sleep(100);
    await sleep(300);
    check("U2.spoof: a payload from that is not the subject sender never reaches the handler", !seen.includes("spoof"), { seen: seen.length });
    check("U2.no-id: an id-less envelope never reaches the handler", !seen.includes("no-id"));
    check("U2.genuine: the authenticated DM after them still arrives", seen.includes("genuine"));
    const after = await pending(gJsm, G.durable);
    check("U2.termed: rejected copies are terminated, not left pending", after.pending === 0 && after.ackPending === 0, after);
    await ep.stop();
  }

  // ---- U3: typed refusals, each with a positive bind --------------------------------------------
  {
    const M = { id: newIdentity(), uid: mintLifecycleUid() };
    const mDurable = dmDurable(DEV_OWNER, M.id.id, M.uid);
    const mCreds = await narrowCreds(M.id, mDurable);
    const ep = own(new CotalEndpoint(dmOnlyOpts(M, mCreds, { handler: () => {} })));
    const missing = await ep.start().then(() => "started", (e) => e);
    check("U3.missing: an absent dm_ refuses with dm-durable-missing", missing instanceof DmDurableMissingError && missing.code === "dm-durable-missing", { class: errClass(missing) });
    await ep.stop().catch(() => {});
    const provJsm = await jetstreamManager(await ownConn(provCreds, provId.id), { checkAPI: false });
    const absent = await provJsm.consumers.info(DM, mDurable).then(() => "present", (e) => (isConsumerNotFound(e) ? "absent" : errClass(e)));
    const control = await provJsm.consumers.info(DM, R.durable).then(() => "present", (e) => errClass(e));
    check("U3.not-created: the refused start created no durable (provisioner reads an existing one)", absent === "absent" && control === "present", { absent, control });
    const D = await recipient();
    const wrongCreds = await narrowCreds(D.id, `${D.durable}x`); // rows name another durable
    const ep2 = own(new CotalEndpoint(dmOnlyOpts(D, wrongCreds, { handler: () => {} })));
    const denied = await ep2.start().then(() => "started", (e) => e);
    check("U3.denied: a refused bind is dm-bind-refused", denied instanceof DmBindRefusedError && denied.code === "dm-bind-refused", { class: errClass(denied) });
    await ep2.stop().catch(() => {});
    const ep3 = own(new CotalEndpoint(dmOnlyOpts(D, D.narrow, { handler: () => {} })));
    const ok = await ep3.start().then(() => "started", (e) => errClass(e));
    check("U3.positive: the same principal with its own rows binds", ok === "started", { ok });
    await ep3.stop();
  }

  // ---- U4: wire census over start, reconnect and stop -------------------------------------------
  {
    const W = await recipient();
    const sent: string[] = [];
    const got: string[] = [];
    const ep = own(new CotalEndpoint(dmOnlyOpts(W, W.narrow, { handler: (m, d) => { got.push(textOf(m)); d.ack(); } }, { onConnection: census(sent) })));
    await ep.start();
    await sender.unicast(W.key, "w1");
    for (let i = 0; i < 50 && got.length < 1; i++) await sleep(100);
    await ep.reconnect();
    await sender.unicast(W.key, "w2");
    for (let i = 0; i < 50 && got.length < 2; i++) await sleep(100);
    await ep.stop();
    const allowed = (s: string) =>
      s === `$JS.API.CONSUMER.INFO.${DM}.${W.durable}` || s === `$JS.API.CONSUMER.MSG.NEXT.${DM}.${W.durable}` || s.startsWith(`$JS.ACK.${DM}.${W.durable}.`);
    const extra = [...new Set(sent.filter((s) => !allowed(s)))];
    check("U4.handled: DMs before and after a reconnect are handled", got.includes("w1") && got.includes("w2"), { count: got.length });
    check("U4.census: every native request is a dm_ INFO, NEXT or ACK row", sent.length > 0 && extra.length === 0, { requests: sent.length, extraClasses: extra.length });
    check("U4.no-js-info: no $JS.API.INFO, stream, KV or registry request", !sent.some((s) => s === "$JS.API.INFO" || s.includes(".STREAM.") || s.includes("KV_")));
  }

  // ---- S: serial handler --------------------------------------------------------------------------
  {
    const Sx = await recipient();
    const sJsm = await provAgentJsm(Sx.agentCreds, Sx.id);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const ep = own(new CotalEndpoint(dmOnlyOpts(Sx, Sx.narrow, {
      handler: async (m, d) => {
        const t = textOf(m);
        order.push(`start:${t}`);
        if (t === "boom") { order.push("end:boom"); throw new Error("handler refused"); }
        if (first) { first = false; await gate; }
        order.push(`end:${t}`);
        d.ack();
      },
    })));
    await ep.start();
    await sender.unicast(Sx.key, "s1");
    await sender.unicast(Sx.key, "s2");
    await sleep(1500);
    check("S.serial: the second DM waits while the first handler runs", order.join(",") === "start:s1", { steps: order.length });
    release();
    for (let i = 0; i < 50 && !order.includes("end:s2"); i++) await sleep(100);
    check("S.order: the second handler starts only after the first settles", order.indexOf("end:s1") >= 0 && order.indexOf("end:s1") < order.indexOf("start:s2"));
    await sender.unicast(Sx.key, "boom");
    await sender.unicast(Sx.key, "s3");
    for (let i = 0; i < 50 && !order.includes("end:s3"); i++) await sleep(100);
    check("S.reject-continues: after a rejecting handler the next DM is still handled", order.includes("end:boom") && order.includes("end:s3"));
    const after = await pending(sJsm, Sx.durable);
    check("S.reject-unacked: the rejected copy is left for redelivery", after.ackPending + after.pending >= 1, after);
    await ep.stop();
  }

  // ---- C: stop custody ----------------------------------------------------------------------------
  {
    const Cx = await recipient();
    const cJsm = await provAgentJsm(Cx.agentCreds, Cx.id);
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => { entered = r; });
    let finishHandler!: () => void;
    const handlerGate = new Promise<void>((r) => { finishHandler = r; });
    const ep = own(new CotalEndpoint(dmOnlyOpts(Cx, Cx.narrow, { handler: async (_m, d) => { entered(); await handlerGate; await sleep(200); d.ack(); } })));
    await ep.start();
    await sender.unicast(Cx.key, "c1");
    await within(inHandler, 5000);
    let stopDone = false;
    const stopping = ep.stop().then(() => { stopDone = true; return "ok"; }, (e) => errClass(e));
    await sleep(500);
    check("C.waits: stop does not resolve while the handler runs", !stopDone);
    finishHandler();
    const res = await within(stopping, 10000);
    check("C.settled: stop resolves after the handler settles", res === "ok", { res });
    const after = await pending(cJsm, Cx.durable);
    check("C.ack-landed: the handler's ack reached the broker before close", after.pending === 0 && after.ackPending === 0, after);

    const Hx = await recipient();
    const hJsm = await provAgentJsm(Hx.agentCreds, Hx.id);
    let hEntered!: () => void;
    const hIn = new Promise<void>((r) => { hEntered = r; });
    const hung = own(new CotalEndpoint(dmOnlyOpts(Hx, Hx.narrow, { handler: () => { hEntered(); return new Promise<void>(() => {}); }, settleTimeoutMs: 1000 })));
    await hung.start();
    await sender.unicast(Hx.key, "h1");
    await within(hIn, 5000);
    const hres = await within(hung.stop().then(() => "ok", (e) => e), 10000);
    check("C.unsettled-throws: stop throws when the handler never settles", hres instanceof Error && /did not settle/.test(hres.message), { class: errClass(hres) });
    const hAfter = await pending(hJsm, Hx.durable);
    check("C.unsettled-retained: the unsettled copy stays unacked", hAfter.ackPending + hAfter.pending >= 1, hAfter);
    ownedEndpoints.splice(ownedEndpoints.indexOf(hung), 1); // its stop is proven (connection closed, throw is the contract)
  }

  // ---- option refusals, each paired with the accepted shape -------------------------------------
  {
    const base = dmOnlyOpts({ id: R.id, uid: R.uid }, R.narrow, { handler: () => {} });
    const refused = (extra: Partial<EndpointOptions>) => { try { new CotalEndpoint({ ...base, ...extra }); return false; } catch { return true; } };
    check("O.accepts: the documented shape constructs", !refused({}));
    check("O.refuses-presence", refused({ registerPresence: true }));
    check("O.refuses-channels", refused({ channels: ["general"] }));
    check("O.refuses-role", refused({ card: { ...base.card, role: "worker" } }));
    check("O.refuses-open-mode", refused({ creds: undefined }));
    check("O.refuses-consume-false", refused({ consume: false }));
  }
} catch (e) {
  check(`harness: unexpected ${errClass(e)}`, false);
} finally {
  let unknown = 0;
  for (const ep of ownedEndpoints.reverse()) {
    const s = await within(ep.stop().then(() => "ok", () => "threw"), 10000);
    if (s !== "ok") unknown++;
  }
  for (const nc of ownedConns) {
    if (!nc.isClosed()) await within(nc.close().catch(() => {}), 5000);
    if ((await within(nc.closed().then(() => "closed"), 5000)) !== "closed") unknown++;
  }
  if (broker) {
    await killAndAwaitExit(broker);
    if (broker.exitCode === null && broker.signalCode === null) unknown++;
  }
  if (unknown === 0) {
    rmSync(dir, { recursive: true, force: true });
    releaseBroker?.();
    releasePath();
  }
  check("custody: endpoints stopped, connections closed, broker exited, store removed", unknown === 0, { unknown });
  finish();
}

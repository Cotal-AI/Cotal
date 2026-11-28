/**
 * Read-ACL containment smoke (channel-read-acl) — the broker boundary, verified at runtime.
 *
 * Spins up its OWN JWT-auth nats-server and proves that a scoped "agent" cred CANNOT read past its
 * `allowSubscribe`, by exercising the exact JetStream API surface the history reads ride:
 *
 *   A. CAN create a single-filter history consumer on an ALLOWED channel (the granted EX subject).
 *   B. CANNOT smuggle a forbidden filter past the ACL: a create on the allowed EX subject but with a
 *      DIFFERENT `filter_subject` in the body is rejected by nats-server itself
 *      (JSConsumerCreateFilterSubjectMismatchErr, code 10131). ← the load-bearing guarantee.
 *   C. CANNOT create a history consumer on a FORBIDDEN channel (no grant for that EX subject).
 *   D. CANNOT use the bare, filter-less create subject (the multi-filter escape hatch).
 *   E. CANNOT Direct-Get the CHAT stream (the removed unfiltered read hole).
 *   F. CANNOT create an arbitrary CHAT consumer name (only the pinned history name is granted).
 *   J. The production page API uses that exact grant, including occupied-name and stale-owner cases.
 *
 * If a future nats-server / nats.js upgrade ever stops enforcing B, this smoke fails loud — the
 * whole read boundary rests on it. Run: pnpm smoke:read-acl:auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, StorageType } from "@nats-io/jetstream";
import { decode, encodeAccount, encodeUser, type Account } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { PLUGIN_CHANNEL_ROOT, pluginChannelFilter, pluginChannelStream, pluginChannelSubject } from "../src/plugin-channel-route.js";
import {
  isReachable,
  CotalEndpoint,
  partsToText,
  createSpaceAuth,
  credsClaims,
  credsFromJwt,
  mintCreds,
  provisionAgent,
  pushAccountClaim,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  chatStream,
  dmStream,
  taskStream,
  dlvStream,
  epcStreamName,
  chatSubject,
  chatDurable,
  chatHistDurable,
  mintLifecycleUid,
  membershipInAllow,
  DEV_OWNER,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
const enc = (s: string) => new TextEncoder().encode(s);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `read-acl-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
  accountResolver: { kind: "full", directory: join(dir, "resolver"), limit: 10, intervalMs: 120_000 },
}));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const CHAT = chatStream(space);
const allowedFilter = chatSubject(space, "*", "*", "allowed"); // cotal.<space>.chat.*.*.allowed
const forbiddenFilter = chatSubject(space, "*", "*", "secret"); // never in allowSubscribe

/** Send a JetStream API request and classify the outcome. For a JS API subject there is always a
 *  responder WHEN the publish is permitted, so: "ok"/"jserror" ⇒ the publish passed the ACL and the
 *  server processed it; "blocked" ⇒ the publish was denied (perm violation or dropped → no reply). */
async function jsApi(
  nc: NatsConnection,
  subject: string,
  body: unknown,
): Promise<{ kind: "ok"; data: any } | { kind: "jserror"; err: any } | { kind: "blocked" }> {
  try {
    const m = await nc.request(subject, enc(JSON.stringify(body)), { timeout: 1500 });
    const r = m.json<any>();
    return r?.error ? { kind: "jserror", err: r.error } : { kind: "ok", data: r };
  } catch {
    return { kind: "blocked" }; // permission violation or no reply (publish dropped)
  }
}

async function checkPluginGrants(): Promise<void> {
  const stream = pluginChannelStream(space);
  const scope = `${PLUGIN_CHANNEL_ROOT}.linear.>`;
  const exact = `${PLUGIN_CHANNEL_ROOT}.linear.one`;
  const second = `${PLUGIN_CHANNEL_ROOT}.linear.two`;
  const foreign = `${PLUGIN_CHANNEL_ROOT}.other.one`;
  const clients: NatsConnection[] = [];
  const dial = async (profile: "agent" | "provisioner", read: string[], post: string[], enabled: boolean) => {
    const id = newIdentity(), uid = mintLifecycleUid();
    const creds = await mintCreds(auth, id, profile, { allowSubscribe: read, allowPublish: post, lifecycleUid: uid, pluginChannelsEnabled: enabled });
    const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(creds)), inboxPrefix: `_INBOX_${id.id}`, reconnect: false });
    clients.push(nc);
    return { nc, id: id.id, history: chatHistDurable(DEV_OWNER, id.id, uid) };
  };
  const publishProbe = async (nc: NatsConnection, subject: string) =>
    jetstream(nc, { timeout: 800 }).publish(subject, enc("plugin boundary")).then(ack => ack.stream, (error: unknown) => {
      if (/permission/i.test(String(error))) return undefined;
      throw error;
    });
  const nativeRead = async (nc: NatsConnection, filter: string, send: () => Promise<unknown>) => {
    let denied = false;
    const received: string[] = [];
    let listening = true;
    void (async () => {
      for await (const status of nc.status()) {
        if (!listening) break;
        const event = JSON.stringify(status);
        if (/permission/i.test(event) && event.includes(filter)) denied = true;
      }
    })().catch(() => {});
    const sub = nc.subscribe(filter, { callback: (err, message) => {
      if (err) denied = /permission/i.test(err.message);
      else received.push(message.subject);
    } });
    await nc.flush();
    await send();
    for (let i = 0; i < 20 && !denied && received.length === 0; i++) await wait(20);
    await nc.flush();
    sub.unsubscribe();
    listening = false;
    return { denied, received };
  };
  const readFilter = (channel: string) => pluginChannelSubject(space, "*", "*", channel);
  const create = (reader: Awaited<ReturnType<typeof dial>>, subjectFilter: string, bodyFilter = subjectFilter, name = reader.history) =>
    jsApi(reader.nc, `$JS.API.CONSUMER.CREATE.${stream}.${name}.${subjectFilter}`, {
      stream_name: stream, config: { name, filter_subject: bodyFilter, ack_policy: "none", deliver_policy: "all", inactive_threshold: 10_000_000_000 }, action: "create",
    });
  try {
    const admin = await dial("provisioner", [], [], true);
    await (await jetstreamManager(admin.nc)).streams.add({ name: stream, subjects: [pluginChannelFilter(space)], storage: StorageType.Memory });
    const broad = await dial("agent", [">"], [">"], true);
    const legacy = await dial("agent", [">"], [">"], false);
    const writer = await dial("agent", [scope], [scope], true);
    const narrow = await dial("agent", [exact], [exact], true);
    const send = (ch: string) => publishProbe(writer.nc, pluginChannelSubject(space, DEV_OWNER, writer.id, ch));

    check("routed provisioner can track the canonical history stream", (await (await jetstreamManager(admin.nc)).streams.info(stream)).config.name === stream);
    check("dark mint can still publish a reserved name as ordinary chat", await publishProbe(legacy.nc, chatSubject(space, DEV_OWNER, legacy.id, exact)) === CHAT);
    check("dark mint has no plugin rail even under its broad post grant", !(await publishProbe(legacy.nc, pluginChannelSubject(space, DEV_OWNER, legacy.id, exact))));
    check("enabled broad chat grant still publishes ordinary chat", await publishProbe(broad.nc, chatSubject(space, DEV_OWNER, broad.id, "allowed")) === CHAT);
    check("enabled broad chat grant cannot publish to the legacy reserved subtree", !(await publishProbe(broad.nc, chatSubject(space, DEV_OWNER, broad.id, exact))));
    check("enabled broad chat grant cannot publish to the bare reserved root", !(await publishProbe(broad.nc, chatSubject(space, DEV_OWNER, broad.id, PLUGIN_CHANNEL_ROOT))));
    check("enabled broad chat grant cannot publish to the plugin rail", !(await publishProbe(broad.nc, pluginChannelSubject(space, DEV_OWNER, broad.id, exact))));
    const escaped = await nativeRead(broad.nc, readFilter(exact), () => send(exact));
    check("enabled broad chat grant is refused a plugin subscription", escaped.denied && escaped.received.length === 0, escaped);
    const crossed = await nativeRead(broad.nc, chatSubject(space, "*", "*", exact), () => publishProbe(legacy.nc, chatSubject(space, DEV_OWNER, legacy.id, exact)));
    check("enabled broad chat grant is refused a legacy reserved subscription", crossed.denied && crossed.received.length === 0, crossed);
    const ordinarySubject = chatSubject(space, DEV_OWNER, legacy.id, "allowed");
    const ordinary = await nativeRead(broad.nc, chatSubject(space, "*", "*", ">"), async () => {
      await publishProbe(legacy.nc, chatSubject(space, DEV_OWNER, legacy.id, exact));
      await publishProbe(legacy.nc, ordinarySubject);
    });
    check("the enabled root wildcard receives ordinary chat but not reserved chat", !ordinary.denied && ordinary.received.join() === ordinarySubject, ordinary);
    const exactRead = await nativeRead(narrow.nc, readFilter(exact), () => send(exact));
    check("an exact plugin read grant receives a post from another allowed agent", exactRead.received.length === 1 && !exactRead.denied, exactRead);
    const subtreeRead = await nativeRead(writer.nc, readFilter(scope), () => publishProbe(narrow.nc, pluginChannelSubject(space, DEV_OWNER, narrow.id, exact)));
    check("a plugin subtree grant receives posts on its own plugin", subtreeRead.received.length === 1 && !subtreeRead.denied, subtreeRead);
    check("the subtree grant can publish to a second resource", await send(second) === stream);
    check("the subtree grant cannot publish outside its plugin", !(await send(foreign)));
    check("the exact grant cannot publish to a sibling resource", !(await publishProbe(narrow.nc, pluginChannelSubject(space, DEV_OWNER, narrow.id, second))));
    check("the plugin grant cannot publish under another sender", !(await publishProbe(writer.nc, pluginChannelSubject(space, DEV_OWNER, narrow.id, exact))));

    const denied = await create(broad, readFilter(exact));
    check("a broad chat grant cannot create a plugin history reader", denied.kind === "blocked", denied);
    const legacyFilter = chatSubject(space, "*", "*", exact);
    const retiredHistory = await jsApi(broad.nc, `$JS.API.CONSUMER.CREATE.${CHAT}.${broad.history}.${legacyFilter}`, {
      stream_name: CHAT, config: { name: broad.history, filter_subject: legacyFilter, ack_policy: "none", deliver_policy: "all", inactive_threshold: 1_000_000_000 }, action: "create",
    });
    check("a routed broad grant cannot create an exact legacy reader under the reserved root", retiredHistory.kind === "blocked", retiredHistory);
    check("the same chat grant does not admit a plugin durable join", !membershipInAllow([">"], exact, true) && !membershipInAllow([">"], scope, true));
    check("only the explicit plugin subtree admits the concrete and family joins", membershipInAllow([scope], exact, true)
      && membershipInAllow([scope], scope, true) && !membershipInAllow([scope], foreign, true)
      && !membershipInAllow([`${PLUGIN_CHANNEL_ROOT}.>`], exact, true));
    const held = await create(narrow, readFilter(exact));
    check("an exact plugin grant creates its own filtered history reader", held.kind === "ok", held);
    if (held.kind === "ok") {
      const jsm = await jetstreamManager(narrow.nc);
      const info = await jsm.consumers.info(stream, narrow.history);
      check("the broker holds the exact filter on the caller's history reader", info.config.filter_subject === readFilter(exact), info.config);
      const consumer = await jetstream(narrow.nc).consumers.get(stream, narrow.history);
      const retained = await consumer.next({ expires: 1500 });
      check("the history reader can fetch a retained message on its admitted filter", info.num_pending > 0 && [writer.id, narrow.id]
        .some(actor => retained?.subject === pluginChannelSubject(space, DEV_OWNER, actor, exact)), { pending: info.num_pending, subject: retained?.subject });
      await jsm.consumers.delete(stream, narrow.history);
    }
    const multi = await jsApi(writer.nc, `$JS.API.CONSUMER.CREATE.${stream}`, {
      stream_name: stream, config: { name: writer.history, filter_subjects: [readFilter(exact), readFilter(foreign)], ack_policy: "none", deliver_policy: "all" }, action: "create",
    });
    check("plugin history authority does not allow a bare multi-filter create", multi.kind === "blocked", multi);
    const foreignReader = await create(writer, readFilter(exact), readFilter(exact), narrow.history);
    check("a plugin history grant cannot name another lifecycle's reader", foreignReader.kind === "blocked", foreignReader);
    const mismatch = await create(writer, readFilter(exact), readFilter(foreign));
    check("the broker rejects a body filter that differs from the allowed create subject", mismatch.kind === "jserror" && mismatch.err?.err_code === 10131, mismatch);
    const other = await create(writer, readFilter(foreign));
    check("one plugin grant cannot create history for another plugin", other.kind === "blocked", other);
    const frontier = await jsApi(writer.nc, `$JS.API.STREAM.INFO.${stream}`, {});
    check("plugin history scope does not grant whole-stream metadata", frontier.kind === "blocked", frontier);
  } finally {
    for (const nc of clients) await nc.close();
  }
}

async function checkLegacyAccountFence(): Promise<void> {
  const legacy = newIdentity(), lifecycleUid = mintLifecycleUid();
  const reserved = `${PLUGIN_CHANNEL_ROOT}.linear.fence`;
  const old = await mintCreds(auth, legacy, "agent", { lifecycleUid, allowPublish: [">"] });
  const dial = (creds: string, id: string) => connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(creds)),
    inboxPrefix: `_INBOX_${id}`, reconnect: false, timeout: 2000 });
  const before = await dial(old, legacy.id);
  let system: NatsConnection | undefined;
  try {
    const subject = chatSubject(space, DEV_OWNER, legacy.id, reserved);
    const post = await jetstream(before).publish(subject, enc("legacy fence control"));
    check("a pre-cutover static credential can publish on the legacy rail before the fence", post.stream === CHAT);
    const systemId = newIdentity();
    const sysJwt = await encodeUser("plugin-cutover-test", fromPublic(systemId.id), fromPublic(auth.sys.pub), {
      pub: { allow: [`$SYS.REQ.ACCOUNT.${auth.account.pub}.CLAIMS.UPDATE`] }, sub: { allow: [`_INBOX_${systemId.id}.>`] },
    }, { signer: fromSeed(enc(auth.sys.signingSeed!)) });
    system = await dial(credsFromJwt(sysJwt, systemId), systemId.id);
    await wait(1100);
    const cutoff = Math.floor(Date.now() / 1000);
    check("the test cutoff succeeds the legacy credential's issuance timestamp", cutoff > credsClaims(old).iat!);
    const claim = decode<Account>(auth.account.jwt);
    const signer = fromSeed(enc(auth.operator.seed));
    let fenced: string;
    try {
      fenced = await encodeAccount(claim.name, fromPublic(auth.account.pub), { ...claim.nats, revocations: { "*": cutoff } }, { signer });
    } finally { signer.clear(); }
    await pushAccountClaim(system, { accountJwt: fenced, expectedServerIds: [system.info!.server_id], maxWaitMs: 3000 });
    for (let i = 0; i < 50 && !before.isClosed(); i++) await wait(20);
    check("the broker closes the still-live pre-cutover connection", before.isClosed());
    const denied = await dial(old, legacy.id).then(async nc => { await nc.close(); return false; },
      error => /authorization|authentication|revok/i.test(String(error)));
    check("the broker cutoff rejects the old static credential before it can reach the legacy rail", denied);
    if (Math.floor(Date.now() / 1000) === cutoff) await wait(1100);
    const current = newIdentity();
    const fresh = await dial(await mintCreds(auth, current, "agent", { lifecycleUid: mintLifecycleUid(), allowPublish: [">"], pluginChannelsEnabled: true }), current.id);
    try {
      const post = await jetstream(fresh).publish(chatSubject(space, DEV_OWNER, current.id, "allowed"), enc("post-fence control"));
      check("a freshly minted routed chat credential still publishes ordinary chat after the fence", post.stream === CHAT);
    } finally { await fresh.close(); }
  } finally { await Promise.all([system?.close(), before.close()]); }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // Manager seeds a couple of messages on #allowed (so the positive read has something to find).
  const mgr = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(mgrCreds)) });
  await mgr.publish(chatSubject(space, DEV_OWNER, "MGR", "allowed"), enc("hi"));
  await mgr.publish(chatSubject(space, DEV_OWNER, "MGR", "secret"), enc("classified"));
  await mgr.flush();

  // A scoped agent: read ACL = ["allowed"] only. The stub provisioner skips durable pre-create —
  // we only need the cred's grants, which is what nats-server enforces.
  const noop = { commitAcl: async () => {}, reissueAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };
  const id = newIdentity();
  const uid = mintLifecycleUid();
  const agentCreds = await provisionAgent(noop, auth, id, { subscribe: ["allowed"], allowSubscribe: ["allowed", "other", "quiet"], allowPublish: ["allowed"], lifecycleUid: uid });
  const chatHistD = chatHistDurable(DEV_OWNER, id.id, uid);
  const ag = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(enc(agentCreds)),
    inboxPrefix: `_INBOX_${id.id}`, // the agent's sub.allow is _INBOX_<id>.>
    maxReconnectAttempts: 0,
  });

  const cfg = (filter: string) => ({
    stream_name: CHAT,
    config: { name: chatHistD, filter_subject: filter, ack_policy: "none", deliver_policy: "all", inactive_threshold: 1_000_000_000 },
    action: "create",
  });

  // A — allowed channel, body filter matches the subject filter ⇒ created.
  const a = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${allowedFilter}`, cfg(allowedFilter));
  check("A: history consumer on ALLOWED channel is created", a.kind === "ok", a);
  if (a.kind === "ok") await jsApi(ag, `$JS.API.CONSUMER.DELETE.${CHAT}.${chatHistD}`, {}); // cleanup

  // B — body≠subject: allowed EX subject, but a FORBIDDEN filter in the body. nats-server must
  // reject with the filtered-subject-mismatch error (10131). THE load-bearing guarantee.
  const b = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${allowedFilter}`, cfg(forbiddenFilter));
  const mism =
    b.kind === "jserror" &&
    (b.err?.err_code === 10131 || /filtered subject|create subject/i.test(String(b.err?.description ?? "")));
  check("B: body filter ≠ subject filter is REJECTED by nats-server (err 10131)", mism, b);

  // C — forbidden channel's own EX subject: no grant ⇒ publish blocked.
  const c = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${forbiddenFilter}`, cfg(forbiddenFilter));
  check("C: history consumer on a FORBIDDEN channel is blocked", c.kind === "blocked", c);

  // D — bare, filter-less create subject (the multi-filter escape hatch): no grant ⇒ blocked.
  const d = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}`, cfg(forbiddenFilter));
  check("D: bare filter-less create is blocked", d.kind === "blocked", d);

  // E — Direct Get on CHAT (the removed unfiltered read hole): no grant ⇒ blocked.
  const e = await jsApi(ag, `$JS.API.DIRECT.GET.${CHAT}`, { seq: 1 });
  check("E: Direct Get on CHAT is blocked (read hole removed)", e.kind === "blocked", e);

  // F — an agent holds no live-tail consumer create (the live read is a core subscription).
  // Probe it by trying to create a CHAT-stream consumer (using the removed chat_<id> name + a forbidden
  // filter) — blocked, so an agent can never stand up its own CHAT reader to self-widen its read.
  const f = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}.${chatDurable(DEV_OWNER, id.id)}`, {
    stream_name: CHAT,
    config: { durable_name: chatDurable(DEV_OWNER, id.id), filter_subjects: [forbiddenFilter], ack_policy: "explicit" },
    action: "create",
  });
  check("F: an agent cannot create a CHAT-stream consumer (no grant — probed via the removed chat_<id> name)", f.kind === "blocked", f);

  // G — this agent carries NO role, and a role-less agent gets no stream-level read on any per-peer
  // stream. It reaches DM and DLV through a pre-created durable by name and EPC through a
  // subject-scoped DIRECT.GET, so none of them needs INFO; TASK it has no grant on at all, because
  // `STREAM.INFO.TASK` rides the same `if (svcD)` role gate as the svc_<role> bind rows (the
  // role-carrying side of that gate is proven in provision-stream-info.smoke.ts). Granting INFO on
  // any of these would leak DM-inbox, task, and delivery subject metadata across peers:
  // `subjects_filter` is a request-body field, so no ACL can narrow INFO to counts alone. CHAT
  // STREAM.INFO IS granted (a documented metadata surface, SPEC §9).
  const gdm = await jsApi(ag, `$JS.API.STREAM.INFO.${dmStream(space)}`, {});
  check("G1: STREAM.INFO on DM is blocked (no DM metadata leak)", gdm.kind === "blocked", gdm);
  const gtask = await jsApi(ag, `$JS.API.STREAM.INFO.${taskStream(space)}`, {});
  check("G2: STREAM.INFO on TASK is blocked", gtask.kind === "blocked", gtask);
  const gdlv = await jsApi(ag, `$JS.API.STREAM.INFO.${dlvStream(space)}`, {});
  check("G3: STREAM.INFO on DLV is blocked (no delivery metadata leak)", gdlv.kind === "blocked", gdlv);
  const gepc = await jsApi(ag, `$JS.API.STREAM.INFO.${epcStreamName(space)}`, {});
  check("G4: STREAM.INFO on EPC is blocked", gepc.kind === "blocked", gepc);

  // H — direct message-body read on CHAT (STREAM.MSG.GET) is NOT granted: history must ride the
  // ACL-bounded ephemeral consumers, never a raw per-seq fetch.
  const h = await jsApi(ag, `$JS.API.STREAM.MSG.GET.${CHAT}`, { seq: 1 });
  check("H: STREAM.MSG.GET on CHAT is blocked (no raw message read)", h.kind === "blocked", h);

  // I — channel-token aliasing is rejected before any grant is minted: a policy channel the wire
  // layer would rewrite (foo/bar → foo_bar) must fail loud, or the grant would alias the ACL.
  let aliasRejected = false;
  try {
    await provisionAgent(noop, auth, newIdentity(), { subscribe: ["foo/bar"], allowSubscribe: ["foo/bar"], lifecycleUid: mintLifecycleUid() });
  } catch {
    aliasRejected = true;
  }
  check("I: non-NATS-safe channel (foo/bar) is rejected at provision (no ACL alias)", aliasRejected);

  // The public one-shot reader must reach the same confined native create, not an observer
  // consumer or an ACL row seeded by this fixture. Separate endpoints model separate CLI processes.
  const readers: CotalEndpoint[] = [];
  const reader = async (lifecycleUid = uid) => {
    const ep = new CotalEndpoint({ space, servers: SERVERS, creds: agentCreds, lifecycleUid,
      card: { name: "page-reader", id: id.id, kind: "endpoint" }, channels: [], consume: false,
      registerPresence: false, watchPresence: false });
    ep.on("error", () => {});
    await ep.start();
    readers.push(ep);
    return ep;
  };
  try {
    const exercise = async () => {
      const one = await reader();
      const two = await reader();
      for (let i = 0; i < 5; i++) await one.multicast(`own ${i}`, { channel: "allowed" });
      const page = await one.channelHistoryPage("allowed", { limit: 2 }).catch((e: Error) => e);
      check("J1: public channel page reaches the scoped consumer and keeps the newest own sends oldest first",
        !(page instanceof Error) && JSON.stringify(page.items.map((m) => partsToText(m.parts))) === JSON.stringify(["own 3", "own 4"]) && page.complete === false, page);
      if (page instanceof Error) return; // keep an authority regression a named red, not a later hang
      let deniedPage = false;
      try { await one.channelHistoryPage("secret"); } catch (e) { deniedPage = /permission/i.test((e as Error).message); }
      check("J2: public channel page refuses a forbidden channel rather than returning empty", deniedPage);
      let badUid = false;
      const foreign = await reader(mintLifecycleUid());
      try { await foreign.channelHistoryPage("allowed"); } catch (e) { badUid = /permission/i.test((e as Error).message); }
      check("J3: public channel page cannot read through a foreign lifecycle consumer name", badUid);

      // Occupy the fixed name with a reader this test owns. Wait for the production call to observe
      // the collision, then abort it: cancellation must not delete/update this owner's consumer.
      const { jetstreamManager } = await import("@nats-io/jetstream");
      const api = await jetstreamManager(ag);
      const occupy = async (marker: string) => {
        const end = Date.now() + 6000;
        for (;;) {
          try { return await api.consumers.add(CHAT, { name: chatHistD, description: marker,
            filter_subject: allowedFilter, ack_policy: "none", deliver_policy: "all",
            mem_storage: true, inactive_threshold: 30_000_000_000 }); }
          catch (e) { if (!/already exists/i.test((e as Error).message) || Date.now() >= end) throw e; await wait(25); }
        }
      };
      const occupant = await occupy("test-owner");
      const internals = one as unknown as { conn: { jsm: import("@nats-io/jetstream").JetStreamManager; js: import("@nats-io/jetstream").JetStreamClient } };
      const originalAdd = internals.conn.jsm.consumers.add.bind(internals.conn.jsm.consumers);
      let observedCollision!: () => void;
      const collision = new Promise<void>((resolve) => { observedCollision = resolve; });
      internals.conn.jsm.consumers.add = async (...args) => {
        try { return await originalAdd(...args); }
        catch (e) { observedCollision(); throw e; }
      };
      const abort = new AbortController();
      const blocked = one.channelHistoryPage("allowed", { signal: abort.signal }).then(() => "succeeded",
        (e: Error) => e === abort.signal.reason || e.cause === abort.signal.reason ? "cancel occupied read" : e.message);
      const collided = await Promise.race([collision.then(() => true), blocked.then(() => false)]);
      if (!collided) {
        check("J4: occupied read and cancellation never change or delete the other owner's consumer", false, "the occupied name was taken over");
        internals.conn.jsm.consumers.add = originalAdd;
        return;
      }
      const beforeAbort = await api.consumers.info(CHAT, chatHistD);
      abort.abort(new Error("cancel occupied read"));
      const cancelled = await blocked;
      const afterAbort = await api.consumers.info(CHAT, chatHistD).catch(() => undefined);
      check("J4: occupied read and cancellation never change or delete the other owner's consumer",
        cancelled === "cancel occupied read" && beforeAbort.created === occupant.created && afterAbort?.created === occupant.created &&
        afterAbort.config.description === "test-owner", { cancelled, before: beforeAbort.config.description, after: afterAbort?.config.description });
      internals.conn.jsm.consumers.add = originalAdd;
      await api.consumers.delete(CHAT, chatHistD); // the fixture releases its own occupant

      // Pause a completed reader before its final INFO, let native expiry replace its consumer,
      // then release it. This stale completion must not claim a page or delete the successor.
      let atInfo!: () => void, resumeInfo!: () => void;
      const infoReached = new Promise<void>((resolve) => { atInfo = resolve; });
      const infoRelease = new Promise<void>((resolve) => { resumeInfo = resolve; });
      const originalGet = internals.conn.js.consumers.get.bind(internals.conn.js.consumers);
      internals.conn.js.consumers.get = async (...args) => {
        const consumer = await originalGet(...args);
        const info = consumer.info.bind(consumer);
        consumer.info = async (...infoArgs) => { atInfo(); await infoRelease; return info(...infoArgs); };
        return consumer;
      };
      const stale = one.channelHistoryPage("allowed").then(() => "succeeded", (e: Error) => e.message);
      const reachedInfo = await Promise.race([infoReached.then(() => true), stale.then(() => false)]);
      if (!reachedInfo) {
        check("J5: a delayed old reader detects replacement and leaves the successor intact", false, "reader skipped its final ownership check");
        internals.conn.js.consumers.get = originalGet;
        return;
      }
      const successor = await occupy("successor");
      resumeInfo();
      const staleResult = await stale;
      const surviving = await api.consumers.info(CHAT, chatHistD);
      check("J5: a delayed old reader detects replacement and leaves the successor intact",
        /ownership was lost/.test(staleResult) && surviving.created === successor.created && surviving.config.description === "successor",
        { staleResult, surviving: surviving.config.description });
      internals.conn.js.consumers.get = originalGet;
      await api.consumers.delete(CHAT, chatHistD); // fixture-owned successor only
      const reread = await one.channelHistoryPage("allowed");
      check("J6: a successful reread retains all own messages after interference", reread.complete && reread.items.length === 5, reread);

      // End a real broker-backed pull after one delivery through the client's native stop API.
      // A clean iterator end must not masquerade as a complete five-row snapshot.
      internals.conn.js.consumers.get = async (...args) => {
        const consumer = await originalGet(...args);
        const consume = consumer.consume.bind(consumer);
        consumer.consume = async (...consumeArgs) => {
          const iter = await consume(...consumeArgs);
          const iterate = iter[Symbol.asyncIterator].bind(iter);
          iter[Symbol.asyncIterator] = async function* () {
            for await (const m of { [Symbol.asyncIterator]: iterate }) { yield m; iter.stop(); break; }
          };
          return iter;
        };
        return consumer;
      };
      const short = await one.channelHistoryPage("allowed").then(() => "succeeded", (e: Error) => e.message);
      check("J7: a pull ending before its captured pending count is a cut-short error, never a page", /window was cut short/.test(short), short);
      internals.conn.js.consumers.get = originalGet;
      const [whole, empty] = await Promise.all([one.channelHistoryPage("allowed"), two.channelHistoryPage("other")]);
      check("J8: independent same-lifecycle readers serialize on the broker without cross-feeding channels",
        whole.complete && whole.items.length === 5 && whole.items.every((m) => m.channel === "allowed") && empty.complete && empty.items.length === 0,
        { whole, empty });
      // Both native creates are in flight before the first creator proceeds to pull. Healthy
      // readers conflict; an identical marker would idempotently bind both to one pending window.
      const twoInternals = two as unknown as { conn: { jsm: import("@nats-io/jetstream").JetStreamManager } };
      const twoAdd = twoInternals.conn.jsm.consumers.add.bind(twoInternals.conn.jsm.consumers);
      let observedBoth!: () => void;
      const bothAttempted = new Promise<void>((resolve) => { observedBoth = resolve; });
      let attempts = 0;
      const gateAdd = (add: typeof originalAdd): typeof originalAdd => async (...args) => {
        try { return await add(...args); }
        finally { if (++attempts >= 2) observedBoth(); await bothAttempted; }
      };
      internals.conn.jsm.consumers.add = gateAdd(originalAdd);
      twoInternals.conn.jsm.consumers.add = gateAdd(twoAdd);
      const same = await Promise.all([one, two].map((ep) => ep.channelHistoryPage("allowed").catch((e: Error) => e)));
      check("J9: simultaneous same-channel connections each receive a whole independent page",
        same.every((p) => !(p instanceof Error) && p.complete && p.items.length === 5), same);
      internals.conn.jsm.consumers.add = originalAdd;
      twoInternals.conn.jsm.consumers.add = twoAdd;

      const { jetstream } = await import("@nats-io/jetstream");
      const publisher = jetstream(ag);
      const ownSubject = chatSubject(space, DEV_OWNER, id.id, "allowed");
      await publisher.publish(ownSubject, enc(JSON.stringify({ ...page.items[0], id: "forged-history", from: { id: `${DEV_OWNER}.forged`, name: "forged" } })));
      await publisher.publish(ownSubject, enc("not JSON"));
      const verified = await one.channelHistoryPage("allowed");
      check("J10: malformed and sender-forged stored rows do not enter the page or completeness probe",
        verified.complete && JSON.stringify(verified.items.map((m) => partsToText(m.parts))) === JSON.stringify(["own 0", "own 1", "own 2", "own 3", "own 4"]), verified);
    };
    await exercise();
  } finally {
    for (const ep of readers) await ep.stop();
  }

  await ag.drain().catch(() => {});
  await mgr.drain().catch(() => {});
  await checkPluginGrants();
  await checkLegacyAccountFence();
  console.log(`\nREAD-ACL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

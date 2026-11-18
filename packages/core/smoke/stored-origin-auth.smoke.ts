/**
 * Stored-message replays on the messaging receive paths, against a real JWT-auth broker with
 * credentials minted by the shipped provisioner and a real delivery daemon.
 *
 * A message the broker serves from a stream carries the headers it writes on a stored message
 * (`Nats-Stream`, `Nats-Subject`, `Nats-Sequence`, `Nats-Time-Stamp`), and a stream that captures
 * such a message on a messaging subject stores them with it. Every messaging receive path drops a
 * message carrying them (SPEC §5). Here an ordinary agent stores bytes that name another agent as
 * the sender under its own presence key and has the broker serve them onto that agent's chat, DM,
 * role and delivery subjects. Per receive path, three cells: a legitimate message is accepted, the
 * replayed one is dropped, and a message whose `from.id` disagrees with its subject is dropped.
 * The trusted reader and the delivery pull check no `from.id`, since only the daemon writes their
 * subjects, so their third cell is the broker refusing an agent's direct publish there.
 *
 * A replayed delivery copy also carries a stamped count of 1, which must not raise the full-store
 * notice, since the count is not the writer's.
 *
 * The roster read, which is the agent's own Direct Get and carries the same headers on its answer,
 * still returns its peers.
 *
 * Run: pnpm smoke:stored-origin:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, headers as natsHeaders, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid, serverConfig,
  newIdentity, setupSpaceStreams, DEV_OWNER, chatSubject, unicastSubject, anycastSubject, controlServiceSubject,
  presenceBucket, presenceKeySubject, dlvSubject, dinboxSubject, openMembersRegistry, commitMemberRevision,
  type CotalMessage, type Delivery, type MessageMeta, type ControlRequest,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `storedorigin-${randomUUID().slice(0, 8)}`;
const { check, finish } = createSuite();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await sleep(50);
  return cond();
};
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
const textOf = (m: CotalMessage): string => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
/** Settle after a positive arrived, so a dropped message would have arrived too. */
const SETTLE_MS = 600;

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const stops: Array<() => Promise<unknown>> = [];

type Seen = { text: string; from: string; kind: string; durable: boolean; historical: boolean };
const enc = (s: string) => new TextEncoder().encode(s);

try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 200 });

  // A full-permission fixture identity: it serves and calls the control probe, and writes one
  // membership row. It is test scaffolding, never an agent.
  const superCreds = async (name: string) => {
    const key = createUser();
    const jwt = await encodeUser(name, fromPublic(key.getPublicKey()), fromPublic(auth.account.pub), {
      pub: { allow: [">"] }, sub: { allow: [">"] },
    }, { signer: fromSeed(enc(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 900 });
    return { id: key.getPublicKey(), creds: new TextDecoder().decode(fmtCreds(jwt, key)) };
  };

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, card: { id: mgrId.id, name: "mgr", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false });
  await mgr.start();
  stops.push(() => mgr.stop());

  const mk = async (name: string, o: { subscribe?: string[]; allowSubscribe?: string[]; allowPublish?: string[]; role?: string }) => {
    const id = newIdentity(), uid = mintLifecycleUid();
    const creds = await provisionAgent(mgr, auth, id, { subscribe: o.subscribe ?? [], allowSubscribe: o.allowSubscribe, allowPublish: o.allowPublish, role: o.role, lifecycleUid: uid });
    return { id, uid, creds, principal: `${DEV_OWNER}.${id.id}`, name };
  };
  const A = await mk("attacker", { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] });
  const B = await mk("bob", { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] });
  const C = await mk("carol", { subscribe: ["general"], allowSubscribe: ["general"], role: "worker" });
  const D = await mk("dave", { allowSubscribe: ["general"] });
  const E = await mk("erin", { allowSubscribe: ["general"] });
  const F = await mk("frank", { subscribe: ["general"], allowSubscribe: ["general"] });
  const acl = new Map([A, B, C, D, E, F].map((p) => [p.principal, ["general"]]));

  const dlvId = newIdentity();
  const dlv = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"), card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: true });
  dlv.on("error", () => { /* the daemon reports each dropped entry; the cells read the outcome */ });
  await dlv.start();
  stops.push(() => dlv.stop());
  await dlv.startPlane3((id: string) => acl.get(id));

  const seen = new Map<string, Seen[]>();
  const start = async (p: typeof A, channels: string[], extra: { role?: string; watchPresence?: boolean } = {}) => {
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds: p.creds, lifecycleUid: p.uid, heartbeatMs: 500, ttlMs: 4000, channels,
      card: { id: p.id.id, name: p.name, kind: "agent", ...(extra.role ? { role: extra.role } : {}) },
      ...(extra.watchPresence === false ? { watchPresence: false } : {}),
    });
    const list: Seen[] = [];
    seen.set(p.name, list);
    ep.on("error", () => { /* each dropped copy is reported here; the cells read the outcome */ });
    ep.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
      list.push({ text: textOf(m), from: m.from.id, kind: meta.kind, durable: d.durable, historical: meta.historical === true });
      d.ack();
    });
    await ep.start();
    stops.push(() => ep.stop());
    return ep;
  };
  const has = (who: string, text: string, pick: (s: Seen) => boolean = () => true) =>
    (seen.get(who) ?? []).some((s) => s.text === text && pick(s));
  const live = (s: Seen) => !s.durable && !s.historical;
  const backstop = (s: Seen) => s.durable && s.kind === "channel";

  const bob = await start(B, ["general"]);
  const carol = await start(C, ["general"], { role: "worker" });
  const dave = await start(D, []);
  const fullNotices: unknown[] = [];
  dave.on("stored-copies-full", (n: unknown) => fullNotices.push(n));
  await start(E, []);
  const dj = await dlv.durableJoinFor(D.principal, "general", D.uid);
  check("setup: dave is a durable member of general", dj.durable === true, dj);

  // An operator tap on the chat plane, through the shipped observer profile.
  const tapped: { subject: string; text: string }[] = [];
  const observer = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), card: { name: "observer", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false });
  await observer.start();
  stops.push(() => observer.stop());
  observer.tap((subject, msg) => { if (msg) tapped.push({ subject, text: textOf(msg) }); }, { subject: `cotal.${space}.chat.>` });

  // A control service served without the bound-reply guard, so the sender check alone stands.
  const probeHost = await superCreds("probe-host");
  const probeCaller = await superCreds("probe-caller");
  const host = new CotalEndpoint({ space, servers: SERVERS, creds: probeHost.creds, card: { id: probeHost.id, name: "probe-host", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false });
  host.on("error", () => { /* refusals are reported here; the cells read the handler calls */ });
  await host.start();
  stops.push(() => host.stop());
  const probeOps: string[] = [];
  host.serveControl("probe", (req) => { probeOps.push(req.op); return { ok: true }; });
  const caller = new CotalEndpoint({ space, servers: SERVERS, creds: probeCaller.creds, card: { id: probeCaller.id, name: "probe-caller", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false });
  await caller.start();
  stops.push(() => caller.stop());

  // The attacker: an ordinary agent credential, used raw.
  const atk: NatsConnection = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(A.creds)), inboxPrefix: `_INBOX_${A.id.id}`, maxReconnectAttempts: 0 });
  stops.push(() => atk.close());
  const denials: string[] = [];
  void (async () => { for await (const s of atk.status()) if (s.type === "error") denials.push(String((s as { error?: Error }).error?.message ?? "")); })();
  const bobCard = { id: B.principal, name: "bob", kind: "agent" };
  const message = (text: string, extra: Partial<CotalMessage> = {}): CotalMessage =>
    ({ id: randomUUID(), ts: Date.now(), space, from: bobCard, parts: [{ kind: "text", text }], ...extra }) as CotalMessage;
  const ownKey = presenceKeySubject(space, DEV_OWNER, A.id.id);
  /** Store `body` under the attacker's own presence key and have the broker serve it onto `target`. */
  const replay = async (target: string, body: unknown, hdrs?: Record<string, string>) => {
    let h;
    if (hdrs) { h = natsHeaders(); for (const [k, v] of Object.entries(hdrs)) h.set(k, v); }
    atk.publish(ownKey, JSON.stringify(body), h ? { headers: h } : undefined);
    await atk.flush();
    atk.publish(`$JS.API.DIRECT.GET.KV_${presenceBucket(space)}`, JSON.stringify({ last_by_subj: ownKey }), { reply: target });
    await atk.flush();
  };
  const raw = async (subject: string, body: unknown) => { atk.publish(subject, JSON.stringify(body)); await atk.flush(); };
  await sleep(500);

  // ── channel posts: replayed, mismatched, then the legitimate one ───────────────────────────
  const bobGeneral = chatSubject(space, DEV_OWNER, B.id.id, "general");
  await replay(bobGeneral, message("chat-replayed", { channel: "general" }));
  await raw(chatSubject(space, DEV_OWNER, A.id.id, "general"), message("chat-mismatched", { channel: "general" }));
  await bob.multicast("chat-legit", { channel: "general" });

  check("live chat: bob's post is accepted", await until(() => has("carol", "chat-legit", live)));
  check("tap: bob's post is accepted", await until(() => tapped.some((t) => t.text === "chat-legit")));
  check("fan-out: bob's post reaches a durable member", await until(() => has("dave", "chat-legit", backstop)));
  await sleep(SETTLE_MS);
  check("live chat: a stored replay naming bob is dropped", !has("carol", "chat-replayed", live), seen.get("carol"));
  check("live chat: a post whose from.id is not its subject's sender is dropped", !has("carol", "chat-mismatched", live));
  check("tap: a stored replay naming bob is dropped", !tapped.some((t) => t.text === "chat-replayed"), tapped);
  check("tap: a post whose from.id is not its subject's sender is dropped", !tapped.some((t) => t.text === "chat-mismatched"));
  check("fan-out: a stored replay naming bob is not routed", !has("dave", "chat-replayed"), seen.get("dave"));
  check("fan-out: a post whose from.id is not its subject's sender is not routed", !has("dave", "chat-mismatched"));

  const history = (await carol.channelHistoryPage("general", { limit: 100 })).items.map(textOf);
  check("history: bob's post is listed", history.includes("chat-legit"), history);
  check("history: a stored replay naming bob is not listed", !history.includes("chat-replayed"), history);
  check("history: a post whose from.id is not its subject's sender is not listed", !history.includes("chat-mismatched"));

  const recall = (await carol.recallChannel("general", 0)).messages.map(textOf);
  check("recall: bob's post is returned", recall.includes("chat-legit"), recall);
  check("recall: a stored replay naming bob is not returned", !recall.includes("chat-replayed"), recall);
  check("recall: a post whose from.id is not its subject's sender is not returned", !recall.includes("chat-mismatched"));

  // Join-time backfill: frank joins general after the posts. He reads the roster on demand.
  const frank = await start(F, ["general"], { watchPresence: false });
  check("backfill: bob's post is replayed on join", await until(() => has("frank", "chat-legit", (s) => s.historical)));
  await sleep(SETTLE_MS);
  check("backfill: a stored replay naming bob is not replayed", !has("frank", "chat-replayed"), seen.get("frank"));
  check("backfill: a post whose from.id is not its subject's sender is not replayed", !has("frank", "chat-mismatched"));

  // Activation catch-up: erin's row predates the posts and is not yet activated, so her join
  // copies the window from its cursor.
  const fixture = await superCreds("members-fixture");
  const fixtureNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(fixture.creds)), maxReconnectAttempts: 0 });
  stops.push(() => fixtureNc.close());
  await commitMemberRevision(await openMembersRegistry(fixtureNc, space), {
    channel: "general", owner: E.principal, lifecycleUid: E.uid, state: "durable-active", joinCursor: 0, generation: 1,
    activated: false, writerIdentity: fixture.id, updatedAt: Date.now(),
  });
  const ej = await dlv.durableJoinFor(E.principal, "general", E.uid);
  check("setup: erin's pending join activates", ej.durable === true, ej);
  check("catch-up: bob's post is copied", await until(() => has("erin", "chat-legit", backstop)));
  await sleep(SETTLE_MS);
  check("catch-up: a stored replay naming bob is not copied", !has("erin", "chat-replayed"), seen.get("erin"));
  check("catch-up: a post whose from.id is not its subject's sender is not copied", !has("erin", "chat-mismatched"));

  // ── DM to carol ───────────────────────────────────────────────────────────────────────────
  await replay(unicastSubject(space, DEV_OWNER, C.id.id, DEV_OWNER, B.id.id), message("dm-replayed", { to: C.principal }));
  await raw(unicastSubject(space, DEV_OWNER, C.id.id, DEV_OWNER, A.id.id), message("dm-mismatched", { to: C.principal }));
  await bob.unicast(C.principal, "dm-legit");
  check("DM pull: bob's DM is accepted", await until(() => has("carol", "dm-legit", (s) => s.kind === "dm" && s.from === B.principal)));
  await sleep(SETTLE_MS);
  check("DM pull: a stored replay naming bob is dropped", !has("carol", "dm-replayed"), seen.get("carol"));
  check("DM pull: a DM whose from.id is not its subject's sender is dropped", !has("carol", "dm-mismatched"));

  // ── role request to worker ────────────────────────────────────────────────────────────────
  await replay(anycastSubject(space, "worker", DEV_OWNER, B.id.id), message("task-replayed", { toService: "worker" }));
  await raw(anycastSubject(space, "worker", DEV_OWNER, A.id.id), message("task-mismatched", { toService: "worker" }));
  await bob.anycast("worker", "task-legit");
  check("task pull: bob's role request is accepted", await until(() => has("carol", "task-legit", (s) => s.kind === "anycast" && s.from === B.principal)));
  await sleep(SETTLE_MS);
  check("task pull: a stored replay naming bob is dropped", !has("carol", "task-replayed"));
  check("task pull: a request whose from.id is not its subject's sender is dropped", !has("carol", "task-mismatched"));

  // ── dave's delivery store and his mixed inbox, which only the daemon writes ────────────────
  const daveDlv = dlvSubject(space, DEV_OWNER, D.id.id, D.uid);
  const daveDinbox = dinboxSubject(space, DEV_OWNER, D.id.id, D.uid);
  await replay(daveDlv, { version: 1, channel: "general", msg: message("dlv-replayed", { channel: "general" }) }, { "Cotal-Delivery-Frame": "1", "Cotal-Delivery-Limit": "1" });
  await replay(daveDinbox, { msg: message("dinbox-replayed", { channel: "general" }), channel: "general", seq: 1_000_000, reason: "live-mention", generation: 1 });
  const before = denials.length;
  await raw(daveDlv, { version: 1, channel: "general", msg: message("dlv-direct", { channel: "general" }) });
  await raw(daveDinbox, { msg: message("dinbox-direct", { channel: "general" }), channel: "general", seq: 1_000_000, reason: "live-mention", generation: 1 });
  await bob.multicast("chat-legit-2", { channel: "general" });
  check("delivery pull: a copy the daemon wrote is accepted", await until(() => has("dave", "chat-legit-2", backstop)));
  check("trusted reader: an entry the fan-out wrote is transferred", has("dave", "chat-legit-2", backstop));
  await sleep(SETTLE_MS);
  check("delivery pull: a stored replay naming bob is dropped", !has("dave", "dlv-replayed"), seen.get("dave"));
  check("delivery pull: a stored replay's stamped count raises no full-store notice", fullNotices.length === 0, fullNotices);
  check("trusted reader: a stored replay naming bob is not transferred", !has("dave", "dinbox-replayed"), seen.get("dave"));
  const refused = denials.slice(before);
  check("delivery pull: the broker refuses an agent's direct publish to a delivery subject", refused.some((d) => d.includes(daveDlv)) && !has("dave", "dlv-direct"), refused);
  check("trusted reader: the broker refuses an agent's direct publish to a mixed inbox", refused.some((d) => d.includes(daveDinbox)) && !has("dave", "dinbox-direct"), refused);

  // ── control request ───────────────────────────────────────────────────────────────────────
  await replay(controlServiceSubject(space, "probe", DEV_OWNER, B.id.id), { op: "replayed", from: bobCard } satisfies ControlRequest);
  const fixtureProbe = controlServiceSubject(space, "probe", DEV_OWNER, fixture.id);
  fixtureNc.publish(fixtureProbe, JSON.stringify({ op: "mismatched", from: bobCard } satisfies ControlRequest));
  await fixtureNc.flush();
  const answer = await caller.requestControl("probe", { op: "legit" });
  check("control: a request from its subject's sender is served", answer.ok === true && probeOps.includes("legit"), { answer, probeOps });
  await sleep(SETTLE_MS);
  check("control: a stored replay naming bob is not served", !probeOps.includes("replayed"), probeOps);
  check("control: a request whose from.id is not its subject's sender is not served", !probeOps.includes("mismatched"), probeOps);

  // ── the agent's own Direct Get read still works ───────────────────────────────────────────
  const roster = await frank.readPresence();
  check("roster read: the agent's own Direct Get read still returns its peers", roster.some((p) => p.card.id === B.principal) && roster.some((p) => p.card.id === C.principal), roster.map((p) => p.card.id));
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const stop of stops.reverse()) { try { await stop(); } catch { /* ignore */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
process.exit(process.exitCode ?? 0);

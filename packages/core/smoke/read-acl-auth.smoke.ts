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
import {
  isReachable,
  CotalEndpoint,
  partsToText,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
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
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
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
      const internals = one as unknown as { jsm: import("@nats-io/jetstream").JetStreamManager; js: import("@nats-io/jetstream").JetStreamClient };
      const originalAdd = internals.jsm.consumers.add.bind(internals.jsm.consumers);
      let observedCollision!: () => void;
      const collision = new Promise<void>((resolve) => { observedCollision = resolve; });
      internals.jsm.consumers.add = async (...args) => {
        try { return await originalAdd(...args); }
        catch (e) { observedCollision(); throw e; }
      };
      const abort = new AbortController();
      const blocked = one.channelHistoryPage("allowed", { signal: abort.signal }).then(() => "succeeded",
        (e: Error) => e === abort.signal.reason || e.cause === abort.signal.reason ? "cancel occupied read" : e.message);
      const collided = await Promise.race([collision.then(() => true), blocked.then(() => false)]);
      if (!collided) {
        check("J4: occupied read and cancellation never change or delete the other owner's consumer", false, "the occupied name was taken over");
        internals.jsm.consumers.add = originalAdd;
        return;
      }
      const beforeAbort = await api.consumers.info(CHAT, chatHistD);
      abort.abort(new Error("cancel occupied read"));
      const cancelled = await blocked;
      const afterAbort = await api.consumers.info(CHAT, chatHistD).catch(() => undefined);
      check("J4: occupied read and cancellation never change or delete the other owner's consumer",
        cancelled === "cancel occupied read" && beforeAbort.created === occupant.created && afterAbort?.created === occupant.created &&
        afterAbort.config.description === "test-owner", { cancelled, before: beforeAbort.config.description, after: afterAbort?.config.description });
      internals.jsm.consumers.add = originalAdd;
      await api.consumers.delete(CHAT, chatHistD); // the fixture releases its own occupant

      // Pause a completed reader before its final INFO, let native expiry replace its consumer,
      // then release it. This stale completion must not claim a page or delete the successor.
      let atInfo!: () => void, resumeInfo!: () => void;
      const infoReached = new Promise<void>((resolve) => { atInfo = resolve; });
      const infoRelease = new Promise<void>((resolve) => { resumeInfo = resolve; });
      const originalGet = internals.js.consumers.get.bind(internals.js.consumers);
      internals.js.consumers.get = async (...args) => {
        const consumer = await originalGet(...args);
        const info = consumer.info.bind(consumer);
        consumer.info = async (...infoArgs) => { atInfo(); await infoRelease; return info(...infoArgs); };
        return consumer;
      };
      const stale = one.channelHistoryPage("allowed").then(() => "succeeded", (e: Error) => e.message);
      const reachedInfo = await Promise.race([infoReached.then(() => true), stale.then(() => false)]);
      if (!reachedInfo) {
        check("J5: a delayed old reader detects replacement and leaves the successor intact", false, "reader skipped its final ownership check");
        internals.js.consumers.get = originalGet;
        return;
      }
      const successor = await occupy("successor");
      resumeInfo();
      const staleResult = await stale;
      const surviving = await api.consumers.info(CHAT, chatHistD);
      check("J5: a delayed old reader detects replacement and leaves the successor intact",
        /ownership was lost/.test(staleResult) && surviving.created === successor.created && surviving.config.description === "successor",
        { staleResult, surviving: surviving.config.description });
      internals.js.consumers.get = originalGet;
      await api.consumers.delete(CHAT, chatHistD); // fixture-owned successor only
      const reread = await one.channelHistoryPage("allowed");
      check("J6: a successful reread retains all own messages after interference", reread.complete && reread.items.length === 5, reread);

      // End a real broker-backed pull after one delivery through the client's native stop API.
      // A clean iterator end must not masquerade as a complete five-row snapshot.
      internals.js.consumers.get = async (...args) => {
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
      internals.js.consumers.get = originalGet;
      const [whole, empty] = await Promise.all([one.channelHistoryPage("allowed"), two.channelHistoryPage("other")]);
      check("J8: independent same-lifecycle readers serialize on the broker without cross-feeding channels",
        whole.complete && whole.items.length === 5 && whole.items.every((m) => m.channel === "allowed") && empty.complete && empty.items.length === 0,
        { whole, empty });
      // Both native creates are in flight before the first creator proceeds to pull. Healthy
      // readers conflict; an identical marker would idempotently bind both to one pending window.
      const twoInternals = two as unknown as { jsm: import("@nats-io/jetstream").JetStreamManager };
      const twoAdd = twoInternals.jsm.consumers.add.bind(twoInternals.jsm.consumers);
      let observedBoth!: () => void;
      const bothAttempted = new Promise<void>((resolve) => { observedBoth = resolve; });
      let attempts = 0;
      const gateAdd = (add: typeof originalAdd): typeof originalAdd => async (...args) => {
        try { return await add(...args); }
        finally { if (++attempts >= 2) observedBoth(); await bothAttempted; }
      };
      internals.jsm.consumers.add = gateAdd(originalAdd);
      twoInternals.jsm.consumers.add = gateAdd(twoAdd);
      const same = await Promise.all([one, two].map((ep) => ep.channelHistoryPage("allowed").catch((e: Error) => e)));
      check("J9: simultaneous same-channel connections each receive a whole independent page",
        same.every((p) => !(p instanceof Error) && p.complete && p.items.length === 5), same);
      internals.jsm.consumers.add = originalAdd;
      twoInternals.jsm.consumers.add = twoAdd;

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

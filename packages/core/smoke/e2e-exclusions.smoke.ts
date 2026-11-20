/**
 * Channel exclusions end to end on a real broker and delivery daemon (SPEC §8, §9). One agent is
 * provisioned from a real agent file whose read grant is `team.>` minus `team.secret` and
 * `team.*.private`, and whose post grant is `team.>` minus `team.secret`. Each step shows the
 * excluded channel refused and a sibling under the same wildcard working:
 *
 *   1. boot backfill of `team.>` goes through the mediated range read: siblings, no excluded rows
 *   2. live reads: the broker filters excluded channels out of the `team.>` subscription
 *   3. posts: the excluded post is broker-refused, a sibling and a read-only exclusion post are not
 *   4. history creates: the credential holds no create row under the overlapped `team.>`, so raw
 *      creates with `team.>`, `team.a.*` and `team.a` filters are refused, as is the excluded one
 *   5. joins: concrete and pattern joins the exclusions cover are refused; a partial overlap is not
 *   6. single-channel page and recall: mediated; the excluded channel refuses, never reads empty
 *   7. recall drains more than one mediated page past excluded rows
 *   8. durable delivery: copies on the excluded channel are never handed to the offline agent
 *   9. an endpoint that does not know its exclusions (an older client) fails to start, never served
 *  10. channelHistory is a view route: every agent credential is refused, a view reads by publisher
 *  11. a mediated page honors its abort signal, before and during the read
 *  12. the range read: a family page over 1000 excluded rows, the pinned frontier, the payload split
 *  13. live ACL changes: a narrowed channel's join is refused and its copies and mentions withheld;
 *      a live row that drops every exclusion still keeps the credential's own
 *  14. a resume floor bounds the mediated boot backfill
 *  15. a purge during a range read ends the scan, and another principal's join is still served
 *  16. a row too large for any reply is refused loudly
 *
 * Run: pnpm smoke:e2e:exclusions
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth, serverConfig, mintCreds, newIdentity, isReachable, loadAgentFile,
  setupSpaceStreams, seedChannelRegistry, provisionAgent, mintLifecycleUid, CotalEndpoint,
  chatStream, chatSubject, chatHistDurable, DEV_OWNER,
  type CotalMessage, type Delivery, type MessageMeta, type ControlReply,
} from "../src/index.js";
import { jetstreamManager } from "@nats-io/jetstream";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort(), SERVERS = `nats://127.0.0.1:${PORT}`, space = "e2eexcl";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};
const refusal = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; return undefined; } catch (e) { return (e as Error).message; }
};

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

try {
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS, { creds: mgrCreds })) { up = true; break; } await sleep(200); }
  if (!up) throw new Error("auth nats-server did not come up");
  const versionNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(mgrCreds)) });
  const brokerVersion = versionNc.info?.version;
  const maxPayload = versionNc.info?.max_payload ?? 1024 * 1024;
  await versionNc.close();
  console.log(`broker ${brokerVersion}`);

  const replay = { replay: true };
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  await seedChannelRegistry({ servers: SERVERS, space, creds: mgrCreds, file: { defaults: replay, channels: {
    "team.a": replay, "team.secret": replay, "team.b.private": replay, "team.b.public": replay, "team.d": replay,
  } } });

  const mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  mgr.on("error", (e) => console.log("mgr err:", e.message));
  await mgr.start();
  const dlvId = newIdentity();
  const dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  dlv.on("error", (e: Error) => console.error("  ! dlv", e.message));
  await dlv.start();
  await dlv.startPlane3((owner, uid) => dlv.aclForOwner(owner, uid));
  const poster = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "operator"), card: { name: "poster", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  poster.on("error", (e) => console.log("poster err:", e.message));
  await poster.start();

  // History that exists before the agent connects.
  for (const [ch, text] of [["team.a", "a-1"], ["team.secret", "s-1"], ["team.b.private", "p-1"], ["team.b.public", "pub-1"]])
    await poster.multicast(text, { channel: ch });
  await sleep(300);

  // The agent, from a real file in the object form.
  mkdirSync(join(dir, "agents"), { recursive: true });
  const file = join(dir, "agents", "xena.md");
  writeFileSync(file, [
    "---", "name: xena", "subscribe: [team.>]",
    "allowSubscribe:", "  allow: [team.>]", "  exclude: [team.secret, team.*.private]",
    "allowPublish:", "  allow: [team.>]", "  exclude: [team.secret]",
    "---", "You are xena.", "",
  ].join("\n"));
  const def = loadAgentFile(file);
  check("the agent file reads the object form", JSON.stringify([def.allowSubscribe, def.excludeSubscribe, def.allowPublish, def.excludePublish])
    === JSON.stringify([["team.>"], ["team.secret", "team.*.private"], ["team.>"], ["team.secret"]]), def);
  const ident = newIdentity(), uid = mintLifecycleUid();
  const grant = { subscribe: def.subscribe, allowSubscribe: def.allowSubscribe, excludeSubscribe: def.excludeSubscribe, allowPublish: def.allowPublish, excludePublish: def.excludePublish };
  const creds = await provisionAgent(mgr, auth, ident, { ...grant, brokerVersion, lifecycleUid: uid });
  const acl = await mgr.aclForOwner(`${DEV_OWNER}.${ident.id}`, uid);
  check("the read-ACL row carries the exclusions", JSON.stringify(acl) === JSON.stringify({ allow: ["team.>"], exclude: ["team.secret", "team.*.private"] }), acl);

  type Got = { channel?: string; text: string; historical: boolean };
  const mkEp = (opts: { routed: boolean }) => {
    const errors: string[] = [], got: Got[] = [];
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds, card: { name: "xena", kind: "agent", id: ident.id }, channels: ["team.>"], lifecycleUid: uid,
      ...(opts.routed ? { allowSubscribe: def.allowSubscribe, excludeSubscribe: def.excludeSubscribe } : {}),
    });
    ep.on("error", (e: Error) => errors.push(e.message));
    ep.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => { got.push({ channel: m.channel, text: textOf(m), historical: meta?.historical ?? false }); d.ack(); });
    return { ep, errors, got };
  };
  let X = mkEp({ routed: true });
  await X.ep.start();
  await sleep(1200);

  console.log("[1] boot backfill through the mediated range read");
  const hist = X.got.filter((g) => g.historical).map((g) => g.text).sort();
  check("backfill holds the siblings", hist.includes("a-1") && hist.includes("pub-1"), hist);
  check("backfill holds no excluded row", !hist.includes("s-1") && !hist.includes("p-1"), hist);
  check("no errors on boot", X.errors.length === 0, X.errors);

  console.log("[2] live reads");
  for (const [ch, text] of [["team.a", "a-live"], ["team.secret", "s-live"], ["team.c.private", "p-live"], ["team.c.public", "pub-live"]])
    await poster.multicast(text, { channel: ch });
  await sleep(600);
  const live = X.got.filter((g) => !g.historical).map((g) => g.text);
  check("live siblings arrive", live.includes("a-live") && live.includes("pub-live"), live);
  check("live excluded channels never arrive", !live.includes("s-live") && !live.includes("p-live"), live);

  console.log("[3] posts");
  const secretPost = await refusal(X.ep.multicast("x-secret", { channel: "team.secret" }));
  check("a post to the excluded channel is broker-refused", secretPost !== undefined && /permission/i.test(secretPost), secretPost);
  check("a post to a sibling works", await refusal(X.ep.multicast("x-a", { channel: "team.a" })) === undefined);
  check("a post to a read-only exclusion works (read and post lists are separate)", await refusal(X.ep.multicast("x-private", { channel: "team.b.private" })) === undefined);

  console.log("[4] raw history creates");
  const raw = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(creds)), inboxPrefix: `_INBOX_${ident.id}`, maxReconnectAttempts: 0 });
  const name = chatHistDurable(DEV_OWNER, ident.id, uid);
  const rawCreate = async (filter: string): Promise<boolean> => {
    const subject = chatSubject(space, "*", "*", filter);
    try {
      const m = await raw.request(`$JS.API.CONSUMER.CREATE.${chatStream(space)}.${name}.${subject}`,
        enc(JSON.stringify({ stream_name: chatStream(space), config: { name, filter_subject: subject, ack_policy: "none", deliver_policy: "all" }, action: "create" })), { timeout: 1500 });
      return !!m.json<{ error?: unknown }>()?.error;
    } catch { return true; }
  };
  for (const f of ["team.>", "team.a.*", "team.a", "team.secret", "team.*.private"])
    check(`a raw history create with filter ${f} is refused`, await rawCreate(f));
  await raw.drain().catch(() => {});

  console.log("[5] joins");
  for (const ch of ["team.secret", "team.b.private", "team.*.private"])
    check(`a join of ${ch} is refused`, await refusal(X.ep.joinChannel(ch)) !== undefined);
  const dJoin = await X.ep.joinChannel("team.d").catch((e: Error) => ({ joined: false, reason: e.message }));
  check("a join of the sibling team.d works", dJoin.joined, dJoin);
  const pJoin = await X.ep.joinChannel("team.private.>").catch((e: Error) => ({ joined: false, reason: e.message }));
  check("a join of team.private.> (a partial overlap) works", pJoin.joined, pJoin);

  console.log("[6] single-channel page and recall");
  const page = await X.ep.channelHistoryPage("team.a", { limit: 10 });
  check("the sibling page is read through the daemon", page.items.some((m) => textOf(m) === "a-1"), page.items.map(textOf));
  check("the excluded page is refused, not empty", await refusal(X.ep.channelHistoryPage("team.secret", { limit: 10 })) !== undefined);
  const recallSecret = await X.ep.recallChannel("team.secret", 0).then((r) => ({ resolved: r }), (e: Error) => ({ refused: e.message }));
  check("recall of the excluded channel is refused, as a direct read's permission denial is", "refused" in recallSecret, recallSecret);

  console.log("[7] recall drains several pages past excluded rows");
  const before = (await X.ep.recallChannel("team.a", 0)).seqs.at(-1) ?? 0;
  for (let i = 0; i < 230; i++) {
    await poster.multicast(`bulk-${i}`, { channel: "team.a" });
    if (i % 3 === 0) await poster.multicast(`bulk-secret-${i}`, { channel: "team.secret" });
  }
  await sleep(500);
  const recalled = await X.ep.recallChannel("team.a", before);
  const bulk = recalled.messages.map(textOf).filter((t) => t.startsWith("bulk-"));
  check("recall returns every sibling post across pages", bulk.length === 230 && !recalled.unanswered, { n: bulk.length, unanswered: recalled.unanswered });
  check("recall returns no excluded post", !bulk.some((t) => t.startsWith("bulk-secret")), bulk.filter((t) => t.startsWith("bulk-secret")).length);
  check("recall sequences ascend", recalled.seqs.every((s, i) => i === 0 || s > recalled.seqs[i - 1]));

  console.log("[8] durable delivery while offline");
  await X.ep.stop();
  await sleep(300);
  await poster.multicast("a-offline", { channel: "team.a" });
  await poster.multicast("s-offline", { channel: "team.secret" });
  await poster.multicast("p-offline", { channel: "team.e.private" });
  await sleep(600);
  X = mkEp({ routed: true });
  await X.ep.start();
  await sleep(1500);
  const after = X.got.map((g) => g.text);
  check("the offline sibling copy is delivered", after.includes("a-offline"), after.filter((t) => !t.startsWith("bulk")));
  check("no offline excluded copy is delivered", !after.includes("s-offline") && !after.includes("p-offline"), after.filter((t) => !t.startsWith("bulk")));

  console.log("[9] an endpoint that does not know its exclusions");
  // An older client routes every history read directly. Its boot backfill of `team.>` asks for the
  // create row the mint withheld, so the broker refuses and the start fails loudly.
  await X.ep.stop();
  const Y = mkEp({ routed: false });
  const boot = await refusal(Y.ep.start());
  check("its start is broker-refused at the backfill, never served", boot !== undefined && /permission/i.test(boot), boot);
  check("it read no excluded row", !Y.got.some((g) => ["s-1", "p-1"].includes(g.text)), Y.got);
  await Y.ep.stop().catch(() => {});

  const rawConn = async (profile: "admin" | "channel-purger") => {
    const id = newIdentity();
    return connect({ servers: SERVERS, inboxPrefix: `_INBOX_${id.id}`, authenticator: credsAuthenticator(enc(await mintCreds(auth, id, profile))) });
  };
  const adminNc = await rawConn("admin");
  const adminJsm = await jetstreamManager(adminNc);
  const lastSeq = async () => (await adminJsm.streams.info(chatStream(space))).state.last_seq;
  type Row = { seq: number; message: CotalMessage };
  type RangePage = { items: Row[]; untilSeq: number; next: number; done: boolean };
  const rowsOf = (rows: Row[]) => JSON.stringify(rows.map((r) => [r.seq, textOf(r.message).slice(0, 12)]));
  const reach = (ep: CotalEndpoint) => ep as unknown as {
    requestDelivery(op: string, args: Record<string, unknown>): Promise<ControlReply>;
    history: { readRange(filter: string, opts: { fromSeq: number; untilSeq?: number }): Promise<Row[]> };
  };
  X = mkEp({ routed: true });
  await X.ep.start();
  await sleep(800);
  const range = async (args: Record<string, unknown>) => {
    const r = await reach(X.ep).requestDelivery("readRange", args);
    return { ...r, page: r.data as RangePage };
  };

  console.log("[10] channelHistory is a view route");
  const viewOnly = await refusal(X.ep.channelHistory("team.a", { limit: 5 }));
  check("the agent's channelHistory is broker-refused, as for every agent credential", viewOnly !== undefined && /permission/i.test(viewOnly), viewOnly);
  const obsId = newIdentity();
  const obs = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, obsId, "observer"), card: { id: obsId.id, name: "obs", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  await obs.start();
  const byXena = (await obs.channelHistory("team.a", { limit: 5, publisher: X.ep.principal })).map(textOf);
  check("an observer view reads the channel by publisher", JSON.stringify(byXena) === JSON.stringify(["x-a"]), byXena);
  await obs.stop();

  console.log("[11] a mediated page honors its signal");
  const pre = await refusal(X.ep.channelHistoryPage("team.a", { limit: 5, signal: AbortSignal.abort(new Error("caller gave up")) }));
  check("an aborted signal rejects with the caller's reason", pre === "caller gave up", pre);
  const ac = new AbortController();
  const inflight = X.ep.channelHistoryPage("team.a", { limit: 5, signal: ac.signal });
  ac.abort(new Error("caller left mid-read"));
  const mid = await refusal(inflight);
  check("an abort during the read rejects with its reason", mid === "caller left mid-read", mid);

  console.log("[12] the mediated range read");
  const s0 = (await lastSeq()) + 1;
  for (let i = 0; i < 550; i++) {
    await poster.multicast(`gap-s-${i}`, { channel: "team.secret" });
    await poster.multicast(`gap-p-${i}`, { channel: "team.f.private" });
  }
  await poster.multicast("after-gap", { channel: "team.a" });
  const gapEnd = await lastSeq();
  const g1 = await range({ filter: "team.>", fromSeq: s0 });
  check("a family page over 1000 excluded rows stops at the scan budget with no row and moves past them",
    g1.ok && g1.page.items.length === 0 && !g1.page.done && g1.page.next === s0 + 1000 && g1.page.untilSeq === gapEnd, { ...g1, s0, gapEnd });
  const drained = await reach(X.ep).history.readRange("team.>", { fromSeq: s0 });
  check("the drain returns only the sibling after the excluded stretch, at its sequence", rowsOf(drained) === JSON.stringify([[gapEnd, "after-gap"]]), rowsOf(drained));
  const f0 = (await lastSeq()) + 1;
  for (const t of ["pin-1", "pin-2", "pin-3"]) await poster.multicast(t, { channel: "team.a" });
  const q1 = await range({ filter: "team.a", fromSeq: f0, limit: 1 });
  check("a one-row page pins the frontier at the newest row",
    q1.ok && rowsOf(q1.page.items) === JSON.stringify([[f0, "pin-1"]]) && q1.page.untilSeq === f0 + 2 && q1.page.next === f0 + 1 && !q1.page.done, { ...q1, f0 });
  await poster.multicast("pin-late", { channel: "team.a" });
  const q2 = await range({ filter: "team.a", fromSeq: q1.page.next, untilSeq: q1.page.untilSeq });
  check("the next page stops at the pinned frontier, without the later post",
    q2.ok && rowsOf(q2.page.items) === JSON.stringify([[f0 + 1, "pin-2"], [f0 + 2, "pin-3"]]) && q2.page.done, q2);
  const big = "b".repeat(Math.floor(maxPayload * 0.4));
  const b0 = (await lastSeq()) + 1;
  for (const t of ["big-1", "big-2", "big-3"]) await poster.multicast(`${t} ${big}`, { channel: "team.big" });
  const split: number[][] = [];
  for (let from = b0, until: number | undefined; split.length < 5;) {
    const r = await range({ filter: "team.big", fromSeq: from, ...(until !== undefined ? { untilSeq: until } : {}) });
    if (!r.ok) { split.push([-1]); break; }
    split.push(r.page.items.map((i) => i.seq));
    if (r.page.done) break;
    from = r.page.next; until = r.page.untilSeq;
  }
  check("rows that do not fit one reply are split across pages, none lost", JSON.stringify(split) === JSON.stringify([[b0, b0 + 1], [b0 + 2]]), split);

  console.log("[13] live ACL changes");
  const principal = `${DEV_OWNER}.${ident.id}`;
  await poster.multicast("d-1", { channel: "team.d" });
  await mgr.commitAcl(principal, uid, ["team.>"], ["team.secret", "team.*.private", "team.d"]);
  await sleep(300);
  const narrowed = await X.ep.joinChannel("team.d").then((r) => ({ resolved: r }), (e: Error) => ({ refused: e.message }));
  check("a join of a channel the live row now excludes is refused, never an empty backfill", "refused" in narrowed, narrowed);
  await X.ep.stop();
  await sleep(300);
  await poster.multicast("d-narrowed", { channel: "team.d", mentions: ["xena"] });
  await poster.multicast("a-narrowed", { channel: "team.a", mentions: ["xena"] });
  await sleep(600);
  X = mkEp({ routed: true });
  await X.ep.start();
  await sleep(1500);
  const afterNarrow = X.got.map((g) => g.text);
  check("the sibling copy and mention are delivered", afterNarrow.includes("a-narrowed"), afterNarrow.filter((t) => /narrowed/.test(t)));
  check("the narrowed channel's copy and mention are withheld", !afterNarrow.includes("d-narrowed") && !afterNarrow.includes("d-1"), afterNarrow.filter((t) => /^d-/.test(t)));
  await mgr.commitAcl(principal, uid, ["team.>"], []);
  await sleep(300);
  const widened = await reach(X.ep).history.readRange("team.>", { fromSeq: s0 });
  check("a live row that drops every exclusion still keeps the credential's own", !widened.some((r) => /^gap-/.test(textOf(r.message))) && widened.some((r) => textOf(r.message) === "after-gap"), widened.length);
  check("the excluded page stays refused", await refusal(X.ep.channelHistoryPage("team.secret", { limit: 5 })) !== undefined);

  console.log("[14] a resume floor bounds the mediated boot backfill");
  await X.ep.stop();
  const floored = new CotalEndpoint({
    space, servers: SERVERS, creds, card: { name: "xena", kind: "agent", id: ident.id }, channels: ["team.>"], lifecycleUid: uid,
    allowSubscribe: def.allowSubscribe, excludeSubscribe: def.excludeSubscribe, backfillFloor: f0,
  });
  const flooredGot: string[] = [];
  floored.on("error", () => {});
  floored.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => { if (meta?.historical) flooredGot.push(textOf(m).slice(0, 12)); d.ack(); });
  await floored.start();
  await sleep(1200);
  check("the backfill starts after the floor", !flooredGot.includes("pin-1") && !flooredGot.includes("a-1") && flooredGot.includes("pin-2") && flooredGot.includes("pin-late"), flooredGot.filter((t) => !t.startsWith("big-")));
  await floored.stop();

  console.log("[15] a purge during a range read");
  X = mkEp({ routed: true });
  await X.ep.start();
  const zId = newIdentity(), zUid = mintLifecycleUid();
  const zCreds = await provisionAgent(mgr, auth, zId, { subscribe: [], allowSubscribe: ["zone.>"], allowPublish: [], brokerVersion, lifecycleUid: zUid });
  const Z = new CotalEndpoint({ space, servers: SERVERS, creds: zCreds, card: { name: "zed", kind: "agent", id: zId.id }, channels: [], lifecycleUid: zUid, watchPresence: false, registerPresence: false });
  Z.on("error", () => {});
  await Z.start();
  const purgerNc = await rawConn("channel-purger");
  const purgerJsm = await jetstreamManager(purgerNc);
  const purgeTrace: unknown[] = [];
  let served = true;
  for (let attempt = 0; attempt < 6; attempt++) {
    const p0 = (await lastSeq()) + 1;
    for (let i = 0; i < 900; i++) await poster.multicast(`purged-${attempt}-${i}`, { channel: "team.secret" });
    const read = range({ filter: "team.>", fromSeq: p0 }).then((r) => (r.ok ? "answered" : `refused: ${r.error}`), (e: Error) => `failed: ${e.message}`);
    await sleep(attempt * 3);
    await purgerJsm.streams.purge(chatStream(space), { filter: chatSubject(space, "*", "*", "team.secret") });
    const outcome = await read;
    const zJoin = await Z.joinChannel(`zone.z${attempt}`);
    purgeTrace.push({ attempt, outcome, zDurable: zJoin.durable, reason: zJoin.reason });
    if (/failed/.test(outcome) || !zJoin.durable) { served = false; break; }
  }
  check("every range read answers and another principal's join keeps its durable row", served, purgeTrace);
  await Z.stop();
  await purgerNc.close();

  console.log("[16] a row too large for any reply");
  // The largest post the broker takes, once wrapped with its sequence, exceeds the reply budget.
  let huge: number | undefined;
  for (let n = maxPayload - 200; n > maxPayload - 3000 && huge === undefined; n -= 25) {
    try { await poster.multicast("h".repeat(n), { channel: "team.huge" }); huge = await lastSeq(); } catch { /* larger than the broker takes */ }
  }
  const h = huge === undefined ? undefined : await range({ filter: "team.huge", fromSeq: huge });
  check("it is refused loudly, never skipped", h !== undefined && !h.ok && /exceeds the reply budget/.test(h.error ?? ""), { huge, ok: h?.ok, error: h?.error });
  await X.ep.stop();
  await adminNc.close();

  console.log(`\nE2E EXCLUSIONS ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
  await Promise.all([dlv.stop(), poster.stop(), mgr.stop()]);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", e);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await new Promise<void>((r) => { if (srv.exitCode !== null || srv.signalCode !== null) r(); else { srv.once("exit", () => r()); setTimeout(r, 3000); } });
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(process.exitCode ?? (fail ? 1 : 0));

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
  type CotalMessage, type Delivery, type MessageMeta,
} from "../src/index.js";
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
  const recallSecret = await X.ep.recallChannel("team.secret", 0);
  check("recall of the excluded channel answers nothing", recallSecret.unanswered && recallSecret.messages.length === 0, recallSecret);

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

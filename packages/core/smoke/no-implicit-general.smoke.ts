/**
 * NO IMPLICIT #general.
 *
 * An agent reads exactly the channels it lists. Omitting the read set means NO channels, not
 * `general`. Before this, four separate places defaulted an absent read set to `["general"]` — the
 * agent-file loader, the provisioner, the mint, and the endpoint — so a persona that simply did not
 * mention channels (every DM-only reviewer, every probe seat) was subscribed to `general` by code
 * and had the matching channel read row baked into its credential. Nobody chose that channel; the
 * absence of a field did.
 *
 * WHAT IS GRADED HERE, and each cell is the observable consequence rather than the constant:
 *
 *   1. THE LOADER. A persona with `allowSubscribe: [ops]` and no `subscribe` LOADS. Under the old
 *      default it threw — the invented `general` read set was not within its own read ACL, so a
 *      perfectly coherent file was rejected by a channel it never named. That throw is the cell:
 *      it fails loud in exactly one direction, so it can be asserted without reading a private
 *      variable. `subscribe: [general]` still round-trips, so the seeded onboarding personas (which
 *      list it) are untouched.
 *
 *   2. THE CREDENTIAL, measured at the broker rather than read off the mint. An agent provisioned
 *      with no read set gets NO channel row: a native subscribe on `chat.*.*.general` is DENIED by
 *      nats-server. The mint is the wrong place to look — a JWT that lists no row and a broker that
 *      refuses the subscribe are different claims, and only the second one is the boundary.
 *
 *   3. THE REST OF THE CRED IS UNAFFECTED, which is the half that makes this safe. That same
 *      channel-less agent — provisioned with `allowPublish: []`, the empty-array form — still sends
 *      and receives DMs and still appears on the roster. "Default-deny for channels" must not
 *      quietly mean "default-deny for everything": an agent with no channel is a full mesh peer,
 *      just a quiet one.
 *
 *   4. THE SEND REFUSAL. With no concrete channel there is no default destination, so `multicast`
 *      with no explicit channel THROWS. The old code picked `general` here too, which for a scoped
 *      agent meant a broker denial, and for an open one meant a broadcast to a channel the caller
 *      never named. A refusal the caller can read beats both.
 *
 *   5. LEAVING YOUR LAST CHANNEL. Allowed, and always was — the `cotal_leave` tool description said
 *      "you can't leave your only channel", which was simply false (`leaveChannel` has no such
 *      guard). This walks it: on one channel, send works; leave it, send with no channel refuses;
 *      re-join, send works again. The description now says what this cell proves.
 *
 * WHAT THIS CANNOT SEE: the connector's own env-level resolution (`configFromEnv`) is graded in its
 * own package, not here. This suite imports core by RELATIVE specifier (`../src/index.js`), so the
 * bytes it grades are the source you just edited, with no build in between.
 *
 * Run: pnpm smoke:no-implicit-general   (needs `nats-server` on PATH; spins its own JWT-auth broker)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";
import {
  chatSubject,
  createSpaceAuth,
  CotalEndpoint,
  DEV_OWNER,
  isReachable,
  loadAgentFile,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  principalKey,
  provisionAgent,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
  type AgentDef,
  type CotalMessage,
  type Delivery,
} from "../src/index.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: CotalMessage): string => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
/** The message a rejected call actually carried, or "" when it did not reject at all. */
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

// ---- 1. the loader, no broker needed ----------------------------------------------------------
console.log("\nloader:");
const files = mkdtempSync(join(tmpdir(), "no-implicit-general-personas-"));
const persona = (name: string, frontmatter: string): string => {
  const path = join(files, `${name}.md`);
  writeFileSync(path, `---\nname: ${name}\n${frontmatter}---\n\nbody\n`);
  return path;
};

// The discriminating shape: a read ACL that does NOT contain `general`, and no `subscribe`. The old
// default invented `general` as the active read set and then rejected the file for reading outside
// its own ACL. An omitted read set is now empty, which is within every ACL, so the file loads.
// The load is wrapped rather than called bare on purpose: the regression is a THROW, and a bare call
// would abort the suite before the cell could name itself, which grades as an unattributed red.
let scoped: AgentDef | undefined;
const scopedErr = await refusal(async () => { scoped = loadAgentFile(persona("scoped-reader", "allowSubscribe: [ops]\n")); });
check("a persona with a read ACL and no subscribe loads (an omitted read set is empty, not general)", scopedErr === "" && scoped?.subscribe === undefined, scopedErr || scoped?.subscribe);

// The DM-only seat: nothing about channels at all. It must carry no channel set of any kind.
const dmOnly = loadAgentFile(persona("dm-only", "role: reviewer\n"));
check("a persona that names no channel at all carries none", dmOnly.subscribe === undefined && dmOnly.allowSubscribe === undefined, { s: dmOnly.subscribe, a: dmOnly.allowSubscribe });

// Explicitly listing `general` is untouched — the seeded onboarding personas do exactly this.
const listsGeneral = loadAgentFile(persona("listy", "subscribe: [general]\nallowPublish: [general]\n"));
check("a persona that lists general still gets general", JSON.stringify(listsGeneral.subscribe) === JSON.stringify(["general"]), listsGeneral.subscribe);

// Coherence, not an accident of the default: with no read set there is nothing to silence, so a
// `quiet:` entry is a config error rather than a silent no-op against an invented `general`.
const quietErr = await refusal(async () => loadAgentFile(persona("quiet-nothing", "quiet: [general]\n")));
check("quieting a channel you do not read fails loud", /not within your read ACL/.test(quietErr), quietErr);

// ---- broker ------------------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort();
const space = "nogeneral";
const server = `nats://127.0.0.1:${port}`;
const storeDir = join(dir, "nats");
const conf = join(dir, "nogeneral.conf");
const log = join(dir, "nogeneral.log");
mkdirSync(storeDir, { recursive: true });
const auth = await createSpaceAuth(space);
writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir }));
const fd = openSync(log, "w");
const child = spawn("nats-server", ["-c", conf], { stdio: ["ignore", fd, fd] });
const releaseBroker = teardownOnSignal(child, dir);

const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
let up = false;
for (let i = 0; i < 50; i++) {
  if (child.exitCode !== null) break;
  if (await isReachable(server, { creds: provCreds })) {
    up = true;
    break;
  }
  await wait(200);
}
if (!up) throw new Error(`server not up (exit ${child.exitCode}):\n${readFileSync(log, "utf8")}`);

await setupSpaceStreams({ servers: server, space, creds: provCreds });
await seedChannelRegistry({
  servers: server,
  space,
  creds: provCreds,
  file: { defaults: { replay: false }, channels: { general: {}, ops: {} } },
});

const prov = new CotalEndpoint({
  space, servers: server, creds: provCreds, card: { name: "prov", kind: "endpoint" },
  channels: [], consume: false, watchPresence: false, registerPresence: false,
});
prov.on("error", (e: Error) => console.log("prov err:", e.message));
await prov.start();

const poster = new CotalEndpoint({
  space, servers: server, creds: await mintCreds(auth, newIdentity(), "operator"),
  card: { name: "poster", kind: "endpoint" }, channels: [], consume: false,
  watchPresence: false, registerPresence: false,
});
poster.on("error", (e: Error) => console.log("poster err:", e.message));
await poster.start();

/** "denied" iff nats-server refuses the native subscribe on this subject under these creds. */
async function subscribeAllowed(creds: string, id: string, subject: string): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: server,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  let perm = false;
  void (async () => {
    for await (const s of nc.status()) if (/permission|authorization/i.test(JSON.stringify(s))) perm = true;
  })().catch(() => {});
  let cbDenied = false;
  try {
    const sub = nc.subscribe(subject, { callback: (err) => { if (err) cbDenied = true; } });
    await nc.flush().catch(() => { cbDenied = true; });
    await wait(350);
    try { sub.unsubscribe(); } catch { /* ignore */ }
    return perm || cbDenied ? "denied" : "allowed";
  } finally {
    await nc.drain().catch(() => {});
  }
}

// ---- 2 + 3. the channel-less agent: no channel row, everything else intact ---------------------
console.log("\ncredential:");
// Provisioned exactly as a DM-only persona resolves: no subscribe, no allowSubscribe, and the
// EMPTY-ARRAY form of allowPublish (the shape that must mean "no channels", never "no publishing").
const quietId = newIdentity();
const quietUid = mintLifecycleUid();
// `role` is provisioned as usual: a role is an anycast address, not a channel, and the point of this
// suite is that dropping the channel default drops NOTHING else.
const quietCreds = await provisionAgent(prov, auth, quietId, { allowPublish: [], role: "reviewer", lifecycleUid: quietUid });

check(
  "a persona with no read set mints NO channel read row: the broker denies chat.*.*.general",
  (await subscribeAllowed(quietCreds, quietId.id, chatSubject(space, "*", "*", "general"))) === "denied",
);
check(
  "and no channel row for anything else either, so this is default-deny and not a general-shaped hole",
  (await subscribeAllowed(quietCreds, quietId.id, chatSubject(space, "*", "*", "ops"))) === "denied",
);

// The peer that talks to it: on `general`, exactly like a seeded onboarding persona.
const talkerId = newIdentity();
const talkerUid = mintLifecycleUid();
const talkerAcl = { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] };
const talkerCreds = await provisionAgent(prov, auth, talkerId, { ...talkerAcl, role: "planner", lifecycleUid: talkerUid });
check(
  "a persona that LISTS general keeps its channel read row (the seeded onboarding personas are untouched)",
  (await subscribeAllowed(talkerCreds, talkerId.id, chatSubject(space, "*", "*", "general"))) === "allowed",
);

const quietGot: string[] = [];
const quietAgent = new CotalEndpoint({
  space, servers: server, creds: quietCreds, lifecycleUid: quietUid,
  card: { id: quietId.id, name: "quiet", role: "reviewer", kind: "agent" },
  heartbeatMs: 500, ttlMs: 2000,
});
const quietErrors: string[] = [];
quietAgent.on("error", (e: Error) => quietErrors.push(e.message));
quietAgent.on("message", (m: CotalMessage, d: Delivery) => { quietGot.push(`${m.to ? "DM" : `#${m.channel}`}:${textOf(m)}`); d.ack(); });
await quietAgent.start();

const talkerGot: string[] = [];
const talker = new CotalEndpoint({
  space, servers: server, creds: talkerCreds, lifecycleUid: talkerUid,
  card: { id: talkerId.id, name: "talker", role: "planner", kind: "agent" },
  channels: ["general"], heartbeatMs: 500, ttlMs: 2000,
});
talker.on("error", (e: Error) => console.log("talker err:", e.message));
talker.on("message", (m: CotalMessage, d: Delivery) => { talkerGot.push(`${m.to ? "DM" : `#${m.channel}`}:${textOf(m)}`); d.ack(); });
await talker.start();
await wait(800);

console.log("\nno channel, still a peer:");
check("an endpoint given no channels joins none", quietAgent.joinedChannels().length === 0, quietAgent.joinedChannels());
check("connecting with no channel raises no permission error", quietErrors.length === 0, quietErrors);

// #general traffic exists and does NOT reach it — the whole point of the change.
await poster.multicast("general chatter", { channel: "general" });
await wait(500);
check("a #general post reaches the agent that listed it", talkerGot.includes("#general:general chatter"), talkerGot);
check("and NOT the agent that listed no channel", !quietGot.some((g) => g.startsWith("#general")), quietGot);

// The DM rails are untouched, both directions, with allowPublish: [].
const quietPrincipal = principalKey(DEV_OWNER, quietId.id).key;
const talkerPrincipal = principalKey(DEV_OWNER, talkerId.id).key;
await talker.unicast(quietPrincipal, "can you review this");
await wait(400);
check("a channel-less agent still RECEIVES DMs", quietGot.includes("DM:can you review this"), quietGot);

const dmOut = await refusal(async () => quietAgent.unicast(talkerPrincipal, "on it"));
await wait(400);
check("an agent minted with allowPublish: [] can still SEND a DM (empty means no channels, not no publishing)", dmOut === "", dmOut);
check("and the DM arrives", talkerGot.includes("DM:on it"), talkerGot);
check("a channel-less agent is on the roster", talker.getRoster().some((p) => p.card.name === "quiet"));

// ---- 4. no default send channel ----------------------------------------------------------------
console.log("\nsend refusal:");
const noDefault = await refusal(async () => quietAgent.multicast("who is listening"));
check("multicast with no channel and no subscription REFUSES", /no default channel/.test(noDefault), noDefault);
check("and the refusal says what to do about it", /name a channel explicitly, or join one first/.test(noDefault), noDefault);
check("it does not fall back to general", !/general/.test(noDefault), noDefault);

// ---- 5. leaving your last channel ---------------------------------------------------------------
console.log("\nleave your last channel:");
const soloId = newIdentity();
const soloUid = mintLifecycleUid();
const soloAcl = { subscribe: ["ops"], allowSubscribe: ["ops"], allowPublish: ["ops"] };
const soloCreds = await provisionAgent(prov, auth, soloId, { ...soloAcl, role: "builder", lifecycleUid: soloUid });
const solo = new CotalEndpoint({
  space, servers: server, creds: soloCreds, lifecycleUid: soloUid,
  card: { id: soloId.id, name: "solo", role: "builder", kind: "agent" },
  channels: ["ops"], heartbeatMs: 500, ttlMs: 2000,
});
solo.on("error", (e: Error) => console.log("solo err:", e.message));
await solo.start();
await wait(400);

const beforeLeave = await refusal(async () => solo.multicast("still here"));
check("on its only channel, a no-channel send resolves to that channel", beforeLeave === "", beforeLeave);

const left = await solo.leaveChannel("ops");
check("leaving your ONLY channel is allowed", left.left === true, left);
check("and leaves you on no channel", solo.joinedChannels().length === 0, solo.joinedChannels());

const afterLeave = await refusal(async () => solo.multicast("anyone"));
check("after leaving your last channel, a no-channel send refuses", /no default channel/.test(afterLeave), afterLeave);

const rejoined = await solo.joinChannel("ops");
check("re-joining restores the default send channel", rejoined.joined === true, rejoined);
const afterRejoin = await refusal(async () => solo.multicast("back"));
check("and the send works again", afterRejoin === "", afterRejoin);

// ---- teardown ------------------------------------------------------------------------------------
console.log(`\nno-implicit-general: ${pass} passed, ${fail} failed`);
await solo.stop();
await talker.stop();
await quietAgent.stop();
await poster.stop();
await prov.stop();
await killAndAwaitExit(child, "SIGTERM");
rmSync(dir, { recursive: true, force: true });
rmSync(files, { recursive: true, force: true });
releaseBroker();
process.exit(fail === 0 ? 0 : 1);

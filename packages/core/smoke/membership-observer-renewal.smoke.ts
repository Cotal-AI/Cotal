/**
 * MEMBERSHIP-OBSERVER RENEWAL: conn A of the graph feed (the $SYS CONNZ reader) adopts a re-minted
 * observer cred from a source, the same prove-then-adopt way conn B adopts its rw cred. On a real
 * broker with short-lived creds:
 *
 *   - STATIC (the original shape): a literal observer cred expires, the broker closes conn A, and a
 *     member who joins afterwards never reaches the feed;
 *   - SAME ISSUER: a source that re-mints under the same system signer and scope (new user nkey) is
 *     adopted at 75% of the lifetime; a member who joins after the first cred's expiry reaches the
 *     feed, and the broker holds one observer connection;
 *   - RECONNECT: after a broker restart conn A comes back on the proven cred and sees a new member;
 *   - WRONG ISSUER / WRONG ACCOUNT: refused before any preflight, nothing adopted;
 *   - SOURCE FAILURE: logged as a refresh failure, nothing adopted;
 *   - STOP DURING REFRESH: a source still pending at stop() leaves no observer connection behind.
 *
 * Run: pnpm smoke:membership-observer-renewal   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  isReachable, createSpaceAuth, mintCreds, mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams,
  startMembershipFeed, provisionAgent, mintLifecycleUid, chatSubject, membershipBucket, membershipKey, principalKey,
  DEV_OWNER, type MembershipFeedHandle,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, budgetMs: number, stepMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { if (await cond()) return true; await wait(stepMs); }
  return await cond();
};
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const noop = { commitAcl: async () => {}, reissueAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `member-obs-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const other = await createSpaceAuth(space); // a different system signer and data account
const accountId = auth.account.pub;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
let releaseBroker = (): void => {};
const startBroker = (): ChildProcess => {
  releaseBroker();
  const p = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(p, dir);
  return p;
};
let srv = startBroker();
const waitReachable = async (): Promise<void> => {
  if (!(await until(() => isReachable(SERVERS), 15_000, 200))) throw new Error(`nats-server did not come up on ${PORT}`);
};

// Observer creds with an explicit lifetime: same issuer + scope as the provisioned one.
const observer = (ttl: number, a = auth) => mintMembershipObserverCreds(a, newIdentity(), { expiresInSeconds: ttl });
// Same system signer, scoped to ANOTHER data account: an issuer-preserving scope change.
const otherScopeObserver = (ttl: number) => mintMembershipObserverCreds({ ...auth, account: other.account }, newIdentity(), { expiresInSeconds: ttl });

// The broker's own connection table, by connection name, through a SERVER.PING.CONNZ-only probe.
const probeId = newIdentity();
const probeJwt = await encodeUser("membership-connz-probe", fromPublic(probeId.id), fromPublic(auth.sys.pub),
  { pub: { allow: ["$SYS.REQ.SERVER.PING.CONNZ"] }, sub: { allow: [`_INBOX_${probeId.id}.>`] } },
  { signer: fromSeed(enc(auth.sys.signingSeed as string)) });
const probeCreds = `-----BEGIN NATS USER JWT-----\n${probeJwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${probeId.seed}\n------END USER NKEY SEED------\n`;
const countObserverConns = async (): Promise<number> => {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(probeCreds)), inboxPrefix: `_INBOX_${probeId.id}`, maxReconnectAttempts: 0 });
  try {
    const r = await nc.request("$SYS.REQ.SERVER.PING.CONNZ", enc(JSON.stringify({ auth: true, limit: 1024 })), { timeout: 3_000 });
    return (r.json<{ data?: { connections?: Array<{ name?: string }> } }>().data?.connections ?? []).filter((c) => c.name === "cotal-membership-observer").length;
  } finally { await nc.close(); }
};

const live: NatsConnection[] = [];
// A new member: a real agent connection subscribed to `channel`, joining NOW.
const join_ = async (channel: string): Promise<string> => {
  const id = newIdentity();
  const creds = await provisionAgent(noop, auth, id, { subscribe: [channel], allowSubscribe: [channel], lifecycleUid: mintLifecycleUid() });
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(creds)), name: `cotal:${channel}` });
  live.push(nc);
  nc.subscribe(chatSubject(space, "*", "*", channel));
  await nc.flush();
  return principalKey(DEV_OWNER, id.id).key;
};
const readerCred = await mintCreds(auth, newIdentity(), "membership-rw", { expiresInSeconds: 3600 });
// Did the feed publish `key` with `channel` live? A real read of the bucket the feed writes.
const feedHas = async (key: string, channel: string): Promise<boolean> => {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(readerCred)), inboxPrefix: `_INBOX_${credsSub(readerCred)}`, maxReconnectAttempts: 0 });
  try {
    const e = await (await new Kvm(nc).open(membershipBucket(space))).get(membershipKey(key));
    return !!e && e.length > 0 && (e.json<{ live?: string[] }>().live ?? []).includes(channel);
  } finally { await nc.close(); }
};
function credsSub(c: string): string {
  return JSON.parse(Buffer.from(c.split("\n")[1].split(".")[1], "base64url").toString()).sub as string;
}
const sees = async (f: MembershipFeedHandle, key: string, channel: string, budget = 6_000) =>
  until(async () => { await f.poll(); return feedHas(key, channel); }, budget, 300);
const start = async (observerCreds: string | (() => string | Promise<string>), logs: string[]) =>
  startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, intervalMs: 60_000,
    rwCreds: await mintCreds(auth, newIdentity(), "membership-rw", { expiresInSeconds: 3600 }),
    log: (m) => logs.push(m),
  });

let feed: MembershipFeedHandle | undefined;
try {
  await waitReachable();
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ---- 1: STATIC observer, the original shape: expiry ends membership observation ----
  {
    const logs: string[] = [];
    feed = await start(await observer(3), logs);
    const before = await join_("static-before");
    check("static: a member who joined before expiry reaches the feed (positive control)", await sees(feed, before, "static-before"));
    await wait(4_500);
    const after = await join_("static-after");
    check("static: after the observer's expiry a new member never reaches the feed", !(await sees(feed, after, "static-after", 3_000)), logs);
    check("static: the broker holds no observer connection after expiry", (await countObserverConns()) === 0);
    await feed.stop(); feed = undefined;
  }

  // ---- 2: SAME ISSUER renewal from a source, then a reconnect on the proven cred ----
  {
    const logs: string[] = [];
    let reads = 0;
    feed = await start(async () => (++reads === 1 ? observer(4) : observer(3600)), logs);
    await wait(5_500); // past the first cred's exp; the 75% timer fired at ~3s
    check("same issuer: the source was re-read by the renewal timer", reads >= 2, { reads, logs });
    const after = await join_("renewed-after");
    check("same issuer: a member who joined after the first cred's expiry reaches the feed", await sees(feed, after, "renewed-after"), logs);
    check("same issuer: the broker holds exactly one observer connection", (await countObserverConns()) === 1);
    srv.kill("SIGKILL");
    await wait(300);
    srv = startBroker();
    await waitReachable();
    const restarted = await join_("after-restart");
    check("reconnect: after a broker restart conn A sees a new member on the proven cred", await sees(feed, restarted, "after-restart", 15_000), logs);
    await feed.stop(); feed = undefined;
    check("same issuer: stop leaves no observer connection", await until(async () => (await countObserverConns()) === 0, 3_000, 200));
  }

  // ---- 3: refusals. Each starts on a 4s cred; the timer reads a bad candidate at ~3s ----
  const refusal = async (label: string, candidate: () => Promise<string>, needle: string): Promise<void> => {
    const logs: string[] = [];
    let reads = 0;
    feed = await start(async () => (++reads === 1 ? observer(4) : candidate()), logs);
    await wait(5_500);
    check(`${label}: refused with the named reason`, logs.some((l) => l.includes(needle)), logs);
    check(`${label}: nothing adopted, so conn A is gone at the first cred's expiry`, (await countObserverConns()) === 0, logs);
    const after = await join_(`${label.replace(/\W/g, "-")}-after`);
    check(`${label}: a later member does not reach the feed (no faked readiness)`, !(await sees(feed, after, `${label.replace(/\W/g, "-")}-after`, 2_000)));
    await feed.stop(); feed = undefined;
  };
  await refusal("wrong issuer", () => observer(3600, { ...auth, sys: other.sys }), "different issuer");
  await refusal("wrong account", () => otherScopeObserver(3600), "different permission scope");
  await refusal("source failure", async () => { throw new Error("store unavailable"); }, "store unavailable");

  // ---- 4: STOP while a refresh is waiting on the source ----
  {
    const logs: string[] = [];
    let reads = 0;
    let release: (c: string) => void = () => {};
    const pending = new Promise<string>((r) => { release = r; });
    feed = await start(async () => (++reads === 1 ? observer(4) : pending), logs);
    await until(() => reads >= 2, 6_000, 100);
    check("stop during refresh: the refresh is waiting on the source", reads >= 2);
    const stopping = feed.stop();
    release(await observer(3600));
    await stopping; feed = undefined;
    await wait(1_000);
    check("stop during refresh: no observer connection remains", (await countObserverConns()) === 0, logs);
  }

  console.log(`\n${fail ? "✗" : "✓"} MEMBERSHIP-OBSERVER RENEWAL ${pass}/${pass + fail}`);
} finally {
  try { await feed?.stop(); } catch { /* draining */ }
  await Promise.allSettled(live.map((c) => c.close()));
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  await wait(200);
}
process.exit(fail ? 1 : 0);

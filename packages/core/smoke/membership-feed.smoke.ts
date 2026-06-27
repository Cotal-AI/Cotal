/**
 * membership-feed smoke (the broker-sourced graph membership, end-to-end). Proves the derived feed is
 * AUTHORITATIVE and broker-sourced — it surfaces SILENT subscribers (zero traffic), the UNION across an
 * agent's connections, the merge of `live` (CONNZ) ∪ `durable` (members registry), excludes god-view
 * taps, and prunes a live subscriber when it disconnects while keeping its durable arm.
 *
 * Spins up a real auth broker, mints the two scoped membership creds, connects silent subscribers + an
 * admin god-tap, seeds a durable member, runs the core feed, and reads the derived bucket back.
 *
 * Run: pnpm smoke:membership-feed:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  mintMembershipObserverCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  startMembershipFeed,
  openMembersRegistry,
  commitMember,
  chatSubject,
  chatWildcard,
  spaceWildcard,
  channelFromChatSubscription,
  membershipBucket,
  membershipKey,
  MEMBERSHIP_FEED_KEY,
} from "../src/index.js";
import type { ChannelMembership, MembershipRecord } from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eq = (a: string[] = [], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const noop = { commitAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };

const space = `membership-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space); // sys.signingSeed lives in-memory here — mint the observer below
const dir = mkdtempSync(join(tmpdir(), "cotal-membership-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const conns: Array<Awaited<ReturnType<typeof connect>>> = [];
let feed: Awaited<ReturnType<typeof startMembershipFeed>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds }); // creates the membership bucket
  const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const rwCreds = await mintCreds(auth, newIdentity(), "membership-rw");

  // --- alice: a SILENT live subscriber, subs split across TWO connections (union test) ---
  const alice = newIdentity();
  const aliceCreds = await provisionAgent(noop, auth, alice, { subscribe: ["general"], allowSubscribe: ["general", "review.>", "logs"] });
  const a1 = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(aliceCreds)), name: "cotal:alice" });
  conns.push(a1);
  a1.subscribe(chatSubject(space, "*", "general"));
  a1.subscribe(chatSubject(space, "*", "review.>")); // wildcard pattern preserved
  await a1.flush();
  const a1b = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(aliceCreds)), name: "cotal:alice" });
  conns.push(a1b);
  a1b.subscribe(chatSubject(space, "*", "logs")); // a second conn for the SAME nkey
  await a1b.flush();

  // --- bob: a durable member of #deploys (no live conn), written straight to the members registry ---
  // The members registry is the DELIVERY daemon's to write (closure (i): the manager cred no longer holds
  // a members-bucket grant). Seed with a `delivery` cred; it has no default `_INBOX`, so pin its per-id one.
  const bob = newIdentity();
  const seedId = newIdentity();
  const seedNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(await mintCreds(auth, seedId, "delivery"))), inboxPrefix: `_INBOX_${seedId.id}` });
  conns.push(seedNc);
  const members = await openMembersRegistry(seedNc, space);
  const rec = (channel: string, owner: string): MembershipRecord => ({ channel, owner, state: "durable-active", joinCursor: 0, activated: true, generation: 1, writerIdentity: "smoke", updatedAt: Date.now() });
  await commitMember(members, rec("deploys", bob.id));
  await commitMember(members, rec("general", alice.id)); // alice is ALSO a durable member of #general (live ∪ durable union)

  // --- a god-view tap (the web dashboard / a core tap) — must be EXCLUDED from membership ---
  const adminId = newIdentity();
  const adminCreds = await mintCreds(auth, adminId, "admin");
  // The admin cred's inbox grant is `_INBOX_<id>.>`, so its connection must use that prefix (as the real
  // CotalEndpoint does) for KV reads / ordered-consumer delivery to be allowed.
  const adminConn = () => connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(adminCreds)), inboxPrefix: `_INBOX_${adminId.id}`, name: "cotal:web" });
  const webNc = await adminConn();
  conns.push(webNc);
  webNc.subscribe(spaceWildcard(space)); // the whole-space god tap — self-excludes (yields no chat channel)
  await webNc.flush();

  // --- a console-style observer: taps chatWildcard (`cotal.<space>.chat.>`) like `cotal console`. Must
  // ALSO self-exclude, but via a DIFFERENT branch than the web tap (parseSubject's <5-token guard, not the
  // !startsWith(".chat.") guard) — mitnick flagged that only the web branch was tested; socrates suspected
  // a phantom reads-all node here. This pins that `cotal console` surfaces NO membership record. ---
  const consoleId = newIdentity();
  const consoleNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(await mintCreds(auth, consoleId, "observer"))), inboxPrefix: `_INBOX_${consoleId.id}`, name: "cotal:console" });
  conns.push(consoleNc);
  consoleNc.subscribe(chatWildcard(space)); // cotal.<space>.chat.> — the console observer tap
  await consoleNc.flush();

  // --- dave: a legitimate BROAD-READ agent (allowSubscribe [">"]) — e.g. the seeded default persona. Its
  // chat.*.> sub MUST surface as a `>` reader (the source-of-truth goal); it must NOT be dropped as if it
  // were a god-tap (review-general/socrates: shape-based exclusion wrongly erased exactly these). ---
  const dave = newIdentity();
  const daveCreds = await provisionAgent(noop, auth, dave, { subscribe: ["general"], allowSubscribe: [">"] });
  const dnc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(daveCreds)), name: "cotal:dave" });
  conns.push(dnc);
  dnc.subscribe(chatSubject(space, "*", ">")); // chat.*.> — reads everything
  await dnc.flush();

  // --- run the feed and force a reconcile ---
  feed = await startMembershipFeed({ servers: SERVERS, space, accountId: auth.account.pub, observerCreds, rwCreds, intervalMs: 60_000 });
  await feed.poll();
  await wait(400);

  const readNc = await adminConn();
  conns.push(readNc);
  const readFeed = async () => {
    const kv = await new Kvm(readNc).open(membershipBucket(space));
    const out = new Map<string, ChannelMembership>();
    let asOf: number | undefined;
    for await (const k of await kv.keys()) {
      const e = await kv.get(k); if (!e) continue;
      if (k === MEMBERSHIP_FEED_KEY) { asOf = e.json<{ observedAt: number }>().observedAt; continue; }
      out.set(k, e.json<ChannelMembership>());
    }
    return { out, asOf };
  };

  let { out, asOf } = await readFeed();
  const aliceRec = out.get(membershipKey(alice.id));
  const bobRec = out.get(membershipKey(bob.id));

  check("silent live subscriber appears (zero traffic)", !!aliceRec);
  check("live patterns unioned across an agent's connections (wildcards kept)", !!aliceRec && eq(aliceRec.live, ["general", "review.>", "logs"]), aliceRec?.live);
  check("alice's durable arm merged in (live ∪ durable)", !!aliceRec && eq(aliceRec.durable, ["general"]), aliceRec?.durable);
  check("durable-only member (no live conn) appears", !!bobRec && eq(bobRec.durable, ["deploys"]) && eq(bobRec.live, []), bobRec);
  const daveRec = out.get(membershipKey(dave.id));
  check("the web god-tap (whole-space sub) self-excludes (no membership record)", !out.has(membershipKey(adminId.id)), [...out.keys()]);
  check("a console-style chat.> tap self-excludes (no phantom reads-all node)", !out.has(membershipKey(consoleId.id)), [...out.keys()]);
  check("channelFromChatSubscription(chatWildcard) is null — pins the console parseSubject<5 branch", channelFromChatSubscription(space, chatWildcard(space)) === null);
  check("a broad-read agent (allowSubscribe '>') SURFACES as a `>` reader, not dropped", !!daveRec && daveRec.live.includes(">"), daveRec);
  check("only the three real agents have records (infra conns contribute nothing)", out.size === 3, [...out.keys()]);
  check("feed freshness heartbeat is stamped", typeof asOf === "number");

  // --- prune: alice's live connections drop; durable arm persists (the key reframe) ---
  await a1.drain(); await a1b.drain();
  await wait(300);
  await feed.poll();
  await wait(300);
  ({ out } = await readFeed());
  const aliceAfter = out.get(membershipKey(alice.id));
  check("a disconnected live subscriber keeps its durable membership", !!aliceAfter && eq(aliceAfter.durable, ["general"]), aliceAfter);
  check("a disconnected live subscriber's live set is pruned to empty", !!aliceAfter && eq(aliceAfter.live, []), aliceAfter?.live);

  // --- incomplete-sweep guard (review-general): a poll that gets ZERO CONNZ replies must NOT prune the
  // live half or advance the freshness heartbeat. Simulate deterministically by running a feed with a
  // MISMATCHED accountId, so the observer's CONNZ publish is denied (not in its pub.allow) → zero replies
  // → complete:false → reconcile early-returns. The good feed is stopped first so only this one runs. ---
  await feed.stop();
  const before = await readFeed();
  const beforeKeys = [...before.out.keys()].sort().join(",");
  feed = await startMembershipFeed({ servers: SERVERS, space, accountId: auth.sys.pub /* wrong acct → CONNZ pub denied */, observerCreds, rwCreds, intervalMs: 60_000, maxWaitMs: 500 });
  await feed.poll();
  await wait(300);
  const afterBad = await readFeed();
  check("an incomplete CONNZ sweep does NOT prune existing membership", [...afterBad.out.keys()].sort().join(",") === beforeKeys, [...afterBad.out.keys()]);
  check("an incomplete CONNZ sweep does NOT advance the freshness heartbeat", afterBad.asOf === before.asOf, { before: before.asOf, after: afterBad.asOf });

  console.log(`\nMEMBERSHIP-FEED SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await feed?.stop(); } catch { /* gone */ }
  for (const c of conns) { try { await c.drain(); } catch { /* already drained */ } }
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

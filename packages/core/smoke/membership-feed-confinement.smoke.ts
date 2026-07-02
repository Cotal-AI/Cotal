/**
 * membership-feed cred confinement smoke (the security NO-GO guard for the graph membership feed). Proves
 * the two scoped creds are least-privilege, NOT allow-all — negative deny-tests so a careless allowlist
 * loosening trips CI:
 *  - observer (SYSTEM account, conn A): CAN request the account-scoped CONNZ, but is DENIED server-wide
 *    PING.CONNZ and any other $SYS subject — i.e. it carries its OWN explicit perms block (a no-block
 *    system-account user would be allow-all = broker admin);
 *  - membership-rw (DATA account, conn B): CAN read the members KV + read/write the membership feed KV,
 *    but is DENIED chat post, members-KV WRITE, presence/ACL KV, and (account isolation) any $SYS;
 *  - admin/web (DATA account): CAN read the membership feed, CANNOT write it, and has no $SYS.
 *
 * Run: pnpm smoke:membership-feed-confinement:auth   (needs `nats-server` on PATH; auth/JetStream, local)
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
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  chatSubject,
  spacePrefix,
  membershipBucket,
  membersBucket,
  presenceBucket,
  aclBucket,
  membershipKey,
  connzRequestSubject,
  MEMBERSHIP_INBOX_PREFIX,
} from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

async function withConn<T>(creds: string, id: string, fn: (nc: Awaited<ReturnType<typeof connect>>, denied: () => boolean) => Promise<T>): Promise<T> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  let perm = false;
  void (async () => { for await (const s of nc.status()) { const blob = `${(s as { type?: string }).type ?? ""} ${(s as { data?: unknown }).data ?? ""}`; if (/permission|authorization/i.test(blob)) perm = true; } })().catch(() => {});
  try { return await fn(nc, () => perm); } finally { await nc.drain().catch(() => {}); }
}
async function trySubscribe(creds: string, id: string, subject: string, graceMs = 350): Promise<"allowed" | "denied"> {
  return withConn(creds, id, async (nc, denied) => {
    let cbDenied = false;
    const sub = nc.subscribe(subject, { callback: (err) => { if (err) cbDenied = true; } });
    await nc.flush().catch(() => { cbDenied = true; });
    await wait(graceMs);
    try { sub.unsubscribe(); } catch { /* ignore */ }
    return denied() || cbDenied ? "denied" : "allowed";
  });
}
async function publishArrives(listenCreds: string, pubCreds: string, pubId: string, subject: string): Promise<"allowed" | "denied"> {
  return withConn(listenCreds, `listen-${randomUUID().slice(0, 6)}`, async (lnc) => {
    let got = false;
    const sub = lnc.subscribe(subject, { callback: (err, m) => { if (!err && m) got = true; } });
    await lnc.flush().catch(() => {});
    await withConn(pubCreds, pubId, async (pnc) => { pnc.publish(subject, enc("x")); await pnc.flush().catch(() => {}); await wait(300); });
    await wait(150);
    try { sub.unsubscribe(); } catch { /* ignore */ }
    return got ? "allowed" : "denied";
  });
}
/** Resolve "allowed"/"denied" for a KV WRITE — the KV API awaits a JetStream ack, so a permission-denied
 *  `put` rejects (unlike a fire-and-forget raw publish, which no scoped cred can natively hear on `$KV.>`
 *  now that the allow-all `manager` listener is deleted). */
async function kvWriteAllowed(creds: string, id: string, bucket: string, key: string): Promise<"allowed" | "denied"> {
  return withConn(creds, id, async (nc) => {
    try {
      const kv = await new Kvm(nc).open(bucket);
      await kv.put(key, new TextEncoder().encode("x"));
      return "allowed";
    } catch (e) {
      // Only an authz rejection counts as "denied"; a non-authz failure (e.g. a bucket that wasn't
      // pre-created → "stream not found") must NOT masquerade as a permission denial and false-pass.
      const msg = (e as Error)?.message ?? "";
      if (/permission|authorization|not authorized/i.test(msg)) return "denied";
      throw e;
    }
  });
}
async function tryKvGet(creds: string, id: string, bucket: string, key: string): Promise<"allowed" | "denied"> {
  return withConn(creds, id, async (nc) => {
    try {
      const kv = await new Kvm(nc).open(bucket);
      await kv.get(key);
      return "allowed";
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (/permission|authorization|not authorized/i.test(msg)) return "denied";
      throw e; // a non-authz failure must not masquerade as a permission denial
    }
  });
}

const space = `membership-conf-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-memconf-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  // An `admin` LISTENER (space-wide `${p}.>` sub) is the arrival oracle for the `cotal.<space>.*` publish
  // checks below — the former allow-all `manager` listener is gone. ($KV.<bucket> writes use kvWriteAllowed;
  // this is NOT the web-admin cred the smoke TESTS below — that one is a publisher in its own check.)
  const adminListen = await mintCreds(auth, newIdentity(), "admin");

  // ---- conn A: the SYSTEM-account observer (explicit perms block; NOT allow-all) ----
  const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const obs = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(observerCreds)), inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0 });
  try {
    let connzOk = false;
    try { const r = await obs.request(connzRequestSubject(auth.account.pub), enc(JSON.stringify({ auth: true, subscriptions: true })), { timeout: 2000 }); connzOk = !!r.json(); } catch { /* */ }
    check("observer: account-scoped CONNZ request is allowed (gets a reply)", connzOk);
    let pingErr = "";
    try { await obs.request("$SYS.REQ.SERVER.PING.CONNZ", enc("{}"), { timeout: 1500 }); } catch (e) { pingErr = (e as Error).message; }
    check("observer: server-wide PING.CONNZ is DENIED (explicit block — no $SYS allow-all)", /permission/i.test(pingErr), pingErr);
    let claimsErr = "";
    try { await obs.request("$SYS.REQ.CLAIMS.LIST", enc("{}"), { timeout: 1500 }); } catch (e) { claimsErr = (e as Error).message; }
    check("observer: $SYS claims/admin verbs are DENIED", /permission/i.test(claimsErr), claimsErr);
  } finally { await obs.drain().catch(() => {}); }

  // ---- conn B: the DATA-account membership-rw cred ----
  const rw = newIdentity();
  const rwCreds = await mintCreds(auth, rw, "membership-rw");
  const owner = newIdentity().id;
  check("rw: read the members KV (durable arm) is allowed", (await tryKvGet(rwCreds, rw.id, membersBucket(space), `general/${owner}`)) === "allowed");
  check("rw: read the membership feed KV is allowed", (await tryKvGet(rwCreds, rw.id, membershipBucket(space), membershipKey(owner))) === "allowed");
  check("rw: WRITE the membership feed KV is allowed", (await kvWriteAllowed(rwCreds, rw.id, membershipBucket(space), membershipKey(owner))) === "allowed");
  check("rw: WRITE the members KV is DENIED (read-only on the durable arm)", (await kvWriteAllowed(rwCreds, rw.id, membersBucket(space), `general/${owner}`)) === "denied");
  check("rw: post to a chat channel is DENIED", (await publishArrives(adminListen, rwCreds, rw.id, chatSubject(space, rw.id, "general"))) === "denied");
  check("rw: native subscribe chat.> is DENIED", (await trySubscribe(rwCreds, rw.id, `${spacePrefix(space)}.chat.>`)) === "denied");
  check("rw: write presence KV is DENIED", (await kvWriteAllowed(rwCreds, rw.id, presenceBucket(space), rw.id)) === "denied");
  check("rw: write ACL KV is DENIED", (await kvWriteAllowed(rwCreds, rw.id, aclBucket(space), owner)) === "denied");
  check("rw: request $SYS CONNZ is DENIED (it's a data-account cred — account isolation)", (await trySubscribe(rwCreds, rw.id, connzRequestSubject(auth.account.pub))) === "denied");

  // ---- admin/web cred: reads the feed, never writes it, no $SYS ----
  const admin = newIdentity();
  const adminCreds = await mintCreds(auth, admin, "admin");
  check("web/admin: read the membership feed is allowed", (await tryKvGet(adminCreds, admin.id, membershipBucket(space), membershipKey(owner))) === "allowed");
  check("web/admin: WRITE the membership feed is DENIED (read-only consumer)", (await kvWriteAllowed(adminCreds, admin.id, membershipBucket(space), membershipKey(owner))) === "denied");
  check("web/admin: request $SYS CONNZ is DENIED (no broker-admin in the browser tier)", (await trySubscribe(adminCreds, admin.id, connzRequestSubject(auth.account.pub))) === "denied");

  console.log(`\nMEMBERSHIP-FEED-CONFINEMENT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

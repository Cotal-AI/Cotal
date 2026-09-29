/**
 * Hosted auth-service fence, failed-start and store-identity proof, native: two real accounts on
 * one broker, started in one process through `startAuthService`.
 *
 *  1. A failed start AFTER the plane is claimed (A's listener port is already bound) refuses
 *     locally, releases A's plane claim, and leaves B serving.
 *  2. A native $SYS KICK of A's sealed auth-ledger scanner fences A mid-life: A's handle reports
 *     `unavailable` with the scanner-death cause and stops serving, B stays ready and serving, and
 *     neither injected store changes identity or content.
 *  3. Stale or recreated store material refuses: another space's issuer under A's slug, and a
 *     same-slug account recreated under a new store/lifecycle, while B stays ready.
 *
 * Run: pnpm smoke:hosted-auth-fence   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { connzRequestSubject, epAuthBucket, MEMBERSHIP_INBOX_PREFIX, mintConnectionEvictorCreds, mintCreds, mintMembershipObserverCreds, newIdentity, serverKickSubject, setupSpaceStreams } from "@cotal-ai/core";
import { startAuthService, type AuthServiceHandle } from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { parsePlaneClaimRow, PLANE_CLAIM_KEY, scannerDeathCopy } from "../src/plane-claim.js";
import { authIssuerKey } from "../src/store.js";
import { MemoryStore, startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";

const fx = await startHostedAuthFixture("hosted-fence");
const handles: AuthServiceHandle[] = [];
const conns: NatsConnection[] = [];
let count = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); count++; };
const refuses = async (p: Promise<unknown>, re: RegExp, name: string) => { await assert.rejects(p, re, name); count++; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};
const health = async (h: AuthServiceHandle) => {
  try { const r = await fetch(`${h.url}/health`); return r.ok ? ((await r.json()) as { issuer: string }).issuer : undefined; }
  catch { return undefined; }
};
const enc = (s: string) => new TextEncoder().encode(s);
/** The plane claim row as the broker holds it, read on a harness connection of the same account. */
async function claimState(acct: HostedAuthAccount): Promise<string | undefined> {
  const c = await openAuthorityClient({ server: fx.servers, space: acct.space, dataAccount: { pub: acct.auth.account.pub, signingSeed: acct.auth.account.signingSeed! }, label: `harness:${acct.space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  try {
    const e = await (await new Kvm(c.nc).open(epAuthBucket(acct.space))).get(PLANE_CLAIM_KEY);
    return e ? parsePlaneClaimRow(e.value)?.state : undefined;
  } finally { await c.close(); }
}
/** Native kill-live: find A's named connection in account CONNZ and KICK it on its server. */
async function kickNamed(acct: HostedAuthAccount, name: string): Promise<number> {
  const observer = await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc(await mintMembershipObserverCreds(acct.auth, newIdentity()))), inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0 });
  const evictor = await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc(await mintConnectionEvictorCreds(acct.auth, newIdentity()))), maxReconnectAttempts: 0 });
  conns.push(observer, evictor);
  const inbox = `${MEMBERSHIP_INBOX_PREFIX}.fence.${Date.now()}`;
  const sub = observer.subscribe(inbox, { max: 1 });
  observer.publish(connzRequestSubject(acct.auth.account.pub), enc(JSON.stringify({ subscriptions: false, auth: true, limit: 1024 })), { reply: inbox });
  let kicked = 0;
  for await (const m of sub) {
    const r = m.json<{ server?: { id?: string }; data?: { server_id?: string; connections?: Array<{ cid: number; name?: string }> } }>();
    const serverId = r.data?.server_id ?? r.server?.id;
    for (const c of r.data?.connections ?? []) {
      if (c.name !== name || serverId === undefined) continue;
      await evictor.request(serverKickSubject(serverId), enc(JSON.stringify({ cid: c.cid })), { timeout: 2000 });
      kicked++;
    }
  }
  return kicked;
}

try {
  const [a, b] = fx.accounts;
  // Each fixture account is a provisioned space (as a hosted platform provisions it before starting
  // auth, and as hosted-bootstrap-order does): the per-space streams the auth plane publishes into.
  for (const acct of fx.accounts)
    await setupSpaceStreams({ servers: fx.servers, space: acct.space, creds: await mintCreds(acct.auth, newIdentity(), "provisioner") });
  const inputs = fx.accounts.map((acct, i) => ({
    context: { accountPublicKey: acct.accountPublicKey, lifecycleUid: `life-${i}` },
    space: acct.space, servers: fx.servers, store: acct.store, storeIdentity: acct.store.identity, stateDir: acct.stateDir,
  }));
  const snapshot = (s: MemoryStore) => JSON.stringify([s.identity, [...s.values.entries()].sort()]);
  const storesBefore = fx.accounts.map((acct) => snapshot(acct.store));

  const second = await startAuthService(inputs[1]);
  handles.push(second);
  const issB = await health(second);
  ok((await second.readiness()).state === "ready" && issB !== undefined, "B starts ready and serving");

  // ---- 1. failed start after the plane claim: A's port is already taken ----
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
  const takenPort = (blocker.address() as { port: number }).port;
  await refuses(startAuthService({ ...inputs[0], port: takenPort }), /EADDRINUSE/, "A's start refuses when its listener cannot bind");
  await new Promise<void>((r) => blocker.close(() => r()));
  ok((await claimState(a)) === "released", "the failed start released A's plane claim");
  ok((await second.readiness()).state === "ready" && (await health(second)) === issB, "B stays ready and serving after A's failed start");

  // ---- 2. mid-life fence by native KICK of A's sealed scanner ----
  const first = await startAuthService(inputs[0]);
  handles.push(first);
  const issA = await health(first);
  ok((await first.readiness()).state === "ready" && issA !== undefined, "A starts after its failed start, over the released claim");
  ok((await kickNamed(a, `cotal:auth-scan:${a.space}`)) === 1, "exactly A's auth-ledger scanner connection was kicked");
  let fenced = await first.readiness();
  for (let i = 0; i < 50 && fenced.state !== "unavailable"; i++) { await wait(100); fenced = await first.readiness(); }
  ok(fenced.state === "unavailable" && fenced.cause === scannerDeathCopy(a.space, "auth-ledger"), "A's handle reports unavailable with the scanner-death cause");
  ok(JSON.stringify(fenced.context) === JSON.stringify(inputs[0].context), "the unavailable state names A's assigned context");
  let aDown = false;
  for (let i = 0; i < 50 && !aDown; i++) { aDown = (await health(first)) === undefined; if (!aDown) await wait(100); }
  ok(aDown, "a fenced A stops serving its listener");
  ok((await second.readiness()).state === "ready" && (await health(second)) === issB, "B stays ready and serving after A is fenced");
  await first.close();
  ok((await first.readiness()).state === "unavailable", "closing a fenced handle keeps its unavailable cause");
  ok(fx.accounts.every((acct, i) => snapshot(acct.store) === storesBefore[i]), "neither injected store changed identity or content");

  // ---- 3. stale and same-slug recreated store material ----
  const stale = new MemoryStore({ kind: "injected", coordinate: "memory:stale" });
  for (const [k, v] of a.store.values) stale.values.set(k, v);
  stale.values.set(authIssuerKey(a.space), b.store.values.get(authIssuerKey(b.space))!);
  await refuses(startAuthService({ ...inputs[0], store: stale, storeIdentity: stale.identity }), /belongs to a different space|does not match space/, "a store carrying another space's issuer refuses");
  const recreated = await fx.recreateSlug(a.space, "memory:recreated");
  await refuses(startAuthService({ ...inputs[0], store: recreated.store, storeIdentity: recreated.store.identity }), /data account does not match/, "a recreated same-slug store under the old assignment refuses");
  await refuses(startAuthService({ ...inputs[0], context: { accountPublicKey: recreated.accountPublicKey, lifecycleUid: "life-recreated" }, store: recreated.store, storeIdentity: recreated.store.identity }), /can't reach the broker|Authorization Violation/, "a recreated same-slug account the broker does not trust refuses before serving");
  ok((await second.readiness()).state === "ready" && (await health(second)) === issB, "B stays ready after the refused stale and recreated starts");
  await second.close();
  ok((await claimState(b)) === "released", "B's close releases its plane claim");
  ok(snapshot(b.store) === storesBefore[1], "B's injected store is unchanged after close");
  console.log(`hosted auth fence: ${count} two-account assertions passed`);
} finally {
  for (const h of handles) await h.close().catch(() => {});
  for (const c of conns) await c.close().catch(() => {});
  await fx.close();
}

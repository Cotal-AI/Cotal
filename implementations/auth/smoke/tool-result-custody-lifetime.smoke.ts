import assert from "node:assert/strict";
import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, jwtAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { decode, encodeUser } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { Kvm } from "@nats-io/kv";
import { canonicalJson, connzRequestSubject, epAuthBucket, EpEnvelopeError, isReachable, MEMBERSHIP_INBOX_PREFIX,
  mintConnectionEvictorCreds, mintMembershipObserverCreds, newIdentity, rotateDataAccountSigningKey, serverKickSubject, type ToolResultConsent } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { AUTHORITY_CLIENT_TTL_SEC, authorityWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { createToolResultRevocationCustody, recordToolResultRevocation, snapshotToolResultRevocations, type ToolResultRevocationCustody, toolResultRevocationWriterGrants, toolResultSnapshotReaderGrants } from "../src/tool-result-prerequisites.js";
import { startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";

if (process.platform !== "linux" || statfsSync(tmpdir()).type !== 0xef53) {
  console.log("Custody lifetime native positives unavailable: qualified Linux/ext4 required; prerequisite suite checks refusal");
  process.exit(0);
}
const lifetime = process.argv.includes("--lifetime");
const fixture = await startHostedAuthFixture("tool-result-custody", lifetime ? 4 : 3);
const custodies: ToolResultRevocationCustody[] = [];
const connections: NatsConnection[] = [];
const target = { owner: `u_${"a".repeat(26)}`, actor: "target", lifecycleUid: "a".repeat(26) };
const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let passed = 0, failed = 0;
async function cell(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${(e as Error).message}`); }
}
async function refuses(run: () => Promise<unknown>) {
  await assert.rejects(run, e => e instanceof EpEnvelopeError && e.code === "unavailable");
}
const options = (account: HostedAuthAccount, directory: string) => ({ server: fixture.servers, space: account.space, directory,
  dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! }, log: () => {},
  authorizeConsent: async () => {}, authorizeTarget: async () => {} });
const request = (account: HostedAuthAccount) => ({ accountPublicKey: account.accountPublicKey, target, deadline: Date.now() + 10_000, maxEntries: 10, maxBytes: 100_000 });
interface Tuple { serverId: string; cid: number; name: string; }
async function observer(account: HostedAuthAccount) {
  const nc = await connect({ servers: fixture.servers,
    authenticator: credsAuthenticator(enc(await mintMembershipObserverCreds(account.auth, newIdentity()))),
    inboxPrefix: MEMBERSHIP_INBOX_PREFIX, reconnect: false });
  connections.push(nc);
  return nc;
}
async function census(account: HostedAuthAccount, nc: NatsConnection): Promise<Tuple[]> {
  const r = (await nc.request(connzRequestSubject(account.accountPublicKey), enc(JSON.stringify({ subscriptions: false, auth: true, limit: 1024 })), { timeout: 3000 })).json<{
    server?: { id?: string }; data?: { server_id?: string; num_connections?: number; total?: number; connections?: Array<{ cid: number; name?: string; jwt?: string }> }; error?: unknown;
  }>();
  assert.equal(r.error, undefined);
  const serverId = r.data?.server_id ?? r.server?.id;
  const rows = r.data?.connections;
  assert.ok(serverId && rows && (r.data?.total ?? rows.length) <= 1024, "complete singleton account census");
  const custodyRows = rows.filter(c => c.name === "cotal:tool-result-snapshot" || c.name === "cotal:tool-result-revocation");
  for (const row of custodyRows) {
    // NATS2.12.12/2.15.1 ConnInfo.jwt is populated from client.opts.JWT when auth:true.
    // Non-bearer JWTs are retained by redactBearerJWT. Inspect only in memory, never print.
    assert.ok(typeof row.jwt === "string" && row.jwt.length > 0, "broker auth census must supply custody claims");
    let claims: { sub?: string; exp?: number; nats?: { issuer_account?: string; pub?: { allow?: string[] }; sub?: { allow?: string[] }; bearer_token?: boolean } };
    try { claims = decode(row.jwt) as unknown as typeof claims; }
    catch { throw new Error("broker custody claim could not be decoded"); }
    const grantBuilder = row.name === "cotal:tool-result-snapshot" ? toolResultSnapshotReaderGrants : toolResultRevocationWriterGrants;
    assert.ok(typeof claims.sub === "string" && claims.exp === undefined && claims.nats?.bearer_token !== true &&
      claims.nats?.issuer_account === account.accountPublicKey,
      "custody must retain a non-expiring non-bearer claim");
    const expected = grantBuilder(account.space, claims.sub);
    assert.ok(JSON.stringify(claims.nats?.pub?.allow) === JSON.stringify(expected.publish) &&
      JSON.stringify(claims.nats?.sub?.allow) === JSON.stringify(expected.subscribe), "custody claim grants must remain exact");
  }
  // Return no JWTs to callers or failure-formatting paths.
  return rows.filter(c => c.name?.startsWith("cotal:tool-result-")).map(c => ({ serverId, cid: c.cid, name: c.name! })).sort((a, b) => a.name.localeCompare(b.name));
}
async function bind(account: HostedAuthAccount, extra = false) {
  const directory = join(fixture.dir, `custody-${account.space}`);
  let forwarded = 0;
  const caller = { ...options(account, directory), ...(extra ? {
    onConnection: () => { forwarded++; }, planeCandidate: true, noReconnect: false,
    probeRenewal: { intervalMs: 10, fail: true }, principal: { owner: target.owner, actor: "extra" },
  } : {}) };
  const custody = await createToolResultRevocationCustody(caller);
  custodies.push(custody);
  const issuer = await openAuthorityClient({ ...options(account, directory), label: "custody-fixture-consent", noReconnect: true,
    grants: id => authorityWriterGrants(account.space, id) });
  const consent: ToolResultConsent = { v: 1, kind: "tool-result-consent", id: "one", space: account.space, target,
    holder: { owner: target.owner, actor: "holder" }, iat: Date.now() - 10, exp: Date.now() + 3_600_000, issuer: { keyId: "fixture" }, sig: "A".repeat(86) };
  try { await (await new Kvm(issuer.nc).open(epAuthBucket(account.space))).create("consent.one", enc(canonicalJson(consent))); }
  finally { await issuer.close(); }
  const obs = await observer(account);
  const initial = await census(account, obs);
  await cell(`exact-two-custody-no-provisioner-${account.space}`, () => assert.deepEqual(initial.map(t => t.name), ["cotal:tool-result-revocation", "cotal:tool-result-snapshot"]));
  await cell(`initial-snapshot-${account.space}`, async () => assert.equal((await snapshotToolResultRevocations(custody, request(account))).snapshot.revokedConsentIds.length, 0));
  if (extra) await cell("extra-runtime-options-not-forwarded", () => assert.equal(forwarded, 0));
  return { custody, consent, directory, initial, obs };
}
async function lost(account: HostedAuthAccount, bound: Awaited<ReturnType<typeof bind>>, label: string) {
  for (let i = 0; i < 50; i++) {
    const rows = await census(account, bound.obs);
    if (!rows.some(t => t.name === label)) break;
    await sleep(100);
  }
  await cell(`${label}-record-refuses`, () => refuses(() => recordToolResultRevocation(bound.custody, bound.consent)));
  await cell(`${label}-snapshot-refuses`, () => refuses(() => snapshotToolResultRevocations(bound.custody, request(account))));
  await cell(`${label}-recreate-refuses`, () => refuses(() => createToolResultRevocationCustody(options(account, bound.directory + "-replacement"))));
}
try {
  // The existing package-internal probeRenewal seam exercises the shipped timer, not a
  // restated rule or public credential hook. A timer that runs emits the forced-failure log.
  await cell("custody-profile-has-no-renewal-timer", async () => {
    const account = fixture.accounts[0]!;
    let renewalLogs = 0;
    const probe = await openAuthorityClient({ server: fixture.servers, space: account.space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
      label: "cotal:tool-result-revocation", toolResultCustody: true,
      grants: id => toolResultRevocationWriterGrants(account.space, id),
      log: () => { renewalLogs++; }, probeRenewal: { intervalMs: 10, fail: true } });
    try { await sleep(50); await probe.nc.flush(); assert.equal(renewalLogs, 0); }
    finally { await probe.close(); }
  });
  for (const [index, label] of ["cotal:tool-result-snapshot", "cotal:tool-result-revocation"].entries()) {
    const account = fixture.accounts[index]!;
    const bound = await bind(account, index === 0);
    const exact = bound.initial.find(t => t.name === label)!;
    const evictor = await connect({ servers: fixture.servers,
      authenticator: credsAuthenticator(enc(await mintConnectionEvictorCreds(account.auth, newIdentity()))), reconnect: false });
    connections.push(evictor);
    await evictor.request(serverKickSubject(exact.serverId), enc(JSON.stringify({ cid: exact.cid })), { timeout: 3000 });
    await lost(account, bound, label);
  }
  const account = fixture.accounts[2]!;
  const bound = await bind(account);
  const successor = await rotateDataAccountSigningKey(account.auth);
  // A harness-only system connection can update precisely this fixture account's claims.
  const user = createUser();
  const claimsSubject = `$SYS.REQ.ACCOUNT.${account.accountPublicKey}.CLAIMS.UPDATE`;
  const jwt = await encodeUser("custody-fixture-key-removal", user, fromPublic(account.auth.sys.pub), {
    pub: { allow: [claimsSubject] }, sub: { allow: ["_INBOX.>"] },
  }, { signer: fromSeed(enc(account.auth.sys.signingSeed!)) });
  const sys = await connect({ servers: fixture.servers, authenticator: jwtAuthenticator(jwt, user.getSeed()), reconnect: false });
  connections.push(sys);
  const reply = (await sys.request(claimsSubject, enc(successor.account.jwt), { timeout: 3000 })).json<{ data?: { code?: number }; error?: unknown }>();
  await cell("D5-native-account-key-removal-accepted", () => assert.ok(reply.data?.code === 200 && !reply.error));
  for (let i = 0; i < 50 && (await census(account, bound.obs)).length; i++) await sleep(100);
  await cell("D5-both-custody-connections-closed", async () => assert.deepEqual(await census(account, bound.obs), []));
  await lost(account, bound, "D5-key-removal");
  if (lifetime) {
    const account = fixture.accounts[3]!;
    // No extra controls here: the pre-fix ordinary profile expires, so this is a real
    // red/green lifetime cell, independent of the old caller-option passthrough defect.
    const bound = await bind(account);
    const started = Date.now();
    const seconds = AUTHORITY_CLIENT_TTL_SEC + 15;
    console.log(`LIFETIME waiting ${seconds}s for unchanged connection identities`);
    while (Date.now() - started < seconds * 1000) {
      await sleep(Math.min(30_000, seconds * 1000 - (Date.now() - started)));
      console.log(`LIFETIME elapsed=${Math.floor((Date.now() - started) / 1000)}s`);
    }
    await cell("past-TTL-same-server-and-client-identities", async () => assert.deepEqual(await census(account, bound.obs), bound.initial));
    await cell("past-TTL-record-succeeds", async () => assert.equal((await recordToolResultRevocation(bound.custody, bound.consent)).consentId, "one"));
    await cell("past-TTL-snapshot-succeeds", async () => assert.deepEqual((await snapshotToolResultRevocations(bound.custody, request(account))).snapshot.revokedConsentIds, ["one"]));
  }
} finally {
  await Promise.all(custodies.map(c => c.close()));
  await Promise.all(connections.map(c => c.close()));
  await fixture.close();
  await cell("owned-fixture-listener-closed", async () => assert.equal(await isReachable(fixture.servers), false));
}
console.log(`CUSTODY_LIFETIME cells=${passed + failed} passed=${passed} failed=${failed}`);
emitSentinel({ passed, failed });
assert.equal(failed, 0);

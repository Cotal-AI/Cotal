/**
 * Hosted auth-service lifetime, native: two real data accounts on one broker, each with its own
 * callout account and injected store, started in ONE process through `startAuthService`.
 * Locks store-identity and account refusals, independent readiness, a context-local failed start
 * (duplicate plane claim) that leaves the sibling ready, no process signal/exit/cwd footprint,
 * and close of one context releasing only its own plane claim.
 *
 * Run: pnpm smoke:hosted-auth-lifetime   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { epAuthBucket, mintConnectionEvictorCreds, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, setupSpaceStreams, type SecretStore } from "@cotal-ai/core";
import { connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey } from "@cotal-ai/workspace";
import { Kvm } from "@nats-io/kv";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { openAuthorityClient, authorityBarrierGrants } from "../src/authority-client.js";
import { deriveOwnerForIdpSubject } from "../src/derive.js";
import { planeClaimRefusal, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { findActorUnified } from "../src/ledger.js";
import { LINK_ENABLE_KEY } from "../src/linked-agent-records.js";
import { parsePlaneClaimRow, PLANE_CLAIM_KEY } from "../src/plane-claim.js";
import { ensurePinnedIdp, loadOwnerSecret } from "../src/store.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { startDeliveryService } from "../../delivery/src/index.js";

const fx = await startHostedAuthFixture("hosted-auth");
const handles: AuthServiceHandle[] = [];
let count = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); count++; };
const refuses = async (p: Promise<unknown>, re: RegExp, name: string) => { await assert.rejects(p, re, name); count++; };
const health = async (h: AuthServiceHandle) => {
  try { const r = await fetch(`${h.url}/health`); return r.ok ? ((await r.json()) as { issuer: string }).issuer : undefined; }
  catch { return undefined; }
};
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
  const signals = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
  const exit = process.exit;
  // Before/after footprint of the cwd AND of any pre-existing cwd .cotal folder (a real worktree may
  // already carry one): hosted contexts must neither create nor write into a cwd-selected root.
  const cwdCotal = join(process.cwd(), ".cotal");
  const footprint = () => JSON.stringify([readdirSync(process.cwd()).sort(), existsSync(cwdCotal) ? readdirSync(cwdCotal, { recursive: true }).map(String).sort() : null]);
  const cwdBefore = footprint();
  const anonymous: SecretStore = { get: (k) => a.store.get(k), put: (k, v) => a.store.put(k, v), create: (k, v) => a.store.create(k, v), delete: (k) => a.store.delete(k) };
  await refuses(startAuthService({ ...inputs[0], store: anonymous }), /must declare a stable identity/, "identity-less store refuses");
  await refuses(startAuthService({ ...inputs[0], storeIdentity: b.store.identity }), /identity does not match/, "wrong store identity refuses");
  await refuses(startAuthService({ ...inputs[0], context: inputs[1].context }), /data account does not match/, "wrong assigned account refuses");
  await refuses(startAuthService({ ...inputs[0], stateDir: "" }), /needs an account/, "missing stateDir refuses");

  const [first, second] = await Promise.all(inputs.map((input) => startAuthService(input)));
  handles.push(first, second);
  ok(JSON.stringify(await first.readiness()) === JSON.stringify({ state: "ready", context: inputs[0].context }), "A ready with its assigned context");
  ok(JSON.stringify(await second.readiness()) === JSON.stringify({ state: "ready", context: inputs[1].context }), "B ready with its assigned context");
  const [issA, issB] = [await health(first), await health(second)];
  ok(issA !== undefined && issB !== undefined && issA !== issB, "each context serves its own issuer on its own listener");

  await refuses(startAuthService(inputs[0]), /plane|claim|held/i, "a duplicate context for A refuses locally at the plane claim");
  ok(process.exit === exit, "no process.exit replaced or called by a failed start");
  ok(process.listenerCount("SIGTERM") + process.listenerCount("SIGINT") === signals, "hosted contexts install no process signal listeners");
  ok(footprint() === cwdBefore, "no cwd-selected root was created or written");
  ok((await second.readiness()).state === "ready" && (await health(second)) === issB, "B remains ready and serving after A's failed duplicate");
  ok((await first.readiness()).state === "ready" && (await health(first)) === issA, "A remains ready after its own refused duplicate");

  await first.drain();
  ok((await first.readiness()).state === "draining", "A reports draining after drain");
  ok((await health(first)) === undefined, "A's listener is closed after drain");
  ok((await second.readiness()).state === "ready" && (await health(second)) === issB, "B remains ready after A closes");

  const restarted = await startAuthService(inputs[0]);
  handles.push(restarted);
  ok((await restarted.readiness()).state === "ready" && (await health(restarted)) === issA, "A restarts over its released plane claim");
  ok((await health(second)) === issB, "B remains serving after A restarts");
  await restarted.close();
  await first.close();
  await second.close();
  await second.close();
  ok((await health(second)) === undefined, "B closes idempotently");
  const retry = await startAuthService(inputs[0]);
  handles.push(retry);
  await fx.stopBroker();
  let closeFailure: unknown;
  try { await retry.close(); } catch (e) { closeFailure = e; }
  ok(planeClaimRefusal(closeFailure) === "release-unreachable", "hosted close exposes a typed retryable release refusal");
  ok((await retry.readiness()).state !== "ready", "failed close does not report hosted context ready");
  await fx.restartBroker();
  const verifier = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! }, label: `cotal:auth-barrier:${a.space}`, grants: (id) => authorityBarrierGrants(a.space, id), log: () => {} });
  try {
    const kv = await new Kvm(verifier.nc).open(epAuthBucket(a.space));
    ok(parsePlaneClaimRow((await kv.get(PLANE_CLAIM_KEY))!.value)?.state === "held", "hosted failed close leaves the row held");
    // A fresh verifier connection does not prove the retained barrier has reconnected.
    // Retry only the public retryable refusal, within a bound, rather than assuming a fixed delay.
    const deadline = Date.now() + 10_000;
    let retryFailure: unknown;
    let attempts = 0;
    do {
      attempts++;
      try { await retry.close(); retryFailure = undefined; break; }
      catch (e) {
        if (planeClaimRefusal(e) !== "release-unreachable") throw e;
        retryFailure = e;
      }
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    console.log(`hosted close after broker restart: ${attempts} attempt(s)`);
    ok(retryFailure === undefined && parsePlaneClaimRow((await kv.get(PLANE_CLAIM_KEY))!.value)?.state === "released",
      "hosted close retries the release after the broker returns");
  } finally { await verifier.close(); }
  console.log(`hosted auth lifetime: ${count} two-account assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  for (const h of handles) await h.close().catch(() => {});
  await fx.close();
}

// The public embedder lifetime cells share this already fragment-registered CI entrypoint.
await import("./hosted-auth-start-close.smoke.js");
await import("./auth-public-closure.smoke.js");
await import("./plane-claim-public.smoke.js");
await import("./account-liveness-public.smoke.js");

const LINK_GRANT = "/managed-lifecycle/linked-grant";
const MANAGED_RETIRE = "/managed-lifecycle/retire";
const LINK_AUD = "fixture-linked-approval";

async function startLinkedProofFixture() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(publicKey), kid: "owner-proof" };
  const jwks = createServer((req, res) => {
    if (req.url !== "/api/auth/jwks") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>(resolve => jwks.listen(0, "127.0.0.1", resolve));
  const address = jwks.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    sign: (sub: string, aud = origin, claims: JWTPayload = {}) => new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setSubject(sub).setAudience(aud)
      .setIssuedAt().setExpirationTime("2m").setJti(randomUUID()).sign(privateKey),
    close: () => new Promise<void>((resolve, reject) => jwks.close(error => error ? reject(error) : resolve())),
  };
}

async function linkedForegroundSmoke() {
  const fixture = await startHostedAuthFixture("linked-foreground", 1);
  let proof: Awaited<ReturnType<typeof startLinkedProofFixture>> | undefined;
  let host: AuthServiceHandle | undefined;
  let delivery: Awaited<ReturnType<typeof startDeliveryService>> | undefined;
  let admin: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
  try {
    const idp = proof = await startLinkedProofFixture();
    const a = fixture.accounts[0]!;
    const { space, accountPublicKey: account } = a;
    const stateDir = join(fixture.dir, "linked-state");
    mkdirSync(stateDir);
    ensurePinnedIdp(stateDir, `${idp.origin}/api/auth`);
    const secret = await loadOwnerSecret(a.store, space);
    assert.ok(secret);
    const owner = deriveOwnerForIdpSubject(secret, idp.origin, "human");
    const inputs = { context: { accountPublicKey: account, lifecycleUid: mintLifecycleUid() }, space,
      servers: fixture.servers, store: a.store, storeIdentity: a.store.identity, stateDir };
    const start = (enabled: boolean) => startAuthService({ ...inputs, ...(enabled ? { linkedForeground: { approvalAudience: LINK_AUD } } : {}) });
    await setupSpaceStreams({ servers: fixture.servers, space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
    const composition = { injected: true as const };
    await a.store.put(deliveryCredsKey(space, composition), await mintCreds(a.auth, newIdentity(), "delivery"));
    await a.store.put(membershipRwCredsKey(space, composition), await mintCreds(a.auth, newIdentity(), "membership-rw"));
    await a.store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(a.auth, newIdentity()));
    await a.store.put(connectionEvictorCredsKey(space, composition), await mintConnectionEvictorCreds(a.auth, newIdentity()));
    const post = async (path: string, body: unknown, token = host!.cap) => {
      const r = await fetch(`${host!.url}${path}`, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${token}`,
      }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    };
    const request = async (actor: string, selection: { mode: "create" } | { mode: "select"; agentUid: string } = { mode: "create" }) => {
      const requestId = randomUUID(), scope: string[] = [], allowSubscribe = ["work.ready"], allowPublish: string[] = [];
      const requestDigest = createHash("sha256").update(JSON.stringify(["cotal/linked-agent-grant/v1", account, space, owner,
        actor, requestId, selection.mode, selection.mode === "select" ? selection.agentUid : null, scope, allowSubscribe, allowPublish])).digest("hex");
      const claims = { account, space, owner, actor, requestDigest, purpose: "linked-agent-grant", auth_time: Math.floor(Date.now() / 1000), amr: ["pwd"] };
      const approval = await idp.sign("human", LINK_AUD, claims);
      return { body: { actor, requestId, scope, allowSubscribe, allowPublish, agentLink: { ...selection, approval } }, claims };
    };
    const signIn = await idp.sign("human");
    const first = await request("linked_one");
    host = await start(false);
    assert.equal((await post(LINK_GRANT, first.body)).body.code, "unavailable", "host capability absent");
    await host.close();
    host = await start(true);
    delivery = await startDeliveryService(inputs);
    for (let i = 0; i < 50 && (await delivery.readiness()).state !== "ready"; i++) await new Promise(r => setTimeout(r, 200));
    assert.equal((await delivery.readiness()).state, "ready");
    assert.ok(!(await post(LINK_GRANT, first.body)).body.actorToken, "private enable row is absent");
    admin = await openAuthorityClient({ server: fixture.servers, space, dataAccount: { pub: account, signingSeed: a.auth.account.signingSeed! },
      label: "linked-foreground-smoke", grants: id => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
    const kv = await new Kvm(admin.nc).open(epAuthBucket(space));
    const enable = (enabled: boolean) => kv.put(LINK_ENABLE_KEY, new TextEncoder().encode(JSON.stringify({ v: 1, accountPublicKey: account, space, enabled })));
    await enable(true);

    assert.equal((await post(LINK_GRANT, { ...first.body, owner })).status, 400);
    assert.equal((await post(LINK_GRANT, { ...first.body, agentLink: { ...first.body.agentLink, approval: signIn } })).status, 403);
    const stale = await idp.sign("human", LINK_AUD, { ...first.claims, auth_time: first.claims.auth_time - 301 });
    assert.equal((await post(LINK_GRANT, { ...first.body, agentLink: { ...first.body.agentLink, approval: stale } })).status, 403);
    assert.equal((await post(LINK_GRANT, { ...first.body, allowSubscribe: ["work.other"] })).status, 403);
    assert.equal((await post(LINK_GRANT, { ...first.body, scope: ["manager-service"] })).status, 403);
    assert.equal((await post(LINK_GRANT, { ...first.body, allowPublish: ["work.*"] })).status, 403);
    assert.equal(findActorUnified(stateDir, owner, first.body.actor), undefined, "refusals left no file grant");

    const pending = await post(LINK_GRANT, first.body);
    assert.equal(pending.status, 200, String(pending.body.error));
    assert.deepEqual(Object.keys(pending.body).sort(), ["actor", "actorToken", "agentLink", "lifecycleUid", "owner", "state", "v"]);
    const { actor, lifecycleUid, actorToken, agentLink } = pending.body;
    assert.equal(pending.body.v, 1);
    assert.equal(pending.body.state, "pending");
    assert.equal(pending.body.owner, owner);
    assert.equal(actor, first.body.actor);
    assert.equal(typeof lifecycleUid, "string");
    assert.equal(typeof actorToken, "string");
    assert.ok(agentLink && typeof agentLink === "object" && "agentUid" in agentLink);
    assert.match(String(agentLink.agentUid), /^ag_[a-z2-7]{26}$/);
    assert.deepEqual(agentLink, { mode: "create", agentUid: agentLink.agentUid });
    assert.notEqual((await post(LINK_GRANT, first.body)).status, 200, "admitted proof was consumed");
    const target = { actor, lifecycleUid };
    assert.equal((await post(MANAGED_RETIRE, target, first.body.agentLink.approval)).status, 401);
    assert.equal((await post(MANAGED_RETIRE, target, await idp.sign("human", idp.origin, first.claims))).status, 401);
    assert.equal((await post(MANAGED_RETIRE, { ...target, owner }, signIn)).status, 400);
    assert.equal((await post(MANAGED_RETIRE, { ...target, actor: "different" }, signIn)).status, 403);
    assert.equal((await post(MANAGED_RETIRE, target, await idp.sign("different-owner"))).status, 403);
    await enable(false);
    const retired = await post(MANAGED_RETIRE, target, signIn);
    assert.equal(retired.status, 200, String(retired.body.error));
    assert.equal(retired.body.retired, true, "owner ends exact pending lifecycle while admission is off");
    assert.equal((await post(MANAGED_RETIRE, target, signIn)).body.alreadyRetired, true);

    await enable(true);
    assert.equal((await post(LINK_GRANT, first.body)).status, 409, "approval replay stays refused after the alias is free");
    assert.equal(findActorUnified(stateDir, owner, first.body.actor), undefined);
    const bootRequest = await request("abandoned");
    const abandoned = await post(LINK_GRANT, bootRequest.body);
    assert.equal(abandoned.status, 200, String(abandoned.body.error));
    assert.ok(findActorUnified(stateDir, owner, bootRequest.body.actor), "bootstrap grant existed before restart");
    await host.close();
    host = await start(true);
    assert.equal(findActorUnified(stateDir, owner, bootRequest.body.actor), undefined, "boot closed the exact pending grant");
    const ended = await post(MANAGED_RETIRE, { actor: abandoned.body.actor, lifecycleUid: abandoned.body.lifecycleUid }, signIn);
    assert.equal(ended.body.alreadyRetired, true, String(ended.body.error));
    assert.notEqual((await post("/exchange", { owner, actor: abandoned.body.actor, actorToken: abandoned.body.actorToken })).status, 200,
      "stale bootstrap cannot mint after boot containment");
    const fresh = await request(bootRequest.body.actor);
    assert.equal((await post(LINK_GRANT, fresh.body)).status, 200, "fresh owner approval can reuse the retired alias");
    console.log("hosted linked foreground: owner proof, disabled admission, exact retirement and pending boot recovery passed");
  } finally {
    await host?.close().catch(() => {});
    await delivery?.close().catch(() => {});
    await admin?.close().catch(() => {});
    await proof?.close();
    await fixture.close();
  }
}

await linkedForegroundSmoke();

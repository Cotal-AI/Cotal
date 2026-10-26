/**
 * Connect limits (SPEC 13.1): the callout's per-actor, per-owner and per-host token buckets, the
 * signed `RATE_LIMITED` denial it journals, and the exchange's typed 429, against a REAL
 * operator-mode nats-server.
 *
 *   L1  the limiter alone, on an injected clock: burst, refill, an owner across its actors, a
 *       refusal spends nothing, `check` spends nothing, hosts apart, and bad limits refused.
 *   L2  the callout with counting hooks: an actor's connects pass up to its limit, and the next is a
 *       prompt Authorization Violation journaled as `RATE_LIMITED` with its retry-after, actor and
 *       owner, after no ledger or issuance work. The owner limit names the owner and the actor. An
 *       expired bearer is charged to its actor, and a bearer that does not verify to its host.
 *   L3  the shipped auth service started in this process with small limits: once the callout has
 *       limited an actor, its human exchange and its managed-agent exchange answer 429 with
 *       `{code, retryAfterSeconds, error}` and `Retry-After`, while another actor still mints.
 *
 * Run: pnpm smoke:connect-limit:auth  (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import {
  ConnectLimiter, ConnectRateLimited, USER_TOKEN_VER, calloutPermissions, deriveOwnerForIdpSubject, deriveOwnerToken, grantActor,
  grantManagedActor, loadCalloutAuth, loadOwnerSecret, newActorToken, startAuthCallout, startAuthService, type AuthServiceHandle,
} from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const now = () => Math.floor(Date.now() / 1000);
/** The principal and reason of each `outcome=denied` line the callout writes. */
const denials = (lines: string[]) => lines.flatMap((l) => {
  const m = /^auth callout: level=\w+ outcome=denied .* owner=(\S+) actor=(\S+) .* reason=("(?:[^"\\]|\\.)*")$/.exec(l);
  return m ? [{ owner: m[1]!, actor: m[2]!, reason: JSON.parse(m[3]!) as string }] : [];
});
const refusal = (fn: () => void): ConnectRateLimited | undefined => {
  try { fn(); return undefined; } catch (e) { if (e instanceof ConnectRateLimited) return e; throw e; }
};

// ---- L1: the limiter alone ------------------------------------------------------------------------
console.log("L1) the limiter on an injected clock");
{
  const t0 = 1_000_000;
  const lim = new ConnectLimiter({ actorPerMinute: 3, ownerPerMinute: 5, hostPerMinute: 2 });
  const a = { owner: "u_owner", actor: "a" }, b = { owner: "u_owner", actor: "b" };
  for (let i = 0; i < 3; i++) lim.take(a, t0);
  const r = refusal(() => lim.take(a, t0));
  check("an actor's burst is its per-minute limit, and the next connect is refused", r?.code === "RATE_LIMITED", r);
  check("the refusal waits one refill: 60s / 3 = 20s", r?.retryAfterSeconds === 20, r?.retryAfterSeconds);
  check("the refusal names the actor and the owner", r?.message === "actor a of owner u_owner is over its limit of 3 connects a minute", r?.message);
  check("refusals spend nothing: the owner still has 2 of 5 for another actor", refusal(() => { lim.take(b, t0); lim.take(b, t0); }) === undefined);
  const o = refusal(() => lim.take(b, t0));
  check("the owner's limit holds across its actors and names both", o?.message === "owner u_owner is over its limit of 5 connects a minute (actor b)", o?.message);
  check("a bucket refills at its rate: one connect for the actor after 20s", refusal(() => lim.check(a, t0 + 20_000)) === undefined);
  check("the longer wait wins when both buckets are short", refusal(() => lim.check(a, t0 + 5_000))?.retryAfterSeconds === 15);
  const lim2 = new ConnectLimiter({ actorPerMinute: 1 });
  lim2.check({ owner: "u_x", actor: "c" }, t0);
  lim2.check({ owner: "u_x", actor: "c" }, t0);
  check("check spends nothing", refusal(() => lim2.take({ owner: "u_x", actor: "c" }, t0)) === undefined);
  lim.take({ host: "10.0.0.1" }, t0); lim.take({ host: "10.0.0.1" }, t0);
  const h = refusal(() => lim.take({ host: "10.0.0.1" }, t0));
  check("a host's bucket refuses a bearer that does not verify", h?.message === "host 10.0.0.1 is over its limit of 2 connects a minute with a bearer that does not verify", h?.message);
  check("another host has its own bucket", refusal(() => lim.take({ host: "10.0.0.2" }, t0)) === undefined);
  check("the defaults are 60, 600 and 60 a minute", JSON.stringify(new ConnectLimiter().limits) === JSON.stringify({ actorPerMinute: 60, ownerPerMinute: 600, hostPerMinute: 60 }));
  let bad: unknown;
  try { new ConnectLimiter({ ownerPerMinute: 0 }); } catch (e) { bad = e; }
  check("a limit that is not a positive integer is refused at construction", /ownerPerMinute must be a positive integer/.test(String(bad)), bad);
}

const fx = await startHostedAuthFixture("connlimit", 1);
const a = fx.accounts[0]!;
let calloutNc: NatsConnection | undefined;
let service: AuthServiceHandle | undefined;
let idpServer: Server | undefined;
const realConsoleError = console.error;
try {
  /** One user-mode connect: ok, or the client's error message. */
  const dial = async (bearer: string): Promise<{ ok: boolean; msg: string; ms: number }> => {
    const nonce = `ibx${randomUUID().replace(/-/g, "")}`, t = Date.now();
    try {
      const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(enc(a.sentinelCreds)), tokenAuthenticator(bearer)],
        name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: 15_000, maxReconnectAttempts: 0 });
      await nc.close();
      return { ok: true, msg: "connected", ms: Date.now() - t };
    } catch (e) {
      return { ok: false, msg: (e as Error).message, ms: Date.now() - t };
    }
  };

  // ---- L2: the callout with counting hooks --------------------------------------------------------
  console.log("L2) the callout charges each connect before any ledger or issuance work");
  const calloutAuth = (await loadCalloutAuth(a.store, a.space))!;
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const ISS = "https://auth.cotal.test";
  const uid = mintLifecycleUid();
  const ownerOf = (who: string) => deriveOwnerToken("c".repeat(32), `better-auth|${who}`);
  const sign = (owner: string, actor: string, key: CryptoKey, exp = now() + 300) =>
    new SignJWT({ sub: owner, ver: USER_TOKEN_VER, act: { owner, actor, scope: [], lifecycleUid: uid } }).setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(ISS).setAudience(a.space).setSubject(owner).setIssuedAt(exp - 360).setNotBefore(exp - 360).setExpirationTime(exp).sign(key);
  let authorized = 0, recorded = 0;
  const journal: string[] = [];
  calloutNc = await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc(calloutAuth.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    xkeySeed: calloutAuth.xkey.seed,
    authAccount: { pub: calloutAuth.account.pub, signingSeed: calloutAuth.account.signingSeed },
    dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
    space: a.space,
    token: { key: publicKey as never, issuer: ISS },
    authorizeActor: () => { authorized++; },
    recordIssuance: async () => { recorded++; },
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: uid, scope: [] })),
    connectLimiter: new ConnectLimiter({ actorPerMinute: 3, ownerPerMinute: 5, hostPerMinute: 2 }),
    log: (l) => journal.push(l),
  });
  await calloutNc.flush();
  const lastDenial = () => denials(journal).at(-1) ?? { owner: "", actor: "", reason: "" };

  const owner = ownerOf("limit-human");
  const loop = await sign(owner, "loop", privateKey as CryptoKey);
  const first = [await dial(loop), await dial(loop), await dial(loop)];
  check("an actor's connects up to its limit are minted", first.every((r) => r.ok) && authorized === 3 && recorded === 3, { first, authorized, recorded, journal });
  const limited = await dial(loop);
  check("the next connect is a prompt Authorization Violation", !limited.ok && /authorization violation/i.test(limited.msg) && limited.ms < 7_500, limited);
  const line = lastDenial();
  const m = new RegExp(`^RATE_LIMITED retry-after (\\d+)s: actor loop of owner ${owner} is over its limit of 3 connects a minute$`).exec(line.reason);
  check("its journal line names RATE_LIMITED, the retry-after, the actor and the owner", m !== null && line.owner === owner && line.actor === "loop", line);
  check("the retry-after is the time to one refill", Number(m?.[1]) >= 18 && Number(m?.[1]) <= 20, m?.[1]);
  check("the limited connect did no ledger read and no issuance write", authorized === 3 && recorded === 3, { authorized, recorded });

  const other = await sign(owner, "other", privateKey as CryptoKey);
  const second = [await dial(other), await dial(other)];
  const ownerLimited = await dial(other);
  check("another actor of the owner connects until the owner's limit", second.every((r) => r.ok), second);
  check("then the owner's limit refuses it, naming the owner and the actor",
    !ownerLimited.ok && new RegExp(`^RATE_LIMITED retry-after \\d+s: owner ${owner} is over its limit of 5 connects a minute \\(actor other\\)$`).test(lastDenial().reason), lastDenial());

  const lateOwner = ownerOf("late-human");
  const expired = await sign(lateOwner, "late", privateKey as CryptoKey, now() - 60);
  const exp3 = [await dial(expired), await dial(expired), await dial(expired)];
  const expDenials = denials(journal).filter((d) => d.reason.includes('"exp" claim timestamp check failed')).length;
  check("an expired bearer is refused for its expiry while its actor has connects left", exp3.every((r) => !r.ok) && expDenials === 3, { exp3, expDenials });
  await dial(expired);
  check("then its retries are charged to the actor its signature names",
    new RegExp(`^RATE_LIMITED retry-after \\d+s: actor late of owner ${lateOwner} is over its limit of 3 connects a minute$`).test(lastDenial().reason) &&
      lastDenial().owner === lateOwner && lastDenial().actor === "late", lastDenial());
  check("an expired bearer reaches no ledger read", authorized === 5, authorized);

  const { privateKey: foreign } = await generateKeyPair("EdDSA");
  const forged = await sign(ownerOf("forger"), "x", foreign as CryptoKey);
  await dial(forged); await dial(forged);
  const hostDenials = denials(journal).filter((d) => /signature verification failed/.test(d.reason)).length;
  await dial(forged);
  check("a bearer that does not verify is refused for its signature, then charged to its client host",
    hostDenials === 2 && /^RATE_LIMITED retry-after \d+s: host 127\.0\.0\.1 is over its limit of 2 connects a minute with a bearer that does not verify$/.test(lastDenial().reason), { hostDenials, last: lastDenial() });
  await calloutNc.close();
  calloutNc = undefined;

  // ---- L3: the shipped service, its callout and its exchange share one limiter ---------------------
  console.log("L3) the exchange refuses an actor the callout has limited");
  const idpKeys = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(idpKeys.publicKey), kid: "limit-idp", alg: "EdDSA" };
  idpServer = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((r) => idpServer!.listen(0, "127.0.0.1", r));
  const IDP = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;
  writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${IDP}/api/auth`, issuer: IDP, audience: IDP, jwksUri: `${IDP}/jwks` }), { mode: 0o600 });
  const human = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, IDP, "limit-human");
  for (const actor of ["cli", "loop", "other"]) grantActor(a.stateDir, { owner: human, actor, scope: [], allowSubscribe: ["general"], allowPublish: ["general"] });
  const secret = newActorToken();
  grantManagedActor(a.stateDir, { custody: { kind: "foreground" }, owner: human, actor: "seat", scope: [], allowSubscribe: ["general"], allowPublish: ["general"],
    parent: `${human}.cli`, tokenHash: secret.tokenHash, lifecycleUid: mintLifecycleUid() });
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  const serviceJournal: string[] = [];
  console.error = (...args: unknown[]) => { serviceJournal.push(args.map(String).join(" ")); };
  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity,
    connectLimits: { actorPerMinute: 2 },
  });
  const proof = () => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "limit-idp" }).setSubject("limit-human").setIssuer(IDP)
    .setAudience(IDP).setIssuedAt(now()).setExpirationTime(now() + 600).sign(idpKeys.privateKey);
  const exchange = async (body: Record<string, unknown>) => {
    const res = await fetch(`${service!.url}/exchange`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify(body) });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() as Record<string, unknown> };
  };
  const human1 = await exchange({ idpToken: await proof(), actor: "loop" });
  const agent1 = await exchange({ owner: human, actor: "seat", actorToken: secret.actorToken });
  check("before any connect, the human and agent exchanges mint", human1.status === 200 && agent1.status === 200, { human1, agent1 });
  const hb = String(human1.body.token), ab = String(agent1.body.token);
  const minted = [await dial(hb), await dial(hb), await dial(ab), await dial(ab)];
  const over = [await dial(hb), await dial(ab)];
  check("the service's callout mints each actor up to its limit and then refuses it", minted.every((r) => r.ok) && over.every((r) => !r.ok), { minted, over });
  check("the service journals each limited connect with its owner and actor",
    denials(serviceJournal).filter((d) => d.owner === human && /^RATE_LIMITED retry-after \d+s: actor (loop|seat) of owner /.test(d.reason)).length === 2, serviceJournal.slice(-4));
  const human2 = await exchange({ idpToken: await proof(), actor: "loop" });
  check("the human exchange for the limited actor answers 429 RATE_LIMITED", human2.status === 429 && human2.body.code === "RATE_LIMITED", human2);
  const secs = human2.body.retryAfterSeconds;
  check("its retryAfterSeconds is a whole number of seconds, sent again as Retry-After", Number.isSafeInteger(secs) && (secs as number) >= 1 && (secs as number) <= 30 && human2.retryAfter === String(secs), human2);
  check("its error is one sentence naming the actor, the owner, the limit and the wait",
    human2.body.error === `actor loop of owner ${human} is over its limit of 2 connects a minute - retry in ${secs}s`, human2.body.error);
  const agent2 = await exchange({ owner: human, actor: "seat", actorToken: secret.actorToken });
  check("the managed-agent exchange for its limited actor answers the same 429", agent2.status === 429 && agent2.body.code === "RATE_LIMITED" && agent2.retryAfter === String(agent2.body.retryAfterSeconds), agent2);
  const other2 = await exchange({ idpToken: await proof(), actor: "other" });
  check("another actor of the same owner still mints", other2.status === 200 && typeof other2.body.token === "string", other2.status);
  check("the 429 is journaled as an exchange refusal", serviceJournal.some((l) => /auth-service: refused an exchange: RATE_LIMITED retry-after \d+s: actor loop of owner /.test(l)), serviceJournal.slice(-4));
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? String(e)}`, false);
} finally {
  console.error = realConsoleError;
  await service?.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  idpServer?.close();
  await fx.close();
}
finish();

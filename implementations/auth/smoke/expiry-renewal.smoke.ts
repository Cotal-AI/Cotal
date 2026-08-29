/**
 * Expired-credential renewal + retry-bounding live smoke (#986) — proves a user-mode endpoint whose
 * bearer expires stops re-presenting the dead token to the broker, and either renews through the
 * auth exchange or backs off.
 *
 * The reported failure: a client whose credential expired while the broker was unreachable retries
 * it forever once the broker returns. Measured on this harness before the fix, with a bearer that
 * expires under a live endpoint: 11 denials in 45s (14.7/min), inter-arrival gaps 3068/3094/3074/
 * 3065/3099/3062/3055/3079/3063/3087 ms (dead flat, the endpoint's 3s reconnect interval), every one
 * of them `"exp" claim timestamp check failed`, every one from a DISTINCT connection nkey, and zero
 * renewal attempts. Each denial costs a full auth-callout round trip, so one stuck client is a
 * permanent flat load on the auth plane.
 *
 * Two causes, and this suite holds both down:
 *   - connectAndBind dialled even when the cached bearer was already expired. The renewal fetch
 *     ahead of it is deliberately best-effort (a dead auth service must not instantly drop a live
 *     mesh), which left the connect presenting material the client had already proven dead.
 *   - the reestablish loop retried on a FIXED interval, so a failure that cannot resolve itself
 *     repeats at the same rate for the life of the process.
 *
 * Three arms, because the fix must bound the hopeless case WITHOUT blunting the recoverable one:
 *   A. no renewal source (a bearer handed over as a value): zero denials, and the wait between
 *      attempts grows instead of staying flat.
 *   B. renewal source present and healthy: the endpoint re-mints through the exchange and publishes
 *      again after its bearer expired. This is the arm that would catch a fix that simply stopped
 *      reconnecting.
 *   C. the refusal is loud and names which of the two situations it is in.
 *
 * Run: pnpm smoke:expiry-renewal:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig,
  setupSpaceStreams, chatSubject, type CotalMessage, mintLifecycleUid } from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

/** The endpoint's first reconnect wait. The fix keeps the FIRST retry here and grows from it, so the
 *  growth assertion needs a window several multiples wide. */
const RETRY_MS = 3000;
/** Bearer lifetime. Short enough to expire inside the suite, long enough that the endpoint connects
 *  and settles first. */
const TTL_SEC = 5;
/** How long arm A watches after the bearer dies. Pre-fix this window held ~7 denials at 3s apart;
 *  it also spans the 3s/6s/12s growth the fix produces. */
const ARM_A_WATCH_MS = 22_000;

const smokeUid = mintLifecycleUid();
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 20_000): Promise<boolean> => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await wait(50); return cond(); };
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `expren-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
let mintCalls = 0;
async function bearer(actor: string): Promise<string> {
  mintCalls++;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: OWNER, ver: USER_TOKEN_VER, act: { owner: OWNER, actor, scope: [], lifecycleUid: smokeUid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(OWNER)
    .setIssuedAt(now - 5).setNotBefore(now - 5).setExpirationTime(now + TTL_SEC)
    .sign(privateKey as CryptoKey);
}

/** Every callout denial, exactly as the auth service logs it: the per-attempt connection nkey and
 *  the reason. This is the live evidence stream the issue was measured from. */
const denials: Array<{ ms: number; nkey: string; reason: string }> = [];
const t0 = Date.now();

let calloutNc: NatsConnection | undefined, witnessNc: NatsConnection | undefined;
let epA: CotalEndpoint | undefined, epB: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  await wait(300);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    authorizeActor: () => {},
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: smokeUid, scope: [] })),
    log: (l) => { const m = /denied (\S+): (.*)$/.exec(l); if (m) denials.push({ ms: Date.now() - t0, nkey: m[1], reason: m[2] }); },
  });

  // ARM A — a bearer handed over as a VALUE: nothing this endpoint can renew with.
  const errorsA: Array<{ ms: number; msg: string }> = [];
  epA = new CotalEndpoint({
    space, servers: SERVERS,
    bearer: await bearer("agentone"), sentinelCreds: callout.sentinelCreds,
    card: { name: "no-renewal", kind: "agent" },
    channels: ["general"],
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  epA.on("error", (e: Error) => errorsA.push({ ms: Date.now() - t0, msg: e.message }));
  await epA.start();
  const denialsBeforeA = denials.length;

  // Let the bearer die under the live connection, then watch the reconnect path.
  await wait(TTL_SEC * 1000 + ARM_A_WATCH_MS);
  const armA = denials.slice(denialsBeforeA).filter((d) => /exp/i.test(d.reason));

  check(
    "an endpoint that cannot renew presents its expired bearer to the broker ZERO times",
    armA.length === 0,
    { denials: armA.length, reasons: [...new Set(armA.map((d) => d.reason))], nkeys: new Set(armA.map((d) => d.nkey)).size },
  );

  // The refusal must be loud, and must say WHICH situation it is: no renewal path at all.
  const refusals = errorsA.filter((e) => /no bearer source to renew it/.test(e.msg));
  check(
    "the refusal to dial is loud and names the missing renewal path",
    refusals.length > 0,
    errorsA.map((e) => e.msg),
  );

  // The retry wait must GROW. Flat-rate retrying is the defect: a credential that was expired one
  // second ago is still expired now, so the same attempt at the same interval forever is pure load.
  const gaps = refusals.slice(1).map((e, i) => e.ms - refusals[i].ms);
  check(
    "the wait between reconnect attempts grows past the flat retry interval",
    refusals.length >= 3 && gaps.length >= 2 && gaps[gaps.length - 1] > RETRY_MS * 1.5,
    { attemptsAtMs: refusals.map((e) => e.ms), gaps },
  );
  await epA.stop();
  epA = undefined;

  // ARM B — the same expiry, with the renewal source the product already has. This must still
  // recover: a fix that bounded arm A by giving up on reconnecting would fail here.
  witnessNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(await mintCreds(auth, newIdentity(), "admin"))) });
  const got: CotalMessage[] = [];
  witnessNc.subscribe(chatSubject(space, "*", "*", "general"), { callback: (err, m) => { if (!err) try { got.push(m.json<CotalMessage>()); } catch { /* skip */ } } });
  await witnessNc.flush();

  const denialsBeforeB = denials.length;
  const mintsBeforeB = mintCalls;
  epB = new CotalEndpoint({
    space, servers: SERVERS,
    bearer: () => bearer("agenttwo"), sentinelCreds: callout.sentinelCreds,
    card: { name: "renewing", kind: "agent", owner: OWNER, actor: "agenttwo" },
    channels: ["general"],
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  epB.on("error", () => { /* expiry churn is expected here; the publish below is the verdict */ });
  await epB.start();

  // Outlive the bearer, then prove the endpoint is still usable — that publish can only land on a
  // connection the broker accepted, which can only have come from freshly minted material.
  await wait(TTL_SEC * 1000 + RETRY_MS * 2);
  let sent: CotalMessage | undefined;
  for (let i = 0; i < 10 && !sent; i++) {
    try { sent = await epB.multicast("post-expiry", { channel: "general" }); } catch { await wait(1000); }
  }
  check("a renewable endpoint re-mints through the auth exchange after its bearer expired", mintCalls > mintsBeforeB, { before: mintsBeforeB, after: mintCalls });
  check("the renewed endpoint publishes again after expiry", !!sent);
  check("the witness receives the post-expiry message", !!sent && (await until(() => got.some((g) => g.id === sent!.id))), got.map((g) => g.id));
  const armB = denials.slice(denialsBeforeB).filter((d) => /exp/i.test(d.reason));
  check("renewal keeps expired material off the wire entirely", armB.length === 0, { denials: armB.length });

  console.log(`\nEXPIRY-RENEWAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  console.log(`\nEXPIRY-RENEWAL SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  process.exitCode = 1;
} finally {
  for (const ep of [epA, epB]) { try { await ep?.stop(); } catch { /* */ } }
  for (const nc of [witnessNc, calloutNc]) { try { await nc?.close(); } catch { /* */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

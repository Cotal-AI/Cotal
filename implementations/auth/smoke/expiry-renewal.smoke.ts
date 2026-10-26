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
 * The arms, because the fix must bound the hopeless case WITHOUT blunting the recoverable one:
 *   A. no renewal source (a bearer handed over as a value): zero denials, and the refusal is loud,
 *      names the missing renewal path, and is said once rather than once per rebuild attempt.
 *   A2. a renewal source that stops answering: zero denials, one notice for the run of failures,
 *      and the source is retried on a growing wait, not once per rebuild attempt.
 *   B. renewal source present and healthy: the endpoint re-mints through the exchange and publishes
 *      again after its bearer expired. This is the arm that would catch a fix that simply stopped
 *      reconnecting.
 *   D. bearers long enough to renew inside their lifetime: the endpoint moves its live connection
 *      onto each new one, so the broker never closes it for an expired bearer.
 *
 * Run: pnpm smoke:expiry-renewal:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig,
  setupSpaceStreams, chatSubject, type CotalMessage, mintLifecycleUid } from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

/** The endpoint's first reconnect wait. */
const RETRY_MS = 3000;
/** Bearer lifetime. Short enough to expire inside the suite, long enough that the endpoint connects
 *  and settles first. */
const TTL_SEC = 5;
/** How long arms A and A2 watch after the bearer dies. Pre-fix this window held ~7 denials at 3s
 *  apart; it also spans the first three retries of a failed renewal (2.5-5s, 5-10s, 10-20s). */
const ARM_A_WATCH_MS = 22_000;
/** Arm D's bearer lifetime and watch: long enough that renewal lands inside the lifetime. */
const LONG_TTL_SEC = 20;
const ARM_D_WATCH_MS = 50_000;

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
async function bearer(actor: string, ttlSec = TTL_SEC): Promise<string> {
  mintCalls++;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: OWNER, ver: USER_TOKEN_VER, act: { owner: OWNER, actor, scope: [], lifecycleUid: smokeUid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(OWNER)
    .setIssuedAt(now - 5).setNotBefore(now - 5).setExpirationTime(now + ttlSec)
    .sign(privateKey as CryptoKey);
}

/** Every callout denial, exactly as the auth service logs it: the per-attempt connection nkey and
 *  the reason. This is the live evidence stream the issue was measured from. */
const denials: Array<{ ms: number; nkey: string; reason: string }> = [];
const t0 = Date.now();

let calloutNc: NatsConnection | undefined, witnessNc: NatsConnection | undefined;
let epA: CotalEndpoint | undefined, epA2: CotalEndpoint | undefined, epB: CotalEndpoint | undefined, epD: CotalEndpoint | undefined;
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
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: smokeUid, scope: [] })),
    log: (l) => {
      // One line per answered request; every outcome but `minted` refused the connect.
      const m = /outcome=(denied|timeout|shed) req=(\S+).*?(?: reason=(".*"))?$/.exec(l);
      if (m) denials.push({ ms: Date.now() - t0, nkey: m[2]!, reason: m[3] ? JSON.parse(m[3]) as string : m[1]! });
    },
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
  // The refusal below is a RECOVERABLE condition: the reestablish loop owns the retry, so #1119
  // reclassified it from `error` to `warning` (an unhandled `error` kills a listenerless host).
  // Watch the channel it is actually emitted on, and assert the classification separately.
  const warningsA: Array<{ ms: number; msg: string }> = [];
  epA.on("warning", (e: Error) => warningsA.push({ ms: Date.now() - t0, msg: e.message }));
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
  const refusals = warningsA.filter((e) => /no bearer source to renew it/.test(e.msg));
  check(
    "the refusal to dial is loud and names the missing renewal path",
    refusals.length > 0,
    { warnings: warningsA.map((e) => e.msg), errors: errorsA.map((e) => e.msg) },
  );
  // And said once. The rebuild loop keeps retrying on its capped backoff, but a line per attempt
  // is what turned one stuck seat into a log that grows for as long as the process lives.
  check("the refusal is surfaced once, not once per rebuild attempt", refusals.length === 1, { attemptsAtMs: refusals.map((e) => e.ms) });

  // Keep #1119's classification true: this path retries on its own, so surfacing it as `error`
  // would kill a host that never registered a listener. That regression is invisible to the cell
  // above, which passes on either channel once it is looking at the right one.
  check(
    "the recoverable refusal stays off the error channel",
    errorsA.every((e) => !/no bearer source to renew it/.test(e.msg)),
    errorsA.map((e) => e.msg),
  );

  await epA.stop();
  epA = undefined;

  // ARM A2 — a renewal source that stops answering after the first token. The bearer dies under the
  // live connection; the endpoint must not present it, must not call the source once per rebuild,
  // and must say so once.
  const sourceFailuresAtMs: number[] = [];
  let exchangeUp = true;
  const warningsA2: Array<{ ms: number; msg: string }> = [];
  epA2 = new CotalEndpoint({
    space, servers: SERVERS,
    bearer: async () => {
      if (exchangeUp) return bearer("agentthree");
      sourceFailuresAtMs.push(Date.now() - t0);
      throw new Error("the auth exchange is not answering");
    },
    sentinelCreds: callout.sentinelCreds,
    card: { name: "renewal-failing", kind: "agent", owner: OWNER, actor: "agentthree" },
    channels: ["general"],
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  epA2.on("error", () => { /* the expiry close is expected here */ });
  epA2.on("warning", (e: Error) => warningsA2.push({ ms: Date.now() - t0, msg: e.message }));
  await epA2.start();
  exchangeUp = false;
  const denialsBeforeA2 = denials.length;
  await wait(TTL_SEC * 1000 + ARM_A_WATCH_MS);
  const armA2 = denials.slice(denialsBeforeA2).filter((d) => /exp/i.test(d.reason));
  check("an endpoint whose renewal is failing presents its expired bearer ZERO times", armA2.length === 0, { denials: armA2.length });
  check(
    "the failing renewal is reported once, and the expired-bearer refusal at most once",
    warningsA2.filter((e) => /bearer refresh failed/.test(e.msg)).length === 1 &&
      warningsA2.filter((e) => /renewal through the auth exchange is failing/.test(e.msg)).length <= 1,
    warningsA2.map((e) => e.msg),
  );
  // The retry wait must GROW. Flat-rate retrying is the defect: a source that did not answer one
  // second ago is no likelier to answer now, so the same call at the same interval forever is pure
  // load. A source call per rebuild attempt would also show here, as a gap far below the backoff.
  const sourceGaps = sourceFailuresAtMs.slice(1).map((ms, i) => ms - sourceFailuresAtMs[i]!);
  check(
    "the failing source is retried on a growing wait",
    sourceFailuresAtMs.length >= 3 && sourceGaps[0]! >= 2_500 && sourceGaps.every((g, i) => i === 0 || g >= sourceGaps[i - 1]!),
    { callsAtMs: sourceFailuresAtMs, gaps: sourceGaps },
  );
  await epA2.stop();
  epA2 = undefined;

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
  await epB.stop();
  epB = undefined;

  // ARM D — bearers long enough to renew inside their lifetime. Each new bearer moves the live
  // connection onto itself, so the broker never has to close it at the old one's expiry.
  const errorsD: string[] = [];
  const mintsBeforeD = mintCalls;
  const denialsBeforeD = denials.length;
  epD = new CotalEndpoint({
    space, servers: SERVERS,
    bearer: () => bearer("agentfour", LONG_TTL_SEC), sentinelCreds: callout.sentinelCreds,
    card: { name: "swapping", kind: "agent", owner: OWNER, actor: "agentfour" },
    channels: ["general"],
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  epD.on("error", (e: Error) => errorsD.push(e.message));
  epD.on("warning", (e: Error) => errorsD.push(e.message));
  await epD.start();
  await wait(ARM_D_WATCH_MS);
  let sentD: CotalMessage | undefined;
  try { sentD = await epD.multicast("after-swaps", { channel: "general" }); } catch { /* reported below */ }
  check("a renewing endpoint renews several times inside the watch", mintCalls - mintsBeforeD >= 3, { mints: mintCalls - mintsBeforeD });
  check("the broker never closed it for an expired bearer", !errorsD.some((m) => /Authentication Expired/i.test(m)), errorsD);
  check("and it still publishes on the swapped connection", !!sentD && (await until(() => got.some((g) => g.id === sentD!.id))));
  check("the swaps presented no expired bearer", denials.slice(denialsBeforeD).length === 0, denials.slice(denialsBeforeD));

  console.log(`\nEXPIRY-RENEWAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  console.log(`\nEXPIRY-RENEWAL SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  process.exitCode = 1;
} finally {
  for (const ep of [epA, epA2, epB, epD]) { try { await ep?.stop(); } catch { /* */ } }
  for (const nc of [witnessNc, calloutNc]) { try { await nc?.close(); } catch { /* */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

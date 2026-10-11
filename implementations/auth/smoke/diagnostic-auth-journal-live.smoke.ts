import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import { CotalEndpoint, createSpaceAuth, isReachable, serverConfig } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createCalloutAuth, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";
import { diagnosticAuthCorrelation } from "./_diagnostic-auth-correlation.js";
import { pickFreePort } from "./_free-port.js";

// Separate source test. It does not add controls or network calls to the retained acceptance entry.
const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`;
const space = `journal-${randomUUID().slice(0, 8)}`, trust = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: trust.operator.seed, accountPub: trust.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "-auth-journal-"));
writeFileSync(join(dir, "nats.conf"), serverConfig(trust, [trust], { transport: { kind: "plaintext" }, port,
  storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "nats.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir), clients: CotalEndpoint[] = [], connections: NatsConnection[] = [];
const brokerExit = new Promise<void>(resolve => broker.once("exit", () => resolve()));
const enc = (value: string) => new TextEncoder().encode(value);
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const issuer = "https://journal.auth.test", owner = deriveOwnerToken("j".repeat(32), "journal-human");
const now = Math.floor(Date.now() / 1000);
const bearer = await new SignJWT({ ver: USER_TOKEN_VER, act: { owner, actor: "journal_actor", scope: [] } })
  .setProtectedHeader({ alg: "EdDSA" }).setSubject(owner).setIssuer(issuer).setAudience(space)
  .setIssuedAt(now - 1).setNotBefore(now - 1).setExpirationTime(now + 300).sign(privateKey as CryptoKey);
let passed = 0, failed = 0, actorDenied = false, actorCalls = 0, permissionCalls = 0, mintCalls = 0;
async function check(cell: string, test: () => Promise<void> | void) {
  try { await test(); passed++; console.log(JSON.stringify({ cell, passed: true })); }
  catch { failed++; console.log(JSON.stringify({ cell, passed: false })); }
}
function client(armed: boolean) {
  const endpoint = new CotalEndpoint({ space, servers, bearer, sentinelCreds: callout.sentinelCreds,
    card: { name: "journal-live", kind: "endpoint" }, tls: false, consume: false,
    registerPresence: false, watchPresence: false, watchChannels: false,
    onConnection: nc => connections.push(nc) });
  clients.push(endpoint); endpoint.on("error", () => {});
  if (armed) endpoint.armDiagnosticAuthJournal();
  return endpoint;
}
try {
  let ready = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ready);
  const nc = await connect({ servers, authenticator: credsAuthenticator(enc(callout.calloutCreds)) }); connections.push(nc);
  const handler = startAuthCallout(nc, { xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: trust.account.pub, signingSeed: trust.account.signingSeed }, space,
    token: { key: publicKey as CryptoKey, issuer },
    authorizeActor: () => { actorCalls++; if (actorDenied) throw new Error("test actor denial"); },
    permissionsFor: (_token, nonce) => { permissionCalls++; return { pub: { allow: [`_INBOX_${nonce}.>`] }, sub: { allow: [`_INBOX_${nonce}.>`] } }; },
    onMint: () => { mintCalls++; }, log: () => {} });
  await nc.flush();
  await check("DJL01-default-off-actual-endpoint-callout", async () => {
    const endpoint = client(false); await endpoint.start();
    assert.equal(endpoint.readDiagnosticAuthJournal().armed, false);
    assert.equal(handler.readDiagnosticJournal().armed, false);
    assert.deepEqual([actorCalls, permissionCalls, mintCalls], [1, 1, 1]);
    await endpoint.stop();
  });
  handler.armDiagnosticJournal();
  await check("DJL02-opt-in-actual-success-same-stock-decisions", async () => {
    const endpoint = client(true); await endpoint.start();
    const snapshot = endpoint.readDiagnosticAuthJournal(), server = handler.readDiagnosticJournal();
    assert.equal(snapshot.flightCount, 1); assert.equal(snapshot.flights[0]?.outcome, "fulfilled");
    assert.equal(snapshot.flights[0]?.challengeCount, 1); assert.equal(snapshot.unsupported, false);
    assert.equal(server.requestCount, 1); assert.equal(server.requests[0]?.stages["response-invoke"], "returned");
    assert.deepEqual([actorCalls, permissionCalls, mintCalls], [2, 2, 2]);
    assert.equal(server.requests[0]?.challenge, snapshot.flights[0]?.challenges[0]);
    assert.equal(server.requests[0]?.instance, snapshot.flights[0]?.instance);
    assert.equal(snapshot.flights[0]?.value, connections.at(-1));
    endpoint.armDiagnosticAuthJournal(); handler.armDiagnosticJournal();
    assert.equal(endpoint.readDiagnosticAuthJournal().flightCount, 1); assert.equal(handler.readDiagnosticJournal().requestCount, 1);
    await endpoint.stop();
  });
  actorDenied = true;
  await check("DJL03-actual-denial-original-error-private-join", async () => {
    const endpoint = client(true); let original: unknown;
    try { await endpoint.start(); } catch (error) { original = error; }
    assert.ok(original instanceof Error);
    const snapshot = endpoint.readDiagnosticAuthJournal();
    assert.equal(snapshot.flights[0]?.value, original); assert.equal(snapshot.flights[0]?.outcome, "rejected");
    const server = handler.readDiagnosticJournal(), projection = diagnosticAuthCorrelation(snapshot, server, original);
    assert.ok(projection.correlation === "exact" || projection.correlation === "correlated-set");
    assert.equal(projection.errorOwnedFlightCount, 1); assert.equal(projection.matchingRequestCount, 1);
    assert.equal(projection.observations[0]?.stages["actor-authorization"], "threw");
    assert.equal(projection.observations[0]?.stages["response-invoke"], "returned");
    assert.deepEqual([actorCalls, permissionCalls, mintCalls], [3, 2, 2]);
    const text = JSON.stringify(projection);
    for (const request of server.requests) for (const value of [request.challenge, request.instance, request.server, request.requestKey])
      if (value !== null) assert.equal(text.includes(value), false);
    assert.equal(text.includes(bearer), false); assert.equal(text.includes(original.message), false);
    await endpoint.stop();
  });
  await check("DJL04-default-off-denial-still-denied", async () => {
    const endpoint = client(false); await assert.rejects(() => endpoint.start());
    assert.equal(endpoint.readDiagnosticAuthJournal().armed, false);
    assert.deepEqual([actorCalls, permissionCalls, mintCalls], [4, 2, 2]); await endpoint.stop();
  });
} catch { failed++; console.log(JSON.stringify({ cell: "DJL00-setup", passed: false })); }
finally {
  for (const endpoint of clients) try { await endpoint.stop(); } catch { failed++; }
  for (const nc of connections) try { await nc.close(); assert.equal(await nc.closed(), undefined); } catch { failed++; }
  broker.kill("SIGTERM"); await brokerExit;
  rmSync(dir, { recursive: true, force: true }); release();
}
console.log(`COTAL_SMOKE_SENTINEL cells=${passed + failed} passed=${passed} failed=${failed}`);
if (failed) process.exitCode = 1;

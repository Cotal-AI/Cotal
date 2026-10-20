/** Persistent user-auth join uses the stock provider, exchange, callout and delivery daemon.
 * The signed IdP fixture implements /token and JWKS. It is not a fake Cotal bearer issuer.
 * The source CLI runs inside a real terminal (util-linux script); no endpoint/auth double.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { CotalEndpoint, chatSubject, mintCreds, mintLifecycleUid, newIdentity, principalKey, provisionAgentDurables, setupSpaceStreams } from "@cotal-ai/core";
import { findMesh, recordMesh, userAuthStateDir } from "@cotal-ai/workspace";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, saveIdpSession, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel, killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") {
  skipSuite("join-user requires util-linux script for its real terminal");
} else {
  const fx = await startHostedAuthFixture("join-user", 1);
  const a = fx.accounts[0]!;
  const root = join(fx.dir, "participant"), home = join(fx.dir, "home");
  mkdirSync(join(root, ".cotal"), { recursive: true });
  mkdirSync(home);
  process.env.COTAL_HOME = home;
  const key = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(key.publicKey), kid: "join-user-idp" };
  let tokenReads = 0, loginRevoked = false;
  let origin = "";
  const idp = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url !== "/api/auth/token") { res.writeHead(404); return void res.end("{}"); }
    if (loginRevoked || req.headers.authorization !== "Bearer join-user-private-session") {
      res.writeHead(401); return void res.end("{}");
    }
    tokenReads++;
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject("human").setIssuedAt(now).setExpirationTime(now + 12).sign(key.privateKey);
    res.end(JSON.stringify({ token }));
  });
  await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/jwks` }), { mode: 0o600 });
  const secret = (await loadOwnerSecret(a.store, a.space))!;
  const owner = deriveOwnerForIdpSubject(secret, origin, "human");
  const uid = mintLifecycleUid();
  grantActor(a.stateDir, { owner, actor: "cli", lifecycleUid: uid, scope: [], allowSubscribe: ["general"], allowPublish: ["general"] });
  let service: AuthServiceHandle | undefined, prov: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined, sender: CotalEndpoint | undefined, witness: CotalEndpoint | undefined;
  let leaseRevision: number | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  let leaseFailure: unknown;
  type Worker = { child: ChildProcessWithoutNullStreams; output: string; closed: boolean; code?: number | null };
  const workers: Worker[] = [];
  let passed = 0;
  const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end) await wait(50);
    return condition();
  };
  const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), NO_COLOR: "1", TERM: "dumb" };
  for (const name of Object.keys(env)) if (name.startsWith("COTAL_") && name !== "COTAL_HOME") delete env[name as keyof typeof env];
  const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const entry = fileURLToPath(new URL("./join-user-entry.fixture.ts", import.meta.url));
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  function launch(values: Record<string, unknown>): Worker {
    const command = [process.execPath, "--import", loader, entry].map(quote).join(" ");
    const child = spawn("script", ["-qefc", command, "/dev/null"], { cwd: root, env: { ...env, JOIN_VALUES: JSON.stringify(values) }, stdio: ["pipe", "pipe", "pipe"] });
    const worker: Worker = { child, output: "", closed: false };
    child.stdout.on("data", (b: Buffer) => { worker.output += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { worker.output += b.toString(); });
    child.once("close", code => { worker.closed = true; worker.code = code; });
    workers.push(worker);
    return worker;
  }
  const lines = (w: Worker, text: string) => w.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).filter(line => line.includes(`: ${text}`));
  try {
    const creds = await mintCreds(a.auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers: fx.servers, space: a.space, creds });
    service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.stateDir, publicFace: { port: 0, trustedProxy: false } });
    const stateDir = userAuthStateDir(root, a.space);
    mkdirSync(stateDir, { recursive: true });
    const sentinel = join(stateDir, "sentinel.creds");
    writeFileSync(sentinel, a.sentinelCreds, { mode: 0o600 });
    recordMesh({ space: a.space, server: fx.servers, root, mode: "user", origin: "manual", policy: { events: "required" }, userAuth: { provider: "cotal", remote: true, idp: { url: `${origin}/api/auth`, issuer: origin, audience: origin }, endpoints: { url: service.publicUrl! }, sentinelCredsPath: sentinel }, ts: new Date().toISOString() });
    saveIdpSession(home, `${origin}/api/auth`, { token: "join-user-private-session", expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "human" });
    prov = new CotalEndpoint({ space: a.space, servers: fx.servers, creds, channels: [], consume: false, registerPresence: false, watchPresence: false, card: { name: "provisioner", kind: "endpoint" } });
    prov.on("error", () => {});
    await prov.start();
    await provisionAgentDurables(prov, { owner, actor: "cli", lifecycleUid: uid }, { subscribe: ["general"], allowSubscribe: ["general"] });
    daemon = new CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "delivery"), channels: [], consume: false, registerPresence: false, card: { name: "delivery", kind: "endpoint" } });
    daemon.on("error", () => {});
    await daemon.start();
    leaseRevision = await daemon.acquireDeliveryLease(0);
    await daemon.startPlane3((o, u) => daemon!.aclForOwner(o, u));
    leaseRevision = await daemon.markDeliveryLeaseReady(0, leaseRevision);
    leaseTimer = setInterval(() => {
      void daemon!.renewDeliveryLease(0, leaseRevision!).then(r => { leaseRevision = r; }, e => { leaseFailure = e; });
    }, 5_000);
    sender = new CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "operator"), channels: [], consume: false, registerPresence: false, watchPresence: false, card: { name: "sender", kind: "endpoint" } });
    sender.on("error", () => {});
    await sender.start();
    witness = new CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "admin"), channels: [], consume: false, registerPresence: false, watchPresence: false, card: { name: "event-witness", kind: "endpoint" } });
    witness.on("error", () => {});
    await witness.start();
    const events: string[] = [];
    witness.tap(subject => { events.push(subject); }, { subject: chatSubject(a.space, owner, "cli", `events.${owner}.cli`) });
    check("real auth-service, callout and delivery are ready", (await service.readiness()).state === "ready");
    const human = launch({ space: a.space, name: "human", channel: "general" });
    await until(() => human.output.includes("Joined ") || human.closed);
    check(`required-events join reaches a real terminal without a harness: ${human.output}`, human.output.includes("Joined ") && !human.closed);
    const cli = principalKey(owner, "cli").key;
    check("presence is the stock cli bearer principal", await until(() => daemon!.getRoster().some(p => p.card.id === cli && p.card.name === "human")));
    await sender.multicast("join-channel-one", { channel: "general" });
    await sender.unicast(cli, "join-dm-one");
    check("live channel and DM are printed", await until(() => lines(human, "join-channel-one").length > 0 && lines(human, "join-dm-one").length > 0));
    await wait(500);
    check("channel and DM print once", lines(human, "join-channel-one").length === 1 && lines(human, "join-dm-one").length === 1);
    const beforeRefresh = tokenReads;
    check("resident join refreshes through stock login and exchange", await until(() => tokenReads > beforeRefresh, 12_000));
    await wait(13_000);
    await sender.unicast(cli, "after-original-expiry");
    check("receive survives the initial twelve-second bearer", await until(() => lines(human, "after-original-expiry").length === 1));
    human.child.stdin.write("join-outbound-one\n");
    check("terminal can send on its granted channel", await until(() => human.output.includes("you: join-outbound-one")));
    check("no synthetic AGUI frames are published on the cli event subject", events.length === 0);
    const staticFile = join(fx.dir, "explicit.creds");
    writeFileSync(staticFile, creds, { mode: 0o600 });
    const staticAttempt = launch({ space: a.space, creds: staticFile, "lifecycle-uid": uid });
    const staticClosed = await until(() => staticAttempt.closed);
    check(`explicit static credential is still refused on known user-auth space: ${staticAttempt.output}`, staticClosed && /per-user-auth mesh/.test(staticAttempt.output) && !staticAttempt.output.includes("Joined "));
    loginRevoked = true;
    check("revoked login is surfaced by native renewal", await until(() => human.output.includes("bearer refresh failed") && human.output.includes("rejected the cached session"), 12_000));
    const readsBeforeRefusal = tokenReads;
    const refused = launch({ space: a.space, name: "refused" });
    check("new join cannot bypass revoked login", await until(() => refused.closed) && refused.output.includes("rejected the cached session") && !refused.output.includes("Joined ") && tokenReads === readsBeforeRefusal);
    human.child.stdin.write("/quit\n");
    check("quit drains the resident session", await until(() => human.closed));
    loginRevoked = false;
    const trusted = findMesh(a.space)!;
    const { policy: _policy, ...unrestricted } = trusted;
    recordMesh({ ...unrestricted, policyCheckedAt: new Date().toISOString() });
    const trustProbe = launch({ space: a.space, name: "trust-probe" });
    check("user-auth join also starts without an events policy", await until(() => trustProbe.output.includes("Joined ")));
    const readsBeforeTrustChange = tokenReads;
    recordMesh({ ...trusted, userAuth: { ...trusted.userAuth!, endpoints: { url: `${origin}/untrusted-exchange` } } });
    check("renewal refuses changed registration before another login proof is fetched", await until(() => trustProbe.output.includes("join registration trust changed"), 12_000) && tokenReads === readsBeforeTrustChange);
    trustProbe.child.stdin.write("/quit\n");
    check("trust-pinned session can still drain", await until(() => trustProbe.closed));
    recordMesh({ ...trusted, tlsRequired: true });
    const tlsProbe = launch({ space: a.space, name: "tls-probe" });
    const tlsClosed = await until(() => tlsProbe.closed);
    check("recorded TLS requirement refuses plaintext with a concise actionable diagnostic", tlsClosed && tlsProbe.code === 1 && /TLS is required to join .*server does not support TLS/.test(tlsProbe.output) && /Ask the mesh operator for its TLS-enabled broker address/.test(tlsProbe.output) && !/ConnectionError:|\n\s+at (?:async )?\S+/.test(tlsProbe.output) && !tlsProbe.output.includes("Joined "));
    check("native delivery lease remained owned throughout", leaseFailure === undefined);
    console.log(`join-user: ${passed} assertions passed`);
    emitSentinel({ passed, failed: 0 });
  } finally {
    for (const worker of workers) {
      if (!worker.closed) { worker.child.stdin.write("/quit\n"); await until(() => worker.closed, 3000); }
      if (!worker.closed) await killAndAwaitExit(worker.child, "SIGKILL");
    }
    await sender?.stop();
    await witness?.stop();
    clearInterval(leaseTimer);
    await daemon?.releaseDeliveryLease(0, leaseRevision);
    await daemon?.stop();
    await prov?.stop();
    await service?.close();
    await new Promise<void>(resolve => idp.close(() => resolve()));
    await fx.close();
  }
}

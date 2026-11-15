/** Loopback signed-in participant for the real installed update harness. No Manager is started. */
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { checkDiscoveryDocument, discoveryDocumentUrl, findMesh, getCurrent, recordMesh, refreshRegistrationPolicy, setCurrent, userAuthStateDir } from "@cotal-ai/workspace";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, saveIdpSession, startAuthService } from "../src/index.js";
import { bootDeliveryDaemon } from "../../manager/smoke/_boot-delivery.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

export interface UpdateParticipantContext {
  env: NodeJS.ProcessEnv;
  project: string;
  cotalHome: string;
  report: Record<string, unknown>;
}

/** Uses the same broker/auth/IdP composition as join-user.smoke.ts, with an hour-long test session. */
export async function prepareUpdateParticipant(context: UpdateParticipantContext): Promise<() => Promise<void>> {
  const { env, project, cotalHome, report } = context;
  assert(env.HOME && env.COTAL_HOME === cotalHome && env.XDG_CONFIG_HOME && env.TMPDIR, "fixture requires private paths");
  const pathKeys = ["HOME", "COTAL_HOME", "XDG_CONFIG_HOME", "TMPDIR"] as const;
  const prior = Object.fromEntries(pathKeys.map(key => [key, process.env[key]]));
  for (const key of pathKeys) process.env[key] = env[key];
  let fixture: Awaited<ReturnType<typeof startHostedAuthFixture>> | undefined;
  let idp: Server | undefined;
  let exchange: Server | undefined;
  let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
  let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
  let tokenReads = 0;
  const close = async () => {
    report.participant = { ...report.participant as object, tokenReads, localManagerStarted: false };
    try { await service?.close(); }
    finally {
      try { await delivery?.stop(); }
      finally {
        try {
          try {
            if (exchange?.listening) await new Promise<void>((resolve, reject) => exchange!.close(error => error ? reject(error) : resolve()));
          } finally {
            if (idp?.listening) await new Promise<void>((resolve, reject) => idp!.close(error => error ? reject(error) : resolve()));
          }
        } finally {
          try { await fixture?.close(); }
          finally {
            for (const key of pathKeys) {
              if (prior[key] === undefined) delete process.env[key];
              else process.env[key] = prior[key];
            }
          }
        }
      }
    }
  };
  try {
    fixture = await startHostedAuthFixture("update-participant", 1);
    const account = fixture.accounts[0]!;
    const key = await generateKeyPair("EdDSA");
    const jwk = { ...await exportJWK(key.publicKey), kid: "update-participant-idp" };
    const session = "update-participant-private-test-session";
    let origin = "";
    idp = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/jwks") return void response.end(JSON.stringify({ keys: [jwk] }));
      if (request.url !== "/api/auth/token") { response.writeHead(404); response.end("{}"); return; }
      if (request.headers.authorization !== `Bearer ${session}`) { response.writeHead(401); response.end("{}"); return; }
      try {
        tokenReads++;
        const now = Math.floor(Date.now() / 1000);
        const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid })
          .setIssuer(origin).setAudience(origin).setSubject("human").setIssuedAt(now).setExpirationTime(now + 3600).sign(key.privateKey);
        response.end(JSON.stringify({ token }));
      } catch { response.writeHead(500); response.end("{}"); }
    });
    await new Promise<void>((resolve, reject) => { idp!.once("error", reject); idp!.listen(0, "127.0.0.1", resolve); });
    origin = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
    writeFileSync(join(account.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/jwks` }), { mode: 0o600 });
    const secret = await loadOwnerSecret(account.store, account.space);
    assert(secret, "fixture owner secret exists");
    const owner = deriveOwnerForIdpSubject(secret, origin, "human");
    grantActor(account.stateDir, { owner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["admin", "spawn", "supervise"], allowSubscribe: [">"], allowPublish: [">"] });
    const provisioner = await mintCreds(account.auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers: fixture.servers, space: account.space, creds: provisioner });
    delivery = await bootDeliveryDaemon({ space: account.space, servers: fixture.servers, auth: account.auth, reloadStoreIdentity: account.store.identity });
    report.deliveryFixture = { kind: "real delivery-admin and Plane-3 endpoint", ready: true };
    // This test broker is plaintext on loopback. Its own discovery must say so, while the
    // production public face deliberately advertises TLS. All auth routes still use that face.
    let upstream: string | undefined;
    let exchangeUrl = "";
    exchange = createServer(async (request, response) => {
      if (!upstream) { response.writeHead(503); response.end(); return; }
      let target: URL;
      try {
        assert(typeof request.url === 'string' && request.url.startsWith('/') && !request.url.startsWith('//'));
        target = new URL(request.url, upstream);
        assert.equal(target.origin, new URL(upstream).origin);
      } catch { response.writeHead(400); response.end(); return; }
      if (request.method === "GET" && request.url === "/.well-known/cotal-mesh") {
        try {
          const fetched = await fetch(target);
          assert(fetched.ok, "fixture discovery upstream must answer");
          const bundle = await fetched.json() as { userAuth: { endpoints: Record<string, unknown> } };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ...bundle, tlsRequired: false, userAuth: { ...bundle.userAuth, endpoints: { ...bundle.userAuth.endpoints, url: exchangeUrl, managerAuthorityUrl: `${exchangeUrl}/manager-service-authority` } } }));
        } catch { response.writeHead(502); response.end(); }
        return;
      }
      const forwarded = httpRequest(target, { method: request.method, headers: request.headers }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      forwarded.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(forwarded);
    });
    await new Promise<void>((resolve, reject) => { exchange!.once("error", reject); exchange!.listen(0, "127.0.0.1", resolve); });
    exchangeUrl = `http://127.0.0.1:${(exchange.address() as { port: number }).port}`;
    service = await startAuthService({ context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: account.space, servers: fixture.servers, store: account.store, storeIdentity: account.store.identity, stateDir: account.stateDir, publicFace: { port: 0, trustedProxy: false } });
    assert(service.publicUrl, "fixture requires the real public listener");
    upstream = service.publicUrl;
    const checked = await checkDiscoveryDocument(await fetch(discoveryDocumentUrl(new URL(exchangeUrl))));
    assert(checked.ok, "fixture must register its validated discovery");
    const bundle = checked.value;
    const participantState = userAuthStateDir(project, account.space);
    mkdirSync(participantState, { recursive: true, mode: 0o700 });
    const sentinel = join(participantState, "sentinel.creds");
    writeFileSync(sentinel, bundle.sentinelCreds, { mode: 0o600 });
    recordMesh({ space: bundle.space, server: bundle.server, tlsRequired: bundle.tlsRequired, root: project, mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: { ...bundle.userAuth, remote: true, sentinelCredsPath: sentinel } });
    await refreshRegistrationPolicy({ space: bundle.space });
    saveIdpSession(cotalHome, `${origin}/api/auth`, { token: session, expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "human" });
    setCurrent(account.space);
    assert.equal((await service.readiness()).state, "ready", "real auth service is ready");
    const selected = findMesh(getCurrent()!);
    assert.equal(selected?.space, account.space, "participant is selected");
    assert.equal(selected?.userAuth?.remote, true, "selected participant uses remote user sign-in");
    report.participant = { space: account.space, server: fixture.servers, owner, remote: true, selected: true, localManagerStarted: false };
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}

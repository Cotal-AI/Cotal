/** Loopback signed-in participant for the real installed update harness. No Manager is started. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { recordMesh, setCurrent, userAuthStateDir } from "@cotal-ai/workspace";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, saveIdpSession, startAuthService } from "../src/index.js";
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
  const fixture = await startHostedAuthFixture("update-participant", 1);
  const account = fixture.accounts[0]!;
  const key = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(key.publicKey), kid: "update-participant-idp" };
  const session = "update-participant-private-test-session";
  let origin = "", tokenReads = 0;
  const idp = createServer(async (request, response) => {
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
  let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
  const close = async () => {
    report.participant = { space: account.space, server: fixture.servers, remote: true, tokenReads, localManagerStarted: false };
    try { await service?.close(); }
    finally {
      try {
        if (idp.listening) await new Promise<void>((resolve, reject) => idp.close(error => error ? reject(error) : resolve()));
      } finally {
        try { await fixture.close(); }
        finally {
          for (const key of pathKeys) {
            if (prior[key] === undefined) delete process.env[key];
            else process.env[key] = prior[key];
          }
        }
      }
    }
  };
  try {
    await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
    writeFileSync(join(account.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/jwks` }), { mode: 0o600 });
    const secret = await loadOwnerSecret(account.store, account.space);
    assert(secret, "fixture owner secret exists");
    const owner = deriveOwnerForIdpSubject(secret, origin, "human");
    grantActor(account.stateDir, { owner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["admin", "spawn", "supervise"], allowSubscribe: [">"], allowPublish: [">"] });
    const provisioner = await mintCreds(account.auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers: fixture.servers, space: account.space, creds: provisioner });
    service = await startAuthService({ context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: account.space, servers: fixture.servers, store: account.store, storeIdentity: account.store.identity, stateDir: account.stateDir, publicFace: { port: 0, trustedProxy: false } });
    const participantState = userAuthStateDir(project, account.space);
    mkdirSync(participantState, { recursive: true, mode: 0o700 });
    const sentinel = join(participantState, "sentinel.creds");
    writeFileSync(sentinel, account.sentinelCreds, { mode: 0o600 });
    recordMesh({ space: account.space, server: fixture.servers, root: project, mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: { provider: "cotal", remote: true, idp: { url: `${origin}/api/auth`, issuer: origin, audience: origin }, endpoints: { url: service.publicUrl! }, sentinelCredsPath: sentinel } });
    saveIdpSession(cotalHome, `${origin}/api/auth`, { token: session, expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "human" });
    setCurrent(account.space);
    assert.equal((await service.readiness()).state, "ready", "real auth service is ready");
    report.participant = { space: account.space, server: fixture.servers, remote: true, localManagerStarted: false };
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}

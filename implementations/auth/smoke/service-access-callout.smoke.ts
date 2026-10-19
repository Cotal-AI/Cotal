import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { createSpaceAuth, serverConfig, isReachable, contractDigest, serviceEndpointActor, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createCalloutAuth, startAuthCallout } from "../src/callout.js";
import { createUserTokenIssuer, generateSigningKey } from "../src/issuer.js";
import { validateUserToken } from "../src/token.js";
import { pickFreePort } from "./_free-port.js";

const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`, space = `service-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"),
  extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const exited = new Promise<void>((resolve, reject) => { srv.once("exit", () => resolve()); srv.once("error", reject); });
const issuer = createUserTokenIssuer({ issuer: "https://service-access.test", key: await generateSigningKey() });
const owner = `u_${"a".repeat(26)}`, instanceId = "i".repeat(32), endpoint = "org.example.orders";
const identity = { accountPublicKey: auth.account.pub, space, owner, endpoint, instanceId };
const witness: ServiceRegistrationWitness = { accountPublicKey: auth.account.pub, space, endpoint, instanceId,
  principal: { owner, actor: serviceEndpointActor(identity), lifecycleUid: "l".repeat(32) }, rootCredentialId: "r".repeat(32),
  approvalDigest: contractDigest({ approval: 1 }), processEpoch: 1, registrationRevision: 2, nameAuthorityRevision: 1,
  registrationRequestId: "a".repeat(32), registrationProof: contractDigest({ registration: 1 }) };
const enc = (s: string) => new TextEncoder().encode(s);
const conns: NatsConnection[] = [], hooks: string[] = [], logs: string[] = [];
const dial = async (bearer: string) => {
  const nonce = randomUUID().replaceAll("-", "");
  const nc = await connect({ servers, name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: 4000, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearer)] });
  conns.push(nc); return nc;
};
try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) { up = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(up, "owned broker becomes ready");
  const nc = await connect({ servers, authenticator: credsAuthenticator(enc(callout.calloutCreds)) }); conns.push(nc);
  startAuthCallout(nc as never, {
    xkeySeed: callout.xkey.seed, authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, space,
    token: { issuer: issuer.issuer, key: issuer.localKeySet() },
    // Deliberately permissive ordinary hooks: the service view must never reach them.
    authorizeActor: () => { hooks.push("actor"); },
    permissionsFor: (_token, nonce) => { hooks.push("permissions"); return { pub: { allow: [`_INBOX_${nonce}.>`] }, sub: { allow: [`_INBOX_${nonce}.>`] } }; },
    recordIssuance: async () => { hooks.push("record"); }, onMint: () => { hooks.push("mint"); }, log: (line) => logs.push(line),
  });
  await nc.flush();
  await dial(await issuer.issue({ owner, actor: "control", space, ttlSec: 60 }));
  assert.deepEqual(hooks, ["actor", "permissions", "record", "mint"], "ordinary control reaches its normal hooks");
  hooks.length = 0;
  const serviceBearer = await issuer.issueServiceAccess({ witness, expiresAt: Math.floor(Date.now() / 1000) + 45 });
  await validateUserToken(serviceBearer, { issuer: issuer.issuer, audience: space, key: issuer.localKeySet() });
  await assert.rejects(dial(serviceBearer), /authorization violation/i);
  assert.deepEqual(hooks, [], "service refusal precedes every ordinary hook and native mint");
  assert.ok(logs.some((line) => line.includes("requires dedicated native service authority")), "denial reaches the intended service boundary");
  console.log("service access callout: signed valid service bearer refused before ordinary hooks; ordinary control connected");
} finally {
  for (const nc of conns.reverse()) await nc.close().catch(() => {});
  srv.kill("SIGKILL"); await exited;
  rmSync(dir, { recursive: true, force: true }); releaseBroker();
}

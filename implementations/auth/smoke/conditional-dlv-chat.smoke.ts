/** Channel-less chat admission drives the shipped HTTP authority and native consumer readback. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { createSuite } from "@cotal-ai/smoke-kit";
import { dlvDurable, dlvStream, dmDurable, dmStream, isConsumerNotFound, mintCreds, mintLifecycleUid, newIdentity, registry, setupSpaceStreams, standaloneConnectOpts, type AuthProvider } from "@cotal-ai/core";
import { openUserChatSession, type NativeChatSession } from "@cotal-ai/workspace/chat";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("channel-less-chat", 1);
const account = fx.accounts[0]!;
let service: AuthServiceHandle | undefined;
let nc: NatsConnection | undefined;
let session: NativeChatSession | undefined;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const kid = "conditional-dlv-idp";
const jwk = { ...await exportJWK(publicKey), kid, alg: "EdDSA" };
const idp = createServer((_req, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
try {
  const issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  writeFileSync(join(account.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${issuer}/api/auth`, issuer, audience: issuer, jwksUri: `${issuer}/jwks` }), { mode: 0o600 });
  const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(account.store, account.space))!, issuer, "chat-person");
  grantActor(account.stateDir, { owner, actor: "cli", scope: [], allowSubscribe: ["general"], allowPublish: [] });
  const creds = await mintCreds(account.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: account.space, creds });
  nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }) });
  const jsm = await jetstreamManager(nc);
  service = await startAuthService({ context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: account.space, servers: fx.servers, stateDir: account.stateDir, store: account.store, storeIdentity: account.store.identity });
  const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid }).setSubject("chat-person").setIssuer(issuer)
    .setAudience(issuer).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  const open = async (read: string[], holderHash: string) => {
    const response = await fetch(`${service!.url}/chat-session/open`, { method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` },
      body: JSON.stringify({ idpToken: token, holderHash, read, post: [], ttlSec: 60 }) });
    const body = await response.json() as { actor?: string; lifecycleUid?: string; code?: string };
    return { status: response.status, body };
  };
  const channel = await open(["general"], "a".repeat(64));
  check("channel-readable chat admission is the live positive control", channel.status === 200 && typeof channel.body.actor === "string" && typeof channel.body.lifecycleUid === "string", { status: channel.status, code: channel.body.code });
  if (channel.status !== 200) throw new Error("positive admission control failed");
  const channelDlv = await jsm.consumers.info(dlvStream(account.space), dlvDurable(owner, channel.body.actor!, channel.body.lifecycleUid!));
  check("channel-readable chat has its native DLV consumer", channelDlv.name === dlvDurable(owner, channel.body.actor!, channel.body.lifecycleUid!));
  const empty = await open([], "b".repeat(64));
  check("channel-less chat admission succeeds without a DLV footprint", empty.status === 200 && typeof empty.body.actor === "string" && typeof empty.body.lifecycleUid === "string", { status: empty.status, code: empty.body.code });
  if (empty.status !== 200) throw new Error("channel-less admission failed");
  const dm = await jsm.consumers.info(dmStream(account.space), dmDurable(owner, empty.body.actor!, empty.body.lifecycleUid!));
  let absent = false;
  try { await jsm.consumers.info(dlvStream(account.space), dlvDurable(owner, empty.body.actor!, empty.body.lifecycleUid!)); }
  catch (error) { if (!isConsumerNotFound(error)) throw error; absent = true; }
  check("channel-less chat retains DM and omits only DLV", dm.name === dmDurable(owner, empty.body.actor!, empty.body.lifecycleUid!) && absent);

  // This adapter forwards every decision to the actual service; it replaces only the saved-login
  // transport so the shipped workspace factory can connect without an interactive fixture login.
  const nativeCall = async (operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch(`${service!.url}/chat-session/${operation}`, { method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` },
      body: JSON.stringify({ idpToken: token, ...body }) });
    if (response.status !== 200) throw new Error(`native chat authority refused with status ${response.status}`);
    return await response.json() as Record<string, unknown>;
  };
  const provider = "conditional-dlv-native-transport";
  registry.register({ kind: "auth-provider", name: provider,
    async openChatSession({ holderHash, label, read, post, ttlSec }) {
      const row = await nativeCall("open", { holderHash, label, read, post, ttlSec });
      return { actor: row.actor as string, lifecycleUid: row.lifecycleUid as string, expiresAt: row.expiresAt as number };
    },
    async chatSessionBearer({ actor, holderProof }) {
      const row = await nativeCall("bearer", { actor, holderProof });
      return { bearer: row.token as string, exp: row.exp as number, sentinelCreds: account.sentinelCreds };
    },
    async retireChatSession({ actor, lifecycleUid, holderProof }) {
      const row = await nativeCall("retire", { actor, lifecycleUid, holderProof });
      return { outcome: row.outcome as "retired" | "alreadyRetired" | "notStarted" | "failed" };
    },
  } as AuthProvider);
  session = await openUserChatSession({ root: account.stateDir, server: fx.servers, space: account.space,
    mode: "user", tlsRequired: false, personaRoot: join(account.stateDir, "agents"), source: "registry",
    userAuth: { provider, idp: { url: `${issuer}/api/auth`, issuer, audience: issuer } } }, {
    label: "channel-less-client", channels: [], read: [], post: [], ttlSec: 60,
    words: { reopen: channel => `chat ${channel}`, answerOne: "answer one message" },
  });
  check("stock user chat adapter starts a native channel-less participant", session !== undefined);
} catch (error) {
  check(`harness: ${error instanceof Error ? error.message : "unknown failure"}`, false);
} finally {
  await session?.close();
  await service?.close();
  await nc?.close();
  idp.closeAllConnections();
  await new Promise<void>(resolve => idp.close(() => resolve()));
  await fx.close();
  if (passed() + failed() !== 5) check(`cell count: ran ${passed() + failed()}, expected 5`, false);
  finish();
}
process.exit(process.exitCode ?? 0);

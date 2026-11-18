/**
 * A per-user-auth connection's private reply inbox is bound to its bearer's principal.
 *
 * Under the auth callout a client names its own inbox, `<owner>-<actor>-<nonce>`, as its connection
 * name, and the callout grants `_INBOX_<name>.>` on it. The callout admits the name only for a bearer
 * of that owner and actor, and refuses a bare nonce, the form older clients send, with the minimum
 * client version.
 *
 * The suite runs the shipped auth service in this process (exchange, callout, permission builder)
 * against a real operator-mode nats-server, with two principals under two IdP subjects:
 *
 *   B1  alice's stock user-mode endpoint connects under her own principal-bound name, and a DM to
 *       her is pulled and handed to her handler.
 *   B2  mallory holds alice's inbox name, as seen on the channel. Connecting with her own bearer
 *       under that name is refused, the callout's refusal names the bearer's own prefix, and no copy
 *       of a later DM reaches her.
 *   B3  a bare inbox nonce under alice's own bearer is refused, and the refusal names the version.
 *   B4  alice's endpoint reconnects under her own principal-bound name, and DMs still arrive.
 *
 * The service-endpoint arm of the callout is graded by smoke:service-access-callout:auth, which
 * holds the native service fixture.
 *
 * Run: pnpm smoke:user-inbox-binding:auth   (needs nats-server on PATH)
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, USER_INBOX_MIN_CLIENT_VERSION, bearerInboxConnId, chatSubject, mintCreds, mintLifecycleUid, newIdentity,
  principalKey, provisionAgentDurables, setupSpaceStreams, type CotalMessage,
} from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const EXPECTED_CELLS = 11;
const { check, finish, passed, failed } = createSuite();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
const until = async (cond: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(50); return cond(); };

// The callout runs in this process and writes one line per answered request to console.error.
const calloutLines: string[] = [];
const stderr = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("auth callout:")) { calloutLines.push(line); return; }
  stderr(...args);
};
const deniedSince = (n: number) => calloutLines.slice(n).filter((l) => l.includes("level=") && /denied/.test(l));

const fx = await startHostedAuthFixture("inboxbind", 1);
const a = fx.accounts[0]!;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "inbox-binding-idp", alg: "EdDSA" };
const idp: Server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const ISS = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${ISS}/api/auth`, issuer: ISS, audience: ISS, jwksUri: `${ISS}/jwks` }), { mode: 0o600 });
const secret = (await loadOwnerSecret(a.store, a.space))!;
const ownerA = deriveOwnerForIdpSubject(secret, ISS, "human-a"), ownerB = deriveOwnerForIdpSubject(secret, ISS, "human-b");
const rowA = grantActor(a.stateDir, { owner: ownerA, actor: "alice", scope: [], allowSubscribe: ["general"], allowPublish: ["general"] });
const rowB = grantActor(a.stateDir, { owner: ownerB, actor: "mallory", scope: [], allowSubscribe: ["general"], allowPublish: ["general"] });
const proof = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setSubject(sub).setIssuer(ISS).setAudience(ISS)
  .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + 600).sign(privateKey);

let service: AuthServiceHandle | undefined;
const endpoints: CotalEndpoint[] = [];
const conns: NatsConnection[] = [];
try {
  const provCreds = await mintCreds(a.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: provCreds });
  const prov = new CotalEndpoint({ space: a.space, servers: fx.servers, creds: provCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  prov.on("error", () => {});
  await prov.start();
  endpoints.push(prov);
  for (const [owner, row] of [[ownerA, rowA], [ownerB, rowB]] as const)
    await provisionAgentDurables(prov, { owner, actor: row.actor, lifecycleUid: row.lifecycleUid! }, { subscribe: ["general"], allowSubscribe: ["general"] });
  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity,
  });
  const exchange = async (sub: string, actor: string): Promise<string> => {
    const res = await fetch(`${service!.url}/exchange`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` },
      body: JSON.stringify({ idpToken: await proof(sub), actor }),
    });
    const body = await res.json() as { token?: string };
    if (typeof body.token !== "string") throw new Error(`exchange for ${actor} answered ${res.status}`);
    return body.token;
  };
  const bearerA = await exchange("human-a", "alice"), bearerB = await exchange("human-b", "mallory");
  /** A raw connection through the callout under `name`, or the refusal message. */
  const dial = async (bearer: string, name: string): Promise<NatsConnection | string> => {
    try {
      const nc = await connect({ servers: fx.servers, name, inboxPrefix: `_INBOX_${name}`, maxReconnectAttempts: 0, reconnect: false, timeout: 5000,
        authenticator: [credsAuthenticator(enc(a.sentinelCreds)), tokenAuthenticator(bearer)] });
      conns.push(nc);
      return nc;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const sender = new CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "operator"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "sender", kind: "endpoint" } });
  sender.on("error", () => {});
  await sender.start();
  endpoints.push(sender);
  const aliceKey = principalKey(ownerA, "alice").key;

  // Mallory's own connection, under her own principal-bound name, reads `general` live.
  const own = await dial(bearerB, bearerInboxConnId(bearerB));
  if (typeof own === "string") throw new Error(`mallory's own connection was refused: ${own}`);
  const replies: string[] = [];
  own.subscribe(chatSubject(a.space, "*", "*", "general"), { callback: (_e, m) => { if (m.reply) replies.push(m.reply); } });
  await own.flush();

  // ---- B1 -----------------------------------------------------------------------------------------
  const received: string[] = [];
  const alice = new CotalEndpoint({
    space: a.space, servers: fx.servers, bearer: bearerA, sentinelCreds: a.sentinelCreds, lifecycleUid: rowA.lifecycleUid,
    channels: ["general"], consume: true, watchPresence: false, registerPresence: false,
    card: { owner: ownerA, actor: "alice", name: "alice", kind: "agent" },
  });
  alice.on("error", () => {});
  alice.on("warning", () => {});
  alice.on("message", (m: CotalMessage) => { received.push(textOf(m)); });
  await alice.start();
  endpoints.push(alice);
  const aliceNc = (alice as unknown as { nc: NatsConnection }).nc;
  await alice.multicast("posted by alice", { channel: "general" });
  await until(() => replies.length > 0);
  const reply = replies[0] ?? "";
  const learned = reply.slice("_INBOX_".length, reply.indexOf("."));
  const ownPrefix = `${principalKey(ownerA, "alice").name}-`;
  check("B1 control: alice's endpoint names its inbox under her own principal", learned.startsWith(ownPrefix) && /^ibx[0-9a-f]{32}$/.test(learned.slice(ownPrefix.length)), { reply });
  await sender.unicast(aliceKey, "dm one");
  check("B1 control: a DM to alice is pulled and handed to her handler", await until(() => received.includes("dm one")), received);

  // ---- B2 -----------------------------------------------------------------------------------------
  check("B2 control: mallory reads alice's inbox name from the reply subject of her post", learned.length > 0 && reply.startsWith(`_INBOX_${learned}.`), { reply });
  const mark = calloutLines.length;
  const intruder = await dial(bearerB, learned);
  const stolen: string[] = [];
  if (typeof intruder !== "string") {
    intruder.subscribe(`_INBOX_${learned}.>`, { callback: (_e, m) => { stolen.push(dec(m.data)); } });
    await intruder.flush();
  }
  check("B2: mallory's bearer naming alice's inbox is refused at connect",
    typeof intruder === "string" && /authorization violation/i.test(intruder), typeof intruder === "string" ? intruder : "(admitted)");
  check("B2: ...and the callout's refusal names mallory's own inbox prefix",
    deniedSince(mark).some((l) => l.includes(`outside this bearer's own inbox prefix`) && l.includes(`${principalKey(ownerB, "mallory").name}-`)), deniedSince(mark));
  await sender.unicast(aliceKey, "dm two");
  await until(() => received.includes("dm two"));
  await sleep(500);
  check("B2: alice receives the next DM and no copy of it reaches mallory",
    received.includes("dm two") && !stolen.some((s) => s.includes("dm two")), { received, stolenCopies: stolen.length });

  // ---- B3 -----------------------------------------------------------------------------------------
  const legacyMark = calloutLines.length;
  const legacy = await dial(bearerA, `ibx${randomUUID().replace(/-/g, "")}`);
  check("B3: a bare inbox nonce under alice's own bearer is refused at connect",
    typeof legacy === "string" && /authorization violation/i.test(legacy), typeof legacy === "string" ? legacy : "(admitted)");
  check(`B3: ...and the callout's refusal names the minimum client version ${USER_INBOX_MIN_CLIENT_VERSION}`,
    deniedSince(legacyMark).some((l) => l.includes("bare inbox nonce") && l.includes(USER_INBOX_MIN_CLIENT_VERSION)), deniedSince(legacyMark));

  // ---- B4 -----------------------------------------------------------------------------------------
  const cidBefore = aliceNc.info?.client_id;
  const reconnectMark = calloutLines.length;
  await aliceNc.reconnect();
  // The client clears its INFO when it starts to dial and sets it again from the new server INFO.
  await until(() => !!aliceNc.info && aliceNc.info.client_id !== cidBefore);
  check("B4: alice's endpoint reconnects through the callout as a new connection",
    aliceNc.info?.client_id !== undefined && aliceNc.info.client_id !== cidBefore && deniedSince(reconnectMark).length === 0, { cidBefore, cidAfter: aliceNc.info?.client_id, denied: deniedSince(reconnectMark) });
  await sender.unicast(aliceKey, "dm three");
  check("B4: ...under her own principal-bound name, and a DM after the reconnect arrives", await until(() => received.includes("dm three")), received);
  const after = replies.length;
  await alice.multicast("posted after reconnect", { channel: "general" });
  await until(() => replies.length > after);
  check("B4: ...and her post after the reconnect still carries her own inbox name", (replies[after] ?? "").startsWith(`_INBOX_${learned}.`), replies.slice(after));
} catch (e) {
  check(`suite ran to completion (${(e as Error).message})`, false);
} finally {
  for (const nc of conns) await nc.close().catch(() => {});
  for (const ep of endpoints.reverse()) await ep.stop().catch(() => {});
  await service?.close().catch(() => {});
  idp.close();
  await fx.close();
  console.error = stderr;
}
check(`cell count: ${EXPECTED_CELLS} cells ran`, passed() + failed() === EXPECTED_CELLS, { passed: passed(), failed: failed() });
finish();

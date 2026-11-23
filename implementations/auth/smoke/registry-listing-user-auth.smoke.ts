/** Run after building: pnpm smoke:registry-listing-user-auth (needs nats-server). A user-auth mesh
 *  end to end: the stock auth service and callout, an agent bearer from its own exchange, a served
 *  registry, and the agent asking it through its own endpoint. The callout issues the agent
 *  connection's listing generation. The IdP is a signed loopback fixture, and the registry is
 *  registered by a fixture; how a space hosts its registry is not under test. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { CotalEndpoint, chatSubject, dialerFor, mintCreds, mintLifecycleUid, newIdentity, provisionAgentDurables, readUsername, readUsernameOwner, seedChannelRegistry, setupSpaceStreams, standaloneConnectOpts, usernameBucket, UsernameRegistryReadError, type CotalMessage, type IssuedCaller } from "@cotal-ai/core";
import * as core from "@cotal-ai/core";
import { NativeChatSession } from "@cotal-ai/workspace/chat";
import { createSuite } from "@cotal-ai/smoke-kit";
import { MeshAgent } from "../../../extensions/connector-core/src/agent.js";
import type { AgentConfig } from "../../../extensions/connector-core/src/config.js";
import { fmtFrom } from "../../../extensions/connector-core/src/framing.js";
import { cotalToolSpecs } from "../../../extensions/connector-core/src/tool-specs.js";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, platformControlOwner, revokeActor, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { authorityWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";
import { fixtureCluster, registerFixture, runRegistryFixture } from "../../registry/smoke/_fixture.js";
import { natsRegistryReads } from "../../registry/src/index.js";

const suite = createSuite();
const fx = await startHostedAuthFixture("listua", 3);
const [a, directory, email] = fx.accounts as [HostedAuthAccount, HostedAuthAccount, HostedAuthAccount];
const mesh = { auth: a.auth, servers: fx.servers, space: a.space };
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "listua-idp", alg: "EdDSA" };
const idp: Server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const ISS = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
function pin(account: HostedAuthAccount, username?: { source: "directory" } | { source: "claims"; emailLocalPart: boolean }) {
  writeFileSync(join(account.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${ISS}/api/auth`, issuer: ISS, audience: ISS, jwksUri: `${ISS}/jwks`, username }), { mode: 0o600 });
}
pin(a);
pin(directory, { source: "directory" });
pin(email, { source: "claims", emailLocalPart: true });
const secret = (await loadOwnerSecret(a.store, a.space))!;
const owner = deriveOwnerForIdpSubject(secret, ISS, "lister-human");
const otherOwner = deriveOwnerForIdpSubject(secret, ISS, "other-human");
const unnamedOwner = deriveOwnerForIdpSubject(secret, ISS, "unnamed-human");
const base = `7_${"n".repeat(38)}`;
const supplied = `9_${"d".repeat(38)}`;
const row = grantActor(a.stateDir, { owner, actor: "lister", scope: [], allowSubscribe: [], allowPublish: [] });
const narrow = { actor: "lister", scope: [], allowSubscribe: [], allowPublish: [] };
const otherRow = grantActor(a.stateDir, { owner: otherOwner, ...narrow });
const senderRow = grantActor(a.stateDir, { owner, ...narrow, actor: "address_sender" });
const caseRows = ["Build", "build"].map((actor) => grantActor(a.stateDir, { owner, ...narrow, actor }));
grantActor(a.stateDir, { owner: unnamedOwner, ...narrow });
const idpToken = (subject: string, claims: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setSubject(subject).setIssuer(ISS).setAudience(ISS)
    .setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
};

async function awaitValue<T>(read: () => T | undefined): Promise<T | undefined> {
  const until = Date.now() + 5_000;
  do {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 25));
  } while (Date.now() < until);
}

async function checkDmResolution(left: MeshAgent, right: MeshAgent, caller: MeshAgent, username: string, otherUsername: string): Promise<void> {
  const tool = cotalToolSpecs(caller.config).find((spec) => spec.name === "cotal_dm")!;
  const send = (to: string, text: string) => tool.run(caller, caller.config, { to, text });
  const exact = `${otherOwner}.unobserved_dm_target`;
  const direct = await send(exact, "exact principal without presence");
  suite.check("an unobserved exact principal reports storage without claiming it messaged the sender", !direct.isError &&
    direct.text.includes(`for ${exact}`) && direct.text.includes("stored at sequence") && !direct.text.includes("messaged you"), direct);

  const roster = await left.readRoster();
  assert.ok(roster.roster.some((p) => p.card.id === right.ep.card.id) && roster.roster.some((p) => p.card.id === caller.ep.card.id));
  const suggestionTool = cotalToolSpecs(left.config).find((spec) => spec.name === "cotal_dm")!;
  const bare = await suggestionTool.run(left, left.config, { to: "reviewer", text: "must not cross owners" });
  suite.check("the tool preserves a typed foreign-only name refusal and suggested address", bare.isError === true &&
    bare.structured?.code === "TARGET_NOT_FOUND" && Array.isArray(bare.structured.addresses) && bare.structured.addresses.includes(`${otherUsername}/reviewer`), bare);
  const label = core.peerLabel(caller.ep.card);
  assert.equal(label, `${username} (role: reviewer)`);
  const invalid = await cotalToolSpecs(right.config).find((spec) => spec.name === "cotal_dm")!.run(right, right.config,
    { to: label, text: "decorated label is not an address" });
  suite.check("the decorated name and role label does not alias the qualified target", invalid.isError === true &&
    ![left, caller].some((agent) => agent.peekInbox().some((item) => item.text === "decorated label is not an address")), invalid);

  const readRoster = caller.readRoster;
  let reads = 0;
  caller.readRoster = async () => { reads++; return readRoster.call(caller); };
  try {
    const malformed = await send(`${username}//reviewer`, "malformed address");
    suite.check("a malformed qualified address is refused before reading presence", malformed.isError === true && malformed.structured?.code === "USAGE_INVALID" && reads === 0, { malformed, reads });
    const first = await send(`${username}/reviewer`, "qualified first reviewer only");
    const second = await send(`${otherUsername}/reviewer`, "qualified second reviewer only");
    const got = (agent: MeshAgent, text: string) => agent.peekInbox().some((item) => item.text === text);
    assert.ok(await awaitValue(() => got(left, "qualified first reviewer only") && got(right, "qualified second reviewer only") ? true : undefined));
    suite.check("two live owners with the same agent name each receive only their qualified DM", !first.isError && !second.isError &&
      !got(left, "qualified second reviewer only") && !got(right, "qualified first reviewer only"), { first, second });
    suite.check("qualified connector targets do not read presence before publishing", reads === 0, reads);
  } finally { caller.readRoster = readRoster; }
}

async function checkReaders(authService: AuthServiceHandle, username: string): Promise<void> {
  const channel = "reader_test";
  const allow = [channel];
  const base = { space: a.space, servers: fx.servers };
  const creds = await mintCreds(a.auth, newIdentity(), "provisioner");
  await seedChannelRegistry({ ...base, creds, file: { channels: { [channel]: { replay: true, deliveryClass: "durable" } } } });
  const provisioner = new CotalEndpoint({ ...base, creds, channels: [], consume: false, registerPresence: false, watchPresence: false, card: { kind: "endpoint", name: "test_provisioner" } });
  const daemon = new CotalEndpoint({ ...base, creds: await mintCreds(a.auth, newIdentity(), "delivery"), channels: [], consume: false, registerPresence: false, watchPresence: true, card: { kind: "endpoint", name: "delivery" } });
  const agents: MeshAgent[] = [];
  let peer: CotalEndpoint | undefined;
  let lease: number | undefined;
  try {
    for (const ep of [provisioner, daemon]) { ep.on("error", console.error); await ep.start(); }
    lease = await daemon.acquireDeliveryLease(0);
    await daemon.startPlane3((id, uid) => daemon.aclForOwner(id, uid));
    lease = await daemon.markDeliveryLeaseReady(0, lease);
    const prepare = async (subject: string, owner: string, actor: string, role?: string) => {
      const lifecycleUid = mintLifecycleUid();
      grantActor(a.stateDir, { owner, actor, lifecycleUid, role, scope: [], allowSubscribe: allow, allowPublish: allow });
      await provisionAgentDurables(provisioner, { owner, actor, lifecycleUid }, { role, subscribe: allow, allowSubscribe: allow });
      const bearer = async () => {
        const result = await fetch(`${authService.url}/exchange`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${authService.cap}` },
          body: JSON.stringify({ actor, idpToken: await idpToken(subject, { preferred_username: subject }) }) });
        const body = await result.json() as { token?: string; error?: string };
        assert.ok(result.ok && body.token, body.error);
        return body.token;
      };
      return { lifecycleUid, role, userAuth: { owner, actor, bearer, sentinelCreds: a.sentinelCreds } };
    };
    const start = async (grant: Awaited<ReturnType<typeof prepare>>, name = grant.userAuth.actor) => {
      const config: AgentConfig = { ...base, ...grant, name, subscribe: allow, allowSubscribe: allow, allowPublish: allow, kind: "agent", tls: false };
      const agent = new MeshAgent(config, {}, { eventsArmed: false });
      agents.push(agent);
      agent.on("error", console.error);
      void agent.start();
      assert.ok(await awaitValue(() => agent.connected ? true : undefined));
      return agent;
    };
    const leftGrant = await prepare("lister-human", owner, "reviewer");
    const left = await start(leftGrant);
    const right = await start(await prepare("other-human", otherOwner, "reviewer"));
    const caller = await start(await prepare("lister-human", owner, "dm_caller", "reviewer"), username);
    const otherUsername = await right.ep.readUsername(otherOwner);
    assert.ok(otherUsername);
    daemon.serveDeliveryLiveness();
    await checkDmResolution(left, right, caller, username, otherUsername);
    for (const agent of [left, right]) await agent.setChannelMode(channel, "quiet");
    const sender = await prepare("lister-human", owner, "sender");
    let nc: NatsConnection | undefined;
    peer = new CotalEndpoint({ ...base, lifecycleUid: sender.lifecycleUid, bearer: sender.userAuth.bearer, sentinelCreds: a.sentinelCreds,
      channels: [], registerPresence: false, watchPresence: false, card: { owner, actor: "sender", kind: "agent", name: "claimed_name" },
      onConnection: (connection) => { nc = connection; } });
    peer.on("error", console.error);
    await peer.start();
    const replies = new Set<string>();
    peer.on("message", (m: CotalMessage) => replies.add(m.id));
    const channelPost = async (id: string, targets?: string[], age = 0) => {
      const wire = { id, ts: Date.now() - age, space: a.space, from: peer!.ref(), channel, mentions: ["reviewer"],
        ...(targets === undefined ? {} : { mentionIds: targets }), parts: [{ kind: "text", text: id }] };
      await nc!.request(chatSubject(a.space, owner, "sender", channel), JSON.stringify(wire), { timeout: 2_000 });
    };
    const saw = (agent: MeshAgent, id: string) => awaitValue(() => agent.peekInbox().find((i) => i.id === id));
    await channelPost("only_right", [right.ep.card.id]);
    const foreign = await saw(right, "only_right");
    suite.check("only the addressed same-name seat observes mention priority", foreign?.mentionsMe === true && (await saw(left, "only_right"))?.mentionsMe === false);
    suite.check("foreign prompt attribution ignores the claimed sender name and uses its registered address",
      foreign !== undefined && !!await awaitValue(() => fmtFrom(foreign) === `${username}/sender` ? true : undefined));
    await channelPost("empty_ids", []);
    suite.check("an explicit empty hint does not fall back to names", (await saw(left, "empty_ids"))?.mentionsMe === false && (await saw(right, "empty_ids"))?.mentionsMe === false);
    await channelPost("legacy_names");
    suite.check("without IDs both legacy name matches retain priority", (await saw(left, "legacy_names"))?.mentionsMe === true && (await saw(right, "legacy_names"))?.mentionsMe === true);
    const held = await peer.unicast(right.ep.card.id, "reply to the verified sender");
    assert.ok(await saw(right, held.id));
    suite.check("an unrostered foreign sender cannot be reached by its claimed name", await right.dm("claimed_name", "not sent").then(() => false, () => true));
    const secondHeld = await peer.unicast(right.ep.card.id, "reply to this by principal");
    assert.ok(await saw(right, secondHeld.id));
    const reply = await right.dm(peer.card.id, "principal reply", { replyTo: secondHeld.id });
    suite.check("an explicit reply reaches its unrostered sender by principal", reply.recipient.id === peer.card.id && !!await awaitValue(() => replies.has(reply.msg.id) ? true : undefined));
    const sharedId = "same-directed-id";
    const otherSender = await core.dialerFor(fx.servers)({ servers: fx.servers,
      ...core.standaloneConnectOpts({ bearer: await leftGrant.userAuth.bearer(), sentinelCreds: a.sentinelCreds, tls: false }) });
    const sendShared = (from: CotalEndpoint, connection: NatsConnection) => connection.request(
      core.unicastSubject(a.space, otherOwner, "reviewer", from.principal.owner, from.principal.actor),
      JSON.stringify({ id: sharedId, ts: Date.now(), space: a.space, from: from.ref(), to: right.ep.card.id, parts: [{ kind: "text", text: "question" }] }),
      { timeout: 2_000 });
    try {
      await sendShared(peer, nc!);
      await sendShared(left.ep, otherSender);
    } finally { await otherSender.close(); }
    const duplicateIds = await awaitValue(() => {
      const items = right.peekInbox().filter((item) => item.id === sharedId);
      return items.length === 2 ? items : undefined;
    });
    const byRight = await right.dm(peer.card.id, "first answer", { replyTo: sharedId });
    const byLeft = await right.dm(left.ep.card.id, "second answer", { replyTo: sharedId });
    suite.check("the same wire DM ID from two senders has independent inbox and reply keys", duplicateIds !== undefined &&
      duplicateIds[0]?.recvKey !== duplicateIds[1]?.recvKey && byRight.msg.replyTo === sharedId && byLeft.msg.replyTo === sharedId);
    await left.stop();
    await channelPost("recent_durable", [left.ep.card.id]);
    await channelPost("historical_ids", [left.ep.card.id], 6 * 60_000);
    const resumed = await start(leftGrant);
    suite.check("a current copy after reconnect retains its principal hint", (await saw(resumed, "recent_durable"))?.mentionsMe === true);
    const history = await saw(resumed, "historical_ids");
    suite.check("a historical copy retains its hint without becoming an automatic wake", history?.historical === true && history.mentionsMe &&
      !resumed.peekInbox("automatic").some((item) => item.id === "historical_ids"));
  } finally {
    await peer?.stop().catch(() => {});
    for (const agent of agents.reverse()) await agent.stop().catch(() => {});
    if (lease !== undefined) await daemon.releaseDeliveryLease(0, lease);
    await daemon.stop().catch(() => {});
    await provisioner.stop().catch(() => {});
  }
}

let service: AuthServiceHandle | undefined;
const services: AuthServiceHandle[] = [];
let registry: { stop(): Promise<void> } | undefined;
const endpoints: CotalEndpoint[] = [];
let readerNc: NatsConnection | undefined;

async function checkAddresses(sender: CotalEndpoint, nc: NatsConnection, own: CotalEndpoint, foreign: CotalEndpoint, foreignName: string, received: string[], failedReader: NatsConnection): Promise<void> {
  const resolve = core.resolvePeerAddress;
  const authority = { mode: "user" as const, ...sender.principal, space: sender.space, nc };
  const target = (roster: core.Presence[], name: string) => resolve(roster, name, { authority });
  const select = async (roster: core.Presence[], name: string) => target(roster, name).then(
    (peer) => peer?.card.id ?? "no match", (error: Error) => error.message);
  const ids = [own.card.id, foreign.card.id];
  let roster: core.Presence[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    roster = sender.getRoster();
    if (ids.every((id) => roster.some((peer) => peer.card.id === id && peer.status !== "offline"))) break;
    await delay(100);
  }
  assert(ids.every((id) => roster.some((peer) => peer.card.id === id)), "both signed-in peers published presence");
  const ownMatch = await select(roster, "lister");
  suite.check("a bare name selects the sender's own live agent among two signed-in owners", ownMatch === own.card.id, ownMatch);
  suite.check("a unique own launch name permits a case-insensitive match", await select(roster, "LISTER") === own.card.id);
  const namesakes = caseRows.map((row) => roster.find((p) => p.card.id === `${row.owner}.${row.actor}`)!);
  assert(namesakes.every(Boolean), "both case variants published authenticated presence");
  suite.check("exact actor spelling wins over a case-insensitive collision", await select(namesakes, "Build") === namesakes[0]!.card.id && await select(namesakes, "build") === namesakes[1]!.card.id);
  const ambiguous = await select(namesakes, "BUILD");
  suite.check("a mixed-case name listing two own actors is ambiguous", ambiguous.includes("ambiguous") && namesakes.every((p) => ambiguous.includes(p.card.id)), ambiguous);
  suite.check("one owner's visible roster accepts its bare own name", await select(roster.filter((p) => p.card.id !== foreign.card.id), "lister") === own.card.id);
  await own.stop();
  for (let attempt = 0; attempt < 30; attempt++) {
    roster = sender.getRoster();
    if (!roster.some((p) => p.card.id === own.card.id && p.status !== "offline")) break;
    await delay(100);
  }
  assert(!roster.some((p) => p.card.id === own.card.id && p.status !== "offline"), "own peer is offline");
  const send = async (address: string, text: string) => {
    const selected = await target(roster, address);
    if (!selected) throw new Error(`no matching participant for ${address}`);
    await sender.unicast(selected.card.id, text);
    return selected.card.id;
  };
  const refused = await send("lister", "bare-must-not-cross-owners").catch((error: Error) => error.message);
  const qualified = `${foreignName}/lister`;
  suite.check("with the own agent offline a bare send refuses and names the other owner's qualified address", refused.includes(qualified), refused);
  const delivered = await send(qualified, "qualified-recipient").catch((error: Error) => error.message);
  for (let i = 0; i < 30 && !received.includes("qualified-recipient") && !received.includes("bare-must-not-cross-owners"); i++) await delay(100);
  suite.check("the other owner never receives the refused bare DM", !received.includes("bare-must-not-cross-owners"), received);
  suite.check("the other owner receives the explicitly qualified DM", delivered === foreign.card.id && received.includes("qualified-recipient"), { delivered, received });
  const missing = await select(roster, `${foreignName}/absent`);
  suite.check("a known username resolves an unobserved actor without inferring existence", missing === `${foreign.principal.owner}.absent`, missing);
  const unknown = await select(roster, "unknown_address_user/lister");
  suite.check("an unknown username fails clearly", /unknown username.*unknown_address_user/i.test(unknown), unknown);
  const wrongCase = await select(roster, `${foreignName}/Lister`);
  suite.check("the actor half is byte-exact", wrongCase === `${foreign.principal.owner}.Lister`, wrongCase);
  const folded = await select(roster, `${foreignName.toUpperCase()}/lister`);
  suite.check("only the username half folds case", folded === foreign.card.id, folded);
  const noPresence = await select([], qualified);
  suite.check("a registered principal resolves without presence", noPresence === foreign.card.id, noPresence);
  const unavailable = await resolve([], qualified, { authority: { ...authority, nc: failedReader } })
    .then((peer) => peer?.card.id ?? "no match", (error: Error) => error.message);
  suite.check("a failed registry read is visibly unavailable, not an unknown username", /cannot read.*username registry/i.test(unavailable), unavailable);
  suite.check("an exact ID still selects a foreign peer", await select(roster, foreign.card.id) === foreign.card.id);
  suite.check("a bare name absent from all owners still returns no match", await select(roster, "missing_actor") === "no match");
}

async function checkChat(sender: CotalEndpoint, foreign: CotalEndpoint, foreignName: string, received: string[], daemon: CotalEndpoint, reopen: () => Promise<CotalEndpoint>): Promise<void> {
  const session = new NativeChatSession({ endpoint: sender,
    identity: { mode: "user", space: sender.space, principal: sender.card.id, lifecycleUid: senderRow.lifecycleUid!, label: "sender", allowSubscribe: [], allowPublish: [] },
    retire: async () => { await sender.stop(); return { retirement: "not-applicable", connectionClosed: "confirmed", message: "stopped" }; },
    words: { reopen: (channel) => channel, answerOne: "use the sender's principal" },
  });
  try {
    await sender.waitForPresenceSnapshot();
    const bare = await session.dm("lister", "chat-bare-must-not-cross");
    suite.check("native chat refuses a foreign bare target without sending", bare.outcome === "refused" && bare.message.includes(`${foreignName}/lister`), bare);
    daemon.serveLiveness("delivery", () => "bound");
    const old = await session.dm(`${foreignName}/lister`, "old-delivery-must-not-store");
    daemon.serveDeliveryLiveness();
    suite.check("qualified sends refuse a bound delivery responder without the version field", old.outcome === "refused" && old.code === "TARGET_UNAVAILABLE" && old.message.includes("Nothing was sent"), old);
    const qualified = await session.dm(`${foreignName}/lister`, "chat-qualified");
    for (let i = 0; i < 30 && !received.includes("chat-qualified") && !received.includes("chat-bare-must-not-cross"); i++) await delay(100);
    suite.check("native chat stores the qualified target at the foreign principal", qualified.outcome === "stored" && qualified.recipient?.id === foreign.card.id && received.includes("chat-qualified"), { qualified, received });
    const unknownActor = await session.dm(`${foreignName}/absent`, "storage without presence");
    suite.check("native chat reports storage at an unobserved principal without asserting existence", unknownActor.outcome === "stored" && !!unknownActor.seq && unknownActor.recipient?.id === `${foreign.principal.owner}.absent` && unknownActor.recipientStatusAtSend === undefined, unknownActor);
    await foreign.stop();
    for (let i = 0; i < 30 && sender.getRoster().some((p) => p.card.id === foreign.card.id && p.status !== "offline"); i++) await delay(100);
    const offline = await session.dm(`${foreignName}/lister`, "chat-qualified-offline");
    suite.check("native chat stores a qualified DM without claiming the target exists", offline.outcome === "stored" && offline.seq !== undefined && offline.recipientStatusAtSend === undefined, offline);
    await reopen();
    for (let i = 0; i < 30 && !received.includes("chat-qualified-offline"); i++) await delay(100);
    suite.check("the same lifecycle gets both qualified DMs and neither refused DM", received.includes("chat-qualified") && received.includes("chat-qualified-offline") && !received.includes("chat-bare-must-not-cross") && !received.includes("old-delivery-must-not-store"), received);
  } finally { await session.close(); }
}

async function provisionAddresses(): Promise<void> {
  const creds = await mintCreds(a.auth, newIdentity(), "provisioner");
  const provisioner = new CotalEndpoint({ space: a.space, servers: fx.servers, creds, channels: [], consume: false,
    watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "provisioner", kind: "endpoint" } });
  endpoints.push(provisioner);
  await provisioner.start();
  for (const grant of [row, otherRow, senderRow, ...caseRows]) {
    await provisioner.provisionDmInbox(grant.owner, grant.actor, grant.lifecycleUid!);
    await provisioner.provisionDlvInbox(grant.owner, grant.actor, grant.lifecycleUid!);
  }
}

async function boot(account: HostedAuthAccount) {
  const handle = await startAuthService({
    context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: account.space, servers: fx.servers,
    stateDir: account.stateDir, store: account.store, storeIdentity: account.store.identity, publicFace: { port: 0, trustedProxy: false },
  });
  services.push(handle);
  return handle;
}

async function bootWithDiagnostics(account: HostedAuthAccount, lines: string[]) {
  const error = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); error(...args); };
  try { return await boot(account); }
  finally { console.error = error; }
}

async function setup(account: HostedAuthAccount) {
  const creds = await mintCreds(account.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: account.space, userAuth: true, creds });
  const connection = await dialerFor(fx.servers)({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }) });
  try {
    const info = await (await jetstreamManager(connection)).streams.info(`KV_${usernameBucket(account.space)}`);
    suite.check("user-auth space setup creates an empty username bucket before auth starts", info.state.messages === 0);
  } finally { await connection.close(); }
}

async function exchange(handle: AuthServiceHandle, subject: string, claims: Record<string, unknown>, username?: string) {
  const res = await fetch(`${handle.url}/exchange`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${handle.cap}` },
    body: JSON.stringify({ idpToken: await idpToken(subject, claims), actor: "lister", username }),
  });
  return { res, body: await res.json() as { token?: string; error?: string } };
}

async function member(account: HostedAuthAccount, grant: typeof row, token: string): Promise<{ ep: CotalEndpoint; nc: NatsConnection }> {
  let nc: NatsConnection | undefined;
  const ep = new CotalEndpoint({
    space: account.space, servers: fx.servers, bearer: token, sentinelCreds: account.sentinelCreds, lifecycleUid: grant.lifecycleUid!,
    channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
    card: { owner: grant.owner, actor: grant.actor, name: "lister", kind: "agent" },
    onConnection: (connected) => { nc = connected; },
  });
  endpoints.push(ep);
  ep.on("error", () => {});
  ep.on("warning", () => {});
  await ep.start();
  if (!nc) throw new Error("the user-auth endpoint did not report its broker connection");
  return { ep, nc };
}

async function directoryCases(): Promise<void> {
  const key = (await loadOwnerSecret(directory.store, directory.space))!;
  const owner = deriveOwnerForIdpSubject(key, ISS, "directory-human");
  const rival = deriveOwnerForIdpSubject(key, ISS, "directory-rival");
  const pending = deriveOwnerForIdpSubject(key, ISS, "interrupted-human");
  const platform = platformControlOwner(key, directory.space, directory.accountPublicKey);
  await setup(directory);
  let handle = await boot(directory);
  const blank = grantActor(directory.stateDir, { owner, ...narrow });
  const unbound = await exchange(handle, "directory-human", { preferred_username: "never_derived" }, "caller_chosen");
  assert.ok(unbound.res.ok && unbound.body.token, unbound.body.error);
  const { nc } = await member(directory, blank, unbound.body.token);
  suite.check("directory exchange with no row username succeeds and does not derive a binding",
    await readUsername(nc, directory.space, owner) === undefined && await readUsernameOwner(nc, directory.space, "never_derived") === undefined);
  for (const username of ["no-hyphen", "Upper", `${supplied}x`, "newline\n", ""]) {
    assert.throws(() => grantActor(directory.stateDir, { owner, ...narrow, username }), /a username must have 1 to 40/);
    suite.check("the directory grant refuses invalid input unchanged", true);
  }
  const named = grantActor(directory.stateDir, { ...blank, username: supplied });
  const issued = await exchange(handle, "directory-human", { preferred_username: "never_derived" });
  suite.check("directory source reserves its exact, digit-leading 40-character username at exchange",
    issued.res.ok && await readUsername(nc, directory.space, owner) === supplied && await readUsernameOwner(nc, directory.space, supplied) === owner, issued.body.error);
  assert.equal(revokeActor(directory.stateDir, owner, named.actor), true);
  suite.check("revoking the grant leaves both keys intact", await readUsername(nc, directory.space, owner) === supplied && await readUsernameOwner(nc, directory.space, supplied) === owner);
  grantActor(directory.stateDir, { owner: rival, ...narrow, username: supplied });
  const collision = await exchange(handle, "directory-rival", { name: "Never Derived" });
  suite.check("another owner cannot get the reserved name after revocation", !collision.res.ok && /already reserved/.test(collision.body.error ?? "") && await readUsername(nc, directory.space, rival) === undefined);
  grantActor(directory.stateDir, named);
  const regranted = await exchange(handle, "directory-human", { preferred_username: "changed_profile" });
  suite.check("regrant returns the same name", regranted.res.ok && await readUsername(nc, directory.space, owner) === supplied, regranted.body.error);
  const replaced = grantActor(directory.stateDir, { owner, ...narrow, lifecycleUid: named.lifecycleUid });
  const withoutUsername = await exchange(handle, "directory-human", { preferred_username: "never_derived" });
  suite.check("whole-row replacement without a username preserves both existing bindings after exchange",
    replaced.username === undefined && withoutUsername.res.ok && typeof withoutUsername.body.token === "string" &&
    await readUsername(nc, directory.space, owner) === supplied && await readUsernameOwner(nc, directory.space, supplied) === owner,
    withoutUsername.body.error);
  for (const lookup of [() => readUsername(nc, a.space, otherOwner), () => readUsernameOwner(nc, a.space, base)])
    await assert.rejects(lookup, (error: unknown) => error instanceof UsernameRegistryReadError && error.code === "denied");
  suite.check("a member of a different space cannot read either direction in this space", true);

  const writer = await openAuthorityClient({ server: fx.servers, space: directory.space,
    dataAccount: { pub: directory.accountPublicKey, signingSeed: directory.auth.account.signingSeed! },
    label: "username-smoke-writer", grants: (id) => authorityWriterGrants(directory.space, id), log: () => {} });
  try {
    for (const [name, reservedFor] of [["interrupted", pending], ["unused_alias", owner]]) {
      await jetstream(writer.nc).publish(`$KV.${usernameBucket(directory.space)}.username.${name}`, new TextEncoder().encode(reservedFor), { expect: { lastSubjectSequence: 0 } });
    }
    suite.check("a half-written reservation is not a complete binding before restart",
      await readUsername(nc, directory.space, pending) === undefined && await readUsernameOwner(nc, directory.space, "interrupted") === undefined);
    await handle.close();
    const restartLog: string[] = [];
    handle = await bootWithDiagnostics(directory, restartLog);
    suite.check("service restart completes both directions without a sign-in for the affected owner",
      await readUsername(nc, directory.space, pending) === "interrupted" && await readUsernameOwner(nc, directory.space, "interrupted") === pending);
    suite.check("startup leaves a second reservation unused for an owner already bound", await readUsernameOwner(nc, directory.space, "unused_alias") === undefined && await readUsername(nc, directory.space, owner) === supplied);
    suite.check("startup reports both repaired and unused orphan keys with their named owners",
      [["interrupted", pending], ["unused_alias", owner]].every(([name, reservedFor]) =>
        restartLog.some((line) => line.includes(`orphan key username.${name}: owner.${reservedFor}`))), restartLog);
    grantActor(directory.stateDir, { owner: rival, ...narrow, username: "unused_alias" });
    const reserved = await exchange(handle, "directory-rival", {});
    suite.check("an unused reservation still cannot be assigned to another owner", !reserved.res.ok && /already reserved/.test(reserved.body.error ?? ""));
    suite.check("platform owner lookup has no binding on either username source",
      await readUsername(nc, directory.space, platform) === undefined && await readUsername(nc, a.space, platform) === undefined);
  } finally { await writer.close(); }
}

async function emailCase(): Promise<void> {
  const key = (await loadOwnerSecret(email.store, email.space))!;
  const owner = deriveOwnerForIdpSubject(key, ISS, "email-human");
  const grant = grantActor(email.stateDir, { owner, ...narrow });
  await setup(email);
  const handle = await boot(email);
  const issued = await exchange(handle, "email-human", { email: "Opt-In@example.test" });
  assert.ok(issued.res.ok && issued.body.token, issued.body.error);
  const { nc } = await member(email, grant, issued.body.token);
  suite.check("the operator can explicitly opt in to using an email local part", await readUsername(nc, email.space, owner) === "opt_in");
}

try {
  await setup(a);
  await provisionAddresses();
  service = await boot(a);
  await registerFixture(mesh, "alpha.example", fixtureCluster("ai.example.alpha", ["read"]));
  registry = await runRegistryFixture(mesh);

  const exchange = async (subject: string, claims: Record<string, unknown>, username?: string, actor = "lister") => {
    const res = await fetch(`${service!.url}/exchange`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` },
      body: JSON.stringify({ idpToken: await idpToken(subject, claims), actor, username }),
    });
    return { res, body: await res.json() as { token?: string; error?: string } };
  };
  const bearer = async (subject: string, claims: Record<string, unknown>, username?: string, actor?: string): Promise<string> => {
    const { res, body } = await exchange(subject, claims, username, actor);
    if (res.status !== 200 || typeof body.token !== "string") throw new Error(`exchange refused: ${res.status} ${JSON.stringify(body)}`);
    return body.token;
  };
  const connect = async (token: string, grant = row, presence = false, received?: string[]): Promise<{ ep: CotalEndpoint; nc: NatsConnection }> => {
    let nc: NatsConnection | undefined;
    const ep = new CotalEndpoint({
      space: a.space, servers: fx.servers, bearer: token, sentinelCreds: a.sentinelCreds, lifecycleUid: grant.lifecycleUid!,
      channels: [], consume: received !== undefined, watchPresence: grant === senderRow, registerPresence: presence, watchChannels: false,
      card: { owner: grant.owner, actor: grant.actor, name: grant.actor, kind: "agent" },
      onConnection: (connected) => { nc = connected; },
    });
    endpoints.push(ep);
    ep.on("error", () => {});
    ep.on("warning", () => {});
    if (received) ep.on("message", (message, delivery) => { received.push(core.partsToText(message.parts)); delivery.ack(); });
    await ep.start();
    if (!nc) throw new Error("the user-auth endpoint did not report its broker connection");
    return { ep, nc };
  };

  const [firstToken, otherToken] = await Promise.all([
    bearer("lister-human", { preferred_username: `7-${"N".repeat(41)}`, name: "Ignored Preferred" }, "caller_chosen"),
    bearer("other-human", { email: "ignored@example.test", name: `7-${"n".repeat(38)}` }),
  ]);
  const { ep: first, nc } = await connect(firstToken, row, true);
  const { nc: otherNc } = await connect(otherToken, otherRow);
  const names = await Promise.all([readUsername(nc, a.space, owner), readUsername(nc, a.space, otherOwner)]);
  suite.check("two owners with concurrent first grants get distinct names from preferred_username and name",
    names.every((name) => name !== undefined && name.length === 40 && (name === base ||
      (name.startsWith(base.slice(0, 33)) && /_[0-9a-f]{6}$/.test(name)))) && names.includes(base) && names[0] !== names[1], names);
  for (const [i, expectedOwner] of [owner, otherOwner].entries()) {
    suite.check("both members read the same reciprocal username binding", names[i] !== undefined &&
      await readUsernameOwner(nc, a.space, names[i]!) === expectedOwner &&
      await readUsernameOwner(otherNc, a.space, names[i]!) === expectedOwner &&
      await readUsername(otherNc, a.space, expectedOwner) === names[i]);
  }
  suite.check("an exchange request cannot choose a username", await readUsernameOwner(nc, a.space, "caller_chosen") === undefined);
  for (const key of [`owner.${owner}`, "username.member_write"]) {
    const subject = `$KV.${usernameBucket(a.space)}.${key}`;
    const denied = await nc.request(subject, "member_write", { timeout: 2_000 }).then(() => undefined, (error: Error) =>
      error instanceof PermissionViolationError ? error : error.cause);
    suite.check("the broker refuses a member's KV publish", denied instanceof PermissionViolationError && denied.operation === "publish" && denied.subject === subject, denied);
  }
  assert.throws(() => grantActor(a.stateDir, { owner: unnamedOwner, ...narrow, username: supplied }), /requires the space username source "directory"/);
  suite.check("claims source rejects supplied names at the grant write", true);
  await bearer("unnamed-human", { preferred_username: "first_private@example.test", name: "second_private@example.test", email: "private_local@example.test" });
  const generated = await readUsername(nc, a.space, unnamedOwner);
  suite.check("claims without a usable name get a generated username and do not expose email by default",
    /^user_[0-9a-f]{10}$/.test(generated ?? "") && await readUsernameOwner(nc, a.space, "private_local") === undefined &&
    await readUsernameOwner(nc, a.space, "first_private_example_test") === undefined && await readUsernameOwner(nc, a.space, "second_private_example_test") === undefined);
  const changed = await bearer("lister-human", { preferred_username: "Changed Name" });
  suite.check("a later identity profile does not rename an owner", await readUsername(nc, a.space, owner) === names[0] &&
    await readUsernameOwner(nc, a.space, "changed_name") === undefined);
  const result = await first.listEndpoints({}).catch((e: unknown) => e as Error);
  const page = result instanceof Error || result.unbound ? undefined : result.page;
  suite.check("a user-auth agent's connection lists only the endpoints its grants cover",
    page?.source === "recorded-ceiling" && page.rows.map((r) => r.endpoint).join() === "registry"
      && page.rows[0]!.commands.map((c) => c.name).join() === "endpoints", result instanceof Error ? result.message : JSON.stringify(result));

  const caller = await first.listingCaller().catch((e: unknown) => e as Error);
  readerNc = await dialerFor(fx.servers)({ servers: fx.servers, ...standaloneConnectOpts({ creds: await mintCreds(a.auth, newIdentity(), "registry-reader"), tls: false }) });
  const reads = await natsRegistryReads(readerNc, a.space);
  const evidence = caller instanceof Error || caller === undefined ? undefined
    : await reads.observe({ space: a.space, owner: caller.owner, actor: caller.actor, uid: caller.uid, generation: caller.generation }).catch(() => undefined);
  suite.check("the callout bound the listing generation to the agent's actor-ledger row",
    evidence?.sources.length === 1 && evidence.sources[0]!.key === `actor.${owner}.lister.${row.lifecycleUid}`, evidence?.sources);

  const { ep: second, nc: ncOfSecond } = await connect(changed);
  const other = await second.listingCaller().catch((e: unknown) => e as Error);
  const generationOf = (c: IssuedCaller | Error | undefined) => (c instanceof Error || c === undefined ? undefined : c.generation);
  suite.check("each connection gets its own listing generation",
    generationOf(other) !== undefined && generationOf(caller) !== undefined && generationOf(other) !== generationOf(caller), [generationOf(caller), generationOf(other)]);

  await checkReaders(service, names[0]!);
  for (const grant of caseRows) await connect(await bearer("lister-human", {}, undefined, grant.actor), grant, true);
  const received: string[] = [];
  const { ep: foreign } = await connect(otherToken, otherRow, true, received);
  const { ep: sender, nc: senderNc } = await connect(await bearer("lister-human", {}, undefined, senderRow.actor), senderRow);
  await second.stop();
  await checkAddresses(sender, senderNc, first, foreign, names[1]!, received, ncOfSecond);
  const daemon = new CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "delivery"),
    channels: [], consume: false, registerPresence: false, watchPresence: false, card: { name: "delivery_addresses", kind: "endpoint" } });
  endpoints.push(daemon);
  daemon.on("error", console.error);
  await daemon.start();
  const lease = await daemon.acquireDeliveryLease(0);
  await daemon.startPlane3((id, uid) => daemon.aclForOwner(id, uid));
  await daemon.markDeliveryLeaseReady(0, lease);
  await checkChat(sender, foreign, names[1]!, received, daemon, async () => (await connect(otherToken, otherRow, true, received)).ep);
  for (const lookup of [() => readUsername(readerNc!, a.space, owner), () => readUsernameOwner(readerNc!, a.space, base)])
    await assert.rejects(lookup, (error: unknown) => error instanceof core.UsernameRegistryReadError && error.code === "denied");
  suite.check("both lookups distinguish a denied key read from absence", true);
  await directoryCases();
  await emailCase();
  while (services.length) await services.pop()!.close();
  await fx.stopBroker();
  try {
    for (const lookup of [() => readUsername(nc, a.space, owner), () => readUsernameOwner(nc, a.space, base)])
      await assert.rejects(lookup, (error: unknown) => error instanceof core.UsernameRegistryReadError && error.code === "unavailable");
  } finally { await fx.restartBroker(); }
  suite.check("both lookups distinguish a stopped broker from absence", true);
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await registry?.stop().catch(() => {});
  await readerNc?.close().catch(() => {});
  for (const handle of services.reverse()) await handle.close().catch(() => {});
  await new Promise<void>((r) => idp.close(() => r()));
  await fx.close();
}
suite.finish();

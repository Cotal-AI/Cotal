/**
 * The own-DM reader (#4189): the `dm-reader` exchange view, its callout profile, and the
 * purpose-bound IdP proof it rides, against a REAL operator-mode nats-server and the shipped auth
 * service started in this process (`startAuthService`: its loopback face, its public face, its
 * callout and its bridge). A synthetic EdDSA IdP serves the pinned JWKS, so every proof's claims
 * and `exp` are exact.
 *
 * Positive controls run first; a refusal cell is paired with a positive on the same door, so a red
 * refusal is about the claim under test and not a broken route.
 *
 *   U1 (5)  a DM-only reader with a dm-reader bearer starts, hands an authenticated DM to its
 *           handler, acks it, survives one bearer renewal, and stops with the handler drained.
 *   U2 (2)  a spoofed `from` and an absent id are terminated before the handler runs.
 *   U3 (2)  a missing durable is refused, not created; a denied bind is refused.
 *   U4 (9+) the bearer is refused DM publish, chat publish, presence put, channel subscribe, its own
 *           `dlv_` bind, a peer's DM durable, `STREAM.INFO` on the DM stream, `$JS.API.INFO` and a
 *           durable in another space, each paired with the stock agent bearer allowed; plus the
 *           exact native-request census over start, renewal, reconnect and drain.
 *   U5      the door x claim matrix. The base has eight routes that take a human IdP proof
 *           (`/exchange`, `/manager-instances`, `/manager-service-authority`, the three
 *           `/chat-session/*` routes, `/tool-result-human-proof/verify`, `/tool-result-consent/issue`),
 *           and `/exchange` is reached two ways (no view, another view). A dm-reader proof is refused
 *           at every one, paired with an ordinary proof passing the verifier there. Then the claim
 *           refusals on the dm-reader exchange itself, each paired with the valid proof.
 *   U6 (3)  an ordinary token with no view still mints `agent`; the views census round-trips every
 *           USER_TOKEN_VIEWS member; the public face refuses `dm-reader`.
 *   U7 (4)  #4185's seam, the embedder's `mintConnectCredential` hook, delayed: the dm-reader
 *           exchange and its renewal re-exchange each as a positive (bearer and NATS JWT expire no
 *           later than the proof) and a refusal (hook returns after the proof expired, nothing signed).
 *
 * The cell total is asserted. Output is cell names, PASS/FAIL and safe classes or counts.
 * Run: pnpm smoke:dm-reader:auth  (needs nats-server on PATH)
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { createUser } from "@nats-io/nkeys";
import {
  CotalEndpoint, DmBindRefusedError, DmDurableMissingError, chatSubject, dlvDurable, dlvStream, dmDurable, dmStream,
  isConsumerNotFound, mintCreds, mintLifecycleUid, newIdentity, permissionsFor, presenceBucket, principalKey,
  setupSpaceStreams, unicastSubject, type CotalMessage, type EndpointOptions, type SignerAnchor,
} from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { spaceSegment } from "@cotal-ai/workspace";
import {
  USER_TOKEN_VIEWS, VIEW_REQUIRED_SCOPE, DM_READER_PURPOSE, createIdpBridge, createUserTokenIssuer,
  deriveOwnerForIdpSubject, generateSigningKey, grantActor, grantManagedActor, loadOwnerSecret, startAuthService, validateUserToken,
  verifyIdpToken, type AuthServiceHandle, type UserTokenIssuer,
} from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const EXPECTED_CELLS = 54;
const { check, finish, passed, failed } = createSuite();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number): Promise<T | "deadline"> => Promise.race([p, sleep(ms).then(() => "deadline" as const)]);
const now = () => Math.floor(Date.now() / 1000);
const enc = (s: string) => new TextEncoder().encode(s);
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
const errClass = (e: unknown): string => (e as Error)?.constructor?.name ?? typeof e;

// ---- broker, account store and the pinned IdP ---------------------------------------------------
const fx = await startHostedAuthFixture("dmreader", 2);
const a = fx.accounts[0]!, foreignSpace = fx.accounts[1]!;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const KID = "dm-reader-idp";
const jwk = { ...await exportJWK(publicKey), kid: KID, alg: "EdDSA" };
const idpServer: Server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idpServer.listen(0, "127.0.0.1", r));
const ISS = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;
// The dedicated audience is explicit pin config, written here as an operator would, never derived.
const DM_AUD = `${ISS}/dm-reader`;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${ISS}/api/auth`, issuer: ISS, audience: ISS, jwksUri: `${ISS}/jwks`, dmReaderAudience: DM_AUD }), { mode: 0o600 });

const SUB = "dm-human";
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, ISS, SUB);
const readerRow = grantActor(a.stateDir, { owner, actor: "dmreader", scope: [], allowSubscribe: [], allowPublish: [] });
const agentRow = grantActor(a.stateDir, { owner, actor: "dmagent", scope: [], allowSubscribe: ["general"], allowPublish: ["general"] });
grantActor(a.stateDir, { owner, actor: "cli", scope: [], allowSubscribe: [">"], allowPublish: [">"] });
// The tool-result consent door needs its signer, a holder and a target, as its own suite sets them up.
const consentHolder = grantActor(a.stateDir, { owner, actor: "web", scope: [], allowSubscribe: [], allowPublish: [] });
const consentTarget = mintLifecycleUid();
grantManagedActor(a.stateDir, { custody: { kind: "foreground" }, owner, actor: "worker", lifecycleUid: consentTarget, scope: [], allowSubscribe: [], allowPublish: [], tokenHash: "a".repeat(64) });
const consentSigner = createUser();
const CONSENT_KID = "dm_reader_consent";
await a.store.create(`auth/${spaceSegment(a.space)}/tool-result-consent-key.json`, JSON.stringify({ ver: 1, keyId: CONSENT_KID, seed: new TextDecoder().decode(consentSigner.getSeed()) }));
const consentAnchor: SignerAnchor = { keyId: CONSENT_KID, publicKey: consentSigner.getPublicKey(), owner: "ai.cotal", roles: ["consents"], scope: { consents: ["tool-results"] }, validFrom: 0, validTo: Number.MAX_SAFE_INTEGER };

type ProofClaims = Record<string, unknown>;
const sign = (claims: ProofClaims, o: { aud?: string; exp?: number } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", kid: KID }).setSubject(SUB).setIssuer(ISS)
    .setAudience(o.aud ?? ISS).setIssuedAt(now()).setExpirationTime(o.exp ?? now() + 600).sign(privateKey);
const ordinary = (extra: ProofClaims = {}, o: { aud?: string; exp?: number } = {}) => sign(extra, o);
const dmProof = (over: ProofClaims = {}, o: { aud?: string; exp?: number } = {}) =>
  sign({ purpose: DM_READER_PURPOSE, actor: "dmreader", lifecycle: readerRow.lifecycleUid, space: a.space, ...over }, { aud: DM_AUD, ...o });

let service: AuthServiceHandle | undefined;
const endpoints: CotalEndpoint[] = [];
const conns: NatsConnection[] = [];
const own = (ep: CotalEndpoint) => { endpoints.push(ep); ep.on("error", () => {}); ep.on("warning", () => {}); return ep; };

// The loopback face answers 429, without a reason, after 30 refused exchanges in a rolling minute
// (FAILED_EXCHANGE_PER_MIN). The suite paces itself under that budget, so every refusal it grades
// is the door's own answer and never the throttle's.
const THROTTLED = /^\/(exchange|manager-instances|manager-service-authority|chat-session\/)/;
const refusals: number[] = [];
async function post(path: string, body: unknown, o: { face?: "loopback" | "public"; cap?: boolean } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = o.face === "public" ? service!.publicUrl! : service!.url;
  const paced = o.face !== "public" && THROTTLED.test(path);
  if (paced) for (;;) {
    while (refusals.length && Date.now() - refusals[0]! > 61_000) refusals.shift();
    if (refusals.length < 25) break;
    await sleep(1000);
  }
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(o.cap === false || o.face === "public" ? {} : { authorization: `Bearer ${service!.cap}` }) },
    body: JSON.stringify(body),
  });
  if (paced && res.status >= 400) refusals.push(Date.now());
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}
const exchange = async (idpToken: string, extra: Record<string, unknown> = {}, face: "loopback" | "public" = "loopback") =>
  post("/exchange", { idpToken, actor: "dmreader", ...extra }, { face });
const bearerOf = (r: { status: number; body: Record<string, unknown> }) => (r.status === 200 && typeof r.body.token === "string" ? r.body.token : undefined);

try {
  const provCreds = await mintCreds(a.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: provCreds });
  await setupSpaceStreams({ servers: fx.servers, space: foreignSpace.space, creds: await mintCreds(foreignSpace.auth, newIdentity(), "provisioner") });
  const prov = own(new CotalEndpoint({ space: a.space, servers: fx.servers, creds: provCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } }));
  await prov.start();
  // The reader's own dm_ and dlv_ durables, provisioned like a spawn does; and the agent's.
  for (const r of [readerRow, agentRow]) {
    await prov.provisionDmInbox(owner, r.actor, r.lifecycleUid!);
    await prov.provisionDlvInbox(owner, r.actor, r.lifecycleUid!);
  }
  const DM = dmStream(a.space);
  const readerDurable = dmDurable(owner, "dmreader", readerRow.lifecycleUid!);
  const agentDurable = dmDurable(owner, "dmagent", agentRow.lifecycleUid!);

  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity,
    publicFace: { port: 0, trustedProxy: false },
    toolResultConsents: { keyId: CONSENT_KID, resolveAnchor: async () => consentAnchor },
  });

  // A sender that DMs the reader: the stock agent bearer of `dmagent`.
  const agentBearer = bearerOf(await post("/exchange", { idpToken: await ordinary(), actor: "dmagent" }))!;
  const sender = own(new CotalEndpoint({ space: a.space, servers: fx.servers, bearer: agentBearer, sentinelCreds: a.sentinelCreds, lifecycleUid: agentRow.lifecycleUid, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { owner, actor: "dmagent", name: "dmagent", kind: "agent" } }));
  await sender.start();
  const readerKey = principalKey(owner, "dmreader").key, senderKey = principalKey(owner, "dmagent").key;
  const pending = async (durable: string) => {
    const jsm = await jetstreamManager(await ownedConn(provCreds), { checkAPI: false });
    const i = await jsm.consumers.info(DM, durable);
    return { pending: i.num_pending, ackPending: i.num_ack_pending };
  };
  async function ownedConn(creds: string): Promise<NatsConnection> {
    const id = newIdentity();
    const nc = await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc(creds)), inboxPrefix: `_INBOX_${id.id}`, maxReconnectAttempts: 0 });
    conns.push(nc);
    return nc;
  }
  /** Connect through the callout with a user bearer; the inbox nonce rides the connect name. */
  async function bearerConn(bearer: string): Promise<NatsConnection> {
    const nonce = `ibx${newIdentity().id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}`;
    const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(enc(a.sentinelCreds)), tokenAuthenticator(bearer)], name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0, timeout: 4000 });
    conns.push(nc);
    return nc;
  }
  type Probe = "denied" | "allowed";
  const probeReq = async (nc: NatsConnection, subject: string, body = "{}"): Promise<Probe> => {
    try { await nc.request(subject, enc(body), { timeout: 1500 }); return "allowed"; }
    catch (e) { return /permission|authorization/i.test(`${(e as Error)?.message} ${String((e as { cause?: unknown }).cause)}`) ? "denied" : "allowed"; }
  };
  const probePub = async (nc: NatsConnection, subject: string): Promise<Probe> => {
    const js = jetstream(nc, { checkAPI: false });
    try { await js.publish(subject, enc(JSON.stringify({ id: `p${Date.now()}`, ts: Date.now(), space: a.space, from: { id: readerKey, name: "x" }, parts: [] })), { timeout: 1500 }); return "allowed"; }
    catch (e) { return /permission|authorization|timeout|no responders/i.test(`${(e as Error)?.message} ${String((e as { cause?: unknown }).cause)}`) ? "denied" : "allowed"; }
  };
  const probeSub = async (nc: NatsConnection, subject: string): Promise<Probe> => {
    const sub = nc.subscribe(subject);
    await nc.flush();
    await sleep(300);
    if (sub.isClosed()) return "denied";
    sub.unsubscribe();
    return "allowed";
  };

  // ---- positive control: the dm-reader exchange mints, and its bearer reads only its own dm_ -----
  const first = await exchange(await dmProof(), { view: "dm-reader" });
  const readerBearer = bearerOf(first);
  check("control: a valid dm-reader proof exchanges for a dm-reader bearer", readerBearer !== undefined && (decodeJwt(readerBearer!) as { act?: { view?: string } }).act?.view === "dm-reader", { status: first.status });

  const dmOnlyOpts = (bearer: EndpointOptions["bearer"], dmOnly: EndpointOptions["dmOnly"], extra: Partial<EndpointOptions> = {}): EndpointOptions => ({
    space: a.space, servers: fx.servers, bearer, sentinelCreds: a.sentinelCreds, lifecycleUid: readerRow.lifecycleUid,
    channels: [], consume: true, watchPresence: false, registerPresence: false, watchChannels: false,
    card: { owner, actor: "dmreader", name: "dmreader", kind: "agent" }, dmOnly, ...extra,
  });

  // ---- U1 + U4 census: start, deliver, ack, renew, reconnect, drain ------------------------------
  {
    const sent: string[] = [];
    const census = (nc: NatsConnection) => {
      const request = nc.request.bind(nc);
      nc.request = (subject, payload, opts) => { sent.push(subject); return request(subject, payload, opts); };
      const publish = nc.publish.bind(nc);
      nc.publish = (subject, payload, opts) => { sent.push(subject); publish(subject, payload, opts); };
    };
    let fetches = 0;
    // The renewal source re-exchanges a fresh short proof, as an embedder would: 70 s, inside the
    // endpoint's 60 s refresh margin, so the first renewal comes due within the cell.
    const source = async () => { fetches++; return bearerOf(await exchange(await dmProof({}, { exp: now() + 70 }), { view: "dm-reader" }))!; };
    const got: string[] = [];
    const ep = own(new CotalEndpoint(dmOnlyOpts(source, { handler: (m, d) => { got.push(`${textOf(m)}|${m.from.id}`); d.ack(); } }, { onConnection: census })));
    const started = await within(ep.start().then(() => "started", (e) => errClass(e)), 15000);
    check("U1.start: a DM-only reader with a dm-reader bearer starts", started === "started", { started });
    await sender.unicast(readerKey, "u1-a");
    for (let i = 0; i < 50 && got.length < 1; i++) await sleep(100);
    check("U1.recv: an authenticated DM reaches the handler with its sender", got.includes(`u1-a|${senderKey}`), { count: got.length });
    await sleep(300);
    const acked = await pending(readerDurable);
    check("U1.ack: the handler's ack lands (nothing pending or unacked)", acked.pending === 0 && acked.ackPending === 0, acked);
    // Renewal: wait for the source's second fetch, which the 60 s margin arms about 10 s in.
    for (let i = 0; i < 200 && fetches < 2; i++) await sleep(100);
    await ep.reconnect(); // a reconnect presents the renewed bearer through the callout
    await sender.unicast(readerKey, "u1-b");
    for (let i = 0; i < 80 && got.length < 2; i++) await sleep(100);
    check("U1.renew: one bearer renewal later, a DM is still handled", fetches >= 2 && got.includes(`u1-b|${senderKey}`), { fetches, count: got.length });
    const stopped = await within(ep.stop().then(() => "ok", (e) => errClass(e)), 15000);
    const drained = await pending(readerDurable);
    check("U1.stop: stop resolves with the handler drained and nothing left unacked", stopped === "ok" && drained.pending === 0 && drained.ackPending === 0, { stopped, ...drained });
    const allowed = (s: string) =>
      s === `$JS.API.CONSUMER.INFO.${DM}.${readerDurable}` || s === `$JS.API.CONSUMER.MSG.NEXT.${DM}.${readerDurable}` || s.startsWith(`$JS.ACK.${DM}.${readerDurable}.`);
    const extra = [...new Set(sent.filter((s) => !allowed(s)))];
    check("U4.census: over start, renewal, reconnect and drain every native request is a dm_ INFO, NEXT or ACK row", sent.length > 0 && extra.length === 0, { requests: sent.length, extraClasses: extra.length });
  }

  // ---- U2: the authenticity guard runs before the handler ------------------------------------------
  {
    const seen: string[] = [];
    const ep = own(new CotalEndpoint(dmOnlyOpts(readerBearer!, { handler: (m, d) => { seen.push(textOf(m)); d.ack(); } })));
    await ep.start();
    const js = jetstream(await bearerConn(agentBearer), { checkAPI: false });
    const subj = unicastSubject(a.space, owner, "dmreader", owner, "dmagent");
    await js.publish(subj, JSON.stringify({ id: "spoof-1", ts: Date.now(), space: a.space, from: { id: `${owner}.someone-else`, name: "x" }, to: readerKey, parts: [{ kind: "text", text: "spoof" }] }));
    await js.publish(subj, JSON.stringify({ ts: Date.now(), space: a.space, from: { id: senderKey, name: "s" }, to: readerKey, parts: [{ kind: "text", text: "no-id" }] }));
    await sender.unicast(readerKey, "genuine");
    for (let i = 0; i < 50 && !seen.includes("genuine"); i++) await sleep(100);
    await sleep(300);
    const after = await pending(readerDurable);
    check("U2.spoof: a spoofed from is terminated before the handler runs", seen.includes("genuine") && !seen.includes("spoof") && after.pending === 0 && after.ackPending === 0, { seen: seen.length, ...after });
    check("U2.no-id: an absent id is terminated before the handler runs", !seen.includes("no-id"));
    await ep.stop();
  }

  // ---- U3: typed refusals, the dm-reader bearer's rows naming a durable that is absent or not its own
  {
    const lone = grantActor(a.stateDir, { owner, actor: "dmlone", scope: [], allowSubscribe: [], allowPublish: [] });
    const loneBearer = bearerOf(await post("/exchange", { idpToken: await dmProof({ actor: "dmlone", lifecycle: lone.lifecycleUid }), actor: "dmlone", view: "dm-reader" }))!;
    const ep = own(new CotalEndpoint({ ...dmOnlyOpts(loneBearer, { handler: () => {} }), lifecycleUid: lone.lifecycleUid, card: { owner, actor: "dmlone", name: "dmlone", kind: "agent" } }));
    const missing = await ep.start().then(() => "started", (e) => e);
    await ep.stop().catch(() => {});
    const absent = await (await jetstreamManager(await ownedConn(provCreds), { checkAPI: false })).consumers.info(DM, dmDurable(owner, "dmlone", lone.lifecycleUid!))
      .then(() => "present", (e) => (isConsumerNotFound(e) ? "absent" : errClass(e)));
    check("U3.missing: an absent dm_ refuses with dm-durable-missing and is not created", missing instanceof DmDurableMissingError && absent === "absent", { class: errClass(missing), absent });
    // The bearer's rows name ITS lifecycle's durable; an endpoint launched at another lifecycle asks
    // for a durable the rows do not grant, and the broker refuses the bind.
    const other = mintLifecycleUid();
    await prov.provisionDmInbox(owner, "dmreader", other);
    const ep2 = own(new CotalEndpoint({ ...dmOnlyOpts(readerBearer!, { handler: () => {} }), lifecycleUid: other }));
    const denied = await ep2.start().then(() => "started", (e) => e);
    await ep2.stop().catch(() => {});
    check("U3.denied: a bind outside the bearer's rows refuses with dm-bind-refused", denied instanceof DmBindRefusedError, { class: errClass(denied) });
  }

  // ---- U4: what the dm-reader bearer is refused, each paired with the agent bearer allowed ---------
  {
    const reader = await bearerConn(readerBearer!);
    const agent = await bearerConn(agentBearer);
    const DLV = dlvStream(a.space);
    const pairs: Array<[string, (nc: NatsConnection) => Promise<Probe>, (nc: NatsConnection) => Promise<Probe>]> = [
      ["dm-publish", (nc) => probePub(nc, unicastSubject(a.space, owner, "dmagent", owner, "dmreader")), (nc) => probePub(nc, unicastSubject(a.space, owner, "dmreader", owner, "dmagent"))],
      ["chat-publish", (nc) => probePub(nc, chatSubject(a.space, owner, "dmreader", "general")), (nc) => probePub(nc, chatSubject(a.space, owner, "dmagent", "general"))],
      ["presence-put", (nc) => probeReq(nc, `$KV.${presenceBucket(a.space)}.${readerKey}`), (nc) => probeReq(nc, `$KV.${presenceBucket(a.space)}.${senderKey}`)],
      ["channel-subscribe", (nc) => probeSub(nc, chatSubject(a.space, "*", "*", "general")), (nc) => probeSub(nc, chatSubject(a.space, "*", "*", "general"))],
      ["own-dlv-bind", (nc) => probeReq(nc, `$JS.API.CONSUMER.INFO.${DLV}.${dlvDurable(owner, "dmreader", readerRow.lifecycleUid!)}`), (nc) => probeReq(nc, `$JS.API.CONSUMER.INFO.${DLV}.${dlvDurable(owner, "dmagent", agentRow.lifecycleUid!)}`)],
      ["peer-dm-bind", (nc) => probeReq(nc, `$JS.API.CONSUMER.INFO.${DM}.${agentDurable}`), (nc) => probeReq(nc, `$JS.API.CONSUMER.INFO.${DM}.${agentDurable}`)],
      ["dm-stream-info", (nc) => probeReq(nc, `$JS.API.STREAM.INFO.${DM}`), (nc) => probeReq(nc, `$JS.API.STREAM.INFO.KV_${presenceBucket(a.space)}`)],
      ["js-api-info", (nc) => probeReq(nc, "$JS.API.INFO"), (nc) => probeReq(nc, "$JS.API.INFO")],
      ["foreign-space-durable", (nc) => probeReq(nc, `$JS.API.CONSUMER.INFO.${dmStream(foreignSpace.space)}.${readerDurable}`), (nc) => probeReq(nc, `$JS.API.CONSUMER.INFO.${DM}.${agentDurable}`)],
    ];
    for (const [name, refused, positive] of pairs) {
      const r = await refused(reader), p = await positive(agent);
      check(`U4.${name}: the dm-reader bearer is refused, the agent bearer's own row is allowed`, r === "denied" && p === "allowed", { reader: r, agent: p });
    }
    const own_ = await probeReq(reader, `$JS.API.CONSUMER.INFO.${DM}.${readerDurable}`);
    check("U4.own-dm-bind: the dm-reader bearer binds its own dm_ (the row it does hold)", own_ === "allowed", { own: own_ });
    const rows = permissionsFor("dm-reader", a.space, { owner, actor: "dmreader", connId: "ibxcensus0123456789", lifecycleUid: readerRow.lifecycleUid }, {}) as { pub: { allow: string[] }; sub: { allow: string[] } };
    check("U4.exact-rows: the profile mints exactly the three dm_ pub rows and the inbox sub row",
      JSON.stringify(rows.pub.allow) === JSON.stringify([`$JS.API.CONSUMER.INFO.${DM}.${readerDurable}`, `$JS.API.CONSUMER.MSG.NEXT.${DM}.${readerDurable}`, `$JS.ACK.${DM}.${readerDurable}.>`])
        && JSON.stringify(rows.sub.allow) === JSON.stringify(["_INBOX_ibxcensus0123456789.>"]), rows);
  }

  // ---- U5: the door x claim matrix -----------------------------------------------------------------
  {
    const proof = await dmProof();
    const plain = await ordinary();
    const isRefused = (r: { status: number }) => r.status === 401 || r.status === 403;
    // A refusal raised by the IdP verifier itself; a positive must get past it to the door's work.
    const verifierRefusal = (r: { body: Record<string, unknown> }) => /idp token|"aud"|JWT|JWS/i.test(String(r.body.error ?? ""));
    const consentBody = (id: string, idpToken: string) => ({ id, idpToken, subject: SUB, accountPublicKey: a.accountPublicKey,
      holder: { actor: "web", lifecycleUid: consentHolder.lifecycleUid }, target: { owner, actor: "worker", lifecycleUid: consentTarget }, ttlMs: 3_600_000 });
    // Each door: the dm-reader proof is refused there, and the same request with an ordinary proof
    // gets past the IdP verifier (any answer other than the verifier's refusal: it reached the work).
    const doors: Array<[string, (t: string) => Promise<{ status: number; body: Record<string, unknown> }>, (r: { status: number; body: Record<string, unknown> }) => boolean]> = [
      ["/exchange (no view)", (t) => exchange(t), (r) => r.status === 200],
      ["/exchange (another view: manager-caller)", (t) => post("/exchange", { idpToken: t, actor: "dmreader", view: "manager-caller" }), (r) => !verifierRefusal(r)],
      ["/manager-instances", (t) => post("/manager-instances", { idpToken: t }), (r) => r.status === 200 || r.status === 503],
      ["/manager-service-authority", (t) => post("/manager-service-authority", { idpToken: t, request: { kind: "probe" } }), (r) => !verifierRefusal(r)],
      ["/chat-session/open", (t) => post("/chat-session/open", { idpToken: t, holderHash: "a".repeat(64), read: ["general"], post: [], ttlSec: 60 }), (r) => r.body.code !== "unauthenticated"],
      ["/chat-session/bearer", (t) => post("/chat-session/bearer", { idpToken: t, actor: "chat_x", holderProof: "x" }), (r) => r.body.code !== "unauthenticated"],
      ["/chat-session/retire", (t) => post("/chat-session/retire", { idpToken: t, actor: "chat_x", lifecycleUid: mintLifecycleUid(), holderProof: "x" }), (r) => r.body.code !== "unauthenticated"],
      ["/tool-result-human-proof/verify", (t) => post("/tool-result-human-proof/verify", { idpToken: t, subject: SUB }), (r) => r.status === 200],
      ["/tool-result-consent/issue", (t) => post("/tool-result-consent/issue", consentBody(`consent_${Math.random().toString(36).slice(2, 10)}`, t)), (r) => r.status === 200 && r.body.consent !== undefined],
    ];
    const pwd = await ordinary({ auth_time: now(), amr: ["pwd"] });
    for (const [name, call, passedVerifier] of doors) {
      const usesPwd = name.startsWith("/tool-result");
      const r = await call(usesPwd ? await sign({ auth_time: now(), amr: ["pwd"], purpose: DM_READER_PURPOSE, actor: "dmreader", lifecycle: readerRow.lifecycleUid, space: a.space }, { aud: DM_AUD }) : proof);
      const p = await call(usesPwd ? pwd : plain);
      check(`U5.door ${name}: a dm-reader proof is refused, an ordinary proof passes the verifier`, isRefused(r) && passedVerifier(p) && r.body.token === undefined, { refused: r.status, positive: p.status });
    }
    // The same proof claims but on the ORDINARY audience: the purpose claim alone is refused at the
    // generic verifier (and therefore at every door that uses it).
    const purposeOnOrdinary = await sign({ purpose: DM_READER_PURPOSE, actor: "dmreader", lifecycle: readerRow.lifecycleUid, space: a.space });
    const pinned = { issuer: ISS, audience: ISS, key: (async () => publicKey) as never };
    const generic = await verifyIdpToken(purposeOnOrdinary, pinned).then(() => "accepted", () => "refused");
    const genericPlain = await verifyIdpToken(plain, pinned).then(() => "accepted", () => "refused");
    check("U5.generic-verifier: any token carrying purpose is refused, an ordinary one is accepted", generic === "refused" && genericPlain === "accepted", { generic, genericPlain });
    const atExchange = await exchange(purposeOnOrdinary);
    check("U5.generic-verifier at /exchange: a purpose claim on the ordinary audience is refused", isRefused(atExchange) && bearerOf(atExchange) === undefined, { status: atExchange.status });

    // The claim matrix on the dm-reader exchange itself, each refusal paired with the valid proof.
    const valid = async () => bearerOf(await exchange(await dmProof(), { view: "dm-reader" })) !== undefined;
    const refusedWith = async (t: string, extra: Record<string, unknown> = {}) => {
      const r = await exchange(t, { view: "dm-reader", ...extra });
      return isRefused(r) && bearerOf(r) === undefined;
    };
    const old = grantActor(a.stateDir, { owner, actor: "dmold", scope: [], allowSubscribe: [], allowPublish: [] });
    const oldUid = old.lifecycleUid!;
    const renewed = grantActor(a.stateDir, { owner, actor: "dmold", scope: [], allowSubscribe: [], allowPublish: [] }); // re-grant rotates the lifecycle
    const claimCells: Array<[string, () => Promise<boolean>]> = [
      ["another actor", async () => refusedWith(await dmProof({ actor: "dmagent" }))],
      ["an old lifecycle", async () => {
        const r = await post("/exchange", { idpToken: await dmProof({ actor: "dmold", lifecycle: oldUid }), actor: "dmold", view: "dm-reader" });
        const p = await post("/exchange", { idpToken: await dmProof({ actor: "dmold", lifecycle: renewed.lifecycleUid }), actor: "dmold", view: "dm-reader" });
        return isRefused(r) && bearerOf(p) !== undefined;
      }],
      ["a foreign space", async () => refusedWith(await dmProof({ space: foreignSpace.space }))],
      ["an unknown purpose", async () => refusedWith(await dmProof({ purpose: "inbox-reader" }))],
      ["a malformed purpose", async () => refusedWith(await dmProof({ purpose: ["dm-reader"] }))],
      ["an absent purpose", async () => refusedWith(await sign({ actor: "dmreader", lifecycle: readerRow.lifecycleUid, space: a.space }, { aud: DM_AUD }))],
      ["an ordinary token (dm-reader requested without the proof)", async () => refusedWith(plain)],
      ["the proof on the ordinary audience", async () => refusedWith(purposeOnOrdinary)],
      ["a missing actor claim", async () => refusedWith(await dmProof({ actor: undefined }))],
      ["a missing lifecycle claim", async () => refusedWith(await dmProof({ lifecycle: undefined }))],
      ["a missing space claim", async () => refusedWith(await dmProof({ space: undefined }))],
      ["an expired proof", async () => refusedWith(await dmProof({}, { exp: now() - 30 }))],
    ];
    for (const [name, refusal] of claimCells) {
      const r = await refusal();
      const p = await valid();
      check(`U5.claim ${name}: refused, and the valid proof still mints`, r && p, { refused: r, positive: p });
    }
  }

  // ---- U6: compatibility ---------------------------------------------------------------------------
  {
    const t = bearerOf(await post("/exchange", { idpToken: await ordinary(), actor: "dmagent" }))!;
    const v = (decodeJwt(t) as { act?: { view?: string } }).act?.view;
    const nc = await bearerConn(t);
    const canPub = await probePub(nc, unicastSubject(a.space, owner, "dmreader", owner, "dmagent"));
    check("U6.agent: an ordinary token with no view still mints the agent profile", v === undefined && canPub === "allowed", { view: v, canPub });

    const signing = await generateSigningKey();
    const iss = createUserTokenIssuer({ issuer: "https://dmreader.views.test", key: signing });
    const uid = mintLifecycleUid();
    let roundTrips = 0, views = 0;
    for (const view of USER_TOKEN_VIEWS) {
      if (view === "service-endpoint") continue; // refuses the ordinary issuer by design (views smoke)
      views++;
      const need = VIEW_REQUIRED_SCOPE[view];
      const tok = await iss.issue({ owner, space: a.space, actor: "cli", scope: need ? [need] : [], view, lifecycleUid: uid,
        ...(view === "manager-caller" ? { managerInstanceId: "m".repeat(26) } : {}),
        ...(view === "session-caller" ? { session: { endpoint: "manager", sessionId: "s".repeat(26), epoch: 1, exp: now() + 300 } } : {}),
        ...(view === "transfer-writer" ? { transferWriter: { instanceId: "m".repeat(26), hex: "a".repeat(64) } } : {}) });
      const back = await validateUserToken(tok, { key: iss.localKeySet(), issuer: "https://dmreader.views.test", audience: a.space });
      if (back.act.view === view) roundTrips++;
    }
    check("U6.views-census: every USER_TOKEN_VIEWS member round-trips, dm-reader included", USER_TOKEN_VIEWS.includes("dm-reader") && roundTrips === views, { roundTrips, views });

    const pub = await exchange(await dmProof(), { view: "dm-reader" }, "public");
    const loop = await exchange(await dmProof(), { view: "dm-reader" });
    check("U6.public-face: the public face refuses dm-reader, loopback serves it", pub.status === 403 && bearerOf(pub) === undefined && bearerOf(loop) !== undefined, { pub: pub.status, loop: loop.status });
  }

  // ---- U7: the #4185 ceiling on the dm-reader arm, through the embedder's mint hook ---------------
  {
    // The seam #4185's bearer-exp-ceiling suite uses: a bridge whose mintConnectCredential hook (the
    // embedder's own code) awaits a delay. The issuer counts signatures; a stock callout mints the
    // NATS user JWT through the shipped dm-reader permissions.
    const stock = createUserTokenIssuer({ issuer: "https://dmreader.ceiling.test", key: await generateSigningKey() });
    let signed = 0;
    const issuer: UserTokenIssuer = { ...stock, issue: async (c) => { const t = await stock.issue(c); signed++; return t; } };
    let hookDelay: () => Promise<void> = async () => {};
    const bridge = createIdpBridge({
      idp: { issuer: ISS, audience: ISS, key: (async () => publicKey) as never }, dmReaderAudience: DM_AUD, space: a.space, spaceSecret: "s".repeat(32), issuer,
      mintConnectCredential: async () => { await hookDelay(); return "root0001"; },
      authorizeActor: () => ({ lifecycleUid: readerRow.lifecycleUid }),
    });
    // The mode's renewal mint is the same exchange called again by its bearer source, while the
    // first bearer is still held; the pair runs once for the first mint and once through a source.
    const source = (proofExp: number) => async () => (await bridge.exchange(await dmProof({}, { exp: proofExp }), { actor: "dmreader", view: "dm-reader", ttlSec: 900 }));
    const ex = async (phase: "exchange" | "renewal", proofExp: number, delay: () => Promise<void>) => {
      hookDelay = delay;
      const before = signed;
      try {
        const r = phase === "exchange"
          ? await bridge.exchange(await dmProof({}, { exp: proofExp }), { actor: "dmreader", view: "dm-reader", ttlSec: 900 })
          : await source(proofExp)();
        return { exp: r.exp, signedNow: signed - before };
      } catch (e) { return { refused: (e as Error).message, signedNow: signed - before }; }
    };
    for (const phase of ["exchange", "renewal"] as const) {
      const okExp = now() + 5;
      const ok = await ex(phase, okExp, () => sleep(2000));
      check(`U7.${phase}: a mint delayed 2 s signs a dm-reader bearer whose exp is at most the proof's`,
        ok.exp !== undefined && ok.exp <= okExp && ok.signedNow === 1, { bearerExp: ok.exp, proofExp: okExp });
      const lateExp = now() + 2;
      const late = await ex(phase, lateExp, () => sleep(2500));
      check(`U7.${phase}: a mint whose hook returns after the proof expired is refused, and nothing is signed`,
        late.refused?.includes("expiry ceiling") === true && late.signedNow === 0, { refused: late.refused !== undefined, signed: late.signedNow });
    }
    // The NATS user JWT the shipped callout mints for a dm-reader bearer expires with the bearer, so
    // the broker ends the connection no later than the proof: connect on a 4 s proof and time it.
    const shortExp = now() + 4;
    const short = bearerOf(await exchange(await dmProof({}, { exp: shortExp }), { view: "dm-reader" }));
    const nc = short ? await bearerConn(short) : undefined;
    const liveAtConnect = nc !== undefined && !nc.isClosed();
    const ended = nc ? await within(nc.closed().then(() => Date.now()), 12_000) : "deadline";
    check("U7.nats-jwt: the connection is admitted, then the broker ends it no later than the proof's exp",
      liveAtConnect && typeof ended === "number" && ended <= shortExp * 1000 + 1500, { liveAtConnect, endedAfterProofMs: typeof ended === "number" ? ended - shortExp * 1000 : ended });
  }
} catch (e) {
  check(`harness: unexpected ${errClass(e)}`, false, (e as Error)?.message);
} finally {
  let unknown = 0;
  for (const ep of endpoints.reverse()) if ((await within(ep.stop().then(() => "ok", () => "threw"), 10000)) === "deadline") unknown++;
  for (const nc of conns) { if (!nc.isClosed()) await within(nc.close().catch(() => {}), 5000); }
  await service?.close().catch(() => { unknown++; });
  idpServer.closeAllConnections();
  await new Promise<void>((r) => idpServer.close(() => r()));
  await fx.close();
  check("custody: endpoints stopped, connections closed, service, IdP and broker closed", unknown === 0, { unknown });
  if (passed() + failed() !== EXPECTED_CELLS) check(`cell count: ran ${passed() + failed()} cells, expected ${EXPECTED_CELLS}`, false);
  finish();
}
process.exit(process.exitCode ?? 0);

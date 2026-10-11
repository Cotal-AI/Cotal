import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  canonicalJson, createSpaceAuth, credsClaims, credsFromJwt, environmentBootstrapActor, environmentManagerPermissions,
  epAuthBucket, isReachable, jwtFromCreds, mintLifecycleUid, mintPublicUserJwt, newIdentity,
  parseEnvironmentManagerBootstrapDocument, serverConfig, type EnvironmentManagerBootstrapDocument,
} from "../src/index.js";
import { awaitBrokerReady, emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let passed = 0, failed = 0;
const cell = async (name: string, run: () => unknown | Promise<unknown>): Promise<void> => {
  try { await run(); console.log(`  ✓ ${name}`); passed++; }
  catch { console.error(`  ✗ ${name}`); failed++; }
};
const auth = await createSpaceAuth("bootstrapdocument");
const foreign = await createSpaceAuth("bootstrapforeign");
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid(), lifecycleUid = mintLifecycleUid(), authorityInstanceId = mintLifecycleUid();
const peer = newIdentity();
const digest = `sha256:${"a".repeat(64)}`;
const make = async (space = auth.space, exp = Math.floor(Date.now() / 1000) + 120): Promise<EnvironmentManagerBootstrapDocument> => {
  const pin = { owner, instanceId, lifecycleUid, authorityEndpoint: "test.example.environment", authorityInstanceId, expiresAt: exp };
  const signed = await mintPublicUserJwt({ space, account: auth.account }, peer.id, "environment-bootstrap", {
    principal: { owner, actor: environmentBootstrapActor(instanceId) }, lifecycleUid, environmentManager: pin, expiresAt: exp,
  });
  return {
    v: 1, space, environmentId: "b".repeat(64), instanceId, lifecycleUid, accountPublicKey: auth.account.pub,
    brokerUrl: "wss://broker.example.invalid/mesh-ws", authorityEndpoint: pin.authorityEndpoint,
    authorityInstanceId, expiresAt: signed.exp,
    contracts: {
      bootstrap: { clusterDigest: digest, inputDigest: digest, outputDigest: digest },
      "bootstrap-status": { clusterDigest: digest, inputDigest: digest, outputDigest: digest },
    },
    creds: credsFromJwt(signed.jwt, peer),
  };
};
const doc = await make();
const carrier = canonicalJson(doc);
const refusesText = (text: string): void => assert.throws(() => parseEnvironmentManagerBootstrapDocument(text), /environment manager bootstrap document/);
// JSON.stringify can encode hostile non-I-JSON strings and non-finite inputs, so rejection must
// come from the actual parser rather than an identical precheck in the fixture's canonicalizer.
const hostile = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => {
  if (v !== null && typeof v === "object" && !Array.isArray(v))
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return v;
});
const refuses = (value: unknown): void => refusesText(hostile(value));
const altered = (change: (claims: Record<string, unknown>) => void, identity = peer): string => {
  const parts = jwtFromCreds(doc.creds)!.split(".");
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>;
  change(claims);
  parts[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return credsFromJwt(parts.join("."), identity);
};

await cell("canonical host-minted bootstrap credentials decode unchanged", () => {
  const parsed = parseEnvironmentManagerBootstrapDocument(carrier);
  assert.ok(canonicalJson(parsed) === carrier);
  assert.ok(parsed.creds === doc.creds && parsed.instanceId === instanceId && parsed.lifecycleUid === lifecycleUid);
});
await cell("paired Unicode space is preserved with its stock fixed grant rows", async () => {
  const unicode = await make("Alpha/🛰");
  assert.ok(parseEnvironmentManagerBootstrapDocument(canonicalJson(unicode)).space === unicode.space);
});
await cell("five-minute equality remains a valid host credential", async () => {
  const ceiling = await make(auth.space, Math.floor(Date.now() / 1000) + 300);
  assert.ok(parseEnvironmentManagerBootstrapDocument(canonicalJson(ceiling)).expiresAt === ceiling.expiresAt);
});
await cell("version refusal precedes credential inspection", () => {
  assert.throws(() => parseEnvironmentManagerBootstrapDocument(hostile({ ...doc, v: 2, creds: "PRIVATE_POISON" })),
    error => error instanceof Error && error.message === "environment manager bootstrap document version must be one");
});
await cell("root owner session signer profile and grant fields refuse", () => {
  for (const key of ["ownerSession", "signingSeed", "profile", "grants", "identity", "owner"]) refuses({ ...doc, [key]: "PRIVATE_EXTRA_FIELD" });
});
await cell("missing root fields refuse", () => {
  for (const key of Object.keys(doc)) { const bad: Record<string, unknown> = { ...doc }; delete bad[key]; refuses(bad); }
});
await cell("non-object and malformed JSON carriers refuse without values", () => {
  for (const raw of [null, [], true, "PRIVATE_VALUE"]) refuses(raw);
  refusesText("{PRIVATE_SYNTAX_VALUE");
});
await cell("oversized bootstrap carrier refuses", () => refusesText(carrier + " ".repeat(64 * 1024)));
await cell("canonical byte check refuses whitespace order and duplicate members", () => {
  refusesText(JSON.stringify(doc, null, 2));
  refusesText(JSON.stringify(doc));
  refusesText(carrier.replace("{", '{"v":1,'));
});
await cell("environment record id must be the native lowercase digest", () => {
  for (const environmentId of ["", "a".repeat(63), "A".repeat(64), "a".repeat(65)]) refuses({ ...doc, environmentId });
});
await cell("reserved manager and authority token grammar is closed", () => {
  for (const key of ["instanceId", "lifecycleUid", "authorityInstanceId"])
    for (const value of ["a".repeat(25), "a".repeat(33), "A".repeat(26), 1]) refuses({ ...doc, [key]: value });
});
await cell("invalid space spellings and types refuse", () => {
  for (const space of ["", ".", "..", "a".repeat(257), "\uD800", "space\u0000", 1]) refuses({ ...doc, space });
});
await cell("endpoint name cannot contain a command or wildcard selector", () => {
  for (const authorityEndpoint of ["", "test.*", "Upper.Case", "bad_name", "a".repeat(65), 1]) refuses({ ...doc, authorityEndpoint });
});
await cell("broker pin refuses plaintext userinfo query fragment and normalization", () => {
  for (const brokerUrl of ["ws://broker.example.invalid/", "https://broker.example.invalid/", "wss://user:PRIVATE@broker.example.invalid/",
    "wss://broker.example.invalid/?token=PRIVATE", "wss://broker.example.invalid/#PRIVATE", "wss://BROKER.example.invalid/",
    "wss://broker.example.invalid:443/", " wss://broker.example.invalid/", "/mesh-ws", 1]) refuses({ ...doc, brokerUrl });
});
await cell("only both fixed bootstrap contract rows are accepted", () => {
  const contracts = { ...doc.contracts } as Record<string, unknown>;
  refuses({ ...doc, contracts: { ...contracts, authority: doc.contracts.bootstrap } });
  delete contracts["bootstrap-status"];
  refuses({ ...doc, contracts });
  refuses({ ...doc, contracts: [] });
});
await cell("command digest rows refuse missing extra and malformed fields", () => {
  for (const command of ["bootstrap", "bootstrap-status"] as const) {
    const row = doc.contracts[command];
    refuses({ ...doc, contracts: { ...doc.contracts, [command]: { ...row, profile: "PRIVATE" } } });
    for (const key of Object.keys(row)) {
      const missing: Record<string, unknown> = { ...row }; delete missing[key];
      refuses({ ...doc, contracts: { ...doc.contracts, [command]: missing } });
      refuses({ ...doc, contracts: { ...doc.contracts, [command]: { ...row, [key]: "a".repeat(64) } } });
    }
  }
});
await cell("expired unbounded noninteger and over-cap file lifetimes refuse", () => {
  for (const expiresAt of [Math.floor(Date.now() / 1000) - 1, Math.floor(Date.now() / 1000) + 301, 1.5, null, "later"])
    refuses({ ...doc, expiresAt });
});
await cell("credential expiry cannot disagree with the file", () => refuses({ ...doc, expiresAt: doc.expiresAt - 1 }));
await cell("credential issue time and issued lifetime remain bounded", () => {
  const clock = Date.now, now = Math.floor(clock() / 1000);
  // Hold only this synchronous local-decoder cell at the boundary under test.
  Date.now = () => now * 1000;
  try {
    for (const iat of [null, "earlier", now + 1, doc.expiresAt - 301])
      refuses({ ...doc, creds: altered(claims => { claims.iat = iat; }) });
    const current = { ...doc, creds: altered(claims => { claims.iat = now; }) };
    assert.ok(parseEnvironmentManagerBootstrapDocument(canonicalJson(current)).creds === current.creds);
  } finally { Date.now = clock; }
  assert.equal(Date.now, clock);
});
await cell("credential envelope refuses raw tokens duplicates and appended material", () => {
  for (const creds of [jwtFromCreds(doc.creds), doc.creds + doc.creds, doc.creds + "PRIVATE_EXTRA", "PRIVATE_NO_CREDENTIAL"])
    refuses({ ...doc, creds });
});
await cell("connection seed and JWT subject cannot be spliced", () => {
  const other = newIdentity();
  refuses({ ...doc, creds: doc.creds.replace(peer.seed, other.seed) });
  refuses({ ...doc, creds: doc.creds.replace(peer.seed, "SUINVALID") });
});
await cell("only private user nkeys may enter the bootstrap carrier", () => {
  const seed = auth.account.signingSeed!;
  const id = fromSeed(new TextEncoder().encode(seed)).getPublicKey();
  const creds = altered(claims => {
    claims.sub = id;
    const nats = claims.nats as Record<string, unknown>;
    const grants = environmentManagerPermissions("environment-bootstrap", auth.space,
      { owner, actor: environmentBootstrapActor(instanceId), connId: id, lifecycleUid },
      { owner, instanceId, lifecycleUid, authorityEndpoint: doc.authorityEndpoint, authorityInstanceId, expiresAt: doc.expiresAt });
    nats.pub = grants.pub; nats.sub = grants.sub;
  }, { id, seed });
  refuses({ ...doc, creds });
});
await cell("host data-account pin cannot be replaced or malformed", () => {
  for (const accountPublicKey of [foreign.account.pub, "A".repeat(56), peer.id, "", 1]) refuses({ ...doc, accountPublicKey });
});
await cell("foreign profile name cannot masquerade as bootstrap", () => {
  refuses({ ...doc, creds: altered(claims => { claims.name = "remote-manager"; }) });
});
await cell("bootstrap actor and exact principal tags cannot be replaced", () => {
  refuses({ ...doc, creds: altered(claims => {
    const nats = claims.nats as { tags: string[] };
    nats.tags = nats.tags.map(tag => tag.startsWith("actor:") ? "actor:other_actor" : tag);
  }) });
  refuses({ ...doc, creds: altered(claims => { (claims.nats as { tags: string[] }).tags.push("owner:PRIVATE_OTHER"); }) });
});
await cell("bootstrap publisher cannot gain auth storage or wildcard grants", () => {
  refuses({ ...doc, creds: altered(claims => { ((claims.nats as Record<string, unknown>).pub as { allow: string[] }).allow.push("$KV.>"); }) });
  refuses({ ...doc, creds: altered(claims => { (claims.nats as Record<string, unknown>).pub = { allow: [">"] }; }) });
});
await cell("bootstrap subscriptions cannot become broad or lose mandatory rows", () => {
  refuses({ ...doc, creds: altered(claims => { (claims.nats as Record<string, unknown>).sub = { allow: [">"] }; }) });
  refuses({ ...doc, creds: altered(claims => { (claims.nats as Record<string, unknown>).sub = { allow: [] }; }) });
});
await cell("dynamic responses bearer mode and foreign JWT kind refuse", () => {
  for (const [key, value] of [["resp", { max: 1, ttl: 1_000_000_000 }], ["bearer_token", true], ["type", "account"], ["version", 3]] as const)
    refuses({ ...doc, creds: altered(claims => { (claims.nats as Record<string, unknown>)[key] = value; }) });
});
await cell("changed authority target or lifecycle cannot adopt existing grant rows", () => {
  for (const key of ["space", "authorityEndpoint", "authorityInstanceId", "instanceId", "lifecycleUid"])
    refuses({ ...doc, [key]: key === "space" ? "foreignspace" : key === "authorityEndpoint" ? "foreign.endpoint" : mintLifecycleUid() });
});
await cell("decoder diagnostics contain no credential seed URL or supplied field", () => {
  for (const bad of [{ ...doc, secret: "PRIVATE_FIELD_DIAGNOSTIC_CONTROL" }, { ...doc, creds: doc.creds + peer.seed },
    { ...doc, brokerUrl: "wss://user:PRIVATE_URL_CONTROL@broker.example.invalid/" }]) {
    let message: string | undefined;
    try { parseEnvironmentManagerBootstrapDocument(hostile(bad)); } catch (error) { if (error instanceof Error) message = error.message; }
    assert.ok(message !== undefined && !message.includes(peer.seed) && !message.includes(doc.creds) && !message.includes("PRIVATE_") && !message.includes("wss:"));
  }
});

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const directory = await mkdtemp(join(tmpdir(), SMOKE_BROKER_TOKEN));
await writeFile(join(directory, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port, storeDir: join(directory, "store"),
}), { mode: 0o600 });
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-c", join(directory, "server.conf")], { stdio: "pipe" });
const releaseBroker = teardownOnSignal(broker, directory);
let brokerOutput = "";
broker.stderr.on("data", bytes => { brokerOutput = (brokerOutput + bytes.toString()).slice(-4000); });
console.log(`OWNED_BROKER_PID=${broker.pid}`);
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 60, delayMs: 50, output: () => brokerOutput });
  await cell("decoded stock credential authenticates on the native private broker", async () => {
    const parsed = parseEnvironmentManagerBootstrapDocument(carrier);
    const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(parsed.creds)), inboxPrefix: `_INBOX_${peer.id}`, reconnect: false });
    try {
      await nc.flush();
      await assert.rejects(() => nc.request(`$KV.${epAuthBucket(auth.space)}.gate.${lifecycleUid}`, new Uint8Array(), { timeout: 1000 }), /Permissions Violation/);
    } finally { await nc.close(); }
  });
  await cell("local decoder is not signature verification and broker rejects forgery", async () => {
    const token = jwtFromCreds(doc.creds)!.split(".");
    token[2] = (token[2]![0] === "A" ? "B" : "A") + token[2]!.slice(1);
    const forged = credsFromJwt(token.join("."), peer);
    assert.ok(parseEnvironmentManagerBootstrapDocument(canonicalJson({ ...doc, creds: forged })).creds === forged);
    await assert.rejects(() => connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(forged)), inboxPrefix: `_INBOX_${peer.id}`, reconnect: false }), /authorization|authentication|signature/i);
  });
} finally {
  await killAndAwaitExit(broker);
  releaseBroker();
  await rm(directory, { recursive: true, force: true });
  console.log(`OWNED_BROKER_CLOSED=${broker.pid}`);
}
console.log(`environment bootstrap document: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;

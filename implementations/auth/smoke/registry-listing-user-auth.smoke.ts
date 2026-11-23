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
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { CotalEndpoint, dialerFor, mintCreds, mintLifecycleUid, newIdentity, readUsername, readUsernameOwner, setupSpaceStreams, standaloneConnectOpts, usernameBucket, UsernameRegistryReadError, type IssuedCaller } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, platformControlOwner, revokeActor, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { authorityWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { pickUsername } from "../src/username-login.js";
import { USERNAME_PICK_PATH, USERNAME_RESERVE_PATH, USERNAME_BACKFILL_PATH } from "../src/username-routes.js";
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
grantActor(a.stateDir, { owner: unnamedOwner, ...narrow });
const idpToken = (subject: string, claims: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setSubject(subject).setIssuer(ISS).setAudience(ISS)
    .setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
};

let service: AuthServiceHandle | undefined;
const services: AuthServiceHandle[] = [];
let registry: { stop(): Promise<void> } | undefined;
const endpoints: CotalEndpoint[] = [];
let readerNc: NatsConnection | undefined;
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
  return { res, body: await res.json() as { token?: string; error?: string; username?: { suggestion?: string; username?: string } } };
}

async function usernamePost(handle: AuthServiceHandle, path: string, body: object, publicFace = false) {
  const response = await fetch(`${publicFace ? handle.publicUrl : handle.url}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(publicFace ? {} : { authorization: `Bearer ${handle.cap}` }) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { suggestion?: string; username?: string; code?: string; error?: string } };
}

function picker(handle: AuthServiceHandle, subject: string, claims: Record<string, unknown>) {
  return async (username?: string) => usernamePost(handle, USERNAME_PICK_PATH, { idpToken: await idpToken(subject, claims), username });
}

async function claimsCases(handle: AuthServiceHandle, nc: NatsConnection, otherNc: NatsConnection) {
  const preferred = { preferred_username: `7-${"N".repeat(41)}`, name: "Ignored Preferred" };
  const display = { email: "ignored@example.test", name: `7-${"n".repeat(38)}` };
  const requests = [picker(handle, "lister-human", preferred), picker(handle, "other-human", display)] as const;
  suite.check("claims exchange returns a suggestion but does not reserve it", (await exchange(handle, "lister-human", preferred)).body.username?.suggestion === base &&
    await readUsername(nc, a.space, owner) === undefined && await readUsernameOwner(nc, a.space, base) === undefined);
  let requestsWithoutTty = 0;
  await pickUsername(false, async () => { requestsWithoutTty++; return requests[0](); }, async () => { throw new Error("unexpected prompt"); });
  suite.check("nonterminal login sends no pick request or reservation", requestsWithoutTty === 0 && await readUsername(nc, a.space, owner) === undefined);
  for (const username of ["admin", "cotal", "support", "root", "system", "bad-name", "a".repeat(41)]) {
    const refused = await requests[0](username);
    suite.check(`the auth service refuses ${username}`, refused.status === 400 && !!refused.body.error);
  }
  const suggestions: string[] = [];
  const errors: string[] = [];
  let started = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  const chosen = await Promise.all(requests.map((request, index) => pickUsername(true, request, async (suggestion, refusal) => {
    if (refusal) { errors.push(refusal); return `second_choice_${index}`; }
    suggestions.push(suggestion);
    if (++started === 2) release();
    await both;
    return suggestion;
  })));
  suite.check("two clients see the suggestion; one confirms it and the other retries with a changed name",
    suggestions.length === 2 && suggestions.every((name) => name === base) && errors.length === 1 && /already reserved/.test(errors[0]!) &&
    chosen.includes(base) && chosen.some((name) => name?.startsWith("second_choice_")), { chosen, suggestions, errors });
  for (const [i, expectedOwner] of [owner, otherOwner].entries()) {
    const name = chosen[i]!;
    suite.check("both members read the same reciprocal confirmed binding", await readUsername(nc, a.space, expectedOwner) === name &&
      await readUsernameOwner(nc, a.space, name) === expectedOwner && await readUsernameOwner(otherNc, a.space, name) === expectedOwner &&
      await readUsername(otherNc, a.space, expectedOwner) === name);
    suite.check("later sign-in returns the permanent name without another prompt",
      await pickUsername(true, requests[i]!, async () => { throw new Error("unexpected second prompt"); }) === name);
    suite.check("a later confirmation cannot rebind the owner", (await requests[i]!("changed_name")).status === 409);
  }
  const noClaims = { preferred_username: "first_private@example.test", name: "second_private@example.test", email: "private_local@example.test" };
  const generated = await picker(handle, "unnamed-human", noClaims)();
  suite.check("email-like claims are skipped and no name binds without confirmation",
    /^user_[0-9a-f]{10}$/.test(generated.body.suggestion ?? "") && await readUsername(nc, a.space, unnamedOwner) === undefined);
  const backfill = await usernamePost(handle, USERNAME_BACKFILL_PATH, { owner: unnamedOwner });
  suite.check("host backfill reserves the generated suggestion for a granted owner",
    backfill.status === 200 && backfill.body.username === generated.body.suggestion &&
    await readUsernameOwner(nc, a.space, backfill.body.username!) === unnamedOwner);
  return chosen;
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
  suite.check("only the host can reserve a directory username before exchanging its grant",
    (await usernamePost(handle, USERNAME_RESERVE_PATH, { owner, username: supplied }, true)).status === 404 &&
    (await usernamePost(handle, USERNAME_RESERVE_PATH, { owner, username: supplied })).body.username === supplied);
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
  suite.check("the opt-in email local part is suggested but not bound without confirmation",
    issued.body.username?.suggestion === "opt_in" && await readUsername(nc, email.space, owner) === undefined);
}

try {
  await setup(a);
  service = await boot(a);
  await registerFixture(mesh, "alpha.example", fixtureCluster("ai.example.alpha", ["read"]));
  registry = await runRegistryFixture(mesh);

  const bearer = async (subject: string, claims: Record<string, unknown>, username?: string): Promise<string> => {
    const { res, body } = await exchange(service!, subject, claims, username);
    if (res.status !== 200 || typeof body.token !== "string") throw new Error(`exchange refused: ${res.status} ${JSON.stringify(body)}`);
    return body.token;
  };
  const [firstToken, otherToken] = await Promise.all([
    bearer("lister-human", { preferred_username: `7-${"N".repeat(41)}`, name: "Ignored Preferred" }, "caller_chosen"),
    bearer("other-human", { email: "ignored@example.test", name: `7-${"n".repeat(38)}` }),
  ]);
  const { ep: first, nc } = await member(a, row, firstToken);
  const { nc: otherNc } = await member(a, otherRow, otherToken);
  const names = await claimsCases(service, nc, otherNc);
  suite.check("an exchange request cannot choose a username", await readUsernameOwner(nc, a.space, "caller_chosen") === undefined);
  for (const key of [`owner.${owner}`, "username.member_write"]) {
    const subject = `$KV.${usernameBucket(a.space)}.${key}`;
    const denied = await nc.request(subject, "member_write", { timeout: 2_000 }).then(() => undefined, (error: Error) =>
      error instanceof PermissionViolationError ? error : error.cause);
    suite.check("the broker refuses a member's KV publish", denied instanceof PermissionViolationError && denied.operation === "publish" && denied.subject === subject, denied);
  }
  assert.throws(() => grantActor(a.stateDir, { owner: unnamedOwner, ...narrow, username: supplied }), /requires the space username source "directory"/);
  suite.check("claims source rejects supplied names at the grant write", true);
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

  const { ep: second } = await member(a, row, changed);
  const other = await second.listingCaller().catch((e: unknown) => e as Error);
  const generationOf = (c: IssuedCaller | Error | undefined) => (c instanceof Error || c === undefined ? undefined : c.generation);
  suite.check("each connection gets its own listing generation",
    generationOf(other) !== undefined && generationOf(caller) !== undefined && generationOf(other) !== generationOf(caller), [generationOf(caller), generationOf(other)]);
  for (const lookup of [() => readUsername(readerNc!, a.space, owner), () => readUsernameOwner(readerNc!, a.space, base)])
    await assert.rejects(lookup, (error: unknown) => error instanceof UsernameRegistryReadError && error.code === "denied");
  suite.check("both lookups distinguish a denied key read from absence", true);
  await directoryCases();
  await emailCase();
  while (services.length) await services.pop()!.close();
  await fx.stopBroker();
  try {
    for (const lookup of [() => readUsername(nc, a.space, owner), () => readUsernameOwner(nc, a.space, base)])
      await assert.rejects(lookup, (error: unknown) => error instanceof UsernameRegistryReadError && error.code === "unavailable");
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

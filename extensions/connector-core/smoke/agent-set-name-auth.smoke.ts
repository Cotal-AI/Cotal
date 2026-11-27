/**
 * An agent's display name and label on its `agent` endpoint (SPEC 13.22 `set-name` and `set-label`),
 * on a real nats-server through the shipped auth callout.
 *
 * Covered: the owner's interactive session renames an agent and gets `{ name }`; the agent's card
 * carries the name at once while its principal stays; a second client watching presence and a third
 * reading it on demand see the new name, the watch emits the rename as a presence update, and a
 * watcher sees it before the agent's next heartbeat; a later message carries the new `from.name` and an earlier
 * one keeps the old; the same name again is ok and changes nothing; every name the shared rule refuses
 * is `bad-request` with the `name-invalid` detail, the long one included; the name of another live
 * agent, in any case, is `already-exists` with `name-taken`, and once that agent is offline its name is
 * free; the agent's own name in another case is a change. The broker refuses a sibling agent of the
 * same owner, another owner's session and another owner's agent that holds a prompts grant, and the
 * shipped grant builder refuses `set-name`. The owner's session labels the agent and gets `{ label }`;
 * the card carries the label and keeps its name, and a watcher sees both; every label the label rule
 * refuses is `bad-request` saying why; the broker refuses a sibling's or another owner's `set-label`;
 * and a later `set-name` drops the label. A closed lane answers `unavailable`. A `MeshAgent` whose
 * launcher restores a display name starts with it under its launch actor, reports it as
 * `displayName`, and follows a rename; `configFromEnv` reads `COTAL_DISPLAY_NAME` and refuses an
 * invalid one, and the shipped connectors' launch env forwards it beside `COTAL_NAME`.
 *
 * Run: pnpm smoke:agent-set-name:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionViolationError, connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  AGENT_ENDPOINT, AGENT_LABEL_META_KEY, AGENT_NAME_REFUSED_DETAIL, CotalEndpoint, EpEnvelopeError, createSpaceAuth, epPrincipalGrantRows, epPrincipalRequestSubject,
  isReachable, mintCreds, mintLifecycleUid, newIdentity, processRuntime, provisionAgentDurables, serverConfig, setupSpaceStreams,
  type EndpointReply, type EpPrincipal, type EpPrincipalServeContext, type Presence,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver, type ValidatedUserToken } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openAgentEndpoint } from "../src/agent-endpoint.js";
import { createNameLane } from "../src/agent-name.js";
import { MeshAgent } from "../src/agent.js";
import { configFromEnv, type AgentConfig } from "../src/config.js";
import { nameEnv } from "../src/launch.js";
import { pickFreePort } from "./_free-port.js";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nonce = () => randomBytes(24).toString("base64url");
async function until(done: () => boolean, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; !done(); await wait(20)) if (Date.now() > end) return false;
  return true;
}
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error }; }
}
const WAIT = 15_000;

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `name-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const broker: ChildProcess = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const A = deriveOwnerToken("s".repeat(32), "better-auth|alice");
const B = deriveOwnerToken("s".repeat(32), "better-auth|bob");

interface Who { owner: string; actor: string; kind: "interactive" | "managed-agent"; uid: string }
const who = (owner: string, actor: string, kind: Who["kind"]): Who => ({ owner, actor, kind, uid: mintLifecycleUid() });
const W = {
  coder: who(A, "coder", "managed-agent"),
  rival: who(A, "rival", "managed-agent"),
  sibling: who(A, "coder2", "managed-agent"),
  ownerSession: who(A, "web", "interactive"),
  reader: who(A, "reader", "managed-agent"),
  foreignSession: who(B, "web", "interactive"),
  foreignGrantee: who(B, "builder", "managed-agent"),
  keeper: who(A, "keeper", "managed-agent"),
  quiet: who(A, "quiet", "managed-agent"),
};
const ledger = new Map(Object.values(W).map((w) => [w.uid, w]));
const resolveAcl: AclResolver = (t) => {
  const w = ledger.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: [], kind: w.kind };
};
// The shipped mint, plus one test-only edit: `builder` holds every grant row the shipped builder makes
// for alice.coder out of prompts and set-name. It refuses set-name.
type Perm = { pub?: { allow?: string[] }; sub?: { allow?: string[] }; [k: string]: unknown };
const shipped = calloutPermissions(resolveAcl, async () => {});
const builderGrants: string[] = [];
const mintFor = async (t: ValidatedUserToken, connId: string, readerId: string): Promise<Record<string, unknown>> => {
  let p = (await shipped(t, connId, readerId)) as Perm;
  const uid = t.act.lifecycleUid!;
  if (uid === W.foreignGrantee.uid) {
    const pub: string[] = [], sub: string[] = [];
    for (const command of ["prompts", "set-name"]) {
      try {
        const r = epPrincipalGrantRows(space, { owner: B, actor: "builder", uid }, { owner: A, actor: "coder", uid: W.coder.uid }, [command]);
        pub.push(...r.pub);
        sub.push(...r.sub);
        builderGrants.push(command);
      } catch { /* the cluster does not admit this command with grant */ }
    }
    p = { ...p, pub: { ...p.pub, allow: [...(p.pub?.allow ?? []), ...pub] }, sub: { ...p.sub, allow: [...new Set([...(p.sub?.allow ?? []), ...sub])] } };
  }
  return p;
};
async function bearer(w: Who): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: w.owner, ver: USER_TOKEN_VER, act: { owner: w.owner, actor: w.actor, scope: [], lifecycleUid: w.uid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(w.owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780)
    .sign(privateKey as CryptoKey);
}

const stops: (() => Promise<unknown>)[] = [];
const errors: string[] = [];
async function userEndpoint(w: Who, opts: { registerPresence?: boolean; watchPresence?: boolean; heartbeatMs?: number } = {}): Promise<CotalEndpoint> {
  const ep = new CotalEndpoint({ space, servers: SERVERS, bearer: () => bearer(w), sentinelCreds: callout.sentinelCreds, lifecycleUid: w.uid,
    card: { owner: w.owner, actor: w.actor, name: w.actor, kind: "agent" }, channels: [], consume: false, watchChannels: false,
    registerPresence: opts.registerPresence ?? false, watchPresence: opts.watchPresence ?? false, ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}) });
  ep.on("error", (e: Error) => errors.push(`${w.owner === A ? "alice" : "bob"}.${w.actor}: ${e.message}`));
  stops.push(() => ep.stop());
  await ep.start();
  return ep;
}
interface Seat { w: Who; nc: NatsConnection; refused: string[] }
async function seat(w: Who): Promise<Seat> {
  const n = `ibx${randomUUID().replace(/-/g, "")}`;
  const nc = await connect({ servers: SERVERS, name: n, inboxPrefix: `_INBOX_${n}`, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await bearer(w))] });
  const s: Seat = { w, nc, refused: [] };
  void (async () => {
    for await (const st of nc.status())
      if (st.type === "error" && st.error instanceof PermissionViolationError && st.error.operation === "publish") s.refused.push(st.error.subject);
  })().catch(() => {});
  stops.push(() => nc.close());
  return s;
}
const addressOf = (w: Who): EpPrincipal => ({ owner: w.owner, actor: w.actor, uid: w.uid, runtimeId: processRuntime(w.uid).id });
const rename = (ep: CotalEndpoint, to: Who, name: unknown, authority: "owner" | "grant" = "owner") =>
  settled(ep.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: addressOf(to), command: "set-name", authority, args: { name }, deadlineMs: WAIT }));
type Settled = Awaited<ReturnType<typeof rename>>;
const verdict = (r: Settled): string =>
  r.ok ? (r.value.ok ? "ok" : `${r.value.error.code}/${r.value.error.outcome ?? "-"}`)
    : r.error instanceof EpEnvelopeError ? `${r.error.code}/${r.error.outcome ?? "-"}` : `threw ${(r.error as Error).message}`;
const reason = (r: Settled): unknown => (r.ok && !r.value.ok ? r.value.error.details?.find((d) => d.kind === AGENT_NAME_REFUSED_DETAIL)?.reason : undefined);
const data = (r: Settled): unknown => (r.ok && r.value.ok ? (r.value as EndpointReply & { data: unknown }).data : undefined);
const refusalText = (r: Settled): string => (r.ok && !r.value.ok ? r.value.error.message : "");
const relabel = (ep: CotalEndpoint, to: Who, label: unknown) =>
  settled(ep.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: addressOf(to), command: "set-label", authority: "owner", args: { label }, deadlineMs: WAIT }));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function publishRefused(s: Seat, to: Who, authority: "owner" | "grant"): Promise<boolean> {
  const subject = epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal: addressOf(to), command: "set-name", authority, caller: { owner: s.w.owner, actor: s.w.actor, uid: s.w.uid }, nonce: nonce() });
  s.nc.publish(subject, enc("{}"));
  await s.nc.flush();
  return until(() => s.refused.includes(subject));
}

let calloutNc: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  const provisioner = new CotalEndpoint({ space, servers: SERVERS, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {});
  stops.push(() => provisioner.stop());
  await provisioner.start();
  for (const w of [W.coder, W.rival, W.sibling, W.reader, W.keeper, W.quiet])
    await provisionAgentDurables(provisioner, { owner: w.owner, actor: w.actor, lifecycleUid: w.uid }, { durableMembership: false });
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: mintFor,
    log: (l) => { if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l); },
  });

  const webEp = await userEndpoint(W.ownerSession, { watchPresence: true });
  const siblingEp = await userEndpoint(W.sibling);
  const bobWebEp = await userEndpoint(W.foreignSession, { watchPresence: true });
  const builderEp = await userEndpoint(W.foreignGrantee);
  const readerEp = await userEndpoint(W.reader, { registerPresence: true });
  const rivalEp = await userEndpoint(W.rival, { registerPresence: true });
  const coderEp = await userEndpoint(W.coder, { registerPresence: true });
  const logs: string[] = [];
  const coderServe = await openAgentEndpoint(coderEp, { warn: (m) => logs.push(`coder: ${m}`) });
  stops.push(() => coderServe.close());
  const coderId = `${A}.coder`;
  const shownTo = (ep: CotalEndpoint) => ep.getRoster().find((p: Presence) => p.card.id === coderId)?.card.name;
  await until(() => shownTo(webEp) === "coder" && webEp.getRoster().some((p) => p.card.id === `${A}.rival`), 10_000);

  console.log("\nthe owner's interactive session renames the agent");
  const before = await coderEp.unicast(`${A}.reader`, "before the rename");
  const events: string[] = [];
  bobWebEp.on("presence", (e: { type: string; presence: Presence }) => { if (e.presence.card.id === coderId) events.push(`${e.type}:${e.presence.card.name}`); });
  const renamed = await rename(webEp, W.coder, "Ada Reviewer");
  check("set-name answers ok with { name } as the card now carries it", verdict(renamed) === "ok" && same(data(renamed), { name: "Ada Reviewer" }), verdict(renamed));
  check("the agent's card carries the new name at once, and its id and principal are unchanged",
    coderEp.card.name === "Ada Reviewer" && coderEp.card.id === coderId && coderEp.principal.owner === A && coderEp.principal.actor === "coder",
    { name: coderEp.card.name, id: coderEp.card.id, principal: coderEp.principal });
  check("a second client that watches presence sees the new name under the same id", await until(() => shownTo(bobWebEp) === "Ada Reviewer", 4000), shownTo(bobWebEp));
  check("...and its watch emits the rename as a presence update, though nothing else in the record changed",
    await until(() => events.includes("update:Ada Reviewer"), 4000), events);
  const read = await readerEp.readPresence();
  check("a third client reading presence on demand sees it too", read.find((p) => p.card.id === coderId)?.card.name === "Ada Reviewer",
    read.map((p) => `${p.card.id}=${p.card.name}`));
  const after = await coderEp.unicast(`${A}.reader`, "after the rename");
  check("a message sent after the rename carries the new from.name and the same from.id; the one sent before keeps the old name",
    after.from.name === "Ada Reviewer" && after.from.id === coderId && before.from.name === "coder" && before.from.id === coderId, { before: before.from, after: after.from });

  {
    // A heartbeat every 30 s: within the 1.5 s below only the write set-name makes can show the name.
    const quietEp = await userEndpoint(W.quiet, { registerPresence: true, heartbeatMs: 30_000 });
    const quietServe = await openAgentEndpoint(quietEp, { warn: (m) => logs.push(`quiet: ${m}`) });
    stops.push(() => quietServe.close());
    const quietName = () => bobWebEp.getRoster().find((p) => p.card.id === `${A}.quiet`)?.card.name;
    await until(() => quietName() === "quiet", 10_000);
    const r = await rename(webEp, W.quiet, "Quiet Hand");
    check("set-name republishes presence at once: a watcher sees the name long before the agent's next heartbeat",
      verdict(r) === "ok" && await until(() => quietName() === "Quiet Hand", 1500), { verdict: verdict(r), shown: quietName() });
  }

  console.log("\nthe same name again");
  {
    const writes: string[] = [];
    const setCardName = coderEp.setCardName.bind(coderEp);
    coderEp.setCardName = async (n: string) => { writes.push(n); return setCardName(n); };
    const again = await rename(webEp, W.coder, "Ada Reviewer");
    coderEp.setCardName = setCardName;
    check("repeating the current name is ok with { name }, and the agent writes nothing",
      verdict(again) === "ok" && same(data(again), { name: "Ada Reviewer" }) && writes.length === 0 && coderEp.card.name === "Ada Reviewer", { verdict: verdict(again), writes });
  }

  console.log("\nnames the shared rule refuses");
  {
    const bad: [string, unknown][] = [["empty", ""], ["padded", " Ada "], ["a slash", "a/b"], ["a backslash", "a\\b"], ["a line break", "a\nb"],
      ["129 characters", "x".repeat(129)], ["an unpaired surrogate", "a\uD800b"]];
    const got = await Promise.all(bad.map(async ([what, name]) => ({ what, r: await rename(webEp, W.coder, name) })));
    check(`each of ${bad.length} invalid names is bad-request, not-executed, with the name-invalid detail`,
      got.every(({ r }) => verdict(r) === "bad-request/not-executed" && reason(r) === "name-invalid"), got.map(({ what, r }) => `${what}: ${verdict(r)} ${String(reason(r))}`));
    const notString = await rename(webEp, W.coder, 7);
    check("a name that is not a string fails the input contract: bad-request, not-executed", verdict(notString) === "bad-request/not-executed", verdict(notString));
    check("and the card kept its name", coderEp.card.name === "Ada Reviewer" && shownTo(bobWebEp) === "Ada Reviewer", coderEp.card.name);
  }

  console.log("\nthe name of another live agent");
  {
    const taken = await Promise.all(["rival", "RIVAL", "Rival"].map((n) => rename(webEp, W.coder, n)));
    check("the live agent rival's name, in any case, is already-exists, not-executed, with the name-taken detail",
      taken.every((r) => verdict(r) === "already-exists/not-executed" && reason(r) === "name-taken"), taken.map((r) => `${verdict(r)} ${String(reason(r))}`));
    check("and the card kept its name", coderEp.card.name === "Ada Reviewer", coderEp.card.name);
    const ownCase = await rename(webEp, W.coder, "ada reviewer");
    check("the agent's own name in another case is a change: ok", verdict(ownCase) === "ok" && coderEp.card.name === "ada reviewer", verdict(ownCase));
    await rivalEp.stop();
    await until(() => webEp.getRoster().find((p) => p.card.id === `${A}.rival`)?.status === "offline", 8000);
    const freed = await rename(webEp, W.coder, "rival");
    check("once rival is offline its name is free: ok", verdict(freed) === "ok" && coderEp.card.name === "rival", verdict(freed));
    const back = await rename(webEp, W.coder, "Ada Reviewer");
    check("and the agent takes its display name back", verdict(back) === "ok" && await until(() => shownTo(bobWebEp) === "Ada Reviewer", 4000), verdict(back));
  }

  console.log("\nwho else may rename");
  {
    const sibling = await rename(siblingEp, W.coder, "Mallory");
    check("a sibling agent of the same owner, which holds no owner row: permission-denied, not-executed", verdict(sibling) === "permission-denied/not-executed", verdict(sibling));
    const siblingRaw = await seat(W.sibling);
    const refused = [await publishRefused(siblingRaw, W.coder, "owner"), await publishRefused(siblingRaw, W.coder, "grant")];
    check("...and the broker refuses its raw set-name publish under owner and under grant", refused.every(Boolean), refused);
    const foreign = await rename(bobWebEp, W.coder, "Mallory");
    check("another owner's interactive session: permission-denied, not-executed", verdict(foreign) === "permission-denied/not-executed", verdict(foreign));
    check("the shipped grant builder makes a row for prompts and refuses set-name", same(builderGrants, ["prompts"]), builderGrants);
    const viaGrant = await rename(builderEp, W.coder, "Mallory", "grant");
    check("another owner's agent with a prompts grant: permission-denied, not-executed", verdict(viaGrant) === "permission-denied/not-executed", verdict(viaGrant));
    check("none of them changed the name", coderEp.card.name === "Ada Reviewer" && shownTo(webEp) === "Ada Reviewer", coderEp.card.name);
  }

  console.log("\nthe owner labels the agent");
  {
    const labelTo = (ep: CotalEndpoint) => ep.getRoster().find((p: Presence) => p.card.id === coderId)?.card.meta?.[AGENT_LABEL_META_KEY];
    const r = await relabel(webEp, W.coder, "Login work");
    check("set-label answers ok with { label }", verdict(r) === "ok" && same(data(r), { label: "Login work" }), verdict(r));
    check("the agent's card carries the label and keeps its name, and a watcher sees both",
      coderEp.card.meta?.[AGENT_LABEL_META_KEY] === "Login work" && coderEp.card.name === "Ada Reviewer"
        && await until(() => labelTo(bobWebEp) === "Login work" && shownTo(bobWebEp) === "Ada Reviewer", 4000),
      { meta: coderEp.card.meta, name: coderEp.card.name, seen: [labelTo(bobWebEp), shownTo(bobWebEp)] });
    const bad: [string, string][] = [["41 characters", "x".repeat(41)], ["two spaces", "Login  work"], ["a tab", "Login\twork"], ["a slash", "src/app.ts"],
      ["a line break", "a\nb"], ["padded", " Login"], ["empty", ""]];
    const got = await Promise.all(bad.map(async ([what, label]) => ({ what, r: await relabel(webEp, W.coder, label) })));
    check(`each of ${bad.length} labels the label rule refuses is bad-request, not-executed, saying why`,
      got.every(({ r }) => verdict(r) === "bad-request/not-executed" && /^invalid (label|name)/.test(refusalText(r))), got.map(({ what, r }) => `${what}: ${verdict(r)} ${refusalText(r)}`));
    check("and the card kept its label", coderEp.card.meta?.[AGENT_LABEL_META_KEY] === "Login work", coderEp.card.meta);
    const sibling = await relabel(siblingEp, W.coder, "Mallory");
    const foreign = await relabel(bobWebEp, W.coder, "Mallory");
    check("a sibling agent of the same owner and another owner's session: permission-denied, not-executed",
      verdict(sibling) === "permission-denied/not-executed" && verdict(foreign) === "permission-denied/not-executed", [verdict(sibling), verdict(foreign)]);
    const back = await rename(webEp, W.coder, "Ada Reviewer");
    check("a later set-name drops the label", verdict(back) === "ok" && coderEp.card.meta?.[AGENT_LABEL_META_KEY] === undefined && await until(() => labelTo(bobWebEp) === undefined, 4000),
      { verdict: verdict(back), meta: coderEp.card.meta });
  }

  console.log("\na closed lane");
  {
    const lane = createNameLane(coderEp, (m) => logs.push(m));
    lane.close();
    const ctx = { request: { args: { name: "Later" } } } as unknown as EpPrincipalServeContext;
    const closed = await settled(Promise.resolve(lane.handlers.find((h) => h.command === "set-name")!.handler(ctx)));
    check("a set-name after the lane closed is unavailable, not-executed, and the card keeps its name",
      !closed.ok && closed.error instanceof EpEnvelopeError && closed.error.code === "unavailable" && closed.error.outcome === "not-executed" && coderEp.card.name === "Ada Reviewer",
      closed.ok ? closed.value : (closed.error as Error).message);
  }

  console.log("\na MeshAgent whose launcher restores a display name");
  {
    const config: AgentConfig = {
      space, servers: SERVERS, name: W.keeper.actor, displayName: "Kept Name", kind: "agent", tls: false, lifecycleUid: W.keeper.uid,
      subscribe: [], allowSubscribe: [], allowPublish: [],
      userAuth: { owner: W.keeper.owner, actor: W.keeper.actor, sentinelCreds: callout.sentinelCreds, bearer: () => bearer(W.keeper) },
    };
    const agent = new MeshAgent(config, {});
    agent.on("error", () => {});
    stops.push(() => agent.stop());
    await agent.start();
    const keeperId = `${A}.keeper`;
    const seen = () => bobWebEp.getRoster().find((p) => p.card.id === keeperId);
    await until(() => seen()?.prompts !== undefined, 10_000);
    check("it starts with the restored name under its launch actor, and reports it as displayName",
      seen()?.card.name === "Kept Name" && agent.ep.principal.actor === "keeper" && agent.id === keeperId && agent.displayName === "Kept Name",
      { shown: seen()?.card.name, actor: agent.ep.principal.actor, displayName: agent.displayName });
    const r = await rename(webEp, W.keeper, "Renamed Keeper");
    check("a rename moves displayName and presence, and the launch name stays its config name",
      verdict(r) === "ok" && agent.displayName === "Renamed Keeper" && config.name === "keeper" && await until(() => seen()?.card.name === "Renamed Keeper", 4000),
      { verdict: verdict(r), displayName: agent.displayName });
  }

  console.log("\nthe launch env");
  {
    const env = { COTAL_SPACE: space, COTAL_LINK: undefined, COTAL_NAME: "keeper", COTAL_ID: "keeper" };
    const restored = configFromEnv({ ...env, COTAL_DISPLAY_NAME: "Kept Name" });
    const plain = configFromEnv(env);
    const sameAsName = configFromEnv({ ...env, COTAL_DISPLAY_NAME: "keeper" });
    check("configFromEnv reads COTAL_DISPLAY_NAME as displayName and keeps COTAL_NAME as name; absent or equal to the name, there is none",
      restored.name === "keeper" && restored.displayName === "Kept Name" && plain.displayName === undefined && sameAsName.displayName === undefined,
      { restored: [restored.name, restored.displayName], plain: plain.displayName, sameAsName: sameAsName.displayName });
    const invalid = await settled(Promise.resolve().then(() => configFromEnv({ ...env, COTAL_DISPLAY_NAME: "a/b" })));
    check("an invalid COTAL_DISPLAY_NAME is refused, naming the variable", !invalid.ok && /COTAL_DISPLAY_NAME/.test((invalid.error as Error).message), invalid.ok ? "accepted" : (invalid.error as Error).message);
    check("nameEnv forwards the launch name, and the display name only when there is one",
      same(nameEnv({ name: "keeper", displayName: "Kept Name" }), { COTAL_NAME: "keeper", COTAL_DISPLAY_NAME: "Kept Name" }) && same(nameEnv({ name: "keeper" }), { COTAL_NAME: "keeper" }));
  }

  check("no endpoint reported an error and the agent endpoint warned nothing", errors.length === 0 && logs.length === 0, { errors, logs });
} catch (e) {
  check(`the suite threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  await calloutNc?.close().catch(() => {});
  await killAndAwaitExit(broker);
  release();
  rmSync(dir, { recursive: true, force: true });
}
finish();

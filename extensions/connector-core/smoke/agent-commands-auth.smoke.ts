/**
 * An agent's own commands and skills on its `agent` endpoint (SPEC 13.22), on a real nats-server
 * through the shipped auth callout. A fake dispatcher stands in for the harness: it lists what a
 * harness would hand over, junk included, and records every command it is asked to start.
 *
 * Covered: the owner's interactive session lists the exact entries and runs a command and a skill
 * under the names the list gave; the broker refuses a sibling agent of the same owner, another
 * owner's session and another owner's agent that holds a prompts grant; an endpoint with no
 * dispatcher answers `supported: false` and refuses `command`; each harness answer maps to its code
 * and outcome; a failed list is an error, never an empty list; the reply bytes carry no field a
 * harness keeps; the queue bound; a command still waiting at the 10 s bound did not start, and one
 * still being started there has an unknown outcome; and closing refuses what waits. A `MeshAgent`
 * opens its endpoint once it joined a per-user mesh, with or without a dispatcher, runs a command that
 * arrived before the broker confirmed its serve, refuses what waits when it stops, answers a command
 * its harness is still being asked to start as `unavailable` with an unknown outcome when it stops,
 * within the stop's 3 s bound, and on an open mesh starts as before and serves nothing.
 *
 * Run: pnpm smoke:agent-commands:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionViolationError, connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  AGENT_CONTRACTS, AGENT_ENDPOINT, CotalEndpoint, EpEnvelopeError, createSpaceAuth, epPrincipalCallerReplyFilter, epPrincipalGrantRows,
  epPrincipalNoRespondersSubject, epPrincipalReplySubject, epPrincipalRequestSubject, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, processRuntime, provisionAgentDurables, serverConfig, setupSpaceStreams,
  type CommandEntry, type CommandTarget, type EndpointReply, type EpPrincipal, type Presence,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver, type ValidatedUserToken } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openAgentEndpoint, type AgentEndpoint } from "../src/agent-endpoint.js";
import { COMMAND_REPLY_MS, CommandRefused, MAX_QUEUED_COMMANDS, type AgentCommand, type CommandDispatcher } from "../src/agent-commands.js";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { pickFreePort } from "./_free-port.js";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nonce = () => randomBytes(24).toString("base64url");
async function until(done: () => boolean, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; !done(); await wait(20)) if (Date.now() > end) return false;
  return true;
}
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error }; }
}
const WAIT = COMMAND_REPLY_MS + 5_000;

const PORT = await pickFreePort(), OPEN_PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`, OPEN_SERVERS = `nats://127.0.0.1:${OPEN_PORT}`;
const space = `cmds-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
writeFileSync(join(dir, "open.conf"), `port: ${OPEN_PORT}\nhost: 127.0.0.1\njetstream { store_dir: "${join(dir, "open-js")}" }\n`);
const brokers: ChildProcess[] = [];
const releases: (() => void)[] = [];
for (const conf of ["server.conf", "open.conf"]) {
  const child = spawn("nats-server", ["-c", join(dir, conf)], { stdio: "ignore" });
  releases.push(teardownOnSignal(child, dir));
  brokers.push(child);
}

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const A = deriveOwnerToken("s".repeat(32), "better-auth|alice");
const B = deriveOwnerToken("s".repeat(32), "better-auth|bob");

interface Who { name: string; owner: string; actor: string; kind: "interactive" | "managed-agent"; uid: string }
const who = (owner: string, actor: string, kind: Who["kind"]): Who =>
  ({ name: `${owner === A ? "alice" : "bob"}.${actor}`, owner, actor, kind, uid: mintLifecycleUid() });
const W = {
  withDispatcher: who(A, "coder", "managed-agent"),
  noDispatcher: who(A, "plain", "managed-agent"),
  byHand: who(A, "lane", "managed-agent"),
  sibling: who(A, "coder2", "managed-agent"),
  ownerSession: who(A, "web", "interactive"),
  foreignSession: who(B, "web", "interactive"),
  meshWithDispatcher: who(A, "agent", "managed-agent"),
  meshNoDispatcher: who(A, "agentplain", "managed-agent"),
  meshEarly: who(A, "agentearly", "managed-agent"),
  meshStopping: who(A, "agentstop", "managed-agent"),
  foreignGrantee: who(B, "builder", "managed-agent"),
};
const ledger = new Map(Object.values(W).map((w) => [w.uid, w]));
const resolveAcl: AclResolver = (t) => {
  const w = ledger.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: [], kind: w.kind };
};
// The shipped mint, plus one test-only edit: `builder` holds every grant row the shipped builder
// makes for alice.coder out of prompts, commands and command. It refuses the last two.
type Perm = { pub?: { allow?: string[] }; sub?: { allow?: string[] }; [k: string]: unknown };
const shipped = calloutPermissions(resolveAcl, async () => {});
const builderGrants: string[] = [];
const mintFor = async (t: ValidatedUserToken, connId: string, readerId: string): Promise<Record<string, unknown>> => {
  let p = (await shipped(t, connId, readerId)) as Perm;
  const uid = t.act.lifecycleUid!;
  if (uid === W.foreignGrantee.uid) {
    const pub: string[] = [], sub: string[] = [];
    for (const command of ["prompts", "commands", "command"]) {
      try {
        const r = epPrincipalGrantRows(space, { owner: B, actor: "builder", uid }, { owner: A, actor: "coder", uid: W.withDispatcher.uid }, [command]);
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
async function userEndpoint(w: Who, opts: { registerPresence?: boolean; watchPresence?: boolean } = {}): Promise<CotalEndpoint> {
  const ep = new CotalEndpoint({ space, servers: SERVERS, bearer: () => bearer(w), sentinelCreds: callout.sentinelCreds, lifecycleUid: w.uid,
    card: { owner: w.owner, actor: w.actor, name: w.actor, kind: "agent" }, channels: [], consume: false, watchChannels: false,
    registerPresence: opts.registerPresence ?? false, watchPresence: opts.watchPresence ?? false });
  ep.on("error", (e: Error) => errors.push(`${w.name}: ${e.message}`));
  stops.push(() => ep.stop());
  await ep.start();
  return ep;
}
interface Seat { w: Who; nc: NatsConnection; refused: { operation: string; subject: string }[] }
async function seat(w: Who): Promise<Seat> {
  const n = `ibx${randomUUID().replace(/-/g, "")}`;
  const nc = await connect({ servers: SERVERS, name: n, inboxPrefix: `_INBOX_${n}`, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await bearer(w))] });
  const s: Seat = { w, nc, refused: [] };
  void (async () => {
    for await (const st of nc.status())
      if (st.type === "error" && st.error instanceof PermissionViolationError) s.refused.push({ operation: st.error.operation, subject: st.error.subject });
  })().catch(() => {});
  stops.push(() => nc.close());
  return s;
}
const meshConfig = (w: Who): AgentConfig => ({
  space, servers: SERVERS, name: w.actor, kind: "agent", tls: false, lifecycleUid: w.uid, subscribe: [], allowSubscribe: [], allowPublish: [],
  userAuth: { owner: w.owner, actor: w.actor, sentinelCreds: callout.sentinelCreds, bearer: () => bearer(w) },
});
const addressOf = (w: Who): EpPrincipal => ({ owner: w.owner, actor: w.actor, uid: w.uid, runtimeId: processRuntime(w.uid).id });
const call = (ep: CotalEndpoint, to: Who, command: string, args: Record<string, unknown> = {}, authority: "owner" | "grant" = "owner") =>
  ep.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: addressOf(to), command, authority, args, deadlineMs: WAIT });
const verdict = (r: { ok: true; value: EndpointReply } | { ok: false; error: unknown }): string =>
  r.ok ? (r.value.ok ? "ok" : `${r.value.error.code}/${r.value.error.outcome ?? "-"}`)
    : r.error instanceof EpEnvelopeError ? `${r.error.code}/${r.error.outcome ?? "-"}` : `threw ${(r.error as Error).message}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function rawCall(s: Seat, to: Who, command: string, args: Record<string, unknown>): Promise<string | undefined> {
  const n = nonce();
  const caller = { owner: s.w.owner, actor: s.w.actor, uid: s.w.uid };
  const principal = addressOf(to);
  const replyTo = epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal, caller, nonce: n });
  const got = new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => { sub.unsubscribe(); resolve(undefined); }, WAIT);
    const sub = s.nc.subscribe(epPrincipalCallerReplyFilter(space, caller, n), { callback: (_e, m) => {
      if (m.subject !== replyTo) return;
      clearTimeout(timer);
      sub.unsubscribe();
      resolve(dec(m.data));
    } });
  });
  const contract = AGENT_CONTRACTS[command];
  const env = { v: 1, id: randomBytes(8).toString("hex"), op: { endpoint: AGENT_ENDPOINT, command, inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest },
    class: "ephemeral", replyExpected: true, deadlineMs: WAIT, args, from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor } };
  s.nc.publish(epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal, command, authority: "owner", caller, nonce: n }), enc(JSON.stringify(env)),
    { reply: epPrincipalNoRespondersSubject(space, caller, n) });
  return got;
}
async function publishRefused(s: Seat, to: Who, command: string, authority: "owner" | "grant"): Promise<boolean> {
  const subject = epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal: addressOf(to), command, authority, caller: { owner: s.w.owner, actor: s.w.actor, uid: s.w.uid }, nonce: nonce() });
  s.nc.publish(subject, enc("{}"));
  await s.nc.flush();
  return until(() => s.refused.some((r) => r.operation === "publish" && r.subject === subject));
}

const LISTED = [
  { name: "review", target: "command", description: "review changes [commit|branch|pr]", inputHint: "[commit|branch|pr]" },
  { name: "init", target: "command", description: "" },
  { name: "has space", target: "command", description: "a name no command can carry" },
  { name: "browser", target: "skill", description: "d".repeat(1100), path: "/home/someone/.config/opencode/skill/browser/SKILL.md", content: "SKILL-BODY" },
];
const EXPECTED: CommandEntry[] = [
  { name: "review", target: "command", description: "review changes [commit|branch|pr]", inputHint: "[commit|branch|pr]" },
  { name: "init", target: "command" },
  { name: "browser", target: "skill", description: `${"d".repeat(1023)}…` },
];
interface Fake extends CommandDispatcher { ran: AgentCommand[]; lists: number }
function fake(o: { targets?: CommandTarget[]; list?: () => Promise<unknown[]>; dispatch?: (c: AgentCommand) => Promise<void> } = {}): Fake {
  const f: Fake = {
    ran: [], lists: 0, targets: new Set(o.targets ?? ["command", "skill"]),
    async list() { f.lists++; return (await (o.list ? o.list() : Promise.resolve(structuredClone(LISTED)))) as CommandEntry[]; },
    async dispatch(c) { f.ran.push(c); await o.dispatch?.(c); },
  };
  return f;
}

let calloutNc: NatsConnection | undefined;
try {
  for (const port of [PORT, OPEN_PORT]) {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${port}`); if (!up) await wait(200); }
    if (!up) throw new Error(`nats-server did not come up on ${port}`);
  }
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  const provisioner = new CotalEndpoint({ space, servers: SERVERS, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {});
  stops.push(() => provisioner.stop());
  await provisioner.start();
  for (const w of [W.withDispatcher, W.noDispatcher, W.byHand, W.sibling, W.meshWithDispatcher, W.meshNoDispatcher, W.meshEarly, W.meshStopping])
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
  const coder2Ep = await userEndpoint(W.sibling);
  const bobWebEp = await userEndpoint(W.foreignSession);
  const builderEp = await userEndpoint(W.foreignGrantee);

  console.log("\nan agent endpoint with a dispatcher, called by the owner's interactive session");
  const logs: string[] = [];
  const coderHarness = fake();
  const coderEp = await userEndpoint(W.withDispatcher, { registerPresence: true });
  const coderServe: AgentEndpoint = await openAgentEndpoint(coderEp, { warn: (m) => logs.push(`coder: ${m}`), dispatcher: coderHarness, onQueued: () => void coderServe.commands.dispatchNext() });
  stops.push(() => coderServe.close());
  const listed = await settled(call(webEp, W.withDispatcher, "commands"));
  const catalog = listed.ok && listed.value.ok ? listed.value.data as { supported: boolean; commands?: CommandEntry[] } : undefined;
  check(`commands answers exactly ${EXPECTED.length} entries: the nameless one left out, the long description cut to 1024 characters, the empty one dropped`,
    same(catalog, { supported: true, commands: EXPECTED }), catalog ?? verdict(listed));
  const webRaw = await seat(W.ownerSession);
  const bytes = await rawCall(webRaw, W.withDispatcher, "commands", {});
  check("the reply bytes on the wire carry no path, content or other field the harness keeps",
    bytes !== undefined && bytes.includes('"supported":true') && !/"path"|"content"|SKILL-BODY|\.config|has space/.test(bytes), bytes?.slice(0, 300));
  const entries = catalog?.commands ?? [];
  const review = entries.find((e) => e.target === "command" && e.name === "review");
  const browser = entries.find((e) => e.target === "skill");
  const ranCommand = await settled(call(webEp, W.withDispatcher, "command", { target: review?.target, name: review?.name, args: "src/" }));
  const ranSkill = await settled(call(webEp, W.withDispatcher, "command", { target: browser?.target, name: browser?.name }));
  check("a listed command and a listed skill each run: ok, executed, and the reply data is {}",
    verdict(ranCommand) === "ok" && verdict(ranSkill) === "ok" && ranCommand.ok && same(ranCommand.value.data, {}), [verdict(ranCommand), verdict(ranSkill)]);
  check("the harness was asked to start exactly those two, under the listed names, args absent read as empty",
    same(coderHarness.ran, [{ target: "command", name: "review", args: "src/" }, { target: "skill", name: "browser", args: "" }]), coderHarness.ran);

  console.log("\nwho else may call");
  {
    const before = coderHarness.ran.length + coderHarness.lists;
    const sibling = await Promise.all(["commands", "command"].map((cmd) => settled(call(coder2Ep, W.withDispatcher, cmd, cmd === "command" ? { target: "command", name: "review" } : {}))));
    check("a sibling agent of the same owner: both commands are permission-denied, not-executed", sibling.every((r) => verdict(r) === "permission-denied/not-executed"), sibling.map(verdict));
    const coder2Raw = await seat(W.sibling);
    const siblingRaw = await Promise.all((["commands", "command"] as const).flatMap((cmd) => (["owner", "grant"] as const).map((word) => publishRefused(coder2Raw, W.withDispatcher, cmd, word))));
    check(`...and the broker refuses ${siblingRaw.filter(Boolean).length}/4 of its raw publishes, under owner and grant`, siblingRaw.every(Boolean));
    const foreign = await Promise.all(["commands", "command"].map((cmd) => settled(call(bobWebEp, W.withDispatcher, cmd, cmd === "command" ? { target: "command", name: "review" } : {}))));
    check("another owner's interactive session: permission-denied, not-executed", foreign.every((r) => verdict(r) === "permission-denied/not-executed"), foreign.map(verdict));
    check("the shipped grant builder makes rows for prompts and refuses commands and command", same(builderGrants, ["prompts"]), builderGrants);
    const granted = await settled(call(builderEp, W.withDispatcher, "prompts", {}, "grant"));
    const viaGrant = await Promise.all(["commands", "command"].map((cmd) => settled(call(builderEp, W.withDispatcher, cmd, cmd === "command" ? { target: "command", name: "review" } : {}, "grant"))));
    check("another owner's agent with a prompts grant reads prompts, and runs no command: permission-denied, not-executed",
      verdict(granted) === "ok" && viaGrant.every((r) => verdict(r) === "permission-denied/not-executed"), [verdict(granted), ...viaGrant.map(verdict)]);
    check("the harness heard nothing from any of them", coderHarness.ran.length + coderHarness.lists === before, coderHarness.ran);
  }

  console.log("\nan agent endpoint with no dispatcher");
  {
    const plainEp = await userEndpoint(W.noDispatcher);
    const plain = await openAgentEndpoint(plainEp, { warn: (m) => logs.push(`plain: ${m}`) });
    stops.push(() => plain.close());
    const list = await settled(call(webEp, W.noDispatcher, "commands"));
    check("commands answers { supported: false }", list.ok && list.value.ok && same(list.value.data, { supported: false }), list.ok ? list.value : verdict(list));
    const run = await settled(call(webEp, W.noDispatcher, "command", { target: "command", name: "review" }));
    check("command is unimplemented, not-executed", verdict(run) === "unimplemented/not-executed", verdict(run));
  }

  console.log("\nthe harness's answers, the queue bound and the 10 s bound");
  const laneEp = await userEndpoint(W.byHand, { registerPresence: true });
  let mode: "ok" | "unknown-name" | "refused" | "error" | "hang" = "ok";
  let laneList: () => Promise<unknown[]> = async () => structuredClone(LISTED);
  const laneHarness = fake({
    targets: ["command"],
    list: () => laneList(),
    dispatch: async () => {
      if (mode === "unknown-name") throw new CommandRefused("not-found", 'the harness has no command named "nope"');
      if (mode === "refused") throw new CommandRefused("failed-precondition", "the harness refused it: no session");
      if (mode === "error") throw new Error("socket hang up");
      if (mode === "hang") await new Promise(() => {});
    },
  });
  let queued = 0;
  const lane: AgentEndpoint = await openAgentEndpoint(laneEp, { warn: (m) => logs.push(`lane: ${m}`), dispatcher: laneHarness, onQueued: () => { queued++; } });
  stops.push(() => lane.close());
  async function runOne(args: Record<string, unknown>): Promise<string> {
    const reply = settled(call(webEp, W.byHand, "command", args));
    await until(() => lane.commands.queued > 0);
    await lane.commands.dispatchNext();
    return verdict(await reply);
  }
  {
    const before = laneHarness.ran.length;
    const skill = await settled(call(webEp, W.byHand, "command", { target: "skill", name: "browser" }));
    check("a target the dispatcher does not run is unimplemented, not-executed, and nothing is queued or started",
      verdict(skill) === "unimplemented/not-executed" && laneHarness.ran.length === before && queued === 0, [verdict(skill), queued]);
    mode = "unknown-name";
    const unknown = await runOne({ target: "command", name: "nope" });
    mode = "refused";
    const refused = await runOne({ target: "command", name: "review" });
    mode = "error";
    const failed = await runOne({ target: "command", name: "review" });
    check("the harness has no such command: not-found, not-executed", unknown === "not-found/not-executed", unknown);
    check("the harness refused it before it started: failed-precondition, not-executed", refused === "failed-precondition/not-executed", refused);
    check("the harness failed and cannot say how far it got: internal, unknown", failed === "internal/unknown", failed);
    laneList = async () => { throw new Error("skill index unavailable"); };
    const down = await settled(call(webEp, W.byHand, "commands"));
    check("a failed list is unavailable with the harness's reason, never an empty list",
      verdict(down) === "unavailable/not-executed" && down.ok && !down.value.ok && down.value.error.message.includes("skill index unavailable"), down.ok ? down.value : verdict(down));
    laneList = async () => [{ name: "browser", target: "skill" }];
    const stray = await settled(call(webEp, W.byHand, "commands"));
    check("a listed target the dispatcher does not run is the connector's fault: internal", verdict(stray).startsWith("internal/"), stray.ok ? stray.value : verdict(stray));
  }
  {
    mode = "hang";
    const started = settled(call(webEp, W.byHand, "command", { target: "command", name: "slow" }));
    await until(() => lane.commands.queued === 1);
    void lane.commands.dispatchNext();
    const t0 = Date.now();
    const waiting = Array.from({ length: MAX_QUEUED_COMMANDS }, (_, i) => settled(call(webEp, W.byHand, "command", { target: "command", name: `wait-${i}` })));
    await until(() => lane.commands.queued === MAX_QUEUED_COMMANDS);
    const over = await settled(call(webEp, W.byHand, "command", { target: "command", name: "one-too-many" }));
    check(`with ${MAX_QUEUED_COMMANDS} waiting, one more is resource-exhausted, not-executed, at once`,
      verdict(over) === "resource-exhausted/not-executed" && Date.now() - t0 < COMMAND_REPLY_MS - 2000, [verdict(over), lane.commands.queued]);
    const late = await Promise.all(waiting);
    const slow = await started;
    const took = Date.now() - t0;
    check(`the ${MAX_QUEUED_COMMANDS} still waiting for a turn at the 10 s bound did not start: unavailable, not-executed, and they leave the queue`,
      late.every((r) => verdict(r) === "unavailable/not-executed") && lane.commands.queued === 0, late.map(verdict));
    check("the one being started when the bound passed has an unknown outcome: deadline-exceeded, unknown, never a refusal that says it did not start",
      verdict(slow) === "deadline-exceeded/unknown" && slow.ok && took >= COMMAND_REPLY_MS - 1500 && took < WAIT - 1000, [verdict(slow), took]);
    check("none of the waiting ones reached the harness", !laneHarness.ran.some((c) => c.name.startsWith("wait-") || c.name === "one-too-many"), laneHarness.ran.map((c) => c.name));
  }
  {
    mode = "ok";
    const pending = [settled(call(webEp, W.byHand, "command", { target: "command", name: "a" })), settled(call(webEp, W.byHand, "command", { target: "command", name: "b" }))];
    await until(() => lane.commands.queued === 2);
    const t0 = Date.now();
    await lane.close();
    const after = await Promise.all(pending);
    check("closing the endpoint refuses each waiting command at once: unavailable, not-executed",
      after.every((r) => verdict(r) === "unavailable/not-executed") && Date.now() - t0 < 3000, after.map(verdict));
  }

  console.log("\na MeshAgent on a per-user mesh");
  const servedBy = (w: Who) => until(() => webEp.getRoster().find((p: Presence) => p.card.id === `${w.owner}.${w.actor}`)?.prompts !== undefined, 10_000);
  {
    const harness = fake();
    const agent = new MeshAgent(meshConfig(W.meshWithDispatcher), {}, { commands: harness });
    agent.on("error", () => {});
    agent.on("command", () => void agent.dispatchNextCommand());
    stops.push(() => agent.stop());
    await agent.start();
    check("a MeshAgent with a dispatcher serves its agent endpoint once it joined: presence shows the prompts field", await servedBy(W.meshWithDispatcher));
    const list = await settled(call(webEp, W.meshWithDispatcher, "commands"));
    const run = await settled(call(webEp, W.meshWithDispatcher, "command", { target: "skill", name: "browser", args: "open the docs" }));
    check(`its commands answer the same ${EXPECTED.length} entries, and a listed skill runs through dispatchNextCommand`,
      list.ok && list.value.ok && same(list.value.data, { supported: true, commands: EXPECTED }) && verdict(run) === "ok"
      && same(harness.ran, [{ target: "skill", name: "browser", args: "open the docs" }]), { list: verdict(list), run: verdict(run), ran: harness.ran });
    agent.removeAllListeners("command");
    const pending = settled(call(webEp, W.meshWithDispatcher, "command", { target: "command", name: "review" }));
    await until(() => agent.queuedCommands === 1);
    await agent.stop();
    check("stopping the MeshAgent refuses its waiting command: unavailable, not-executed, and the harness never saw it",
      verdict(await pending) === "unavailable/not-executed" && harness.ran.length === 1, harness.ran);
  }
  {
    const plain = new MeshAgent(meshConfig(W.meshNoDispatcher), {});
    plain.on("error", () => {});
    stops.push(() => plain.stop());
    await plain.start();
    await servedBy(W.meshNoDispatcher);
    const list = await settled(call(webEp, W.meshNoDispatcher, "commands"));
    const run = await settled(call(webEp, W.meshNoDispatcher, "command", { target: "command", name: "review" }));
    check("a MeshAgent with no dispatcher answers { supported: false } and refuses command unimplemented, not-executed",
      list.ok && list.value.ok && same(list.value.data, { supported: false }) && verdict(run) === "unimplemented/not-executed", [verdict(list), verdict(run)]);
    check("...and has nothing waiting to dispatch", plain.queuedCommands === 0 && await plain.dispatchNextCommand() === "empty");
  }

  {
    // The broker accepts the serve, and the agent's own confirmation is held while a command arrives.
    const harness = fake();
    const early = new MeshAgent(meshConfig(W.meshEarly), {}, { commands: harness });
    early.on("error", () => {});
    early.on("command", () => void early.dispatchNextCommand());
    stops.push(() => early.stop());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const serve = early.ep.servePrincipal.bind(early.ep);
    early.ep.servePrincipal = (s) => { const served = serve(s); return { ...served, ready: served.ready.then(() => held) }; };
    await early.start();
    await servedBy(W.meshEarly);
    const reply = settled(call(webEp, W.meshEarly, "command", { target: "command", name: "review" }));
    await until(() => harness.ran.length > 0, 1500);
    release();
    check("a command that arrives before the agent confirmed its serve runs once it did: ok, and the harness started it once",
      verdict(await reply) === "ok" && harness.ran.length === 1, harness.ran);
  }
  {
    const harness = fake({ dispatch: () => new Promise<void>(() => {}) });
    const stopping = new MeshAgent(meshConfig(W.meshStopping), {}, { commands: harness });
    stopping.on("error", () => {});
    stopping.on("command", () => void stopping.dispatchNextCommand());
    stops.push(() => stopping.stop());
    await stopping.start();
    await servedBy(W.meshStopping);
    let answeredAt = 0;
    const reply = settled(call(webEp, W.meshStopping, "command", { target: "command", name: "review" })).finally(() => { answeredAt = Date.now(); });
    await until(() => harness.ran.length === 1);
    const t0 = Date.now();
    await stopping.stop();
    const stopTook = Date.now() - t0;
    const stopped = verdict(await reply);
    check("stopping a MeshAgent while its harness is being asked to start a command answers that caller at once: unavailable, unknown, and stop() returns within 4 s",
      stopped === "unavailable/unknown" && answeredAt - t0 < 4000 && stopTook < 4000, { verdict: stopped, stopTook, answeredIn: answeredAt - t0 });
  }

  console.log("\nan open mesh");
  {
    const watcher = new CotalEndpoint({ space, servers: OPEN_SERVERS, lifecycleUid: mintLifecycleUid(), card: { actor: "watch", name: "watch", kind: "agent" }, channels: [], consume: false, watchChannels: false, registerPresence: false, watchPresence: true });
    watcher.on("error", () => {});
    stops.push(() => watcher.stop());
    await watcher.start();
    const harness = fake();
    // MeshAgent logs to stderr: an open mesh must add no line about an agent endpoint.
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (String(chunk).includes("agent endpoint")) said.push(String(chunk).trim());
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    const open = new MeshAgent({ space, servers: OPEN_SERVERS, name: "opencoder", id: "opencoder", kind: "agent", tls: false, lifecycleUid: mintLifecycleUid(), subscribe: [], allowSubscribe: [], allowPublish: [] }, {}, { commands: harness });
    open.on("error", () => {});
    stops.push(() => open.stop());
    try {
      await open.start();
      const seen = await until(() => watcher.getRoster().some((p: Presence) => p.card.id === open.id), 8000);
      await wait(500);
      const presence = watcher.getRoster().find((p: Presence) => p.card.id === open.id);
      check("a MeshAgent with a dispatcher on an open mesh starts and connects as before, serves nothing, logs nothing about it, and its presence has no prompts field",
        open.connected && seen && presence !== undefined && presence.prompts === undefined && open.queuedCommands === 0 && said.length === 0, { prompts: presence?.prompts, said });
    } finally {
      process.stderr.write = write;
    }
  }

  check("no endpoint reported an error and no agent endpoint warned", errors.length === 0 && logs.length === 0, { errors, logs });
} catch (e) {
  check(`the suite threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  await calloutNc?.close().catch(() => {});
  for (const b of brokers) await killAndAwaitExit(b);
  for (const r of releases) r();
  rmSync(dir, { recursive: true, force: true });
}
finish();

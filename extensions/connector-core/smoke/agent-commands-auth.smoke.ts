/**
 * An agent's own commands and skills on its `agent` endpoint (SPEC 13.22), on a real nats-server
 * through the shipped auth callout. A fake dispatcher stands in for the harness: it lists what a
 * harness would hand over, junk included, and records every command it is asked to start.
 *
 * Covered: the owner's interactive session lists the exact entries and queues a command and a skill
 * under the names the list gave, each answered with an id at once and read as started once taken; the
 * broker refuses a sibling agent of the same owner, another owner's session and another owner's agent
 * that holds a prompts grant, on all four command commands; an endpoint with no dispatcher answers
 * `supported: false`, refuses `command` and knows no id. The queue: N commands get N distinct ids, it
 * holds 8 and refuses the ninth, a cancel before the agent takes a command makes room and the harness
 * never sees it, a retried cancel changes nothing, a queued command has no time bound, the oldest is
 * taken first, and a taken or started command is not cancelled. Each harness answer maps to its
 * state, a longer message is cut to 2048 characters, an id never issued is not-found, and an ended id
 * is forgotten after 32 later ones end; a failed list is an error, never an empty list; the reply
 * bytes carry no field a harness keeps; closing the lane refuses every queued command as unavailable
 * and leaves a taken one taken; closing the endpoint returns at once. A `MeshAgent` opens its endpoint
 * once it joined a per-user mesh, with or without a dispatcher, runs a command that arrived before
 * the broker confirmed its serve, never runs a command still queued when it stops, stops within 4 s
 * while its harness is being asked to start a command, and on an open mesh starts as before and
 * serves nothing.
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
  type CommandEntry, type CommandState, type CommandTarget, type EndpointReply, type EpPrincipal, type Presence,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver, type ValidatedUserToken } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openAgentEndpoint, type AgentEndpoint } from "../src/agent-endpoint.js";
import { CommandRefused, createCommandLane, type AgentCommand, type CommandDispatcher } from "../src/agent-commands.js";
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
const WAIT = 15_000;
/** SPEC 13.22: at most 8 commands are queued, and the agent remembers the last 32 to end. */
const QUEUE_BOUND = 8, ENDED_KEPT = 32;
const ID = /^[a-z2-7]{26}$/;
const label = (s: CommandState): string => ("code" in s ? `${s.kind}/${s.code}` : s.kind);

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
// makes for alice.coder out of prompts and the four command commands. It refuses the last four.
type Perm = { pub?: { allow?: string[] }; sub?: { allow?: string[] }; [k: string]: unknown };
const shipped = calloutPermissions(resolveAcl, async () => {});
const builderGrants: string[] = [];
const mintFor = async (t: ValidatedUserToken, connId: string, readerId: string): Promise<Record<string, unknown>> => {
  let p = (await shipped(t, connId, readerId)) as Perm;
  const uid = t.act.lifecycleUid!;
  if (uid === W.foreignGrantee.uid) {
    const pub: string[] = [], sub: string[] = [];
    for (const command of ["prompts", "commands", "command", "command-cancel", "command-state"]) {
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

  const queue = async (to: Who, args: Record<string, unknown>): Promise<{ verdict: string; id?: string; data?: unknown }> => {
    const r = await settled(call(webEp, to, "command", args));
    const data = r.ok && r.value.ok ? r.value.data : undefined;
    const id = (data as { id?: unknown } | undefined)?.id;
    return { verdict: verdict(r), ...(typeof id === "string" ? { id } : {}), data };
  };
  const readState = async (to: Who, id: string | undefined): Promise<{ label: string; state?: CommandState }> => {
    const r = await settled(call(webEp, to, "command-state", { id }));
    if (!r.ok || !r.value.ok) return { label: verdict(r) };
    const { state } = r.value.data as { state: CommandState };
    return { label: label(state), state };
  };
  const stateOf = async (to: Who, id: string | undefined): Promise<string> => (await readState(to, id)).label;
  const finalState = async (to: Who, id: string | undefined): Promise<string> => {
    let s = await stateOf(to, id);
    for (const end = Date.now() + 5000; (s === "queued" || s === "taken") && Date.now() < end; s = await stateOf(to, id)) await wait(20);
    return s;
  };
  const cancel = (to: Who, id: string | undefined) => settled(call(webEp, to, "command-cancel", { id }));
  const stateDetail = (r: Awaited<ReturnType<typeof cancel>>) => (r.ok && !r.value.ok ? r.value.error.details : undefined);

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
  const t0 = Date.now();
  const ranCommand = await queue(W.withDispatcher, { target: review?.target, name: review?.name, args: "src/" });
  const ranSkill = await queue(W.withDispatcher, { target: browser?.target, name: browser?.name });
  const acceptedIn = Date.now() - t0;
  check("a listed command and a listed skill are each accepted at once: ok, and the reply data is { id } with an id of the grammar",
    [ranCommand, ranSkill].every((r) => r.verdict === "ok" && same(Object.keys(r.data ?? {}), ["id"]) && ID.test(r.id ?? "")) && acceptedIn < 2000,
    { acceptedIn, command: ranCommand, skill: ranSkill });
  const ranStates = [await finalState(W.withDispatcher, ranCommand.id), await finalState(W.withDispatcher, ranSkill.id)];
  check("each reads started once the connector took it", same(ranStates, ["started", "started"]), ranStates);
  check("the harness was asked to start exactly those two, under the listed names, args absent read as empty",
    same(coderHarness.ran, [{ target: "command", name: "review", args: "src/" }, { target: "skill", name: "browser", args: "" }]), coderHarness.ran);

  console.log("\nwho else may call");
  {
    const before = coderHarness.ran.length + coderHarness.lists;
    const FOUR = ["commands", "command", "command-cancel", "command-state"] as const;
    const argsFor = (cmd: string): Record<string, unknown> => (cmd === "commands" ? {} : cmd === "command" ? { target: "command", name: "review" } : { id: ranCommand.id });
    const sibling = await Promise.all(FOUR.map((cmd) => settled(call(coder2Ep, W.withDispatcher, cmd, argsFor(cmd)))));
    check("a sibling agent of the same owner: commands, command, command-cancel and command-state are each permission-denied, not-executed",
      sibling.every((r) => verdict(r) === "permission-denied/not-executed"), sibling.map(verdict));
    const coder2Raw = await seat(W.sibling);
    const siblingRaw = await Promise.all(FOUR.flatMap((cmd) => (["owner", "grant"] as const).map((word) => publishRefused(coder2Raw, W.withDispatcher, cmd, word))));
    check(`...and the broker refuses ${siblingRaw.filter(Boolean).length}/${FOUR.length * 2} of its raw publishes, under owner and grant`, siblingRaw.every(Boolean));
    const foreign = await Promise.all(FOUR.map((cmd) => settled(call(bobWebEp, W.withDispatcher, cmd, argsFor(cmd)))));
    check("another owner's interactive session: permission-denied, not-executed, on all four", foreign.every((r) => verdict(r) === "permission-denied/not-executed"), foreign.map(verdict));
    check("the shipped grant builder makes rows for prompts and refuses the four command commands", same(builderGrants, ["prompts"]), builderGrants);
    const granted = await settled(call(builderEp, W.withDispatcher, "prompts", {}, "grant"));
    const viaGrant = await Promise.all(FOUR.map((cmd) => settled(call(builderEp, W.withDispatcher, cmd, argsFor(cmd), "grant"))));
    check("another owner's agent with a prompts grant reads prompts, and lists, runs, cancels and reads no command: permission-denied, not-executed",
      verdict(granted) === "ok" && viaGrant.every((r) => verdict(r) === "permission-denied/not-executed"), [verdict(granted), ...viaGrant.map(verdict)]);
    const still = await stateOf(W.withDispatcher, ranCommand.id);
    check("the harness heard nothing from any of them, and the command they named still reads started",
      coderHarness.ran.length + coderHarness.lists === before && still === "started", { ran: coderHarness.ran, still });
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
    const byId = await Promise.all(["command-cancel", "command-state"].map((cmd) => settled(call(webEp, W.noDispatcher, cmd, { id: "a".repeat(26) }))));
    check("command-cancel and command-state know no id: not-found, not-executed", byId.every((r) => verdict(r) === "not-found/not-executed"), byId.map(verdict));
  }

  console.log("\nthe queue: ids, the bound, cancel and taking");
  const laneEp = await userEndpoint(W.byHand, { registerPresence: true });
  let mode: "ok" | "unknown-name" | "refused" | "long" | "error" | "hold" = "ok";
  let held = Promise.resolve();
  let laneList: () => Promise<unknown[]> = async () => structuredClone(LISTED);
  const laneHarness = fake({
    targets: ["command"],
    list: () => laneList(),
    dispatch: async () => {
      if (mode === "unknown-name") throw new CommandRefused("not-found", 'the harness has no command named "nope"');
      if (mode === "refused") throw new CommandRefused("failed-precondition", "the harness refused it: no session");
      if (mode === "long") throw new CommandRefused("failed-precondition", "r".repeat(3000));
      if (mode === "error") throw new Error("socket hang up");
      if (mode === "hold") await held;
    },
  });
  let told = 0;
  const lane: AgentEndpoint = await openAgentEndpoint(laneEp, { warn: (m) => logs.push(`lane: ${m}`), dispatcher: laneHarness, onQueued: () => { told++; } });
  stops.push(() => lane.close());
  const names = () => laneHarness.ran.map((c) => c.name);
  {
    const before = laneHarness.ran.length;
    const skill = await settled(call(webEp, W.byHand, "command", { target: "skill", name: "browser" }));
    check("a target the dispatcher does not run is unimplemented, not-executed, and nothing is queued or started",
      verdict(skill) === "unimplemented/not-executed" && laneHarness.ran.length === before && told === 0, [verdict(skill), told]);
  }
  {
    const t0 = Date.now();
    const accepted: Awaited<ReturnType<typeof queue>>[] = [];
    for (let i = 0; i < QUEUE_BOUND; i++) accepted.push(await queue(W.byHand, { target: "command", name: `q-${i}` }));
    const took = Date.now() - t0;
    const ids = accepted.map((a) => a.id);
    const distinct = new Set(ids.filter((id) => ID.test(id ?? ""))).size;
    check(`${QUEUE_BOUND} commands are each answered at once with an id, ${distinct} distinct ids of the grammar`,
      accepted.every((a) => a.verdict === "ok") && distinct === QUEUE_BOUND && took < 3000, { took, accepted: accepted.map((a) => a.id ?? a.verdict) });
    const states = await Promise.all(ids.map((id) => stateOf(W.byHand, id)));
    check(`each reads queued, the connector was told ${QUEUE_BOUND} times, and the harness started none`,
      states.every((s) => s === "queued") && told === QUEUE_BOUND && lane.commands.queued === QUEUE_BOUND && laneHarness.ran.length === 0,
      { states, told, queued: lane.commands.queued, ran: names() });
    const over = await queue(W.byHand, { target: "command", name: "one-too-many" });
    check(`with ${QUEUE_BOUND} queued, one more is resource-exhausted, not-executed, at once`,
      over.verdict === "resource-exhausted/not-executed" && lane.commands.queued === QUEUE_BOUND, [over.verdict, lane.commands.queued]);
    const cancelled = await cancel(W.byHand, ids[3]);
    const retried = await cancel(W.byHand, ids[3]);
    const afterCancel = await stateOf(W.byHand, ids[3]);
    check("cancelling a queued command is ok with the state cancelled, a retried cancel is ok and changes nothing, and it leaves the queue",
      [cancelled, retried].every((r) => r.ok && r.value.ok && same(r.value.data, { state: { kind: "cancelled" } }))
      && afterCancel === "cancelled" && lane.commands.queued === QUEUE_BOUND - 1, [verdict(cancelled), verdict(retried), afterCancel, lane.commands.queued]);
    const room = await queue(W.byHand, { target: "command", name: "q-8" });
    check(`the cancel made room: one more is accepted, and ${QUEUE_BOUND} are queued again`,
      room.verdict === "ok" && ID.test(room.id ?? "") && lane.commands.queued === QUEUE_BOUND, [room.verdict, lane.commands.queued]);
    await wait(Math.max(0, t0 + 11_000 - Date.now()));
    const all = [...ids, room.id];
    const later = await Promise.all(all.map((id) => stateOf(W.byHand, id)));
    check("11 s after the first was queued, every queued command still reads queued: a queued command has no time bound",
      same(later, all.map((_, i) => (i === 3 ? "cancelled" : "queued"))), later);

    mode = "hold";
    let release!: () => void;
    held = new Promise<void>((resolve) => { release = resolve; });
    const taking = settled(lane.commands.dispatchNext());
    const whileTaken = await stateOf(W.byHand, ids[0]);
    check("the connector takes the oldest queued command first: it reads taken, and the harness was asked to start it",
      whileTaken === "taken" && same(names(), ["q-0"]), [whileTaken, names()]);
    const cancelTaken = await cancel(W.byHand, ids[0]);
    check("cancelling a taken command is conflict, not-executed, with the state taken in details",
      verdict(cancelTaken) === "conflict/not-executed" && same(stateDetail(cancelTaken), [{ kind: "ai.cotal.agent.command-state", state: { kind: "taken" } }]),
      [verdict(cancelTaken), stateDetail(cancelTaken)]);
    release();
    const firstTake = await taking;
    const tookFirst = firstTake.ok ? firstTake.value : `threw ${(firstTake.error as Error).message}`;
    const startedFirst = await stateOf(W.byHand, ids[0]);
    const cancelStarted = await cancel(W.byHand, ids[0]);
    check("once the harness accepted it, dispatchNext answers dispatched, it reads started, and cancelling it is conflict, not-executed, with the state started in details",
      tookFirst === "dispatched" && startedFirst === "started" && verdict(cancelStarted) === "conflict/not-executed"
      && same(stateDetail(cancelStarted), [{ kind: "ai.cotal.agent.command-state", state: { kind: "started" } }]),
      [tookFirst, startedFirst, verdict(cancelStarted), stateDetail(cancelStarted)]);
    mode = "ok";
    while (lane.commands.queued > 0) await lane.commands.dispatchNext();
    const ended = await Promise.all(all.map((id) => stateOf(W.byHand, id)));
    check(`the harness ran the ${QUEUE_BOUND} not cancelled, in the order they were queued, each reads started, and the cancelled one never reached it`,
      same(names(), ["q-0", "q-1", "q-2", "q-4", "q-5", "q-6", "q-7", "q-8"]) && same(ended, all.map((_, i) => (i === 3 ? "cancelled" : "started"))),
      { ran: names(), ended });
  }

  console.log("\nthe harness's answers, as states");
  {
    async function runOne(name: string): Promise<{ label: string; state?: CommandState }> {
      const q = await queue(W.byHand, { target: "command", name });
      await lane.commands.dispatchNext();
      return readState(W.byHand, q.id);
    }
    const message = (s?: CommandState) => (s && "message" in s ? s.message : "");
    mode = "unknown-name";
    const unknown = await runOne("nope");
    mode = "refused";
    const refusedOne = await runOne("review");
    mode = "long";
    const long = await runOne("review");
    mode = "error";
    const failed = await runOne("review");
    mode = "ok";
    check("the harness has no such command: refused, not-found, with the harness's message",
      unknown.label === "refused/not-found" && message(unknown.state) === 'the harness has no command named "nope"', unknown);
    check("the harness refused it before it started: refused, failed-precondition, with the harness's message",
      refusedOne.label === "refused/failed-precondition" && message(refusedOne.state) === "the harness refused it: no session", refusedOne);
    check("a 3000-character message is cut to 2048 characters, marking the cut",
      long.label === "refused/failed-precondition" && [...message(long.state)].length === 2048 && message(long.state).endsWith("…"), [long.label, [...message(long.state)].length]);
    check("the harness failed and cannot say how far it got: unknown, internal, with the harness's reason",
      failed.label === "unknown/internal" && message(failed.state).includes("socket hang up"), failed);
    const never = await Promise.all(["command-state", "command-cancel"].map((cmd) => settled(call(webEp, W.byHand, cmd, { id: "b".repeat(26) }))));
    check("an id the agent never issued is not-found, not-executed, for command-state and command-cancel", never.every((r) => verdict(r) === "not-found/not-executed"), never.map(verdict));
    laneList = async () => { throw new Error("skill index unavailable"); };
    const down = await settled(call(webEp, W.byHand, "commands"));
    check("a failed list is unavailable with the harness's reason, never an empty list",
      verdict(down) === "unavailable/not-executed" && down.ok && !down.value.ok && down.value.error.message.includes("skill index unavailable"), down.ok ? down.value : verdict(down));
    laneList = async () => [{ name: "browser", target: "skill" }];
    const stray = await settled(call(webEp, W.byHand, "commands"));
    check("a listed target the dispatcher does not run is the connector's fault: internal", verdict(stray).startsWith("internal/"), stray.ok ? stray.value : verdict(stray));
  }

  console.log("\nforgetting");
  {
    const endOne = async (name: string): Promise<string | undefined> => {
      const q = await queue(W.byHand, { target: "command", name });
      await cancel(W.byHand, q.id);
      return q.id;
    };
    const first = await endOne("forget-me");
    const later: (string | undefined)[] = [];
    for (let i = 0; i < ENDED_KEPT - 1; i++) later.push(await endOne(`later-${i}`));
    const kept = await stateOf(W.byHand, first);
    later.push(await endOne(`later-${ENDED_KEPT - 1}`));
    const forgotten = await Promise.all(["command-state", "command-cancel"].map((cmd) => settled(call(webEp, W.byHand, cmd, { id: first }))));
    const newest = await Promise.all(later.map((id) => stateOf(W.byHand, id)));
    check(`an ended command still reads cancelled after ${ENDED_KEPT - 1} later ones end`, kept === "cancelled", kept);
    check(`once ${ENDED_KEPT} later ones ended, its id is not-found, not-executed, for command-state and command-cancel, and those ${ENDED_KEPT} still read cancelled`,
      forgotten.every((r) => verdict(r) === "not-found/not-executed") && newest.length === ENDED_KEPT && newest.every((s) => s === "cancelled"),
      { forgotten: forgotten.map(verdict), newest: newest.filter((s) => s !== "cancelled") });
  }

  console.log("\nclosing");
  {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = fake({ dispatch: () => gate });
    let toldDirect = 0;
    const direct = createCommandLane(harness, () => { toldDirect++; });
    const handle = (command: string, args: Record<string, unknown>) => {
      const def = direct.handlers.find((h) => h.command === command);
      return settled(Promise.resolve().then(() => (def ? def.handler({ request: { args } } as never) : Promise.reject(new Error(`the lane has no ${command} handler`)))));
    };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await handle("command", { target: "command", name: `close-${i}` });
      ids.push(r.ok ? String((r.value as { id?: unknown })?.id) : `refused: ${(r.error as Error).message}`);
    }
    const taking = settled(direct.dispatchNext());
    direct.close();
    const read = await Promise.all(ids.map((id) => handle("command-state", { id })));
    const stateAt = (i: number): CommandState | undefined => (read[i].ok ? (read[i].value as { state?: CommandState })?.state : undefined);
    check("closing the lane leaves the taken command taken and moves both queued ones to refused, unavailable, which command-state then reads",
      stateAt(0)?.kind === "taken" && [1, 2].every((i) => { const s = stateAt(i); return s?.kind === "refused" && s.code === "unavailable" && s.message !== ""; })
      && direct.queued === 0 && toldDirect === 3, { ids, states: [0, 1, 2].map(stateAt), queued: direct.queued });
    const late = await handle("command", { target: "command", name: "late" });
    // A lane that kept a queued command would take it here and wait on the gate, which opens only below.
    const left = await Promise.race([direct.dispatchNext(), wait(1000).then(() => "still taking")]);
    check("after close, command is unavailable, not-executed, and nothing is left to take",
      !late.ok && late.error instanceof EpEnvelopeError && late.error.code === "unavailable" && late.error.outcome === "not-executed" && left === "empty",
      [late.ok ? late.value : (late.error as Error).message, left]);
    release();
    const took = await taking;
    const finished = took.ok ? took.value : `threw ${(took.error as Error).message}`;
    const after = await handle("command-state", { id: ids[0] });
    check("the taken command's start still finishes after close: dispatched, it reads started, and the harness saw only that one",
      finished === "dispatched" && after.ok && same((after.value as { state?: CommandState })?.state, { kind: "started" }) && same(harness.ran.map((c) => c.name), ["close-0"]),
      [finished, after.ok ? after.value : (after.error as Error).message, harness.ran.map((c) => c.name)]);
  }
  {
    const pending = [await queue(W.byHand, { target: "command", name: "a" }), await queue(W.byHand, { target: "command", name: "b" })];
    const t0 = Date.now();
    await lane.close();
    const took = Date.now() - t0;
    const after = await Promise.all(pending.map((p) => stateOf(W.byHand, p.id)));
    check("closing the endpoint with commands queued returns at once, and then no one answers for them: unavailable, not-executed",
      pending.every((p) => p.verdict === "ok") && took < 3000 && after.every((s) => s === "unavailable/not-executed"), { pending: pending.map((p) => p.verdict), took, after });
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
    const run = await queue(W.meshWithDispatcher, { target: "skill", name: "browser", args: "open the docs" });
    const ran = await finalState(W.meshWithDispatcher, run.id);
    check(`its commands answer the same ${EXPECTED.length} entries, and a listed skill is accepted with an id and started through dispatchNextCommand`,
      list.ok && list.value.ok && same(list.value.data, { supported: true, commands: EXPECTED }) && run.verdict === "ok" && ran === "started"
      && same(harness.ran, [{ target: "skill", name: "browser", args: "open the docs" }]), { list: verdict(list), run: run.verdict, ran, harness: harness.ran });
    agent.removeAllListeners("command");
    const pending = await queue(W.meshWithDispatcher, { target: "command", name: "review" });
    const before = await stateOf(W.meshWithDispatcher, pending.id);
    await agent.stop();
    const taken = await agent.dispatchNextCommand();
    check("a command still queued when the MeshAgent stops never runs: it read queued, and after stop() nothing is left to dispatch and the harness never saw it",
      pending.verdict === "ok" && before === "queued" && agent.queuedCommands === 0 && taken === "empty" && harness.ran.length === 1,
      { pending: pending.verdict, before, taken, harness: harness.ran });
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
    const accepted = await queue(W.meshEarly, { target: "command", name: "review" });
    const whileHeld = await stateOf(W.meshEarly, accepted.id);
    const ranWhileHeld = harness.ran.length;
    release();
    const ran = await finalState(W.meshEarly, accepted.id);
    check("a command that arrives before the agent confirmed its serve is accepted at once and waits queued; once the agent confirmed, it runs: started, and the harness started it once",
      accepted.verdict === "ok" && whileHeld === "queued" && ranWhileHeld === 0 && ran === "started" && harness.ran.length === 1,
      { accepted: accepted.verdict, whileHeld, ranWhileHeld, ran, harness: harness.ran });
  }
  {
    const harness = fake({ dispatch: () => new Promise<void>(() => {}) });
    const stopping = new MeshAgent(meshConfig(W.meshStopping), {}, { commands: harness });
    stopping.on("error", () => {});
    stopping.on("command", () => void stopping.dispatchNextCommand());
    stops.push(() => stopping.stop());
    await stopping.start();
    await servedBy(W.meshStopping);
    const accepted = await queue(W.meshStopping, { target: "command", name: "review" });
    await until(() => harness.ran.length === 1);
    const whileStarting = await stateOf(W.meshStopping, accepted.id);
    const t0 = Date.now();
    await stopping.stop();
    const stopTook = Date.now() - t0;
    const afterStop = await stateOf(W.meshStopping, accepted.id);
    check("a command the harness is still being asked to start reads taken; stop() returns within 4 s, and then no one answers for it: unavailable, not-executed",
      accepted.verdict === "ok" && whileStarting === "taken" && stopTook < 4000 && afterStop === "unavailable/not-executed",
      { accepted: accepted.verdict, whileStarting, stopTook, afterStop });
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

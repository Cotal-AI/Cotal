/**
 * Agent commands, interrupt, the owner's turns and usage on OpenCode 1.x through the agent endpoint (SPEC 13.22): the real
 * plugin, booted in-process, against a fake OpenCode server and a JWT broker with the shipped auth
 * callout. The fake answers as opencode 1.19.6 was measured to: `GET /command` is one list of
 * commands and skills, each `{ name, source, description?, template, hints, subtask? }` with `source`
 * `command`, `mcp` or `skill`. `POST /session/:id/command` `{ command, arguments }` calls the
 * `command.execute.before` hook, makes the session busy and answers only once that turn ended. A
 * command OpenCode cannot run, such as one naming an agent it lacks, publishes a `session.error` and
 * answers a 500 before the hook. `POST /session/:id/abort` answers `true` whether or not a turn runs,
 * and a stopped turn ends with a `MessageAbortedError` and an idle. `POST /session/:id/prompt_async`
 * answers a 204 at once. `GET /session/:id/message` lists `{ info, parts }`, where an assistant's
 * `info` carries `cost`, `providerID` and `modelID` and each model step ends in a `step-finish` part
 * with its `tokens`. `GET /provider` lists each provider's models with their `limit`.
 *
 * Covered: presence says the agent serves interrupt, turns with images and usage. The owner's session lists the commands, the MCP
 * prompt as a command and the skills, with nothing else from OpenCode's entries, leaving out the
 * `/reconnect` the launch injects. A listed command runs under its name, and reads started once the
 * hook ran, with OpenCode's answer still owed. Commands sent while that turn runs are queued and one is
 * cancelled. After the command turn the waiting message goes first, carrying the persona, which the
 * command route cannot carry. Then the queued skill runs through the same route. `/reconnect`, an unknown command and an
 * unknown skill end refused and never reach OpenCode. A command OpenCode refuses before its prompt
 * ends refused, failed-precondition, and leaves the session free. A command whose shell snippets run
 * reads taken until its hook. With no turn running, `interrupt` answers idle and asks OpenCode
 * nothing; during a command's turn it aborts once, answers interrupted, and the command queued
 * behind it then runs. `usage` before any model step reports nothing. A turn goes out as one prompt, the
 * text and then each image as a file part with a data URL, and an image-only turn has no text part. A
 * 4xx answer ends it refused, failed-precondition. `usage` then reports the last step's input, cache
 * and output tokens of the model's input limit, and the sum of the assistant messages' cost, reading
 * the provider list once; a model the list has no window for leaves the context out. Listed newest
 * first, the step usage reports is still the newest message's. The broker refuses a sibling agent of
 * the same owner.
 *
 * Run: pnpm smoke:opencode1-command:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  AGENT_ENDPOINT, CotalEndpoint, EpEnvelopeError, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, processRuntime, provisionAgentDurables, serverConfig, setupSpaceStreams,
  type CommandEntry, type CommandState, type EndpointReply, type EpPrincipal, type Presence,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { opencodeConnector } from "../src/extension.js";
import { bootPlugin, disposeInProcess } from "./_boot-plugin.js";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, ms = 8000): Promise<boolean> => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) if (read()) return true;
  return read();
};
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error }; }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const WAIT = 15_000;
const label = (s: CommandState): string => ("code" in s ? `${s.kind}/${s.code}` : s.kind);
const message = (s?: CommandState): string => (s && "message" in s ? s.message : "");

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `oc1cmd-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const A = deriveOwnerToken("s".repeat(32), "better-auth|alice");
interface Who { owner: string; actor: string; kind: "interactive" | "managed-agent"; uid: string }
const who = (actor: string, kind: Who["kind"]): Who => ({ owner: A, actor, kind, uid: mintLifecycleUid() });
const W = { cody: who("cody", "managed-agent"), web: who("web", "interactive"), sibling: who("sibling", "managed-agent") };
const ledger = new Map(Object.values(W).map((w) => [w.uid, w]));
const resolveAcl: AclResolver = (t) => {
  const w = ledger.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: [], kind: w.kind };
};
async function bearer(w: Who): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: w.owner, ver: USER_TOKEN_VER, act: { owner: w.owner, actor: w.actor, scope: [], lifecycleUid: w.uid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(w.owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780)
    .sign(privateKey as CryptoKey);
}

const SID = "ses_commands1";
interface Listed { name: string; source: "command" | "mcp" | "skill"; description?: string; agent?: string; template: string; hints: string[]; subtask?: boolean | null }
const LIST: Listed[] = [
  { name: "init", source: "command", description: "guided AGENTS.md setup", template: "Set up AGENTS.md in /work", hints: ["$ARGUMENTS"] },
  { name: "review", source: "command", description: "review changes [commit|branch|pr], defaults to uncommitted", template: "Review $ARGUMENTS", hints: ["$ARGUMENTS"], subtask: true },
  { name: "docs", source: "mcp", template: "MCP-PROMPT-BODY", hints: [] },
  { name: "lonely", source: "command", description: "runs as an agent OpenCode lacks", agent: "missing", template: "x", hints: [] },
  { name: "humanizer", source: "skill", description: "Rewrite AI-sounding text", template: "SKILL-BODY", hints: [] },
];
// The commands the connector's own launch adds through OPENCODE_CONFIG_CONTENT, which OpenCode then
// lists beside its own (measured on 1.19.6): `/reconnect` today.
const launch = opencodeConnector.buildLaunch({ space: "launch-config", name: "cody", events: false });
for (const a of launch.artifacts ?? []) rmSync(a, { recursive: true, force: true });
const INJECTED = Object.entries((JSON.parse(launch.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as { command?: Record<string, { description?: string; template: string }> }).command ?? {})
  .map(([name, c]): Listed => ({ name, source: "command", description: c.description, template: c.template, hints: [], subtask: null }));
LIST.push(...INJECTED);
const PERSONA = "You are Cody, a careful reviewer who explains every finding.";

let hooks: Awaited<ReturnType<typeof bootPlugin>> | undefined;
const fire = (type: string, properties: Record<string, unknown> = {}) => hooks!.event!({ event: { type, properties: { sessionID: SID, ...properties } } } as never);
let snippetsMs = 0;
let refuseTurn = false;
let messages: unknown[] = [];
const providers = { all: [{ id: "opencode", models: { "m1": { id: "m1", limit: { context: 200000, input: 160000, output: 32000 } }, "m2": { id: "m2" }, "m3": { id: "m3", limit: { context: 262144, output: 65536 } } } }], default: {}, connected: ["opencode"] };
let held: (() => void) | undefined; // answers the POST of the command whose turn runs, ending that turn
const calls: string[] = [];
const bodies: Record<string, unknown>[] = [];
const unexpected: string[] = [];
const basic = `Basic ${Buffer.from("opencode:smoke-secret").toString("base64")}`;
const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
/** End the running turn as OpenCode does: its events go out back to back, and the bus does not wait
 *  for a handler before it calls the next. */
const endTurn = async (error?: unknown) => {
  if (error) void fire("session.error", { error });
  void fire("session.status", { status: { type: "idle" } });
  void fire("session.idle");
  const answer = held;
  held = undefined;
  answer?.();
  await sleep(300);
};
async function runCommand(res: ServerResponse, body: { command?: string; arguments?: string }): Promise<void> {
  const entry = LIST.find((e) => e.name === body.command);
  if (!entry || entry.agent) {
    const why = entry ? `Agent not found: "${entry.agent}".` : `Command not found: "${body.command}".`;
    void fire("session.error", { error: { name: "UnknownError", data: { message: why } } });
    return json(res, 500, { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details." } });
  }
  if (snippetsMs) await sleep(snippetsMs);
  await hooks!["command.execute.before"]!({ command: entry.name, sessionID: SID, arguments: body.arguments ?? "" }, { parts: [] });
  await fire("session.status", { status: { type: "busy" } });
  held = () => json(res, 200, { info: { id: `msg_${calls.length}`, role: "assistant", sessionID: SID }, parts: [] });
}
const oc = createServer((req, res) => {
  if (req.headers.authorization !== basic) return void res.writeHead(401).end();
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session") return json(res, 200, { id: SID });
    if (req.method === "GET" && req.url === "/command") return json(res, 200, LIST);
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    if (req.method === "POST" && req.url === `/session/${SID}/command`) {
      calls.push(`command ${String(body.command)}`);
      bodies.push(body);
      return void runCommand(res, body);
    }
    if (req.method === "POST" && req.url === `/session/${SID}/prompt_async`) {
      calls.push("prompt");
      bodies.push(body);
      if (refuseTurn) return json(res, 400, { name: "BadRequest", data: { message: "invalid prompt" } });
      return void res.writeHead(204).end();
    }
    if (req.method === "GET" && req.url === `/session/${SID}/message`) return json(res, 200, messages);
    if (req.method === "GET" && req.url === "/provider") {
      calls.push("provider");
      return json(res, 200, providers);
    }
    if (req.method === "POST" && req.url === `/session/${SID}/abort`) {
      calls.push("abort");
      json(res, 200, true);
      if (held) void endTurn({ name: "MessageAbortedError", data: { message: "The operation was aborted." } });
      return;
    }
    unexpected.push(`${req.method} ${req.url}`);
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");

const stops: Array<() => Promise<unknown>> = [];
const addressOf = (w: Who): EpPrincipal => ({ owner: w.owner, actor: w.actor, uid: w.uid, runtimeId: processRuntime(w.uid).id });
const verdict = (r: { ok: true; value: EndpointReply } | { ok: false; error: unknown }): string =>
  r.ok ? (r.value.ok ? "ok" : `${r.value.error.code}/${r.value.error.outcome ?? "-"}`)
    : r.error instanceof EpEnvelopeError ? `${r.error.code}/${r.error.outcome ?? "-"}` : `threw ${(r.error as Error).message}`;
/** A DM turn the plugin drove: it runs and ends as OpenCode reports one. */
const runAndEndTurn = async () => {
  await fire("session.status", { status: { type: "busy" } });
  await endTurn();
};

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  const provisioner = new CotalEndpoint({ space, servers, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {});
  stops.push(() => provisioner.stop());
  await provisioner.start();
  await provisionAgentDurables(provisioner, { owner: A, actor: "cody", lifecycleUid: W.cody.uid }, { durableMembership: false });
  const calloutNc = await connect({ servers, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  stops.push(() => calloutNc.close());
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: calloutPermissions(resolveAcl, async () => {}),
    log: () => {},
  });
  const user = async (w: Who, watchPresence = false) => {
    const ep = new CotalEndpoint({ space, servers, bearer: () => bearer(w), sentinelCreds: callout.sentinelCreds, lifecycleUid: w.uid,
      card: { owner: w.owner, actor: w.actor, name: w.actor, kind: "agent" }, channels: [], consume: false, watchChannels: false, registerPresence: false, watchPresence });
    ep.on("error", () => {});
    stops.push(() => ep.stop());
    await ep.start();
    return ep;
  };
  const webEp = await user(W.web, true);
  const siblingEp = await user(W.sibling);
  const call = (ep: CotalEndpoint, command: string, args: Record<string, unknown> = {}) =>
    settled(ep.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: addressOf(W.cody), command, authority: "owner", args, deadlineMs: WAIT }));
  const queue = async (args: Record<string, unknown>): Promise<{ verdict: string; id?: string }> => {
    const r = await call(webEp, "command", args);
    const id = r.ok && r.value.ok ? (r.value.data as { id?: unknown }).id : undefined;
    return { verdict: verdict(r), ...(typeof id === "string" ? { id } : {}) };
  };
  const readState = async (id: string | undefined): Promise<{ label: string; state?: CommandState }> => {
    const r = await call(webEp, "command-state", { id });
    if (!r.ok || !r.value.ok) return { label: verdict(r) };
    const { state } = r.value.data as { state: CommandState };
    return { label: label(state), state };
  };
  const settle = async (id: string | undefined, ms = 8000): Promise<{ label: string; state?: CommandState }> => {
    let s = await readState(id);
    for (const end = Date.now() + ms; (s.label === "queued" || s.label === "taken") && Date.now() < end; s = await readState(id)) await sleep(25);
    return s;
  };
  const run = async (args: Record<string, unknown>) => {
    const q = await queue(args);
    return { verdict: q.verdict, ...(await settle(q.id)) };
  };

  const bearerFile = join(dir, "bearer"), sentinelFile = join(dir, "sentinel.creds"), agentFile = join(dir, "cody.md");
  writeFileSync(bearerFile, await bearer(W.cody), { mode: 0o600 });
  writeFileSync(sentinelFile, callout.sentinelCreds, { mode: 0o600 });
  writeFileSync(agentFile, `---\nname: cody\nagent: opencode\n---\n\n${PERSONA}\n`);
  for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
  Object.assign(process.env, {
    COTAL_NAME: "cody", COTAL_ID: "cody", COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_LIFECYCLE_UID: W.cody.uid, COTAL_AGENT_FILE: agentFile,
    COTAL_OWNER: A, COTAL_ACTOR: "cody", COTAL_SENTINEL_CREDS: sentinelFile,
    COTAL_BEARER_CMD: JSON.stringify([process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", bearerFile]),
    COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${(oc.address() as { port: number }).port}`,
    OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "smoke-secret",
  });
  hooks = await bootPlugin();
  const row = () => webEp.getRoster().find((p: Presence) => p.card.id === `${A}.cody`);
  const served = await until(() => row()?.prompts !== undefined, 20_000);
  check("the plugin came online and serves its agent endpoint", served);
  await sleep(300);
  check("presence says it serves interrupt, the owner's turns with images, and usage", same(row()?.agentEndpoint, { interrupt: true, turn: true, images: true, usage: true }), row()?.agentEndpoint);

  const listed = await call(webEp, "commands");
  const catalog = listed.ok && listed.value.ok ? listed.value.data : verdict(listed);
  const expected: CommandEntry[] = [
    { name: "init", target: "command", description: "guided AGENTS.md setup" },
    { name: "review", target: "command", description: "review changes [commit|branch|pr], defaults to uncommitted" },
    { name: "docs", target: "command" },
    { name: "lonely", target: "command", description: "runs as an agent OpenCode lacks" },
    { name: "humanizer", target: "skill", description: "Rewrite AI-sounding text" },
  ];
  check(`commands lists OpenCode's commands, its MCP prompt as a command and its skill, by name only, leaving out the ${INJECTED.length} the launch injects (${INJECTED.map((c) => `/${c.name}`).join(", ")})`,
    INJECTED.length === 1 && same(catalog, { supported: true, commands: expected }), catalog);
  check("listing ran nothing", calls.length === 0, calls);

  const review = await queue({ target: "command", name: "review", args: "src/" });
  const reviewState = await settle(review.id);
  check("a listed command runs under its name and reads started once OpenCode's hook ran, with OpenCode's answer still owed",
    review.verdict === "ok" && reviewState.label === "started" && same(calls, ["command review"]) && same(bodies[0], { command: "review", arguments: "src/" }) && held !== undefined,
    [review.verdict, reviewState.label, calls, bodies[0]]);
  await webEp.unicast(`${A}.cody`, "hello from the inbox");
  const dropped = await queue({ target: "command", name: "init" });
  const queued = await queue({ target: "skill", name: "humanizer", args: "this text" });
  await sleep(700);
  const waiting = [(await readState(dropped.id)).label, (await readState(queued.id)).label];
  check("two commands sent while that turn runs are each accepted at once and read queued", dropped.verdict === "ok" && queued.verdict === "ok" && same(waiting, ["queued", "queued"]), [dropped.verdict, queued.verdict, waiting]);
  const cancelled = await call(webEp, "command-cancel", { id: dropped.id });
  check("the first is cancelled while the turn runs", cancelled.ok && cancelled.value.ok && same(cancelled.value.data, { state: { kind: "cancelled" } }), verdict(cancelled));
  check("while the command's turn runs, nothing else is sent", same(calls, ["command review"]), calls);
  await endTurn();
  await until(() => calls.length >= 2);
  const second = bodies[1] as { parts?: { text?: string }[]; system?: string } | undefined;
  check("after the command turn the waiting message goes first, and it carries the persona, which the command route cannot",
    calls[1] === "prompt" && JSON.stringify(second?.parts).includes("hello from the inbox") && typeof second?.system === "string" && second.system.startsWith(PERSONA), { calls, second });
  await runAndEndTurn();
  const skillState = await settle(queued.id);
  check("then the queued skill runs through the command route under its name, and the cancelled command never reached OpenCode",
    skillState.label === "started" && calls[2] === "command humanizer" && same(bodies[2], { command: "humanizer", arguments: "this text" }) && !calls.includes("command init"),
    [skillState.label, calls, bodies[2]]);
  await endTurn();

  const before = calls.length;
  const injected = await Promise.all(INJECTED.map((c) => run({ target: "command", name: c.name })));
  check("a command the launch injects, sent anyway, ends refused, failed-precondition",
    injected.every((r) => r.verdict === "ok" && r.label === "refused/failed-precondition" && message(r.state).includes("terminal")), injected);
  const unknownCommand = await run({ target: "command", name: "nope" });
  const unknownSkill = await run({ target: "skill", name: "nope" });
  const skillAsCommand = await run({ target: "command", name: "humanizer" });
  check("an unknown command, an unknown skill and a skill sent as a command each end refused, not-found",
    [unknownCommand, unknownSkill, skillAsCommand].every((r) => r.verdict === "ok" && r.label === "refused/not-found"), [unknownCommand, unknownSkill, skillAsCommand]);
  check("none of them reached OpenCode", calls.length === before, calls.slice(before));
  const lonely = await run({ target: "command", name: "lonely" });
  check("a command OpenCode refuses before its prompt ends refused, failed-precondition, after one POST",
    lonely.label === "refused/failed-precondition" && same(calls.slice(before), ["command lonely"]), [lonely.label, calls.slice(before)]);
  await webEp.unicast(`${A}.cody`, "after the refusal");
  const freed = await until(() => calls.length > before + 1, 7000);
  check("...and the session is free: a DM then reaches prompt_async", freed && calls[before + 1] === "prompt", calls.slice(before));
  await runAndEndTurn();

  snippetsMs = 1500;
  const slow = await queue({ target: "command", name: "init" });
  await sleep(800);
  const during = (await readState(slow.id)).label;
  const after = await settle(slow.id);
  check("a command whose shell snippets run reads taken until OpenCode's hook, then started", during === "taken" && after.label === "started", [during, after.label]);
  snippetsMs = 0;
  await endTurn();

  const beforeStop = calls.length;
  const idle = await call(webEp, "interrupt");
  check("with no turn running, interrupt answers idle and asks OpenCode nothing",
    idle.ok && idle.value.ok && same(idle.value.data, { state: "idle" }) && calls.length === beforeStop, [verdict(idle), calls.slice(beforeStop)]);
  const long = await run({ target: "command", name: "review" });
  const behind = await queue({ target: "command", name: "init" });
  await sleep(500);
  const stop = await call(webEp, "interrupt");
  const next = await settle(behind.id);
  check("during a command's turn, interrupt aborts once and answers interrupted, and the command queued behind it then runs",
    long.label === "started" && stop.ok && stop.value.ok && same(stop.value.data, { state: "interrupted" }) && next.label === "started"
    && same(calls.slice(beforeStop), ["command review", "abort", "command init"]),
    [long.label, verdict(stop), stop.ok && stop.value.ok ? stop.value.data : undefined, next.label, calls.slice(beforeStop)]);
  await endTurn();

  const usageOf = async () => {
    const r = await call(webEp, "usage");
    return r.ok && r.value.ok ? r.value.data : verdict(r);
  };
  check("usage before any model step reports nothing yet", same(await usageOf(), { supported: true }), await usageOf());
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const beforeTurn = calls.length;
  const turned = await call(webEp, "turn", { text: "What color is this?", images: [{ mimeType: "image/png", data: png }] });
  const turnId = turned.ok && turned.value.ok ? (turned.value.data as { id?: string }).id : undefined;
  const turnState = await settle(turnId);
  check("a turn reads started and goes out as one prompt: the text, then the image as a file part with a data URL",
    turnState.label === "started" && same(calls.slice(beforeTurn), ["prompt"])
    && same(bodies.at(-1), { parts: [{ type: "text", text: "What color is this?" }, { type: "file", mime: "image/png", url: `data:image/png;base64,${png}` }] }),
    [verdict(turned), turnState.label, calls.slice(beforeTurn), bodies.at(-1)]);
  await runAndEndTurn();
  const imageOnly = await call(webEp, "turn", { text: "", images: [{ mimeType: "image/png", data: png }] });
  const imageOnlyState = await settle(imageOnly.ok && imageOnly.value.ok ? (imageOnly.value.data as { id?: string }).id : undefined);
  check("an image-only turn carries no text part", imageOnlyState.label === "started" && same(bodies.at(-1), { parts: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${png}` }] }), [imageOnlyState.label, bodies.at(-1)]);
  await runAndEndTurn();
  refuseTurn = true;
  const refusedTurn = await call(webEp, "turn", { text: "refused" });
  const refusedState = await settle(refusedTurn.ok && refusedTurn.value.ok ? (refusedTurn.value.data as { id?: string }).id : undefined);
  refuseTurn = false;
  check("a turn OpenCode answers with a 4xx ends refused, failed-precondition", refusedState.label === "refused/failed-precondition", refusedState);
  const step = (input: number, output: number, read: number, write: number) => ({ type: "step-finish", reason: "stop", cost: 0, tokens: { total: input + output + read + write, input, output, reasoning: 7, cache: { read, write } } });
  messages = [
    { info: { role: "user", id: "msg_1" }, parts: [{ type: "text", text: "hi" }] },
    { info: { role: "assistant", id: "msg_2", providerID: "opencode", modelID: "m1", cost: 0.25 }, parts: [{ type: "step-start" }, step(900, 40, 0, 0)] },
    { info: { role: "assistant", id: "msg_3", providerID: "opencode", modelID: "m1", cost: 0.5 }, parts: [{ type: "step-start" }, step(500, 20, 100, 0), { type: "step-start" }, step(1000, 50, 3000, 200)] },
  ];
  const providerReads = calls.filter((c) => c === "provider").length;
  const reported = await usageOf();
  const again = await usageOf();
  check("usage reports the last step's input, cache and output tokens of the model's input limit, and the summed cost, reading the provider list once",
    same(reported, { supported: true, context: { used: 4250, size: 160000 }, cost: { amount: 0.75, currency: "USD" } }) && same(again, reported)
    && calls.filter((c) => c === "provider").length === providerReads + 1, { reported, again, providerReads: calls.filter((c) => c === "provider").length - providerReads });
  (messages[2] as { info: { modelID: string } }).info.modelID = "m2";
  check("a model the provider list gives no window leaves the context out", same(await usageOf(), { supported: true, cost: { amount: 0.75, currency: "USD" } }), await usageOf());
  (messages[2] as { info: { modelID: string } }).info.modelID = "m3";
  check("a model with no input limit is measured against its context limit", same(await usageOf(), { supported: true, context: { used: 4250, size: 262144 }, cost: { amount: 0.75, currency: "USD" } }), await usageOf());
  messages = [
    { info: { role: "assistant", id: "msg_3", providerID: "opencode", modelID: "m1", cost: 0.5 }, parts: [{ type: "step-start" }, step(500, 20, 0, 0)] },
    { info: { role: "assistant", id: "msg_2", providerID: "opencode", modelID: "m1", cost: 0.25 }, parts: [{ type: "step-start" }, step(900, 40, 0, 0)] },
    { info: { role: "user", id: "msg_1" }, parts: [{ type: "text", text: "hi" }] },
  ];
  const newestFirst = await usageOf();
  check("usage takes the step of the newest message by id when OpenCode lists the messages newest first",
    same(newestFirst, { supported: true, context: { used: 520, size: 160000 }, cost: { amount: 0.75, currency: "USD" } }), newestFirst);

  const sibling = await call(siblingEp, "command", { target: "command", name: "review" });
  check("a sibling agent of the same owner: permission-denied, not-executed", verdict(sibling) === "permission-denied/not-executed", verdict(sibling));
  check("the server saw no request beyond its routes", unexpected.length === 0, unexpected);
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  held?.();
  await disposeInProcess(hooks).catch(() => {});
  for (const stop of stops.reverse()) await stop().catch(() => {});
  oc.closeAllConnections();
  oc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
process.exit(process.exitCode ?? 0);

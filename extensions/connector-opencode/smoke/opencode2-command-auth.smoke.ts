/**
 * Agent commands on OpenCode 2.x through the agent endpoint (SPEC 13.22): the real plugin, booted
 * in-process with a fake plugin context, against a fake OpenCode server and a JWT broker with the
 * shipped auth callout. The fake answers as opencode 2.2.5 was measured to: `GET /api/command` is
 * `{ location, data: [{ name, description? }] }`, `GET /api/skill` is `{ location, data: [{ id,
 * name, description?, path, content }] }` where a built-in skill's `id` differs from its `name`,
 * `POST /api/session/:id/command` is a 204 or a 404 `CommandNotFoundError`, and
 * `POST /api/session/:id/prompt` is a 200 or a 400 `InvalidRequestError` whose field is `skills`.
 * The first `GET` of each list answers only the built-ins, and `command.updated` and `skill.updated`
 * follow 200 ms after both first reads, as a fresh 2.2.5 loads a location's lists.
 *
 * Covered: the owner's session lists OpenCode's commands, then its skills by id, with no `path` or
 * `content` on the wire, and the first list is complete. `command` answers an id at once, and
 * `command-state` reads how far each command got. A listed command and a listed skill each run under
 * that name as an idle turn of their own; the first turn carries the persona's `system` field when
 * that turn is a command; a command sent while a turn runs is queued and can be cancelled, and after
 * that turn a waiting message goes before the next queued command, which then runs; an unknown name
 * ends `refused` with `not-found`, another 4xx `refused` with `failed-precondition` and a 5xx `unknown`
 * with `internal`; a failed list is `unavailable`, never an empty list; a command OpenCode accepts
 * without starting a turn reads `started` and frees the session 5 s after OpenCode answered, and that
 * bound never frees a later submission; a POST OpenCode answers only after 12 s reads `taken` past
 * 10 s, and `started` once OpenCode answered with the plugin still waiting, so the command runs; and
 * the broker refuses a sibling agent of the same owner.
 *
 * Run: pnpm smoke:opencode2-command:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  AGENT_CONTRACTS, AGENT_ENDPOINT, CotalEndpoint, EpEnvelopeError, createSpaceAuth, epPrincipalCallerReplyFilter,
  epPrincipalNoRespondersSubject, epPrincipalReplySubject, epPrincipalRequestSubject, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, processRuntime, provisionAgentDurables, serverConfig, setupSpaceStreams,
  type CommandEntry, type CommandState, type EndpointReply, type EpPrincipal, type Presence,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { bootPlugin2, fakeOpenCode2Context } from "./_boot-plugin.js";

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
const space = `oc2cmd-${randomUUID().slice(0, 8)}`;
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

const SID = "ses_commands";
const location = { directory: "/work/project" };
const COMMANDS = [
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
  { name: "goal", description: "set, show or clear the session goal" },
  { name: "has space" },
  { name: "sub/nested", description: "a nested command" },
];
const SKILLS = [
  { id: "opencode", name: "OpenCode", description: "Use this skill for any question about OpenCode itself.", path: "/builtin/opencode.md", content: "SKILL-BODY-OPENCODE" },
  { id: "demo-skill", name: "demo-skill", description: "A demo skill", autoinvoke: true, path: "/home/someone/.config/opencode/skill/demo-skill/SKILL.md", content: "SKILL-BODY-DEMO" },
];
const BUILT_IN = new Set(["init", "review", "goal", "opencode"]);
const unread = new Set(["/api/command", "/api/skill"]);
function answerList<T extends { name: string; id?: string }>(url: string, all: T[]): T[] {
  if (!unread.delete(url)) return all;
  if (unread.size === 0) setTimeout(() => { for (const type of ["command.updated", "skill.updated"]) ctx.feed({ type, data: {} }); }, 200);
  return all.filter((e) => BUILT_IN.has(e.id ?? e.name));
}
const PERSONA = "You are Cody, a careful reviewer who explains every finding.";
let mode: "ok" | "bad-text" | "crash" | "stall" = "ok";
let slow: { answered: boolean; clientLeft: boolean } | undefined;
let failSkills = false;
const calls: string[] = [];
const bodies: Record<string, unknown>[] = [];
const unexpected: string[] = [];
const basic = `Basic ${Buffer.from("opencode:smoke-secret").toString("base64")}`;
const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const oc = createServer((req, res) => {
  if (req.headers.authorization !== basic) return void res.writeHead(401).end();
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/api/session") return json(res, 200, { data: { id: SID } });
    if (req.method === "GET" && req.url === "/api/command") return json(res, 200, { location, data: answerList(req.url, COMMANDS) });
    if (req.method === "GET" && req.url === "/api/skill") {
      if (failSkills) return json(res, 500, { _tag: "UnknownError", message: "skill index unavailable" });
      return json(res, 200, { location, data: answerList(req.url, SKILLS) });
    }
    const body = (raw ? JSON.parse(raw) : {}) as { name?: string; text?: string; skills?: { id: string }[] };
    if (req.method === "POST" && req.url === `/api/session/${SID}/command`) {
      calls.push(`command ${body.name}`);
      bodies.push(body);
      if (!COMMANDS.some((c) => c.name === body.name)) return json(res, 404, { _tag: "CommandNotFoundError", command: body.name, message: `Command not found: ${body.name}` });
      if (mode === "bad-text") return json(res, 400, { _tag: "InvalidRequestError", message: "text is too long", field: "text" });
      if (mode === "crash") return json(res, 500, { _tag: "CommandExecutionError", command: body.name, message: "the template failed" });
      if (mode === "stall") {
        const s = { answered: false, clientLeft: false };
        slow = s;
        res.on("close", () => { if (!res.writableFinished) s.clientLeft = true; });
        return void setTimeout(() => {
          if (s.clientLeft) return;
          res.writeHead(204).end();
          s.answered = true;
        }, 12_000);
      }
      return void res.writeHead(204).end();
    }
    if (req.method === "POST" && req.url === `/api/session/${SID}/prompt`) {
      const skill = body.skills?.[0]?.id;
      calls.push(skill === undefined ? "prompt" : `skill ${skill}`);
      bodies.push(body);
      if (skill !== undefined && !SKILLS.some((s) => s.id === skill)) return json(res, 400, { _tag: "InvalidRequestError", message: `Skill not found: ${skill}`, field: "skills" });
      return json(res, 200, { data: { id: `msg_${calls.length}`, sessionID: SID, type: "user" } });
    }
    unexpected.push(`${req.method} ${req.url}`);
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");

const stops: Array<() => Promise<unknown>> = [];
const ctx = fakeOpenCode2Context();
let dispose: (() => Promise<void>) | void = undefined;
let seq = 0;
const feed = (type: string) => ctx.feed({ type, durable: { aggregateID: SID, seq: ++seq }, data: { sessionID: SID } } as never);
const runAndEndTurn = async () => { feed("session.execution.started"); feed("session.execution.succeeded"); await sleep(300); };
const addressOf = (w: Who): EpPrincipal => ({ owner: w.owner, actor: w.actor, uid: w.uid, runtimeId: processRuntime(w.uid).id });
const verdict = (r: { ok: true; value: EndpointReply } | { ok: false; error: unknown }): string =>
  r.ok ? (r.value.ok ? "ok" : `${r.value.error.code}/${r.value.error.outcome ?? "-"}`)
    : r.error instanceof EpEnvelopeError ? `${r.error.code}/${r.error.outcome ?? "-"}` : `threw ${(r.error as Error).message}`;

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
  // `at` stands in for when OpenCode answered: the cells that check its 5 s bound measure from it.
  const settle = async (id: string | undefined, ms = 8000): Promise<{ label: string; state?: CommandState; at: number }> => {
    let s = await readState(id);
    for (const end = Date.now() + ms; (s.label === "queued" || s.label === "taken") && Date.now() < end; s = await readState(id)) await sleep(25);
    return { ...s, at: Date.now() };
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
  dispose = await bootPlugin2(ctx);
  const served = await until(() => webEp.getRoster().some((p: Presence) => p.card.id === `${A}.cody` && p.prompts !== undefined), 20_000);
  check("the plugin came online and serves its agent endpoint", served);
  await sleep(300);

  const listStart = Date.now();
  const listed = await call(webEp, "commands");
  const listTook = Date.now() - listStart;
  const catalog = listed.ok && listed.value.ok ? (listed.value.data as { supported: true; commands: CommandEntry[] }) : undefined;
  const expected: CommandEntry[] = [
    { name: "init", target: "command", description: "guided AGENTS.md setup" },
    { name: "review", target: "command", description: "review changes [commit|branch|pr], defaults to uncommitted" },
    { name: "goal", target: "command", description: "set, show or clear the session goal" },
    { name: "sub/nested", target: "command", description: "a nested command" },
    { name: "opencode", target: "skill", description: "Use this skill for any question about OpenCode itself." },
    { name: "demo-skill", target: "skill", description: "A demo skill" },
  ];
  check("the first commands reply waits for OpenCode's load events, under 2 s, and lists its 4 nameable commands, then its 2 skills by id",
    same(catalog, { supported: true, commands: expected }) && listTook < 2000, { listTook, catalog: catalog ?? verdict(listed) });
  const n = `ibx${randomUUID().replace(/-/g, "")}`;
  const raw = await connect({ servers, name: n, inboxPrefix: `_INBOX_${n}`, maxReconnectAttempts: 0, authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await bearer(W.web))] });
  stops.push(() => raw.close());
  const caller = { owner: A, actor: "web", uid: W.web.uid }, nonce = randomBytes(24).toString("base64url");
  const replyTo = epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: addressOf(W.cody), caller, nonce });
  const bytes = new Promise<string>((resolve) => {
    const sub = raw.subscribe(epPrincipalCallerReplyFilter(space, caller, nonce), { callback: (_e, m) => { if (m.subject === replyTo) { sub.unsubscribe(); resolve(new TextDecoder().decode(m.data)); } } });
  });
  raw.publish(epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal: addressOf(W.cody), command: "commands", authority: "owner", caller, nonce }),
    enc(JSON.stringify({ v: 1, id: "raw-list", op: { endpoint: AGENT_ENDPOINT, command: "commands", inputDigest: AGENT_CONTRACTS.commands.input.closureDigest, outputDigest: AGENT_CONTRACTS.commands.output.closureDigest },
      class: "ephemeral", replyExpected: true, deadlineMs: WAIT, args: {}, from: { id: `${A}.web`, name: "web" } })), { reply: epPrincipalNoRespondersSubject(space, caller, nonce) });
  const wire = await Promise.race([bytes, sleep(WAIT).then(() => "")]);
  check("the reply bytes carry no path, content, autoinvoke, location or display name of a built-in skill",
    wire.includes('"supported":true') && !/"path"|"content"|"autoinvoke"|"location"|SKILL-BODY|\/builtin\/|\.config|"OpenCode"|has space/.test(wire), wire.slice(0, 300));
  check("listing ran nothing", calls.length === 0, calls);

  const review = catalog?.commands?.find((e) => e.target === "command" && e.name === "review");
  const skill = catalog?.commands?.find((e) => e.target === "skill");
  const ran = await run({ target: review?.target, name: review?.name, args: "src/" });
  check("a listed command is accepted and runs under the listed name: it reads started, and OpenCode got POST /command",
    ran.verdict === "ok" && ran.label === "started" && same(calls, ["command review"]), [ran.verdict, ran.label, calls]);
  const first = bodies[0] as { name?: string; text?: string; system?: string } | undefined;
  check("the first turn is that command, and it carries the persona", first?.name === "review" && first.text === "src/" && typeof first.system === "string" && first.system.startsWith(PERSONA), first);
  feed("session.execution.started");
  await webEp.unicast(`${A}.cody`, "hello from the inbox");
  const dropped = await queue({ target: "command", name: "init" });
  const queued = await queue({ target: skill?.target, name: skill?.name });
  await sleep(700);
  const waiting = [(await readState(dropped.id)).label, (await readState(queued.id)).label];
  check("two commands sent while a turn runs are each accepted at once and read queued",
    dropped.verdict === "ok" && queued.verdict === "ok" && same(waiting, ["queued", "queued"]), [dropped.verdict, queued.verdict, waiting]);
  const cancelled = await call(webEp, "command-cancel", { id: dropped.id });
  const afterCancel = (await readState(dropped.id)).label;
  check("the first is cancelled while the turn runs: ok, and it reads cancelled",
    cancelled.ok && cancelled.value.ok && same(cancelled.value.data, { state: { kind: "cancelled" } }) && afterCancel === "cancelled", [verdict(cancelled), afterCancel]);
  check("while the command's turn runs, nothing else is sent", same(calls, ["command review"]), calls);
  feed("session.execution.succeeded");
  await until(() => calls.length >= 2);
  const second = bodies[1] as { text?: string; system?: string } | undefined;
  check("after the command turn, the waiting message goes first, and the persona does not ride again",
    calls[1] === "prompt" && typeof second?.text === "string" && second.text.includes("hello from the inbox") && second.system === undefined, { calls, second });
  await runAndEndTurn();
  const skillState = await settle(queued.id);
  check("then the second queued command, the skill, runs under its listed id as a turn of its own: it reads started, and the cancelled one never reached OpenCode",
    skillState.label === "started" && calls[2] === "skill opencode" && same(bodies[2], { text: "", skills: [{ id: "opencode" }] }) && !calls.includes("command init"),
    [skillState.label, calls, bodies[2]]);
  await runAndEndTurn();

  const before = calls.length;
  const unknownCommand = await run({ target: "command", name: "nope" });
  const unknownSkill = await run({ target: "skill", name: "nope" });
  check("an unknown command and an unknown skill are each accepted and end refused, not-found",
    [unknownCommand, unknownSkill].every((r) => r.verdict === "ok" && r.label === "refused/not-found"), [unknownCommand, unknownSkill]);
  mode = "bad-text";
  const badText = await run({ target: "command", name: "review", args: "x" });
  mode = "crash";
  const crash = await run({ target: "command", name: "review" });
  check("another 4xx ends refused, failed-precondition, with OpenCode's message", badText.label === "refused/failed-precondition" && message(badText.state).includes("text is too long"), badText);
  check("a 5xx ends unknown, internal", crash.label === "unknown/internal", crash);
  check("each went to OpenCode once, and none left a turn holding the session", same(calls.slice(before), ["command nope", "skill nope", "command review", "command review"]), calls.slice(before));
  mode = "ok";
  failSkills = true;
  const down = await call(webEp, "commands");
  check("a failed list is unavailable with OpenCode's status and body, never an empty list",
    verdict(down) === "unavailable/not-executed" && down.ok && !down.value.ok && down.value.error.message.includes("OpenCode HTTP 500") && down.value.error.message.includes("skill index unavailable"),
    down.ok ? down.value : verdict(down));
  failSkills = false;

  const sibling = await call(siblingEp, "command", { target: "command", name: "review" });
  check("a sibling agent of the same owner: permission-denied, not-executed, and OpenCode heard nothing",
    verdict(sibling) === "permission-denied/not-executed" && calls.length === before + 4, [verdict(sibling), calls.length - before]);

  const goal = await run({ target: "command", name: "goal", args: "clear" });
  const acceptedAt = goal.at;
  check("a command OpenCode accepts without starting a turn, as 2.2.5 does goal clear: it reads started", goal.label === "started" && calls.at(-1) === "command goal", [goal.label, calls.at(-1)]);
  const beforeDm = calls.length;
  await webEp.unicast(`${A}.cody`, "after the goal");
  const freed = await until(() => calls.length > beforeDm, 7000);
  const freedAfter = Date.now() - acceptedAt;
  check("with no execution started 5 s after OpenCode answered, the session is free: a DM then reaches POST /prompt",
    freed && calls[beforeDm] === "prompt" && String((bodies[beforeDm] as { text?: string }).text).includes("after the goal") && freedAfter >= 4500,
    { calls: calls.slice(beforeDm), freedAfter });
  await runAndEndTurn();
  const next = await run({ target: "command", name: "review" });
  const nextAt = next.at;
  check("...and the next command runs: it reads started", next.label === "started" && calls.at(-1) === "command review", [next.label, calls.at(-1)]);
  await runAndEndTurn();
  const held = calls.length;
  await webEp.unicast(`${A}.cody`, "second message");
  await until(() => calls.length > held);
  await webEp.unicast(`${A}.cody`, "third message");
  await sleep(Math.max(0, nextAt + 6500 - Date.now()));
  check("the last command's 5 s bound frees no later submission: a DM waits while the DM before it has not started its turn",
    same(calls.slice(held), ["prompt"]), calls.slice(held));
  await runAndEndTurn();
  await until(() => calls.length > held + 1);
  await runAndEndTurn();

  mode = "stall";
  const beforeStall = calls.length;
  const t0 = Date.now();
  const stalled = await queue({ target: "command", name: "review" });
  const acceptedIn = Date.now() - t0;
  await sleep(Math.max(0, t0 + 10_500 - Date.now()));
  const at10 = (await readState(stalled.id)).label;
  check("a command whose POST OpenCode has not answered 10 s later was accepted at once and still reads taken: no bound ends it",
    stalled.verdict === "ok" && acceptedIn < 2000 && at10 === "taken" && calls.length === beforeStall + 1 && calls.at(-1) === "command review", [stalled.verdict, acceptedIn, at10]);
  const done = await settle(stalled.id, 5000);
  check("OpenCode answers that command at 12 s, once its template ran, with the plugin still waiting for the answer, so the command runs: it reads started",
    slow?.answered === true && !slow.clientLeft && done.label === "started", { slow, state: done.label });
  check("the server saw no request beyond its routes", unexpected.length === 0, unexpected);
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  ctx.end();
  await dispose?.().catch(() => {});
  for (const stop of stops.reverse()) await stop().catch(() => {});
  oc.closeAllConnections();
  oc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
process.exit(process.exitCode ?? 0);

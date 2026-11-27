/**
 * Codex skills through the agent endpoint (SPEC 13.22): the real Codex host, launched as a child,
 * on a JWT broker with the shipped auth callout. By default the host drives a fake app-server that
 * answers as codex-cli 0.170.0 was measured to (skill-command-app-server.mjs). With
 * `COTAL_CODEX_SKILLS_LIVE=1` it drives the installed `codex` instead, pointed at a local mock
 * Responses endpoint, so no login is needed and the cells check what reached the model.
 *
 * Covered: the owner's session lists Codex's enabled skills once each, by name and description, with
 * no path on the wire. A listed skill runs as a turn of its own that starts the skill: `turn/start`
 * carries `{ type: "skill", name, path }` with the listed path and the args as text, and live Codex
 * puts the SKILL.md body into the model request. An unknown or disabled skill ends `refused` with
 * `not-found` and starts no turn. A skill queued behind a turn that never ends stays queued until the
 * owner's `interrupt`, which answers `interrupted`; the stopped turn frees the thread and the skill
 * runs. With no turn running, `interrupt` answers `idle`, and so does one Codex refuses because the
 * turn ended while it was on its way (fake only). The owner's `turn` runs their words, and a PNG
 * they attach, as a turn of its own on the same thread: `turn/start` carries the text and the image as
 * a data URL, and live Codex puts both into the model request. `usage` answers no context until
 * Codex reports token usage, then the last call's total tokens in the model's window. Presence says
 * the agent serves interrupt, turn, images, usage and set-model.
 *
 * `set-model` (fake only) reads every page of `model/list`, then sends `thread/settings/update` with
 * the model and effort, and answers them. The next turn runs on them, and its `turn/start` names
 * neither. Without a variant it sends the model's default effort, and without a model it keeps the
 * model the thread runs, the switched one. An unlisted model is `not-found` and an unlisted effort
 * `failed-precondition`, both before Codex is asked, and an update Codex refuses is
 * `failed-precondition`. After the app-server crashes, the host sends the switch to the restarted
 * thread before any `turn/start`, and the new thread's first turn runs on it.
 *
 * Run: pnpm smoke:codex-skill-command:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  AGENT_ENDPOINT, CotalEndpoint, EpEnvelopeError, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  provisionAgentDurables, serverConfig, setupSpaceStreams,
  type CommandEntry, type CommandState, type EndpointReply, type EpPrincipal, type Presence,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const live = /^(1|true|yes|on)$/i.test(process.env.COTAL_CODEX_SKILLS_LIVE ?? "");
const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, ms = 10_000): Promise<boolean> => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) if (read()) return true;
  return read();
};
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error }; }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const WAIT = 15_000;
const label = (s: CommandState): string => ("code" in s ? `${s.kind}/${s.code}` : s.kind);

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `codexcmd-${randomUUID().slice(0, 8)}`;
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
const W = { cody: who("cody", "managed-agent"), web: who("web", "interactive") };
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

// The agent's working directory, with one repo skill. Live, HOME points here too, so only this
// skill and Codex's own system skills are found.
const work = join(dir, "work");
const SKILL_BODY = "Reply with the single word PINEAPPLE.";
for (const name of ["smoke-echo", "smoke-off"]) {
  mkdirSync(join(work, ".agents/skills", name), { recursive: true });
  writeFileSync(join(work, ".agents/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name === "smoke-echo" ? "Reply with the word PINEAPPLE." : "A skill the user turned off."}\n---\n${SKILL_BODY}\n`);
}
const ECHO_PATH = join(work, ".agents/skills/smoke-echo/SKILL.md");
/** A 1×1 red PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

// What the harness was asked. Fake: the app-server journals each request, with a `turn/start`'s input
// and the model and effort it runs on. Live: the mock Responses endpoint records the last user text of
// each model request.
const fakeLog = join(dir, "fake.log.jsonl");
const modelTurns: string[] = [];
let usersSeen = 0;
interface FakeEntry {
  ev: string;
  method?: string;
  params?: Record<string, unknown>;
  input?: { type: string; name?: string; path?: string; text?: string }[];
  model?: string;
  effort?: string;
  runs?: { model: string; effort: string | null };
}
const fakeEntries = (): FakeEntry[] => existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeEntry) : [];
const fakeTurns = (): FakeEntry[] => fakeEntries().filter((e) => e.method === "turn/start");
const turnCount = () => (live ? modelTurns.length : fakeTurns().length);

const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (!req.url?.endsWith("/responses")) return void res.writeHead(404).end();
    const input = (JSON.parse(raw) as { input?: { type?: string; role?: string; content?: { text?: string; image_url?: string }[] }[] }).input ?? [];
    const users = input.filter((i) => i.type === "message" && i.role === "user").map((i) => (i.content ?? []).map((c) => c.text ?? (c.image_url ? `[image ${c.image_url.slice(0, 22)}]` : "")).join(""));
    // Each request carries the thread's whole history, so a turn's own input is the user messages
    // added since the previous request.
    const own = users.slice(usersSeen).join("\n");
    usersSeen = users.length;
    modelTurns.push(own);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("response.created", { response: { id: "resp" } });
    if (own.includes("HOLD-OPEN")) return; // never completes, so only an interrupt ends the turn
    ev("response.output_item.done", { item: { type: "message", role: "assistant", id: `msg_${modelTurns.length}`, content: [{ type: "output_text", text: own.includes(SKILL_BODY) ? "PINEAPPLE" : "OK" }] } });
    ev("response.completed", { response: { id: "resp", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
    res.end();
  });
});
mock.listen(0, "127.0.0.1");
await once(mock, "listening");

const stops: Array<() => Promise<unknown>> = [];
let host: ChildProcess | undefined;
const hostOut: string[] = [];
const verdict = (r: { ok: true; value: EndpointReply } | { ok: false; error: unknown }): string =>
  r.ok ? (r.value.ok ? "ok" : `${r.value.error.code}/${r.value.error.outcome ?? "-"}`)
    : r.error instanceof EpEnvelopeError ? `${r.error.code}/${r.error.outcome ?? "-"}` : `threw ${(r.error as Error).message}`;

function hostEnv(bearerFile: string, sentinelFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  Object.assign(env, {
    COTAL_NAME: "cody", COTAL_ID: "cody", COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_LIFECYCLE_UID: W.cody.uid,
    COTAL_OWNER: A, COTAL_ACTOR: "cody", COTAL_SENTINEL_CREDS: sentinelFile, COTAL_CODEX_HOME: dir, COTAL_CODEX_TUI: "0",
    COTAL_BEARER_CMD: JSON.stringify([process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", bearerFile]),
  });
  if (live) {
    const mockUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`;
    Object.assign(env, {
      HOME: work,
      COTAL_MODEL: "mock-model",
      COTAL_CODEX_CONFIG: JSON.stringify({
        model_provider: '"mock"',
        "model_providers.mock": `{ name = "mock", base_url = "${mockUrl}", wire_api = "responses", supports_websockets = false }`,
        "skills.config": `[{ path = "${join(work, ".agents/skills/smoke-off/SKILL.md")}", enabled = false }]`,
      }),
    });
    delete env.CODEX_HOME;
    delete env.OPENAI_API_KEY;
  } else {
    const bin = join(dir, "fake-codex");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "extensions/connector-codex/smoke/skill-command-app-server.mjs")}" "$@"\n`);
    chmodSync(bin, 0o755);
    Object.assign(env, { COTAL_CODEX_BIN: bin, FAKE_CODEX_LOG: fakeLog, COTAL_MODEL: "fake-model" });
  }
  return env;
}

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
  const webEp = new CotalEndpoint({ space, servers, bearer: () => bearer(W.web), sentinelCreds: callout.sentinelCreds, lifecycleUid: W.web.uid,
    card: { owner: A, actor: "web", name: "web", kind: "agent" }, channels: [], consume: false, watchChannels: false, registerPresence: false, watchPresence: true });
  webEp.on("error", () => {});
  stops.push(() => webEp.stop());
  await webEp.start();
  // The host is its own process, so its runtime id is the one its presence carries.
  let cody: EpPrincipal | undefined;
  const call = (command: string, args: Record<string, unknown> = {}) =>
    settled(webEp.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: cody!, command, authority: "owner", args, deadlineMs: WAIT }));
  const queue = async (args: Record<string, unknown>): Promise<{ verdict: string; id?: string }> => {
    const r = await call("command", args);
    const id = r.ok && r.value.ok ? (r.value.data as { id?: unknown }).id : undefined;
    return { verdict: verdict(r), ...(typeof id === "string" ? { id } : {}) };
  };
  const readState = async (id: string | undefined): Promise<string> => {
    const r = await call("command-state", { id });
    return r.ok && r.value.ok ? label((r.value.data as { state: CommandState }).state) : verdict(r);
  };
  const settle = async (id: string | undefined, ms = 10_000): Promise<string> => {
    let s = await readState(id);
    for (const end = Date.now() + ms; (s === "queued" || s === "taken") && Date.now() < end; s = await readState(id)) await sleep(25);
    return s;
  };
  const run = async (args: Record<string, unknown>) => {
    const q = await queue(args);
    return { verdict: q.verdict, label: await settle(q.id) };
  };

  const bearerFile = join(dir, "bearer"), sentinelFile = join(dir, "sentinel.creds");
  writeFileSync(bearerFile, await bearer(W.cody), { mode: 0o600 });
  writeFileSync(sentinelFile, callout.sentinelCreds, { mode: 0o600 });
  const tsx = join(repo, "node_modules/.bin/tsx");
  host = spawn(tsx, [join(repo, "extensions/connector-codex/src/host-main.ts")], { cwd: work, env: hostEnv(bearerFile, sentinelFile), stdio: ["ignore", "pipe", "pipe"] });
  host.stdout?.on("data", (c) => hostOut.push(String(c)));
  host.stderr?.on("data", (c) => hostOut.push(String(c)));
  const served = await until(() => webEp.getRoster().some((p: Presence) => p.card.id === `${A}.cody` && p.status === "idle" && p.prompts !== undefined), live ? 60_000 : 20_000);
  const presence = webEp.getRoster().find((p) => p.card.id === `${A}.cody`);
  if (presence?.runtime) cody = { owner: A, actor: "cody", uid: W.cody.uid, runtimeId: presence.runtime.id };
  check(`the host came online${live ? " on the installed codex" : ""}`, served && cody !== undefined, served ? undefined : hostOut.join("").slice(-3000));
  check("presence says the agent serves interrupt, turn, images, usage and set-model",
    same(presence?.agentEndpoint, { interrupt: true, turn: true, images: true, usage: true, setModel: true }), presence?.agentEndpoint);
  const fresh = await call("usage");
  check("before Codex reports token usage, usage answers supported with no context",
    fresh.ok && fresh.value.ok && same(fresh.value.data, { supported: true }), fresh.ok ? fresh.value : verdict(fresh));

  const listed = await call("commands");
  const catalog = listed.ok && listed.value.ok ? (listed.value.data as { supported: boolean; commands?: CommandEntry[] }) : undefined;
  const echo = catalog?.commands?.find((e) => e.name === "smoke-echo");
  const names = catalog?.commands?.map((e) => e.name) ?? [];
  check("commands lists Codex's enabled skills as skills, once each, the repo skill first under its name and description, and leaves out the disabled one",
    catalog?.supported === true && same(echo, { name: "smoke-echo", target: "skill", description: "Reply with the word PINEAPPLE." })
    && names.filter((n) => n === "smoke-echo").length === 1 && !names.includes("smoke-off") && names.includes("imagegen")
    && catalog.commands!.every((e) => e.target === "skill"), catalog ?? verdict(listed));
  check("the reply carries no skill path", !JSON.stringify(catalog ?? {}).includes("SKILL.md"), catalog);
  check("listing ran nothing", turnCount() === 0, turnCount());

  const ran = await run({ target: "skill", name: "smoke-echo", args: "go" });
  check("a listed skill is accepted and reads started", ran.verdict === "ok" && ran.label === "started", ran);
  await until(() => turnCount() >= 1);
  if (live) {
    check("Codex put the SKILL.md body into the model request beside the args, so the skill ran as a skill",
      modelTurns.length === 1 && modelTurns[0].includes("<skill>") && modelTurns[0].includes(SKILL_BODY) && modelTurns[0].includes("go"), modelTurns);
  } else {
    check("turn/start started the skill by its listed path, with the args as text",
      same(fakeTurns()[0]?.input, [{ type: "skill", name: "smoke-echo", path: ECHO_PATH }, { type: "text", text: "go", text_elements: [] }]), fakeTurns());
  }
  await until(() => webEp.getRoster().some((p) => p.card.id === `${A}.cody` && p.status === "idle"));

  const before = turnCount();
  const unknown = await run({ target: "skill", name: "nope" });
  const off = await run({ target: "skill", name: "smoke-off" });
  const command = await call("command", { target: "command", name: "review" });
  check("an unknown and a disabled skill are accepted and end refused, not-found, and a command target is unimplemented",
    unknown.label === "refused/not-found" && off.label === "refused/not-found" && verdict(command) === "unimplemented/not-executed", [unknown, off, verdict(command)]);
  await sleep(500);
  check("none of them started a turn", turnCount() === before, turnCount() - before);

  const said = await call("turn", { text: "OWNER-WORDS" });
  const saidId = said.ok && said.value.ok ? (said.value.data as { id?: string }).id : undefined;
  check("the owner's turn is accepted and reads started", verdict(said) === "ok" && (await settle(saidId)) === "started", verdict(said));
  await until(() => turnCount() >= before + 1);
  check("it runs their words as typed", live ? modelTurns.at(-1)?.includes("OWNER-WORDS") === true
    : same(fakeTurns().at(-1)?.input, [{ type: "text", text: "OWNER-WORDS", text_elements: [] }]), live ? modelTurns.at(-1) : fakeTurns().at(-1));
  await until(() => webEp.getRoster().some((p) => p.card.id === `${A}.cody` && p.status === "idle"));
  const shown = await call("turn", { text: "LOOK", images: [{ mimeType: "image/png", data: PNG }] });
  const shownId = shown.ok && shown.value.ok ? (shown.value.data as { id?: string }).id : undefined;
  check("a turn with a PNG is accepted and reads started", verdict(shown) === "ok" && (await settle(shownId)) === "started", verdict(shown));
  await until(() => turnCount() >= before + 2);
  check("the image goes with the text as a data URL", live ? ["LOOK", "[image data:image/png;base64,"].every((part) => modelTurns.at(-1)?.includes(part))
    : same(fakeTurns().at(-1)?.input, [{ type: "text", text: "LOOK", text_elements: [] }, { type: "image", url: `data:image/png;base64,${PNG}` }]), live ? modelTurns.at(-1) : fakeTurns().at(-1));
  await until(() => webEp.getRoster().some((p) => p.card.id === `${A}.cody` && p.status === "idle"));
  const used = await call("usage");
  const context = used.ok && used.value.ok ? (used.value.data as { context?: { used: number; size: number } }).context : undefined;
  check("after a turn, usage answers the last call's total tokens in the model's window",
    live ? (context?.used ?? 0) > 0 && (context?.size ?? 0) > 0 : same(context, { used: 1000 + before + 2, size: 258400 }), used.ok ? used.value : verdict(used));
  const ownerTurns = 2;

  const idle = await call("interrupt");
  check("with no turn running, interrupt answers idle", idle.ok && idle.value.ok && same(idle.value.data, { state: "idle" }), idle.ok ? idle.value : verdict(idle));

  await webEp.unicast(`${A}.cody`, "HOLD-OPEN until interrupted");
  const holding = await until(() => turnCount() > before + ownerTurns);
  const stuck = await queue({ target: "skill", name: "smoke-echo" });
  await sleep(3000);
  const behind = await readState(stuck.id);
  check("a skill sent while a turn that never ends runs still reads queued 3 s later, and starts no turn",
    holding && stuck.verdict === "ok" && behind === "queued" && turnCount() === before + ownerTurns + 1, [holding, stuck.verdict, behind, turnCount() - before]);
  const stop = await call("interrupt");
  const freed = await settle(stuck.id);
  check("the owner's interrupt answers interrupted, and the queued skill then runs: it reads started",
    stop.ok && stop.value.ok && same(stop.value.data, { state: "interrupted" }) && freed === "started", [verdict(stop), stop.ok && stop.value.ok ? stop.value.data : undefined, freed]);
  await until(() => turnCount() >= before + ownerTurns + 2);
  const last = live ? modelTurns.at(-1) ?? "" : JSON.stringify(fakeTurns().at(-1)?.input ?? []);
  check("that turn is the skill", live ? last.includes(SKILL_BODY) && !last.includes("HOLD-OPEN") : last.includes('"type":"skill"'), last);

  if (!live) {
    // A turn can end while the interrupt is on its way. Codex then refuses it, and nothing was stopped.
    await until(() => webEp.getRoster().some((p) => p.card.id === `${A}.cody` && p.status === "idle"));
    const raced = turnCount();
    await webEp.unicast(`${A}.cody`, "RACE-END");
    await until(() => turnCount() > raced);
    const late = await call("interrupt");
    check("an interrupt that reaches Codex after the turn ended answers idle",
      late.ok && late.value.ok && same(late.value.data, { state: "idle" }), late.ok ? late.value : verdict(late));

    // set-model: checked against model/list, then thread/settings/update, from the next turn on.
    await until(() => webEp.getRoster().some((p) => p.card.id === `${A}.cody` && p.status === "idle"));
    const updates = () => fakeEntries().filter((e) => e.method === "thread/settings/update").map((e) => e.params);
    const answer = (r: Awaited<ReturnType<typeof call>>) => (r.ok && r.value.ok ? r.value.data : verdict(r));
    const ownerTurn = async (text: string): Promise<FakeEntry | undefined> => {
      const r = await call("turn", { text });
      const state = await settle(r.ok && r.value.ok ? (r.value.data as { id?: string }).id : undefined, 20_000);
      const find = () => fakeTurns().find((t) => JSON.stringify(t.input).includes(text));
      await until(() => find() !== undefined);
      return find() ?? ({ ev: `the turn did not run: ${verdict(r)} ${state}` } as FakeEntry);
    };
    const next = await call("set-model", { model: "fake-next", variant: "low" });
    check("set-model to a listed model and effort answers the model and effort Codex runs",
      same(answer(next), { model: "fake-next", variant: "low" }), answer(next));
    const lists = fakeEntries().filter((e) => e.method === "model/list").map((e) => e.params);
    check("the host read both pages of model/list with hidden models, then sent thread/settings/update with that model and effort",
      same(lists, [{ includeHidden: true }, { includeHidden: true, cursor: "page-2" }]) && same(updates(), [{ threadId: "t_skills", model: "fake-next", effort: "low" }]), [lists, updates()]);
    const switched = await ownerTurn("AFTER-SWITCH");
    check("the next turn runs on fake-next at low effort, and its turn/start names neither, so the thread's setting decides",
      same(switched?.runs, { model: "fake-next", effort: "low" }) && switched?.model === undefined && switched?.effort === undefined, switched);
    await until(() => webEp.getRoster().some((p) => p.card.id === `${A}.cody` && p.status === "idle"));

    const effortOnly = await call("set-model", { variant: "high" });
    check("set-model with only a variant keeps the model the thread runs, the switched one, and changes the effort",
      same(answer(effortOnly), { model: "fake-next", variant: "high" }) && same(updates().at(-1), { threadId: "t_skills", model: "fake-next", effort: "high" }), [answer(effortOnly), updates().at(-1)]);
    const modelOnly = await call("set-model", { model: "fake-model" });
    check("set-model with only a model sends that model's default effort from model/list",
      same(answer(modelOnly), { model: "fake-model", variant: "medium" }) && same(updates().at(-1), { threadId: "t_skills", model: "fake-model", effort: "medium" }), [answer(modelOnly), updates().at(-1)]);

    const sent = updates().length;
    const unlisted = await call("set-model", { model: "gpt-nope" });
    const effortOff = await call("set-model", { variant: "xhigh" });
    const pairOff = await call("set-model", { model: "fake-next", variant: "medium" });
    check("an unlisted model is not-found, and an effort the model does not list is failed-precondition, both before Codex is asked",
      verdict(unlisted) === "not-found/not-executed" && verdict(effortOff) === "failed-precondition/not-executed"
      && verdict(pairOff) === "failed-precondition/not-executed" && updates().length === sent, [verdict(unlisted), verdict(effortOff), verdict(pairOff), updates().length - sent]);
    const codexSaidNo = await call("set-model", { model: "fake-refused" });
    check("a switch Codex refuses with an error answer is failed-precondition",
      verdict(codexSaidNo) === "failed-precondition/not-executed" && updates().length === sent + 1 && updates().at(-1)?.model === "fake-refused", [verdict(codexSaidNo), updates().slice(sent)]);

    // An app-server restart starts a new thread on the launch config. The switch goes to it first.
    const kept = await call("set-model", { model: "fake-next", variant: "low" });
    const mark = fakeEntries().length;
    writeFileSync(`${fakeLog}.crash`, "");
    await until(() => fakeEntries().slice(mark).some((e) => e.method === "thread/settings/update"), 30_000);
    const tail = fakeEntries().slice(mark);
    const died = tail.findIndex((e) => e.ev === "died");
    const restarted = tail.findIndex((e, i) => i > died && e.method === "thread/start");
    const reapplied = tail.findIndex((e, i) => i > restarted && e.method === "thread/settings/update");
    const firstTurn = tail.findIndex((e, i) => i > restarted && e.method === "turn/start");
    check("after the app-server crashes, the host sends the switch to the restarted thread before any turn/start",
      same(answer(kept), { model: "fake-next", variant: "low" }) && died >= 0 && restarted > died && reapplied > restarted && (firstTurn < 0 || firstTurn > reapplied)
      && same(tail[reapplied]?.params, { threadId: "t_skills", model: "fake-next", effort: "low" }), { tail: tail.map((e) => e.method ?? e.ev), host: hostOut.join("").slice(-1500) });
    const reborn = await ownerTurn("AFTER-RESTART");
    check("the restarted thread's first turn runs on fake-next at low effort",
      same(reborn?.runs, { model: "fake-next", effort: "low" }), reborn);
  }
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    const child = host;
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  }
  for (const stop of stops.reverse()) await stop().catch(() => {});
  mock.closeAllConnections();
  mock.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
process.exit(process.exitCode ?? 0);

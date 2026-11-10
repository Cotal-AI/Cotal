/** Personal Codex conversations on local meshes this machine runs: a static-credential mesh and an
 * open one, each started with the real `cotal up`. A real `codex app-server` owns two conversations
 * through the Cotal plugin `cotal setup` installs with Codex's own plugin commands; a loopback model
 * stands in for inference and calls the one Cotal tool each scripted prompt names, so no paid model
 * runs and no hosted acceptance is claimed. Needs `nats-server`, `codex` and a build.
 *
 * Run: pnpm smoke:personal-codex-local:live */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const CLI = join(REPO, "bin/dist/cotal.js");
assert(existsSync(CLI), `build first: ${CLI} missing`);
const base = mkdtempSync(join(tmpdir(), "cotal-personal-local-codex-"));
const userHome = join(base, "user"), codexHome = join(base, "codex"), config = join(base, "config");
// Codex gives a plugin server a minimal environment, so the CLI it runs finds the Cotal home under
// HOME. Every command here uses that same home.
const cotalHome = join(userHome, ".cotal");
for (const dir of [userHome, cotalHome, codexHome, config]) mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
Object.assign(process.env, { COTAL_HOME: cotalHome, HOME: userHome, XDG_CONFIG_HOME: config });
const { CotalEndpoint, DEV_OWNER, deprovisionAgent, eventChannel, mintCreds, newIdentity } = await import("@cotal-ai/core");
const { authDir, loadSpaceAuth } = await import("@cotal-ai/workspace");
const { codexSetupProvider } = await import("../../../extensions/connector-codex/src/setup.js");

const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_|OPENAI_|CODEX_)/.test(k)));
Object.assign(env, { COTAL_NO_PROMPT: "1", COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" });
const codexEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("COTAL_")));
Object.assign(codexEnv, { CODEX_HOME: codexHome, NO_PROXY: "127.0.0.1,localhost" });

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await wait(100); }
  throw new Error(message);
};
let checks = 0;
/** `observed` is model-visible tool output, shown when the check fails. */
const check = (name: string, condition: unknown, observed?: string) => {
  assert(condition, observed === undefined ? name : `${name}\n--- observed ---\n${observed}`);
  checks++;
  console.log(`  ✓ ${name}`);
};

// The loopback model. It never sees a credential. A prompt `COTAL_CALL <label> <tool> <json>` makes
// it call that tool once; a Cotal wake notice makes it read the inbox of the connection it names.
type Item = { type?: string; role?: string; content?: unknown; output?: unknown; call_id?: string };
const outputs = new Map<string, string>();
const labels = new Map<string, string>();
const prompts: string[] = [];
let calls = 0;
const text = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
const model = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body || "{}") as { tools?: Array<{ type?: string; name?: string; tools?: Array<{ name?: string }> }>; input?: Item[] };
  const input = request.input ?? [];
  const last = input.at(-1);
  const tool = (name: string) => {
    for (const t of request.tools ?? []) {
      if (t.type === "namespace" && t.tools?.some((x) => x.name === name)) return { name, namespace: t.name };
      if (t.name === name) return { name };
    }
    throw new Error(`the model was offered no ${name}`);
  };
  const n = ++calls;
  const say = (words: string) => ({ type: "message", role: "assistant", id: `msg-${n}`, content: [{ type: "output_text", text: words }] });
  let item: Record<string, unknown>;
  if (last?.type === "function_call_output") {
    outputs.set(labels.get(last.call_id ?? "") ?? `unlabelled-${n}`, typeof last.output === "string" ? last.output : JSON.stringify(last.output));
    item = say(`FIXTURE_DONE_${n}`);
  } else {
    const prompt = text([...input].reverse().find((i) => i.role === "user")?.content);
    prompts.push(prompt);
    const directive = /COTAL_CALL (\S+) (\S+) (\{.*\})\s*$/.exec(prompt);
    const wake = /Cotal messages are waiting for connection_id ([0-9a-f-]{36})\. Read them/.exec(prompt);
    const call: [string, string, Record<string, unknown>] | undefined = directive ? [directive[1]!, directive[2]!, JSON.parse(directive[3]!)]
      : wake ? [`wake:${wake[1]}:${n}`, "cotal_inbox", { connection_id: wake[1] }] : undefined;
    if (call) labels.set(`call-${n}`, call[0]);
    item = call ? { type: "function_call", id: `fc-${n}`, call_id: `call-${n}`, ...tool(call[1]), arguments: JSON.stringify(call[2]) } : say(`FIXTURE_ASSISTANT_${n}`);
  }
  const events = [
    { type: "response.created", response: { id: `resp-${n}` } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id: `resp-${n}`, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelPort = (model.address() as AddressInfo).port;

const children: ChildProcess[] = [];
const stopped = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once("exit", () => resolve());
  child.stdin?.end();
  setTimeout(() => child.kill("SIGTERM"), 10_000).unref();
});

/** One `codex app-server` over stdio, as Codex's own clients drive it. */
const appServer = async (root: string) => {
  const p = spawn("codex", ["app-server"], { cwd: root, env: codexEnv, stdio: ["pipe", "pipe", "ignore"] });
  children.push(p);
  const events: Array<{ method: string; params: Record<string, any> }> = [];
  const waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
  let id = 0;
  createInterface({ input: p.stdout! }).on("line", (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); }
    else if (m.method) events.push({ method: m.method, params: m.params ?? {} });
  });
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    waiting.set(n, (m) => { clearTimeout(timer); if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result); });
    p.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
  });
  await call("initialize", { clientInfo: { name: "fixture-personal-local", version: "1" }, capabilities: { experimentalApi: true } });
  p.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
  /** One conversation: `call` runs one scripted tool call as a whole turn and returns its output. */
  const conversation = async (who: string) => {
    const thread = (await call("thread/start", { cwd: root })).thread.id as string;
    let k = 0;
    const turns = () => events.filter((e) => e.method === "turn/started" && e.params.threadId === thread).length;
    return {
      thread, turns,
      async call(tool: string, args: Record<string, unknown>): Promise<string> {
        const label = `${who}-${++k}-${tool}`;
        const turn = (await call("turn/start", { threadId: thread, input: [{ type: "text", text: `COTAL_CALL ${label} ${tool} ${JSON.stringify(args)}` }] })).turn.id as string;
        await until(() => events.some((e) => e.method === "turn/completed" && e.params.turn?.id === turn), `${who}: ${tool} turn did not complete`, 60_000);
        const out = outputs.get(label);
        assert(out !== undefined, `${who}: ${tool} produced no tool output`);
        return out;
      },
    };
  };
  return { p, conversation };
};

/** The credential directories a static provision made for `space`, with their records. */
const identities = (space: string) => readdirSync(tmpdir()).filter((n) => n.startsWith("cotal-app-identity-")).flatMap((n) => {
  try {
    const record = JSON.parse(readFileSync(join(tmpdir(), n, "identity.json"), "utf8")) as { space: string; id: string; lifecycleUid: string; owner: number; session?: string };
    return record.space === space ? [{ dir: join(tmpdir(), n), ...record }] : [];
  } catch { return []; }
});
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const secretShaped = /BEGIN NATS|NKEY SEED|-----BEGIN|\bSU[A-Z2-7]{50,}|COTAL_CREDS|agent\.creds/;

const sandboxes: Array<{ root: string; sandbox: SmokeSandboxAnchor; up: boolean; space: string }> = [];
const cotal = (s: { root: string; sandbox: SmokeSandboxAnchor }, ...args: string[]) => {
  const options = { cwd: s.root, env, encoding: "utf8" as const };
  assertSmokeSandboxDown(s.sandbox, args, options);
  return spawnSync(process.execPath, [CLI, ...args], options);
};

let complete = false;
try {
  // `cotal setup` for Codex, run against the fixture's own Codex home with Codex's plugin commands.
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  let installed: string;
  try { installed = await codexSetupProvider.connector!.run({ cotal: [process.execPath, CLI] }); }
  finally { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; }
  check("setup installs the Cotal plugin through Codex's own plugin commands", /^cotal@cotal-mesh \d/.test(installed));
  writeFileSync(join(codexHome, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "Loopback fixture"
base_url = "http://127.0.0.1:${modelPort}/v1"
wire_api = "responses"
requires_openai_auth = false
[plugins."cotal@cotal-mesh".mcp_servers.cotal]
default_tools_approval_mode = "approve"
${readFileSync(join(codexHome, "config.toml"), "utf8")}`);

  for (const kind of ["static", "open"] as const) {
    console.log(`${kind} mesh`);
    const root = join(base, kind);
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true, mode: 0o700 });
    // The persona a bare `cotal spawn` loads here: what a conversation's default grant follows.
    writeFileSync(join(root, ".cotal/agents/default.md"),
      "---\nname: default\nrole: default\nsubscribe: []\nallowSubscribe: [general, team.>]\nallowPublish: [general, team.>]\ncapabilities: [run]\n---\nFixture persona.\n");
    const space = `pl${kind}${process.pid}`;
    const s = { root, sandbox: recordSmokeSandbox({ root, cotalHome, xdgConfigHome: config }), up: false, space };
    sandboxes.push(s);
    const servers = `nats://127.0.0.1:${await freePort()}`;
    const up = cotal(s, "up", "--detach", "--no-manager", "--server", servers, "--space", space, ...(kind === "open" ? ["--open"] : []));
    s.up = true;
    check(`the isolated ${kind} mesh starts with cotal up`, up.status === 0, `${up.stdout}${up.stderr}`);
    const auth = kind === "static" ? loadSpaceAuth(authDir(root), space) : undefined;
    check(`  ${kind === "static" ? "it holds this machine's signing authority" : "it takes no credential"}`, kind === "static" ? auth !== undefined : auth === undefined);
    const observer = new CotalEndpoint({ space, servers, ...(auth ? { creds: await mintCreds(auth, newIdentity(), "operator") } : {}),
      channels: [], consume: false, registerPresence: false, watchPresence: true, card: { name: "fixture-observer", kind: "endpoint" } });
    observer.on("error", () => {});
    observer.on("warning", () => {});
    await observer.start();
    const online = (name: string) => observer.getRoster().filter((p) => p.card.name === name && p.status !== "offline");
    const footprintGone = async (who: { id: string; lifecycleUid: string }) => {
      const again = await deprovisionAgent({ servers, space, targetId: who.id, lifecycleUid: who.lifecycleUid,
        creds: await mintCreds(auth!, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: who.id, lifecycleUid: who.lifecycleUid } }) });
      return again.acls.absent === 1 && again.consumers.absent === 2 && again.deleted === 0;
    };

    const codex = await appServer(root);
    const a = await codex.conversation(`${kind}-a`);
    const b = await codex.conversation(`${kind}-b`);
    check("Codex runs two conversations", a.thread !== b.thread);

    const connectedB = await b.call("cotal_connect", { name: "codex_b", space });
    check("conversation B connects through cotal_connect with the mesh's default persona grant", connectedB.includes("Connected as codex_b"), connectedB);

    // A selection reaches only what a bare spawn's persona already holds.
    const outside = await a.call("cotal_connect", { name: "codex_a", space, channels: [{ channel: "secret", access: "read" }] });
    check("a channel the mesh's persona does not grant is refused, and nothing joins", /not within/.test(outside) && !/Connected as/.test(outside) && online("codex_a").length === 0, outside);
    const seat = await a.call("cotal_connect", { name: "codex_a", space, capabilities: ["spawn"] });
    check("a capability outside the local persona's grant is refused", /not within/.test(seat) && !/Connected as/.test(seat) && online("codex_a").length === 0, seat);
    check("  and neither refusal opened a credential", identities(space).length <= 1);

    const connectedA = await a.call("cotal_connect", { name: "codex_a", space, channels: [{ channel: "general", access: "read-post" }] });
    check("conversation A connects with a channel selection", connectedA.includes("Connected as codex_a"), connectedA);
    const idA = /connection_id: ([0-9a-f-]{36})/.exec(connectedA)![1]!;
    const idB = /connection_id: ([0-9a-f-]{36})/.exec(connectedB)![1]!;
    check("connect reports the native wake path", connectedB.includes("Cotal wakes this conversation when a message arrives"));
    await until(() => online("codex_a").length === 1 && online("codex_b").length === 1, "both conversations did not appear on the mesh");
    const [peerA] = online("codex_a"), [peerB] = online("codex_b");
    check("the two conversations are distinct identities on the mesh", peerA!.card.id !== peerB!.card.id);
    const held = identities(space);
    const [recA, recB] = [held.find((r) => r.session === a.thread), held.find((r) => r.session === b.thread)];
    check("each holds its own identity, recorded with its native conversation and its own server",
      held.length === 2 && recA && recB && recA.owner !== recB.owner && peerA!.card.id?.endsWith(recA.id) && peerB!.card.id?.endsWith(recB.id),
      JSON.stringify({ peers: [peerA!.card.id, peerB!.card.id], held: held.map((r) => ({ id: r.id, session: r.session, owner: r.owner })), threads: [a.thread, b.thread] }));
    check(kind === "static" ? "  with a credential private to this account" : "  and an open mesh issues no credential", kind === "static"
      ? held.every((r) => readdirSync(r.dir).length === 2 && (statSync(join(r.dir, "agent.creds")).mode & 0o077) === 0)
      : held.every((r) => !existsSync(join(r.dir, "agent.creds"))));
    check("the model never sees a credential", [connectedA, connectedB].every((o) => !secretShaped.test(o)));

    // Isolation: a conversation cannot act through another conversation's connection.
    const borrowed = await b.call("cotal_inbox", { connection_id: idA });
    check("conversation B cannot use A's connection_id", borrowed.includes("CONNECTION_REQUIRED"), borrowed);
    const second = await a.call("cotal_connect", { name: "codex_a_again", space });
    check("one conversation cannot open a second connection", second.includes("already has a connection"));

    // A direct message from A wakes idle B natively; the content arrives only through cotal_inbox.
    const marker = `LOCAL_DM_${kind.toUpperCase()}_${process.pid}`;
    const beforeDm = b.turns();
    const sent = await a.call("cotal_dm", { connection_id: idA, to: "codex_b", text: marker });
    check("A sends a direct message to B by name", !/refus|fail|CONNECTION_REQUIRED/i.test(sent), sent);
    await until(() => [...outputs].some(([label, out]) => label.startsWith(`wake:${idB}:`) && out.includes(marker)), "the DM did not wake conversation B", 60_000);
    const notices = prompts.filter((p) => p.includes(`Cotal messages are waiting for connection_id ${idB}`));
    check("B is woken by Codex itself with a notice that carries no peer content", b.turns() > beforeDm && notices.length >= 1 && notices.every((p) => !p.includes(marker)));
    check("A was not woken by its own message", !prompts.some((p) => p.includes(`connection_id ${idA}. Read them`)));
    // Each conversation publishes its own activity on its own event channel.
    const eventsA = eventChannel({ owner: DEV_OWNER, actor: recA!.id });
    const reader = new CotalEndpoint({ space, servers, ...(auth ? { creds: await mintCreds(auth, newIdentity(), "observer") } : {}),
      channels: [eventsA], consume: false, registerPresence: false, card: { name: "fixture-event-observer", kind: "endpoint" } });
    reader.on("error", () => {});
    reader.on("warning", () => {});
    await reader.start();
    let frames: string[] = [];
    await until(async () => {
      frames = (await reader.channelHistory(eventsA, { limit: 200 })).map((m) => JSON.stringify(m));
      return frames.some((f) => f.includes("TOOL_CALL_START"));
    }, "conversation A's activity was not published on its event channel");
    await reader.stop();
    check("A's own activity reaches its event channel", frames.some((f) => f.includes("RUN_STARTED")));

    // Channel selection: A joins and posts on its selected channel; B reads it there.
    const joinedA = await a.call("cotal_join", { connection_id: idA, channel: "general" });
    check("A joins its selected channel", /general/.test(joinedA) && !/refus|not permitted|cannot/i.test(joinedA), joinedA);
    const joinedB = await b.call("cotal_join", { connection_id: idB, channel: "general" });
    check("B joins a channel its default grant allows", /general/.test(joinedB) && !/refus|not permitted|cannot/i.test(joinedB), joinedB);
    const posted = `LOCAL_CHANNEL_${kind.toUpperCase()}_${process.pid}`;
    const post = await a.call("cotal_send", { connection_id: idA, channel: "general", text: posted });
    check("A posts on its selected channel", /general/.test(post) && !/refus|not permitted|cannot/i.test(post), post);
    await wait(3_000);
    const read = await b.call("cotal_inbox", { connection_id: idB });
    check("B receives A's post on that channel", read.includes(posted) || [...outputs].some(([label, out]) => label.startsWith(`wake:${idB}:`) && out.includes(posted)), read);
    // An open mesh enforces no post ACL, so only the static mesh's broker refuses this.
    if (kind === "static") {
      const beyond = await a.call("cotal_send", { connection_id: idA, channel: "team.alpha", text: "BEYOND_SELECTION" });
      check("A cannot post beyond its selection", /not|cannot|refus|permission/i.test(beyond), beyond);
    }

    // Disconnect retires A exactly; B stays.
    const leaving = kind === "static" ? identities(space).find((r) => r.session === a.thread)! : undefined;
    check("A disconnects", (await a.call("cotal_disconnect", { connection_id: idA })).includes(`Disconnected ${idA}`));
    await until(() => online("codex_a").length === 0, "A stayed on the mesh after disconnecting");
    if (leaving) {
      check("  its credential directory is gone", !existsSync(leaving.dir));
      check("  and so is its broker footprint", await footprintGone(leaving));
    }
    check("  and B stays connected", online("codex_b").length === 1);

    // Codex ends its plugin servers without letting them retire, so what B held waits for the next
    // connection on this computer, which retires an identity whose server is gone.
    const remaining = identities(space).find((r) => r.session === b.thread)!;
    await stopped(codex.p);
    await until(() => online("codex_b").length === 0, "B stayed on the mesh after Codex exited", 30_000);
    check("Codex exiting ends B's server, and B leaves the mesh", !pidAlive(remaining.owner));
    const later = await appServer(root);
    const c = await later.conversation(`${kind}-c`);
    const connectedC = await c.call("cotal_connect", { name: "codex_c", space });
    check("a later conversation connects", connectedC.includes("Connected as codex_c"), connectedC);
    check("  and its connection retired what B's ended server left", !existsSync(remaining.dir));
    if (kind === "static") check("  with B's broker footprint", await footprintGone(remaining));
    const idC = /connection_id: ([0-9a-f-]{36})/.exec(connectedC)![1]!;
    check("the later conversation disconnects", (await c.call("cotal_disconnect", { connection_id: idC })).includes(`Disconnected ${idC}`));
    await stopped(later.p);
    check("no conversation identity is left on this mesh", identities(space).length === 0);
    await observer.stop();
    const down = cotal(s, "down", "--yes");
    check(`the ${kind} mesh stops`, down.status === 0);
    s.up = false;
  }
  complete = true;
  console.log(`personal-local-codex: ${checks} checks passed on real local meshes and a real codex app-server; loopback model; no hosted acceptance claimed`);
} finally {
  for (const child of children) await stopped(child);
  // A plugin server retires what it holds as Codex ends it; let that finish before its mesh stops,
  // then remove only this suite's own records that a failed run left.
  await until(() => sandboxes.every((s) => identities(s.space).length === 0), "", 15_000).catch(() => {});
  for (const s of sandboxes) if (s.up) cotal(s, "down", "--yes");
  for (const s of sandboxes) for (const r of identities(s.space)) rmSync(r.dir, { recursive: true, force: true });
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  if (complete) rmSync(base, { recursive: true, force: true });
  else { process.exitCode = 1; console.error(`fixture retained for diagnosis: ${base}`); }
}

/** Harness work events reach presence independently of the heartbeat and optional event plane.
 * Run: pnpm smoke:connector-activity
 * Uses real connectors and a private broker, with scripted host events, not model processes.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, type Presence } from "@cotal-ai/core";
import { MeshAgent } from "@cotal-ai/connector-core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createClaudeHandle } from "../../extensions/connector-claude-code/src/hooks.js";
import { hermesHookHandle } from "../../extensions/connector-hermes/src/hermes-hooks.js";
import { bootPlugin, disposeInProcess, fakeOpenCode2Context } from "../../extensions/connector-opencode/smoke/_boot-plugin.js";
import { setupCotal } from "../../extensions/connector-opencode/src/plugin2.js";
import cotalMesh from "../../extensions/pi/src/extension.js";
import { presenceFacts } from "../../implementations/cli/src/ui.js";
import { presenceFacts as webFacts } from "../../implementations/web/client/src/lib/presence.js";

const { check, finish } = createSuite();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
console.log(`retained evidence: ${dir}`);
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "connectoractivity";
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
// Do not hand over the directory: this suite retains its evidence after stopping the broker.
const release = teardownOnSignal(broker);
const observer = new CotalEndpoint({ space, servers, registerPresence: false, consume: false, watchChannels: false,
  card: { id: "observer", name: "observer", kind: "endpoint" } });
observer.on("error", () => {});
const agents: MeshAgent[] = [];
let codex: ChildProcess | undefined;
let hooks: Awaited<ReturnType<typeof bootPlugin>> | undefined;
let stop2: (() => Promise<void>) | void = undefined;
const context2 = fakeOpenCode2Context();
const piHandlers = new Map<string, (event: unknown, context: unknown) => unknown>();
const piContext = { hasUI: false, ui: { notify() {} }, isIdle: () => true, shutdown() {},
  sessionManager: { getSessionId: () => "pi_session", getSessionFile: () => undefined } };
let piLoaded = false;
const http = createServer((req, res) => {
  req.resume();
  const id = req.url === "/session" ? "oc1_session" : "oc2_session";
  if (req.method === "POST" && (req.url === "/session" || req.url === "/api/session"))
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.url === "/session" ? { id } : { data: { id } }));
  else res.writeHead(404).end();
});
const originalEnv = { ...process.env };
function env(name: string): void {
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  Object.assign(process.env, { COTAL_NAME: name, COTAL_ID: name, COTAL_SPACE: space, COTAL_SERVERS: servers,
    COTAL_EVENTS: "0", COTAL_SUBSCRIBE: "", COTAL_ALLOW_SUBSCRIBE: "", COTAL_ALLOW_PUBLISH: "",
    COTAL_HOME: join(dir, "cotal-home"), HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"),
    XDG_RUNTIME_DIR: join(dir, "runtime"), CODEX_HOME: join(dir, "operator-codex"),
    COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
    OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "fixture-only" });
}
async function seat(name: string): Promise<MeshAgent> {
  const agent = new MeshAgent({ name, id: name, space, servers, kind: "agent", tls: false, subscribe: [], allowSubscribe: [], allowPublish: [] });
  agents.push(agent);
  agent.on("error", () => {});
  await agent.start();
  return agent;
}
async function presence(name: string, predicate: (p: Presence) => boolean = () => true): Promise<Presence> {
  const end = Date.now() + 10_000;
  do {
    const value = observer.getRoster().find((p) => p.card.name === name);
    if (value && predicate(value)) return value;
    await sleep(50);
  } while (Date.now() < end);
  throw new Error(`presence timeout: ${name}`);
}
async function work(name: string, label: string, fire: () => unknown | Promise<unknown>): Promise<Presence> {
  await sleep(2);
  const at = Date.now();
  await fire();
  const value = await presence(name, (p) => p.ts >= at);
  check(`${name}: ${label} records real work`, typeof value.activeAt === "number" && value.activeAt >= at && value.activeAt <= value.ts,
    { eventAt: at, activeAt: value.activeAt, heartbeat: value.ts });
  return value;
}
async function unchanged(name: string, label: string, fire: () => unknown | Promise<unknown>): Promise<void> {
  const before = await presence(name);
  await fire();
  const after = await presence(name, (p) => p.ts > before.ts);
  check(`${name}: ${label} does not manufacture progress`, after.activeAt === before.activeAt, { before: before.activeAt, after: after.activeAt });
}
try {
  for (const path of ["home", "config", "runtime", "cotal-home", "operator-codex"]) mkdirSync(join(dir, path), { recursive: true });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await observer.start();

  const control = await seat("control");
  const exact = Date.now();
  control.noteActivity(exact);
  const controlled = await presence("control", (p) => p.activeAt === exact && p.ts > exact);
  check("positive control: noteActivity reaches the live broker on a newer heartbeat", controlled.activeAt === exact && controlled.ts > exact);

  const claude = await seat("claude");
  const handle = createClaudeHandle({ delivery: false });
  await work("claude", "UserPromptSubmit", () => handle.handle(claude, { hook_event_name: "UserPromptSubmit" }));
  await work("claude", "PreToolUse", () => handle.handle(claude, { hook_event_name: "PreToolUse", tool_name: "Read" }));
  await work("claude", "PostToolBatch without a permission wait", () => handle.handle(claude, { hook_event_name: "PostToolBatch" }));
  await unchanged("claude", "subagent tool events", () => handle.handle(claude, { hook_event_name: "PreToolUse", agent_id: "child", tool_name: "Read" }));
  await unchanged("claude", "notifications", () => handle.handle(claude, { hook_event_name: "Notification", notification_type: "permission_prompt" }));
  await work("claude", "successful turn end", () => handle.handle(claude, { hook_event_name: "Stop" }));
  await unchanged("claude", "failed turn end", () => handle.handle(claude, { hook_event_name: "StopFailure", error: "server_error" }));

  const hermes = await seat("hermes");
  for (const event of ["pre_llm_call", "pre_tool_call", "post_llm_call"])
    await work("hermes", event, () => hermesHookHandle(hermes, { hook_event_name: event, tool_name: "read_file" }));
  await unchanged("hermes", "gateway lifecycle", () => hermesHookHandle(hermes, { hook_event_name: "gateway_startup" }));

  env("pi");
  const api = { sendMessage() {}, registerMessageRenderer() {}, registerTool() {},
    on(name: string, fn: (event: unknown, context: unknown) => unknown) { piHandlers.set(name, fn); } } as unknown as Parameters<typeof cotalMesh>[0];
  await cotalMesh(api);
  piLoaded = true;
  await presence("pi");
  await work("pi", "agent_start", () => piHandlers.get("agent_start")!({}, piContext));
  check("pi: subscribes to streaming assistant work", piHandlers.has("message_update"));
  await work("pi", "streaming assistant delta", () => piHandlers.get("message_update")?.({ assistantMessageEvent: { type: "text_delta", delta: "answer" } }, piContext));
  for (const type of ["thinking_delta", "toolcall_delta"])
    await work("pi", type, () => piHandlers.get("message_update")?.({ assistantMessageEvent: { type, delta: "work" } }, piContext));
  await unchanged("pi", "empty assistant delta", () => piHandlers.get("message_update")?.({ assistantMessageEvent: { type: "text_delta", delta: "" } }, piContext));
  await work("pi", "tool_execution_start", () => piHandlers.get("tool_execution_start")!({ toolName: "read" }, piContext));
  await work("pi", "tool_execution_update", () => piHandlers.get("tool_execution_update")?.({}, piContext));
  await work("pi", "tool_execution_end", () => piHandlers.get("tool_execution_end")!({}, piContext));

  env("opencode1");
  hooks = await bootPlugin();
  await presence("opencode1");
  const fire = (event: unknown) => hooks!.event!({ event } as never);
  await work("opencode1", "owned busy event", () => fire({ type: "session.status", properties: { sessionID: "oc1_session", status: { type: "busy" } } }));
  await work("opencode1", "owned assistant delta", () => fire({ type: "message.part.updated", properties: { part: { sessionID: "oc1_session", type: "text", text: "answer" }, delta: "answer" } }));
  await unchanged("opencode1", "text snapshot without a delta", () => fire({ type: "message.part.updated", properties: { part: { sessionID: "oc1_session", type: "text", text: "old text" } } }));
  await work("opencode1", "owned tool hook", () => hooks!["tool.execute.before"]!({ sessionID: "oc1_session", tool: "read", callID: "call" } as never, {} as never));
  await unchanged("opencode1", "foreign-session parts", () => fire({ type: "message.part.updated", properties: { part: { sessionID: "foreign", type: "text", text: "other" } } }));
  await unchanged("opencode1", "retry status", () => fire({ type: "session.status", properties: { sessionID: "oc1_session", status: { type: "retry", message: "provider unavailable" } } }));

  env("opencode2");
  stop2 = await setupCotal(context2);
  await presence("opencode2");
  await work("opencode2", "owned execution start", () => context2.feed({ type: "session.execution.started", durable: { aggregateID: "oc2_session", seq: 1 }, data: { sessionID: "oc2_session" } }));
  await work("opencode2", "owned tool hook", () => context2.toolHooks.get("execute.before")!({ sessionID: "oc2_session", tool: "read" } as never));
  await work("opencode2", "owned completed model step", () => context2.feed({ type: "session.step.ended", durable: { aggregateID: "oc2_session", seq: 2 }, data: { sessionID: "oc2_session" } }));
  await unchanged("opencode2", "replayed completed model step", () => context2.feed({ type: "session.step.ended", durable: { aggregateID: "oc2_session", seq: 2 }, data: { sessionID: "oc2_session" } }));
  await unchanged("opencode2", "foreign step", () => context2.feed({ type: "session.step.ended", durable: { aggregateID: "foreign", seq: 3 }, data: { sessionID: "foreign" } }));
  await unchanged("opencode2", "replayed execution start", () => context2.feed({ type: "session.execution.started", durable: { aggregateID: "oc2_session", seq: 1 }, data: { sessionID: "oc2_session" } }));

  env("codex");
  const fake = join(dir, "codex");
  writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${fileURLToPath(new URL("../../extensions/connector-codex/smoke/fake-codex.mjs", import.meta.url))}' "$@"\n`);
  chmodSync(fake, 0o700);
  codex = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../extensions/connector-codex/src/host-main.ts", import.meta.url))], {
    env: { ...process.env, COTAL_CODEX_BIN: fake, COTAL_CODEX_HOME: dir, FAKE_CODEX_LOG: join(dir, "codex.jsonl"), FAKE_CODEX_ACTIVITY_STEP: join(dir, "step") }, stdio: ["ignore", "ignore", "inherit"],
  });
  await presence("codex");
  const sender = await seat("sender");
  await work("codex", "app-server turn and item events", async () => {
    const peer = await presence("codex");
    await sender.ep.unicast(peer.card.id!, "ACTIVITY-PROBE");
  });
  const releaseStep = async (step: number): Promise<void> => {
    writeFileSync(join(dir, `step.${step}`), "go");
    const deadline = Date.now() + 5_000;
    while (!readFileSync(join(dir, "codex.jsonl"), "utf8").split("\n").some((line) => {
      if (!line) return false;
      const entry = JSON.parse(line) as { ev: string; step?: number };
      return entry.ev === "activityStep" && entry.step === step;
    })) {
      assert.ok(Date.now() < deadline, `Codex activity step ${step} delivered`);
      await sleep(25);
    }
  };
  for (let step = 0; step < 5; step++) await work("codex", `streaming notification ${step}`, () => releaseStep(step));
  await unchanged("codex", "foreign-thread delta", () => releaseStep(5));
  await unchanged("codex", "empty delta", () => releaseStep(6));
  await unchanged("codex", "token-usage metadata", () => releaseStep(7));
  await work("codex", "completed assistant item", () => writeFileSync(join(dir, "step.end"), "go"));

  const old = await presence("control");
  const fresh = await presence("control", (p) => p.ts > old.ts);
  check("heartbeat alone preserves the last work timestamp", fresh.activeAt === old.activeAt);
  const now = exact + 90_000;
  check("CLI reads activeAt as work age, not heartbeat age", presenceFacts(controlled, now).ages.includes("active 1m ago"));
  check("dashboard reads activeAt as work age, not heartbeat age", webFacts(controlled, now).includes("active 1m ago"));
} finally {
  if (codex) await killAndAwaitExit(codex);
  context2.end();
  await stop2?.();
  await disposeInProcess(hooks);
  if (piLoaded) await piHandlers.get("session_shutdown")!({ reason: "quit" }, piContext);
  for (const agent of agents) await agent.stop();
  await observer.stop();
  await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  await killAndAwaitExit(broker);
  release();
  process.env = originalEnv;
}
assert.equal(broker.exitCode !== null || broker.signalCode !== null, true, "owned broker exited");
finish();

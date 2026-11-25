/**
 * A mesh read tool's result stays off the event plane across a real read grant (#1426).
 *
 * On a JWT-auth broker, Reed is a Claude Code seat that may read `#vault` and nothing else. Its
 * event plane is armed as the manager arms it, with its own `events.<owner>.<actor>` in its publish
 * grant. Keeper posts a marker on `#vault`. Watcher is another agent of the same owner. It holds a
 * grant on Reed's event channel, can read Reed's event payload rail, and holds no grant on `#vault`.
 *
 * Reed runs a real `cotal_inbox` call over MCP under its own grant. The transcript records are the
 * ones Claude Code writes for an MCP call, with the tool result copied from that call. Claude's own
 * hook handler and event plane (`createClaudeEventPlane`) publish the turn on the broker. Watcher
 * must not receive the marker live on the event channel, in its history, or live on the payload
 * rail, which Watcher reads through the subscription its grant allows.
 *
 * The controls give that absence its meaning. The broker refuses Watcher a read of `#vault`. The
 * tool result and the transcript carry the marker. Watcher receives the call's start and end on
 * the event channel. A Bash result in the same turn reaches Watcher on the payload rail.
 *
 * Run: pnpm smoke:agui-egress-acl:auth   (needs `nats-server` on PATH; local-only)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  type CotalMessage,
  DEV_OWNER,
  createSpaceAuth,
  eventChannel,
  eventPayloadSubject,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
} from "@cotal-ai/core";
// The package's built entry, the copy the Claude connector imports, so the agent, the tools and the
// event plane below are one module graph.
import { MeshAgent, isAguiFramePart, parseAguiFrame, registerCotalTools, type AgentConfig, type AguiEvent } from "@cotal-ai/connector-core";
import { createClaudeEventPlane } from "../../connector-claude-code/src/claude-events.js";
import { createClaudeHandle } from "../../connector-claude-code/src/hooks.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = `egressacl${randomUUID().slice(0, 8)}`;
const THREAD = "sess-egress-acl";
const SECRET = `VAULT-ONLY-${randomUUID()}`;
const CONTROL = `PAYLOAD-RAIL-CONTROL-${randomUUID()}`;
const INBOX_CALL = "toolu_egress_inbox";
const BASH_CALL = "toolu_egress_bash";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { check, finish } = createSuite();
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
async function until(read: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}
const frameEvents = (msgs: CotalMessage[]): AguiEvent[] =>
  msgs.flatMap((m) => m.parts.filter(isAguiFramePart).flatMap((p) => parseAguiFrame(p).events));

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const stops: Array<() => Promise<unknown> | void> = [];

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provCreds });
  const reedId = newIdentity();
  const reedUid = mintLifecycleUid();
  const reed = { owner: DEV_OWNER, actor: reedId.id };
  const events = eventChannel(reed);
  await seedChannelRegistry({ servers, space, creds: provCreds, file: { defaults: { replay: false }, channels: { vault: { replay: false }, [events]: { replay: true } } } });
  const mgr = new CotalEndpoint({ space, servers, creds: provCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();
  stops.push(() => mgr.stop());

  const reedGrant = { subscribe: ["vault"], allowSubscribe: ["vault"], allowPublish: [events] };
  const reedCreds = await provisionAgent(mgr, auth, reedId, { ...reedGrant, role: "generalist", lifecycleUid: reedUid });
  const keeperId = newIdentity();
  const keeperUid = mintLifecycleUid();
  const keeperCreds = await provisionAgent(mgr, auth, keeperId, { subscribe: ["vault"], allowSubscribe: ["vault"], allowPublish: ["vault"], lifecycleUid: keeperUid });
  const watcherId = newIdentity();
  const watcherUid = mintLifecycleUid();
  const watcherCreds = await provisionAgent(mgr, auth, watcherId, { subscribe: [events], allowSubscribe: [events], allowPublish: [], lifecycleUid: watcherUid });

  const watcher = new CotalEndpoint({ space, servers, creds: watcherCreds, card: { id: watcherId.id, name: "Watcher", kind: "agent" }, channels: [events], lifecycleUid: watcherUid });
  watcher.on("error", () => {});
  const live: CotalMessage[] = [];
  watcher.on("message", (m: CotalMessage) => {
    if (m.channel === events) live.push(m);
  });
  await watcher.start();
  stops.push(() => watcher.stop());
  const watcherNc = await connect({ servers, ...standaloneConnectOpts({ creds: watcherCreds, tls: false }) });
  stops.push(() => watcherNc.close());
  const payloads: string[] = [];
  watcherNc.subscribe(eventPayloadSubject(space, reed.owner, reed.actor), { callback: (err, m) => { payloads.push(err ? `error: ${err.message}` : m.string()); } });
  await watcherNc.flush();
  const keeper = new CotalEndpoint({ space, servers, creds: keeperCreds, card: { id: keeperId.id, name: "Keeper", kind: "agent" }, channels: ["vault"], lifecycleUid: keeperUid });
  keeper.on("error", () => {});
  await keeper.start();
  stops.push(() => keeper.stop());

  // The seat as the Claude connector assembles it: agent, event plane, hook handler and MCP tools.
  const wsRoot = join(dir, "ws");
  mkdirSync(wsRoot);
  const env: NodeJS.ProcessEnv = { COTAL_EVENTS: "1", COTAL_WORKSPACE_ROOT: wsRoot };
  const config: AgentConfig = { space, name: "Reed", role: "generalist", servers, creds: reedCreds, ...reedGrant, kind: "agent", tls: false, id: reedId.id, lifecycleUid: reedUid, connector: "claude" };
  const agent = new MeshAgent(config, env);
  agent.on("error", () => {});
  const plane = createClaudeEventPlane(agent, config, env);
  const claude = createClaudeHandle({ events: () => plane.events });
  const server = new McpServer({ name: "egress-acl", version: "1" });
  registerCotalTools(server, agent, config, "smoke", env);
  const client = new Client({ name: "egress-acl", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  stops.push(() => agent.stop());
  stops.push(async () => {
    plane.stop();
    await plane.events.close();
  });
  stops.push(() => client.close());
  agent.start();
  check("Reed connects with its scoped credential", await until(() => agent.connected && agent.transportConnected));

  const vaultRead = await watcher.channelHistoryPage("vault", { limit: 10 }).then(
    () => "allowed",
    (e: Error) => e.message,
  );
  check("control: the broker refuses Watcher a read of #vault", /Permissions Violation/.test(vaultRead), vaultRead);

  const transcript = join(dir, `${THREAD}.jsonl`);
  const record = (o: Record<string, unknown>): string =>
    JSON.stringify({ uuid: randomUUID(), sessionId: THREAD, timestamp: new Date().toISOString(), ...o }) + "\n";
  const hook = (ev: Record<string, unknown>) => claude.handle(agent, { transcript_path: transcript, session_id: THREAD, ...ev });
  writeFileSync(transcript, record({ type: "user", origin: { kind: "human" }, message: { content: "Check your inbox." } }));
  await hook({ hook_event_name: "SessionStart", source: "startup" });
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "Check your inbox." });

  // The post arrives mid-turn, after the prompt hook has injected what was waiting.
  await keeper.multicast(SECRET, { channel: "vault" });
  check("control: Reed receives the #vault post under its grant", await until(() => agent.inboxCount() > 0));
  appendFileSync(transcript, record({ type: "assistant", message: { id: "msg-1", stop_reason: "tool_use", content: [{ type: "tool_use", id: INBOX_CALL, name: "mcp__cotal__cotal_inbox", input: {} }] } }));
  await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__cotal__cotal_inbox", tool_input: {} });
  const result = await client.callTool({ name: "cotal_inbox", arguments: {} });
  check("control: the real cotal_inbox call returns the marker", !result.isError && JSON.stringify(result.content).includes(SECRET), result);
  appendFileSync(transcript, record({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: INBOX_CALL, content: result.content }] } }));

  // A tool outside Cotal's own, whose result the payload rail does carry.
  appendFileSync(transcript, record({ type: "assistant", message: { id: "msg-2", stop_reason: "tool_use", content: [{ type: "tool_use", id: BASH_CALL, name: "Bash", input: { command: "printf control" } }] } }));
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "printf control" } });
  appendFileSync(transcript, record({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: BASH_CALL, content: CONTROL }] } }));
  appendFileSync(transcript, record({ type: "assistant", message: { id: "msg-3", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } }));
  await hook({ hook_event_name: "Stop" });
  await plane.events.settled();
  check("control: the transcript carries the marker", readFileSync(transcript, "utf8").includes(SECRET));

  check("Watcher receives the turn's end live", await until(() => frameEvents(live).some((e) => e.type === "RUN_FINISHED")), frameEvents(live).map((e) => e.type));
  const liveEvents = frameEvents(live);
  check(
    "control: Watcher sees the cotal_inbox call start and end on Reed's event channel",
    liveEvents.some((e) => e.type === "TOOL_CALL_START" && e.toolCallId === INBOX_CALL && e.toolCallName === "mcp__cotal__cotal_inbox")
      && liveEvents.some((e) => e.type === "TOOL_CALL_END" && e.toolCallId === INBOX_CALL),
    liveEvents.map((e) => e.type),
  );
  const history = JSON.stringify(await watcher.channelHistoryPage(events, { limit: 100 }));
  check("control: Watcher reads the turn back from the event channel's history", history.includes(INBOX_CALL));
  check("control: Watcher receives the Bash result live on Reed's payload rail", await until(() => payloads.join("\n").includes(CONTROL)), payloads);

  check("Watcher never receives the #vault marker live on Reed's event channel", !JSON.stringify(live).includes(SECRET));
  check("the #vault marker is not in the event channel's history", !history.includes(SECRET));
  check("the #vault marker is not on Reed's payload rail", !payloads.join("\n").includes(SECRET));
  check(
    "no TOOL_CALL_ARGS or TOOL_CALL_RESULT reaches Reed's event channel",
    !liveEvents.some((e) => e.type === "TOOL_CALL_ARGS" || e.type === "TOOL_CALL_RESULT"),
    liveEvents.map((e) => e.type),
  );
} finally {
  for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => {});
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
finish();
process.exit(process.exitCode ?? 0);

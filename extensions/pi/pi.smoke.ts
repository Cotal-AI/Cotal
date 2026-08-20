import assert from "node:assert/strict";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial } from "@cotal-ai/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExactDrainResult, InboxItem, InboxScope, MeshAgent } from "@cotal-ai/connector-core";
import { PiDriver, type CotalBatchDetails, type PiContextLike, type PiHost } from "./src/driver.js";
import cotalMesh from "./src/extension.js";
import { InboxTurn } from "./src/inbox-turn.js";
import { piConnector } from "./src/connector.js";

let checks = 0;
const ok = (condition: unknown, message: string): void => {
  assert.ok(condition, message);
  checks++;
};

function item(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    ts: new Date().toISOString(),
    fromId: `sender-${id}`,
    fromName: "sender",
    kind: "dm",
    historical: false,
    mentionsMe: false,
    text: id,
    ...overrides,
  } as InboxItem;
}

class FakeMesh {
  id = "self";
  attention: "open" | "dnd" | "focus" = "open";
  items: InboxItem[] = [];
  drained: string[] = [];
  statuses: Array<{ status: string; activity?: string }> = [];
  modes = new Map<string, "quiet" | "muted">();
  pullOnly = new Set<string>();

  peekInbox(scope: InboxScope = "all"): InboxItem[] {
    return this.items.filter((value) => scope === "all" || (scope === "pull-only") === this.pullOnly.has(value.id));
  }

  drainInbox(limit?: number): InboxItem[] {
    const count = limit && limit > 0 ? Math.min(limit, this.items.length) : this.items.length;
    const drained = this.items.splice(0, count);
    this.drained.push(...drained.map((value) => value.id));
    return drained;
  }

  drainInboxIds(ids: readonly string[]): ExactDrainResult {
    const wanted = new Set(ids);
    const drained = this.items.filter((value) => wanted.has(value.id));
    this.items = this.items.filter((value) => !wanted.has(value.id));
    this.drained.push(...drained.map((value) => value.id));
    for (const value of drained) this.pullOnly.delete(value.id);
    const present = new Set(drained.map((value) => value.id));
    return { items: drained, missingIds: [...wanted].filter((id) => !present.has(id)) };
  }

  channelMode(channel?: string): "quiet" | "muted" | undefined {
    return channel ? this.modes.get(channel) : undefined;
  }

  async setStatus(status: string, activity?: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, status === "working" && activity === "thinking" ? 3 : 0));
    this.statuses.push({ status, activity });
  }
}

class FakeHost implements PiHost {
  sent: Array<{ content: string; details: CotalBatchDetails }> = [];

  sendMessage(message: { content: string; details: CotalBatchDetails }): void {
    this.sent.push({ content: message.content, details: message.details });
  }
}

function context(signal?: AbortSignal): PiContextLike & { idle: boolean; notifications: string[]; shutdowns: number } {
  const value = {
    signal,
    idle: false,
    notifications: [] as string[],
    shutdowns: 0,
    hasUI: true,
    ui: {
      notify(message: string): void {
        value.notifications.push(message);
      },
    },
    isIdle(): boolean {
      return value.idle;
    },
    shutdown(): void {
      value.shutdowns++;
    },
  };
  return value;
}

function startBatch(driver: PiDriver, host: FakeHost): CotalBatchDetails {
  const details = host.sent.at(-1)?.details;
  assert.ok(details);
  driver.onMessageStart({ role: "custom", customType: "cotal-inbox", details });
  return details;
}

function confirm(driver: PiDriver, details: CotalBatchDetails): void {
  driver.onContext([{ role: "custom", customType: "cotal-inbox", details }]);
  driver.onProviderResponse(200);
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Exact-id commit, zero guard, eviction, interleaving, and late duplicate behavior.
{
  const mesh = new FakeMesh();
  const ledger = new InboxTurn(mesh);
  ledger.commitConfirmed([]);
  ok(mesh.drained.length === 0, "an empty commit must never call drainInbox(0)");

  mesh.items = [item("m2"), item("new")];
  const evicted = ledger.commitConfirmed(["m1", "m2"]);
  ok(evicted.drained === 1 && mesh.drained.at(-1) === "m2", "an older evicted id may precede an exact-id commit");

  mesh.items = [item("unrelated"), item("m4")];
  const exact = ledger.commitConfirmed(["m3", "m4"]);
  ok(exact.drained === 1 && exact.tombstoned === 1, "exact completion drains only the present confirmed id");
  ok(mesh.items[0]?.id === "unrelated", "exact completion never drains an unrelated physical prefix");

  mesh.items = [];
  ledger.commitConfirmed(["late"]);
  mesh.items.push(item("late"));
  ok(ledger.discardTombstoned() === 1, "a late duplicate of an absent confirmed id is not surfaced twice");

  mesh.items = [item("quiet", { kind: "channel", channel: "quiet" }), item("dm")];
  mesh.pullOnly.add("quiet");
  ledger.commitConfirmed(["buried-late"]);
  mesh.items.splice(1, 0, item("buried-late"));
  ok(ledger.discardTombstoned() === 1, "a pull-only item cannot bury a tombstoned late duplicate");
  ok(
    mesh.items.map((value) => value.id).join() === "quiet,dm" && mesh.peekInbox("automatic")[0]?.id === "dm",
    "exact tombstone cleanup preserves quiet traffic and leaves later automatic work deliverable",
  );
}

// Queue/start/provider confirmation is not acknowledgement; terminal completion is.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent, 20);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  ok(mesh.drained.length === 0, "custom message_start is queue confirmation, not acknowledgement");
  confirm(driver, details);
  ok(mesh.drained.length === 0, "provider acceptance alone waits for a terminal agent boundary");
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], ctx);
  ok(mesh.drained.join() === "m1", "a clean terminal boundary drains the exact confirmed prefix");
}

// Real Pi may expose the request context before all extensions observe message_start.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent, 20);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = host.sent.at(-1)?.details;
  assert.ok(details);
  driver.onAgentStart(ctx);
  driver.onContext([{ role: "custom", customType: "cotal-inbox", details }]);
  driver.onMessageStart({ role: "custom", customType: "cotal-inbox", details });
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], ctx);
  ok(
    mesh.drained.join() === "m1",
    "a clean terminal boundary confirms exact context even when context precedes message_start and no response hook fires",
  );
}

// Own channel echoes are dropped, while self-selected anycast remains valid directed traffic.
{
  const mesh = new FakeMesh();
  mesh.items = [
    item("echo", { kind: "channel", channel: "general", fromId: "self" }),
    item("self-anycast", { kind: "anycast", service: "worker", fromId: "self" }),
  ];
  const host = new FakeHost();
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(context());
  ok(mesh.drained[0] === "echo", "only an own channel multicast is treated as an echo");
  ok(host.sent[0]?.details.ids.join() === "self-anycast", "self-selected anycast is surfaced");
}

// A buried own echo cannot let older pull-only traffic block a later DM.
{
  const mesh = new FakeMesh();
  mesh.items = [
    item("quiet", { kind: "channel", channel: "quiet" }),
    item("echo", { kind: "channel", channel: "general", fromId: "self" }),
    item("dm"),
  ];
  mesh.pullOnly.add("quiet");
  const host = new FakeHost();
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(context());
  ok(mesh.drained.includes("echo"), "a buried own echo is discarded by exact id");
  ok(host.sent[0]?.details.ids.join() === "dm", "the DM passes older pull-only traffic and the buried echo");
  ok(mesh.items.some((value) => value.id === "quiet"), "quiet ambient remains buffered for explicit pull");
}

// Pi wake decisions use the receive-time lane, never the channel's current mode.
{
  const automatic = new FakeMesh();
  automatic.items = [item("auto", { kind: "channel", channel: "changing" })];
  automatic.modes.set("changing", "quiet");
  const automaticHost = new FakeHost();
  const automaticDriver = new PiDriver(automatic as unknown as MeshAgent);
  automaticDriver.bind(automaticHost);
  automaticDriver.onSessionStart(context());
  ok(automaticHost.sent[0]?.details.ids.join() === "auto", "normal→quiet does not strand receive-time automatic Pi traffic");

  const pulled = new FakeMesh();
  pulled.items = [item("pull", { kind: "channel", channel: "changing" })];
  pulled.pullOnly.add("pull");
  const pullHost = new FakeHost();
  const pullDriver = new PiDriver(pulled as unknown as MeshAgent);
  pullDriver.bind(pullHost);
  pullDriver.onSessionStart(context());
  ok(pullHost.sent.length === 0, "quiet→normal does not release receive-time pull-only Pi traffic");
}

// Mention and DM arrivals serialize behind one unconfirmed trigger.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(context());
  mesh.items.push(item("m2"));
  driver.onIncoming();
  driver.onMentionWake(item("mention", { kind: "channel", channel: "general", mentionsMe: true }));
  ok(host.sent.length === 1, "new traffic and a mention cannot race a second unconfirmed trigger");
}

// Abort retains even provider-confirmed work, holds new traffic, then a clean continuation commits.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const controller = new AbortController();
  const ctx = context(controller.signal);
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  driver.onAgentStart(ctx);
  confirm(driver, details);
  controller.abort();
  driver.onAgentEnd([{ role: "assistant", stopReason: "aborted" }], ctx);
  ok(driver.state === "held" && mesh.drained.length === 0, "abort retains confirmed work and enters held");
  mesh.items.push(item("m2"));
  driver.onIncoming();
  ok(host.sent.length === 1, "new traffic cannot auto-replay while held");
  const continuation = context();
  driver.onAgentStart(continuation);
  ok(host.sent.length === 2 && host.sent[1]?.details.ids.join() === "m2", "the next human turn carries held backlog");
  const next = startBatch(driver, host);
  confirm(driver, next);
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], continuation);
  ok(mesh.drained.join() === "m1,m2", "the later clean boundary commits retained and continued work once");
}

// An unconfirmed abort retains the same association and a later human provider call can confirm it.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const controller = new AbortController();
  const ctx = context(controller.signal);
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  driver.onAgentStart(ctx);
  controller.abort();
  driver.onAgentEnd([{ role: "assistant", stopReason: "aborted" }], ctx);
  ok(mesh.drained.length === 0, "abort before provider confirmation acknowledges nothing");
  const recovery = context();
  driver.onAgentStart(recovery);
  confirm(driver, details);
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], recovery);
  ok(mesh.drained.join() === "m1", "late confirmation resolves the retained association without re-dispatch");
}

// Error retention does not race a later overflow event, even across event-loop delays.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const controller = new AbortController();
  const ctx = context(controller.signal);
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  driver.onAgentStart(ctx);
  confirm(driver, details);
  controller.abort();
  driver.onAgentEnd([{ role: "assistant", stopReason: "error" }], ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  ok(driver.state === "held" && mesh.drained.length === 0, "an error end retains confirmed work without timer inference");
  driver.onBeforeCompact("overflow", true);
  await tick();
  ok(mesh.drained.length === 0, "a later overflow retry still cannot commit the retained batch");
  const retry = context();
  driver.onAgentStart(retry);
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], retry);
  ok(mesh.drained.join() === "m1", "the successful overflow continuation commits once");
}

// A non-overflow provider error may auto-retry after backoff without a before_compact event.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent, 20);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  driver.onAgentStart(ctx);
  driver.onContext([{ role: "custom", customType: "cotal-inbox", details }]);
  driver.onAgentEnd([{ role: "assistant", stopReason: "error" }], ctx);
  await driver.flushPresence();
  ok(driver.state === "held" && mesh.drained.length === 0, "an error waits without acknowledging before Pi's retry decision");
  const retry = context();
  driver.onAgentStart(retry);
  confirm(driver, details);
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], retry);
  ok(mesh.drained.join() === "m1" && driver.state === "idle", "the automatic retry commits only at its later clean boundary");
}

// An unconfirmed error with no automatic continuation remains observably held without a timer.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent, 20);
  driver.bind(host);
  driver.onSessionStart(ctx);
  startBatch(driver, host);
  driver.onAgentStart(ctx);
  driver.onAgentEnd([{ role: "assistant", stopReason: "error" }], ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await driver.flushPresence();
  ok(
    driver.state === "held" && mesh.drained.length === 0 && mesh.statuses.at(-1)?.status === "waiting",
    "an error without continuation stays held and visible without time-based acknowledgement",
  );
}

// Managed shutdown is absorbing even when Pi reports late lifecycle events.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  driver.onAgentStart(ctx);
  confirm(driver, details);
  await driver.flushPresence();
  const statusesBefore = mesh.statuses.length;
  driver.requestShutdown();
  driver.onAgentStart(ctx);
  driver.onContext([{ role: "custom", customType: "cotal-inbox", details }]);
  driver.onProviderResponse(200);
  driver.onToolStart("bash");
  driver.onToolEnd();
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], ctx);
  driver.onBeforeCompact("overflow", true);
  await driver.flushPresence();
  ok(ctx.shutdowns === 2, "shutdown reaches both the active context and any late agent start");
  ok(driver.state === "shuttingDown" && mesh.drained.length === 0, "late lifecycle cannot acknowledge or escape shutdown");
  ok(mesh.statuses.length === statusesBefore, "late lifecycle cannot publish presence after shutdown");

  const between = new PiDriver(new FakeMesh() as unknown as MeshAgent);
  between.requestShutdown();
  const replacement = context();
  between.onSessionStart(replacement);
  ok(replacement.shutdowns === 1 && between.state === "shuttingDown", "shutdown between sessions closes the replacement context");
}

// Unknown future stop reasons fail closed until an exact clean stop proves terminality.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  driver.onAgentStart(ctx);
  confirm(driver, details);
  driver.onAgentEnd([{ role: "assistant", stopReason: "future-reason" }], ctx);
  ok(driver.state === "held" && mesh.drained.length === 0, "a non-stop boundary cannot acknowledge confirmed work");
  const continuation = context();
  driver.onAgentStart(continuation);
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], continuation);
  ok(mesh.drained.join() === "m1", "an exact later stop resolves an unknown retained boundary");
}

// Known non-overflow terminal reasons commit and keep the headless peer live.
for (const assistant of [
  { role: "assistant", stopReason: "length", usage: { output: 12 } },
  { role: "assistant", stopReason: "toolUse" },
]) {
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  driver.onAgentStart(ctx);
  confirm(driver, details);
  mesh.items.push(item("m2"));
  driver.onAgentEnd([assistant], ctx);
  ok(mesh.drained.join() === "m1", `${assistant.stopReason} commits the confirmed terminal batch`);
  ok(host.sent.length === 2 && host.sent[1]?.details.ids.join() === "m2", `${assistant.stopReason} keeps dispatch live`);
}

// Pi's zero-output length overflow is not terminal and must wait for continuation.
{
  const mesh = new FakeMesh();
  mesh.items = [item("m1")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = startBatch(driver, host);
  driver.onAgentStart(ctx);
  confirm(driver, details);
  driver.onAgentEnd([{ role: "assistant", stopReason: "length", usage: { output: 0 } }], ctx);
  ok(driver.state === "held" && mesh.drained.length === 0, "zero-output length retains the overflow batch");
  driver.onBeforeCompact("overflow", true);
  const continuation = context();
  driver.onAgentStart(continuation);
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], continuation);
  ok(mesh.drained.join() === "m1", "the overflow-length continuation commits at its terminal boundary");
}

// Dispatch-start watchdog holds association and blocks competing delivery; late lifecycle still wins.
{
  const mesh = new FakeMesh();
  mesh.items = [item("slow")];
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh as unknown as MeshAgent, 5);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const details = host.sent[0]!.details;
  // Wait well past the 5ms watchdog so it has reliably FIRED before the assertion — a 10ms wait races
  // the 5ms timer on Windows' coarse (~15ms) granularity, where both round to the same tick.
  await new Promise((resolve) => setTimeout(resolve, 120));
  ok(driver.state === "held" && mesh.drained.length === 0, "watchdog expiry holds without acknowledgement");
  mesh.items.push(item("new"));
  driver.onIncoming();
  ok(host.sent.length === 1, "watchdog hold blocks a competing dispatch");
  driver.onMessageStart({ role: "custom", customType: "cotal-inbox", details });
  confirm(driver, details);
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], ctx);
  ok(mesh.drained.join() === "slow", "late lifecycle confirmation remains associated with the original batch");
}

// Presence writes complete in callback invocation order despite asynchronous operations.
{
  const mesh = new FakeMesh();
  const driver = new PiDriver(mesh as unknown as MeshAgent);
  const ctx = context();
  driver.bind(new FakeHost());
  driver.onSessionStart(ctx);
  driver.onAgentStart(ctx);
  driver.onToolStart("bash");
  driver.onToolEnd();
  await driver.flushPresence();
  ok(
    mesh.statuses.map(({ status, activity }) => `${status}:${activity ?? ""}`).join("|") ===
      "working:thinking|working:running bash|working:thinking",
    "presence writes preserve lifecycle invocation order",
  );
}

// Extension activation: unrelated operator settings are inert; partial managed control fails loud.
{
  const keys = [
    "COTAL_NAME",
    "COTAL_AGENT_FILE",
    "COTAL_LINK",
    "COTAL_HOME",
    "COTAL_DEFAULT_AGENT",
    "COTAL_CONTROL_SOCKET",
    "COTAL_CONTROL_TOKEN",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.COTAL_HOME = "/tmp/operator-setting";
  process.env.COTAL_DEFAULT_AGENT = "pi";
  await cotalMesh({} as ExtensionAPI);
  checks++;

  process.env.COTAL_NAME = "partial-control";
  process.env.COTAL_CONTROL_SOCKET = join(tmpdir(), "cotal-partial.sock");
  const compatibleApi = {
    sendMessage(): void {},
    registerMessageRenderer(): void {},
    on(): void {},
  } as unknown as ExtensionAPI;
  await assert.rejects(() => cotalMesh(compatibleApi), /COTAL_CONTROL_SOCKET is set but no control token could be resolved/);
  checks++;
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// buildLaunch keeps contributor model/persona precedence and rejects every unsupported surface.
{
  const root = mkdtempSync(join(tmpdir(), "cotal-pi-launch-"));
  const agentFile = join(root, "agent.md");
  writeFileSync(agentFile, "---\nname: pi-test\nmodel: file/model\n---\nPersona body\n");
  const previousGroq = process.env.GROQ_API_KEY;
  const previousSecret = process.env.UNRELATED_SECRET;
  process.env.GROQ_API_KEY = "groq-test";
  process.env.UNRELATED_SECRET = "must-not-forward";
  try {
    const launch = piConnector.buildLaunch({
      space: "test",
      name: "pi-test",
      model: "flag/model",
      configPath: agentFile,
      userAuth: { owner: "owner", actor: "actor", sentinelCredsPath: "/tmp/sentinel", bearerCmd: ["token"] },
    });
    ok(launch.args.includes("flag/model") && !launch.args.includes("file/model"), "spawn model overrides the agent file model");
    ok(launch.args.includes("--append-system-prompt"), "the frontmatter-stripped persona is forwarded by file");
    // `LaunchSpec.env` is optional on the interface; a managed Pi launch always carries one, so
    // bind it once and assert that, rather than reading through an optional at every cell.
    const env = launch.env;
    assert.ok(env, "a managed Pi launch carries a child env");
    // The user-mode identity is forwarded through the launch material, not the environment: the
    // sentinel creds path and the bearer command are this mode's credential, and a shell the seat
    // runs has no more business holding them than it has holding a creds file.
    ok(
      env.COTAL_OWNER === undefined && env.COTAL_ACTOR === undefined,
      "user-mode identity is NOT in the seat environment",
    );
    ok(
      readLaunchMaterial(env[LAUNCH_MATERIAL_ENV]).userAuth?.owner === "owner",
      "user-mode identity is forwarded through the launch material",
    );
    ok(env.GROQ_API_KEY === "groq-test" && !("UNRELATED_SECRET" in env), "only Pi provider keys are forwarded");
    ok(Boolean(launch.control?.path && launch.control.token), "managed Pi launches expose cooperative control");
    ok(launch.args.some((arg) => arg.endsWith("standalone.js")), "managed Pi launches use the standalone bundle");
    if (env.COTAL_PI_PERSONA_FILE) rmSync(dirname(env.COTAL_PI_PERSONA_FILE), { recursive: true, force: true });

    assert.throws(
      () => piConnector.buildLaunch({ space: "test", name: "pi", creds: "creds", userAuth: { owner: "o", actor: "a", sentinelCredsPath: "s", bearerCmd: ["b"] } }),
      /mutually exclusive/,
    );
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", resume: "session" }), /resume/);
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", variant: "high" }), /variant/);
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", mcpServers: { x: { command: "x" } } }), /MCP/);
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", launchOptions: { offline: true } }), /launch options/);
    // `--prompt` is Pi's positional initial message: delivered as the LAST argument (Pi's parser
    // takes any bare argument as a message, so it must follow every value-taking flag), and a
    // prompt Pi would misread (empty, an option, a file reference) refuses the launch.
    const prompted = piConnector.buildLaunch({ space: "test", name: "pi", model: "flag/model", prompt: "  say hello  " });
    ok(prompted.args[prompted.args.length - 1] === "say hello", "the initial prompt is Pi's last positional argument, trimmed");
    ok(prompted.args.indexOf("--model") === prompted.args.length - 3, "the prompt follows the value-taking flags");
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", prompt: "   " }), /empty/);
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", prompt: "-p run" }), /cannot start with/);
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", prompt: "@notes.md summarize" }), /cannot start with/);
    const unprompted = piConnector.buildLaunch({ space: "test", name: "pi", model: "flag/model" }).args;
    ok(unprompted[unprompted.length - 1] === "flag/model", "no prompt, no positional argument: the last argument is still the model value");
    checks += 11;
  } finally {
    if (previousGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroq;
    if (previousSecret === undefined) delete process.env.UNRELATED_SECRET;
    else process.env.UNRELATED_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`pi smoke: ${checks} checks passed`);

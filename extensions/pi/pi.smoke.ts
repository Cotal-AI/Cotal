import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InboxItem, MeshAgent } from "@cotal-ai/connector-core";
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

  peekInbox(): InboxItem[] {
    return [...this.items];
  }

  drainInbox(limit?: number): InboxItem[] {
    const count = limit && limit > 0 ? Math.min(limit, this.items.length) : this.items.length;
    const drained = this.items.splice(0, count);
    this.drained.push(...drained.map((value) => value.id));
    return drained;
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

// Prefix commit, zero guard, eviction, mismatch, and late duplicate behavior.
{
  const mesh = new FakeMesh();
  const ledger = new InboxTurn(mesh);
  ledger.commitConfirmed([]);
  ok(mesh.drained.length === 0, "an empty commit must never call drainInbox(0)");

  mesh.items = [item("m2"), item("new")];
  const evicted = ledger.commitConfirmed(["m1", "m2"]);
  ok(evicted.drained === 1 && mesh.drained.at(-1) === "m2", "an older evicted id may precede an exact front prefix");

  mesh.items = [item("unrelated"), item("m4")];
  const mismatch = ledger.commitConfirmed(["m3", "m4"]);
  ok(mismatch.drained === 0 && Boolean(mismatch.error), "a mismatch must acknowledge no unrelated message");
  ok(mesh.items[0]?.id === "unrelated", "the unrelated front message must remain buffered");
  mesh.drainInbox(1);
  ok(ledger.discardTombstonedFront() === 1, "the confirmed duplicate is discarded only after reaching the front");

  mesh.items = [];
  ledger.commitConfirmed(["late"]);
  mesh.items.push(item("late"));
  ok(ledger.discardTombstonedFront() === 1, "a late duplicate of an absent confirmed id is not surfaced twice");
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

// Abort commits only provider-confirmed work, holds new traffic, then a human turn recovers.
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
  ok(driver.state === "held" && mesh.drained.join() === "m1", "abort consumes confirmed work and enters held");
  mesh.items.push(item("m2"));
  driver.onIncoming();
  ok(host.sent.length === 1, "new traffic cannot auto-replay while held");
  driver.onAgentStart(context());
  ok(host.sent.length === 2 && host.sent[1]?.details.ids.join() === "m2", "the next human turn carries held backlog");
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

// agent_end precedes overflow events in Pi: defer ordinary error policy so retry is not acked early.
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
  driver.onAgentEnd([{ role: "assistant", stopReason: "error" }], ctx);
  driver.onBeforeCompact("overflow", true);
  await tick();
  ok(mesh.drained.length === 0, "overflow retry suppresses the deferred ordinary-error commit");
  const retry = context();
  driver.onAgentStart(retry);
  driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], retry);
  ok(mesh.drained.join() === "m1", "the successful overflow continuation commits once");
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
  await new Promise((resolve) => setTimeout(resolve, 10));
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
  await assert.rejects(() => cotalMesh(compatibleApi), /must be provided together/);
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
    ok(launch.env.COTAL_OWNER === "owner" && launch.env.COTAL_ACTOR === "actor", "user-mode identity is forwarded");
    ok(launch.env.GROQ_API_KEY === "groq-test" && !("UNRELATED_SECRET" in launch.env), "only Pi provider keys are forwarded");
    ok(Boolean(launch.control?.path && launch.control.token), "managed Pi launches expose cooperative control");
    ok(launch.args.some((arg) => arg.endsWith("standalone.js")), "managed Pi launches use the standalone bundle");
    if (launch.env.COTAL_PI_PERSONA_FILE) rmSync(dirname(launch.env.COTAL_PI_PERSONA_FILE), { recursive: true, force: true });

    assert.throws(
      () => piConnector.buildLaunch({ space: "test", name: "pi", creds: "creds", userAuth: { owner: "o", actor: "a", sentinelCredsPath: "s", bearerCmd: ["b"] } }),
      /mutually exclusive/,
    );
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", resume: "session" }), /resume/);
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", variant: "high" }), /variant/);
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", mcpServers: { x: { command: "x" } } }), /MCP/);
    assert.throws(() => piConnector.buildLaunch({ space: "test", name: "pi", launchOptions: { offline: true } }), /launch options/);
    checks += 5;
  } finally {
    if (previousGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroq;
    if (previousSecret === undefined) delete process.env.UNRELATED_SECRET;
    else process.env.UNRELATED_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`pi smoke: ${checks} checks passed`);

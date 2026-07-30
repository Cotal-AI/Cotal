import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { InboxItem } from "@cotal-ai/connector-core";
import {
  CodexBridge,
  type AppServerPeer,
  type BridgeAgent,
  type RpcMessage,
} from "../src/bridge.js";
import {
  AppServerRequestTimeoutError,
  AppServerResponseError,
} from "../src/rpc.js";

function item(id: string, text = id): InboxItem {
  return {
    id,
    ts: Date.now(),
    fromId: `peer-${id}`,
    fromName: "peer",
    kind: "dm",
    mentionsMe: false,
    historical: false,
    text,
  };
}

function channelItem(id: string, channel: string): InboxItem {
  return {
    ...item(id),
    kind: "channel",
    channel,
    mentionsMe: true,
  };
}

class FakeAgent extends EventEmitter implements BridgeAgent {
  inbox: InboxItem[] = [];
  readonly acked: string[] = [];
  readonly statuses: Array<[string, string | undefined]> = [];
  readonly pullOnlyIds = new Set<string>();

  peekInbox(scope: "all" | "automatic" | "pull-only" = "all"): InboxItem[] {
    return this.inbox.filter((candidate) =>
      scope === "all"
        ? true
        : scope === "pull-only"
          ? this.pullOnlyIds.has(candidate.id)
          : !this.pullOnlyIds.has(candidate.id),
    );
  }

  drainInboxIds(ids: readonly string[]): { items: InboxItem[]; missingIds: string[] } {
    const wanted = new Set(ids);
    const items = this.inbox.filter((candidate) => wanted.has(candidate.id));
    this.inbox = this.inbox.filter((candidate) => !wanted.has(candidate.id));
    this.acked.push(...items.map((candidate) => candidate.id));
    return { items, missingIds: ids.filter((id) => !items.some((candidate) => candidate.id === id)) };
  }

  async setStatus(status: "idle" | "working" | "waiting" | "offline", activity?: string): Promise<void> {
    this.statuses.push([status, activity]);
  }

  push(...items: InboxItem[]): void {
    this.inbox.push(...items);
    for (const candidate of items) this.emit("incoming", candidate);
  }

  pushPullOnly(...items: InboxItem[]): void {
    for (const candidate of items) this.pullOnlyIds.add(candidate.id);
    this.inbox.push(...items);
    for (const candidate of items) this.emit("incoming", candidate);
  }
}

class FakePeer extends EventEmitter implements AppServerPeer {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly replies: Array<{ id: string | number; result?: unknown; error?: unknown }> = [];
  rejectSteer = false;
  deferredSteer?: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };
  deferredTurnStart?: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  };
  nextTurn = 1;

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "initialize") return { userAgent: "fake" };
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") {
      if (this.deferredTurnStart) return this.deferredTurnStart.promise;
      return { turn: { id: `turn-${this.nextTurn++}`, status: "inProgress" } };
    }
    if (method === "turn/steer") {
      if (this.rejectSteer)
        throw new AppServerResponseError(-32600, "no active turn");
      if (this.deferredSteer) return this.deferredSteer.promise;
      return { turnId: params.expectedTurnId };
    }
    return {};
  }

  deferSteer(): void {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.deferredSteer = { promise, resolve, reject };
  }

  deferTurnStart(): void {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((res) => {
      resolve = res;
    });
    this.deferredTurnStart = { promise, resolve };
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.calls.push({ method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.replies.push({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.replies.push({ id, error: { code, message } });
  }

  notification(method: string, params: Record<string, unknown>): void {
    this.emit("notification", { method, params } satisfies RpcMessage);
  }

  serverRequest(id: number, method: string, params: Record<string, unknown>): void {
    this.emit("serverRequest", { id, method, params } satisfies RpcMessage);
  }
}

async function startedBridge(opts: { activate?: boolean } = {}): Promise<{
  agent: FakeAgent;
  peer: FakePeer;
  bridge: CodexBridge;
  fatals: Error[];
}> {
  const agent = new FakeAgent();
  const peer = new FakePeer();
  const fatals: Error[] = [];
  const bridge = new CodexBridge({
    peer,
    agent,
    onFatal: (error) => fatals.push(error),
  });
  await bridge.start();
  if (opts.activate !== false) bridge.activate();
  return { agent, peer, bridge, fatals };
}

test("queues startup traffic and acks only after successful completion", async () => {
  const agent = new FakeAgent();
  const peer = new FakePeer();
  const bridge = new CodexBridge({ peer, agent });
  agent.push(item("m1"));

  await bridge.start();
  assert.equal(peer.calls.some((call) => call.method === "turn/start"), false);
  bridge.activate();
  await bridge.settled();
  const turnStart = peer.calls.find((call) => call.method === "turn/start");
  assert.equal(turnStart?.params.threadId, "thread-1");
  assert.deepEqual(agent.acked, []);

  peer.notification("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  await bridge.settled();
  assert.deepEqual(agent.acked, ["m1"]);
});

test("steers an active turn and keeps the steered batch unacked until completion", async () => {
  const { agent, peer, bridge } = await startedBridge();
  peer.notification("turn/started", { threadId: "thread-1", turn: { id: "turn-live" } });
  agent.push(item("m2"));
  await bridge.settled();

  const steer = peer.calls.find((call) => call.method === "turn/steer");
  assert.equal(steer?.params.expectedTurnId, "turn-live");
  assert.deepEqual(agent.acked, []);

  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "completed" },
  });
  await bridge.settled();
  assert.deepEqual(agent.acked, ["m2"]);
});

test("does not replay a steer accepted across a completion-response race", async () => {
  const { agent, peer, bridge } = await startedBridge();
  peer.notification("turn/started", { threadId: "thread-1", turn: { id: "turn-live" } });
  peer.deferSteer();
  agent.push(item("raced"));
  await new Promise((resolve) => setImmediate(resolve));

  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "completed" },
  });
  peer.deferredSteer?.resolve({ turnId: "turn-live" });
  await bridge.settled();

  assert.deepEqual(agent.acked, ["raced"]);
  assert.equal(peer.calls.filter((call) => call.method === "turn/start").length, 0);
});

test("fails closed when a timed-out steer has an uncertain outcome", async () => {
  const { agent, peer, bridge, fatals } = await startedBridge();
  peer.notification("turn/started", { threadId: "thread-1", turn: { id: "turn-live" } });
  peer.deferSteer();
  agent.push(item("uncertain"));
  await new Promise((resolve) => setImmediate(resolve));

  peer.deferredSteer?.reject(
    new AppServerRequestTimeoutError("turn/steer", 15_000),
  );
  await bridge.settled();
  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "completed" },
  });
  await bridge.settled();

  assert.deepEqual(agent.acked, []);
  assert.equal(peer.calls.filter((call) => call.method === "turn/start").length, 0);
  assert.match(fatals[0]?.message ?? "", /outcome is uncertain/);
});

test("fails closed if a concurrent turn replaces a just-started mesh turn", async () => {
  const { agent, peer, bridge, fatals } = await startedBridge();
  peer.deferTurnStart();
  agent.push(item("diverged"));
  await new Promise((resolve) => setImmediate(resolve));

  peer.notification("turn/started", {
    threadId: "thread-1",
    turn: { id: "human-turn" },
  });
  peer.deferredTurnStart?.resolve({
    turn: { id: "mesh-turn", status: "inProgress" },
  });
  await bridge.settled();

  assert.deepEqual(agent.acked, []);
  assert.match(fatals[0]?.message ?? "", /started mesh turn.*human-turn/);
});

test("a human-only interrupted turn does not tear down the connector", async () => {
  const { peer, bridge, fatals } = await startedBridge();
  peer.notification("turn/started", {
    threadId: "thread-1",
    turn: { id: "human-turn" },
  });
  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "human-turn", status: "interrupted" },
  });
  await bridge.settled();

  assert.deepEqual(fatals, []);
});

test("keeps pull-only inbox traffic out of automatic turns", async () => {
  const { agent, peer, bridge } = await startedBridge();
  agent.pushPullOnly(item("quiet"));
  await bridge.settled();

  assert.equal(peer.calls.some((call) => call.method === "turn/start"), false);
  assert.deepEqual(agent.acked, []);
  assert.deepEqual(agent.peekInbox("pull-only").map(({ id }) => id), ["quiet"]);
});

test("applies effort to the thread as well as connector-started turns", async () => {
  const agent = new FakeAgent();
  const peer = new FakePeer();
  const bridge = new CodexBridge({
    peer,
    agent,
    effort: "high",
    threadConfig: { model_context_window: 123 },
  });
  await bridge.start();

  const threadStart = peer.calls.find((call) => call.method === "thread/start");
  assert.deepEqual(threadStart?.params.config, {
    model_context_window: 123,
    model_reasoning_effort: "high",
  });
});

test("keeps DM senders and channels in separate turn scopes", async () => {
  const { agent, peer, bridge } = await startedBridge();
  peer.notification("turn/started", { threadId: "thread-1", turn: { id: "turn-live" } });
  const secondDm = item("dm-b");
  secondDm.fromId = "peer-dm-a";
  agent.push(item("dm-a"), channelItem("channel-a", "general"), secondDm);
  await bridge.settled();

  const firstSteer = peer.calls.find((call) => call.method === "turn/steer");
  const firstText = (
    firstSteer?.params.input as Array<{ type: string; text: string }>
  )[0].text;
  assert.match(firstText, /dm-a/);
  assert.match(firstText, /dm-b/);
  assert.doesNotMatch(firstText, /channel-a/);

  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "completed" },
  });
  await bridge.settled();
  const nextStart = peer.calls.find((call) => call.method === "turn/start");
  const nextText = (
    nextStart?.params.input as Array<{ type: string; text: string }>
  )[0].text;
  assert.match(nextText, /channel-a/);
});

test("steering rejection falls back safely and a failed turn forces recovery", async () => {
  const { agent, peer, bridge, fatals } = await startedBridge();
  peer.notification("turn/started", { threadId: "thread-1", turn: { id: "turn-live" } });
  peer.rejectSteer = true;
  agent.push(item("m3"));
  await bridge.settled();
  assert.deepEqual(agent.acked, []);

  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "completed" },
  });
  peer.rejectSteer = false;
  await bridge.settled();
  assert.equal(peer.calls.filter((call) => call.method === "turn/start").length, 1);

  peer.notification("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "failed" },
  });
  await bridge.settled();
  assert.deepEqual(agent.acked, []);
  assert.equal(peer.calls.filter((call) => call.method === "turn/start").length, 1);
  assert.match(fatals[0]?.message ?? "", /ended failed/);
});

test("rejects server requests for another thread", async () => {
  const agent = new FakeAgent();
  const toolPeer = new FakePeer();
  const bridge = new CodexBridge({ peer: toolPeer, agent });
  await bridge.start();

  toolPeer.serverRequest(10, "item/commandExecution/requestApproval", {
    threadId: "other",
    turnId: "turn-1",
  });
  await bridge.settled();
  assert.deepEqual(toolPeer.replies[0], {
    id: 10,
    error: { code: -32602, message: "request belongs to another Cotal thread" },
  });
});

test("presence, interrupt, and shutdown follow explicit app-server events", async () => {
  const { agent, peer, bridge } = await startedBridge();
  peer.notification("turn/started", { threadId: "thread-1", turn: { id: "turn-live" } });
  peer.serverRequest(7, "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-live",
    itemId: "cmd-1",
  });
  peer.notification("serverRequest/resolved", { threadId: "thread-1", requestId: 7 });
  await bridge.interrupt();
  peer.notification("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "interrupted" },
  });
  await bridge.stop();

  assert.deepEqual(
    agent.statuses.map(([status]) => status),
    ["idle", "working", "waiting", "working", "idle", "offline"],
  );
  assert.deepEqual(peer.calls.find((call) => call.method === "turn/interrupt"), {
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-live" },
  });
  assert.deepEqual(
    peer.calls.find((call) => call.method === "thread/backgroundTerminals/clean"),
    {
      method: "thread/backgroundTerminals/clean",
      params: { threadId: "thread-1" },
    },
  );
});

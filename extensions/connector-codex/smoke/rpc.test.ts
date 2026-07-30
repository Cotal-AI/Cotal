import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AppServerClient, type RpcSocket } from "../src/rpc.js";

class FakeSocket extends EventEmitter implements RpcSocket {
  readonly sent: string[] = [];
  readyState = 1;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

function harness(timeout = 100): {
  client: AppServerClient;
  socket: FakeSocket;
} {
  const socket = new FakeSocket();
  const client = new AppServerClient({
    socket,
    requestTimeoutMs: timeout,
  });
  return { client, socket };
}

test("correlates responses and surfaces notifications/server requests", async () => {
  const { client, socket } = harness();
  const notifications: unknown[] = [];
  const requests: unknown[] = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("serverRequest", (message) => requests.push(message));

  const pending = client.request("initialize", { clientInfo: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(socket.sent[0], /"method":"initialize"/);
  socket.receive({ id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });

  socket.receive({ method: "turn/started", params: { threadId: "t" } });
  socket.receive({ id: 7, method: "item/tool/call", params: { tool: "cotal_dm" } });
  assert.equal(notifications.length, 1);
  assert.equal(requests.length, 1);
});

test("times out requests and rejects every pending request when the transport closes", async () => {
  const timeoutHarness = harness(10);
  await assert.rejects(
    timeoutHarness.client.request("turn/start"),
    /timed out after 10ms: turn\/start/,
  );

  const closeHarness = harness();
  const first = closeHarness.client.request("thread/start");
  const second = closeHarness.client.request("model/list");
  closeHarness.socket.emit("error", new Error("socket crashed"));
  await assert.rejects(first, /socket crashed/);
  await assert.rejects(second, /socket crashed/);
});

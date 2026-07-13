import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExactDrainResult, InboxItem, InboxScope, MeshAgent } from "@cotal-ai/connector-core";
import { startBridgeServer } from "../src/bridge.js";

const dir = mkdtempSync(join(tmpdir(), "cotal-hermes-quiet-"));
const socketPath = join(dir, "bridge.sock");

class FakeAgent extends EventEmitter {
  attention = "open" as const;
  items: InboxItem[] = [
    { id: "quiet", ts: 1, fromId: "q", fromName: "Quiet", kind: "channel", channel: "quiet", mentionsMe: false, historical: false, text: "quiet body" },
    { id: "dm", ts: 2, fromId: "d", fromName: "Direct", kind: "dm", mentionsMe: false, historical: false, text: "dm body" },
  ];
  pullOnly = new Set(["quiet"]);

  peekInbox(scope: InboxScope = "all"): InboxItem[] {
    return this.items.filter((item) => scope === "all" || (scope === "pull-only") === this.pullOnly.has(item.id));
  }

  drainInbox(_limit?: number, scope: InboxScope = "all"): InboxItem[] {
    const selected = this.peekInbox(scope);
    return this.remove(selected.map((item) => item.id)).items;
  }

  drainInboxIds(ids: readonly string[]): ExactDrainResult {
    return this.remove(ids);
  }

  inboxCount(scope: InboxScope = "all"): number {
    return this.peekInbox(scope).length;
  }

  recallAmbient(): Promise<{ items: InboxItem[]; droppedChannels: string[] }> {
    return Promise.resolve({ items: [], droppedChannels: [] });
  }

  private remove(ids: readonly string[]): ExactDrainResult {
    const wanted = new Set(ids);
    const items = this.items.filter((item) => wanted.has(item.id));
    this.items = this.items.filter((item) => !wanted.has(item.id));
    const present = new Set(items.map((item) => item.id));
    return { items, missingIds: [...wanted].filter((id) => !present.has(id)) };
  }
}

const config = {
  space: "hermes-quiet",
  name: "Hermes",
  id: "hermes",
  servers: "nats://127.0.0.1:1",
  subscribe: ["quiet"],
  allowSubscribe: ["quiet"],
  allowPublish: ["quiet"],
  kind: "agent" as const,
  tls: false,
};

const agent = new FakeAgent();
const bridge = startBridgeServer(agent as unknown as MeshAgent, config, socketPath);

try {
  for (let i = 0; i < 50; i++) {
    try {
      const probe = connect(socketPath);
      await once(probe, "connect");
      probe.destroy();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const client = connect(socketPath);
  await once(client, "connect");
  client.setEncoding("utf8");
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  client.on("data", (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      buffer = buffer.slice(newline + 1);
    }
  });
  const waitFrame = async (predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 100; i++) {
      const frame = frames.find(predicate);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for bridge frame: ${JSON.stringify(frames)}`);
  };

  client.write(JSON.stringify({ t: "subscribe" }) + "\n");
  const incoming = await waitFrame((frame) => frame.t === "incoming");
  assert.equal((incoming.msg as { id?: string }).id, "dm", "older quiet ambient must not block or join automatic Hermes delivery");

  client.write(JSON.stringify({ t: "tool", id: "pull", name: "cotal_inbox", args: {} }) + "\n");
  const tool = await waitFrame((frame) => frame.t === "tool_result" && frame.id === "pull");
  assert.match(String(tool.text), /quiet body/, "cotal_inbox must destructively surface quiet ambient");
  assert.deepEqual(agent.items.map((item) => item.id), ["dm"], "the pull must leave connector-managed automatic traffic untouched");

  client.write(JSON.stringify({ t: "delivered", id: "dm" }) + "\n");
  for (let i = 0; i < 50 && agent.items.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(agent.items.length, 0, "Hermes completion must exact-ack the delivered DM");
  client.destroy();
  console.log("✓ hermes quiet bridge: pull-only traffic is isolated from automatic delivery");
} finally {
  bridge.close();
  rmSync(dir, { recursive: true, force: true });
}

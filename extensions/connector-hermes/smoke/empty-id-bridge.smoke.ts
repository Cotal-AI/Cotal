/**
 * HERMES UNWEDGES ON AN EMPTY-ID MESSAGE (Cotal #624, finding (h)).
 *
 * THE WEDGE, as found at the graded sha: the bridge pumps one automatic delivery at a time and
 * holds its address in `awaitingId`; the Python sidecar acks `delivered` for the message it was
 * handed; the bridge clears the hold ONLY when the ack's id matches. Both sides keyed the WIRE id:
 * - the sidecar's truthiness gate (`if mid:`) drops an empty id, so it never acks;
 * - the bridge's own guard (`frame.id && frame.id === awaitingId`) also treats "" as falsy.
 * One surfaced message with id "" therefore wedged the bridge forever: no further pump, no clear,
 * until a sidecar resubscribe. The single worst consequence found in review.
 *
 * THE FIX: the address is the per-delivery receive key (`InboxItem.recvKey`), which is never "" for
 * any delivery (minted for id-less ones) and never a dedup key. The wire item carries it, the
 * sidecar echoes it, the bridge matches it exactly.
 *
 * This suite drives the REAL bridge server over its real unix socket with a fake MeshAgent (the
 * same shape bridge-quiet.smoke.ts uses), and asserts, for an empty-id delivery:
 *   1. the pump surfaces it (no starvation before the wedge would even fire);
 *   2. the sidecar-style ack with recvKey (and empty wire id) CLEARS the hold and retires the
 *      delivery (drainInboxDeliveries by receive key);
 *   3. a SECOND empty-id message is then pumped and retired in turn: the wedge is gone, not
 *      one-shot-unwedged;
 *   4. the pre-fix ack shape (wire id "", the falsy one) is NOT what the bridge keys on anymore.
 *
 * Run: pnpm smoke:hermes-empty-id   (in-process unix socket, no broker)
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExactDrainResult, InboxItem, InboxScope, MeshAgent } from "@cotal-ai/connector-core";
import { startBridgeServer } from "../src/bridge.js";

const dir = mkdtempSync(join(tmpdir(), "hermes-empty-id"));
const socketPath = join(dir, "bridge.sock");

/** The fake agent: same surface bridge-quiet uses, plus a minted recvKey like the real MeshAgent. */
class FakeAgent {
  items: InboxItem[] = [];
  drained: string[] = [];
  peekInbox(scope: InboxScope = "all"): InboxItem[] {
    return this.items.filter((item) => scope === "all" || (scope === "pull-only") === false);
  }
  drainInboxDeliveries(ids: readonly string[]): ExactDrainResult {
    const wanted = new Set(ids);
    const items = this.items.filter((item) => wanted.has(item.recvKey));
    this.items = this.items.filter((item) => !wanted.has(item.recvKey));
    this.drained.push(...items.map((item) => item.recvKey));
    const present = new Set(items.map((item) => item.recvKey));
    return { items, missingKeys: [...wanted].filter((key) => !present.has(key)) };
  }
  inboxCount(scope: InboxScope = "all"): number { return this.peekInbox(scope).length; }
  recallAmbient(): Promise<{ items: InboxItem[]; droppedChannels: string[] }> {
    return Promise.resolve({ items: [], droppedChannels: [] });
  }
  answersQuestion(): boolean { return false; }
  private listeners: Array<() => void> = [];
  on(_ev: string, fn: () => void) { if (_ev === "incoming" || _ev === "wake") this.listeners.push(fn); }
  emitIncoming() { for (const fn of this.listeners) fn(); }
}
// The real minted shape: an id-less delivery gets rx1, rx2, ... in arrival order.
let seq = 0;
const emptyIdDelivery = (text: string): InboxItem => ({
  id: "", recvKey: `rx${++seq}`, ts: Date.now(), fromId: "p", fromName: "Peer",
  kind: "channel", channel: "general", mentionsMe: false, historical: false, text,
});

import type { AgentConfig } from "@cotal-ai/connector-core";

const config = {
  space: "hermes-empty-id", name: "Hermes", role: "reviewer",
  servers: "nats://127.0.0.1:1", subscribe: ["general"], allowSubscribe: ["general"],
  allowPublish: ["general"], kind: "agent" as const, tls: false,
};

const agent = new FakeAgent();
const TOKEN = "empty-id-bridge-token";
const bridge = startBridgeServer(agent as unknown as MeshAgent, config as AgentConfig, socketPath, TOKEN);

try {
  for (let i = 0; i < 50; i++) {
    try { const probe = connect(socketPath); await once(probe, "connect"); probe.destroy(); break; }
    catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  const client = connect(socketPath);
  await once(client, "connect");
  client.setEncoding("utf8");
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  client.on("data", (chunk) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      buffer = buffer.slice(nl + 1);
    }
  });
  const waitFrame = async (pred: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 100; i++) {
      const f = frames.find(pred);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for bridge frame: ${JSON.stringify(frames)}`);
  };

  // ---- 0a) a subscribe with no token is dropped before it becomes the adapter ----
  {
    const raw = connect(socketPath);
    await once(raw, "connect");
    raw.write(JSON.stringify({ t: "subscribe" }) + "\n");
    await once(raw, "close");
    agent.emitIncoming(); // nothing to receive it: the connection never became the adapter
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(frames.length, 0, "no frame reaches a connection that never authenticated");
  }

  // ---- 0b) a tool frame from an unauthenticated connection gets no tool_result ----
  {
    const raw = connect(socketPath);
    await once(raw, "connect");
    let sawResult = false;
    raw.setEncoding("utf8");
    raw.on("data", (d) => { if (String(d).includes("tool_result")) sawResult = true; });
    raw.write(JSON.stringify({ t: "tool", id: "x", name: "cotal_send", args: {} }) + "\n");
    await once(raw, "close");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sawResult, false, "a tool frame before auth gets no tool_result");
  }

  // ---- 0c) a subscribe with a wrong token is dropped ----
  {
    const raw = connect(socketPath);
    await once(raw, "connect");
    raw.write(JSON.stringify({ t: "subscribe", token: "wrong" }) + "\n");
    await once(raw, "close");
  }

  client.write(JSON.stringify({ t: "subscribe", token: TOKEN }) + "\n");

  // ---- 1) an empty-id message is pumped like any other ----
  agent.items.push(emptyIdDelivery("first empty-id body"));
  agent.emitIncoming(); // the real MeshAgent fires "incoming" per buffered arrival
  const first = await waitFrame((f) => f.t === "incoming");
  const firstMsg = first.msg as { id?: string; recvKey?: string; historical?: boolean };
  assert.equal(firstMsg.id, "", "the empty wire id rides the wire item");
  assert.strictEqual(firstMsg.historical, false, "the wire item carries the historical flag, so the sidecar can frame a backfill (#2205)");
  assert.ok(typeof firstMsg.recvKey === "string" && firstMsg.recvKey !== "", "the wire item carries a minted receive key");

  // ---- 2) the ack the sidecar sends (by receive key, wire id empty) clears the hold ----
  client.write(JSON.stringify({ t: "delivered", id: "", recvKey: firstMsg.recvKey }) + "\n");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(agent.drained, [firstMsg.recvKey], "the empty-id delivery is retired by its receive key (no wedge)");
  assert.equal(agent.items.length, 0, "the inbox is empty: the hold cleared and the drain ran");

  // ---- 3) a SECOND empty-id message is pumped and retired in turn ----
  agent.items.push(emptyIdDelivery("second empty-id body"));
  agent.emitIncoming(); // the real MeshAgent fires "incoming" per buffered arrival
  const second = await waitFrame((f) => f.t === "incoming" && (f.msg as { recvKey?: string }).recvKey !== firstMsg.recvKey);
  const secondKey = (second.msg as { recvKey: string }).recvKey;
  client.write(JSON.stringify({ t: "delivered", recvKey: secondKey }) + "\n");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(agent.drained, [firstMsg.recvKey, secondKey], "the second empty-id delivery is retired too: not a one-shot unwedge");

  client.destroy();

  // ---- 4) the REAL Python client's ack retires the delivery (#2237) ----
  // Cells 2-3 write the ack frame by hand, so they cannot see which field the shipped client
  // puts the key in. Here the plugin's own BridgeClient subscribes, receives one item, and acks
  // it through `delivered()` exactly as the adapter does; the bridge must drain that key.
  const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
  assert.ok(python, "python is on PATH, so the real client's ack can be driven at all");
  const pluginDir = fileURLToPath(new URL("../plugin", import.meta.url));
  const script = [
    "import sys, threading",
    "sys.path.insert(0, sys.argv[1])",
    "from cotal.bridge_client import BridgeClient",
    "c = BridgeClient(sys.argv[2])",
    "done = threading.Event()",
    "def on_incoming(m):",
    "    c.delivered(m['recvKey'])",
    "    done.set()",
    "c.start(on_incoming)",
    "sys.exit(0 if done.wait(10) else 3)",
  ].join("\n");
  agent.items.push(emptyIdDelivery("third body, acked by the real client"));
  const thirdKey = agent.items[agent.items.length - 1].recvKey;
  // Whatever runs this suite may be a managed agent session, so the inherited environment can carry
  // a live credential and a live broker URL. Strip every COTAL_ key from the copy before the child
  // sees it; the control token set below is the only one this client reads.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];
  const py = spawn(python!, ["-c", script, pluginDir, socketPath], {
    env: { ...childEnv, COTAL_CONTROL_TOKEN: TOKEN }, stdio: ["ignore", "inherit", "inherit"],
  });
  const [code] = (await once(py, "exit")) as [number | null];
  assert.equal(code, 0, "the real client subscribed and surfaced the pending item");
  for (let i = 0; i < 50 && !agent.drained.includes(thirdKey); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(agent.drained, [firstMsg.recvKey, secondKey, thirdKey], "the real client's delivered() ack names the receive key the bridge matches (#2237)");

  console.log("✓ hermes empty-id bridge: unauthenticated connections are dropped; the legit client still receives incoming after authenticating; id-less deliveries pump, ack, and unwedge by receive key; the real Python client's ack retires its delivery");
} finally {
  bridge.close();
  rmSync(dir, { recursive: true, force: true });
}

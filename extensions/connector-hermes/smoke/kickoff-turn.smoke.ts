/**
 * A turn in the user's own words, handed to the gateway over the bridge (`submitTurn` in
 * src/bridge.ts): the launch's initial prompt is the first. It waits for an adapter, goes out once,
 * and settles on the adapter's answer. A turn whose adapter disconnects before answering is not
 * handed to the next one, because whether the gateway started it cannot be known.
 */
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, MeshAgent } from "@cotal-ai/connector-core";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { startBridgeServer } from "../src/bridge.js";
import { bridgeKey, openBridge } from "./bridge-open.js";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`  x FAIL: ${name}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  }
};

/** An agent with an empty inbox: the bridge pushes no mesh message, only turns. */
class EmptyAgent extends EventEmitter {
  inboxPreview() {
    return [];
  }
}

const dir = mkdtempSync(join(tmpdir(), "cotal-hermes-turn-"));
const socketPath = join(dir, "bridge.sock");
const key = "turn-smoke-control-key";
const config = {
  space: "hermes-turn", name: "Hermes", servers: "nats://127.0.0.1:1", subscribe: ["general"],
  allowSubscribe: ["general"], allowPublish: ["general"], kind: "agent" as const, tls: false,
};
const bridge = startBridgeServer(new EmptyAgent() as unknown as MeshAgent, config as AgentConfig, socketPath, bridgeKey(socketPath, key));

/** Connect and subscribe as the adapter; collect the frames the sidecar sends. */
async function adapter(): Promise<{ sock: Socket; frames: Record<string, unknown>[]; next: () => Promise<Record<string, unknown>> }> {
  const sock = connect(socketPath);
  await once(sock, "connect");
  const frames: Record<string, unknown>[] = [];
  let read = 0;
  let waiter: (() => void) | undefined;
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      frames.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      buf = buf.slice(nl + 1);
    }
    waiter?.();
  });
  await openBridge(sock, key);
  const next = async (): Promise<Record<string, unknown>> => {
    while (read >= frames.length) await new Promise<void>((resolve) => (waiter = resolve));
    return frames[read++]!;
  };
  return { sock, frames, next };
}
const send = (sock: Socket, frame: Record<string, unknown>) => sock.write(`${JSON.stringify(frame)}\n`);
const outcome = (p: Promise<void>) => p.then(() => "taken", (e: Error) => e.message);

try {
  // Submitted before any adapter exists, as the launcher does with the initial prompt.
  const first = outcome(bridge.submitTurn("run the checks"));
  const a = await adapter();
  const turn = await a.next();
  check("the turn goes to the adapter once it subscribes, as the user's text", turn.t === "turn" && turn.text === "run the checks" && typeof turn.id === "string", turn);
  send(a.sock, { t: "turn_taken", id: turn.id });
  check("it resolves when the gateway took it", (await first) === "taken");

  const refused = outcome(bridge.submitTurn("second"));
  const t2 = await a.next();
  send(a.sock, { t: "turn_refused", id: t2.id, error: "no session" });
  check("a turn the gateway refused rejects with its reason", /did not take the turn: no session/.test(await refused));

  const lost = outcome(bridge.submitTurn("third"));
  await a.next();
  a.sock.destroy();
  check("a turn whose adapter left before answering rejects as unknown", /whether it started is unknown/.test(await lost));

  const b = await adapter();
  await new Promise((r) => setTimeout(r, 200));
  check("a reconnecting adapter is not handed that turn again", b.frames.every((f) => f.t !== "turn"), b.frames);
  b.sock.destroy();
} finally {
  await bridge.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`hermes kickoff turn: ${pass} passed, ${fail} failed`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);

import { readFileSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

const [mode, file] = process.argv.slice(2);
if (mode === "parent") {
  const child = fork(new URL(import.meta.url), ["consumer", file], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.on("message", (message) => process.send?.(message));
  process.send?.({ childPid: child.pid });
  setInterval(() => {}, 1_000);
} else {
  const { config, ready } = JSON.parse(readFileSync(file, "utf8")) as { config: AgentConfig; ready: string };
  const agent = new MeshAgent(config);
  agent.on("log", () => {});
  agent.on("incoming", () => {
    const messages = agent.drainInbox();
    for (const m of messages) process.send?.({ received: m.id });
    writeFileSync(`${ready}.receipts`, JSON.stringify(messages.map((m) => m.id)));
  });
  try {
    await agent.start(20);
    writeFileSync(ready, String(process.pid));
    process.send?.({ ready: true, pid: process.pid });
  } catch (error) {
    process.send?.({ refused: (error as Error).message });
    process.exit(1);
  }
  process.on("message", (message: { reconnect?: boolean }) => {
    if (message.reconnect) void agent.reconnect().then((result) => process.send?.({ reconnected: result.ok }));
  });
  const stop = async () => { await agent.stop(); process.exit(0); };
  process.on("SIGTERM", () => void stop());
}

/**
 * The stored-copy notice (#5404).
 *
 * When the endpoint says this session's stored copies reached their limit, the next cotal_inbox reply
 * carries one line in either attention mode. A peek keeps the notice for the next read, and the read
 * that carries it clears it.
 *
 * No broker: a real MeshAgent that never starts, whose own endpoint emits the event. channel-family-auth
 * covers the endpoint saying it against a real broker. Focus mode is entered by stubbing the attention
 * getter and recall, since entering it for real needs a connection.
 *
 * Run: `pnpm smoke:stored-copies-notice`
 */
import { MeshAgent } from "../src/agent.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import type { AgentConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? extra : "");
  }
};

const cfg: AgentConfig = {
  space: "notice",
  name: "fred",
  servers: "nats://127.0.0.1:4222",
  subscribe: ["flood.>"],
  allowSubscribe: ["flood.>"],
  allowPublish: [],
  kind: "agent",
  tls: false,
};
const agent = new MeshAgent(cfg);
agent.on("error", () => {});
const inbox = cotalToolSpecs(cfg, "smoke").find((s) => s.name === "cotal_inbox")!;
const read = async (args: { peek?: boolean } = {}) => (await inbox.run(agent, cfg, args)).text;
const NOTE = "Your stored copies reached their limit of 1000, so earlier channel posts may have been dropped before they reached you.";
const count = (text: string) => text.split(NOTE).length - 1;

const quiet = await read();
check("before the endpoint says anything, cotal_inbox has no stored-copy notice", count(quiet) === 0, quiet);

agent.ep.emit("stored-copies-full");
check("the endpoint's stored-copies-full event marks the session", agent.storedCopiesFull === true);
const peeked = await read({ peek: true });
check("a peek carries the notice once and keeps it", count(peeked) === 1 && agent.storedCopiesFull === true, peeked);
const first = await read();
check("the next read carries the notice once", count(first) === 1, first);
check(
  "the notice points to channel history and its own bound",
  first.includes("Channel history may still hold them: `cotal history <channel>` reads it, and it keeps the newest 1000 posts per sender on each channel."),
  first,
);
const second = await read();
check("the read after it does not repeat it", count(second) === 0 && agent.storedCopiesFull === false, second);

// Focus mode reads recall instead of the live buffer; the notice rides there too.
Object.defineProperty(agent, "attention", { get: () => "focus" });
(agent as unknown as { recallAmbient: MeshAgent["recallAmbient"] }).recallAmbient = async () => ({ items: [], droppedChannels: [] });
agent.ep.emit("stored-copies-full");
const focused = await read();
check("in focus mode the next read carries the notice once", count(focused) === 1, focused);
const focusedAgain = await read();
check("in focus mode the read after it does not repeat it", count(focusedAgain) === 0, focusedAgain);

console.log(`\nSTORED-COPIES-NOTICE SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

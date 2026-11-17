/**
 * The stored-copy notice (#5404).
 *
 * When the endpoint says this session's stored copies reached their limit, the next cotal_inbox reply
 * carries one line in either attention mode, naming the count the endpoint reported, whether it
 * shows messages or reports an empty inbox. A peek keeps the notice for the next read, and the read
 * that carries it clears it. A read that throws, or whose caller goes before the reply, keeps it, and a
 * limit seen while a reply is being built is said by the next read.
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
const noteAt = (limit: number) => `Your stored copies reached their limit of ${limit}, so earlier channel posts may have been dropped before they reached you.`;
const NOTE = noteAt(1000);
const count = (text: string) => text.split(NOTE).length - 1;
const full = (limit = 1000) => agent.ep.emit("stored-copies-full", { limit });

const quiet = await read();
check("before the endpoint says anything, cotal_inbox has no stored-copy notice", count(quiet) === 0, quiet);

full();
check("the endpoint's stored-copies-full event marks the session", agent.storedCopiesFull > 0);
const peeked = await read({ peek: true });
check("a peek carries the notice once and keeps it", count(peeked) === 1 && agent.storedCopiesFull > 0, peeked);
const first = await read();
check("the next read carries the notice once", count(first) === 1, first);
check(
  "the notice points to channel history and its own bound",
  first.includes("Channel history may still hold them: `cotal history <channel>` reads it, within the space's history limit."),
  first,
);
const second = await read();
check("the read after it does not repeat it", count(second) === 0 && agent.storedCopiesFull === 0, second);

// A read that shows a message builds its reply from what it takes, and the notice rides that reply.
agent.ep.emit("message", { id: "dm-1", ts: 1, space: cfg.space, from: { id: "peer", name: "ada" }, to: cfg.name, parts: [{ kind: "text", text: "a waiting dm" }] }, { ack: () => {}, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
full();
const shown = await read();
check("a read that shows a message carries the notice once", count(shown) === 1 && shown.includes("a waiting dm") && agent.storedCopiesFull === 0, shown);
// The count is the one stamped on the copy, which an operator may have set.
full(250);
const at250 = await read();
check("the notice names the count the endpoint reported", at250.split(noteAt(250)).length - 1 === 1 && count(at250) === 0, at250);

// Focus mode reads recall instead of the live buffer; the notice rides there too.
Object.defineProperty(agent, "attention", { get: () => "focus" });
const nothing = { items: [], droppedChannels: [] };
const recallWith = (recall: MeshAgent["recallAmbient"]) => {
  (agent as unknown as { recallAmbient: MeshAgent["recallAmbient"] }).recallAmbient = recall;
};
recallWith(async () => nothing);
full();
const focused = await read();
check("in focus mode the next read carries the notice once", count(focused) === 1, focused);
const focusedAgain = await read();
check("in focus mode the read after it does not repeat it", count(focusedAgain) === 0, focusedAgain);
// Recall never reads a family whole, so a family follower's focus read always has recall to report.
// That reply carries the notice too.
recallWith(async () => ({ items: [], droppedChannels: ["flood.>"] }));
full();
const withRecall = await read();
check("in focus mode a read with recall to report carries the notice once", count(withRecall) === 1, withRecall);

// The notice clears only once a reply carrying it reaches a caller that is still there.
full();
recallWith(async () => { throw new Error("recall failed"); });
const threw = await read().then(() => false, () => true);
recallWith(async () => nothing);
const afterThrow = await read();
check("in focus mode a read whose recall throws keeps the notice for the next read", threw && count(afterThrow) === 1, { threw, afterThrow });

full();
const gone = new AbortController();
recallWith(async () => { gone.abort(); return nothing; });
await inbox.run(agent, cfg, {}, { signal: gone.signal });
recallWith(async () => nothing);
const afterGone = await read();
check("in focus mode a caller that goes during recall leaves the notice for the next read", count(afterGone) === 1, afterGone);

full();
recallWith(async () => { full(); return nothing; });
const during = await read();
recallWith(async () => nothing);
const next = await read();
const quietAgain = await read();
check(
  "a limit seen while a reply is built is said by the next read, and then not again",
  count(during) === 1 && count(next) === 1 && count(quietAgain) === 0,
  { during, next, quietAgain },
);

check(
  "the cotal_inbox description says a reply can carry the notice",
  inbox.description.includes("If your stored copies reached their limit, 1000 unless an operator set another, the reply says earlier channel posts may have been dropped"),
  inbox.description,
);

console.log(`\nSTORED-COPIES-NOTICE SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

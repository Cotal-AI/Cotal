/**
 * THE CONNECTION STATUS TOOL REPORTS THIS SESSION'S LIVE STATE, RATHER THAN ASSUMING IT.
 *
 * A silent inbox has two meanings: nothing arrived, or this session is not connected. The tool must
 * keep those apart using MeshAgent's own state. This suite reaches it through a real MCP server and
 * client, not by calling the tool helper directly, so it grades the registered route as an agent
 * invokes it. The broker address is inert: MeshAgent is constructed but never started.
 *
 * MUTATION LEDGER, predicted before the run. Six mutations, because the state a caller acts on is
 * derived from three facts and one mutation on the derivation would be killed by whichever cell ran
 * first, leaving every other state ungraded.
 *
 * M1 replaces MeshAgent's `connected` getter with the constant false.
 *   IN  "the real MCP route reports the MeshAgent's live connected=true state"
 *   ALSO "bound with the transport down reports degraded, not connected and not disconnected",
 *       which asserts the REPORTED `connected` is true. Predicted, not a surprise.
 *   OUT every cell that asserts only on `state`: `connectionState` reads the private field rather
 *       than this getter, so the derived state is unmoved by M1. Ready, connecting, disconnected and
 *       both stopped cells stay green.
 *
 * M2 deletes the `_stopping` branch from `connectionState`.
 *   IN  "a deliberately stopped session reports stopped rather than disconnected"
 *   ALSO "a stopped session reports its retained failure as a post-mortem, not as a current issue",
 *       because the issue key is chosen from the state. Predicted, not a surprise.
 *   OUT ready, degraded, connecting and disconnected: none of them stages `_stopping`.
 *
 * M3 collapses `degraded` into `ready`.
 *   IN  "bound with the transport down reports degraded, not connected and not disconnected"
 *   OUT ready is already ready; connecting and disconnected stage `_connected` false and never
 *       reach the mutated branch; stopped returns before it.
 *
 * M4 collapses `connecting` into `disconnected`.
 *   IN  "a live transport whose bind has not finished reports connecting"
 *   OUT disconnected expects that value anyway; ready and degraded return before this line;
 *       stopped returns first.
 *
 * M5 drops the stopped scoping on the reported issue in tool-specs.
 *   IN  "a stopped session reports its retained failure as a post-mortem, not as a current issue"
 *   OUT the disconnected cell, which expects `connectionIssue` and gets it under the mutant too;
 *       every cell that stages no issue at all.
 *
 * M6 replaces the `transportConnected` getter with the constant true.
 *   IN  "bound with the transport down reports degraded, not connected and not disconnected"
 *   OUT the derived state is computed from the private field, so `state` is unaffected everywhere.
 *       Only cells asserting the REPORTED fact move. This is deliberate: it proves the raw facts
 *       come from live getters rather than being back-derived from the state, which would make them
 *       useless to a caller wanting to check our reading.
 *
 * M7 replaces the reported `stopping` fact with the constant false.
 *   IN  "the reported facts distinguish stopped from disconnected, which agree on both other facts"
 *   OUT every cell asserting only on `state`: the derivation reads the private field, so the state
 *       itself is unmoved. Only the reported fact breaks, which is the point.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. Every state is staged by writing MeshAgent's private fields, so
 * these cells prove the tool REPORTS each state distinctly. They do not prove the endpoint reaches
 * each combination. That is proved separately: the transport-liveness broker companion drives real
 * disconnect and reconnect edges against a real broker, and the `connecting` window exists by
 * construction, since the endpoint emits transport=true when connect() returns while the Cotal bind
 * below is still in progress. Reachability is argued there and deliberately not claimed here.
 *
 * Named gap: no broker connection is opened, so this suite does not prove CotalEndpoint emits the
 * connection event. Existing endpoint suites own that source. It proves this tool reports the state
 * MeshAgent holds and that a real MCP call reaches it.
 *
 * Harness correction before the graded rerun: the first mutation attempt used the green success
 * summary as `completionMarker`. That correctly went absent on red and made the proof inconclusive.
 * The suite now prints a separate completion line after all cells on both outcomes; the marker names
 * that line rather than a success condition.
 *
 * Run: pnpm smoke:connection-status
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MeshAgent, type InboxItem } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { registerCotalTools } from "../src/tools.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
};

const config: AgentConfig = {
  space: "connection-status",
  name: "status-agent",
  servers: "nats://127.0.0.1:1",
  kind: "agent",
  tls: false,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
};
const agent = new MeshAgent(config);
// Both liveness facts, deliberately. Staging only `_connected` leaves `_transportConnected` false,
// which is the DEGRADED state, so a setup that sets one and calls the session healthy is staging the
// very combination this tool exists to tell apart.
type Stage = { _connected: boolean; _transportConnected: boolean; _stopping: boolean; lastConnectionError?: string };
const stage = agent as unknown as Stage;
stage._connected = true;
stage._transportConnected = true;

const acked: string[] = [];
const oldestAutomaticReceivedAt = Date.now() - 2_000;
const item = (id: string): InboxItem => ({
  id,
  recvKey: id,
  ts: Date.now(),
  fromId: `peer-${id}`,
  fromName: `peer-${id}`,
  kind: "dm",
  mentionsMe: false,
  historical: false,
  text: `message ${id}`,
});
(agent as unknown as { inbox: Array<{ item: InboxItem; ack: () => void; pullOnly: boolean; receivedAt: number }> }).inbox = [
  { item: item("one"), ack: () => acked.push("one"), pullOnly: false, receivedAt: oldestAutomaticReceivedAt },
  { item: item("two"), ack: () => acked.push("two"), pullOnly: true, receivedAt: Date.now() - 1_000 },
];

const server = new McpServer({ name: "connection-status-smoke", version: "0.0.0" });
registerCotalTools(server, agent, config, "smoke");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "connection-status-client", version: "0.0.0" });
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const listed = await client.listTools();
const statusDecl = listed.tools.find((tool) => tool.name === "cotal_connection_status");
check(
  "the status tool is published with a CLOSED empty input schema",
  !!statusDecl && Object.keys(statusDecl.inputSchema?.properties ?? {}).length === 0 &&
    (statusDecl.inputSchema as { additionalProperties?: unknown } | undefined)?.additionalProperties === false,
  statusDecl?.inputSchema,
);

let refused = "";
try {
  const result = await client.callTool({ name: "cotal_connection_status", arguments: { owner: "attacker" } });
  refused = JSON.stringify(result);
} catch (error) {
  refused = String(error);
}
check(
  "unknown input is refused before the status route executes",
  refused.includes("owner") && refused.includes("unrecognized_keys"),
  refused,
);

const text = async (name: string): Promise<string> => {
  const result = await client.callTool({ name, arguments: {} });
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error(`${name} returned no text`);
  return first.text;
};
const status = async (): Promise<Record<string, unknown>> => JSON.parse(await text("cotal_connection_status"));

const initial = await status();
check("the real MCP route reports the MeshAgent's live connected=true state", initial.connected === true, initial);
check("the first status has no synthesized lastDrainedAt", !("lastDrainedAt" in initial), initial);
check("the status route reports the live buffered count before the drain", initial.bufferedCount === 2, initial);
check("the status route counts only automatic deliveries before the drain", initial.automaticCount === 1, initial);
check(
  "the status route reports the oldest automatic local receive time",
  initial.oldestAutomaticAt === new Date(oldestAutomaticReceivedAt).toISOString(),
  initial,
);

const beforeDrain = Date.now();
await text("cotal_inbox");
const afterDrain = Date.now();
check(
  "a real inbox call clears the two buffered deliveries",
  agent.inboxCount() === 0 && acked.join(",") === "one,two",
  { buffered: agent.inboxCount(), acked },
);

const drained = await status();
const drainedAt = typeof drained.lastDrainedAt === "string" ? Date.parse(drained.lastDrainedAt) : Number.NaN;
check(
  "lastDrainedAt is measured by that successful non-empty inbox drain",
  Number.isFinite(drainedAt) && drainedAt >= beforeDrain && drainedAt <= afterDrain,
  { drainedAt: drained.lastDrainedAt, beforeDrain, afterDrain },
);
check("the status route reports the live buffered count after the drain", drained.bufferedCount === 0, drained);
check(
  "the status route clears automatic queue depth and oldest time after the drain",
  drained.automaticCount === 0 && !("oldestAutomaticAt" in drained),
  drained,
);

check("a bound session with a live transport reports ready", (await status()).state === "ready", await status());

// DEGRADED: bound, transport down. The single boolean this tool used to report was FALSE here, on
// the one row that actually needs attention, because it was derived from `connected` alone.
stage._transportConnected = false;
const degraded = await status();
check(
  "bound with the transport down reports degraded, not connected and not disconnected",
  degraded.state === "degraded" && degraded.connected === true && degraded.transportConnected === false,
  degraded,
);

// CONNECTING: the transport is live before the Cotal bind finishes. The endpoint creates this
// window deliberately, emitting transport=true when connect() returns while the bind is still in
// progress, so this is a real state rather than one invented to fill the table.
stage._connected = false;
stage._transportConnected = true;
const connecting = await status();
check(
  "a live transport whose bind has not finished reports connecting",
  connecting.state === "connecting" && connecting.connected === false && connecting.transportConnected === true,
  connecting,
);

// DISCONNECTED, carrying the reason as a CURRENT problem.
stage._transportConnected = false;
stage.lastConnectionError = "socket closed";
const down = await status();
check(
  "neither bound nor transported reports disconnected, with the reason as a current issue",
  down.state === "disconnected" && down.connectionIssue === "socket closed" && !("lastConnectionIssue" in down),
  down,
);

// STOPPED: terminal and NOT a fault. stop() clears both liveness flags, so without `stopping` this
// is indistinguishable from the disconnected row above. The retained issue is a post-mortem here,
// and reporting it under the same key would tell a reader a cleanly stopped session is broken.
stage._stopping = true;
const stopped = await status();
check(
  "a deliberately stopped session reports stopped rather than disconnected",
  stopped.state === "stopped",
  stopped,
);
check(
  "a stopped session reports its retained failure as a post-mortem, not as a current issue",
  stopped.lastConnectionIssue === "socket closed" && !("connectionIssue" in stopped),
  stopped,
);

// The reported facts must be able to REPRODUCE the state, or they are decoration rather than a
// check on our derivation. Stopped and disconnected both read connected=false and
// transportConnected=false, so `stopping` is the only fact that separates them.
check(
  "the reported facts distinguish stopped from disconnected, which agree on both other facts",
  down.connected === false &&
    down.transportConnected === false &&
    down.stopping === false &&
    stopped.connected === false &&
    stopped.transportConnected === false &&
    stopped.stopping === true,
  { down, stopped },
);

await Promise.all([client.close(), server.close()]);

const EXPECTED_CELLS = 18;
const ran = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
console.log(`SUITE COMPLETE: ${ran} cells`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;

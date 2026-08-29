/**
 * THE CONNECTION STATUS TOOL REPORTS THIS SESSION'S LIVE STATE, RATHER THAN ASSUMING IT.
 *
 * A silent inbox has two meanings: nothing arrived, or this session is not connected. The tool must
 * keep those apart using MeshAgent's own state. This suite reaches it through a real MCP server and
 * client, not by calling the tool helper directly, so it grades the registered route as an agent
 * invokes it. The broker address is inert: MeshAgent is constructed but never started.
 *
 * MUTATION LEDGER, predicted before the run. M1 changes MeshAgent's `connected` getter from its live
 * field to the constant `false`.
 *
 *   IN  "the real MCP route reports the MeshAgent's live connected=true state"
 *       The staged source is true, so the constant changes this cell's observed result to false.
 *   OUT "the status tool is published with a CLOSED empty input schema"
 *       Schema publication does not read the connected getter.
 *   OUT "unknown input is refused before the status route executes"
 *       Input validation runs before the handler and never reads MeshAgent state.
 *   OUT "the first status has no synthesized lastDrainedAt"
 *       Drain state is independent of connectedness and has not been measured yet.
 *   OUT "the status route reports the live buffered count before the drain"
 *       The count comes from inboxCount(), whose source is unchanged by M1.
 *   OUT "a real inbox call clears the two buffered deliveries"
 *       The inbox route drains the staged buffer without consulting connectedness.
 *   OUT "lastDrainedAt is measured by that successful non-empty inbox drain"
 *       The timestamp source is the successful drain, not the connected getter.
 *   OUT "the status route reports the live buffered count after the drain"
 *       The count comes from inboxCount(), whose source is unchanged by M1.
 *   OUT "the status route reports a live connection issue as degraded"
 *       This cell stages connected=false, matching M1, and grades connectionIssue instead.
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
(agent as unknown as { _connected: boolean })._connected = true;

const acked: string[] = [];
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
(agent as unknown as { inbox: Array<{ item: InboxItem; ack: () => void; pullOnly: boolean }> }).inbox = [
  { item: item("one"), ack: () => acked.push("one"), pullOnly: false },
  { item: item("two"), ack: () => acked.push("two"), pullOnly: false },
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

(agent as unknown as { _connected: boolean; lastConnectionError?: string })._connected = false;
(agent as unknown as { lastConnectionError?: string }).lastConnectionError = "socket closed";
const degraded = await status();
check(
  "the status route reports a live connection issue as degraded",
  degraded.connected === false && degraded.degraded === true && degraded.connectionIssue === "socket closed",
  degraded,
);

await Promise.all([client.close(), server.close()]);

const EXPECTED_CELLS = 9;
const ran = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
console.log(`SUITE COMPLETE: ${ran} cells`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;

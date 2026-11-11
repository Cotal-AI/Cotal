import assert from "node:assert/strict";
import * as root from "@cotal-ai/core";
import * as client from "@cotal-ai/core/client";
import type { AgentCard, EndpointOptions, EpAttributedReply, HistoryPage } from "@cotal-ai/core/client";

let checks = 0;
function check(run: () => void): void {
  run();
  checks++;
}

check(() => assert.deepEqual(Object.keys(client).sort(), [
  "CotalEndpoint", "DmBindRefusedError", "DmDurableMissingError", "PresenceWriteStuckError",
  "isAuthRejection", "isPermissionDenied", "isPublishPermissionDenied",
].sort()));
for (const name of Object.keys(client) as (keyof typeof client)[]) {
  check(() => assert.equal(client[name], root[name], name));
}
for (const name of ["mintCreds", "createBrokerAuth", "parseAgentFileSource", "registry"]) {
  check(() => assert.equal(name in client, false, name));
}

const card: Omit<AgentCard, "id"> = { name: "client", kind: "agent" };
const options: EndpointOptions = { space: "client_entry", card, channels: [], consume: false };
const endpoint = new client.CotalEndpoint(options);
check(() => assert.ok(endpoint instanceof root.CotalEndpoint));
check(() => assert.throws(() => new client.CotalEndpoint({
  ...options, card: { ...card, kind: "invalid" as AgentCard["kind"] },
}), /"kind" must be "agent" or "endpoint"/));
check(() => assert.throws(() => root.parseAgentFileSource(
  "---\nname: client\nkind: invalid\n---\n", "client.md",
), /"kind" must be "agent" or "endpoint"/));

// These assignments also check the client entry's declarations against the existing methods.
const history: (...args: Parameters<typeof endpoint.channelHistoryPage>) => Promise<HistoryPage> = endpoint.channelHistoryPage;
const invoke: (...args: Parameters<typeof endpoint.invokeService>) => Promise<EpAttributedReply> = endpoint.invokeService;
void history;
void invoke;
console.log(`client entry smoke: ${checks} checks passed`);

import { readFileSync } from "node:fs";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { authorizeServeGrant, compileContract, contractRefToHex, contractStoreContext, fetchContractArtifact, recordsBucket, serveEndpoint, serviceEpochReader, standaloneConnectOpts, type EpServeHandle } from "@cotal-ai/core";

const path = process.env.ENDPOINT_R0_WORKER_FILE;
if (!path || !process.send) throw new Error("owned worker file and IPC required");
const material = JSON.parse(readFileSync(path, "utf8"));
let reader: NatsConnection | undefined, serving: NatsConnection | undefined, handle: EpServeHandle | undefined;
let effects = 0;
async function stop() {
  await handle?.stop();
  for (const nc of [serving, reader]) if (nc) { await nc.close(); await nc.closed(); }
  process.send!({ kind: "stopped", effects });
  process.disconnect();
}
try {
  reader = await connect({ servers: material.servers, ...standaloneConnectOpts({ tls: false, creds: material.readerCreds }), maxReconnectAttempts: 0 });
  const kv = await new Kvm(reader).open(recordsBucket(material.space), { bindOnly: true });
  const jsm = await jetstreamManager(reader, { checkAPI: false });
  const store = await contractStoreContext(reader, material.space);
  const grant = await authorizeServeGrant(kv, {
    space: material.space, endpoint: material.endpoint, instanceId: material.instanceId, epoch: material.epoch,
    holder: { owner: material.owner },
    authority: { authorize: (name, owner) => ({ authorized: name === material.endpoint && owner === material.owner, revision: 0 }) },
    readProcessEpoch: () => serviceEpochReader(jsm, material.space, material.endpoint)(material.instanceId),
    readClusterArtifact: async digest => { const bytes = await fetchContractArtifact(store, contractRefToHex(digest)); return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined; },
  });
  serving = await connect({ servers: material.servers, ...standaloneConnectOpts({ tls: false, creds: material.serveCreds }), maxReconnectAttempts: 0 });
  const contract = { input: compileContract({ root: { type: "null" } }), output: compileContract({ root: { type: "object", properties: { effects: { type: "integer" } }, required: ["effects"], additionalProperties: false } }) };
  handle = serveEndpoint(serving, material.space, grant, ["increment", "other"].map(command => ({ command, contract, handler: () => { effects++; process.send!({ kind: "effect", command, effects }); return { effects }; } })), { public: true });
  await serving.flush();
  process.send({ kind: "ready", endpoint: grant.endpoint, instanceId: grant.instanceId, epoch: grant.epoch });
  process.on("message", message => { if ((message as { kind?: string }).kind === "stop") void stop().catch(error => { process.send!({ kind: "failure", message: error.message }); process.exitCode = 1; }); });
} catch (error) {
  process.send({ kind: "failure", message: error instanceof Error ? error.message : String(error) });
  await stop(); process.exitCode = 1;
}

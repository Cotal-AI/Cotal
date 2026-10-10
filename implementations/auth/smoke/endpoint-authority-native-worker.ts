import { readFileSync } from "node:fs";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { fromSeed } from "@nats-io/nkeys";
import * as core from "@cotal-ai/core";
const path = process.env.ENDPOINT_U12_WORKER_FILE;
if (!path || !process.send) throw new Error("owned worker material and IPC required");
const material = JSON.parse(readFileSync(path, "utf8"));
const connections: NatsConnection[] = [];
let handle: core.EpServeHandle | undefined, effects = 0;
const enc = new TextEncoder();
async function stop() {
  await handle?.stop();
  for (const nc of connections.reverse()) { await nc.close(); await nc.closed(); }
  process.send!({ kind: "stopped", effects }); process.disconnect();
}
try {
  const control = await connect({ servers: material.servers, ...core.standaloneConnectOpts({ tls: false, creds: material.controlCreds }), maxReconnectAttempts: 0 }); connections.push(control);
  const adoption = await core.adoptEndpointService({ nc: control, authority: material.authority, trust: material.trust, serveJwt: material.serveJwt, attestation: material.attestation, artifacts: material.artifacts, holder: { publicKey: material.holder.id, sign: async bytes => fromSeed(enc.encode(material.holder.seed)).sign(bytes) } });
  const serving = await connect({ servers: material.servers, ...core.standaloneConnectOpts({ tls: false, creds: material.serveCreds }), maxReconnectAttempts: 0 }); connections.push(serving);
  const contract = { input: core.compileContract({ root: material.input }), output: core.compileContract({ root: material.output }) };
  handle = core.serveEndpoint(serving, material.authority.space, adoption.grant, ["increment", "other"].map(command => ({ command, contract, handler: () => { effects++; process.send!({ kind: "effect", command, effects }); return { effects, owner: adoption.grant.owner }; } })), { view: () => { throw new Error("delegated describe must use stock admission view"); } }, { requestAuthority: adoption.requestAuthority });
  await serving.flush();
  process.send!({ kind: "ready", instanceId: adoption.grant.instanceId, owner: adoption.grant.owner, protocol: adoption.grant.descriptor.protocol.v });
  process.on("message", message => { if ((message as { kind?: string }).kind === "stop") void stop().catch(error => { process.send!({ kind: "failure", message: String(error) }); process.exitCode = 1; }); });
} catch (error) {
  process.send!({ kind: "failure", message: String(error) });
  await stop(); process.exitCode = 1;
}

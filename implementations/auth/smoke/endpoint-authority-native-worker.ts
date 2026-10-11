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
const publicControl = material.publicControl === true;
if (publicControl && (typeof material.controlBearer !== "string" || typeof material.sentinelCreds !== "string" || typeof material.serveCreds !== "string" || material.controlCreds !== undefined || !material.expectedControlPrincipal)) throw new Error("exclusive public control material required");
async function stop() {
  await handle?.stop();
  for (const nc of connections.reverse()) { await nc.close(); const error = await nc.closed(); if (publicControl && (error || !nc.isClosed())) throw new Error("public worker connection close failed"); }
  process.send!({ kind: "stopped", effects, ...(publicControl ? { knownConnectionsClosed: connections.length } : {}) }); process.disconnect();
}
try {
  const controlOptions = publicControl
    ? core.standaloneConnectOpts({ tls: false, bearer: material.controlBearer, sentinelCreds: material.sentinelCreds })
    : core.standaloneConnectOpts({ tls: false, creds: material.controlCreds });
  if (publicControl && typeof controlOptions.name !== "string") throw new Error("public worker issued nonce required");
  const control = await connect({ servers: material.servers, ...controlOptions, maxReconnectAttempts: 0 }); connections.push(control);
  const authority = publicControl ? { ...material.authority, caller: await core.issuedUserCaller(control, material.authority.space, String(controlOptions.name), material.expectedControlPrincipal) } : material.authority;
  const adoption = await core.adoptEndpointService({ nc: control, authority, trust: material.trust, serveJwt: material.serveJwt, attestation: material.attestation, artifacts: material.artifacts, holder: { publicKey: material.holder.id, sign: async bytes => fromSeed(enc.encode(material.holder.seed)).sign(bytes) } });
  const serving = await connect({ servers: material.servers, ...core.standaloneConnectOpts({ tls: false, creds: material.serveCreds }), maxReconnectAttempts: 0 }); connections.push(serving);
  const contract = { input: core.compileContract({ root: material.input }), output: core.compileContract({ root: material.output }) };
  const replyOwner = adoption.grant.owner;
  handle = core.serveEndpoint(serving, material.authority.space, adoption.grant, ["increment", "other"].map(command => ({ command, contract, handler: () => { effects++; process.send!({ kind: "effect", command, effects }); return { effects, owner: publicControl ? replyOwner : adoption.grant.owner }; } })), { view: () => { throw new Error("delegated describe must use stock admission view"); } }, { requestAuthority: adoption.requestAuthority });
  await serving.flush();
  process.send!({ kind: "ready", instanceId: adoption.grant.instanceId, owner: adoption.grant.owner, protocol: adoption.grant.descriptor.protocol.v, ...(publicControl ? { controlPrincipal: material.expectedControlPrincipal, issuedControlObserved: "generation" in authority.caller } : {}) });
  process.on("message", message => {
    const request = message as { kind?: string; id?: string };
    if (publicControl && request.kind === "effects-snapshot" && typeof request.id === "string") process.send!({ kind: "effects-snapshot", id: request.id, effects });
    if (request.kind === "stop") void stop().catch(error => { process.send!({ kind: "failure", message: publicControl ? "public worker stop failed" : String(error) }); process.exitCode = 1; });
  });
} catch (error) {
  process.send!({ kind: "failure", message: publicControl ? "public worker setup failed" : String(error) });
  await stop(); process.exitCode = 1;
}

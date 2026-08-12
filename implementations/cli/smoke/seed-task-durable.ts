import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { mintCreds, newIdentity, standaloneConnectOpts, taskDurableConfig, taskStream } from "@cotal-ai/core";
import { authDir, loadSoleSpaceAuth } from "@cotal-ai/workspace";

const [root, server, space, role] = process.argv.slice(2);
if (!root || !server || !space || !role) throw new Error("usage: seed-task-durable <root> <server> <space> <role>");
const auth = loadSoleSpaceAuth(authDir(root));
if (!auth) throw new Error(`missing SpaceAuth under ${root}`);
const creds = await mintCreds(auth, newIdentity(), "provisioner");
const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds, tls: false }) });
try {
  await (await jetstreamManager(nc)).consumers.add(taskStream(space), taskDurableConfig(space, role));
} finally {
  await nc.drain().catch(() => {});
}

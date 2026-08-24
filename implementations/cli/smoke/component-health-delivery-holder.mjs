import { CotalEndpoint, deliveryBucket } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";

const [server, space] = process.argv.slice(2);
if (!server || !space) throw new Error("usage: component-health-delivery-holder <server> <space>");

const nc = await connect({ servers: server });
await new Kvm(nc).create(deliveryBucket(space), { ttl: 10_000 }).catch(async () => new Kvm(nc).open(deliveryBucket(space)));
const ep = new CotalEndpoint({
  space,
  servers: server,
  channels: [],
  consume: false,
  registerPresence: false,
  watchPresence: false,
  watchChannels: false,
  card: { name: "delivery-health-holder", kind: "endpoint" },
});
ep.on("error", (error) => console.error(error.message));
await ep.start();
await ep.acquireDeliveryLease(0);
console.log(process.pid);
await new Promise(() => {});

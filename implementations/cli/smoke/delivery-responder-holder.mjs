/** #1576 fixture: a REAL delivery lease holder, in one of the two states the fix distinguishes.
 *
 *   claim  -> acquireDeliveryLease(0) ONLY. The single-flight slot is taken and the lease exists with
 *             `ready:false`, exactly as the daemon leaves it BEFORE it binds `ctl.delivery`. This is
 *             the reporter's 22-hour state: a live process, a claimed slot, no responder.
 *   ready  -> acquire THEN markDeliveryLeaseReady(0, rev), which is what the daemon does after
 *             `startPlane3` has bound the responder and the fan-out/reader loops.
 *
 * Deliberately the real core calls against a real broker rather than a hand-written lease record: the
 * property under test is that the surfaces read the daemon's own readiness protocol, so faking the
 * record would let a wrong implementation pass.
 */
import { CotalEndpoint, deliveryBucket } from "@cotal-ai/core";
import { readFileSync } from "node:fs";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";

const [server, space, mode, credsPath] = process.argv.slice(2);
if (!server || !space || (mode !== "claim" && mode !== "ready"))
  throw new Error("usage: delivery-responder-holder <server> <space> <claim|ready> [credsFile]");

// An OPEN broker needs no credential; an AUTH broker refuses an anonymous connection outright, so the
// caller passes a `delivery`-profile creds file. Both callers exist (the status cell runs an open
// mesh to keep minting out of the experiment; the boot-path cell must be auth, because the function
// under test returns early in open mode), so the fixture takes it as an option rather than assuming.
const creds = credsPath ? readFileSync(credsPath, "utf8") : undefined;
const authOpts = creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(creds)) } : {};

const nc = await connect({ servers: server, ...authOpts });
const kvm = new Kvm(nc);
// Same bucket-level TTL the real `cotal up` pre-creates, so a released claim expires on its own and a
// later leg can CAS-create rather than fight a stale record. On an auth mesh the bucket is already
// provisioned, so the create is expected to fall through to the open.
await kvm.create(deliveryBucket(space), { ttl: 10_000 }).catch(async () => kvm.open(deliveryBucket(space)));

const ep = new CotalEndpoint({
  space,
  servers: server,
  ...(creds ? { creds } : {}),
  channels: [],
  consume: false,
  registerPresence: false,
  watchPresence: false,
  watchChannels: false,
  card: { name: "responder-visibility-holder", kind: "endpoint" },
});
ep.on("error", (e) => console.error(e.message));
await ep.start();
const revision = await ep.acquireDeliveryLease(0);
if (mode === "ready") await ep.markDeliveryLeaseReady(0, revision);
console.log(process.pid);
// Hold the lease (and renew nothing else) until the smoke stops us: releasing early would let the
// record expire mid-assertion and turn a real verdict into a flake.
await new Promise(() => {});

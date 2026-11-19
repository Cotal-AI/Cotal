/** Native control-consumer observations. The fixture writer administers its own data account;
 * the observer uses the product's one-shot profile and cannot consume or change these resources. */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { encodeUser } from "@nats-io/jwt";
import { createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
import { createSuite } from "@cotal-ai/smoke-kit";
import { canonConsumerConfig, chatStream, credsFromJwt, decisionReaderConfig, effectsConsumerConfig,
  epfStreamName, epfSubject, epjStreamName, epjSubject, eprStreamName, eprSubject, eptReqStreamName, epwStreamName,
  fanoutDurableConfig, goalReaderConfig, inboxReaderConfig, inboxStream, mintCreds, mintLifecycleUid, newIdentity,
  observeBrokerConnectionIdentity, poolConsumerConfig, recordWriterConsumerConfig, RECORD_KINDS,
  setupSpaceStreams, standaloneConnectOpts, timerWriterConsumerConfig } from "@cotal-ai/core";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { observeQueueQuiescence } from "../src/quiescence-queues.js";

const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("quiet-controls", 1);
const account = fx.accounts[0]!, space = account.space, endpoint = "org.example.worker";
const connections: NatsConnection[] = [];
const open = async (creds: string) => {
  const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  connections.push(nc);
  return nc;
};
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  const id = newIdentity();
  const jwt = await encodeUser("isolated-fixture-writer", fromPublic(id.id), fromPublic(account.auth.account.pub), {}, {
    signer: fromSeed(new TextEncoder().encode(account.auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 120,
  });
  const writer = await open(credsFromJwt(jwt, id));
  const jsm = await jetstreamManager(writer), js = jetstream(writer);
  await jsm.consumers.add(chatStream(space), fanoutDurableConfig(space));
  await jsm.consumers.add(inboxStream(space), inboxReaderConfig(space));
  await jsm.consumers.add(eptReqStreamName(space), timerWriterConsumerConfig(space));
  const readerId = newIdentity();
  const reader = await open(await mintCreds(account.auth, readerId, "space-quiescence-reader"));
  const readerJsm = await jetstreamManager(reader);
  const observe = () => observeQueueQuiescence(readerJsm, space);
  check("empty control streams are completely observed", (await observe()).state === "clear");
  check("the one-shot reader can prove its actual broker account", (await observeBrokerConnectionIdentity(reader, { user: readerId.id, account: account.accountPublicKey })).state === "matched");
  check("a different pinned account is rejected by native identity observation", (await observeBrokerConnectionIdentity(reader, { user: readerId.id, account: createAccount().getPublicKey() })).state === "target-mismatch");

  await jsm.consumers.add(epwStreamName(space), poolConsumerConfig(space, endpoint, "work"));
  const pooled = await observe();
  check("a dotted endpoint's empty native pool is recognized", pooled.state === "clear", pooled.reasons);
  if (pooled.state !== "clear") {
    const expected = poolConsumerConfig(space, endpoint, "work");
    const observed = await jsm.consumers.info(epwStreamName(space), expected.durable_name!);
    console.log("isolated pool policy diagnostic", { expected, observed: observed.config });
  }
  const caller = { owner: "local", actor: "caller", uid: mintLifecycleUid() };
  const instance = mintLifecycleUid();
  const canon = canonConsumerConfig(space, endpoint, { maxAckPending: 1 });
  const controls = [
    { label: "journal admission", stream: epjStreamName(space), config: canon, subject: epjSubject(space, { endpoint, command: "work", caller }) },
    { label: "record writer", stream: eprStreamName(space), config: recordWriterConsumerConfig(space, RECORD_KINDS.run), subject: eprSubject(space, endpoint, instance, 1, "run", ["manager", "run", "status"]) },
    { label: "effects executor", stream: epfStreamName(space), config: effectsConsumerConfig(space, endpoint), subject: epfSubject(space, endpoint, ["dec", caller.owner, caller.actor, caller.uid, "request"]) },
  ];
  const reply = decisionReaderConfig(space, endpoint, caller);
  await jsm.consumers.add(epfStreamName(space), reply);
  for (const control of controls) {
    await jsm.consumers.add(control.stream, control.config);
    await js.publish(control.subject, new TextEncoder().encode("fixture work"));
    const pending = await observe();
    check(`${control.label} pending work blocks quiescence`, pending.state === "busy" && pending.reasons.some(reason => reason.source === `${control.stream}/${control.config.durable_name}` && reason.count === 1), pending.reasons);
    const consumer = await js.consumers.get(control.stream, control.config.durable_name!);
    const message = await consumer.next({ expires: 1_000 });
    if (!message) throw new Error("fixture work was not delivered");
    check(`${control.label} unacknowledged work remains busy`, (await observe()).state === "busy");
    const acknowledged = await message.ackAck();
    check(`${control.label} acknowledged history is not pending work`, acknowledged && (await observe()).state === "clear");
  }
  check("an unread decision reply is retained mail, not autonomous work", (await jsm.consumers.info(epfStreamName(space), reply.durable_name!)).num_pending === 1 && (await observe()).state === "clear");
  const goal = goalReaderConfig(space, endpoint, caller);
  await jsm.consumers.add(epfStreamName(space), goal);
  await js.publish(epfSubject(space, endpoint, ["goal", caller.owner, caller.actor, caller.uid, "result"]), new TextEncoder().encode("retained result"));
  check("an unread goal result does not keep an otherwise idle control plane busy", (await jsm.consumers.info(epfStreamName(space), goal.durable_name!)).num_pending === 1 && (await observe()).state === "clear");

  await jsm.consumers.add(epjStreamName(space), { ...canon, durable_name: "unsupported" });
  check("an unsupported control durable yields unknown", (await observe()).state === "unknown");
  await jsm.consumers.delete(epjStreamName(space), "unsupported");
  check("the unsupported-consumer refusal has a restored positive control", (await observe()).state === "clear");
  await jsm.consumers.delete(epjStreamName(space), canon.durable_name!);
  check("retained ingress without its canonical consumer is unknown", (await observe()).state === "unknown");
  await jsm.consumers.add(epjStreamName(space), canon);
  const replay = await (await js.consumers.get(epjStreamName(space), canon.durable_name!)).next({ expires: 1_000 });
  check("restoring and draining the ingress consumer restores the positive control", !!replay && await replay.ackAck() && (await observe()).state === "clear");
} catch (error) {
  check(`harness: ${error instanceof Error ? error.message : "unknown failure"}`, false);
} finally {
  for (const nc of connections) await nc.close();
  await fx.close();
  if (passed() + failed() !== 19) check(`cell count: ran ${passed() + failed()}, expected 19`, false);
  finish();
}
process.exit(process.exitCode ?? 0);

/** Real broker coverage for queue/timer observations and the one-shot read-only profile.
 * This is not a complete space-idle verdict: workflow and retirement observation are separate. */
import { connect, headers, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { createSuite } from "@cotal-ai/smoke-kit";
import { anycastSubject, chatStream, eptReqStreamName, eptStreamName, eptSubject, fanoutDurableConfig, inboxReaderConfig,
  inboxStream, isPermissionDenied, mintCreds, mintLifecycleUid, newIdentity, readerDurable,
  setupSpaceStreams, spacePrefix, standaloneConnectOpts, taskDurable, taskDurableConfig, taskStream,
  timerWriterConsumerConfig, type MintOpts } from "@cotal-ai/core";
import { observeQueueQuiescence } from "../src/quiescence-queues.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("quiescence", 1);
const account = fx.accounts[0]!;
const space = account.space;
const connections: NatsConnection[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const open = async (profile: "provisioner" | "delivery" | "agent" | "space-quiescence-reader" | "probe", options: MintOpts = {}) => {
  const creds = await mintCreds(account.auth, newIdentity(), profile, options);
  const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  connections.push(nc);
  return nc;
};
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  const writer = await jetstreamManager(await open("provisioner"));
  const delivery = await open("delivery");
  const infra = await jetstreamManager(delivery);
  const js = jetstream(await open("agent", { principal: { owner: "local", actor: "worker" }, role: "worker", lifecycleUid: mintLifecycleUid() }));
  await infra.consumers.add(chatStream(space), fanoutDurableConfig(space));
  await infra.consumers.add(inboxStream(space), inboxReaderConfig(space));
  await infra.consumers.add(eptReqStreamName(space), timerWriterConsumerConfig(space));
  const reader = await open("space-quiescence-reader");
  const jsm = await jetstreamManager(reader);
  const observe = () => observeQueueQuiescence(jsm, space);
  const initial = await observe();
  check("a canonical idle queue set is completely observed with the scoped profile", initial.state === "clear" && initial.consumersRead === 3, initial.reasons);
  if (initial.state !== "clear") {
    const timers = await writer.streams.info(eptStreamName(space), { subjects_filter: ">" });
    console.log("isolated timer stream diagnostic", { config: timers.config, state: timers.state });
    throw new Error("idle positive control failed");
  }

  await writer.consumers.add(taskStream(space), taskDurableConfig(space, "worker"));
  await js.publish(anycastSubject(space, "worker", "local", "worker"), new TextEncoder().encode("work"));
  check("queued TASK work prevents a clear observation", (await observe()).state === "busy");
  const consumer = await js.consumers.get(taskStream(space), taskDurable("worker"));
  const message = await consumer.next({ expires: 1_000 });
  if (!message) throw new Error("native task was not delivered");
  const held = await observe();
  check("delivered but unacknowledged TASK work remains active", held.state === "busy" && held.reasons.some(reason => reason.source === `${taskStream(space)}/${taskDurable("worker")}` && reason.count === 1));
  const acked = await message.ackAck();
  check("native acknowledgement clears the task queue", acked && (await observe()).state === "clear");

  const instance = mintLifecycleUid();
  const armed = eptSubject(space, "manager", instance, 1, "timer", "armed");
  const fire = eptSubject(space, "manager", instance, 1, "timer", "fire");
  const h = headers();
  h.set("Nats-Schedule", `@at ${new Date(Date.now() + 3_000).toISOString()}`);
  h.set("Nats-Schedule-Target", fire);
  await jetstream(delivery).publish(armed, new TextEncoder().encode("timer"), { headers: h });
  const scheduled = await observe();
  check("a native armed timer prevents a clear observation", scheduled.state === "busy" && scheduled.armedTimers === 1);
  const deadline = Date.now() + 8_000;
  let fired = false;
  while (Date.now() < deadline) {
    const info = await writer.streams.info(eptStreamName(space), { subjects_filter: ">" });
    if (info.state.subjects?.[fire] === 1 && info.state.subjects[armed] === undefined) { fired = true; break; }
    await pause(50);
  }
  check("a fired one-shot purges its arm while retained fire history permits clear queues", fired && (await observe()).state === "clear");

  const denied = async (subject: string) => {
    try { await reader.request(subject, new TextEncoder().encode("{}"), { timeout: 1_000 }); return false; }
    catch (error) { if (!isPermissionDenied(error)) throw error; return true; }
  };
  check("the reader cannot create streams", await denied("$JS.API.STREAM.CREATE.not-allowed"));
  check("the reader cannot create consumers", await denied(`$JS.API.CONSUMER.CREATE.${inboxStream(space)}.not-allowed`));
  check("the reader cannot consume an existing task queue", await denied(`$JS.API.CONSUMER.MSG.NEXT.${taskStream(space)}.${taskDurable("worker")}`));
  check("the reader cannot inspect another space", await denied("$JS.API.STREAM.INFO.CHAT_foreign"));
  check("broker self-identity grants no account-wide connection view", await denied(`$SYS.REQ.ACCOUNT.${fx.accounts[0]!.accountPublicKey}.CONNZ`));
  check("broker self-identity grants no server-wide connection view", await denied("$SYS.REQ.SERVER.PING.CONNZ"));
  await infra.consumers.delete(inboxStream(space), readerDurable());
  check("a missing required consumer is unknown rather than empty", (await observe()).state === "unknown");
  await infra.consumers.add(inboxStream(space), { ...inboxReaderConfig(space), filter_subject: `${spacePrefix(space)}.dinbox.wrong` });
  check("a narrowed reader filter cannot hide queued work behind a clear verdict", (await observe()).state === "unknown");
  const unprivileged = await jetstreamManager(await open("probe"), { checkAPI: false });
  const unavailable = await observeQueueQuiescence(unprivileged, space);
  check("denied observations remain unknown", unavailable.state === "unknown" && unavailable.streams.size === 0);
} catch (error) {
  check(`harness: ${error instanceof Error ? error.message : "unknown failure"}`, false);
} finally {
  for (const nc of connections) await nc.close();
  await fx.close();
  if (passed() + failed() !== 15) check(`cell count: ran ${passed() + failed()}, expected 15`, false);
  finish();
}
process.exit(process.exitCode ?? 0);

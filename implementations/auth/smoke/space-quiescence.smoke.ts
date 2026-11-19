/** Full host observation over an owned operator-mode broker, including a genuine concurrent
 * ledger write and a bounded stalled TCP dial. No injected observation verdicts. */
import { createServer, type AddressInfo, type Socket } from "node:net";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { encodeUser } from "@nats-io/jwt";
import { createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
import { createSuite } from "@cotal-ai/smoke-kit";
import { anycastSubject, chatStream, credsFromJwt, eptReqStreamName, fanoutDurableConfig, inboxReaderConfig,
  inboxStream, markLedgerRowRevoked, mintCreds, newIdentity, recordsBucket, setupSpaceStreams,
  standaloneConnectOpts, taskDurable, taskDurableConfig, taskStream, timerWriterConsumerConfig } from "@cotal-ai/core";
import { activateLifecycle, openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { finalizeAgentMint, stageAgentMint } from "../src/credential-ledger.js";
import { observeSpaceQuiescence } from "../dist/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("quiet-complete", 1, { keepFiles: process.argv.includes("--keep-fixture") });
const account = fx.accounts[0]!, space = account.space;
let writer: NatsConnection | undefined;
const sockets = new Set<Socket>();
let stalled: ReturnType<typeof createServer> | undefined;
try {
  const provisioner = await mintCreds(account.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space, creds: provisioner });
  const id = newIdentity();
  const jwt = await encodeUser("isolated-observation-fixture", fromPublic(id.id), fromPublic(account.auth.account.pub), {}, {
    signer: fromSeed(new TextEncoder().encode(account.auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 120,
  });
  writer = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: credsFromJwt(jwt, id), tls: false }), reconnect: false });
  const jsm = await jetstreamManager(writer), js = jetstream(writer);
  await jsm.consumers.add(chatStream(space), fanoutDurableConfig(space));
  await jsm.consumers.add(inboxStream(space), inboxReaderConfig(space));
  await jsm.consumers.add(eptReqStreamName(space), timerWriterConsumerConfig(space));
  const creds = await mintCreds(account.auth, newIdentity(), "space-quiescence-reader");
  const opts = { servers: fx.servers, space, creds, accountPublicKey: account.accountPublicKey, tls: false };
  const observe = () => observeSpaceQuiescence(opts);
  const recordsAtStart = (await jsm.streams.info(`KV_${recordsBucket(space)}`)).state.messages;
  const empty = await observe();
  check("a complete native observation proves an idle account", empty.state === "quiescent" && empty.complete && empty.reasons.length === 0, empty);
  check("coverage counts include twelve eager streams, three consumers and no initialization records", empty.counts.streams === 12 && empty.counts.consumers === 3 && empty.counts.authRecords === 0 && recordsAtStart === 0 && empty.counts.records === recordsAtStart, empty.counts);
  const mismatch = await observeSpaceQuiescence({ ...opts, accountPublicKey: createAccount().getPublicKey() });
  check("a credential for another account is refused before source reads", mismatch.state === "unknown" && !mismatch.complete && mismatch.counts.streams === 0 && mismatch.reasons[0]?.source === "identity");
  const long = await mintCreds(account.auth, newIdentity(), "space-quiescence-reader", { expiresInSeconds: 600 });
  check("a standing-length reader is refused", (await observeSpaceQuiescence({ ...opts, creds: long })).reasons[0]?.source === "credential");
  const broad = await mintCreds(account.auth, newIdentity(), "provisioner", { expiresInSeconds: 60 });
  check("an overprivileged credential is not substituted for the read-only profile", (await observeSpaceQuiescence({ ...opts, creds: broad })).reasons[0]?.source === "credential");

  await jsm.consumers.add(taskStream(space), taskDurableConfig(space, "worker"));
  await js.publish(anycastSubject(space, "worker", "local", "writer"), new TextEncoder().encode("owned task"));
  const busy = await observe();
  check("native queued work produces a complete active verdict", busy.state === "active" && busy.complete && busy.reasons.some(reason => reason.source === "queues"), busy);
  const task = await (await js.consumers.get(taskStream(space), taskDurable("worker"))).next({ expires: 1_000 });
  if (!task) throw new Error("fixture task not delivered");
  await task.ackAck();
  check("native acknowledgement restores a quiescent verdict", (await observe()).state === "quiescent");

  const registry = await openLifecycleRegistry(writer, space);
  const { authKv } = registryStores(registry);
  const actor = await activateLifecycle(registry, { owner: "local", actor: "worker", managerInstance: "fixture" });
  const root = async (credentialId: string) => {
    const staged = await stageAgentMint(registry, { lifecycleUid: actor.mapping.lifecycleUid, credentialId,
      holderPrincipal: "local.worker", sourceChain: ["root"], exp: Date.now() + 60_000 });
    await finalizeAgentMint(registry, staged);
    return staged;
  };
  const first = await root("first");
  const active = await observe();
  check("a real ledgered credential blocks the complete observer", active.state === "active" && active.complete && active.counts.liveAuthorityRows === 1, active);
  await markLedgerRowRevoked(authKv, first.rowKey);
  check("native ledger revocation clears that authority blocker", (await observe()).state === "quiescent");

  const second = await root("concurrent");
  let fired = false;
  let mutation: Promise<unknown> | undefined;
  const tap = writer.subscribe(`$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`, { callback: (_error, msg) => {
    // Trigger after the auth ledger pass, at whole-record enumeration.
    if (fired || msg.json<{ next_by_subj?: string }>().next_by_subj !== `$KV.${recordsBucket(space)}.>`) return;
    fired = true;
    mutation = markLedgerRowRevoked(authKv, second.rowKey);
  } });
  await writer.flush();
  const changed = await observe();
  tap.unsubscribe();
  await mutation;
  check("a genuine authority write during enumeration refuses a stable verdict", fired && changed.state === "unknown" && !changed.complete &&
    changed.counts.liveAuthorityRows === 1 && changed.reasons.some(reason => reason.source === "stability"), changed);
  check("the changed-source refusal has a fresh stable positive control", (await observe()).state === "quiescent");

  let accepted = 0;
  stalled = createServer(socket => { accepted++; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => stalled!.listen(0, "127.0.0.1", resolve));
  const port = (stalled.address() as AddressInfo).port;
  const stalledDeadlineMs = 10_000;
  const started = performance.now();
  // A cold worker needs time to reach the listener; the 1ms cell below tests startup expiry.
  const timed = await observeSpaceQuiescence({ ...opts, servers: `nats://127.0.0.1:${port}`, timeoutMs: stalledDeadlineMs });
  const elapsed = performance.now() - started;
  check("the overall deadline bounds a genuinely stalled dial", accepted === 1 && timed.state === "unknown" && !timed.complete &&
    timed.reasons.some(reason => reason.source === "deadline") && elapsed < stalledDeadlineMs + 1_000, { accepted, elapsed, reasons: timed.reasons });
  await new Promise(resolve => setTimeout(resolve, 100));
  check("the failed dial leaves no live fixture socket", sockets.size === 0, sockets.size);
  const repeated = await observeSpaceQuiescence({ ...opts, servers: `nats://127.0.0.1:${port}`, timeoutMs: stalledDeadlineMs });
  check("a second stalled observation reaches a separate native connection", accepted === 2 && repeated.state === "unknown" && !repeated.complete &&
    repeated.reasons.some(reason => reason.source === "deadline"), { accepted, reasons: repeated.reasons });
  await new Promise(resolve => setTimeout(resolve, 100));
  check("repeated deadlines leave no accumulated fixture sockets", sockets.size === 0, sockets.size);
  const startupBound = await observeSpaceQuiescence({ ...opts, timeoutMs: 1 });
  check("a deadline that includes worker startup never returns a complete view", startupBound.state === "unknown" && !startupBound.complete && startupBound.reasons[0]?.source === "deadline");
  const tls = await observeSpaceQuiescence({ ...opts, tls: true, timeoutMs: 1_000 });
  check("explicit TLS never downgrades to this plaintext broker", tls.state === "unknown" && !tls.complete);
  check("the plaintext fixture remains a positive control when explicitly selected", (await observe()).state === "quiescent");
  const all = [];
  for await (const stream of jsm.streams.list()) all.push(stream);
  check("observations created no additional JetStream consumers", all.reduce((sum, stream) => sum + stream.state.consumer_count, 0) === 4);
} catch (error) {
  check(`harness: ${error instanceof Error ? error.message : "unknown failure"}`, false);
} finally {
  for (const socket of sockets) socket.destroy();
  if (stalled) await new Promise<void>(resolve => stalled!.close(() => resolve()));
  await writer?.close();
  await fx.close();
  if (passed() + failed() !== 19) check(`cell count: ran ${passed() + failed()}, expected 19`, false);
  finish();
}
process.exit(process.exitCode ?? 0);

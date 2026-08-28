/**
 * Core open-mode end-to-end smoke — run with: pnpm smoke
 *
 * Owns an OS-assigned JetStream broker and a unique provisioned space, so the repository's bare
 * smoke entry point is safe in CI and in concurrent checkouts. Open mode has no trusted Plane-3
 * delivery daemon: channels are live-only and therefore create no durable membership rows. Direct
 * messages are separately durable through the lifecycle-keyed DM consumer: a lifecycle that has
 * connected once receives a message sent during a later offline gap, while a freshly activated
 * lifecycle does not inherit messages published before its activation frontier.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  CotalEndpoint,
  DEV_OWNER,
  chatStream,
  deleteSpace as deleteSpaceResources,
  dmDurable,
  dmStream,
  isReachable,
  mintLifecycleUid,
  principalKey,
  setupSpaceStreams,
  type CotalMessage,
  type Delivery,
} from "./src/index.js";
import { pickFreePort } from "./smoke/_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `core-smoke-${randomUUID().slice(0, 8)}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
let brokerLog = "";
const broker = spawn(
  "nats-server",
  ["-js", "-sd", storeDir, "-p", String(PORT), "-a", "127.0.0.1"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
for (const stream of [broker.stdout, broker.stderr])
  stream?.on("data", (chunk: Buffer | string) => {
    brokerLog = (brokerLog + String(chunk)).slice(-8_000);
  });
const releaseBroker = teardownOnSignal(broker, storeDir);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
  stepMs = 50,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  let current = await condition();
  while (!current && Date.now() < deadline) {
    await wait(stepMs);
    current = await condition();
  }
  return current;
};
const textOf = (message: CotalMessage): string =>
  message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");

let pass = 0;
let fail = 0;
let unexpected = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const endpointErrors: Array<{ endpoint: string; message: string }> = [];
const watchEndpointErrors = (endpoint: string, instance: CotalEndpoint): void => {
  instance.on("error", (error: Error) => {
    endpointErrors.push({ endpoint, message: error.message });
    console.error(`  ! ${endpoint}:`, error.message);
  });
};

const started = new Set<CotalEndpoint>();
const startEndpoint = async (endpoint: CotalEndpoint): Promise<void> => {
  started.add(endpoint);
  await endpoint.start();
};
const stopEndpoint = async (endpoint: CotalEndpoint): Promise<void> => {
  if (!started.delete(endpoint)) return;
  await endpoint.stop();
};
const stopEndpointWithin = async (endpoint: CotalEndpoint, timeoutMs = 5_000): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopEndpoint(endpoint),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`stop timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

let provisioned = false;
const provisionedStreams = new Set<string>();
try {
  const reachable = await until(async () => {
    if (broker.exitCode !== null || broker.signalCode !== null) return false;
    return isReachable(SERVERS);
  }, 5_000, 100);
  if (reachable) await wait(200); // bind failures exit promptly; survive past that before trust
  const ready = reachable
    && broker.exitCode === null
    && broker.signalCode === null
    && await isReachable(SERVERS);
  check("owned broker is ready before the scenario", ready, {
    servers: SERVERS,
    exitCode: broker.exitCode,
    signalCode: broker.signalCode,
    log: brokerLog,
  });
  if (!ready) throw new Error("owned broker did not survive bind and become reachable");

  await setupSpaceStreams({ servers: SERVERS, space: SPACE });
  provisioned = true;
  let chatExists = false;
  const setupProbe = await connect({ servers: SERVERS });
  try {
    const setupManager = await jetstreamManager(setupProbe);
    for await (const name of setupManager.streams.names()) provisionedStreams.add(name);
    chatExists = provisionedStreams.has(chatStream(SPACE));
  } catch {
    chatExists = false;
  } finally {
    await setupProbe.close();
  }
  check("the production setup seam provisions this unique space", chatExists);

  const aliceActor = `alice_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const bobActor = `bob_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const alice = new CotalEndpoint({
    space: SPACE,
    servers: SERVERS,
    lifecycleUid: mintLifecycleUid(),
    card: { id: aliceActor, name: "alice", role: "planner", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 300,
    ttlMs: 1_500,
  });
  const bob = new CotalEndpoint({
    space: SPACE,
    servers: SERVERS,
    lifecycleUid: mintLifecycleUid(),
    card: { id: bobActor, name: "bob", role: "builder", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 300,
    ttlMs: 1_500,
  });
  watchEndpointErrors("alice", alice);
  watchEndpointErrors("bob", bob);

  const bobReceived: Array<{ kind: string; text: string }> = [];
  let bobMentions: string[] | undefined;
  bob.on("message", (message: CotalMessage, delivery: Delivery) => {
    const kind = message.to ? "dm" : message.toService ? `any:${message.toService}` : `channel:${message.channel ?? ""}`;
    const text = textOf(message);
    bobReceived.push({ kind, text });
    if (text === "hello team") bobMentions = message.mentions;
    delivery.ack();
  });

  await startEndpoint(alice);
  await startEndpoint(bob);
  check(
    "both explicit-channel peers become visible",
    await until(
      () => alice.getRoster().some((peer) => peer.card.id === bob.card.id)
        && bob.getRoster().some((peer) => peer.card.id === alice.card.id),
    ),
  );

  await alice.setStatus("working");
  check(
    "presence status propagates",
    await until(() => bob.getRoster().find((peer) => peer.card.id === alice.card.id)?.status === "working"),
    bob.getRoster().find((peer) => peer.card.id === alice.card.id)?.status,
  );

  const sent = await alice.multicast("hello team", {
    channel: "general",
    mentions: ["BOB", " bob ", "carol", ""],
  });
  const omitted = await alice.multicast("no ping", { channel: "general", mentions: [""] });
  await alice.unicast(bob.card.id, "private hello");
  await alice.anycast("builder", "build the thing");
  await until(
    () => bobReceived.some((entry) => entry.kind === "channel:general" && entry.text === "hello team")
      && bobReceived.some((entry) => entry.kind === "dm" && entry.text === "private hello")
      && bobReceived.some((entry) => entry.kind === "any:builder" && entry.text === "build the thing"),
  );

  check(
    "multicast reaches the explicitly joined channel",
    bobReceived.some((entry) => entry.kind === "channel:general" && entry.text === "hello team"),
    bobReceived,
  );
  check(
    "unicast reaches the addressed principal",
    bobReceived.some((entry) => entry.kind === "dm" && entry.text === "private hello"),
    bobReceived,
  );
  check(
    "anycast reaches the builder role",
    bobReceived.some((entry) => entry.kind === "any:builder" && entry.text === "build the thing"),
    bobReceived,
  );
  check(
    "mentions are normalized on the wire",
    JSON.stringify(sent.mentions) === JSON.stringify(["bob", "carol"]),
    sent.mentions,
  );
  check("empty mentions are omitted", omitted.mentions === undefined, omitted.mentions);
  check("the recipient sees its normalized mention", bobMentions?.includes("bob") === true, bobMentions);

  const carolActor = `carol_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const carolLifecycleUid = mintLifecycleUid();
  const carol = new CotalEndpoint({
    space: SPACE,
    servers: SERVERS,
    lifecycleUid: carolLifecycleUid,
    card: { id: carolActor, name: "carol", role: "tester", kind: "agent" },
    channels: [],
    heartbeatMs: 300,
    ttlMs: 1_500,
  });
  watchEndpointErrors("carol", carol);
  await startEndpoint(carol);

  let carolDurableExists = false;
  const durableProbe = await connect({ servers: SERVERS });
  try {
    await (await jetstreamManager(durableProbe)).consumers.info(
      dmStream(SPACE),
      dmDurable(DEV_OWNER, carolActor, carolLifecycleUid),
    );
    carolDurableExists = true;
  } catch {
    carolDurableExists = false;
  } finally {
    await durableProbe.close();
  }
  check("carol's lifecycle creates its DM durable before the offline gap", carolDurableExists);

  await stopEndpoint(carol);
  await alice.unicast(carol.card.id, "held during the offline gap");

  const carolRestarted = new CotalEndpoint({
    space: SPACE,
    servers: SERVERS,
    lifecycleUid: carolLifecycleUid,
    card: { id: carolActor, name: "carol", role: "tester", kind: "agent" },
    channels: [],
    heartbeatMs: 300,
    ttlMs: 1_500,
  });
  const carolReceived: string[] = [];
  watchEndpointErrors("carol restart", carolRestarted);
  carolRestarted.on("message", (message: CotalMessage, delivery: Delivery) => {
    carolReceived.push(textOf(message));
    delivery.ack();
  });
  await startEndpoint(carolRestarted);
  check(
    "the same lifecycle receives a DM sent while it was offline",
    await until(() => carolReceived.includes("held during the offline gap")),
    carolReceived,
  );

  const daveActor = `dave_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await alice.unicast(principalKey(DEV_OWNER, daveActor).key, "published before activation");
  const dave = new CotalEndpoint({
    space: SPACE,
    servers: SERVERS,
    lifecycleUid: mintLifecycleUid(),
    card: { id: daveActor, name: "dave", role: "tester", kind: "agent" },
    channels: [],
    heartbeatMs: 300,
    ttlMs: 1_500,
  });
  const daveReceived: string[] = [];
  watchEndpointErrors("dave", dave);
  dave.on("message", (message: CotalMessage, delivery: Delivery) => {
    daveReceived.push(textOf(message));
    delivery.ack();
  });
  await startEndpoint(dave);
  await alice.unicast(dave.card.id, "published after activation");
  check(
    "the fresh lifecycle receives a post-activation DM sentinel",
    await until(() => daveReceived.includes("published after activation")),
    daveReceived,
  );
  check(
    "a fresh lifecycle does not inherit a pre-activation DM",
    !daveReceived.includes("published before activation"),
    daveReceived,
  );

  check(
    "open live-only channels do not fabricate durable membership",
    (await alice.channelMembers("general")).length === 0,
  );
  check(
    "the no-arg durable-membership map is empty in open live-only mode",
    (await alice.channelMembers()).size === 0,
  );

  await stopEndpoint(bob);
  check(
    "presence flips offline after a peer stops",
    await until(() => alice.getRoster().find((peer) => peer.card.id === bob.card.id)?.status === "offline"),
    alice.getRoster().find((peer) => peer.card.id === bob.card.id)?.status,
  );
} catch (error) {
  unexpected++;
  console.error("  ✗ scenario threw:", (error as Error).message);
} finally {
  const endpointsToStop = [...started].reverse();
  const stopResults = await Promise.allSettled(endpointsToStop.map((endpoint) => stopEndpointWithin(endpoint)));
  stopResults.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    unexpected++;
    console.error(
      `  ✗ endpoint cleanup for ${endpointsToStop[index]?.card.name ?? "unknown"} threw:`,
      result.reason instanceof Error ? result.reason.message : String(result.reason),
    );
  });

  check("the endpoints emitted no unexpected errors", endpointErrors.length === 0, endpointErrors);

  let spaceDeleted = false;
  let spaceDeleteError: unknown;
  let remainingStreams: string[] = [];
  if (provisioned) {
    try {
      await deleteSpaceResources({ servers: SERVERS, space: SPACE });
      const deletionProbe = await connect({ servers: SERVERS });
      try {
        const deletionManager = await jetstreamManager(deletionProbe);
        for await (const name of deletionManager.streams.names())
          if (provisionedStreams.has(name)) remainingStreams.push(name);
      } finally {
        await deletionProbe.close();
      }
      spaceDeleted = provisionedStreams.size > 0 && remainingStreams.length === 0;
    } catch (error) {
      spaceDeleteError = error;
    }
  }
  check("the production teardown seam removes the unique space", spaceDeleted, {
    error: spaceDeleteError,
    remainingStreams,
    provisionedStreams: [...provisionedStreams],
  });

  await killAndAwaitExit(broker);
  const brokerExited = broker.exitCode !== null || broker.signalCode !== null;
  check("the owned broker exits before its JetStream tree is removed", brokerExited);
  let storeRemoved = false;
  let storeRemoveError: unknown;
  try {
    rmSync(storeDir, { recursive: true, force: true });
    storeRemoved = true;
  } catch (error) {
    storeRemoveError = error;
  }
  check("the owned broker's JetStream tree is removed", storeRemoved, storeRemoveError);
  if (brokerExited && storeRemoved) releaseBroker();
}

const EXPECTED_BEFORE_COUNT = 21;
check(
  `every scenario cell ran — ${EXPECTED_BEFORE_COUNT} expected`,
  pass + fail === EXPECTED_BEFORE_COUNT,
  { pass, fail, unexpected, expected: EXPECTED_BEFORE_COUNT },
);

const totalFail = fail + unexpected;
console.log(
  `\n${totalFail === 0 ? "SMOKE OK ✅" : "SMOKE FAILED ❌"}  (${pass} passed, ${totalFail} failed)`,
);
process.exit(totalFail === 0 ? 0 : 1);

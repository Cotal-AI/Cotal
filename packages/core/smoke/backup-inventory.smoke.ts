/**
 * The backup inventory, validated against BROKER TRUTH, in the CI gate.
 *
 * WHY THIS SUITE EXISTS. #643: the gated backup smokes validated `spaceBackupInventory` against
 * its own output, the same list on both sides of an exact set-equality, so the check passed even
 * when a whole stream family was absent from the inventory. That is the mechanism that let the
 * unenumerated authority stores (#356) sit undetected: nothing in the gate compared the inventory
 * to a broker. A hand-pinned count cannot catch that class either, because it counts the
 * inventory's own length, and a family the inventory never knew has nothing to count.
 *
 * So this suite does what the artifact-plane S2 suite (`smoke:artifact-store`) does: it provisions
 * a real space on a real broker, enumerates what the broker ACTUALLY holds (its own stream list,
 * never a name synthesized from `spaceBackupInventory()`), and runs `validateSpaceBackupInventory`
 * against that. Exact set-equality against reality fails in BOTH directions: a stream created but
 * unenumerated, and a stream enumerated but never created. That is the property the circular
 * check could not have. It is GATED (ci-suites, `smoke:backup-inventory`); the hermetic
 * `backup.smoke.ts` comparator unit tests remain in `pnpm test` under the core package.
 *
 * Run: pnpm smoke:backup-inventory   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, createInbox } from "@nats-io/transport-node";
import {
  canonicalBackupStreamConfig,
  chatStream,
  chatSubject,
  consumerConfigFromCheckpoint,
  createSpaceStreams,
  downloadStreamSnapshot,
  dlvStream,
  eventPayloadStream,
  finalizeStreamRestore,
  initiateStreamRestore,
  isReachable,
  newIdentity,
  pluginFanoutDurableConfig,
  purgePluginHistory,
  recreateConsumerCheckpoint,
  setupSpaceStreams,
  spaceDeletionStreams,
  spacePluginStreams,
  uploadStreamRestoreChunk,
  validateSpaceBackupInventory,
  validateBackupStreamState,
  validateCanonicalBackupStreamConfig,
  validatePersistentConsumerInventory,
  type PersistentConsumerCheckpoint,
} from "../src/index.js";
import { PLUGIN_CHANNEL_ROOT, PLUGIN_FANOUT_DURABLE, pluginChannelStream, pluginChannelSubject } from "../src/plugin-channel-route.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const SPACE = "bkinv";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);
const servers = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; } else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

/** The broker's OWN stream list, on a fresh connection each call: a probe that mutates the broker
 *  and re-validates must re-read it, or it grades a memory of the broker instead of the broker. */
const readBrokerStreams = async (): Promise<string[]> => {
  const c = await connect({ servers });
  try {
    const m = await jetstreamManager(c);
    const names: string[] = [];
    for await (const si of m.streams.list()) names.push(si.config.name);
    return names;
  } finally { await c.close(); }
};

/** Validate the broker's actual stream set for {@link SPACE}: "" on success, else the mismatch
 *  message, the validator's own words, so a red names the stream it reddened for. */
const validateAgainstBroker = async (): Promise<string> => {
  const names = await readBrokerStreams();
  try { validateSpaceBackupInventory(SPACE, names); return ""; }
  catch (e) { return (e as Error).message; }
};

async function roundTripPluginHistory(source: Awaited<ReturnType<typeof connect>>, checkpoint: PersistentConsumerCheckpoint, subjects: readonly string[], body: Uint8Array): Promise<void> {
  const port = await pickFreePort();
  const target = `nats://127.0.0.1:${port}`;
  const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const child = spawn("nats-server", ["-js", "-sd", store, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
  const release = teardownOnSignal(child, store);
  try {
    await awaitBrokerReady(() => isReachable(target), { servers: target, attempts: 50, delayMs: 100 });
    const chunks: Uint8Array[] = [];
    const snapshot = await downloadStreamSnapshot(source, checkpoint.stream, {
      deliverSubject: createInbox(), onChunk: (chunk) => { chunks.push(chunk); },
    });
    const nc = await connect({ servers: target });
    try {
      const session = await initiateStreamRestore(nc, SPACE, checkpoint.stream, snapshot.config, snapshot.state as unknown as Readonly<Record<string, unknown>>);
      for (const chunk of chunks) await uploadStreamRestoreChunk(nc, session, chunk);
      const restored = await finalizeStreamRestore(nc, session);
      const fanout = await recreateConsumerCheckpoint(nc, SPACE, checkpoint);
      const manager = await jetstreamManager(nc);
      const state = (await manager.streams.info(checkpoint.stream, { subjects_filter: ">" })).state;
      const consumer = await manager.consumers.info(checkpoint.stream, checkpoint.name);
      assert.equal(state.messages, snapshot.state.messages);
      assert.equal(restored.state.bytes, snapshot.state.bytes);
      for (const subject of subjects) {
        assert.equal(state.subjects?.[subject], 1);
        assert.deepEqual((await manager.streams.getMessage(checkpoint.stream, { last_by_subj: subject }))?.data, body);
      }
      check("native backup and restore conserve plugin posts and the pending fan-out", consumer.num_pending === 2 && fanout.config.opt_start_seq === 1, consumer);
    } finally { await nc.close(); }
  } finally {
    await killAndAwaitExit(child);
    release();
  }
}

async function verifyPluginStorage(): Promise<void> {
  const nc = await connect({ servers });
  try {
    const manager = await jetstreamManager(nc);
    const js = jetstream(nc);
    const streams = spacePluginStreams(SPACE);
    const history = pluginChannelStream(SPACE);
    const owner = newIdentity().id, actor = newIdentity().id;
    const subject = (plugin: string) => pluginChannelSubject(SPACE, owner, actor, `${PLUGIN_CHANNEL_ROOT}.${plugin}.work`);
    check("default bootstrap created none of the plugin streams", (await readBrokerStreams()).every((name) => !streams.includes(name)));
    await createSpaceStreams(manager, SPACE, true);
    const inventory = validateSpaceBackupInventory(SPACE, await readBrokerStreams(), { pluginChannels: true });
    check("enabled inventory contains the native plugin history stream", inventory.full.includes(history));
    const wrongEpoch = await validateAgainstBroker();
    check("off inventory refuses live plugin streams", wrongEpoch.includes("unexpected") && streams.every((name) => wrongEpoch.includes(name)), wrongEpoch);
    await manager.consumers.add(history, pluginFanoutDurableConfig(SPACE));
    const alpha = subject("alpha"), beta = subject("beta");
    const body = new Uint8Array([42]);
    const a = await js.publish(alpha, body), b = await js.publish(beta, body);
    check("both plugins receive native publish ACKs from plugin history", a.stream === history && b.stream === history);
    const consumer = await manager.consumers.info(history, PLUGIN_FANOUT_DURABLE);
    check("fan-out holds both new posts pending", consumer.num_pending === 2, consumer.num_pending);
    const stored = validateBackupStreamState((await manager.streams.info(history)).state as unknown as Record<string, unknown>);
    const [checkpoint] = validatePersistentConsumerInventory(SPACE, { [history]: [consumer] }, { [history]: stored }, [history]);
    const replay = consumerConfigFromCheckpoint(SPACE, checkpoint!);
    check("plugin fan-out checkpoint retains the filter and both pending posts", checkpoint?.ackFloorStreamSequence === 0 &&
      replay.opt_start_seq === a.seq && replay.filter_subject === consumer.config.filter_subject, checkpoint);
    await roundTripPluginHistory(nc, checkpoint!, [alpha, beta], body);
    const chat = await js.publish(chatSubject(SPACE, owner, actor, "ordinary"), body);
    check("ordinary chat receives its own native stream ACK", chat.stream === chatStream(SPACE));
    const purged = await purgePluginHistory(manager, SPACE, "alpha");
    check("scoped purge acknowledged exactly alpha's message", purged === 1, purged);
    const state = (await manager.streams.info(history, { subjects_filter: ">" })).state;
    check("plugin history retains beta but not alpha", state.messages === 1 && state.subjects?.[beta] === 1 && !state.subjects?.[alpha], state);
    check("scoped purge left ordinary chat untouched", (await manager.streams.info(chatStream(SPACE))).state.messages === 1);
    const targets = spaceDeletionStreams(SPACE, await readBrokerStreams());
    for (const stream of targets) await manager.streams.delete(stream);
    const remaining = await readBrokerStreams();
    check("deletion targets leave neither plugin history nor its fan-out", remaining.length === 0, remaining);
  } finally { await nc.close(); }
}

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error(`broker never came up on ${PORT}`);

  await setupSpaceStreams({ servers, space: SPACE });

  // THE LOAD-BEARING CELL. Exact set-equality between what the broker holds and what the inventory
  // declares, so a family created but unenumerated fails here, and one enumerated but never
  // created fails here too. Both directions, one assertion. This is the check the circular
  // `backup.smoke.ts` line could not be: remove a family from `spaceBackupInventory` and the
  // broker's list still names it, so the validator throws `unexpected` here.
  const equality = await validateAgainstBroker();
  check("the broker's own stream set equals the backup inventory exactly", equality === "", equality);

  const payloadNc = await connect({ servers });
  try {
    const payload = await (await jetstreamManager(payloadNc)).streams.info(eventPayloadStream(SPACE));
    validateCanonicalBackupStreamConfig(SPACE, eventPayloadStream(SPACE), payload.config as unknown as Record<string, unknown>);
    check("the live payload stream matches the canonical backup config", true);
  } finally { await payloadNc.close(); }

  // TEETH, BOTH DIRECTIONS, ON A REAL BROKER. The equality above is a claim that CAN fail; these
  // cells make it fail on purpose, so the suite proves its own check is live rather than trusting
  // the mutation rig to visit it. Each probe mutates the BROKER (never the inventory): the
  // inventory under test stays the shipped one, and each probe is undone before the next cell
  // reads the broker, so no cell grades a leftover of another.
  const c0 = await connect({ servers });
  await (await jetstreamManager(c0)).streams.delete(dlvStream(SPACE));
  await c0.close();
  const missingErr = await validateAgainstBroker();
  check("a stream DELETED from the broker reddens the check as missing",
    missingErr.includes("missing") && missingErr.includes(dlvStream(SPACE)), missingErr);

  const c1 = await connect({ servers });
  const jsm1 = await jetstreamManager(c1);
  await jsm1.streams.add(canonicalBackupStreamConfig(SPACE, dlvStream(SPACE)));
  await jsm1.streams.add({ name: "FOREIGN_PROBE", subjects: ["foreign.probe.>"] });
  await c1.close();
  const unexpectedErr = await validateAgainstBroker();
  check("a stream the inventory does not know reddens the check as unexpected",
    unexpectedErr.includes("unexpected") && unexpectedErr.includes("FOREIGN_PROBE"), unexpectedErr);

  const c2 = await connect({ servers });
  await (await jetstreamManager(c2)).streams.delete("FOREIGN_PROBE");
  await c2.close();
  const restored = await validateAgainstBroker();
  check("the check is green again once the probes are undone", restored === "", restored);
  await verifyPluginStorage();

  console.log(`\nbackup inventory vs broker truth: ${ok} passed, ${fail} failed`);
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(fail === 0 ? 0 : 1);

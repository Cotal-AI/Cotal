/** Run after building core: pnpm smoke:consumer-already-exists (needs nats-server). */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  activateRun, createEndpointStreams, isConsumerAlreadyExists, isReachable,
  replayRunJournal, runJournalConsumerConfig, wfjStreamName,
  openServerConfig, setupSpaceStreams, dmStream, dlvStream, provisionAgentDurables, CotalEndpoint, deprovisionAgent,
} from "@cotal-ai/core";
import {
  awaitBrokerReady, createSuite, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal,
} from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const suite = createSuite();
const space = "existscheck";
const runId = "run-check";
const stream = wfjStreamName(space);
const port = await pickFreePort();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}consumer-exists-`));
const configPath = join(store, "server.conf");
const brokerVersion = execFileSync("nats-server", ["--version"], { encoding: "utf8" }).match(/\d+\.\d+\.\d+/)?.[0];
if (!brokerVersion) throw new Error("Cannot read nats-server version");
const rendered = openServerConfig({ brokerVersion, transport: { kind: "plaintext" }, storeDir: join(store, "js"), port });
// Start with the pre-upgrade block, then reload the stock render on the same stream.
writeFileSync(configPath, rendered.replace(", limits { default_max_consumers: -1 }", ""));
const broker = spawn("nats-server", ["-c", configPath], { stdio: "ignore" });
const release = teardownOnSignal(broker);
const servers = `nats://127.0.0.1:${port}`;
let nc: NatsConnection | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 60, delayMs: 100 });
  nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await setupSpaceStreams({ servers, space });
  const inboxStream = dmStream(space);
  const provisioner = new CotalEndpoint({ space, servers, card: { id: "limitprov", name: "limitprov", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  provisioner.on("error", () => {});
  await provisioner.start();
  const started = Date.now();
  for (let i = 0; i < 1000; i++) {
    await provisionAgentDurables(provisioner, { owner: "local", actor: `limit${i}`, lifecycleUid: `limit${i}`.padEnd(26, "0") }, { subscribe: ["general"] });
  }
  console.log(`Provisioned 1000 lifecycle pairs in ${Date.now() - started}ms`);
  const before = await jsm.streams.info(inboxStream);
  suite.check("existing DM stream keeps canonical unlimited consumers", before.config.max_consumers === -1);
  if (Number(brokerVersion.split(".")[1]) >= 15) {
    const refusal = await provisionAgentDurables(provisioner, { owner: "local", actor: "limit1000", lifecycleUid: "limit1000".padEnd(26, "0") }, { subscribe: ["general"] })
      .then(() => undefined, (error: unknown) => error);
    suite.check("pre-upgrade stock provisioning refuses lifecycle 1001 with broker limit 10026", refusal instanceof JetStreamApiError && refusal.code === 10026);
  }
  writeFileSync(configPath, rendered);
  broker.kill("SIGHUP");
  let admitted = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await provisionAgentDurables(provisioner, { owner: "local", actor: "limit1000", lifecycleUid: "limit1000".padEnd(26, "0") }, { subscribe: ["general"] });
      admitted = true;
      break;
    } catch (error) {
      if (!(error instanceof JetStreamApiError) || error.code !== 10026) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  suite.check("stock config reload admits lifecycle 1001 on existing streams", admitted);
  await setupSpaceStreams({ servers, space });
  const after = await jsm.streams.info(inboxStream);
  suite.check("setup accepts existing stream without changing its identity or consumer limit",
    after.created === before.created && after.config.max_consumers === -1 && after.state.consumer_count === 1001);
  const delivery = await jsm.streams.info(dlvStream(space));
  suite.check("DLV also admits 1001 canonical lifecycle durables", delivery.state.consumer_count === 1001 && delivery.config.max_consumers === -1);
  await deprovisionAgent({ servers, space, targetId: "limit1000", lifecycleUid: "limit1000".padEnd(26, "0") });
  console.log(`After retiring one lifecycle: DM=${(await jsm.streams.info(inboxStream)).state.consumer_count}, DLV=${(await jsm.streams.info(dlvStream(space))).state.consumer_count}`);
  suite.check("retirement removes exactly one DM and one DLV durable",
    (await jsm.streams.info(inboxStream)).state.consumer_count === 1000 && (await jsm.streams.info(dlvStream(space))).state.consumer_count === 1000);
  const retainedDm = await jsm.consumers.list(inboxStream).next();
  const retainedDlv = await jsm.consumers.list(dlvStream(space)).next();
  suite.check("unretired lifecycle inboxes have no inactivity expiry",
    retainedDm.every((entry) => !entry.config.inactive_threshold) && retainedDlv.every((entry) => !entry.config.inactive_threshold));
  console.log(`Unretired consumers: DM=${(await jsm.streams.info(inboxStream)).state.consumer_count}, DLV=${(await jsm.streams.info(dlvStream(space))).state.consumer_count}, inactive_threshold=0`);
  await provisioner.stop();
  await createEndpointStreams(jsm, new Kvm(nc), space);
  const activation = await activateRun(js, jsm, {
    space, runId, holder: "driver", fencingToken: 1, epoch: 1, at: 1_700_000_000_000,
    expect: "new", takeoverId: "start",
  });
  await activation.append({ value: "retained" }, 1);

  const cases: [string, unknown][] = [
    ["plain Error with numeric code", Object.assign(new Error("permissions violation"), { code: 10148 })],
    ["plain object with numeric code", { code: 10148 }],
    ["plain Error with string code", Object.assign(new Error("wrapped"), { code: "10148" })],
    ["unrelated numeric code", Object.assign(new Error("permissions violation"), { code: 10023 })],
    ["structured permission error", new JetStreamApiError({ code: 403, err_code: 10023, description: "permissions violation" })],
    ["structured missing consumer", new JetStreamApiError({ code: 404, err_code: JetStreamApiCodes.ConsumerNotFound, description: "consumer not found" })],
    ["null", null],
    ["undefined", undefined],
  ];
  let sequence = 0;
  for (const [name, error] of cases) {
    const takeoverId = `case${++sequence}`;
    const config = runJournalConsumerConfig(space, runId, takeoverId);
    const durable = config.durable_name!;
    const original = await jsm.consumers.add(stream, { ...config, mem_storage: false });
    const calls: string[] = [];
    const guarded = {
      ...jsm,
      consumers: {
        ...jsm.consumers,
        add: (async (...args) => {
          calls.push("add");
          if (calls.length === 1) throw error;
          return await jsm.consumers.add(...args);
        }) as typeof jsm.consumers.add,
        delete: (async (...args) => {
          calls.push("delete");
          return await jsm.consumers.delete(...args);
        }) as typeof jsm.consumers.delete,
      },
    };
    const outcome = await replayRunJournal(js, guarded, space, runId, takeoverId)
      .then(() => ({ rejected: false, error: undefined as unknown }), (caught: unknown) => ({ rejected: true, error: caught }));
    const remaining = await jsm.consumers.info(stream, durable).catch((caught: unknown) => {
      if (!(caught instanceof JetStreamApiError) || caught.code !== JetStreamApiCodes.ConsumerNotFound) throw caught;
      return undefined;
    });
    suite.check(`${name}: structured predicate refuses it`, !isConsumerAlreadyExists(error));
    suite.check(`${name}: replay rethrows the original value before any delete`,
      outcome.rejected && outcome.error === error && calls.join(",") === "add", { calls, outcome });
    suite.check(`${name}: existing durable remains unchanged`,
      remaining !== undefined && remaining.created === original.created
      && remaining.config.mem_storage === original.config.mem_storage);
    if (remaining !== undefined) await jsm.consumers.delete(stream, durable);
  }

  // The positive control comes from this broker, not a hand-built error of the expected class.
  const takeoverId = "brokercontrol";
  const config = runJournalConsumerConfig(space, runId, takeoverId);
  const durable = config.durable_name!;
  await jsm.consumers.add(stream, { ...config, mem_storage: false });
  const conflict: unknown = await jsm.consumers.add(stream, config).then(() => undefined, (error: unknown) => error);
  suite.check("broker differing-config create returns structured 10148",
    conflict instanceof JetStreamApiError && conflict.code === 10148, conflict);
  suite.check("structured predicate accepts the broker conflict", isConsumerAlreadyExists(conflict));
  const replay = await replayRunJournal(js, jsm, space, runId, takeoverId);
  suite.check("broker conflict is recovered and the complete journal is read",
    replay.records.length === 2 && replay.records[1]?.record.kind === "step");
  const removed: unknown = await jsm.consumers.info(stream, durable).then(() => undefined, (error: unknown) => error);
  suite.check("successful replay removes its consumer",
    removed instanceof JetStreamApiError && removed.code === JetStreamApiCodes.ConsumerNotFound);
} finally {
  try { await nc?.close(); }
  finally {
    await killAndAwaitExit(broker);
    release();
    rmSync(store, { recursive: true, force: true });
  }
}
suite.finish();

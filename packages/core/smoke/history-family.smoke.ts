/** Authenticated newest-N channel-family reads through the published core entrypoint (#6707). */
import { strict as nodeAssert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  provisionAgent, seedChannelRegistry, serverConfig, setupSpaceStreams,
} from "../dist/index.js";
import { countedAssert, emitSentinel, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;
const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "history-family";
const auth = await createSpaceAuth(space);
writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port, storeDir: join(root, "js"),
}));
const broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
// Keep the broker store as diagnostic evidence, including when an assertion fails.
const releaseBroker = teardownOnSignal(broker);
const endpoints: CotalEndpoint[] = [];
const text = (msg: { parts: { kind: string; text?: string }[] }) =>
  msg.parts.map((part) => part.kind === "text" ? part.text : "").join("");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) { ready = true; break; }
    await wait(200);
  }
  assert.ok(ready, "isolated auth broker started");
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds });
  const concrete = ["events.alpha", "events.beta", "events.gamma", "events.alpha.worker"];
  const channels = [...concrete, "events", "events2.alpha", "notes.aside"];
  await seedChannelRegistry({
    servers, space, creds,
    file: { defaults: { replay: true }, channels: Object.fromEntries(channels.map((c) => [c, { replay: true }])) },
  });
  const start = async (creds: string, name: string, extra = {}) => {
    const ep = new CotalEndpoint({
      space, servers, creds, channels: [], consume: false, watchPresence: false,
      registerPresence: false, watchChannels: false, card: { name, kind: "endpoint" }, ...extra,
    });
    endpoints.push(ep);
    ep.on("error", () => {});
    await ep.start();
    return ep;
  };
  const manager = await start(creds, "provisioner");
  const agent = async (name: string, allowSubscribe: string[], allowPublish: string[]) => {
    const id = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const creds = await provisionAgent(manager, auth, id, {
      allowSubscribe, allowPublish, subscribe: [], lifecycleUid,
    });
    return start(creds, name, { lifecycleUid, card: { id: id.id, name, kind: "agent" } });
  };
  const poster = await agent("poster", ["events.alpha"], channels);
  const observer = await start(await mintCreds(auth, newIdentity(), "observer"), "observer");

  // The retained baseline corpus: newest four across the family, with an interleaved outsider.
  for (const [channel, body] of [
    ["events.alpha", "a1"], ["events.beta", "b1"], ["notes.aside", "aside"],
    ["events.gamma", "g1"], ["events.alpha", "a2"], ["events.beta", "b2"],
  ] as const) await poster.multicast(body, { channel });
  await wait(300);
  const control = await observer.multiChannelHistory(concrete, { limit: 4 });
  assert.deepEqual(control.map((r) => `${r.channel}:${text(r.msg)}:${r.seq}`), [
    "events.beta:b1:2", "events.gamma:g1:4", "events.alpha:a2:5", "events.beta:b2:6",
  ], "positive control: concrete history returns the newest four in stream order");
  const family = await observer.multiChannelHistory(["events.>"], { limit: 4 });
  assert.deepEqual(family, control, "family history equals the concrete-channel positive control");
  console.log("PASS retained #6707 case: family equals concrete newest four, including channel and sequence");

  // A second publisher, nested channel and non-matching prefix exercise the filter's boundaries.
  const other = await agent("other", [], ["events.alpha.worker"]);
  await other.multicast("nested", { channel: "events.alpha.worker" });
  await poster.multicast("bare prefix", { channel: "events" });
  await poster.multicast("different prefix", { channel: "events2.alpha" });
  // A sparse family needs the existing widening walk, not only its first 64-sequence window.
  for (let i = 0; i < 130; i++) {
    await poster.multicast(`family-${i}`, { channel: concrete[i % concrete.length]! });
    await poster.multicast(`aside-${i}`, { channel: "notes.aside" });
  }
  await wait(300);
  for (const limit of [1, 4, 100, 200]) {
    const rows = await observer.multiChannelHistory(["events.>"], { limit });
    const listed = await observer.multiChannelHistory(concrete, { limit, batch: 1 });
    assert.deepEqual(rows, listed, `family agrees with batched concrete channels at limit ${limit}`);
    assert.ok(rows.every((r, i) => i === 0 || r.seq > rows[i - 1]!.seq), "ascending stream sequence");
    assert.ok(rows.every((r) => concrete.includes(r.channel)), "only concrete family descendants returned");
  }
  const all = await observer.multiChannelHistory(["events.>"], { limit: 200 });
  assert.equal(all.length, 136, "all family messages from both publishers, without outsiders");
  assert.ok(all.some((r) => r.channel === "events.alpha.worker" && text(r.msg) === "nested"));
  assert.equal((await observer.multiChannelHistory(["events.>"])).length, 100, "default limit");
  assert.deepEqual(await observer.multiChannelHistory(["unused.>"]), [], "unused family is empty");
  assert.deepEqual(await observer.multiChannelHistory([]), [], "empty filter list reads nothing");
  assert.deepEqual(await observer.multiChannelHistory(["events.>"], { limit: 0 }), [], "zero limit");
  const aborted = AbortSignal.abort(new Error("cancel family history"));
  await assert.rejects(observer.multiChannelHistory(["events.>"], { signal: aborted }), /cancel family history/);
  console.log("PASS family selection, nested channels, sparse widening, limits, empty reads and cancellation");

  for (const filters of [
    [">"], ["events.*"], ["events.*.>"], ["events.>", "events.alpha"],
    ["events.>", "notes.>"], ["events.>", "events.>"], ["events.>.alpha"],
    ["events..>"], ["events/alpha.>"], [" events.>"], ["events.alpha "],
  ]) {
    await assert.rejects(observer.multiChannelHistory(filters), /wildcard channel|invalid channel/,
      `unsupported or aliased filters must refuse: ${filters.join(",")}`);
  }
  assert.deepEqual(await observer.multiChannelHistory(["events.alpha", "events.alpha"], { limit: 2 }),
    await observer.multiChannelHistory(["events.alpha"], { limit: 2 }), "concrete duplicates remain supported");

  // Stock agents do not hold the observer's history-reader creates. A family must not bypass that.
  await assert.rejects(poster.multiChannelHistory(["events.>"], { limit: 4 }), /permission/i,
    "a concrete-channel grant must not authorize its whole family");
  const reader = await agent("family-reader", ["events.>"], []);
  await assert.rejects(reader.multiChannelHistory(["events.>"], { limit: 4 }), /permission/i,
    "a family subscription grant does not add observer history-reader authority");
  await assert.rejects(reader.multiChannelHistory(["notes.>"], { limit: 4 }), /permission/i,
    "an unrelated family is denied rather than reported empty");
  console.log("PASS invalid filters refuse and existing broker grants bound family access");
} finally {
  try {
    await Promise.all(endpoints.reverse().map((ep) => ep.stop()));
  } finally {
    await killAndAwaitExit(broker);
    releaseBroker();
    console.log(`Retained broker store: ${root}`);
  }
}
emitSentinel({ passed: cells(), failed: 0 });

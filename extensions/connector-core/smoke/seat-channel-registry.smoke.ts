/**
 * A seat sees the channel registry (#5738). Seats read presence on demand instead of watching it
 * (#4864), and the registry has to reach them without a watch too: under JWT auth, the shipped
 * MeshAgent and its tool handlers must show registered channels with their descriptions before any
 * traffic, see entries an operator adds or removes after the seat started, and pick a registered
 * channel's delivery class on join. The seat must bind no consumer on the registry stream, which the
 * broker's own monitoring endpoint counts, with a watching endpoint as the counter's positive control.
 * Run: pnpm smoke:seat-channel-registry
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  createSpaceAuth,
  deleteChannels,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, teardownOnSignal } from "@cotal-ai/smoke-kit";

const EXPECTED_CELLS = 13;
const PORT = await pickFreePort();
const MONITOR = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "seatreg";
const registryStream = `KV_cotal_channels_${space}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }) + `http: 127.0.0.1:${MONITOR}\n`,
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

/** The broker's count of consumers on the registry stream, off its monitoring endpoint. */
async function registryConsumers(): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${MONITOR}/jsz?accounts=true&streams=true&consumers=true`);
  const body = (await r.json()) as { account_details?: { stream_detail?: { name: string; consumer_detail?: unknown[] }[] }[] };
  const streams = (body.account_details ?? []).flatMap((a) => a.stream_detail ?? []);
  const stream = streams.find((s) => s.name === registryStream);
  assert.ok(stream, `the monitoring endpoint lists no ${registryStream} stream: ${streams.map((s) => s.name).join(", ")}`);
  return stream.consumer_detail?.length ?? 0;
}

const stops: Array<() => Promise<void>> = [];
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  await seedChannelRegistry({
    servers,
    space,
    creds: provisioner,
    file: {
      defaults: { deliveryClass: "durable" },
      channels: {
        general: { description: "general talk" },
        "review.a": { description: "review lane a" },
        "live.ch": { description: "live only", deliveryClass: "live" },
      },
    },
  });

  const prov = new CotalEndpoint({ space, servers, creds: provisioner, card: { name: "prov", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  prov.on("error", () => {});
  await prov.start();
  const id = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const acl = ["general", "review.a", "live.ch", "late"];
  const creds = await provisionAgent(prov, auth, id, { subscribe: ["general"], allowSubscribe: acl, allowPublish: acl, lifecycleUid });
  await prov.stop();

  const cfg: AgentConfig = { space, name: "seat", servers, creds, subscribe: ["general"], allowSubscribe: acl, allowPublish: acl, kind: "agent", tls: false, id: id.id, lifecycleUid };
  const agent = new MeshAgent(cfg);
  agent.on("error", () => {});
  stops.push(() => agent.stop());
  agent.start();
  for (let i = 0; i < 50 && !agent.connected; i++) await sleep(200);
  assert.ok(agent.connected, "the seat did not connect");

  const specs = cotalToolSpecs(cfg, "smoke");
  const tool = (name: string) => specs.find((s) => s.name === name)!;
  const info = async (channel: string) => (await Promise.resolve(tool("cotal_channel_info").run(agent, cfg, { channel }))).text;
  const listed = async () => (await Promise.resolve(tool("cotal_channels").run(agent, cfg, {}))).text;

  // ── 1. registered channels reach the seat before any traffic ─────────────────────────────────
  {
    const general = await info("general");
    check("channel_info on a joined registered channel shows its description", general.includes("general talk") && !general.includes("not in the channel registry"), general);
    const review = await info("review.a");
    check("channel_info on an unjoined registered channel shows its description", review.includes("review lane a") && !review.includes("not in the channel registry"), review);
    const list = await listed();
    check("cotal_channels lists the unjoined registered channels with no traffic on them", list.includes("review.a") && list.includes("live.ch"), list);
    check("  with their descriptions", list.includes("review lane a") && list.includes("live only"), list);
    check("the boot briefing carries the joined channel's description", agent.channelBriefing()?.includes("general talk") === true, agent.channelBriefing());
  }

  // ── 2. registry edits after the seat started ─────────────────────────────────────────────────
  {
    await seedChannelRegistry({ servers, space, creds: provisioner, file: { channels: { late: { description: "added after start" } } } });
    const late = await info("late");
    check("an entry added after the seat started reaches channel_info", late.includes("added after start") && !late.includes("not in the channel registry"), late);
    check("  and cotal_channels", (await listed()).includes("added after start"));
    const removed = await deleteChannels({ servers, space, creds: provisioner, channels: ["review.a"] });
    assert.deepEqual(removed, ["review.a"], "the operator removal did not remove review.a");
    const gone = await info("review.a");
    check("an entry removed after the seat started is gone from channel_info", gone.includes("not in the channel registry") && !gone.includes("review lane a"), gone);
    check("  and from cotal_channels", !(await listed()).includes("review.a"));
  }

  // ── 3. join reads the registered delivery class ──────────────────────────────────────────────
  {
    const live = await agent.joinChannel("live.ch");
    check("joining a registered live-class channel asks for no stored copies", live.joined && !live.durable && live.reason === undefined, live);
    // The control: a durable-class channel does ask, and with no delivery daemon here it says why not.
    const durable = await agent.joinChannel("late");
    check("joining a durable-class channel asks for stored copies (control)", durable.joined && /durable backstop unavailable/.test(durable.reason ?? ""), durable);
  }

  // ── 4. the seat binds no consumer on the registry stream ─────────────────────────────────────
  {
    const seatOnly = await registryConsumers();
    const watcher = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "observer"), channels: [], consume: false, registerPresence: false, card: { name: "watcher", kind: "endpoint" } });
    watcher.on("error", () => {});
    await watcher.start();
    stops.push(() => watcher.stop());
    const withWatcher = await registryConsumers();
    check("the broker counts a watching endpoint's registry consumer (control)", withWatcher === seatOnly + 1, { seatOnly, withWatcher });
    check("the connected seat holds no registry consumer", seatOnly === 0, { seatOnly });
  }

  if (pass + fail !== EXPECTED_CELLS) {
    fail++;
    console.log(`  ✗ ran ${pass + fail - 1} cells, expected ${EXPECTED_CELLS}`);
  }
  console.log(`\nseat-channel-registry: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => (srv.exitCode !== null || srv.signalCode !== null ? resolve() : srv.once("exit", () => resolve())));
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(process.exitCode ?? 0);

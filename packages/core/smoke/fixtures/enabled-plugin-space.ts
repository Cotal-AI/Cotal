import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  CotalEndpoint, DEV_OWNER, MEMBERSHIP_FEED_KEY, createSpaceAuth, isReachable, membershipBucket, mintCreds,
  mintLifecycleUid, newIdentity, parsePrincipalKey, principalKey, serverConfig, setupSpaceStreams,
  standaloneConnectOpts, type ChannelMembership,
} from "../../src/index.js";
import { openChannelRegistry, writeChannelConfig } from "../../src/channels.js";
import { PLUGIN_CHANNEL_PROJECTION_KEY } from "../../src/plugin-channel-projection.js";
import { PLUGIN_CHANNEL_ROOT, pluginChannelStream } from "../../src/plugin-channel-route.js";
import { pluginChannelSpaceStateSubject } from "../../src/plugin-channel-space-state.js";
import { pickFreePort } from "../_free-port.js";

export interface EnabledPluginAgentOptions {
  readonly read?: readonly string[];
  readonly post?: readonly string[];
}

/** A switched-on, disposable local broker. Only tests can seed both enabled records. */
export async function startEnabledPluginSpace() {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const space = `plugin-smoke-${randomUUID().slice(0, 8)}`;
  const channel = `${PLUGIN_CHANNEL_ROOT}.fixture.issue`;
  const hiddenChannel = `${PLUGIN_CHANNEL_ROOT}.other.issue`;
  const chatChannel = "fixture-replay";
  const auth = await createSpaceAuth(space);
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const conf = join(dir, "server.conf");
  writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
  const broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  const release = teardownOnSignal(broker, dir);
  const endpoints = new Set<CotalEndpoint>();
  let provisionerWire: NatsConnection | undefined;
  const close = async () => {
    try {
      await Promise.allSettled([...endpoints].reverse().map((ep) => ep.stop()));
      await provisionerWire?.close();
    } finally {
      await killAndAwaitExit(broker);
      release();
    }
  };
  const endpoint = (options: Omit<ConstructorParameters<typeof CotalEndpoint>[0], "space" | "servers">) => {
    const ep = new CotalEndpoint({ ...options, space, servers });
    ep.on("error", (error) => console.error("fixture endpoint:", error));
    endpoints.add(ep);
    return ep;
  };
  try {
    await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
    const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner", { pluginChannelsEnabled: true, initializePluginChannelState: true });
    await setupSpaceStreams({ servers, space, creds: provisionerCreds, pluginChannels: true });
    const wire = await connect({ servers, ...standaloneConnectOpts({ creds: provisionerCreds, tls: false }) });
    provisionerWire = wire;
    const jsm = await jetstreamManager(wire);
    await jsm.jetstream().publish(pluginChannelSpaceStateSubject(space), new TextEncoder().encode(JSON.stringify({ version: 1, enabled: true, epoch: 1 })));
    const registry = await openChannelRegistry(wire, space);
    await registry.put(PLUGIN_CHANNEL_PROJECTION_KEY, JSON.stringify({ enabled: true, epoch: 1 }));
    await writeChannelConfig(registry, chatChannel, { deliveryClass: "live", replay: true, replayWindow: "1h" });
    const provisioner = endpoint({ creds: provisionerCreds, channels: [], consume: false, registerPresence: false, watchPresence: false,
      card: { name: "prov", kind: "endpoint" } });
    await provisioner.start();

    const mintAgent = async (options: EnabledPluginAgentOptions = {}) => {
      const id = newIdentity();
      const lifecycleUid = mintLifecycleUid();
      const allowSubscribe = [...(options.read ?? [])];
      const actor = id.id;
      const principal = principalKey(DEV_OWNER, actor).key;
      const creds = await mintCreds(auth, id, "agent", { lifecycleUid, pluginChannelsEnabled: true,
        allowSubscribe, allowPublish: [...(options.post ?? [])] });
      await provisioner.provisionDmInbox(DEV_OWNER, actor, lifecycleUid);
      if (allowSubscribe.length) await provisioner.provisionDlvInbox(DEV_OWNER, actor, lifecycleUid);
      await provisioner.reissueAcl(principal, lifecycleUid, allowSubscribe);
      return { creds, lifecycleUid, owner: DEV_OWNER, actor, principal };
    };
    const mintObserver = () => mintCreds(auth, newIdentity(), "observer", { pluginChannelsEnabled: true });
    /** Seed the display-only feed, not the durable members registry. The write uses no system connection. */
    const seedMembership = async (id: string, row: Pick<ChannelMembership, "live" | "durable">) => {
      if (!parsePrincipalKey(id)) throw new Error("fixture membership requires an agent principal key");
      const creds = await mintCreds(auth, newIdentity(), "membership-rw");
      const connection = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }) });
      try {
        const feed = await new Kvm(connection).open(membershipBucket(space));
        const observedAt = Date.now();
        await feed.put(id, JSON.stringify({ live: row.live, durable: row.durable, observedAt }));
        await feed.put(MEMBERSHIP_FEED_KEY, JSON.stringify({ observedAt }));
      } finally {
        await connection.close();
      }
    };
    const startDelivery = async () => {
      const creds = await mintCreds(auth, newIdentity(), "delivery", { pluginChannelsEnabled: true });
      const ep = endpoint({ creds, channels: [], consume: false, registerPresence: false, watchPresence: true,
        card: { name: "delivery", kind: "endpoint", role: "delivery" } });
      await ep.start();
      await ep.startPlane3((target, uid) => ep.aclForOwner(target, uid), { readPluginChannelAuthority: true });
      return ep;
    };
    const removePluginHistory = async () => {
      const stream = pluginChannelStream(space);
      const creds = await mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid(), transferStreams: [stream] });
      const teardown = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }) });
      try {
        if (!(await (await jetstreamManager(teardown)).streams.delete(stream))) throw new Error("fixture plugin history stream was not deleted");
      } finally {
        await teardown.close();
      }
    };
    const recreatePluginHistoryAtNextEpoch = async () => {
      await removePluginHistory();
      await setupSpaceStreams({ servers, space, creds: provisionerCreds, pluginChannels: true });
      await jsm.jetstream().publish(pluginChannelSpaceStateSubject(space), new TextEncoder().encode(JSON.stringify({ version: 1, enabled: true, epoch: 2 })));
      await registry.put(PLUGIN_CHANNEL_PROJECTION_KEY, JSON.stringify({ enabled: true, epoch: 2 }));
    };
    return { servers, space, channel, hiddenChannel, chatChannel, endpoint, mintAgent, mintObserver, seedMembership, startDelivery, removePluginHistory,
      recreatePluginHistoryAtNextEpoch, provisioner, jsm, close };
  } catch (error) {
    await close();
    throw error;
  }
}

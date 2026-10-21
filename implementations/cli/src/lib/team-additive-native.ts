import { Kvm } from "@nats-io/kv";
import { assertValidChannel, channelBucket, dialerFor, isConcreteChannel, standaloneConnectOpts, validateChannelConfig, type ChannelConfig } from "@cotal-ai/core";

/** One non-reconnecting writer connection for an additive attempt. Every create on this
 * handle reaches the same live transport; a missing acknowledgement remains unknown. */
export async function openAdditiveChannelWriter(input: {
  server: string;
  space: string;
  tls: boolean;
  auth: { creds?: string; bearer?: string; sentinelCreds?: string };
}): Promise<{ create(name: string, config: ChannelConfig): Promise<number>; close(): Promise<void> }> {
  const nc = await dialerFor(input.server)({ servers: input.server, ...standaloneConnectOpts({ ...input.auth, tls: input.tls }), timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
  let kv: Awaited<ReturnType<Kvm["open"]>>;
  try { kv = await new Kvm(nc).open(channelBucket(input.space)); }
  catch (error) { try { await nc.close(); } catch { /* No channel request was made. */ } throw error; }
  return {
    async create(name, config) {
      assertValidChannel(name);
      if (!isConcreteChannel(name)) throw new Error("additive channel creation requires a concrete key");
      validateChannelConfig(config);
      return kv.create(name, JSON.stringify(config));
    },
    close: () => nc.close(),
  };
}

import { JetStreamApiCodes, jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { channelBucket } from "./subjects.js";
import { isJetStreamMissing } from "./jetstream-missing.js";

export const PLUGIN_CHANNEL_PROJECTION_KEY = "=plugin-channel-space";

export interface PluginChannelRouteProjection {
  readonly enabled: boolean;
  readonly epoch: number;
}

/** One leader-served read on the existing agent-readable registry. The projection selects a route,
 *  not authority. Only a broker-confirmed absent key selects the legacy route. */
export async function readPluginChannelRouteProjection(nc: NatsConnection, space: string): Promise<PluginChannelRouteProjection> {
  const bucket = channelBucket(space);
  const subject = `$KV.${bucket}.${PLUGIN_CHANNEL_PROJECTION_KEY}`;
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const row = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: subject }).catch((error: unknown) => {
    if (isJetStreamMissing(error, JetStreamApiCodes.NoMessageFound)) return undefined;
    throw error;
  });
  if (!row) return { enabled: false, epoch: 0 };
  if (row.subject !== subject || row.header?.get("KV-Operation"))
    throw new Error("invalid plugin channel route projection record");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.data));
  } catch (cause) {
    throw new Error("malformed plugin channel route projection", { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !("enabled" in value) || typeof value.enabled !== "boolean" ||
      !("epoch" in value) || typeof value.epoch !== "number" || !Number.isSafeInteger(value.epoch) || value.epoch < 0)
    throw new Error("invalid plugin channel route projection fields");
  return { enabled: value.enabled, epoch: value.epoch };
}

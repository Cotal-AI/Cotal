import type { JetStreamManager } from "@nats-io/jetstream";
import { decodeRecordJson, recordsBucket } from "./endpoint-records.js";

export const PLUGIN_CHANNEL_SPACE_STATE_KEY = "plugin-channel-space";

export interface PluginChannelSpaceState {
  readonly version: 1;
  readonly epoch: number;
  readonly enabled: boolean;
}

export interface PluginChannelSpaceSnapshot {
  readonly state: PluginChannelSpaceState;
  /** Zero means the leader confirmed the key was absent. */
  readonly revision: number;
}

const initialState = { version: 1, epoch: 0, enabled: false } as const satisfies PluginChannelSpaceState;

export function pluginChannelSpaceStateSubject(space: string): string {
  return `$KV.${recordsBucket(space)}.${PLUGIN_CHANNEL_SPACE_STATE_KEY}`;
}

/** Read the space's plugin channel state from the stream leader using the caller's existing grant. This read does not grant access or change routing. */
export async function readPluginChannelSpaceAuthority(jsm: JetStreamManager, space: string): Promise<PluginChannelSpaceSnapshot> {
  const subject = pluginChannelSpaceStateSubject(space);
  const row = await jsm.streams.getMessage(`KV_${recordsBucket(space)}`, { last_by_subj: subject });
  // getMessage returns null only for the leader's NoMessageFound response, not for missing streams or failed requests.
  if (row === null) return { state: { ...initialState }, revision: 0 };
  if (row.subject !== subject || row.header?.has("KV-Operation"))
    throw new Error("invalid plugin channel space authority record or deletion marker");
  const value = decodeRecordJson(row.data, PLUGIN_CHANNEL_SPACE_STATE_KEY, true);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !("version" in value) || value.version !== 1 ||
      !("epoch" in value) || typeof value.epoch !== "number" || !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
      !("enabled" in value) || typeof value.enabled !== "boolean" || Object.keys(value).length !== 3 ||
      !Number.isSafeInteger(row.seq) || row.seq <= 0) {
    throw new Error("invalid or unsupported plugin channel space state");
  }
  return { state: { version: 1, epoch: value.epoch, enabled: value.enabled }, revision: row.seq };
}

/** Read the space authority from the leader and require off state. */
export async function readPluginChannelSpaceState(jsm: JetStreamManager, space: string): Promise<PluginChannelSpaceSnapshot> {
  const snapshot = await readPluginChannelSpaceAuthority(jsm, space);
  if (snapshot.state.enabled) throw new Error("this release does not support enabled plugin channels");
  return snapshot;
}

/** Trusted provisioner only. Create the off record if absent; never overwrite or enable it. */
export async function initializePluginChannelSpaceState(jsm: JetStreamManager, space: string): Promise<PluginChannelSpaceSnapshot> {
  const current = await readPluginChannelSpaceState(jsm, space);
  if (current.revision !== 0) return current;
  const streamName = `KV_${recordsBucket(space)}`;
  const data = new TextEncoder().encode(JSON.stringify(initialState));
  const ack = await jsm.jetstream().publish(pluginChannelSpaceStateSubject(space), data, {
    expect: { streamName, lastSubjectSequence: 0 },
  });
  return { state: { ...initialState }, revision: ack.seq };
}

import type { JetStreamManager } from "@nats-io/jetstream";
import { readRecordLeader, recordsBucket } from "./endpoint-records.js";

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

/** Read the space authority from the leader. This release only supports off state. */
export async function readPluginChannelSpaceState(jsm: JetStreamManager, space: string): Promise<PluginChannelSpaceSnapshot> {
  const row = await readRecordLeader(jsm, space, PLUGIN_CHANNEL_SPACE_STATE_KEY);
  if (row === undefined) return { state: { ...initialState }, revision: 0 };
  const value = row.value;
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !("version" in value) || value.version !== 1 ||
      !("epoch" in value) || typeof value.epoch !== "number" || !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
      !("enabled" in value) || typeof value.enabled !== "boolean" || Object.keys(value).length !== 3 ||
      !Number.isSafeInteger(row.revision) || row.revision <= 0) {
    throw new Error("invalid or unsupported plugin channel space state");
  }
  if (value.enabled) throw new Error("this release does not support enabled plugin channels");
  return { state: { version: 1, epoch: value.epoch, enabled: false }, revision: row.revision };
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

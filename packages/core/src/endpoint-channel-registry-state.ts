// The channel registry a CotalEndpoint has read, in one object the endpoint's internal parts read by
// reference. Not re-exported by the index.
import type { ChannelConfig, ChannelDefaults } from "./types.js";

/** Created by the `CotalEndpoint` before its parts. Channel discovery writes it; the connection part
 *  resets it with the connection. Every other part takes it as `Readonly` and reads a field when it uses
 *  it, never a copy. */
export interface ChannelRegistryState {
  /** Local cache of the channel registry (key = channel token), kept by a KV watch or, on an
   *  endpoint that reads it on demand, by {@link readChannels}. */
  readonly channelConfigs: Map<string, ChannelConfig>;
  channelDefaults: ChannelDefaults;
  /** The {@link readChannels} in flight; calls made before it settles share it. */
  channelRead?: Promise<void>;
  /** Orders {@link readChannels} results: a read that settles after a newer one was applied is dropped. */
  channelReadGeneration: number;
  channelReadApplied: number;
}

/** The state before any credential or registry is read. */
export function newChannelRegistryState(): ChannelRegistryState {
  return {
    channelConfigs: new Map<string, ChannelConfig>(),
    channelDefaults: {},
    channelReadGeneration: 0,
    channelReadApplied: 0,
  };
}

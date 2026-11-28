import {
  aclBucket, anycastBucket, artifactBucket, channelBucket, chatStream, deliveryBucket, dlvStream, dmStream,
  inboxStream, isTransferStream, managerBucket, membershipBucket, membersBucket,
  objectStoreStream, presenceBucket, taskStream,
} from "./subjects.js";
import { endpointPlaneStreamNames } from "./endpoint-binding.js";
import { eventPayloadStream } from "./event-payloads.js";
import { pluginChannelStream } from "./plugin-channel-route.js";

/** Native message stores reserved for an enabled plugin channel rail. */
export function spacePluginStreams(space: string): readonly string[] {
  return [pluginChannelStream(space)];
}

/** Native streams belonging to one space, including the backing streams of its KV and object buckets.
 * A plugin or transfer stream is included only when its exact name was observed on this broker. */
export function spaceDeletionStreams(space: string, observedNames: readonly string[] = []): string[] {
  const base = [
    chatStream(space), eventPayloadStream(space), dmStream(space), taskStream(space), inboxStream(space), dlvStream(space),
    `KV_${presenceBucket(space)}`, `KV_${channelBucket(space)}`, `KV_${membersBucket(space)}`,
    `KV_${aclBucket(space)}`, `KV_${membershipBucket(space)}`, `KV_${anycastBucket(space)}`,
    `KV_${deliveryBucket(space)}`, `KV_${managerBucket(space)}`,
    ...endpointPlaneStreamNames(space), objectStoreStream(artifactBucket(space)),
  ];
  return [...base, ...spacePluginStreams(space).filter((name) => observedNames.includes(name)),
    ...observedNames.filter((name) => isTransferStream(space, name))];
}

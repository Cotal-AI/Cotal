import {
  aclBucket, artifactBucket, channelBucket, chatStream, deliveryBucket, dlvStream, dmStream,
  inboxStream, isTransferStream, managerBucket, membershipBucket, membersBucket,
  objectStoreStream, presenceBucket, taskStream,
} from "./subjects.js";
import { endpointPlaneStreamNames } from "./endpoint-binding.js";

/** Native streams belonging to one space, including the backing streams of its KV and object buckets.
 * A transfer stream is included only when its exact name was observed on this broker. */
export function spaceDeletionStreams(space: string, observedNames: readonly string[] = []): string[] {
  const base = [
    chatStream(space), dmStream(space), taskStream(space), inboxStream(space), dlvStream(space),
    `KV_${presenceBucket(space)}`, `KV_${channelBucket(space)}`, `KV_${membersBucket(space)}`,
    `KV_${aclBucket(space)}`, `KV_${membershipBucket(space)}`,
    `KV_${deliveryBucket(space)}`, `KV_${managerBucket(space)}`,
    ...endpointPlaneStreamNames(space), objectStoreStream(artifactBucket(space)),
  ];
  return [...base, ...observedNames.filter((name) => isTransferStream(space, name))];
}

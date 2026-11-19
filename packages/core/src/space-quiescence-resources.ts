import { anycastBucket, assertInboxConnId, chatStream, fanoutDurable, inboxStream, readerDurable, spacePrefix, taskStream } from "./subjects.js";
import { epAuthBucket, epfStreamName, epjStreamName, eprStreamName, eptReqStreamName, eptStreamName, epwStreamName, timerWriterDurable } from "./endpoint-binding.js";
import { recordsBucket } from "./endpoint-records.js";
import { BROKER_USER_INFO_SUBJECT } from "./broker-identity.js";

/** The stock idle-work census and its one-shot credential use these same resource coordinates.
 * Retained DM/DLV mail is deliberately absent: unread mail is not runnable work. */
export function spaceQuiescenceResources(space: string) {
  const auth = epAuthBucket(space);
  const records = recordsBucket(space);
  const requiredConsumers = [
    { stream: chatStream(space), name: fanoutDurable() },
    { stream: inboxStream(space), name: readerDurable() },
    { stream: eptReqStreamName(space), name: timerWriterDurable(space) },
  ];
  const workQueues = [taskStream(space), epwStreamName(space)];
  const ingressStreams = [epjStreamName(space), eprStreamName(space)];
  const controlStreams = [...ingressStreams, epfStreamName(space)];
  const consumerStreams = [...workQueues, ...controlStreams];
  const anycast = anycastBucket(space);
  const keyStreams = [`KV_${auth}`, `KV_${records}`, `KV_${anycast}`];
  return {
    auth, records, anycast, requiredConsumers, workQueues, controlStreams, consumerStreams, ingressStreams, keyStreams,
    streams: [...new Set([...requiredConsumers.map(row => row.stream), ...consumerStreams, ...keyStreams, eptStreamName(space)])],
    armedStream: eptStreamName(space),
    armedFilter: `${spacePrefix(space)}.ept.*.*.*.*.armed`,
  };
}

/** Read-only host observation grants. No consumer creation, message consumption, ACK, write,
 * stream mutation or direct/follower authority read is available to this one-shot credential. */
export function spaceQuiescenceReaderGrants(space: string, inbox: string): { pub: { allow: string[] }; sub: { allow: string[] } } {
  const resources = spaceQuiescenceResources(space);
  const connId = assertInboxConnId(inbox);
  return {
    pub: { allow: [
      "$JS.API.INFO",
      BROKER_USER_INFO_SUBJECT,
      ...resources.streams.map(stream => `$JS.API.STREAM.INFO.${stream}`),
      ...resources.keyStreams.map(stream => `$JS.API.STREAM.MSG.GET.${stream}`),
      ...resources.consumerStreams.map(stream => `$JS.API.CONSUMER.LIST.${stream}`),
      ...resources.requiredConsumers.map(row => `$JS.API.CONSUMER.INFO.${row.stream}.${row.name}`),
    ] },
    sub: { allow: [`_INBOX_${connId}.>`] },
  };
}

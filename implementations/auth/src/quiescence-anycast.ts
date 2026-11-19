import type { KV } from "@nats-io/kv";
import { anycastRecordWork, walkKvLatest } from "@cotal-ai/core";

export interface AnycastQuiescenceObservation {
  unknown: boolean;
  recordsEnumerated: number;
  owedNotices: number;
  pendingRemovals: number;
}

/** Internal tracking census. The host checks canonical history-one configuration/incarnation,
 * binds leader reads, and brackets this census with stream-stability and TASK observations. */
export async function observeAnycastQuiescence(kv: KV, expectedMessages: number): Promise<AnycastQuiescenceObservation> {
  const result: AnycastQuiescenceObservation = { unknown: false, recordsEnumerated: 0, owedNotices: 0, pendingRemovals: 0 };
  try {
    const entries = await walkKvLatest(kv, ">");
    result.recordsEnumerated = entries.length;
    if (!Number.isSafeInteger(expectedMessages) || expectedMessages < 0 || entries.length !== expectedMessages)
      result.unknown = true;
    for (const entry of entries) {
      const work = anycastRecordWork(entry);
      result.owedNotices += work.owedNotices;
      result.pendingRemovals += work.pendingRemovals;
    }
  } catch { result.unknown = true; }
  return result;
}

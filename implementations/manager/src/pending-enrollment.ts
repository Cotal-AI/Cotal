import { randomBytes } from "node:crypto";
import { canonicalJson, mintLifecycleUid, type SecretStore } from "@cotal-ai/core";
import { spaceKey } from "@cotal-ai/workspace";

/** One unlaunched enrollment. Its token and request survive an unanswered host call together. */
export interface PendingEnrollment<T> {
  v: 1;
  requestId: string;
  lifecycleUid: string;
  actorToken: string;
  input: T;
}

/** A manager's pending actor is replayed only for the same owner, spawner and launch authority.
 * The current served request may differ, but the saved input carries the original host request. */
export async function pendingEnrollment<T>(args: {
  store: SecretStore;
  space: string;
  instanceId: string;
  actor: string;
  input: T;
  authority: unknown;
}): Promise<{ key: string; record: PendingEnrollment<T>; created: boolean }> {
  const key = `manager/enrollments/${spaceKey(args.space)}/${args.instanceId}/${args.actor}.json`;
  const authority = canonicalJson(JSON.parse(JSON.stringify(args.authority)));
  const candidate = {
    v: 1 as const,
    requestId: `enroll${mintLifecycleUid()}`,
    lifecycleUid: mintLifecycleUid(),
    actorToken: randomBytes(32).toString("base64url"),
    input: args.input,
  };
  const encoded = JSON.stringify({ ...candidate, authority });
  const created = await args.store.create(key, encoded);
  const saved = await args.store.get(key);
  if (saved === undefined) throw new Error(`pending enrollment for "${args.actor}" disappeared before it could be read`);
  let record: PendingEnrollment<T> & { authority: string };
  try { record = JSON.parse(saved) as typeof record; }
  catch { throw new Error(`pending enrollment for "${args.actor}" is unreadable; refusing to replace its token`); }
  if (record === null || typeof record !== "object" || record.v !== 1 || !/^enroll[a-z0-9]{26,32}$/.test(record.requestId) ||
      !/^[a-z0-9]{26,32}$/.test(record.lifecycleUid) || !/^[A-Za-z0-9_-]{43}$/.test(record.actorToken))
    throw new Error(`pending enrollment for "${args.actor}" is invalid; refusing to replace its token`);
  if (record.authority !== authority)
    throw new Error(`the name "${args.actor}" is held by this manager's earlier enrollment with different launch authority. Retry the original persona and caller, then stop the launched agent before changing its authority`);
  // Validate JSON before any saved request is sent. A corrupt record must never become a new request.
  canonicalJson(record.input);
  return { key, record, created };
}

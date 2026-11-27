import { brandCoreError } from "./error-brand.js";
import { drainAndClose } from "./connection-cleanup.js";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { dialerFor } from "./endpoint.js";
import {
  dmStream,
  dmDurable,
  aclBucket,
  aclKey,
  membersBucket,
  dlvStream,
  dlvDurable,
  principalKey,
  memberKey,
  deprovisionTargetPrincipal,
} from "./subjects.js";
import { isConsumerNotFound } from "./jetstream-missing.js";
import { isCasLoss } from "./endpoint-records.js";
import { openAclRegistry, fenceAcl } from "./acls.js";
import { openMembersRegistry } from "./members.js";
import { standaloneConnectOpts } from "./standalone-connect.js";

/**
 * Bounded accounting for logical resources inspected, deleted, verified absent, or refused
 * during agent lifecycle deprovisioning.
 */
export interface DeprovisionResourceAccounting {
  /** Total count of distinct candidate resources examined across consumers, ACL and members. */
  examined: number;
  /** Uniquely attributable removals; null when a consumer disappeared without a native winner token. */
  deleted: number | null;
  /** Resources already absent at this attempt's first native observation of each resource. */
  absent: number;
  /** Number of resources that could not be deleted (broker errors). */
  refused: number;
  /** Native consumer DELETE success replies, not uniquely attributable removals. */
  acknowledged: number;
  /** Live resources observed gone without attributing removal to this call. */
  disappeared: number;
  /** Durable consumer accounting. */
  consumers: { examined: number; deleted: number | null; absent: number; refused: number; acknowledged: number; disappeared: number };
  /** Read-ACL entry accounting; disappeared means a competing purge won the native CAS. */
  acls: { examined: number; deleted: number; absent: number; refused: number; disappeared: number };
  /** Durable membership entry accounting; disappeared means a competing purge won the native CAS. */
  members: { examined: number; deleted: number; absent: number; refused: number; disappeared: number };
}

/** Add `part` into `total`. A null `deleted` on either side keeps the sum null, since one
 *  unattributable removal leaves the whole count unattributable. */
export function addDeprovisionAccounting(total: DeprovisionResourceAccounting, part: DeprovisionResourceAccounting): void {
  total.examined += part.examined;
  total.deleted = total.deleted === null || part.deleted === null ? null : total.deleted + part.deleted;
  total.absent += part.absent;
  total.refused += part.refused;
  total.acknowledged += part.acknowledged;
  total.disappeared += part.disappeared;
  total.consumers.examined += part.consumers.examined;
  total.consumers.deleted = total.consumers.deleted === null || part.consumers.deleted === null ? null : total.consumers.deleted + part.consumers.deleted;
  total.consumers.absent += part.consumers.absent;
  total.consumers.refused += part.consumers.refused;
  total.consumers.acknowledged += part.consumers.acknowledged;
  total.consumers.disappeared += part.consumers.disappeared;
  total.acls.examined += part.acls.examined;
  total.acls.deleted += part.acls.deleted;
  total.acls.absent += part.acls.absent;
  total.acls.refused += part.acls.refused;
  total.acls.disappeared += part.acls.disappeared;
  total.members.examined += part.members.examined;
  total.members.deleted += part.members.deleted;
  total.members.absent += part.members.absent;
  total.members.refused += part.members.refused;
  total.members.disappeared += part.members.disappeared;
}

/** Error raised when deprovisioning encounters an unexpected failure, retaining partial deletion accounting. */
export class DeprovisionError extends Error {
  static { brandCoreError(this, "DeprovisionError"); }

  public readonly accounting: DeprovisionResourceAccounting;
  constructor(message: string, accounting: DeprovisionResourceAccounting, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "DeprovisionError";
    this.accounting = accounting;
  }
}

/** Fence a retiring LIFECYCLE before its membership inventory is read: narrow its read-ACL row to no
 *  reads ({@link fenceAcl}, a compare-and-set update that never creates the row). The delivery daemon
 *  re-reads that exact row around every membership row a join creates, so after this returns no join
 *  of the lifecycle keeps a row the inventory does not list. Pass a `deprovisioner` credential pinned to
 *  this lifecycle: its exact-key ACL grants cover the read and the update, and it needs no member
 *  channels. Reads the row through that exact-key direct get, so on a clustered broker a stale read
 *  only loses the compare-and-set and retries. */
export async function fenceLifecycleAcl(opts: {
  servers: string;
  space: string;
  targetId: string;
  lifecycleUid: string;
  creds?: string;
}): Promise<"fenced" | "absent"> {
  const nc = await dialerFor(opts.servers)({
    servers: opts.servers,
    ...standaloneConnectOpts({ creds: opts.creds, tls: false }),
    // A teardown step: fail fast, as deprovisionAgent does.
    maxReconnectAttempts: 0,
    timeout: 5_000,
  });
  try {
    const t = deprovisionTargetPrincipal({ principal: opts.targetId, lifecycleUid: opts.lifecycleUid });
    const kv = await new Kvm(nc).open(aclBucket(opts.space), { allow_direct: true });
    return await fenceAcl(kv, principalKey(t.owner, t.actor).key, t.lifecycleUid);
  } finally {
    await drainAndClose(nc);
  }
}

/** Delete a departed agent LIFECYCLE's provisioning footprint (#159 Part B) — the teardown counterpart
 *  to {@link provisionAgent}. Removes exactly what the provisioner minted for THIS incarnation: its two
 *  bind-only durables (`dm_<o>-<a>-<uid>`, `dlv_<o>-<a>-<uid>`) and its lifecycle-keyed read-ACL row.
 *  Idempotent — a missing consumer / absent ACL row is a no-op (the agent may have exited before a
 *  durable was created, or a re-run). LIFECYCLE-EXACT by construction (SPEC §13.1): every name this
 *  deletes embeds the target uid, so a stale/replayed teardown for a retired lifecycle names only
 *  retired resources — it structurally cannot touch a same-alias successor, and the deprovisioner
 *  cred's exact-name grants make a wrong-uid delete broker-DENIED, not just a no-op.
 *
 *  Does NOT touch the role-SHARED `svc_<role>` TASK durable (deleting it would break the role's other
 *  agents — it lives until space teardown), nor the ephemeral `chathist_…-<uid>` history consumers (they
 *  self-clean on the agent's disconnect). The creds FILE is removed by the caller (a manager-local
 *  filesystem concern, not a broker one). Pass a TARGET-PINNED `deprovisioner` cred (see
 *  {@link mintCreds}); a bare connection (open mode) never calls this — an open mesh mints nothing. */
export async function deprovisionAgent(opts: {
  servers: string;
  space: string;
  targetId: string;
  lifecycleUid: string;
  /** Concrete channels or families (`team.>`) whose membership rows to purge; must equal the cred's
   *  `memberChannels`. */
  memberChannels?: readonly string[];
  creds?: string;
}): Promise<DeprovisionResourceAccounting> {
  const nc = await dialerFor(opts.servers)({
    servers: opts.servers,
    ...standaloneConnectOpts({ creds: opts.creds, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }),
    // This is a detached, fire-and-forget teardown — it must FAIL FAST, never hang, so the caller's
    // fail-loud `.catch` is load-bearing: no reconnect loop (a wedged broker rejects promptly instead of
    // looping silently) and a bounded initial connect. Without this a broker-down deprovision would sit
    // pending forever and the footprint would survive with no log.
    maxReconnectAttempts: 0,
    timeout: 5_000,
  });

  const accounting: DeprovisionResourceAccounting = {
    examined: 0,
    deleted: 0,
    absent: 0,
    refused: 0,
    acknowledged: 0,
    disappeared: 0,
    consumers: { examined: 0, deleted: 0, absent: 0, refused: 0, acknowledged: 0, disappeared: 0 },
    acls: { examined: 0, deleted: 0, absent: 0, refused: 0, disappeared: 0 },
    members: { examined: 0, deleted: 0, absent: 0, refused: 0, disappeared: 0 },
  };

  try {
    // The target is a full principal dot-form (user-mode agent) or a bare static actor id under the
    // local owner, PLUS the exact lifecycle uid being torn down — the SAME resolution the
    // deprovisioner cred's permission pin used, so the delete names and the grant can't diverge.
    const t = deprovisionTargetPrincipal({ principal: opts.targetId, lifecycleUid: opts.lifecycleUid, memberChannels: opts.memberChannels });
    const jsm = await jetstreamManager(nc);
    const errors: Error[] = [];

    // 1. Read-ACL entry. This CAS fences only this key's transition, not the other resources.
    accounting.acls.examined++;
    accounting.examined++;
    let aclSafe = false;
    try {
      const aclsKv = await openAclRegistry(nc, opts.space);
      const aclKeyStr = aclKey(principalKey(t.owner, t.actor).key, t.lifecycleUid);
      const aclRes = await purgeKvKeyWithAccounting(jsm, aclsKv, aclBucket(opts.space), aclKeyStr);
      aclSafe = true;
      if (aclRes.outcome === "deleted") {
        accounting.acls.deleted++;
        if (accounting.deleted !== null) accounting.deleted++;
      } else if (aclRes.outcome === "disappeared") {
        accounting.acls.disappeared++;
        accounting.disappeared++;
      } else {
        accounting.acls.absent++;
        accounting.absent++;
      }
    } catch (e) {
      accounting.acls.refused++;
      accounting.refused++;
      errors.push(e as Error);
    }

    // 2. Consumers (dm + dlv)
    accounting.consumers.examined += 2;
    accounting.examined += 2;
    if (!aclSafe) {
      // The key may still be live. Do not erase its consumers or invent absence.
      accounting.consumers.refused += 2;
      accounting.refused += 2;
    } else for (const [stream, name] of [
      [dmStream(opts.space), dmDurable(t.owner, t.actor, t.lifecycleUid)],
      [dlvStream(opts.space), dlvDurable(t.owner, t.actor, t.lifecycleUid)],
    ]) {
      try {
        const outcome = await deleteConsumerIdempotent(jsm, stream, name, () => {
          accounting.consumers.acknowledged++;
          accounting.acknowledged++;
        });
        if (outcome === "absent") {
          accounting.consumers.absent++;
          accounting.absent++;
        } else if (outcome === "disappeared") {
          accounting.consumers.disappeared++;
          accounting.disappeared++;
          accounting.consumers.deleted = null;
          accounting.deleted = null;
        } else {
          throw new Error(`${stream}/${name} remains live after acknowledged DELETE`);
        }
      } catch (e) {
        accounting.consumers.refused++;
        accounting.refused++;
        errors.push(e as Error);
      }
    }

    // 3. Member rows
    if (t.memberChannels.length > 0) {
      if (!aclSafe) {
        accounting.members.examined += t.memberChannels.length;
        accounting.examined += t.memberChannels.length;
        accounting.members.refused += t.memberChannels.length;
        accounting.refused += t.memberChannels.length;
      } else {
        try {
          const membersKv = await openMembersRegistry(nc, opts.space);
          for (const ch of t.memberChannels) {
            accounting.members.examined++;
            accounting.examined++;
            try {
              const mKeyStr = memberKey(ch, principalKey(t.owner, t.actor).key, t.lifecycleUid);
              const mRes = await purgeKvKeyWithAccounting(jsm, membersKv, membersBucket(opts.space), mKeyStr);
              if (mRes.outcome === "deleted") {
                accounting.members.deleted++;
                if (accounting.deleted !== null) accounting.deleted++;
              } else if (mRes.outcome === "disappeared") {
                accounting.members.disappeared++;
                accounting.disappeared++;
              } else {
                accounting.members.absent++;
                accounting.absent++;
              }
            } catch (e) {
              accounting.members.refused++;
              accounting.refused++;
              errors.push(e as Error);
            }
          }
        } catch (e) {
          for (let i = accounting.members.examined; i < t.memberChannels.length; i++) {
            accounting.members.examined++;
            accounting.examined++;
            accounting.members.refused++;
            accounting.refused++;
          }
          errors.push(e as Error);
        }
      }
    }

    if (errors.length > 0) {
      throw new DeprovisionError(
        `deprovision refused on ${errors.length} resource(s): ${errors.map((e) => e.message).join("; ")}`,
        accounting,
        errors[0],
      );
    }

    return accounting;
  } finally {
    await drainAndClose(nc);
  }
}

/** Purge one exact KV key with native revision fencing. A lost CAS never proves absence. */
async function purgeKvKeyWithAccounting(
  jsm: JetStreamManager,
  kv: KV,
  bucket: string,
  key: string,
): Promise<{ outcome: "deleted" | "absent" | "disappeared"; status: "won" | "raced-loss" | "already-tombstoned" | "missing" }> {
  const stream = `KV_${bucket}`;
  const subject = `$KV.${bucket}.${key}`;
  const observe = async (): Promise<{ live: boolean; missing: boolean; seq?: number }> => {
    try {
      const msg = await jsm.direct.getMessage(stream, { last_by_subj: subject });
      if (msg === null) return { live: false, missing: true };
      const op = msg.header?.get("KV-Operation");
      return { live: op !== "PURGE" && op !== "DEL", missing: false, seq: msg.seq };
    } catch (e) {
      if ([404, 10037].includes((e as { code?: number }).code ?? -1)) return { live: false, missing: true };
      throw e;
    }
  };
  const before = await observe();
  if (before.missing) return { outcome: "absent", status: "missing" };
  try {
    await kv.purge(key, { previousSeq: before.seq });
    return before.live ? { outcome: "deleted", status: "won" } : { outcome: "absent", status: "already-tombstoned" };
  } catch (err: unknown) {
    if (isCasLoss(err)) {
      const after = await observe();
      if (after.live) throw new Error(`CAS loss left a live ${bucket}/${key}`, { cause: err });
      return { outcome: before.live ? "disappeared" : "absent", status: "raced-loss" };
    }
    throw err;
  }
}

/** Observe the exact consumer before and after a native DELETE. The boolean is an acknowledgment,
 * not a unique-removal token; two simultaneous callers can both receive true. */
async function deleteConsumerIdempotent(jsm: JetStreamManager, stream: string, name: string, onAcknowledged: () => void): Promise<"disappeared" | "absent" | "still-live"> {
  const present = async (): Promise<boolean> => {
    try {
      await jsm.consumers.info(stream, name);
      return true;
    } catch (e) {
      if (isConsumerNotFound(e)) return false;
      throw e;
    }
  };
  if (!(await present())) return "absent";
  let acknowledged: boolean;
  try {
    acknowledged = await jsm.consumers.delete(stream, name);
  } catch (e) {
    // An overlapping deletion can return not-found after our pre-read. Native post-state settles
    // disappearance, but cannot attribute that deletion or an acknowledgment to this caller.
    if (!isConsumerNotFound(e)) throw e;
    if (!(await present())) return "disappeared";
    throw e;
  }
  if (!acknowledged) throw new Error(`native DELETE did not acknowledge ${stream}/${name}`);
  onAcknowledged();
  return (await present()) ? "still-live" : "disappeared";
}

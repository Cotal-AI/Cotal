/**
 * Durable read-ACL registry — read/write helpers over the per-space ACL KV bucket
 * (`cotal_acl_<space>`). One {@link AclRecord} per OWNER under {@link aclKey}, holding that owner's
 * current read ACL (`allowSubscribe`). This is the **keystone** that lets the Plane-3 trusted reader
 * run in a stateless, server-side **delivery daemon**: the reader re-authorizes every durable entry
 * against the owner's ACL read FRESH from here (not the manager's in-memory ledger), so a daemon
 * restart re-reads the truth instead of nak-looping every unknown owner to `term()`.
 *
 * Writes are **privileged** — the manager records an agent's ACL at mint time (the same act as baking
 * it into the JWT); agent-authored ACLs are forbidden (they would self-authorize reads). Every write
 * is a single ATOMIC CAS put of the whole value, so a present record is always complete: a present
 * `allowSubscribe: []` is a known "reads nothing" policy (the reader DROPS), distinct from an ABSENT
 * record (a genuinely-unknown owner — the reader DEFERS, never drops).
 */
import { Kvm, type KV } from "@nats-io/kv";
import { aclBucket, aclKey } from "./subjects.js";
import type { AclRecord } from "./types.js";

/** Open the ACL registry bucket. Auth mode OPENs the bucket pre-created at `cotal up`; a privileged
 *  caller may pass `{ create: true }` to lazily CREATE it. Mirrors {@link openMembersRegistry}. */
export async function openAclRegistry(
  nc: import("@nats-io/transport-node").NatsConnection,
  space: string,
  opts: { create?: boolean } = {},
): Promise<KV> {
  const kvm = new Kvm(nc);
  return opts.create ? kvm.create(aclBucket(space)) : kvm.open(aclBucket(space));
}

/**
 * Read one owner's read-ACL record, or `undefined` if there is NO usable record — absent, deleted,
 * undecodable, or missing the `allowSubscribe` array. The reader maps that `undefined` to DEFER (an
 * unknown owner, e.g. a pre-provision race — never dropped). A PRESENT record returns its
 * `allowSubscribe` as-is, **including `[]`** (a known no-read policy → DROP). The CAS revision is
 * returned alongside for a read-modify-write.
 */
export async function readAcl(
  kv: KV,
  owner: string,
): Promise<{ record: AclRecord; revision: number } | undefined> {
  const e = await kv.get(aclKey(owner));
  if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
  try {
    const record = e.json<AclRecord>();
    if (!Array.isArray(record.allowSubscribe)) return undefined; // half/garbled — treat as unknown (DEFER)
    return { record, revision: e.revision };
  } catch {
    return undefined;
  }
}

/**
 * Record (set) an owner's read ACL — a single ATOMIC CAS put of the full value, never
 * create-then-populate, so a present record is always complete and `[]` always means "no-read", never
 * "not yet written". Bumps `revision`. Retries a revision conflict by re-reading. Idempotent in
 * effect: writing the same `allowSubscribe` is harmless. Use `allowSubscribe: []` to revoke all reads
 * (the reader then DROPS the owner's entries) — distinct from {@link deleteAcl}, which removes the row.
 */
export async function commitAcl(kv: KV, owner: string, allowSubscribe: string[]): Promise<AclRecord> {
  const key = aclKey(owner);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readAcl(kv, owner);
    const next: AclRecord = {
      allowSubscribe: [...allowSubscribe],
      revision: (cur?.record.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    const data = new TextEncoder().encode(JSON.stringify(next));
    if (!cur) {
      try {
        await kv.create(key, data);
        return next;
      } catch (e) {
        lastErr = e;
        // Either we lost a create race, or the row is PRESENT but garbled — readAcl reports both
        // as `undefined` (DEFER), and a garbled row would make this create conflict on every
        // attempt (the owner stays wedged until purge). CAS-overwrite at the raw revision: the
        // atomic full-value put restores the "present record is always complete" invariant.
        try {
          const raw = await kv.get(key);
          if (raw) {
            await kv.update(key, data, raw.revision);
            return next;
          }
        } catch (e2) {
          lastErr = e2;
        }
        continue; // raced a concurrent writer — re-read and retry
      }
    }
    try {
      await kv.update(key, data, cur.revision);
      return next;
    } catch (e) {
      lastErr = e; // revision moved under us — re-read and retry
      continue;
    }
  }
  // Carry the last underlying KV failure: without it the operator sees only this wrapper and the
  // actual cause (timeout, permission, sequence conflict) is permanently lost.
  throw new Error(
    `acl CAS exhausted retries for ${owner}${lastErr ? ` - last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ""}`,
    lastErr instanceof Error ? { cause: lastErr } : undefined,
  );
}

/** Permanently remove an owner's ACL row (GC / footprint deletion — revocation deletes the footprint
 *  AFTER invalidating creds). Distinct from a `commitAcl(kv, owner, [])` write, which keeps a present
 *  "no-read" record so the reader DROPS (vs. DEFER for an absent owner). */
export async function deleteAcl(kv: KV, owner: string): Promise<void> {
  await kv.purge(aclKey(owner));
}

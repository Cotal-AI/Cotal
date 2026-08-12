/**
 * Durable read-ACL registry — read/write helpers over the per-space ACL KV bucket
 * (`cotal_acl_<space>`). One {@link AclRecord} per LIFECYCLE under {@link aclKey}
 * (`<owner>.<actor>.<lifecycleUid>`, SPEC §13.1), holding that incarnation's
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
import { aclBucket, aclKey, aclAliasFilter, parseLifecycleSubjectKey, patternInAllow } from "./subjects.js";
import type { AclRecord } from "./types.js";
import { liveKvEntries } from "./kv-scan.js";

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
  lifecycleUid: string,
): Promise<{ record: AclRecord; revision: number } | undefined> {
  const e = await kv.get(aclKey(owner, lifecycleUid));
  if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
  try {
    const record = e.json<AclRecord>();
    if (!Array.isArray(record.allowSubscribe)) return undefined; // half/garbled — treat as unknown (DEFER)
    return { record, revision: e.revision };
  } catch {
    return undefined;
  }
}

/** Error for an alias with MORE than one live ACL row: §13.1's invariant is at most one live
 *  lifecycle per alias, so two rows are split-brain evidence (a reservation breach or an unfinished
 *  teardown), and an alias-level authorizer MUST refuse loudly rather than pick one. */
export class AmbiguousAclAlias extends Error {
  constructor(
    readonly principal: string,
    readonly lifecycleUids: string[],
  ) {
    super(
      `read-ACL alias "${principal}" resolves to ${lifecycleUids.length} live lifecycle rows (${lifecycleUids.join(", ")}); ` +
        `at most one lifecycle may be live per alias (SPEC 13.1) - refusing to authorize on a first-match guess`,
    );
  }
}

/**
 * Resolve an ALIAS (`<owner>.<actor>` dot-form) to its single live lifecycle-keyed ACL row — the
 * bounded prefix enumeration for callers that hold no lifecycle UID (a runtime durable-join authz).
 * Returns `undefined` when NO live row exists (unknown alias — the caller DEFERS/refuses), the row +
 * its uid when exactly ONE does, and THROWS {@link AmbiguousAclAlias} on two or more: taking
 * first-match would let a stale row authorize (or de-authorize) the successor. Keys that do not parse
 * as `<owner>.<actor>.<uid>` are ignored (foreign shapes never authorize).
 */
export async function readAclForAlias(
  kv: KV,
  principal: string,
): Promise<{ record: AclRecord; revision: number; lifecycleUid: string } | undefined> {
  // HONESTY (SPEC 13.1 residual, panel-locked): "at most one live lifecycle per alias" is
  // fail-loud + exact-name teardown, NOT a broker occupancy CAS (reservation lands with P2).
  // A FAILED detached teardown leaves the predecessor's row live; a same-alias successor then
  // hits AmbiguousAclAlias on every durable-join and stays LIVE-ONLY until an operator re-runs
  // the exact-uid deprovision (or a future D30/D33 reconciler, which does not exist yet). The
  // fail direction is deliberate: refuse beats silently inheriting a predecessor's ACL.
  const first = await enumerateLiveAclRows(kv, principal);
  if (first.length > 1) throw new AmbiguousAclAlias(principal, first.map((l) => l.lifecycleUid).sort());
  // POST-SCAN RE-VERIFY (panel bar, TOCTOU close): `kv.keys()` is a point-in-time snapshot
  // bounded by the stream sequence at consumer-create, so a successor row COMMITTED AFTER that
  // snapshot is invisible to the first pass — a genuinely dual-live alias would resolve as the
  // lone (possibly predecessor) row instead of refusing. Enumerate a SECOND time and act on the
  // fresh pass: a row that appeared makes the alias ambiguous (refuse), a row that vanished
  // makes it absent (defer). Two live rows in EITHER pass refuse. Bounded at two passes — an
  // alias replaced BETWEEN the passes (disjoint singles) also refuses, and the caller's retry
  // resolves against the settled state; anything stronger is the P2 occupancy reservation.
  // DO NOT COLLAPSE THESE TWO CALLS. `enumerateLiveAclRows` is single-pass, which makes it look like
  // calling it twice is redundant work to optimize away. It is not: the second enumerate is the
  // TOCTOU barrier. Each pass is bounded by the stream sequence at ITS OWN consumer-create, so a
  // successor row committed after the first pass is invisible to it and only the second can see it.
  // One enumerate silently disables AmbiguousAclAlias detection and lets a respawn inherit a
  // predecessor's ACL — a lifecycle-safety regression, not a speedup.
  const second = await enumerateLiveAclRows(kv, principal);
  if (second.length > 1) throw new AmbiguousAclAlias(principal, second.map((l) => l.lifecycleUid).sort());
  if (second.length === 0) return undefined;
  if (first.length === 1 && first[0].lifecycleUid !== second[0].lifecycleUid)
    throw new AmbiguousAclAlias(principal, [first[0].lifecycleUid, second[0].lifecycleUid].sort());
  return { record: second[0].record, revision: second[0].revision, lifecycleUid: second[0].lifecycleUid };
}

/** One live-row enumeration pass for {@link readAclForAlias}: LIVE rows, not keys — DEL/PURGE
 *  markers and garbled values are excluded BEFORE anything counts toward ambiguity, because the
 *  refusal invariant is ">=2 LIVE rows" and counting raw keys would fail-closed the NORMAL
 *  deprovision-then-respawn path.
 *
 *  ONE filtered pass. This used to be `keys(filter)` plus a per-key `readAcl()` get, and
 *  {@link readAclForAlias} calls it TWICE, so it cost 2N round trips on the durable-join re-auth
 *  path. The marker/garble exclusion that the per-key read provided is now split: DEL/PURGE is the
 *  collapse's job (which also closes the resurrection case a per-key read could not see), and an
 *  undecodable value is dropped here. */
async function enumerateLiveAclRows(
  kv: KV,
  principal: string,
): Promise<{ lifecycleUid: string; record: AclRecord; revision: number }[]> {
  const live: { lifecycleUid: string; record: AclRecord; revision: number }[] = [];
  for (const e of await liveKvEntries(kv, aclAliasFilter(principal))) {
    const parsed = parseLifecycleSubjectKey(e.key);
    if (!parsed || `${parsed.owner}.${parsed.actor}` !== principal) continue;
    let record: AclRecord;
    try { record = e.json<AclRecord>(); } catch { continue; } // a garbled value is never a live row
    // Same half/garbled rejection {@link readAcl} applies: a record without its `allowSubscribe`
    // array is UNKNOWN (the reader DEFERS), not a live row, and must not count toward ambiguity.
    if (!Array.isArray(record.allowSubscribe)) continue;
    live.push({ lifecycleUid: parsed.lifecycleUid, record, revision: e.revision });
  }
  return live;
}

/**
 * Record (set) an owner's read ACL — a single ATOMIC CAS put of the full value, never
 * create-then-populate, so a present record is always complete and `[]` always means "no-read", never
 * "not yet written". Bumps `revision`. Retries a revision conflict by re-reading. Idempotent in
 * effect: writing the same `allowSubscribe` is harmless. Use `allowSubscribe: []` to revoke all reads
 * (the reader then DROPS the owner's entries) — distinct from {@link deleteAcl}, which removes the row.
 */
export type CommitAclOpts = {
  /**
   * Credential re-issue: raise the history ceiling (`issuedAllowSubscribe`) to match `allowSubscribe`.
   * Use from provision/remint — the same act that bakes the list into the JWT. Plain commits
   * (revocation, runtime narrow) leave the ceiling in place so a registry-only widen cannot mint
   * history reach the broker credential does not grant (SPEC §9.6).
   */
  reissue?: boolean;
};

export async function commitAcl(
  kv: KV,
  owner: string,
  lifecycleUid: string,
  allowSubscribe: string[],
  opts: CommitAclOpts = {},
): Promise<AclRecord> {
  const key = aclKey(owner, lifecycleUid);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readAcl(kv, owner, lifecycleUid);
    // Ceiling is writable ONLY by create and by explicit reissue (provision/remint — the same act
    // that bakes allowSubscribe into the JWT). A plain commitAcl MUST NOT raise it: if it could,
    // the fix for "registry outruns credential" would be the same hole one field over. Legacy rows
    // missing the field treat their then-current allowSubscribe as the ceiling.
    let issued: string[];
    if (opts.reissue || !cur) {
      issued = [...allowSubscribe];
    } else {
      issued = [...(cur.record.issuedAllowSubscribe ?? cur.record.allowSubscribe)];
      const excess = allowSubscribe.filter((a) => !patternInAllow(issued, a));
      if (excess.length > 0) {
        throw new Error(
          `commitAcl: cannot raise ACL above mint-time ceiling without reissue ` +
            `(entries [${excess.join(", ")}] not within ceiling [${issued.join(", ")}]); ` +
            `pass { reissue: true } only from the provisioning path that also remints the JWT`,
        );
      }
    }
    const next: AclRecord = {
      allowSubscribe: [...allowSubscribe],
      issuedAllowSubscribe: issued,
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

/** Permanently remove one LIFECYCLE's ACL row (GC / footprint deletion — revocation deletes the
 *  footprint AFTER invalidating creds). Lifecycle-exact by construction: a replayed delete for a
 *  retired lifecycle names a key the successor's row does not share. Distinct from a
 *  `commitAcl(kv, owner, uid, [])` write, which keeps a present "no-read" record so the reader DROPS
 *  (vs. DEFER for an absent owner). */
export async function deleteAcl(kv: KV, owner: string, lifecycleUid: string): Promise<void> {
  await kv.purge(aclKey(owner, lifecycleUid));
}

import { findManagedActor, loadActorLedger, withManagedGrantTransaction, type ActorKind, type ActorRow } from "./ledger.js";

/** The exact incarnation of a managed grant, without grant or credential data. */
export interface ManagedGrantCoordinate {
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
}

export interface ManagedGrantSubtreeSnapshot {
  readonly root: ManagedGrantCoordinate;
  readonly descendants: readonly (ManagedGrantCoordinate & { readonly parent: string })[];
}

/** A delete failed. `removed` lists the exact rows already deleted, in deletion order. */
export class ManagedGrantSubtreeRevokeError extends Error {
  constructor(readonly removed: readonly ManagedGrantCoordinate[], cause: unknown) {
    super("Failed to revoke the managed grant subtree", { cause });
    this.name = "ManagedGrantSubtreeRevokeError";
  }
}

function principal(row: Pick<ActorRow, "owner" | "actor">): string {
  return `${row.owner}.${row.actor}`;
}

function coordinate({ owner, actor, lifecycleUid }: ActorRow): ManagedGrantCoordinate {
  if (!lifecycleUid) throw new Error(`Managed grant ${owner}.${actor} has no lifecycle UID`);
  return { owner, actor, lifecycleUid };
}

type Descendant = ActorRow & { kind: ActorKind; parent: string };

/** Return the named ledger descendants in postorder, or null for a cycle. */
function descendantsOf(dir: string, root: ActorRow): Descendant[] | null {
  const byParent = new Map<string, Descendant[]>();
  for (const row of loadActorLedger(dir)) {
    if (row.parent === undefined) continue;
    const children = byParent.get(row.parent) ?? [];
    children.push({ ...row, parent: row.parent });
    byParent.set(row.parent, children);
  }
  const rootKey = principal(root);
  const pending = [...(byParent.get(rootKey) ?? [])];
  const descendants: Descendant[] = [];
  while (pending.length) {
    const row = pending.pop()!;
    const key = principal(row);
    // Each row names at most one parent, so a cycle reachable from the root contains the root.
    if (key === rootKey) return null;
    descendants.push(row);
    for (const child of byParent.get(key) ?? []) pending.push(child);
  }
  return descendants.reverse();
}

/** Read the exact managed subtree without deleting any grants. Descendants are leaf first. */
export function snapshotManagedGrantSubtree(
  dir: string, owner: string, actor: string, expectedLifecycleUid?: string,
): ManagedGrantSubtreeSnapshot | "absent" | "superseded" {
  return withManagedGrantTransaction(dir, () => {
    const root = findManagedActor(dir, owner, actor);
    if (!root) return "absent";
    if (expectedLifecycleUid !== undefined && root.lifecycleUid !== expectedLifecycleUid) return "superseded";
    const descendants = descendantsOf(dir, root);
    if (!descendants) throw new Error(`Managed grant subtree at ${principal(root)} contains a delegation cycle`);
    if (descendants.some((row) => row.kind !== "managed-agent"))
      throw new Error(`Managed grant subtree at ${principal(root)} contains an interactive grant`);
    return { root: coordinate(root), descendants: descendants.map((row) => ({ ...coordinate(row), parent: row.parent })) };
  });
}

/** Revoke a snapshot leaf first, only if its exact managed subtree still matches under the writers' lock. */
export function commitManagedGrantSubtreeRevoke(
  dir: string, snapshot: ManagedGrantSubtreeSnapshot,
): { readonly status: "removed"; readonly removed: readonly ManagedGrantCoordinate[] } | { readonly status: "changed" } {
  return withManagedGrantTransaction(dir, (tx) => {
    const root = findManagedActor(dir, snapshot.root.owner, snapshot.root.actor);
    if (!root?.lifecycleUid || root.lifecycleUid !== snapshot.root.lifecycleUid) return { status: "changed" };
    const descendants = descendantsOf(dir, root);
    if (!descendants || descendants.length !== snapshot.descendants.length) return { status: "changed" };
    const expected = new Map(snapshot.descendants.map((row) => [principal(row), row]));
    if (expected.size !== descendants.length || descendants.some((row) => {
      const before = expected.get(principal(row));
      return row.kind !== "managed-agent" || !row.lifecycleUid || row.lifecycleUid !== before?.lifecycleUid || row.parent !== before.parent;
    })) return { status: "changed" };

    const coordinates = [...descendants, root].map(coordinate);
    const removed: ManagedGrantCoordinate[] = [];
    for (const row of coordinates) {
      try {
        if (!tx.revokeManagedAt(row.owner, row.actor, row.lifecycleUid))
          throw new Error(`Managed grant ${principal(row)} disappeared or changed during revocation`);
      } catch (cause) {
        throw new ManagedGrantSubtreeRevokeError(removed, cause);
      }
      removed.push(row);
    }
    return { status: "removed", removed };
  });
}

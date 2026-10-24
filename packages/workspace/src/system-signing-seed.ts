/**
 * Host-only custody of the broker's system-account signing seed, so an own-broker root can mint the
 * short-lived `$SYS` observer credentials service caller issuance bootstraps from after the boot that
 * created the space. The persisted trust record stays seed-free (`putSpaceAuth` strips it); this record
 * lives beside it in the same secret store and never enters a client bundle, a registration or a
 * message. It is written in the one window the seed exists in memory: space creation, and an explicit
 * `cotal up --rotate-sys`, which replaces it with the successor's.
 */
import type { SecretStore, SpaceAuth } from "@cotal-ai/core";
import { spaceSegment } from "./auth-paths.js";

/** Where one space's system-account signing seed lives in the root's secret store. */
export const systemSigningSeedKey = (space: string): string => `auth/${spaceSegment(space)}/system-signing-seed.json`;

export interface SystemSigningSeedRecord { v: 1; kind: "system-signing-seed"; sysPub: string; signingSeed: string }

/** Retain the system-account signing seed `auth` carries in memory, replacing any earlier record for
 *  the space (a rotation retires the old account, and its seed with it). Refuses a stripped signer. */
export async function retainSystemSigningSeed(store: SecretStore, auth: SpaceAuth): Promise<void> {
  if (!auth.sys.signingSeed)
    throw new Error(`retainSystemSigningSeed: the trust record for "${auth.space}" carries no system-account signing seed in memory; it exists only at space creation and rotation`);
  const record: SystemSigningSeedRecord = { v: 1, kind: "system-signing-seed", sysPub: auth.sys.pub, signingSeed: auth.sys.signingSeed };
  await store.put(systemSigningSeedKey(auth.space), JSON.stringify(record));
}

/** The retained record for `space`, or `undefined` when this root never retained one. A record that
 *  does not parse is refused rather than read around. */
export async function readSystemSigningSeed(store: SecretStore, space: string): Promise<SystemSigningSeedRecord | undefined> {
  const raw = await store.get(systemSigningSeedKey(space));
  if (raw === undefined) return undefined;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error(`the system-account signing seed record for "${space}" is not well formed; restore it or rotate the system account`); }
  if (o === null || typeof o !== "object" || Array.isArray(o) || o.v !== 1 || o.kind !== "system-signing-seed" || typeof o.sysPub !== "string" || typeof o.signingSeed !== "string")
    throw new Error(`the system-account signing seed record for "${space}" is not well formed; restore it or rotate the system account`);
  return { v: 1, kind: "system-signing-seed", sysPub: o.sysPub, signingSeed: o.signingSeed };
}

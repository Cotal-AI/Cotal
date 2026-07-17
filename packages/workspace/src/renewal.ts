import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  identityFromCreds,
  mintCreds,
  writeSecretFile,
  type Profile,
  type SecretStore,
} from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "./auth-paths.js";
import { workspaceSecretStore } from "./secret-store-fs.js";

/**
 * D5 slice 5 class-2 standing renewal — the RENEWAL OWNER'S half, shared by the manager (the
 * resident owner in every mesh mode) and `cotal doctor auth --fix` (the operator repair). The
 * daemon's half is the explicit `reloadCreds` adoption op on the delivery-admin rail (plus the
 * passive 75% source re-read as backstop). Machine-local file work lives here in the workspace
 * layer: implementations never import each other.
 */

/** The canonical secret-store key of the delivery daemon's scoped cred — by the FS convention the
 *  key IS the filename under `.cotal/`. The single source for every tier (the CLI writer, the
 *  delivery daemon reader, this renewal owner): a hand-copied drifted literal would silently split
 *  the kind across two store entries with no compile error. Lives in workspace because the
 *  key↔filename convention is the workspace layout's; implementations never import each other. */
export const DELIVERY_CREDS_KEY = "delivery.creds";

/** The seed-less daemon creds files a renewal owner re-signs. The $SYS files
 *  (membership-observer, connection-evictor) are deliberately ABSENT: they are rotation-renewed —
 *  no persisted seed can re-sign them, by design. */
export const REMINTABLE_DAEMON_CREDS: ReadonlyArray<{ file: string; profile: Profile }> = [
  { file: DELIVERY_CREDS_KEY, profile: "delivery" },
  { file: "membership-rw.creds", profile: "membership-rw" },
];

export interface RemintResult {
  file: string;
  /** true = re-signed; false = failed (see error); undefined ok with `skipped` = file absent. */
  ok: boolean;
  skipped?: "missing-file" | "no-auth";
  error?: string;
}

/** Re-sign the daemon creds files for their EXISTING nkeys (a renewal must never swap a daemon's
 *  identity — the daemon side pins it). Reads and writes through the secret-store seam; `store` is
 *  the renewal owner's injection point, SYMMETRIC with the daemon's `runDelivery(args, store?)`.
 *  The manager — the D5 standing-renewal owner, and a hosted-path caller (manager.ts calls this
 *  unconditionally) — must pass the SAME store it gives the daemon, or a hosted composition
 *  re-signs into one store while the daemon reads another and rides to expiry. Threading the store
 *  through the manager's entry is its own slice; until it lands, hosted end-to-end renewal on an
 *  injected store is NOT yet wired, and no store means the local workspace FS composition (keys =
 *  the filenames under `.cotal/`). The store's ATOMIC put is load-bearing here, because the daemons
 *  re-read these files LIVE (the delivery endpoint's 75% source backstop, the membership rw
 *  reconnect getter) and the plain `writeSecretFile` this replaced could tear such a concurrent
 *  re-read. Structured per-file results, never throws: a failed remint leaves the old cred running
 *  toward its loud expiry and the caller records/reports the failure. */
export async function remintDaemonCreds(root: string, store?: SecretStore): Promise<RemintResult[]> {
  const auth = loadSpaceAuth(authDir(root));
  if (!auth) return REMINTABLE_DAEMON_CREDS.map(({ file }) => ({ file, ok: false, skipped: "no-auth" as const }));
  const s = store ?? workspaceSecretStore(root);
  const results: RemintResult[] = [];
  for (const { file, profile } of REMINTABLE_DAEMON_CREDS) {
    try {
      const current = await s.get(file);
      if (current === undefined) {
        results.push({ file, ok: false, skipped: "missing-file" });
        continue;
      }
      await s.put(file, await mintCreds(auth, identityFromCreds(current), profile));
      results.push({ file, ok: true });
    } catch (e) {
      results.push({ file, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

/** The renewal owner's audit record — what `cotal doctor auth` renders so "file re-signed" and
 *  "daemon adopted" are distinguishable states, per the D5 panel gate. One file, overwritten per
 *  pass: the CURRENT renewal state, not a log (history is the git/ops layer's job). */
export interface RenewalRecord {
  /** ISO timestamp of the renewal pass. */
  ts: string;
  /** Who ran the pass (e.g. "manager", "doctor --fix"). */
  owner: string;
  results: RemintResult[];
  /** The daemon's explicit reloadCreds adoption outcome; absent when nothing was re-signed. */
  adoption?: { ok: boolean; detail?: unknown; error?: string };
}

export function renewalRecordPath(root: string): string {
  return join(root, ".cotal", "renewal.json");
}

export function writeRenewalRecord(root: string, record: RenewalRecord): void {
  writeSecretFile(renewalRecordPath(root), JSON.stringify(record, null, 2));
}

export function readRenewalRecord(root: string): RenewalRecord | undefined {
  const p = renewalRecordPath(root);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RenewalRecord;
  } catch {
    return undefined; // a corrupt record is rendered as "no renewal record", never a crash
  }
}

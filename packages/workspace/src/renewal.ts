import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  credsFingerprint,
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
 * daemon's half is the explicit `reloadCreds` adoption op on the delivery-admin rail, plus each
 * daemon's own 75% renewal timer (the delivery endpoint re-reads its source; the membership feed
 * preflight-proves each candidate). Machine-local file work lives here in the workspace layer:
 * implementations never import each other.
 */

/** The canonical secret-store key of the delivery daemon's scoped cred — by the FS convention the
 *  key IS the filename under `.cotal/`. The single source for every tier (the CLI writer, the
 *  delivery daemon reader, this renewal owner): a hand-copied drifted literal would silently split
 *  the kind across two store entries with no compile error. Lives in workspace because the
 *  key↔filename convention is the workspace layout's; implementations never import each other. */
export const DELIVERY_CREDS_KEY = "delivery.creds";

/** The membership feed's data-account rw cred key — the same key↔filename discipline as
 *  {@link DELIVERY_CREDS_KEY}. Named (not a bare literal) so the renewal owner can map a remint
 *  result back to the daemon's `membership` component without a hand-copied string. */
export const MEMBERSHIP_RW_CREDS_KEY = "membership-rw.creds";

/** The seed-less daemon creds files a renewal owner re-signs. The $SYS files
 *  (membership-observer, connection-evictor) are deliberately ABSENT: they are rotation-renewed —
 *  no persisted seed can re-sign them, by design. */
export const REMINTABLE_DAEMON_CREDS: ReadonlyArray<{ file: string; profile: Profile }> = [
  { file: DELIVERY_CREDS_KEY, profile: "delivery" },
  { file: MEMBERSHIP_RW_CREDS_KEY, profile: "membership-rw" },
];

export interface RemintResult {
  file: string;
  /** true = re-signed; false = failed (see error); undefined ok with `skipped` = file absent. */
  ok: boolean;
  skipped?: "missing-file" | "no-auth";
  error?: string;
  /** EPHEMERAL SHA-256 of the JUST-RE-SIGNED cred's USER JWT — the EXPECTED-generation token the
   *  renewal owner hands the daemon so an adoption reply can prove it adopted THIS generation, not
   *  merely re-read some file. Present only on `ok`. NEVER persisted: the caller strips it before
   *  writing the renewal record (a stable secret-derived token must not land on disk). */
  fingerprint?: string;
}

/** Re-sign the daemon creds files for their EXISTING nkeys (a renewal must never swap a daemon's
 *  identity — the daemon side pins it). Reads and writes through the secret-store seam; `store` is
 *  the renewal owner's injection point, SYMMETRIC with the daemon's `runDelivery(args, store?)`.
 *  The manager — the D5 standing-renewal owner, and a hosted-path caller (manager.ts calls this
 *  unconditionally) — passes the SAME store it gives the daemon (its `ManagerOptions.secretStore`),
 *  so a hosted composition re-signs into the store the daemon renews from, never a divergent one; no
 *  store means the local workspace FS composition (keys = the filenames under `.cotal/`). The store's
 *  ATOMIC put is load-bearing here, because the daemons re-read these values LIVE (the delivery
 *  endpoint's 75% source refresh, the membership feed's 75% renewal fetch) and the plain
 *  `writeSecretFile` this replaced could tear such a concurrent read. Structured per-file results,
 *  never throws: a failed remint leaves the old cred running toward its loud expiry and the caller
 *  records/reports the failure. */
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
      const next = await mintCreds(auth, identityFromCreds(current), profile);
      await s.put(file, next);
      results.push({ file, ok: true, fingerprint: credsFingerprint(next) });
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
  // REDACT the ephemeral generation token HERE, at the single persistence boundary, so no writer
  // (the manager, `doctor auth --fix`, or any future caller) can leak the stable secret-derived
  // fingerprint to `.cotal/renewal.json`. `JSON.stringify` then omits the `undefined` field.
  const redacted: RenewalRecord = { ...record, results: record.results.map((r) => ({ ...r, fingerprint: undefined })) };
  writeSecretFile(renewalRecordPath(root), JSON.stringify(redacted, null, 2));
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

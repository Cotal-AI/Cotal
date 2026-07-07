import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  identityFromCreds,
  mintCreds,
  writeSecretFile,
  type Profile,
} from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "./auth-paths.js";

/**
 * D5 slice 5 class-2 standing renewal — the RENEWAL OWNER'S half, shared by the manager (the
 * resident owner in every mesh mode) and `cotal doctor auth --fix` (the operator repair). The
 * daemon's half is the explicit `reloadCreds` adoption op on the delivery-admin rail (plus the
 * passive 75% source re-read as backstop). Machine-local file work lives here in the workspace
 * layer: implementations never import each other.
 */

/** The seed-less daemon creds files a renewal owner re-signs. The $SYS files
 *  (membership-observer, connection-evictor) are deliberately ABSENT: they are rotation-renewed —
 *  no persisted seed can re-sign them, by design. */
export const REMINTABLE_DAEMON_CREDS: ReadonlyArray<{ file: string; profile: Profile }> = [
  { file: "delivery.creds", profile: "delivery" },
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
 *  identity — the daemon side pins it). Structured per-file results, never throws: a failed remint
 *  leaves the old cred running toward its loud expiry and the caller records/reports the failure. */
export async function remintDaemonCreds(root: string): Promise<RemintResult[]> {
  const auth = loadSpaceAuth(authDir(root));
  if (!auth) return REMINTABLE_DAEMON_CREDS.map(({ file }) => ({ file, ok: false, skipped: "no-auth" as const }));
  const results: RemintResult[] = [];
  for (const { file, profile } of REMINTABLE_DAEMON_CREDS) {
    const path = join(root, ".cotal", file);
    if (!existsSync(path)) {
      results.push({ file, ok: false, skipped: "missing-file" });
      continue;
    }
    try {
      const identity = identityFromCreds(readFileSync(path, "utf8"));
      writeSecretFile(path, await mintCreds(auth, identity, profile));
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

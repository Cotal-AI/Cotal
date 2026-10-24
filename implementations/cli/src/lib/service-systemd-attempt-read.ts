import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { protectedLocalDirectory, readLocalRecordSource } from "@cotal-ai/workspace";
import type { ServiceInstallIntent } from "./service-install-intent.js";
import { processServiceHost } from "./service-instances.js";

const fields = ["Id", "LoadState", "ActiveState", "UnitFileState", "FragmentPath", "NeedDaemonReload"] as const;

/** Diagnose one retained exact attempt without adopting a name-only native unit. A missing or
 *  changed physical file never grants an uninstall, reload, start or receipt transition. */
export function observeSystemdAttempt(intent: Pick<ServiceInstallIntent, "machine" | "uid" | "unit" | "unitPath" | "unitSha256"> & { privateHome?: string }) {
  const observedAt = new Date().toISOString();
  let privateStore: "not-checked" | "owned-private-directory" | "missing" | "unavailable-or-unattributed" = "not-checked";
  const empty = (file: "foreign-host" | "missing" | "different" | "unreadable" | "matches-attempt", reason: string) => ({ file, privateStore, native: "not-checked" as const, observedAt, reason, loadState: null, activeState: null, unitFileState: null, fragment: "not-checked" as const, daemonReloadRequired: null });
  if (process.platform !== "linux") return empty("foreign-host", "this native attempt has no Linux user-manager reader on this platform");
  let host: ReturnType<typeof processServiceHost>;
  try { host = processServiceHost(); }
  catch { return empty("unreadable", "the current execution-host identity could not be established"); }
  if (host.machine !== intent.machine || host.uid !== intent.uid) return empty("foreign-host", "this attempt belongs to another machine or OS user");
  if (intent.privateHome) {
    privateStore = "unavailable-or-unattributed";
    try {
      protectedLocalDirectory(dirname(intent.privateHome));
      const stat = lstatSync(intent.privateHome);
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === host.uid && (stat.mode & 0o077) === 0) privateStore = "owned-private-directory";
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") privateStore = "missing"; }
  }
  let file: "missing" | "different" | "unreadable" | "matches-attempt" = "unreadable";
  try {
    protectedLocalDirectory(dirname(intent.unitPath));
    const bytes = readLocalRecordSource(intent.unitPath, 64 * 1024, true);
    if (!bytes) file = "missing";
    else {
      const stat = lstatSync(intent.unitPath);
      file = stat.isFile() && !stat.isSymbolicLink() && stat.uid === host.uid && (stat.mode & 0o077) === 0 && createHash("sha256").update(bytes).digest("hex") === intent.unitSha256 ? "matches-attempt" : "different";
    }
  } catch { /* An unreadable path is not a missing file. */ }
  const result = spawnSync("systemctl", ["--user", "show", intent.unit, ...fields.map((name) => `--property=${name}`), "--all", "--no-pager", "--no-ask-password"], { encoding: "utf8", timeout: 1500, maxBuffer: 16 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") return { ...empty(file, "the exact native status read did not confirm an answer"), native: "unavailable" as const };
  const values = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1 || !(fields as readonly string[]).includes(line.slice(0, index)) || values.has(line.slice(0, index))) return { ...empty(file, "the user manager returned an incomplete or ambiguous unit status"), native: "unavailable" as const };
    const value = line.slice(index + 1);
    if (/[\u0000-\u001f\u007f]/u.test(value)) return { ...empty(file, "the user manager returned an invalid unit status value"), native: "unavailable" as const };
    values.set(line.slice(0, index), value);
  }
  if (values.size !== fields.length || values.get("Id") !== intent.unit || values.get("NeedDaemonReload") !== "yes" && values.get("NeedDaemonReload") !== "no" || ["LoadState", "ActiveState", "UnitFileState"].some((name) => !/^[A-Za-z0-9_-]{0,80}$/.test(values.get(name) ?? "invalid"))) return { ...empty(file, "the user manager did not return complete exact-unit coordinates"), native: "unavailable" as const };
  let fragment: "matching-physical-source" | "other-or-unavailable" = "other-or-unavailable";
  if (file === "matches-attempt") {
    try { if (realpathSync.native(values.get("FragmentPath")!) === realpathSync.native(intent.unitPath)) fragment = "matching-physical-source"; }
    catch { /* A loaded fragment with no physical match confers no ownership. */ }
  }
  return { file, privateStore, native: fragment === "matching-physical-source" ? "matching-fragment" as const : "name-only" as const,
    observedAt, reason: fragment === "matching-physical-source" ? null : "the native name did not establish the attempt's unchanged physical fragment",
    loadState: values.get("LoadState")!, activeState: values.get("ActiveState")!, unitFileState: values.get("UnitFileState")!, fragment,
    daemonReloadRequired: values.get("NeedDaemonReload") === "yes" };
}

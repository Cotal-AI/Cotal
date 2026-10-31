// The file-side store documents: the versioned parse every store read shares, the file read, and the
// auth service's runtime discovery file. It imports nothing heavier than core's secret-file writers,
// so `cotal agent-bearer` finds the local service without loading this package's root or core's.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core/secret-fs";

export const STORE_VER = 1;

/** Fail-loud versioned-JSON parse, shared by the store-read and file-read paths: a torn/edited/
 *  unknown-version document is a legible sentence naming WHERE it lives (a store key or a path)
 *  and the recovery, never a raw parse error downstream. */
export function parseStoreDoc<T extends { ver: number }>(raw: string, where: string, what: string): T {
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`${where}: the ${what} entry is not valid JSON (${e instanceof Error ? e.message : String(e)}) - restore it from backup; regenerating breaks existing credentials`);
  }
  if (parsed === null || typeof parsed !== "object" || parsed.ver !== STORE_VER)
    throw new Error(`${where}: unknown ${what} version ${String((parsed as { ver?: unknown })?.ver)} (expected ${STORE_VER}) - refusing to guess at credential material`);
  return parsed;
}

/** The file-side read, for the NON-SEAM kinds only (the IdP pin, service runtime discovery). */
export function readStoreFile<T extends { ver: number }>(path: string, what: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return parseStoreDoc<T>(readFileSync(path, "utf8"), path, what);
}

// ---- the auth-service runtime discovery file ----

const SERVICE_FILE = "auth-service.json";

/** Where the RUNNING auth service listens — written by the daemon only after EVERY plane is bound
 *  (its existence is the readiness signal), read by user-mode connects from other directories on
 *  this machine. Runtime state, not a trust pin: the port and capability rotate per start.
 *  `cap` is the per-start exchange capability: /exchange requires `Authorization: Bearer <cap>`,
 *  so a local process can only exchange if it can read this 0600 file — same-user file ACL is the
 *  boundary, and browser/off-user processes are shut out of the loopback port. */
export interface AuthServiceInfo {
  /** The local exchange/JWKS base URL, e.g. `http://127.0.0.1:53200`. */
  url: string;
  pid: number;
  /** High-entropy per-start exchange capability (hex). NEVER copied into the mesh registry. */
  cap: string;
  /** The PUBLIC exchange base URL when the optional public face is enabled — the operator's
   *  `--exchange-public-url` (the reverse proxy's https address) or the local bind. `up` copies
   *  this (never `cap`) into the registry's `UserAuthInfo.endpoints.url` so the discovery bundle
   *  is generated, not hand-written. */
  publicUrl?: string;
}

interface ServiceFile extends AuthServiceInfo {
  ver: number;
}

export function loadAuthServiceInfo(dir: string): AuthServiceInfo | undefined {
  const f = readStoreFile<ServiceFile>(join(dir, SERVICE_FILE), "auth service info");
  if (!f) return undefined;
  if (!f.url || typeof f.pid !== "number" || !f.cap || (f.publicUrl !== undefined && typeof f.publicUrl !== "string"))
    throw new Error(`${join(dir, SERVICE_FILE)}: malformed auth service info - restart the mesh (\`cotal down\` then \`cotal up\`)`);
  return { url: f.url, pid: f.pid, cap: f.cap, ...(f.publicUrl !== undefined ? { publicUrl: f.publicUrl } : {}) };
}

export function saveAuthServiceInfo(dir: string, info: AuthServiceInfo): void {
  mkSecretDir(dir);
  writeSecretFileAtomic(join(dir, SERVICE_FILE), JSON.stringify({ ver: STORE_VER, ...info } satisfies ServiceFile, null, 2));
}

/** Remove the discovery file (daemon shutdown / CLI pre-start scrub) so a stale entry can never
 *  satisfy a readiness poll for the NEXT start. */
export function clearAuthServiceInfo(dir: string): void {
  rmSync(join(dir, SERVICE_FILE), { force: true });
}

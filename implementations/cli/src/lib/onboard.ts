import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir } from "@cotal-ai/core";
import { homeCotalDir } from "@cotal-ai/workspace";

/** Machine-level "I've onboarded before" marker. Its presence flips `cotal` from the
 *  full first-run flow to the compact ensure+status run. Lives next to the materialized
 *  plugin marketplace under ~/.cotal (COTAL_HOME-overridable, via {@link homeCotalDir}). */
const MARKER = () => join(homeCotalDir(), "onboarded.json");

export function isOnboarded(): boolean {
  return existsSync(MARKER());
}

export function markOnboarded(version: string): void {
  mkSecretDir(homeCotalDir()); // the home dir holds secrets — keep it owner-only (0700 / hardened ACL)
  writeFileSync(MARKER(), JSON.stringify({ version, ts: new Date().toISOString() }, null, 2));
}

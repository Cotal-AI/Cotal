import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeCotalDir } from "@cotal-ai/core";

/** Machine-level "I've onboarded before" marker. Its presence flips `cotal` from the
 *  full first-run flow to the compact ensure+status run. Lives next to the materialized
 *  plugin marketplace under ~/.cotal (COTAL_HOME-overridable, via {@link homeCotalDir}). */
const MARKER = () => join(homeCotalDir(), "onboarded.json");

export function isOnboarded(): boolean {
  return existsSync(MARKER());
}

export function markOnboarded(version: string): void {
  mkdirSync(homeCotalDir(), { recursive: true, mode: 0o700 });
  writeFileSync(MARKER(), JSON.stringify({ version, ts: new Date().toISOString() }, null, 2));
}

import { join } from "node:path";
import { spaceKey } from "./auth-paths.js";

/** `.cotal/renewal.<spaceKey>.json` — one renewal owner's current state per space. */
export const RENEWAL_RECORD_FILE = "renewal.{space}.json";

/** The path a renewal owner writes and a reader or per-space reaper addresses. */
export function renewalRecordPath(root: string, space: string): string {
  return join(root, ".cotal", RENEWAL_RECORD_FILE.replaceAll("{space}", spaceKey(space)));
}

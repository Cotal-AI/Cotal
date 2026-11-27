import { realpathSync } from "node:fs";
import { join } from "node:path";
import { makeWindowsCustodyDirectory } from "./shared-files-win32.js";
import { windowsSeatStore } from "./shared-slot-win32.js";

/** Only the hosted Manager's artifact producers and their legacy cleanup use this private temp. */
export function windowsSeatArtifactTemp(installation: string): string {
  const folder = join(windowsSeatStore(installation), "artifacts");
  makeWindowsCustodyDirectory(folder);
  return realpathSync.native(folder);
}

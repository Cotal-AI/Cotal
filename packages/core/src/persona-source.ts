import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { rawDigest } from "./canonical.js";

export const PERSONA_SOURCE_META_KEY = "ai.cotal.persona.source";

/** Advisory host-local file reference. Keep the final directory entry distinct even if two
 *  catalog names are links to the same file. Never send the path or file contents to the mesh. */
export function personaSourceRef(path: string): string | undefined {
  const absolute = resolve(path);
  let directory: string;
  try { directory = realpathSync.native(dirname(absolute)); }
  catch { return undefined; }
  return rawDigest(JSON.stringify([hostname(), directory, basename(absolute)]));
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { SEEDED_SHARED_DIR, SEEDED_SHARED_FILES } from "@cotal-ai/workspace";

/** One file a published payload ships in the shared directory instead of its own: `rel` is its path
 *  inside the payload (`/`-separated), `source` the one shipped copy. */
export interface SharedPlacement {
  readonly rel: string;
  readonly source: string;
}

interface Placements {
  readonly v: 1;
  readonly files: Record<string, string>;
  readonly placements: Record<string, string[]>;
}

/**
 * The shared files the payload of built-in `name` at `payloadDir` is missing, and where each belongs.
 * A published payload (`<cotal-ai>/seeded-connectors/<name>`) had its docs data removed by the prepack,
 * which listed every removed path in `seeded-connectors/_shared/placements.json`. A source checkout's
 * payload holds its own copies and has none. Throws when a published layout's manifest is missing or
 * malformed, names a path outside the payload or a file that is not shared, or when a shipped shared
 * file is not the bytes the manifest records.
 */
export function sharedPlacements(name: string, payloadDir: string): SharedPlacement[] {
  const root = dirname(payloadDir);
  if (basename(root) !== "seeded-connectors") return [];
  const dir = join(root, SEEDED_SHARED_DIR);
  const path = join(dir, "placements.json");
  let manifest: Placements;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as Placements;
  } catch (e) {
    throw new Error(`the shared-file manifest ${path} is unreadable (${(e as Error).message}) - reinstall cotal-ai`);
  }
  const bad = (why: string) => new Error(`the shared-file manifest ${path} ${why} - reinstall cotal-ai`);
  if (manifest?.v !== 1 || typeof manifest.files !== "object" || typeof manifest.placements !== "object") throw bad("is not a version 1 manifest");
  const rels = manifest.placements[name] ?? [];
  if (!Array.isArray(rels)) throw bad(`lists no paths for ${name}`);
  const checked = new Set<string>();
  return rels.map((rel) => {
    const file = typeof rel === "string" ? posix.basename(rel) : "";
    if (typeof rel !== "string" || posix.isAbsolute(rel) || posix.normalize(rel) !== rel || rel.split("/").includes(".."))
      throw bad(`places ${JSON.stringify(rel)} outside the ${name} payload`);
    if (!SEEDED_SHARED_FILES.includes(file)) throw bad(`places ${rel}, which is not a shared file`);
    const source = join(dir, file);
    if (!checked.has(file)) {
      const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
      if (digest !== manifest.files[file]) throw bad(`records ${file} as ${String(manifest.files[file])}, but the shipped copy is ${digest}`);
      checked.add(file);
    }
    return { rel, source };
  });
}

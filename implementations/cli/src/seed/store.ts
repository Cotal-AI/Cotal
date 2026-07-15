import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { seedStoreDir, seedStorePath, shippedSourceDir } from "./paths.js";

/**
 * The durable seed store: a stable, per-generation copy of each shipped connector payload that
 * `ext add --install-links` can normalize a `file:` dep against (a volatile `npx` source would later
 * fail to reify). One directory per generation keeps an in-flight refresh from clobbering the bytes a
 * running manager's connectors still resolve; the old generation is GC'd only once nothing references
 * it.
 */

/** Everything except a nested `node_modules` (npm resolves deps fresh; peers are junction-linked by
 *  the `ext add` path) and VCS metadata. Keeps the dev copy from dragging a huge symlinked tree. */
function payloadFilter(src: string): boolean {
  return !src.includes(`${sep}node_modules${sep}`) && !src.endsWith(`${sep}node_modules`) && !src.includes(`${sep}.git${sep}`);
}

/**
 * Stage a built-in connector's shipped payload into `store/<generation>/<name>` and return that
 * stable path (the spec `ext add` installs from). Idempotent: an intact prior copy is reused unless
 * `force` re-materializes it (a `--force`/`--reset` repair). The copy is staged into a sibling temp
 * dir and renamed into place, so a crash mid-copy never leaves a half-written payload at the final
 * path for a later run to `ext add` from.
 */
export function stageSeedPayload(generation: string, name: string, opts: { force?: boolean } = {}): string {
  const dest = seedStorePath(generation, name);
  if (!opts.force && existsSync(join(dest, "package.json"))) return dest;
  const src = shippedSourceDir(name);
  const staging = `${dest}.staging`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, staging, { recursive: true, filter: payloadFilter });
  renameSync(staging, dest); // atomic within the store: the final path only ever holds a complete payload
  return dest;
}

/**
 * GC seed-store generations other than `keepGeneration`, but ONLY those no live manifest entry still
 * installs from (its normalized `file:` spec points under the generation dir). This is the commit
 * predicate: a prior generation is removed only after every seeded entry has been re-added from the
 * new one, so a running manager never loses the bytes its connectors resolve.
 */
export function gcSeedStore(keepGeneration: string, referencedSpecs: readonly string[]): void {
  const root = seedStoreDir();
  if (!existsSync(root)) return;
  for (const gen of readdirSync(root)) {
    if (gen === keepGeneration) continue;
    const genDir = join(root, gen);
    const referenced = referencedSpecs.some((spec) => spec === genDir || spec.startsWith(genDir + sep));
    if (!referenced) rmSync(genDir, { recursive: true, force: true });
  }
}

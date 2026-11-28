import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionsDir, isExtensionPathSpec, oneLine, provenance } from "@cotal-ai/workspace";
import { assertReleasedSeedWriter, seedStoreDir, seedStorePath, shippedSourceDir } from "./paths.js";
import { sharedPlacements } from "./shared.js";

/**
 * The durable seed store: a stable, per-generation copy of each shipped connector payload that
 * `ext add --install-links` can normalize a `file:` dep against (a volatile `npx` source would later
 * fail to reify). One directory per generation keeps an in-flight refresh from clobbering the bytes a
 * running manager's connectors still resolve; the old generation is GC'd only once nothing references
 * it.
 */

/** Everything except a nested `node_modules` (npm resolves deps fresh; peers are junction-linked by
 *  the `ext add` path) and VCS metadata. The exclusion is RELATIVE to the payload root — a published
 *  connector lives UNDER `.../node_modules/cotal-ai/seeded-connectors/<name>`, so matching
 *  `node_modules` anywhere in the absolute path would reject the root itself and copy nothing. */
function payloadFilter(root: string, from: string): boolean {
  const segments = relative(root, from).split(sep);
  return !segments.includes("node_modules") && !segments.includes(".git");
}

/** Private store copies need writable directories, even when the shipped payload is read-only. */
function writableDirectories(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  chmodSync(path, stat.mode | 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) writableDirectories(join(path, entry.name));
  }
}

/**
 * Stage a built-in connector's shipped payload into `store/<generation>/<name>` and return that
 * stable path (the spec `ext add` installs from). Idempotent: an intact prior copy is reused unless
 * `force` re-materializes it (a `--force`/`--reset` repair). The copy is staged into a sibling temp
 * dir and renamed into place, so a crash mid-copy never leaves a half-written payload at the final
 * path for a later run to `ext add` from.
 */
export function stageSeedPayload(generation: string, name: string, opts: { force?: boolean; quiet?: boolean } = {}): string {
  const dest = seedStorePath(generation, name);
  if (!opts.force && existsSync(join(dest, "package.json"))) return dest;
  assertReleasedSeedWriter(generation, "write");
  const src = shippedSourceDir(name);
  const shared = sharedPlacements(name, src);
  const staging = `${dest}.staging`;
  writableDirectories(staging);
  rmSync(staging, { recursive: true, force: true });
  writableDirectories(dest);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  cpSync(src, staging, { recursive: true, filter: (from) => payloadFilter(src, from) });
  writableDirectories(staging);
  // A published payload's docs data ships once for every connector; put a copy back where it was packed.
  for (const { rel, source } of shared) {
    const to = join(staging, ...rel.split("/"));
    if (existsSync(to)) throw new Error(`the shipped payload for "${name}" holds ${rel} and also ships it shared - reinstall cotal-ai`);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(source, to);
  }
  renameSync(staging, dest); // atomic within the store: the final path only ever holds a complete payload
  if (opts.quiet) return dest;
  // Announce the write on the provenance channel. This store is operator-global (a sibling of the
  // shared `extensions/` prefix, moved only by `XDG_CONFIG_HOME`), so re-seeding it from a non-released
  // checkout silently makes those bytes the machine-wide payload for that generation key; naming the
  // path here lets the line read as the machine-wide action it is. Only on a real materialization: the
  // idempotent early return above (an intact prior copy) writes nothing and stays silent.
  //
  // THE BOUND, stated where the claim is made: this announce is AFTER the commit, so it names what
  // happened. Announcing BEFORE the rename would trade that for a worse lie (a named write that then
  // failed). A stderr fault neither fails the seed nor drops the line silently: the provenance
  // channel's failure policy moves the line to stdout, and a run whose stdout fails too exits 1. Only
  // a stderr closed or redirected away at launch loses it silently.
  provenance.wrote(`operator-global seed store payload (${name})`, dest);
  return dest;
}

/** Collect only old generations with no manifest or npm reference. npm records local sources
 * even when the corresponding extension inventory row has no spec. */
export function gcSeedStore(keepGeneration: string, referencedSpecs: readonly (string | undefined)[]): void {
  const root = seedStoreDir();
  if (!existsSync(root)) return;
  const old = readdirSync(root).filter(gen => gen !== keepGeneration);
  if (!old.length) return;
  const prefix = extensionsDir();
  const needsNpmEvidence = referencedSpecs.some(spec => typeof spec !== "string");
  const refs = new Set<string>();
  const add = (path: string): void => {
    refs.add(path);
    try { refs.add(realpathSync(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  const addFile = (spec: string): void => {
    if (spec.startsWith("file://")) return add(fileURLToPath(spec));
    const path = spec.slice(5);
    add(resolve(prefix, path));
    if (/%[\da-f]{2}/i.test(path)) add(resolve(prefix, decodeURIComponent(path)));
  };
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(root);
    for (const spec of referencedSpecs) {
      if (typeof spec !== "string") continue;
      if (spec.startsWith("file:")) addFile(spec);
      else if (isExtensionPathSpec(spec)) add(resolve(spec));
    }
    for (const file of ["package.json", "package-lock.json"]) {
      let bytes: string;
      try { bytes = readFileSync(join(prefix, file), "utf8"); }
      catch (error) {
        if (!needsNpmEvidence && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const metadata: unknown = JSON.parse(bytes, (_key, value: unknown) => {
        if (typeof value === "string" && value.startsWith("file:")) {
          addFile(value);
        } else if (value && typeof value === "object" && "link" in value && value.link === true &&
          "resolved" in value && typeof value.resolved === "string" && !value.resolved.startsWith("file:")) {
          add(resolve(prefix, value.resolved));
        }
        return value;
      });
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
    }
  } catch {
    return; // Incomplete reference evidence cannot authorize deletion.
  }
  const paths = [...refs];
  for (const gen of old) {
    const genDir = join(root, gen);
    const physicalDir = join(physicalRoot, gen);
    const referenced = paths.some(path =>
      path === genDir || path.startsWith(genDir + sep) || path === physicalDir || path.startsWith(physicalDir + sep));
    if (referenced) continue;
    assertReleasedSeedWriter(keepGeneration, "garbage-collect");
    try {
      writableDirectories(genDir);
      rmSync(genDir, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error) || typeof (error as NodeJS.ErrnoException).errno !== "number") throw error;
      const status = oneLine(error.message);
      console.error(`Warning: could not remove old seed-store generation at ${oneLine(genDir)} (${status}). The old copy was left in place.`);
      continue;
    }
    // Announce the DELETE for the same reason the write above is announced: this store is
    // operator-global, so dropping a generation from it is a machine-wide act performed by a command
    // the operator ran for a local reason. It is announced AFTER the removal, so the line reports
    // what happened rather than what was intended.
    provenance.removed(`operator-global seed store generation (${gen})`, genDir);
  }
}

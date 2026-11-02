// Prepack step for the published `cotal-ai` binary: materialize each built-in connector's PUBLISHED
// file set into `bin/seeded-connectors/<name>/`, so the shipped binary carries a stable, durable
// payload the first-run reconcile can `ext add --install-links` from (see implementations/cli/src/
// seed/paths.ts `shippedSourceDir` — the published branch resolves `<cotal-ai>/seeded-connectors/
// <name>`). In a source checkout the reconcile resolves the live `extensions/` dirs instead, so this
// only matters for a real publish.
//
// `npm pack` is used per connector because it honors each package's own `files`/`.npmignore` exactly
// (dotfiles like claude's `.claude-plugin`, hermes' `plugin/**` globs), producing the same bytes a
// standalone publish of that connector would. The connectors must be BUILT first (their `dist/`); we
// fail loud rather than silently ship an empty payload.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SEEDED_EXTENSIONS, SEEDED_SHARED_DIR, SEEDED_SHARED_FILES } from "@cotal-ai/workspace";

const binRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(binRoot, "..");
const outRoot = join(binRoot, "seeded-connectors");

// The generation the reconcile stamps is this binary's version; every bundled extension must carry
// the SAME version (the `fixed` changeset group versions them in lockstep). Assert it at pack time so
// a skewed payload can never be published inside the umbrella and then installed as the current
// generation (see verifyInstalled in seed/reconcile.ts for the install-time half of this guard).
const umbrellaVersion = JSON.parse(readFileSync(join(binRoot, "package.json"), "utf8")).version;

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

for (const [name, { pkg, srcDir: srcSubdir }] of Object.entries(SEEDED_EXTENSIONS)) {
  const srcDir = join(repoRoot, srcSubdir);
  const meta = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
  if (meta.name !== pkg) {
    throw new Error(`seeded extension "${name}": package.json name "${meta.name}" != expected "${pkg}"`);
  }
  if (meta.version !== umbrellaVersion) {
    throw new Error(`seeded extension ${pkg} is version "${meta.version}" but cotal-ai is "${umbrellaVersion}" - the fixed changeset group must version every bundled extension in lockstep with the umbrella`);
  }
  if (!existsSync(join(srcDir, "dist"))) {
    throw new Error(`first-party extension ${pkg} is not built (no dist at ${srcDir}) - run \`pnpm build\` before packing cotal-ai`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "cotal-seed-"));
  try {
    // --ignore-scripts: dist is already built above; don't re-run the connector's own prepack.
    const stdout = execFileSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", tmp, srcDir], { encoding: "utf8" });
    const tgz = stdout.trim().split("\n").filter(Boolean).pop();
    if (!tgz) throw new Error(`npm pack produced no tarball for ${pkg}`);
    const dest = join(outRoot, name);
    mkdirSync(dest, { recursive: true });
    // The tarball's top-level dir is always `package/`; strip it so files land directly under <name>.
    execFileSync("tar", ["xzf", join(tmp, tgz), "-C", dest, "--strip-components=1"]);
    console.log(`seeded-connectors/${name}  <-  ${pkg}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Every connector bundle reads the same docs corpus and index from beside itself, so the payloads above
// hold identical copies of each. Ship one copy of each file and the paths it was removed from; the seed
// store puts a copy back at each path (implementations/cli/src/seed/shared.ts).
if (Object.hasOwn(SEEDED_EXTENSIONS, SEEDED_SHARED_DIR)) throw new Error(`"${SEEDED_SHARED_DIR}" is a seeded extension name and the shared-files directory`);
const sharedRoot = join(outRoot, SEEDED_SHARED_DIR);
mkdirSync(sharedRoot);
const files = {};
const placements = {};
for (const name of Object.keys(SEEDED_EXTENSIONS)) {
  const payload = join(outRoot, name);
  for (const rel of readdirSync(payload, { recursive: true }).sort()) {
    const path = join(payload, rel);
    const file = basename(rel);
    if (!SEEDED_SHARED_FILES.includes(file) || !statSync(path).isFile()) continue;
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (files[file] === undefined) {
      files[file] = digest;
      copyFileSync(path, join(sharedRoot, file));
    } else if (files[file] !== digest) {
      throw new Error(`seeded-connectors/${name}/${rel} differs from the other copies of ${file} - every connector must ship the docs data built with this release`);
    }
    rmSync(path);
    (placements[name] ??= []).push(rel.split(sep).join("/"));
  }
}
writeFileSync(join(sharedRoot, "placements.json"), `${JSON.stringify({ v: 1, files, placements }, null, 2)}\n`);
const placed = Object.values(placements).flat().length;
console.log(`seeded-connectors/${SEEDED_SHARED_DIR}  <-  ${Object.keys(files).length} shared files for ${placed} placements`);

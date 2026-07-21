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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEEDED_EXTENSIONS } from "@cotal-ai/workspace";

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

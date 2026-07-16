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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_CONNECTORS } from "@cotal-ai/workspace";

const binRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(binRoot, "..");
const outRoot = join(binRoot, "seeded-connectors");

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

for (const [name, pkg] of Object.entries(OFFICIAL_CONNECTORS)) {
  const srcDir = join(repoRoot, "extensions", pkg.split("/")[1]);
  if (!existsSync(join(srcDir, "dist"))) {
    throw new Error(`connector ${pkg} is not built (no dist at ${srcDir}) - run \`pnpm build\` before packing cotal-ai`);
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

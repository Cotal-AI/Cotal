// Build step for `cotal-ai`: write the checked POSIX per-user installer folders declared by each
// built-in connector into `bin/dist/daemon/seeded-installers.json`, so both source-checkout gates
// (`pnpm build`) and the packed `cotal-ai` / desktop runtime read one connector-derived table
// without regex-parsing TypeScript sources or reading seed authority internals.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registry } from "@cotal-ai/core";
import { checkedHarnessInstall, SEEDED_EXTENSIONS } from "@cotal-ai/workspace";

const binRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(binRoot, "..");

for (const [name, { pkg, srcDir }] of Object.entries(SEEDED_EXTENSIONS)) {
  if (name === "web") continue;
  const entry = join(repoRoot, srcDir, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error(`first-party extension ${pkg} is not built (no dist at ${srcDir}) - run \`pnpm --filter cotal-ai... build\` first`);
  }
  await import(pathToFileURL(entry).href);
}

const byName = new Map(registry.all("connector").map((connector) => [connector.name, connector]));
const installers = {};
const apps = [];
for (const name of Object.keys(SEEDED_EXTENSIONS)) {
  const connector = byName.get(name);
  if (!connector?.install) continue;
  const checked = checkedHarnessInstall(connector.name, connector.requires ?? [], connector.install);
  apps.push({ name, pkg: SEEDED_EXTENSIONS[name].pkg, requires: connector.requires, install: checked });
  const dirs = Object.fromEntries(
    ["darwin", "linux"].flatMap((os) => (checked.installers[os] ? [[os, checked.installers[os].binDir]] : [])),
  );
  if (Object.keys(dirs).length) installers[name] = dirs;
}

const outDir = join(binRoot, "dist", "daemon");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "seeded-installers.json"), `${JSON.stringify({ v: 1, installers, apps }, null, 2)}\n`);

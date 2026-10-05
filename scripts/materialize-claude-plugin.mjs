// Write the committed Claude Code plugin tree, claude-plugin/cotal and claude-plugin/cotal-skills,
// that the repo's .claude-plugin/marketplace.json lists. Run: `node scripts/materialize-claude-plugin.mjs`.
//
// Claude Code installs a plugin from a git source by copying that one directory at a pinned commit
// into its cache, so the directory must hold every file its MCP config and hooks reference. It also
// keeps an installed plugin until the manifest version changes. The source directories hold
// neither: the connector's dist/ is gitignored and the skills are copied in by `cotal setup`. This
// copies the same assets `cotal setup` copies (the claude connector's src/setup.ts), adds README
// and LICENSE, and stamps both manifests with the release version (bin/package.json).
//
// `pnpm ci:version` runs it after `changeset version` and a rebuild of the connector, so the
// bundles carry the version they are stamped with. Each plugin directory is rebuilt from scratch
// and swapped in whole, and the run FAILS LOUD when a referenced file is missing or the bundle was
// built at another version, so a release cannot commit a plugin that does not run.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const connector = join(repoRoot, "extensions", "connector-claude-code");
const out = join(repoRoot, "claude-plugin");
const version = JSON.parse(readFileSync(join(repoRoot, "bin", "package.json"), "utf8")).version;
if (!version) throw new Error("materialize-claude-plugin: no version in bin/package.json");

const legal = [
  [join(repoRoot, "LICENSE"), "LICENSE"],
  [join(repoRoot, "NOTICE"), "NOTICE"],
];
// [source, destination inside the plugin directory]
const plugins = {
  cotal: [
    ...[".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json", "dist/mcp.cjs", "dist/hook.cjs"].map((asset) => [join(connector, asset), asset]),
    [join(connector, "PLUGIN.md"), "README.md"],
    ...legal,
  ],
  "cotal-skills": [
    [join(connector, "skills-plugin", ".claude-plugin", "plugin.json"), ".claude-plugin/plugin.json"],
    [join(connector, "skills-plugin", "README.md"), "README.md"],
    [join(repoRoot, "implementations", "cli", "cotal-skills", "skills"), "skills"],
    ...legal,
  ],
};

/** Every `${CLAUDE_PLUGIN_ROOT}/<path>` an installed plugin will run, read from its own configs. */
function referencedPaths(dir) {
  const refs = [];
  for (const config of [".mcp.json", "hooks/hooks.json"]) {
    if (!existsSync(join(dir, config))) continue;
    for (const match of readFileSync(join(dir, config), "utf8").matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\\s]+)/g)) refs.push(match[1]);
  }
  return refs;
}

function verify(name, dir) {
  for (const ref of referencedPaths(dir))
    if (!existsSync(join(dir, ref))) throw new Error(`materialize-claude-plugin: ${name} references ${ref}, which is not in the plugin directory`);
  if (name === "cotal") {
    // The docs bundle inside mcp.cjs is stamped from bin/package.json at build time, so a bundle
    // built before `changeset version` carries the previous release under the new manifest version.
    if (!readFileSync(join(dir, "dist", "mcp.cjs"), "utf8").includes(`"version": ${JSON.stringify(version)}`))
      throw new Error(`materialize-claude-plugin: dist/mcp.cjs was not built at ${version}; rebuild @cotal-ai/connector-claude-code first`);
  }
  if (name === "cotal-skills") {
    const skills = readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md")));
    if (skills.length === 0) throw new Error("materialize-claude-plugin: cotal-skills has no skills/<name>/SKILL.md");
  }
}

for (const [name, assets] of Object.entries(plugins)) {
  const dest = join(out, name);
  const staging = `${dest}.staging`;
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const [source, asset] of assets) {
      if (!existsSync(source)) throw new Error(`materialize-claude-plugin: ${name} source missing: ${source}`);
      mkdirSync(dirname(join(staging, asset)), { recursive: true });
      cpSync(source, join(staging, asset), { recursive: true, dereference: true });
    }
    const manifestPath = join(staging, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    verify(name, staging);
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`claude-plugin/${name} ${version}`);
}

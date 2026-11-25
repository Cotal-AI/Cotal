// The release script's `cotal` plugin runs once installed: every hooks module it loads is in the
// tree, and a hooks module that loads a file the asset list omits fails the script.
//
// The script writes beside the repo root it lives in, so each case copies it into a scratch root
// whose other inputs link to this checkout's. It needs the claude connector built.
// Run: pnpm smoke:materialize-claude-plugin
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const connector = join("extensions", "connector-claude-code");
let failed = 0;
const check = (label, ok, extra) => {
  console.log(`  ${ok ? "✓" : "FAIL"} ${label}${ok || extra === undefined ? "" : ` — ${extra}`}`);
  if (!ok) failed++;
};

/** A scratch repo root holding a copy of the script, its claude connector placed by `linkConnector`. */
function scratchRoot(base, linkConnector) {
  const root = mkdtempSync(join(base, "root-"));
  mkdirSync(join(root, "scripts"));
  for (const script of ["materialize-claude-plugin.mjs", "check-mcp-docs-stamp.mjs"]) copyFileSync(join(repo, "scripts", script), join(root, "scripts", script));
  for (const path of ["node_modules", "LICENSE", "NOTICE", join("bin", "package.json"), join("implementations", "cli", "cotal-skills")]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(repo, path), join(root, path));
  }
  mkdirSync(dirname(join(root, connector)), { recursive: true });
  linkConnector(join(root, connector));
  return root;
}

const materialize = (root) => spawnSync(process.execPath, [join(root, "scripts", "materialize-claude-plugin.mjs")], { encoding: "utf8" });

const base = mkdtempSync(join(tmpdir(), "cotal-materialize-"));
try {
  console.log("the release tree");
  {
    const root = scratchRoot(base, (dest) => symlinkSync(join(repo, connector), dest));
    const run = materialize(root);
    check("the script writes the cotal plugin", run.status === 0, run.stderr);
    let loaded;
    try {
      const hooks = await import(pathToFileURL(join(root, "claude-plugin", "cotal", "hooks", "index.js")).href);
      hooks.register(() => {});
      loaded = "ok";
    } catch (error) {
      loaded = error.message;
    }
    check("its hooks/index.js loads every module it imports, and registers", loaded === "ok", loaded);
  }
  {
    // The connector as links to this one's files, with a hooks/index.js that also imports a module
    // the script's asset list does not name.
    const root = scratchRoot(base, (dest) => {
      mkdirSync(join(dest, "hooks"), { recursive: true });
      for (const entry of readdirSync(join(repo, connector))) if (entry !== "hooks") symlinkSync(join(repo, connector, entry), join(dest, entry));
      for (const entry of readdirSync(join(repo, connector, "hooks"))) if (entry !== "index.js") symlinkSync(join(repo, connector, "hooks", entry), join(dest, "hooks", entry));
      writeFileSync(join(dest, "hooks", "index.js"), "import { more } from './more.js';\nexport function register() { more(); }\n");
      writeFileSync(join(dest, "hooks", "more.js"), "export function more() {}\n");
    });
    const run = materialize(root);
    check("a hooks module that imports a file the asset list omits fails the script, naming the file",
      run.status !== 0 && run.stderr.includes("hooks/more.js"), `exit ${run.status}: ${run.stderr.trim().split("\n").at(-1)}`);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log(failed === 0 ? "all passed" : `${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * Every first-party connector's built package entry imports.
 *
 * The connector seed installs each built-in with `ext add`, which imports the package entry and
 * rolls the add back when the import throws. In 0.133.9 five of these entries threw at module
 * evaluation (`Class2 is not a constructor`): the bundled tool specs built a zod schema at the top
 * level before the bundle had initialized the zod class it needs, so a fresh `cotal setup` failed
 * its first seed and exited. Typecheck and the source-level suites run the unbundled modules, where
 * the order is different, so only the BUILT entry shows it.
 *
 * Each entry is imported in its own fresh node process, the way the seed meets it. Run after a
 * build: `pnpm smoke:connector-bundle-import`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const PACKAGES = [
  "extensions/connector-claude-code",
  "extensions/connector-codex",
  "extensions/connector-hermes",
  "extensions/connector-jcode",
  "extensions/connector-opencode",
  "extensions/pi",
] as const;

let imported = 0;
for (const pkg of PACKAGES) {
  const dir = join(repoRoot, pkg);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; main?: string; exports?: Record<string, unknown> };
  const root = manifest.exports?.["."] as string | { import?: string; default?: string } | undefined;
  const entry = typeof root === "string" ? root : (root?.import ?? root?.default ?? manifest.main);
  if (!entry || !existsSync(join(dir, entry))) {
    check(`${manifest.name} has a built package entry`, false, { entry, hint: "build the workspace first" });
    continue;
  }
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  const ok = run.status === 0;
  if (ok) imported++;
  check(`${manifest.name} entry ${entry} imports in a fresh process`, ok, { status: run.status, signal: run.signal, stderr: run.stderr.split("\n").slice(0, 6).join("\n") });
}
check(`all ${PACKAGES.length} connector entries imported`, imported === PACKAGES.length, { imported });
finish();

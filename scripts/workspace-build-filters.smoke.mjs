/** Grade build-filter metadata through the real reader without executing fixture commands. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "../bin/smoke/sentinel.mjs";

const { check, finish } = createSuite();
const tool = fileURLToPath(new URL("./mutation-coverage.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "build-filters-"));
const write = (path, text) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const manifests = {
  core: {},
  delivery: { dependencies: { "@cotal-ai/core": "workspace:*" } },
  connector: { devDependencies: { "@cotal-ai/core": "workspace:*" } },
  optional: { optionalDependencies: { "@cotal-ai/core": "workspace:*" } },
  peer: { peerDependencies: { "@cotal-ai/core": "workspace:*" } },
  other: {},
};
try {
  write("package.json", JSON.stringify({ name: "fixture", scripts: { "build:core": 'pnpm --filter "@cotal-ai/core" build' } }));
  for (const [name, dependencies] of Object.entries(manifests)) {
    write(`packages/${name}/package.json`, JSON.stringify({ name: `@cotal-ai/${name}`, ...dependencies,
      scripts: { build: "tsc", "build:emit": "tsc", "build:docs": "typedoc" } }));
    write(`packages/${name}/src/index.ts`, "export const value = 1;\n");
    write(`packages/${name}/dist/index.js`, "export const value = 1;\n");
    write(`bin/smoke/${name}.smoke.ts`, `const mod = await import("../../packages/${name}/dist/index.js");\nconsole.log(mod);\n`);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  const cases = [
    ["bare direct control", "pnpm --filter @cotal-ai/core build", "core", true],
    ["double quoted direct", 'pnpm --filter "@cotal-ai/core" build', "core", true],
    ["single quoted equals", "pnpm --filter='@cotal-ai/core' build", "core", true],
    ["bare dependency closure", "pnpm --filter @cotal-ai/delivery... build", "core", true],
    ["quoted dependency closure", 'pnpm --filter "@cotal-ai/delivery..." build', "core", true],
    ["dev dependency closure", 'pnpm --filter "@cotal-ai/connector..." build', "core", true],
    ["optional dependency closure", "pnpm --filter @cotal-ai/optional... build", "core", true],
    ["peer dependency closure", "pnpm --filter @cotal-ai/peer... build", "core", true],
    ["dependent closure", 'pnpm --filter "...@cotal-ai/core" build', "delivery", true],
    ["second filter", "pnpm --filter @cotal-ai/other --filter=@cotal-ai/core build", "core", true],
    ["quoted build variant", 'pnpm --filter "@cotal-ai/core" build:emit', "core", true],
    ["root script expansion", "pnpm build:core", "core", true],
    ["unrelated package control", "pnpm --filter @cotal-ai/other build", "core", false],
    ["unrelated closure control", "pnpm --filter @cotal-ai/other... build", "core", false],
    ["nonemitting variant control", 'pnpm --filter "@cotal-ai/core" build:docs', "core", false],
    ["conditional build control", "false && pnpm --filter @cotal-ai/core build || true", "core", false],
  ];
  for (const [label, command, target, accepted] of cases) {
    const source = `packages/${target}/src/index.ts`;
    const before = readFileSync(join(root, source), "utf8");
    write("case.json", JSON.stringify({ suite: [`bin/smoke/${target}.smoke.ts`], command,
      mutations: [{ name: "fixture value", file: source, find: "value = 1", replace: "value = 2", cell: "fixture value", expectRed: "fixture value" }] }));
    const result = spawnSync(process.execPath, [tool, "--gradable-only", "case.json"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    check(label, result.status === (accepted ? 0 : 1) && (accepted ? result.stdout.includes("ACCEPTED case.json") : result.stderr.includes("REFUSED case.json")), result.stdout + result.stderr);
    check(`${label}: source unchanged and commands not executed`, before === readFileSync(join(root, source), "utf8") && result.stdout.includes("command-failed=0") && result.stdout.includes("0 mutations run"));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
finish();

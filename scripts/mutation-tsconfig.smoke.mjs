/** Compare built-source metadata mapping with TypeScript's own configuration reader. */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "../bin/smoke/sentinel.mjs";

const { check, finish } = createSuite();
const repo = fileURLToPath(new URL("..", import.meta.url));
const tool = join(repo, "scripts/mutation-coverage.mjs");
const tsc = join(repo, "node_modules/typescript/lib/tsc.js");
const scratch = mkdtempSync(join(tmpdir(), "metadata-tsconfig-"));
const options = { compilerOptions: { rootDir: "./lib", outDir: "./dist" }, include: ["lib"] };
const plain = JSON.stringify(options);
const trailing = '{ "compilerOptions": { "rootDir": "./lib", "outDir": "./dist", }, "include": ["lib"], }';
const cases = [
  { name: "plain", text: plain, target: "lib", accepted: true, compiler: true },
  { name: "line-comment", text: "// configuration\n" + plain, target: "lib", accepted: true, compiler: true },
  { name: "block-comment", text: "/* configuration */\n" + plain, target: "lib", accepted: true, compiler: true },
  { name: "trailing-comma", text: trailing, target: "lib", accepted: true, compiler: true },
  { name: "extends", text: '{ "extends": "./base.json" }', base: plain, target: "lib", accepted: true, compiler: true },
  { name: "nested-extends", text: '{ "extends": "./config/base.json" }', basePath: "config/base.json", base: '{ "compilerOptions": { "rootDir": "../lib", "outDir": "../dist" }, "include": ["../lib"] }', target: "lib", accepted: true, compiler: true },
  { name: "missing-root", text: '{ "compilerOptions": { "outDir": "dist" } }', target: "src", accepted: false, diagnostic: true },
  { name: "missing-output", text: '{ "compilerOptions": { "rootDir": "src" } }', target: "src", accepted: false, diagnostic: true },
  { name: "stale-src-trailing", text: trailing, target: "src", accepted: false, compiler: true },
  { name: "stale-src-plain", text: plain, target: "src", accepted: false, compiler: true },
  { name: "malformed", text: '{ "compilerOptions": ', target: "src", accepted: false, diagnostic: true },
  { name: "missing", target: "src", accepted: false },
  { name: "missing-base", text: '{ "extends": "./absent.json" }', target: "src", accepted: false, diagnostic: true },
  { name: "invalid-option", text: '{ "compilerOptions": { "rootDir": 7, "outDir": "dist" } }', target: "src", accepted: false, diagnostic: true },
];
if (process.platform !== "win32" && process.getuid?.() !== 0)
  cases.push({ name: "unreadable", text: plain, target: "src", accepted: false, diagnostic: true, unreadable: true });
else console.log("POSIX non-root unreadable-file control not applicable");
try {
  for (const c of cases) {
    const root = join(scratch, c.name);
    const write = (path, text) => { const p = join(root, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
    write("package.json", '{"name":"fixture"}');
    write("packages/seat/package.json", JSON.stringify({ name: "@cotal-ai/seat", scripts: { build: "tsc -p tsconfig.json" } }));
    for (const dir of ["lib", "src", "dist"])
      write(`packages/seat/${dir}/index.${dir === "dist" ? "js" : "ts"}`, "export const value = 1;\n");
    write("bin/smoke/observe.smoke.ts", 'const mod = await import("../../packages/seat/dist/index.js"); console.log(mod);\n');
    if (c.text !== undefined) write("packages/seat/tsconfig.json", c.text);
    if (c.base) write(`packages/seat/${c.basePath ?? "base.json"}`, c.base);
    const source = `packages/seat/${c.target}/index.ts`;
    write("case.json", JSON.stringify({ suite: ["bin/smoke/observe.smoke.ts"], command: "pnpm --filter @cotal-ai/seat build",
      mutations: [{ name: "source value", file: source, find: "value = 1", replace: "value = 2", cell: "source value", expectRed: "source value" }] }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    if (c.compiler) {
      const compiler = spawnSync(process.execPath, [tsc, "-p", "packages/seat/tsconfig.json", "--showConfig"], { cwd: root, encoding: "utf8", timeout: 30_000 });
      let config;
      try { config = JSON.parse(compiler.stdout); } catch { config = undefined; }
      check(`${c.name}: compiler resolves lib to dist`, compiler.status === 0 && config?.compilerOptions?.rootDir === "./lib" && config?.compilerOptions?.outDir === "./dist", compiler.stdout + compiler.stderr);
    }
    const path = join(root, "packages/seat/tsconfig.json");
    if (c.unreadable) chmodSync(path, 0);
    const before = readFileSync(join(root, source), "utf8");
    const result = spawnSync(process.execPath, [tool, "--gradable-only", "case.json"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (c.unreadable) chmodSync(path, 0o600);
    check(`${c.name}: metadata ${c.accepted ? "accepts the compiled source" : "refuses the unsupported mapping"}`,
      result.status === (c.accepted ? 0 : 1) && (c.accepted ? result.stdout.includes("ACCEPTED case.json") : result.stderr.includes("REFUSED case.json")), result.stdout + result.stderr);
    if (c.diagnostic) check(`${c.name}: refusal names the configuration`, result.stderr.includes("tsconfig.json"), result.stderr);
    check(`${c.name}: source unchanged and no fixture command executed`, readFileSync(join(root, source), "utf8") === before && result.stdout.includes("0 mutations run") && result.stdout.includes("command-failed=0"));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
finish();

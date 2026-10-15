/** Typecheck real consumers of the built CJS subpath, including modes NodeNext alone misses. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), "hosted-types-"));
const compiler = require.resolve("typescript/bin/tsc");
const typeRoots = dirname(dirname(require.resolve("@types/node/package.json")));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const consumer = `import { PassThrough } from "node:stream";
import { serveClaudeSession, type ClaudeSession, type ClaudeSessionOptions } from "@cotal-ai/connector-claude-code/mcp";
const options: ClaudeSessionOptions = { env: {}, input: new PassThrough(), output: new PassThrough(), onShutdown: (code: number) => void code };
const session: Promise<ClaudeSession> = serveClaudeSession(options);
void session.then(value => { const name: string = value.name; const stopped: Promise<void> = value.close(); void name; void stopped; });
// @ts-expect-error input is required
void serveClaudeSession({ env: {}, output: new PassThrough() });
// @ts-expect-error onShutdown receives a number
void serveClaudeSession({ ...options, onShutdown: (code: string) => void code });
`;
const cases = [
  ["esm-nodenext", "mts", "NodeNext", "NodeNext"],
  ["cjs-nodenext", "cts", "NodeNext", "NodeNext"],
  ["esm-node16", "mts", "Node16", "Node16"],
  ["cjs-node16", "cts", "Node16", "Node16"],
  ["cjs-node18", "cts", "Node18", "NodeNext"],
  ["cjs-node20", "cts", "Node20", "NodeNext"],
  ["bundler-esnext", "ts", "ESNext", "Bundler"],
  ["bundler-preserve", "ts", "Preserve", "Bundler"],
];
let failed = 0;
try {
  mkdirSync(join(root, "node_modules/@cotal-ai"), { recursive: true, mode: 0o700 });
  symlinkSync(packageRoot, join(root, "node_modules/@cotal-ai/connector-claude-code"), "junction");
  for (const extension of ["cts", "mts", "ts"]) writeFileSync(join(root, `host.${extension}`), consumer);
  for (const [name, extension, module, moduleResolution] of cases) {
    const config = join(root, `${name}.json`);
    writeFileSync(config, JSON.stringify({
      compilerOptions: { target: "ES2022", module, moduleResolution, strict: true, noEmit: true, types: ["node"], typeRoots: [typeRoots] },
      files: [`host.${extension}`],
    }));
    const result = spawnSync(process.execPath, [compiler, "-p", config, "--pretty", "false"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0 && !result.error && !result.signal) console.log(`PASS public_subpath_types_${name}`);
    else {
      failed++;
      console.error(`FAIL public_subpath_types_${name}\n${result.error ?? result.signal ?? ""}\n${result.stdout}${result.stderr}`);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
assert.equal(failed, 0, "public subpath type-consumer failures");

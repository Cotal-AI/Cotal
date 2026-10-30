/** Count native TypeScript parses and suite reads during read-only metadata validation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSuite } from "../bin/smoke/sentinel.mjs";

const { check, finish } = createSuite();
const root = fileURLToPath(new URL("..", import.meta.url));
const tool = join(root, "scripts/mutation-coverage.mjs");
const scratch = mkdtempSync(join(tmpdir(), "parse-cache-"));
const config = JSON.parse(readFileSync(join(root, "bin/smoke/mutations/dm-history-subject.json"), "utf8"));
assert(config.mutations.length > 0 && config.suite.length === 1);
const suite = resolve(root, config.suite[0]);
const preload = join(scratch, "metrics.mjs");
writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from ${JSON.stringify(pathToFileURL(join(root, "node_modules/typescript/lib/typescript.js")).href)};
let reads = 0;
const original = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const name = path instanceof URL ? fileURLToPath(path) : path;
  if (typeof name === "string" && resolve(name) === ${JSON.stringify(suite)}) reads++;
  return original.call(this, path, ...args);
};
syncBuiltinESMExports();
ts.performance.enable();
process.on("exit", () => fs.writeFileSync(process.env.PARSE_CACHE_METRICS, JSON.stringify({ parses: ts.performance.getCount("beforeParse"), reads })));
`);
const invoke = (path, metrics) => spawnSync(process.execPath, [
  ...(metrics ? ["--import", preload] : []), tool, "--gradable-only", ...(Array.isArray(path) ? path : [path]),
], { cwd: root, encoding: "utf8", timeout: 60_000,
  env: { ...process.env, ...(metrics ? { PARSE_CACHE_METRICS: metrics } : {}) } });
try {
  const rows = [];
  for (const factor of [0, 1, 4]) {
    const path = join(scratch, `k${factor}.json`);
    const metrics = join(scratch, `k${factor}-metrics.json`);
    writeFileSync(path, JSON.stringify({ ...config, mutations: Array.from({ length: factor }, () => config.mutations).flat() }));
    const plain = invoke(path);
    const measured = invoke(path, metrics);
    check(`k${factor}: plain metadata validation accepts`, plain.status === 0 && plain.stdout.includes("ACCEPTED "), plain.stdout + plain.stderr);
    check(`k${factor}: instrumentation preserves verdict and output`, measured.status === plain.status && measured.stdout === plain.stdout && measured.stderr === plain.stderr, measured.stdout + measured.stderr);
    const counts = JSON.parse(readFileSync(metrics, "utf8"));
    rows.push({ factor, mutations: config.mutations.length * factor, ...counts });
    console.log(`PARSE_COUNTS ${JSON.stringify(rows.at(-1))}`);
  }
  check("empty metadata has no source parses or suite reads", rows[0].parses === 0 && rows[0].reads === 0, rows[0]);
  check("nonempty metadata really parses source", rows[1].parses > 0, rows[1]);
  check("repeating mutations does not repeat source parsing", rows[2].parses === rows[1].parses, rows);
  check("the suite is read once per config, independent of mutation count", rows[1].reads === 1 && rows[2].reads === 1, rows);
  const pairMetrics = join(scratch, "pair-metrics.json");
  const pair = invoke([join(scratch, "k1.json"), join(scratch, "k4.json")], pairMetrics);
  const pairCounts = JSON.parse(readFileSync(pairMetrics, "utf8"));
  check("two configs in one process both remain accepted", pair.status === 0 && pair.stdout.includes("examined=2 graded=2 refused-with-reason=0"), pair.stdout + pair.stderr);
  check("suite text is reread for each config", pairCounts.reads === 2, pairCounts);
  check("unchanged parses are shared across configs", pairCounts.parses === rows[1].parses, pairCounts);

  const refusedPath = join(scratch, "unrelated-target.json");
  writeFileSync(refusedPath, JSON.stringify({ ...config, mutations: [{ ...config.mutations[0], file: "scripts/mutation-failure-signature.mjs" }] }));
  const refused = invoke(refusedPath);
  const measuredRefusal = invoke(refusedPath, join(scratch, "refused-metrics.json"));
  check("an unrelated target remains refused", refused.status === 1 && /targets scripts\/mutation-failure-signature\.mjs, which (none of|is outside the swept tree)/.test(refused.stderr), refused.stdout + refused.stderr);
  check("instrumentation also preserves a refusal", measuredRefusal.status === refused.status && measuredRefusal.stdout === refused.stdout && measuredRefusal.stderr === refused.stderr, measuredRefusal.stdout + measuredRefusal.stderr);

  const { sourceAst } = await import("./mutation-source-cache.mjs");
  const path = join(scratch, "cache-contract.ts");
  const text = "export const value = 1;";
  const first = sourceAst(path, text);
  check("same file and text reuse the parsed object", sourceAst(path, text) === first);
  check("equivalent paths share the same parse", sourceAst(`${scratch}/unused/../cache-contract.ts`, text) === first);
  const changed = sourceAst(path, "export const value = 2;");
  check("changed text gets a new parse without altering the old tree", changed !== first && changed.text === "export const value = 2;" && first.text === text);
  check("different files do not share a source identity", sourceAst(join(scratch, "other.ts"), text) !== first);
  check("only the current text is retained for each file", sourceAst(path, text) !== first);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
finish();

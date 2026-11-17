import "../../implementations/cli/smoke/update-isolation.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "linux") {
  console.log("current installed closure fast path is Linux-only");
} else {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "current-manager-report-")));
  const repo = join(import.meta.dirname, "../..");
  const installed = join(root, "prefix/lib/node_modules/cotal-ai");
  cpSync(join(repo, "bin/dist"), join(installed, "dist"), { recursive: true });
  cpSync(join(repo, "bin/package.json"), join(installed, "package.json"));
  const entry = realpathSync.native(join(installed, "dist/cotal.js"));
  try {
    for (const checkout of [false, true]) {
      const home = join(root, String(checkout));
      mkdirSync(home, { mode: 0o700 });
      const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"), COTAL_SKIP_CONNECTOR_SEED: "1" };
      delete env.XDG_RUNTIME_DIR;
      const script = `
process.argv[1] = ${JSON.stringify(entry)};
const { registry } = await import(${JSON.stringify(pathToFileURL(join(repo, "packages/core/dist/index.js")).href)});
await import(${JSON.stringify(pathToFileURL(join(repo, "implementations/cli/dist/index.js")).href)});
const { updateRuntime } = await import(${JSON.stringify(pathToFileURL(join(repo, "implementations/cli/dist/commands/update.js")).href)});
Object.defineProperty(globalThis, Symbol.for('cotal.execution.started'), { value: true });
Object.defineProperty(globalThis, Symbol.for('cotal.execution.identity'), { value: Object.freeze({ logicalEntry: ${JSON.stringify(entry)}, loadedEntry: ${JSON.stringify(entry)} }) });
let legacyReads = 0;
Object.assign(updateRuntime, {
  checkout: () => ${checkout}, isCurrent: () => true, version: () => '0.164.18',
  npm: () => ({ status: 0, stdout: '"0.164.18"', stderr: '' }),
  preflightReplacement: async () => {},
  reportRunningManager: async () => { legacyReads++; return 'legacy'; },
});
await import(${JSON.stringify(pathToFileURL(join(repo, "bin/dist/daemon/update-entry.js")).href)});
await registry.resolve('command', 'update').run({ raw: ['--self'], positionals: [], values: { self: true } });
console.log('LEGACY_READS=' + legacyReads);
`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: home, env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`LEGACY_READS=${checkout ? 1 : 0}`), "installed no-op uses retained reads, while a source checkout keeps the in-place report");
      if (checkout) assert.match(result.stdout, /later update will require stopping/i);
      else assert.doesNotMatch(result.stdout, /later update will require stopping/i);
    }
    console.log("current Manager report: installed retention and checkout isolation pass");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

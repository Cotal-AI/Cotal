import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.scripts.preinstall, undefined, "platform support must not depend on install scripts");
const entry = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "npm-platform-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COTAL_|NATS_|NODE_OPTIONS$)/.test(key)));
env.HOME = join(scratch, "home");
env.XDG_CONFIG_HOME = join(scratch, "config");
env.XDG_RUNTIME_DIR = join(scratch, "run");
env.COTAL_HOME = join(scratch, "state");
env.DO_NOT_TRACK = "1";
mkdirSync(env.HOME, { mode: 0o700 });
mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });

for (const [name, header] of [
  ["missing", {}],
  ["compiler-only", { glibcVersionCompiler: "2.39" }],
  ["empty", { glibcVersionRuntime: "" }],
] as const) {
  const preload = join(scratch, `${name}.mjs`);
  writeFileSync(preload, `Object.defineProperty(process, "platform", { value: "linux" });
process.report.getReport = () => ({ header: ${JSON.stringify(header)} });\n`);
  for (const args of [["--version"], ["up", "--foreground"], ["setup", "--no-input"], ["__daemon-manager"], ["spawn"], ["sp"]]) {
    const handoff = join(scratch, `${name}-${args[0]}-handoff.json`);
    const managed = args[0] === "spawn" || args[0] === "sp";
    const key = args[0] === "sp" ? "Cotal_Managed_Handoff_File" : "COTAL_MANAGED_HANDOFF_FILE";
    const childEnv = { ...env };
    if (managed) {
      writeFileSync(handoff, JSON.stringify({ actorToken: "platform-smoke-placeholder" }), { mode: 0o600 });
      childEnv[key] = handoff;
      childEnv.COTAL_MANAGER_INSTANCE = "platform-smoke";
    }
    const result = spawnSync(process.execPath, ["--import", preload, entry, ...args], {
      env: childEnv, cwd: scratch, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Cotal requires glibc on Linux\./);
    assert.match(result.stderr, /Alpine and other musl distributions are not supported/);
    assert.match(result.stderr, /Use a glibc distribution or container/);
    if (managed) assert(!existsSync(handoff), "unsupported-platform refusal must remove the managed handoff");
    assert(!existsSync(env.COTAL_HOME), "refusal must precede Cotal state creation");
    assert(!existsSync(join(scratch, ".cotal")), "refusal must precede stack setup");
    console.log(`PASS: ${name} ${args.join(" ")} refused at the real CLI entry`);
  }
}

const version = spawnSync(process.execPath, [entry, "--version"], { env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout, /^cotal-ai \d+\.\d+\.\d+/);
console.log("PASS: host platform starts and reports the version");

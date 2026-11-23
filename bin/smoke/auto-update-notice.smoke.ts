import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "autoupd-notice-"));
const home = join(root, "home");
const runtime = join(root, "runtime");
mkdirSync(home, { mode: 0o700 });
mkdirSync(runtime, { mode: 0o700 });
mkdirSync(join(root, ".cotal"));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home, COTAL_HOME: home,
  XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: runtime, TMPDIR: root,
  npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"),
  npm_config_userconfig: join(root, "npmrc"), npm_config_globalconfig: join(root, "npmrc-global"),
  npm_config_registry: "http://127.0.0.1:1", COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", TERM: "xterm-256color",
};
writeFileSync(join(home, "update-check.json"), JSON.stringify({ v: 1, latest: "99.0.0", checkedAt: Date.now(), attemptedAt: Date.now(), firstSeenAt: Date.now() }));
const entry = join(repo, "bin/dist/cotal.js");
function ptyArgs(args: string[]): string[] {
  const command = [process.execPath, entry, ...args].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
  return ["-qec", command, "/dev/null"];
}
function run(args: string[], terminal = false, extra: Record<string, string> = {}, code = 0): string {
  const options = { cwd: root, env: { ...env, ...extra }, encoding: "utf8" as const, timeout: 30_000 };
  const result = terminal ? spawnSync("script", ptyArgs(args), options) : spawnSync(process.execPath, [entry, ...args], options);
  assert.equal(result.status, code, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}

async function coldHelp(): Promise<void> {
  const requests: string[] = [];
  const latest = "99.0.0";
  const registry = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest }, versions: { [latest]: { name: "cotal-ai", version: latest } } }));
  });
  await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
  try {
    const address = registry.address();
    if (!address || typeof address === "string") throw new Error("missing test registry address");
    const terminal = promisify(execFile);
    const invoke = (args: string[], cotalHome: string) => terminal("script", ptyArgs(args), {
      cwd: root, env: { ...env, COTAL_HOME: cotalHome, npm_config_registry: `http://127.0.0.1:${address.port}` }, timeout: 30_000,
    });
    const helpHome = join(root, "help-home");
    const docsHome = join(root, "docs-home");
    assert.match((await invoke(["--no-color", "--help"], helpHome)).stdout, /lateral agent coordination/);
    assert.match((await invoke(["--no-color", "docs"], docsHome)).stdout, /documentation/);
    const cache = join(docsHome, "update-check.json");
    const lock = join(docsHome, "update-check.lock");
    const deadline = Date.now() + 15_000;
    while ((!existsSync(cache) || existsSync(lock)) && Date.now() < deadline) await wait(50);
    assert.equal(JSON.parse(readFileSync(cache, "utf8")).latest, latest);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(requests, ["GET /cotal-ai"]);
    assert.equal(existsSync(helpHome), false);
  } finally {
    await new Promise<void>(resolve => registry.close(() => resolve()));
  }
}
assert.match(run(["update", "--auto", "off"]), /Automatic updates: off/);
assert.match(run(["update", "--auto"]), /Automatic updates: off/);
if (process.platform === "win32") assert.doesNotMatch(run(["update", "--auto"]), /Automatic installation is unavailable on Windows/);
assert.match(run(["--version"], true), /Cotal update available: .* -> 99\.0\.0/);
assert.doesNotMatch(run(["--version"]), /Cotal update available:/);
assert.doesNotMatch(run(["version", "--json"], true), /Cotal update available:/);
assert.doesNotMatch(run(["config", "--plain"], true), /Cotal update available:/);
for (const args of [["help"], ["--no-color", "--help"], ["-h"], ["--", "--help"], ["help", "docs"], ["docs", "--help"], ["docs", "-h"]]) {
  const output = run(args, true);
  assert.match(output, /lateral agent coordination|Usage/, args.join(" "));
  assert.doesNotMatch(output, /Cotal update available:/, args.join(" "));
}
const literal = run(["docs", "--", "--help"], true, {}, 1);
assert.match(literal, /no docs page "--help"/);
assert.match(literal, /Cotal update available:/);
assert.doesNotMatch(run(["--version"], true, { CI: "1" }), /Cotal update available:/);
assert.doesNotMatch(run(["--version"], true, { COTAL_NO_UPDATE_CHECK: "1" }), /Cotal update available:/);
assert.match(run(["update", "--notify", "off"]), /Update notices: off/);
assert.doesNotMatch(run(["--version"], true), /Cotal update available:/);
assert.match(run(["update", "--notify", "on"]), /Update notices: on/);
assert.equal((run(["--version"], true).match(/Cotal update available:/g) ?? []).length, 1);
await coldHelp();
emitSentinel({ passed: counted.cells(), failed: 0 });

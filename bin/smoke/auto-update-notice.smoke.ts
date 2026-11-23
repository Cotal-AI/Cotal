import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "autoupd-notice-"));
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
mkdirSync(join(root, ".cotal"));
const runtime = join(root, "run");
mkdirSync(runtime, { mode: 0o700 });
for (const name of ["npmrc", "npmrc-global"]) writeFileSync(join(root, name), "");
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home, COTAL_HOME: home,
  XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: runtime, TMPDIR: root,
  npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"),
  npm_config_registry: "http://127.0.0.1:1", npm_config_userconfig: join(root, "npmrc"),
  npm_config_globalconfig: join(root, "npmrc-global"),
  COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", LANG: "C.UTF-8",
};
writeFileSync(join(home, "update-check.json"), JSON.stringify({ v: 1, latest: "99.0.0", checkedAt: Date.now(), attemptedAt: Date.now(), firstSeenAt: Date.now() }));
const entry = join(repo, "bin/dist/cotal.js");
function run(args: readonly string[], terminal = false, extra: NodeJS.ProcessEnv = {}, status = 0): string {
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, entry, ...args].map(quote).join(" ");
  const options = { cwd: root, env: { ...env, ...extra }, encoding: "utf8" as const, timeout: 30_000 };
  const result = terminal ? spawnSync("script", ["-qec", command, "/dev/null"], options) : spawnSync(process.execPath, [entry, ...args], options);
  if (result.error) throw result.error;
  assert.equal(result.status, status, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return (result.stdout + result.stderr).replaceAll("\r", "");
}
assert.match(run(["update", "--auto", "off"]), /Automatic updates: off/);
assert.match(run(["update", "--auto"]), /Automatic updates: off/);
if (process.platform === "win32") assert.doesNotMatch(run(["update", "--auto"]), /Automatic installation is unavailable on Windows/);
assert.match(run(["--version"], true), /Cotal update available: .* -> 99\.0\.0/);
assert.doesNotMatch(run(["--version"]), /Cotal update available:/);
assert.doesNotMatch(run(["version", "--json"], true), /Cotal update available:/);
assert.doesNotMatch(run(["config", "--plain"], true), /Cotal update available:/);
assert.doesNotMatch(run(["--version"], true, { CI: "1" }), /Cotal update available:/);
assert.doesNotMatch(run(["--version"], true, { COTAL_NO_UPDATE_CHECK: "1" }), /Cotal update available:/);
assert.match(run(["update", "--notify", "off"]), /Update notices: off/);
assert.doesNotMatch(run(["--version"], true), /Cotal update available:/);
assert.match(run(["update", "--notify", "on"]), /Update notices: on/);
assert.equal((run(["--version"], true).match(/Cotal update available:/g) ?? []).length, 1);

const helpCases = [
  { args: ["--no-color", "--help"], heading: /cotal - lateral agent coordination over NATS/ },
  { args: ["--no-color", "-h"], heading: /cotal - lateral agent coordination over NATS/ },
  { args: ["--no-color", "help"], heading: /cotal - lateral agent coordination over NATS/ },
  { args: ["--no-color", "help", "docs"], heading: /^cotal docs\b/ },
  { args: ["--no-color", "docs", "--help"], heading: /^cotal docs\b/ },
  { args: ["--no-color", "--", "docs", "-h"], heading: /^cotal docs\b/ },
];
for (const { args, heading } of helpCases) {
  const output = run(args, true);
  assert.match(output, heading);
  assert.doesNotMatch(output, /Cotal update available:/);
}

async function checkColdHelp(): Promise<void> {
  const requests: string[] = [];
  const registry = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: "99.0.0" }, versions: { "99.0.0": { version: "99.0.0" } } }));
  });
  await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
  try {
    const address = registry.address();
    if (!address || typeof address === "string") throw new Error("local npm registry did not bind");
    const cotalHome = (id: string) => join(root, id, ".cotal");
    const isolated = (id: string) => {
      const privateHome = join(root, id);
      mkdirSync(privateHome, { mode: 0o700 });
      return {
        HOME: privateHome, USERPROFILE: privateHome, COTAL_HOME: undefined,
        XDG_CONFIG_HOME: join(privateHome, "config"), npm_config_cache: join(privateHome, "npm-cache"),
        npm_config_registry: `http://127.0.0.1:${address.port}/${id}/`,
      };
    };
    const helpIds = helpCases.map(({ args, heading }, index) => {
      const id = `help-${index}`;
      assert.match(run(args, true, isolated(id)), heading);
      return id;
    });
    assert.match(run(["--no-color", "--help"], false, isolated("redirected")), /cotal - lateral agent coordination over NATS/);
    assert.match(run(["--no-color", "docs"], true, isolated("docs")), /Bundled with this installed version and readable offline/);
    assert.match(run(["--no-color", "docs", "--", "--help"], true, isolated("literal"), 1), /no docs page "--help"/);
    const controls = [cotalHome("docs"), cotalHome("literal")];
    const deadline = Date.now() + 10_000;
    while (controls.some(dir => !existsSync(join(dir, "update-check.json")) || existsSync(join(dir, "update-check.lock"))) && Date.now() < deadline) await delay(50);
    for (const dir of controls) assert.equal(JSON.parse(readFileSync(join(dir, "update-check.json"), "utf8")).latest, "99.0.0");
    await delay(1_500);
    assert.deepEqual(requests.sort(), ["GET /docs/cotal-ai", "GET /literal/cotal-ai"]);
    for (const id of [...helpIds, "redirected"]) assert.equal(existsSync(cotalHome(id)), false, `${id} created a Cotal home`);
    console.log("Help left cold homes untouched and made no registry requests. Interactive docs and a literal --help operand both fetched and cached the fixture version.");
  } finally {
    await new Promise<void>(resolve => registry.close(() => resolve()));
  }
}
await checkColdHelp();
emitSentinel({ passed: counted.cells(), failed: 0 });

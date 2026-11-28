/** A legitimate update never fails over an installed extension. An extension added before connectors
 *  could declare an install, whose connector now declares one the check refuses, is left as it was by
 *  `cotal update` and by the reseed it runs; the app offers no Install for it, and names its package.
 *  Adding such a package fresh is still refused, loudly. Everything runs in a private home against a
 *  local registry that reports this version as the latest. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { writePluginFixture } from "../../scripts/plugin-fixture.mjs";

if (process.platform === "win32") skipSuite("harness-install-update: the reseed and the bridge's login-shell PATH run here on Linux and macOS; Windows runs the declaration check");
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const version = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }).version;
const root = mkdtempSync(join(tmpdir(), "harness-install-update-"));
let checks = 0;
const check = (ok: unknown, what: string) => { assert.ok(ok, what); checks++; };

let served = 0;
const registry = createServer((_request, response) => { served++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })); });
await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
for (const leaf of ["home", "cotal", "config", "rt", "cache", "data", "state", "tmp"]) mkdirSync(join(root, leaf), { mode: 0o700 });
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, LANG: "C.UTF-8", USER: process.env.USER, LOGNAME: process.env.LOGNAME,
  HOME: join(root, "home"), COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "rt"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), TMPDIR: join(root, "tmp"),
  COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
const cotal = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, cwd: root, encoding: "utf8", timeout: 300_000 });
/** For `update`, which reads the registry this process serves: spawnSync would block the event loop that answers it. */
function cotalAsync(args: string[], extra: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extra }, cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, output }));
  });
}
const manifest = () => JSON.parse(readFileSync(join(root, "config", "cotal", "extensions", "extensions.json"), "utf8")) as { extensions: Array<{ pkg: string; connectors?: unknown }> };
const entry = () => manifest().extensions.find(ext => ext.pkg === "cotal-connector-oldbad");

/** A third-party connector package. `install` is the declaration its connector makes, if any. */
function connectorPackage(dir: string, packageVersion: string, install?: unknown): string {
  const provider = { kind: "connector", name: "oldbad", requires: ["oldbad"], ...(install === undefined ? {} : { install }) };
  writePluginFixture(dir, { name: "cotal-connector-oldbad", version: packageVersion, provides: [provider],
    factorySource: `export default host => host.register({ ...${JSON.stringify(provider)}, buildLaunch() { throw new Error("fixture"); } });\n` });
  return dir;
}
const refusedInstall = { title: "Old Bad", maker: "Someone", installers: { linux: { script: "https://oldbad.example/i.sh", shell: "sh", binDir: "~/$(touch pwned)" }, darwin: { script: "https://oldbad.example/i.sh", shell: "sh", binDir: "~/$(touch pwned)" } } };

try {
  check(cotal(["ext", "root"]).stdout.trim().startsWith(join(root, "config")), "extensions resolve inside the private home");
  const seeded = cotal(["ext", "seed"]);
  check(seeded.status === 0, `the official connectors seed: ${seeded.stderr}`);
  // Installed as an older CLI did: the connector declared nothing it checked, so no install is cached.
  const added = cotal(["ext", "add", connectorPackage(join(root, "pkg-old"), "1.0.0")]);
  check(added.status === 0, `the third-party connector installs: ${added.stderr}`);
  // Its installed code now declares an install the check refuses, as a package written before the field existed might.
  connectorPackage(join(root, "config", "cotal", "extensions", "node_modules", "cotal-connector-oldbad"), "1.0.0", refusedInstall);
  const before = JSON.stringify(entry());
  check((entry()?.connectors as Array<Record<string, unknown>> | undefined)?.length === 1 && !("install" in (entry()!.connectors as Array<Record<string, unknown>>)[0]!), `the cached connector carries no install: ${before}`);

  const update = await cotalAsync(["update"], { npm_config_registry: `http://127.0.0.1:${(registry.address() as AddressInfo).port}` });
  const output = update.output;
  check(served > 0 && output.includes(`Registry latest: ${version}`), `cotal update read this smoke's registry (${served} requests): ${output}`);
  if (update.status !== 0 && /running manager continuity check:/.test(output) && !/invalid install/.test(output)) {
    // The census reads every Manager on the machine, so another home's running Manager stops `update` before its reseed.
    // This smoke starts none. The forced reseed below is the step `update` runs (`runSeed({ force: true })`).
    console.log(`SKIP cotal update exit: a Manager outside this smoke runs on this machine (${/Manager pid \d+/.exec(output)?.[0] ?? "named in the refusal"})`);
  } else {
    check(update.status === 0, `cotal update succeeds with the extension installed: ${output}`);
  }
  const reseed = cotal(["ext", "seed", "--force"]);
  check(reseed.status === 0, `the forced reseed succeeds: ${reseed.stderr}`);
  check(JSON.stringify(entry()) === before, `the third-party entry is unchanged: ${JSON.stringify(entry())}`);
  check(!existsSync(join(root, "home", "pwned")) && !existsSync(join(root, "pwned")), "nothing from the refused declaration ran");

  const listed = await new Promise<string>((resolve, reject) => {
    const bridge = spawn(process.execPath, [cli, "daemon", "desktop"], { env, cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { bridge.kill("SIGKILL"); reject(new Error("the bridge did not answer")); }, 120_000);
    bridge.stdout.on("data", (chunk: Buffer) => { out += chunk; });
    bridge.once("close", () => { clearTimeout(timer); resolve(out); });
    bridge.stdin.end(`${JSON.stringify({ op: "agent-apps" })}\n`);
  });
  const result = JSON.parse(listed.trim().split("\n").at(-1)!) as { ok: boolean; result?: { apps: Array<Record<string, unknown>> } };
  const row = result.result?.apps.find(app => app.name === "oldbad");
  assert.deepEqual(row, { name: "oldbad", title: "oldbad", state: "missing", missing: ["oldbad"], package: "cotal-connector-oldbad" }, "the app lists it with its package and no Install"); checks++;
  check(result.result?.apps.filter(app => app.package !== undefined).length === 1, "the official connectors carry no package");

  // A fresh add of the same declaration stays loud.
  cpSync(join(root, "pkg-old"), join(root, "pkg-new"), { recursive: true });
  const refused = cotal(["ext", "add", connectorPackage(join(root, "pkg-new"), "1.0.1", refusedInstall)]);
  check(refused.status !== 0 && /connector oldbad declares an invalid install/.test(refused.stderr), `adding the refused declaration fails: ${refused.stderr.slice(-400)}`);
  check(JSON.stringify(entry()) === before, "the refused add left the installed entry as it was");
  console.log(`harness-install-update: ${checks} checks passed (${process.platform})`);
} finally {
  await new Promise<void>(resolve => registry.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}

/**
 * LIVE e2e for `cotal ext` (CLI rework stage 3): fixture extension packages are built on the fly
 * and driven through the REAL binary as subprocesses (sandboxed XDG_CONFIG_HOME/COTAL_HOME):
 *
 *  A. add: installs into the cotal-owned prefix and caches declared providers without an import.
 *  B. cache-only surface: with the installed package's code made to THROW, `--help` and
 *     `__complete` still work (they never import); running the command fails LOUD.
 *  C. run: the real command executes with LIVE specs (flag + positional through the kernel);
 *     re-add is a clean refresh; a corrupt manifest is ONE red line, not a stack dump.
 *  D. version-skew: on-disk version ≠ manifest pin → loud error prescribing re-add.
 *  E. failed adds are loud AND rolled back: builtin name collision, ext-vs-ext name collision
 *     (checked against the manifest cache), unsupported core versions, and missing declarations.
 *  F. non-command providers: runtime-only install + lazy supervise resolution; a contributed
 *     local process is not a named `down` target, and only bare `down` stops it, with the stack.
 *  E3. aliases: an extension's alias runs its command; an alias or name a built-in or another
 *     installed extension already claims fails the add.
 *  G. remove: commands leave the surface; the manifest empties.
 * Run: pnpm smoke:ext:live   (needs npm on PATH)
 */
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { recordMesh } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { writePluginFixture, type FixtureProvider } from "../../scripts/plugin-fixture.mjs";

// macOS commonly exposes tmpdir() through /var -> /private/var (and this harness may add another
// alias). The CLI canonicalizes cwd, so register the same physical root or extension removal sees
// two contexts and tries to reserve the same provider pidfile twice.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "cotal-ext-sb-")));
const configDir = join(sandbox, "xdg");
const home = join(sandbox, "home");
mkdirSync(configDir, { recursive: true });
mkdirSync(home, { recursive: true });
// The in-process registry write in F goes to the same sandboxed home as the CLI's; it is read per call.
process.env.COTAL_HOME = home;
// COTAL_HOME isolates only the registry; CLI project-root resolution still walks for `.cotal`.
mkdirSync(join(sandbox, ".cotal"), { recursive: true });
const sandboxAnchor = recordSmokeSandbox({ root: sandbox, cotalHome: home, xdgConfigHome: configDir });

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// Isolate this THIRD-PARTY extension suite from built-in-connector seeding (its own suite covers
// that): with the opt-out set, a fresh prefix stays empty so the add/remove/manifest assertions below
// speak only about the fixture packages.
const env = { ...process.env, XDG_CONFIG_HOME: configDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1" };
const realNode = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
const tsxCli = resolve(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const binCotal = resolve(import.meta.dirname, "..", "cotal.ts");
const cotal = (args: string[], { timeout = 180_000, extraEnv = {} }: { timeout?: number; extraEnv?: NodeJS.ProcessEnv } = {}) => {
  const options = { encoding: "utf8" as const, env: { ...env, ...extraEnv }, cwd: sandbox, timeout };
  assertSmokeSandboxDown(sandboxAnchor, args, options);
  return spawnSync(realNode, [tsxCli, binCotal, ...args], options);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const target = cotal(["meshes", "add", "main", "--server", "nats://127.0.0.1:1", "--root", sandbox, "--mode", "open", "--force"]);
ok("fixture mesh target is registered", target.status === 0, target.stderr);

/** Build a fixture extension package on disk. `index` is its module body. */
function fixture(name: string, index: string, options: { name?: string; version?: string; core?: string; legacy?: boolean; provides?: FixtureProvider[]; packageFields?: Record<string, unknown> } = {}): string {
  const dir = join(sandbox, name);
  const command = /kind: "command",\s*name: "([^"]+)"/.exec(index)?.[1];
  const provides = options.provides ?? (command ? [{ ...GOOD_COMMAND, name: command }] : []);
  writePluginFixture(dir, { name: options.name ?? name, version: options.version ?? "1.0.0", provides, factorySource: index,
    ...(options.core ? { core: options.core } : {}), ...(options.legacy ? { contract: 0 } : {}),
    ...(options.packageFields ? { packageFields: options.packageFields } : {}) });
  return dir;
}

const GOOD_COMMAND = {
  kind: "command", name: "hello-ext", group: "Extensions", summary: "fixture extension command",
  flags: [{ name: "shout", type: "boolean", description: "upper-case it" }], positionals: "[<who>]",
};
const GOOD = `export default host => host.register({
  kind: "command",
  name: "hello-ext",
  group: "Extensions",
  summary: "fixture extension command",
  flags: [{ name: "shout", type: "boolean", description: "upper-case it" }],
  positionals: "[<who>]",
  run: async (args) => {
    const who = args.positionals[0] ?? "world";
    const msg = "hello " + who;
    console.log(args.values.shout ? msg.toUpperCase() : msg);
  },
});
`;

const extDir = join(configDir, "cotal", "extensions");
const manifestPath = join(extDir, "extensions.json");
const installedIndex = join(extDir, "node_modules", "cotal-ext-fixture", "index.js");
const installedPkg = join(extDir, "node_modules", "cotal-ext-fixture", "package.json");
const goodFixture = fixture("local extension", GOOD, { name: "cotal-ext-fixture", packageFields: { bin: { "fixture-bin": "bin.js" } } });
const goodMetadata = join(goodFixture, "package.json");
writeFileSync(goodMetadata, JSON.stringify({ ...JSON.parse(readFileSync(goodMetadata, "utf8")), main: "./index" }));

// -- empty state ---------------------------------------------------------------------------------
ok("ext list starts empty", /No extensions installed\./.test(cotal(["ext", "list"]).stdout));

{
  const marker = join(sandbox, "fixture-imported");
  const body = `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\n${GOOD.replaceAll('hello-ext', 'core-window')}`;
  const bad = fixture("cotal-ext-newer-core", body, { core: "99.0.0" });
  const refusal = cotal(["ext", "add", bad]);
  ok("newer bundled core is refused without importing the package", refusal.status === 1 && /uses newer core 99\.0\.0/.test(refusal.stderr) && !existsSync(marker), refusal.stderr);
  const compatible = fixture("cotal-ext-compatible-core", body);
  const added = cotal(["ext", "add", compatible]);
  ok("regular fixture installs without executing its module", added.status === 0 && !existsSync(marker), added.stderr);
  const ran = cotal(["core-window"]);
  ok("first dispatch imports and runs the installed factory", ran.status === 0 && ran.stdout.trim() === "hello world" && existsSync(marker), ran.stderr);
  ok("the compatible install still removes", cotal(["ext", "remove", "cotal-ext-compatible-core"]).status === 0);
}

async function explicitOlderRegistryPin() {
  const version = "0.1.0", official = "@cotal-ai/tmux", thirdParty = "cotal-ext-registry-core";
  const command = "registry-core-probe";
  const provider = { ...GOOD_COMMAND, name: command, reads: true };
  const body = `export default host => host.register({ ...${JSON.stringify(provider)}, run() { throw new Error("incompatible registry fixture ran"); } });`;
  const rows = [official, thirdParty].map((name, i) => {
    const dir = fixture(`registry-core-${i}/package`, body, { name, version, core: i === 0 ? version : "99.0.0", provides: [provider] });
    const archive = execFileSync("tar", ["-czf", "-", "-C", join(dir, ".."), "package"]);
    return { name, dir, archive, metadata: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` };
  });
  const paths = new Set<string>();
  let origin = "";
  const registry = createServer((req, res) => {
    const path = decodeURIComponent(req.url ?? "");
    paths.add(path);
    const i = rows.findIndex((row, index) => path === `/${row.name}` || path === `/package-${index}.tgz`);
    const row = rows[i];
    if (!row) { res.writeHead(404).end(); return; }
    if (path.endsWith(".tgz")) { res.end(row.archive); return; }
    const dist = { tarball: `${origin}/package-${i}.tgz`, integrity: row.integrity };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: row.name, versions: { [version]: { ...row.metadata, dist } } }));
  });
  try {
    await new Promise<void>((ready, reject) => registry.once("error", reject).listen(0, "127.0.0.1", ready));
    const address = registry.address();
    if (!address || typeof address === "string") throw new Error("loopback registry has no TCP port");
    origin = `http://127.0.0.1:${address.port}`;
    const npmrc = join(sandbox, "fixture-registry.npmrc");
    writeFileSync(npmrc, `@cotal-ai:registry=${origin}\n`);
    const add = (name: string) => promisify(execFile)(realNode, [tsxCli, binCotal, "ext", "add", `${name}@${version}`], {
      cwd: sandbox, timeout: 180_000,
      env: { ...env, npm_config_userconfig: npmrc, npm_config_registry: origin, npm_config_fetch_retries: "0" },
    });
    const result = await add(official);
    const manifest = readFileSync(manifestPath, "utf8");
    const pin = JSON.parse(manifest).extensions.find((entry: { pkg: string }) => entry.pkg === official);
    const peer = join(extDir, "node_modules", official, "node_modules", "@cotal-ai", "core");
    ok("an explicit older first-party registry pin installs without a host-core link",
      paths.has("/package-0.tgz") && result.stdout.includes(`added ${official}@${version}`) && pin?.version === version && !existsSync(peer), result.stdout + result.stderr);
    const run = cotal([command]);
    ok("loading the out-of-lockstep official pin names self-update without reconciling it",
      run.status === 1 && /update --self/.test(run.stderr) && readFileSync(manifestPath, "utf8") === manifest, run.stderr);
    const refused = await add(thirdParty).then(() => undefined, (error: { code?: number; stderr?: string }) => error);
    ok("newer third-party core is refused without replacing the pinned inventory",
      paths.has("/package-1.tgz") && refused?.code === 1 && /uses newer core 99\.0\.0/.test(refused.stderr ?? "") && readFileSync(manifestPath, "utf8") === manifest, refused);
    const local = cotal(["ext", "add", rows[0]!.dir]);
    ok("the same out-of-lockstep package is refused as a local add", local.status === 1 && /update --self/.test(local.stderr) && readFileSync(manifestPath, "utf8") === manifest, local.stderr);
    ok("the registry pin still removes", cotal(["ext", "remove", official]).status === 0);
  } finally {
    await new Promise<void>(done => registry.close(() => done()));
  }
}

await explicitOlderRegistryPin();

// -- A: add --------------------------------------------------------------------------------------
{
  writeFileSync(join(goodFixture, "bin.js"), "#!/usr/bin/env node\n");
  const r = cotal(["ext", "add", goodFixture]);
  ok("add resolves an extensionless npm main", r.status === 0, r.stderr.slice(-400));
  ok("add names the contributed command", /hello-ext/.test(r.stdout), r.stdout);
  ok("manifest written + announced", existsSync(manifestPath) && /→ wrote extensions manifest/.test(r.stderr), r.stderr.slice(-300));
  ok("installed fixture has no link to host core", !existsSync(join(installedPkg, "..", "node_modules", "@cotal-ai", "core")));
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok("manifest pins name@version + caches flags and provider keys", m.extensions[0].version === "1.0.0" && m.extensions[0].commands[0].flags[0].name === "shout" && m.extensions[0].provides[0].kind === "command", m.extensions[0]);
  const run = cotal(["hello-ext"]);
  ok("a later command resolves the same npm main", run.status === 0 && run.stdout.trim() === "hello world", run);
}

{
  const pkg = "cotal-ext-plural-kind";
  const name = "hello-ext-typo";
  const path = fixture(pkg, GOOD.replace('kind: "command"', 'kind: "commands"').replace('name: "hello-ext"', `name: "${name}"`));
  const add = cotal(["ext", "add", path]);
  ok("add refuses a package that declares no valid providers", add.status === 1 && add.stderr.includes(pkg), add);
  const list = cotal(["ext", "list"]);
  ok("list does not expose the refused package", list.status === 0 && !list.stdout.includes(pkg), list);
  const help = cotal(["help"]);
  const run = cotal([name]);
  ok("a plural kind does not add a CLI command", help.status === 0 && !help.stdout.includes(name)
    && run.status === 1 && run.stderr.includes(`unknown command: ${name}`) && run.stdout === "", run);
}

// -- B: cache-only help/complete; run fails loud while broken -------------------------------------
{
  const good = readFileSync(installedIndex, "utf8");
  writeFileSync(installedIndex, 'throw new Error("BOOM — cache must not import me");\n');
  // Help lists every command group, extensions included, under the entry screen.
  const help = cotal(["help"]);
  ok("help lists the extension command WITHOUT importing it", help.status === 0 && /hello-ext/.test(help.stdout), help.stdout.slice(-400));
  const comp = cotal(["__complete", "hello-ext", "--"]);
  ok("<TAB> offers cached flags WITHOUT importing", comp.status === 0 && /--shout/.test(comp.stdout), comp.stdout);
  const run = cotal(["hello-ext"]);
  ok("running the broken extension fails loud, naming it", run.status === 1 && /cotal-ext-fixture/.test(run.stderr) && /BOOM/.test(run.stderr), run.stderr.slice(0, 300));
  if (process.platform !== "win32") {
    const retry = /`(?:pnpm )?cotal (ext add [^`]+)`/.exec(run.stderr)?.[1];
    ok("the import error prints a reinstall command", retry !== undefined, run.stderr);
    // Use the smoke's launcher but let the shell parse the printed arguments unchanged.
    const readded = spawnSync("sh", ["-c", `"$@" ${retry}`, "sh", realNode, tsxCli, binCotal], {
      encoding: "utf8", env, cwd: sandbox, timeout: 180_000,
    });
    ok("the printed reinstall command accepts a path with spaces", readded.status === 0 && /added cotal-ext-fixture/.test(readded.stdout), readded.stderr);
  } else {
    writeFileSync(installedIndex, good);
  }
}

// -- B3: a competing load waits for the module evaluation under the installation lock ---------------
{
  const ready = join(sandbox, "materialize-ready");
  const release = join(sandbox, "materialize-release");
  const good = readFileSync(installedIndex, "utf8");
  writeFileSync(
    installedIndex,
    `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
while (!existsSync(${JSON.stringify(release)})) await sleep(10);
export default host => host.register({ ...${JSON.stringify(GOOD_COMMAND)}, run: async () => console.log("barrier-ok") });
`,
  );
  let stdout = "";
  let stderr = "";
  const first = spawn(realNode, [tsxCli, binCotal, "hello-ext"], { env, cwd: sandbox, timeout: 30_000 });
  first.stdout.on("data", (data) => (stdout += data.toString()));
  first.stderr.on("data", (data) => (stderr += data.toString()));
  const firstDone = new Promise<number | null>((resolve) => first.on("close", resolve));
  let secondDone: Promise<number | null> | undefined;
  let secondStdout = "";
  let secondStderr = "";
  let firstStatus: number | null = null;
  let secondStatus: number | null = null;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await sleep(20);
    ok("first materializer reaches top-level await while holding the prefix lock", existsSync(ready), stderr);
    const owner = readFileSync(ready, "utf8");
    const second = spawn(realNode, [tsxCli, binCotal, "hello-ext"], { env, cwd: sandbox, timeout: 30_000 });
    second.stdout.on("data", (data) => (secondStdout += data.toString()));
    second.stderr.on("data", (data) => (secondStderr += data.toString()));
    let secondClosed = false;
    secondDone = new Promise<number | null>((resolve) => second.on("close", (status) => { secondClosed = true; resolve(status); }));
    const notice = `waiting for another cotal command (pid ${owner}) to finish changing this installation`;
    const waitDeadline = Date.now() + 10_000;
    while (!secondClosed && !secondStderr.includes(notice) && Date.now() < waitDeadline) await sleep(20);
    ok("a competing materializer announces the closure holder and stays waiting",
      !secondClosed && secondStderr.includes(notice) && secondStdout === "", secondStdout + secondStderr);
    ok("the waiting materializer does not evaluate the module", readFileSync(ready, "utf8") === owner, secondStderr);
  } finally {
    writeFileSync(release, "release");
    firstStatus = await firstDone;
    if (secondDone) secondStatus = await secondDone;
    writeFileSync(installedIndex, good);
  }
  ok("the lock holder completes after its module evaluation barrier releases", firstStatus === 0 && /barrier-ok/.test(stdout), stdout + stderr);
  ok("the waiting materializer resumes successfully after the holder releases",
    secondStatus === 0 && /barrier-ok/.test(secondStdout), secondStdout + secondStderr);
}

// -- C: run with LIVE specs ------------------------------------------------------------------------
{
  const r = cotal(["hello-ext", "bob", "--shout"]);
  ok("extension command runs through the kernel", r.status === 0 && r.stdout.includes("HELLO BOB"), r.stdout + r.stderr.slice(-200));
  const bad = cotal(["hello-ext", "--nope"]);
  ok("unknown flag on an extension command is a usage error (live specs)", bad.status === 1 && /Unknown option/.test(bad.stderr), bad.stderr.slice(0, 200));
}

// -- C2: re-adding an installed extension is a clean refresh (manifest keeps ONE entry) ------------
{
  const r = cotal(["ext", "add", goodFixture]);
  ok("re-add of the same extension exits 0", r.status === 0, r.stderr.slice(-300));
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok("re-add keeps one manifest entry at the same pin", m.extensions.length === 1 && m.extensions[0].version === "1.0.0", m.extensions);
  ok("successful re-add preserves npm relative bin symlinks", existsSync(join(extDir, "node_modules", ".bin", "fixture-bin")));
}

// -- C2b: old command-only manifests remain usable and still participate in collision checks -------
{
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete m.extensions[0].provides;
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const help = cotal(["help"]);
  const completion = cotal(["__complete", "hello-ext", "--"]);
  const run = cotal(["hello-ext", "legacy"]);
  ok("legacy command-only manifest still renders, completes, and dispatches", help.status === 0 && /hello-ext/.test(help.stdout) && completion.status === 0 && /--shout/.test(completion.stdout) && run.status === 0 && /hello legacy/.test(run.stdout), help.stdout + completion.stdout + run.stdout + run.stderr);
}

// -- C3: a corrupt manifest is fatal-and-loud as ONE red line (never a stack dump, never a
//        silently-shrunk surface) ------------------------------------------------------------------
{
  const good = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, "{ not json");
  const r = cotal(["--help"]);
  ok("corrupt manifest fails every invocation", r.status === 1, r.status);
  ok("...as one red line naming the manifest and the repair command", /corrupt extensions manifest/.test(r.stderr) && /cotal ext seed --repair/.test(r.stderr), r.stderr.slice(0, 300));
  ok("...not an unhandled-rejection stack dump", !/ModuleJob|at async/.test(r.stderr), r.stderr.slice(0, 300));
  writeFileSync(manifestPath, good);
}

// -- D: version skew -------------------------------------------------------------------------------
{
  const meta = JSON.parse(readFileSync(installedPkg, "utf8"));
  writeFileSync(installedPkg, JSON.stringify({ ...meta, version: "9.9.9" }, null, 2));
  const r = cotal(["hello-ext"]);
  ok("version skew fails loud, prescribing re-add", r.status === 1 && /9\.9\.9/.test(r.stderr) && /ext add/.test(r.stderr), r.stderr.slice(0, 300));
  writeFileSync(installedPkg, JSON.stringify(meta, null, 2));
}

// -- E: failed adds are loud + rolled back ---------------------------------------------------------
{
  // The mutation lock is now a JSON owner FILE (the shared advisory-lock primitive), not a bare PID
  // string. A LIVE owner blocks (fail-fast: "mutation is in progress"); a dead owner is reclaimed; an
  // unreadable path (a stray directory) fails loud fast rather than busy-spinning.
  const mutationLock = join(configDir, "cotal", ".extensions.lock");
  const ownerFile = (pid: number) => JSON.stringify({ pid, nonce: "smoke", ts: 1 });
  writeFileSync(mutationLock, ownerFile(process.pid)); // a live owner (this process)
  const locked = cotal(["ext", "add", fixture("cotal-ext-locked", GOOD.replace('name: "hello-ext"', 'name: "locked-ext"'))]);
  ok("concurrent extension mutation fails loud", locked.status === 1 && /mutation is in progress/.test(locked.stderr), locked.stderr);
  const lockedRun = cotal(["hello-ext"]);
  ok("lazy extension import refuses a concurrent prefix mutation", lockedRun.status === 1 && /install\/remove is in progress/.test(lockedRun.stderr), lockedRun.stderr);
  rmSync(mutationLock, { force: true });

  const deadOwner = spawnSync(realNode, ["-e", ""], { encoding: "utf8" }).pid ?? 2147483646;
  writeFileSync(mutationLock, ownerFile(deadOwner));
  const staleRun = cotal(["hello-ext", "stale-lock"]);
  ok("lazy extension import ignores a dead owner's stale mutation lock", staleRun.status === 0 && /hello stale-lock/.test(staleRun.stdout), staleRun.stdout + staleRun.stderr);
  const staleClaim = cotal(["ext", "remove", "not-installed"]);
  ok("extension mutation reclaims a dead owner's stale lock", staleClaim.status === 0 && /already absent/.test(staleClaim.stdout) && !existsSync(mutationLock), staleClaim.stdout + staleClaim.stderr);

  mkdirSync(mutationLock); // a stray directory where the lock file belongs → unreadable
  // Observe the real lock read without including CLI startup in the assertion.
  const probe = join(sandbox, "count-lock-reads.cjs");
  const countFile = join(sandbox, "lock-read-count");
  writeFileSync(probe, `
const fs = require("node:fs");
const read = fs.readFileSync;
let reads = 0;
fs.readFileSync = function (path, ...args) {
  if (path === ${JSON.stringify(mutationLock)}) reads++;
  return read.call(this, path, ...args);
};
require("node:module").syncBuiltinESMExports();
process.on("exit", () => {
  if (reads > 0) fs.writeFileSync(${JSON.stringify(countFile)}, String(reads));
});
`);
  const unreadable = cotal(["ext", "add", fixture("cotal-ext-unreadable-lock", GOOD.replace('name: "hello-ext"', 'name: "unreadable-lock"'))], {
    timeout: 30_000,
    extraEnv: { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(probe)}`].filter(Boolean).join(" ") },
  });
  const lockReads = existsSync(countFile) ? readFileSync(countFile, "utf8") : "none recorded";
  ok("an unreadable mutation lock fails loud instead of retrying", unreadable.status === 1 && unreadable.stderr.includes(`advisory lock path ${mutationLock} is unreadable`) && lockReads === "1",
    { stderr: unreadable.stderr, error: unreadable.error?.message, lockReads });
  rmSync(mutationLock, { recursive: true, force: true });

  const priorManifest = readFileSync(manifestPath, "utf8");
  const badUpdate = fixture("cotal-ext-bad-update", GOOD, {
    name: "cotal-ext-fixture",
    core: "99.0.0",
  });
  const update = cotal(["ext", "add", badUpdate]);
  const stillRuns = cotal(["hello-ext", "rollback"]);
  ok("failed same-name re-add restores the working package", update.status === 1 && stillRuns.status === 0 && /hello rollback/.test(stillRuns.stdout), update.stderr + stillRuns.stderr);
  ok("failed same-name re-add restores the prior manifest", readFileSync(manifestPath, "utf8") === priorManifest, readFileSync(manifestPath, "utf8"));

  const collide = fixture("cotal-ext-collide", GOOD.replace('name: "hello-ext"', 'name: "spawn"'));
  const r1 = cotal(["ext", "add", collide]);
  ok("builtin-name collision fails the add", r1.status === 1 && /cotal-ext-collide/.test(r1.stderr), r1.stderr.slice(-300));
  const r1b = cotal(["ext", "list"]);
  ok("collision add rolled back (not listed)", !/collide/.test(r1b.stdout), r1b.stdout);

  const sibling = fixture("cotal-ext-sibling", GOOD);
  const r5 = cotal(["ext", "add", sibling]);
  ok(
    "ext-vs-ext name collision fails the add, naming BOTH extensions",
    r5.status === 1 && /cotal-ext-sibling/.test(r5.stderr) && /cotal-ext-fixture/.test(r5.stderr) && /hello-ext/.test(r5.stderr),
    r5.stderr.slice(-400),
  );
  const r5b = cotal(["ext", "list"]);
  ok("ext-vs-ext collision rolled back (not listed)", !/sibling/.test(r5b.stdout), r5b.stdout);
}

// -- E3: aliases. An extension's alias runs its command, and a word another provider claims fails the
// add, whether a built-in or an installed extension (read from its manifest cache) holds it --------
{
  const aliased = (name: string, aliases: string[]) => `export default host => host.register({
  kind: "command",
  name: "${name}",
  aliases: ${JSON.stringify(aliases)},
  group: "Extensions",
  summary: "fixture with an alias",
  positionals: "[<who>]",
  run: async (args) => { console.log("${name} " + (args.positionals[0] ?? "world")); },
});
`;
  const aliasFixture = (pkg: string, name: string, aliases: string[]) => fixture(pkg, aliased(name, aliases), {
    provides: [{ kind: "command", name, aliases, group: "Extensions", summary: "fixture with an alias", positionals: "[<who>]" }],
  });
  const added = cotal(["ext", "add", aliasFixture("cotal-ext-aliased", "alias-ext", ["ax"])]);
  ok("an extension that declares an alias installs", added.status === 0, added.stderr.slice(-400));
  const viaAlias = cotal(["ax", "there"]);
  ok("the alias runs the extension's command", viaAlias.status === 0 && viaAlias.stdout.includes("alias-ext there"), viaAlias.stdout + viaAlias.stderr.slice(-200));
  const help = cotal(["help"]);
  ok("help lists the alias beside its command", /alias-ext, ax/.test(help.stdout), help.stdout.slice(-600));
  const builtin = cotal(["ext", "add", aliasFixture("cotal-ext-claims-sp", "other-ext", ["sp"])]);
  ok("an alias a built-in claims fails the add", builtin.status === 1 && /cotal-ext-claims-sp/.test(builtin.stderr) && /command "sp"/.test(builtin.stderr), builtin.stderr.slice(-300));
  const sibling = cotal(["ext", "add", aliasFixture("cotal-ext-claims-ax", "third-ext", ["ax"])]);
  ok(
    "an alias an installed extension claims fails the add, naming both",
    sibling.status === 1 && /cotal-ext-claims-ax/.test(sibling.stderr) && /cotal-ext-aliased/.test(sibling.stderr) && /"ax"/.test(sibling.stderr),
    sibling.stderr.slice(-400),
  );
  const nameOnAlias = cotal(["ext", "add", aliasFixture("cotal-ext-name-ax", "ax", [])]);
  ok("a name an installed extension claims as its alias fails the add", nameOnAlias.status === 1 && /cotal-ext-name-ax/.test(nameOnAlias.stderr) && /cotal-ext-aliased/.test(nameOnAlias.stderr), nameOnAlias.stderr.slice(-400));
  const listed = cotal(["ext", "list"]).stdout;
  ok("the refused adds rolled back", !/claims-sp|claims-ax|name-ax/.test(listed), listed);
  const removed = cotal(["ext", "remove", "cotal-ext-aliased"]);
  ok("the aliased extension removes", removed.status === 0, removed.stderr.slice(-200));
  const gone = cotal(["ax"]);
  ok("a removed extension's alias is unknown again", gone.status === 1 && /unknown command: ax/.test(gone.stderr), gone.stderr.slice(0, 200));
}


// -- E4: a refused NEW package is staged, so the live prefix is never replaced ------------------
{
  const live = fixture("cotal-ext-live-link", GOOD.replace('name: "hello-ext"', 'name: "live-link"'));
  const added = cotal(["ext", "add", live]);
  ok("a package is installed before the refused new add", added.status === 0, added.stderr.slice(-300));
  const link = join(extDir, "node_modules", "cotal-ext-live-link");
  const files = ["package.json", "package-lock.json", "extensions.json"].map((name) => join(extDir, name));
  const linkBefore = { ino: statSync(link).ino, dev: statSync(link).dev, target: realpathSync(link) };
  const links = (dir: string): { path: string; ino: number; dev: number; target: string }[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return [{ path, ino: stat.ino, dev: stat.dev, target: realpathSync(path) }];
      return stat.isDirectory() ? links(path) : [];
    });
  const linksBefore = links(join(extDir, "node_modules"));
  ok("the refusal identity census includes pre-existing npm launcher links", linksBefore.length > 0 || process.platform === "win32");
  const filesBefore = files.map((path) => ({ path, ino: statSync(path).ino, dev: statSync(path).dev, sha: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  const refused = fixture("cotal-ext-refused-new", GOOD, { legacy: true });
  const add = cotal(["ext", "add", refused]);

  ok(
    "a new package without a plugin declaration exits 1 with the upgrade remedy",
    add.status === 1 && /ext add cotal-ext-refused-new@latest/.test(add.stderr),
    add.stderr.slice(-400),
  );
  const linkAfter = statSync(link);
  ok("the refused new add leaves the live package inode and target", linkBefore.ino === linkAfter.ino && linkBefore.dev === linkAfter.dev && linkBefore.target === realpathSync(link));
  ok("the refused new add preserves every pre-existing link inode and target", linksBefore.every((before) => {
    const after = lstatSync(before.path);
    return after.isSymbolicLink() && before.ino === after.ino && before.dev === after.dev && before.target === realpathSync(before.path);
  }), { links: linksBefore.length });
  for (const file of filesBefore) {
    const after = statSync(file.path);
    const sha = createHash("sha256").update(readFileSync(file.path)).digest("hex");
    ok("refused new add leaves " + file.path.split("/").pop() + " inode and bytes", file.ino === after.ino && file.dev === after.dev && file.sha === sha, { before: file.ino, after: after.ino, shaSame: file.sha === sha });
  }
  const leftovers = readdirSync(join(configDir, "cotal")).filter((name) => name.startsWith(".extensions.stage-") || name.startsWith(".extensions.rollback-"));
  ok("the refused new add leaves no stage or rollback directory", leftovers.length === 0, leftovers);
  const removed = cotal(["ext", "remove", "cotal-ext-live-link"]);
  ok("the pre-existing package still removes after the refusal", removed.status === 0, removed.stderr.slice(-200));
}

// -- F: non-command providers + whole-stack process shutdown ---------------------------------------
{
  const loaded = join(sandbox, "runtime-loaded");
  const PROVIDERS = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(loaded)}, "loaded");
export default host => host.register(
  {
    kind: "runtime",
    name: "fixture-runtime",
    available: () => true,
    create: () => ({ kind: "fixture-runtime", spawn: () => { throw new Error("unused"); } }),
  },
  {
    kind: "runtime",
    name: "fixture-unavailable",
    available: () => false,
    create: () => ({ kind: "fixture-unavailable", spawn: () => { throw new Error("unused"); } }),
  },
  {
    kind: "local-process",
    name: "fixture-worker",
    label: "fixture worker",
    order: 35,
    pidFile: "fixture.pid",
    artifacts: ["fixture.secret"],
  },
);
`;
  const providers = fixture("cotal-ext-providers", PROVIDERS, { provides: [
    { kind: "runtime", name: "fixture-runtime" },
    { kind: "runtime", name: "fixture-unavailable" },
    { kind: "local-process", name: "fixture-worker", label: "fixture worker", order: 35, pidFile: "fixture.pid", artifacts: ["fixture.secret"] },
  ] });
  const added = cotal(["ext", "add", providers]);
  ok("runtime-only extension add exits 0", added.status === 0, added.stderr.slice(-400));
  ok("add reads provider declarations without evaluating the entry", !existsSync(loaded));
  ok("add reports every provider kind", /runtime:fixture-runtime/.test(added.stdout) && /local-process:fixture-worker/.test(added.stdout), added.stdout);
  const providerManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const providerEntry = providerManifest.extensions.find((entry: { pkg: string }) => entry.pkg === "cotal-ext-providers");
  ok("local-process metadata is cached declaratively", providerEntry.localProcesses[0].pidFile === "fixture.pid" && providerEntry.localProcesses[0].artifacts[0] === "fixture.secret", providerEntry);
  rmSync(loaded, { force: true });
  const downCompletion = cotal(["__complete", "down", ""]);
  ok("down completion offers saved services, never installed process providers, and imports nothing", downCompletion.status === 0 && !/fixture-worker/.test(downCompletion.stdout) && !existsSync(loaded), downCompletion.stdout + downCompletion.stderr);
  const supervise = cotal(["supervise", "--runtime", "fixture-runtime", "--server", "nats://127.0.0.1:1"]);
  ok("supervise lazy-loads an installed runtime provider", supervise.status === 1 && existsSync(loaded) && /Can't reach NATS/.test(supervise.stderr) && !/unknown runtime/.test(supervise.stderr), supervise.stderr.slice(-400));

  const unavailableManifest = join(sandbox, "unavailable.yaml");
  // The sandbox is main's root, and a folder runs only its own space, so the manifest names main.
  // It also names the fixture target, so the start never reaches the default 4222.
  writeFileSync(unavailableManifest, `apiVersion: cotal/v1\nkind: Mesh\nspace: main\nbroker:\n  servers: nats://127.0.0.1:1\nruntime: fixture-unavailable\nchannels: {}\n`);
  const unavailable = cotal(["up", "-f", unavailableManifest]);
  ok("up -f rejects an unavailable extension runtime before starting the broker", unavailable.status === 2 && /DEPENDENCY_UNAVAILABLE/.test(unavailable.stderr) && /not reachable/.test(unavailable.stderr) && !existsSync(join(sandbox, ".cotal", "nats.pid")), unavailable.stderr.slice(-400));

  mkdirSync(join(sandbox, ".cotal"), { recursive: true });
  const daemon = (childCode = "setInterval(() => {}, 1000)"): number => {
    const code = `const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`;
    return Number(spawnSync(realNode, ["-e", code], { encoding: "utf8" }).stdout.trim());
  };
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  // A named `down` is a service stop. An installed provider's process, a core component and a typo
  // are all unknown saved services here, so each refuses before any process is signalled or any
  // artifact deleted.
  const fixturePid = daemon();
  writeFileSync(join(sandbox, ".cotal", "fixture.pid"), String(fixturePid));
  writeFileSync(join(sandbox, ".cotal", "fixture.secret"), "keep");
  const liveRemoval = cotal(["ext", "remove", "cotal-ext-providers"]);
  ok("remove preserves a live process and gives a readable refusal",
    liveRemoval.status === 1 && liveRemoval.stderr.includes(`stop pid ${fixturePid}, then retry`)
      && !liveRemoval.stderr.includes("\\u000a") && alive(fixturePid)
      && readFileSync(join(sandbox, ".cotal", "fixture.pid"), "utf8") === String(fixturePid),
    liveRemoval.stderr);
  for (const raw of ["", "not-a-pid", "0", "2147483648", `removing:${process.pid}`]) {
    writeFileSync(join(sandbox, ".cotal", "fixture.pid"), raw);
    const refused = cotal(["ext", "remove", "cotal-ext-providers"]);
    ok(`remove preserves unattributable or reserved record ${JSON.stringify(raw)}`,
      refused.status === 1 && /UNATTRIBUTABLE|extension-removal reservation/.test(refused.stderr)
        && readFileSync(join(sandbox, ".cotal", "fixture.pid"), "utf8") === raw,
      refused.stderr);
  }
  writeFileSync(join(sandbox, ".cotal", "fixture.pid"), String(fixturePid));
  for (const name of ["fixture-worker", "manager", "nats", "managre"]) {
    const named = cotal(["down", name]);
    const reason = name === "manager" ? /no manager has been started/ : /no saved service definition resolves this name/;
    ok(`named down ${name} refuses without an owned service and signals nothing`,
      named.status === 2 && reason.test(named.stderr) && alive(fixturePid) && existsSync(join(sandbox, ".cotal", "fixture.secret")),
      named.stdout + named.stderr);
  }

  // Only bare `down` reaches an extension's process, together with the stack, and it needs the
  // stack's own `up` registration. `meshes add` above recorded a manual one, so this replaces it.
  recordMesh({ space: "main", server: "nats://127.0.0.1:1", root: sandbox, mode: "open", origin: "up", ts: "2026-07-27T00:00:00.000Z" });

  // A refused component stops the sweep before the broker, and keeps its artifacts and the registration.
  const reservationOwner = daemon();
  writeFileSync(join(sandbox, ".cotal", "fixture.pid"), `removing:${reservationOwner}`);
  const reservedDown = cotal(["down", "--yes"]);
  ok("bare down never signals a removal reservation or deletes its artifacts",
    reservedDown.status === 1 && /removal is in progress/.test(reservedDown.stderr) && alive(reservationOwner) && existsSync(join(sandbox, ".cotal", "fixture.secret")),
    reservedDown.stdout + reservedDown.stderr);
  try { process.kill(reservationOwner, "SIGTERM"); } catch { /* gone */ }

  writeFileSync(join(sandbox, ".cotal", "fixture.pid"), String(fixturePid));
  const whole = cotal(["down", "--yes"]);
  ok("bare down stops an installed extension's process with the stack and clears its artifacts",
    whole.status === 0 && !alive(fixturePid) && !existsSync(join(sandbox, ".cotal", "fixture.pid")) && !existsSync(join(sandbox, ".cotal", "fixture.secret")),
    whole.stdout + whole.stderr);
  const exited = await new Promise<number>((resolve, reject) => {
    const child = spawn(realNode, ["-e", "process.exit(0)"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 && child.pid ? resolve(child.pid) : reject(new Error(`child exit ${code}`)));
  });
  ok("the stale record names a real process proven gone", !alive(exited));
  const otherRoot = join(sandbox, "other-root");
  mkdirSync(join(otherRoot, ".cotal"), { recursive: true });
  recordMesh({ space: "other", server: "nats://127.0.0.1:1", root: otherRoot, mode: "open", ts: "2026-07-27T00:00:00.000Z" });
  const stalePaths = [sandbox, otherRoot].map((root) => join(root, ".cotal", "fixture.pid"));
  for (const path of stalePaths) writeFileSync(path, String(exited));
  const staleRemoved = cotal(["ext", "remove", "cotal-ext-providers"]);
  ok("remove reclaims proven-dead pidfiles in the current and registered roots",
    staleRemoved.status === 0 && stalePaths.every((path) => !existsSync(path)), staleRemoved.stdout + staleRemoved.stderr);
  ok("dead-pid removal drops the provider from the installed manifest",
    !JSON.parse(readFileSync(manifestPath, "utf8")).extensions.some((entry: { pkg: string }) => entry.pkg === "cotal-ext-providers"));

  // A provider whose records sit in a folder of their own: remove reserves that folder before the
  // process has ever run, and under a group-writable umask, which the binary inherits, it is 0700.
  const processProvider = { kind: "local-process", name: "nested-worker", label: "nested worker", order: 36, pidFile: "nested-worker/{space}.pid" };
  const nested = fixture("cotal-ext-nested", `export default host => host.register(${JSON.stringify(processProvider)});\n`, { provides: [processProvider] });
  ok("an extension with a nested process record adds", cotal(["ext", "add", nested]).status === 0);
  const previousUmask = process.umask(0o002);
  const nestedRemoved = cotal(["ext", "remove", "cotal-ext-nested"]);
  process.umask(previousUmask);
  const folder = join(sandbox, ".cotal", "nested-worker");
  ok("under umask 0002, remove creates the provider's record folder 0700",
    nestedRemoved.status === 0 && (process.platform === "win32" || (statSync(folder).mode & 0o777) === 0o700), nestedRemoved.stderr.slice(-300));
}

// -- G: remove -------------------------------------------------------------------------------------
{
  const r = cotal(["ext", "remove", "cotal-ext-fixture"]);
  ok("remove exits 0", r.status === 0, r.stderr.slice(-200));
  const gone = cotal(["hello-ext"]);
  ok("removed command is unknown again", gone.status === 1 && /unknown command: hello-ext/.test(gone.stderr), gone.stderr.slice(0, 150));
  ok("ext list is empty again", /No extensions installed\./.test(cotal(["ext", "list"]).stdout));
}

console.log(`\next live e2e: ${pass} checks passed`);

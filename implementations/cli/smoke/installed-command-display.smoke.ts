/** Installed command suggestions remain runnable when the installer's launcher is off PATH. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveOnPath } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, emitSentinel, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") {
  console.log("Installed command display: POSIX installer fixture excluded on Windows");
  emitSentinel({ passed: 0, failed: 0 });
  process.exit(0);
}
const suite = createSuite();
const repo = resolve(import.meta.dirname, "../../..");
const sandbox = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}command-display-`));
const home = join(sandbox, "home's space"), root = join(sandbox, "project"), outside = join(sandbox, "outside"), tools = join(sandbox, "tools"), xdg = join(sandbox, "config");
for (const dir of [home, root, outside, tools, xdg]) mkdirSync(dir, { mode: 0o700 });
// As in installer-selection, runtime discovery and package staging are fixtures. Installer main,
// launcher creation, no-modify-path handling and the CLI itself are real; no download is certified.
for (const name of ["awk", "basename", "cat", "chmod", "cp", "curl", "cut", "date", "dirname", "env", "find", "grep", "head", "id", "ln", "ls", "mkdir", "mktemp", "mv", "readlink", "rm", "rmdir", "sed", "sh", "sort", "tail", "tar", "tr", "uname", "wc", "nats-server"]) {
  const executable = resolveOnPath(name);
  if (!executable) throw new Error(`fixture utility unavailable: ${name}`);
  symlinkSync(executable, join(tools, name));
}
// Linux custody checks use the host's account database and ACLs for group-writable ancestors.
for (const name of ["getent", "getfacl", "python3"]) {
  const executable = resolveOnPath(name);
  if (executable) symlinkSync(executable, join(tools, name));
}
const installer = readFileSync(join(repo, "install.sh"), "utf8");
const entry = '{ main "$@"; exit $?; }';
if (!installer.trimEnd().endsWith(entry)) throw new Error("installer entry guard changed");
const library = join(sandbox, "installer-library.sh"), driver = join(sandbox, "installer-driver.sh");
writeFileSync(library, installer.slice(0, installer.lastIndexOf(entry)));
writeFileSync(driver, `#!/bin/sh
. "$1"
resolve_node() { NODE_BIN="$FIXTURE_NODE"; NPM_BIN="$FIXTURE_NPM"; NODE_LABEL="fixture runtime"; }
install_cotal() {
  pkg="$INSTALL_DIR/lib/node_modules/cotal-ai"
  mkdir -p "$pkg" "$INSTALL_DIR/bin"
  cp "$FIXTURE_PACKAGE/package.json" "$pkg/package.json"
  cp -R "$FIXTURE_PACKAGE/dist" "$pkg/dist"
  ln -s "$FIXTURE_PACKAGE/node_modules" "$pkg/node_modules"
  chmod 755 "$pkg/dist/cotal.js"
  ln -s "$pkg/dist/cotal.js" "$INSTALL_DIR/bin/cotal"
  INSTALLED_VERSION="$FIXTURE_VERSION"
}
main --version "$FIXTURE_VERSION" --yes --no-setup --no-modify-path
`);
chmodSync(driver, 0o700);
const version = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;
const npm = resolveOnPath("npm");
if (!npm) throw new Error("fixture npm unavailable");
const env = { PATH: tools, HOME: home, USERPROFILE: home, SHELL: "/bin/sh", CI: "1", NO_COLOR: "1", DO_NOT_TRACK: "1", COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(sandbox, "state"), XDG_CACHE_HOME: join(sandbox, "cache"), COTAL_BIN_DIR: join(home, ".local/bin"), COTAL_SKIP_CONNECTOR_SEED: "1", FIXTURE_NODE: process.execPath, FIXTURE_NPM: npm, FIXTURE_PACKAGE: join(repo, "bin"), FIXTURE_VERSION: version };
const installed = spawnSync("/bin/sh", [driver, library], { env, encoding: "utf8", timeout: 90_000 });
writeFileSync(join(sandbox, "installer.log"), installed.stdout + installed.stderr);
if (installed.status !== 0) throw new Error(`owned installer failed: ${installed.stdout}${installed.stderr}`);
const launcher = join(env.COTAL_BIN_DIR, "cotal");
const installedEntry = realpathSync(join(env.XDG_DATA_HOME, "cotal/lib/node_modules/cotal-ai/dist/cotal.js"));
const installKey = createHash("sha256").update(installedEntry).digest("hex");
const completedSetupSeed = (config: string): boolean => {
  const canonical = join(config, "cotal");
  let connectorRoot = canonical;
  if (process.platform === "linux" || process.platform === "darwin") {
    // Installed POSIX executions retain seed state per installation and release, not canonically.
    const set = join(canonical, "installs", installKey, "sets", version);
    connectorRoot = join(set, "cotal");
    const selectionPath = join(set, "selection.json");
    if (!existsSync(selectionPath) || existsSync(join(canonical, "seed/stamp.json"))) return false;
    const selection = JSON.parse(readFileSync(selectionPath, "utf8"));
    if (selection.v !== 1 || selection.entry !== installedEntry || selection.version !== version || selection.root !== connectorRoot) return false;
  }
  const stamp = join(connectorRoot, "seed/stamp.json");
  if (!existsSync(stamp)) return false;
  const committed = JSON.parse(readFileSync(stamp, "utf8"));
  return committed.generation === version && committed.writtenBy === installedEntry;
};
mkdirSync(env.COTAL_HOME, { recursive: true, mode: 0o700 });
const anchor = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: xdg });
recordSmokeSandbox({ root: outside, cotalHome: env.COTAL_HOME, xdgConfigHome: xdg });
let sequence = 0;
const run = (args: string[], cwd = root, path = tools) => {
  const options = { cwd, env: { ...env, PATH: path }, encoding: "utf8" as const, timeout: 90_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(launcher, args, options);
  const value = { code: result.status, output: result.stdout + result.stderr, stdout: result.stdout };
  writeFileSync(join(sandbox, `${String(sequence++).padStart(2, "0")}.json`), JSON.stringify(value, null, 2));
  return value;
};
const psCommand = (text: string) => text.split("\n").find((line) => line.includes("See the agent roster"))?.trim().split(/\s{2,}See the agent roster/)[0];
const space = "command-display";
let attempted = false;
try {
  suite.check("fixture PATH has no cotal, pnpm, npm or node", ["cotal", "pnpm", "npm", "node"].every((name) => !resolveOnPath(name, env)));
  const customCache = join(sandbox, "custom-pnpm-cache"), empty = join(sandbox, "empty-project");
  mkdirSync(empty);
  // pnpm 11 links a dlx package from its global virtual store, so the entry names the store, and it
  // exports its user agent but no cache directory.
  const store11 = join(sandbox, "pnpm-store", "v11", "links", "@", "cotal-ai", version, "hash", "node_modules");
  for (const [name, modules, prefix, stored] of [
    ["default pnpm dlx", join(sandbox, "pnpm", "dlx", "hash", "run", "node_modules"), "pnpm dlx cotal-ai", undefined],
    ["custom-cache pnpm dlx", join(customCache, "dlx", "hash", "run", "node_modules"), "pnpm dlx cotal-ai", undefined],
    ["pnpm 11 dlx", join(sandbox, "pnpm", "dlx", "hash11", "run", "node_modules"), "pnpm dlx cotal-ai", store11],
    ["npx", join(sandbox, "_npx", "hash", "node_modules"), "npx cotal-ai", undefined],
  ] as const) {
    const pkg = join(stored ?? modules, "cotal-ai"), shims = join(modules, ".bin");
    mkdirSync(shims, { recursive: true });
    mkdirSync(pkg, { recursive: true });
    if (stored) symlinkSync(pkg, join(modules, "cotal-ai"));
    cpSync(join(repo, "bin", "dist"), join(pkg, "dist"), { recursive: true });
    cpSync(join(repo, "bin", "package.json"), join(pkg, "package.json"));
    symlinkSync(join(repo, "bin", "node_modules"), join(pkg, "node_modules"));
    const entry = join(pkg, "dist", "cotal.js");
    chmodSync(entry, 0o755);
    symlinkSync(entry, join(shims, "cotal"));
    const runner = stored ? { npm_config_user_agent: "pnpm/11.28.13 npm/? node/v24.22.0 linux x64" } : { npm_config_cache_dir: customCache };
    const runFromCache = (args: string[], path = `${shims}:${tools}`) => spawnSync(process.execPath, [entry, ...args], {
      cwd: empty, env: { ...env, PATH: path, ...runner }, encoding: "utf8", timeout: 60_000,
    });
    const card = runFromCache([]);
    suite.check(`${name} card keeps its runner for every command row`, card.status === 0 &&
      card.stdout.includes(`  ${prefix} setup `) && card.stdout.includes(`  ${prefix} status `) &&
      card.stdout.includes(`  ${prefix} help `) && !/^  cotal /m.test(card.stdout), card);
    const status = runFromCache(["status", "--plain"]);
    suite.check(`${name} status suggests its runner, not the transient shim`, status.status === 0 &&
      status.stdout.includes(`  ${prefix} login `) && status.stdout.includes(`  ${prefix} setup `) &&
      status.stdout.includes(`\`${prefix} up\` in a project`), status);
    const onPath = runFromCache([], `${shims}:${env.COTAL_BIN_DIR}:${tools}`);
    suite.check(`${name} card prefers a durable cotal when present`, onPath.status === 0 && onPath.stdout.includes("  cotal status "), onPath);
  }
  const prepared = run(["space", "create", space, "--root", root, "--json"]);
  if (prepared.code !== 0) throw new Error(`preparation failed: ${prepared.output}`);
  attempted = true;
  const up = run(["up", "--server", `nats://127.0.0.1:${await freePort()}`, "--detach", "--json"]);
  if (up.code !== 0) throw new Error(`owned stack failed: ${up.output}`);
  const metadata = run(["status", "--json"]);
  const json = JSON.parse(metadata.stdout) as { result?: { machine?: { install?: { kind: string } } } };
  suite.check("staged CLI reports installed provenance", json.result?.machine?.install?.kind === "installed", metadata);
  const status = run(["status", "--plain"]);
  suite.check("installed status never suggests pnpm cotal off PATH", status.code === 0 && !status.output.includes("pnpm cotal"), status);
  const command = psCommand(status.stdout);
  suite.check("status prints a roster next step", Boolean(command), status);
  if (command) {
    const followed = spawnSync("/bin/sh", ["-c", command], { cwd: outside, env, encoding: "utf8", timeout: 60_000 });
    writeFileSync(join(sandbox, "followed-command.json"), JSON.stringify({ code: followed.status, output: followed.stdout + followed.stderr }, null, 2));
    suite.check("the printed roster command runs unchanged from another folder", followed.status === 0 && !followed.stderr.includes("not found"), { code: followed.status, output: followed.stdout + followed.stderr });
  }
  const roster = run(["ps", "--plain"]);
  suite.check("off-PATH roster suggestions use the same runnable prefix", roster.code === 0 && !/^\s+cotal (?:spawn|setup)\b/m.test(roster.stdout) && !roster.stdout.includes("pnpm cotal"), roster);
  const onPath = run(["status", "--plain"], root, `${env.COTAL_BIN_DIR}:${tools}`);
  suite.check("on-PATH installed status keeps concise cotal commands", onPath.code === 0 && psCommand(onPath.stdout) === "cotal ps" && !onPath.stdout.includes("pnpm cotal"), onPath);
  const source = spawnSync(process.execPath, [join(repo, "bin/dist/cotal.js"), "status", "--plain"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  suite.check("off-PATH source checkout retains pnpm cotal guidance", source.status === 0 && source.stdout.includes("pnpm cotal"), { code: source.status, output: source.stdout + source.stderr });
  const setupCommand = status.stdout.split("\n").find((line) => /\s{2,}Set up an agent application(?: and a space)?$/.test(line))?.trim().split(/\s{2,}Set up an agent application(?: and a space)?$/)[0];
  suite.check("status prints a setup next step", Boolean(setupCommand), status);
  const seedEnv: NodeJS.ProcessEnv = { ...env };
  delete seedEnv.COTAL_SKIP_CONNECTOR_SEED;
  const setupConfig = join(sandbox, "setup-config"), controlConfig = join(sandbox, "setup-control-config");
  for (const dir of [setupConfig, controlConfig]) mkdirSync(dir, { mode: 0o700 });
  // Each setup reconciles every bundled connector serially.
  const seedTimeout = 300_000;
  if (setupCommand) {
    // Skills-only setup crosses the same automatic seed boundary without starting a space or app.
    const seeded = spawnSync("/bin/sh", ["-c", `${setupCommand} --skills`], { cwd: outside, env: { ...seedEnv, XDG_CONFIG_HOME: setupConfig }, encoding: "utf8", timeout: seedTimeout });
    const receipt = { code: seeded.status, output: seeded.stdout + seeded.stderr };
    writeFileSync(join(sandbox, "setup-from-hint.json"), JSON.stringify(receipt, null, 2));
    suite.check("printed setup prefix can seed with npm absent from the parent PATH", seeded.status === 0 && completedSetupSeed(setupConfig), receipt);
  }
  const control = spawnSync(launcher, ["setup", "--skills"], { cwd: outside, env: { ...seedEnv, XDG_CONFIG_HOME: controlConfig }, encoding: "utf8", timeout: seedTimeout });
  const controlReceipt = { code: control.status, output: control.stdout + control.stderr };
  writeFileSync(join(sandbox, "setup-launcher-control.json"), JSON.stringify(controlReceipt, null, 2));
  suite.check("fresh launcher control completes the same setup seed", control.status === 0 && completedSetupSeed(controlConfig), controlReceipt);
  const refresh = run(["up", "--plain"]);
  suite.check("controller up next steps keep the installed off-PATH prefix", refresh.code === 0 && !/^\s+cotal (?:spawn|down)\b/m.test(refresh.stdout) && refresh.stdout.includes("Launch your default agent"), refresh);
  const unconfirmed = run(["down"]);
  const controllerPrefix = unconfirmed.output.match(/`([^`\n]+) down --yes`/)?.[1];
  suite.check("controller down confirmation remedy keeps the installed prefix", unconfirmed.code === 1 && Boolean(controllerPrefix) && controllerPrefix !== "cotal", unconfirmed);
  const controllerReap = run(["down", "--with-agents"]);
  suite.check("controller down keeps the installed prefix and --with-agents in both confirmation commands", controllerReap.code === 1 && Boolean(controllerPrefix) &&
    ["--yes", "--dry-run"].every((flag) => controllerReap.output.includes(`\`${controllerPrefix} down --with-agents ${flag}\``)), controllerReap);

  const npxEntry = join(sandbox, "_npx", "fixture", "cotal.js");
  mkdirSync(join(sandbox, "_npx", "fixture"), { recursive: true });
  symlinkSync(join(env.XDG_DATA_HOME, "cotal/lib/node_modules/cotal-ai/dist/cotal.js"), npxEntry);
  for (const npx of [false, true]) {
    const project = join(sandbox, npx ? "npx-project" : "installed-project");
    mkdirSync(project, { mode: 0o700 });
    const own = recordSmokeSandbox({ root: project, cotalHome: env.COTAL_HOME, xdgConfigHome: xdg });
    const command = (args: string[]) => {
      const options = { cwd: project, env, encoding: "utf8" as const, timeout: 120_000 };
      assertSmokeSandboxDown(own, args, options);
      return spawnSync(npx ? process.execPath : launcher, npx ? [npxEntry, ...args] : args, options);
    };
    try {
      const started = command(["up", "--server", `nats://127.0.0.1:${await freePort()}`]);
      const output = started.stdout + started.stderr;
      const prefix = npx ? "npx cotal-ai" : output.match(/stop with: `(.+) down`/)?.[1];
      suite.check("legacy up summary and Next use one runnable invocation prefix", started.status === 0 && Boolean(prefix) && output.includes(`stop with: \`${prefix} down\``) && output.includes(`${prefix} spawn --space`) && !/^\s+cotal (?:spawn|down)\b/m.test(output), output);
      const refused = command(["down"]);
      suite.check("legacy down confirmation remedy preserves the invocation", refused.status === 1 && (refused.stdout + refused.stderr).includes(`\`${prefix} down --yes\``), refused.stderr);
      const reap = command(["down", "--with-agents"]);
      suite.check("legacy down keeps the invocation and --with-agents in both confirmation commands", reap.status === 1 && Boolean(prefix) &&
        ["--yes", "--dry-run"].every((flag) => (reap.stdout + reap.stderr).includes(`\`${prefix} down --with-agents ${flag}\``)), reap.stderr);
      // npx's command prefix is checked above without contacting a package registry. The installed
      // prefix is followed unchanged, including its shell quoting and pinned runtime environment.
      if (!npx && prefix) {
        const options = { cwd: project, env, encoding: "utf8" as const, timeout: 120_000 };
        assertSmokeSandboxDown(own, ["down", "--yes"], options);
        const stopped = spawnSync("/bin/sh", ["-c", `${prefix} down --yes`], options);
        suite.check("the printed off-PATH stop command runs unchanged and suggests the same up", stopped.status === 0 && stopped.stdout.includes(`${prefix} up`), stopped.stdout + stopped.stderr);
      } else {
        const stopped = command(["down", "--yes"]);
        suite.check("npx down Next preserves npx cotal-ai", stopped.status === 0 && stopped.stdout.includes("npx cotal-ai up"), stopped.stdout + stopped.stderr);
      }
    } finally {
      const stopped = command(["down", "--yes"]);
      suite.check("the invocation-display legacy stack stops cleanly", stopped.status === 0, stopped.stdout + stopped.stderr);
    }
  }
} finally {
  if (attempted) {
    const down = run(["down", "--yes", "--json"]);
    const inventory = run(["service", "--space", space, "--json"]);
    const rows = (JSON.parse(inventory.stdout) as { result?: { instances?: { observedProcess: string }[] } }).result?.instances;
    suite.check("owned installed-layout stack is stopped", down.code === 0 && inventory.code === 0 && Boolean(rows?.length) && rows!.every((row) => ["gone", "previous-boot"].includes(row.observedProcess)), down);
  }
  console.log(`Retained installed command fixture: ${sandbox}`);
}
suite.finish();
process.exit(process.exitCode ?? 0);

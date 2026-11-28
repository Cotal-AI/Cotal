/** Real npm removal and failed seed cleanup must preserve copied file-based extensions.
 * Exercises both paths offline with an empty npm cache, using the built CLI and Claude connector
 * in private prefixes. Never starts a connector or broker.
 * Build the workspace first. Run: pnpm smoke:ext-install-copies
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";

function recordNpmSpawns(dir: string): { record: string; env: NodeJS.ProcessEnv } {
  const record = join(dir, "npm-spawn.jsonl");
  const preload = join(dir, "record-npm-spawn.cjs");
  writeFileSync(preload, `const cp = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const spawn = cp.spawn;
cp.spawn = (file, args, options) => {
  const command = [file, ...(Array.isArray(args) ? args : [])].join(" ");
  if (/npm/i.test(command) && /\\binstall\\b/.test(command) && command.includes("example-extension")) {
    appendFileSync(${JSON.stringify(record)}, JSON.stringify({ windowsHide: options?.windowsHide }) + "\\n");
  }
  return spawn(file, args, options);
};
syncBuiltinESMExports();
`);
  return { record, env: { NODE_OPTIONS: `--require="${preload}"` } };
}

function checkMissingLocalTarball(
  dir: string,
  prefix: string,
  cli: (args: string[], extra?: NodeJS.ProcessEnv) => { status: number | null; stderr: string },
): void {
  const source = join(dir, "bad-dependency");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "cotal-bad-dependency-demo", version: "1.0.0", type: "module", main: "./greeting.mjs",
    peerDependencies: { "@cotal-ai/core": "*" }, dependencies: { "missing-library": "file:./missing-library.tgz" },
  }));
  writeFileSync(join(source, "greeting.mjs"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "command", name: "demo-bad-dependency", summary: "Print a greeting", run() {} });
`);
  const files = ["package.json", "package-lock.json", "extensions.json"].map(name => join(prefix, name));
  const before = files.map(file => readFileSync(file));
  const refused = cli(["ext", "add", "./bad-dependency"], { npm_config_offline: "true" });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /cotal-bad-dependency-demo: it could not open the tarball for missing-library/);
  assert.match(refused.stderr, /`npm pack --dry-run \.\/bad-dependency`/);
  assert.match(refused.stderr, /absolute path of an existing archive/);
  assert.match(refused.stderr, /`(?:pnpm )?cotal ext add \.\/bad-dependency`/);
  assert.match(refused.stderr, /npm can install from a registry/);
  assert.doesNotMatch(refused.stderr, /\.extensions\.stage-/);
  assert.deepEqual(files.map(file => readFileSync(file)), before);
}

function main(): void {
  const repo = resolve(import.meta.dirname, "../../..");
  const binary = join(repo, "bin", "dist", "cotal.js");
  const source = join(repo, "extensions", "connector-claude-code");
  const keptName = "@cotal-ai/connector-claude-code";
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const sourceEntry = join(source, "dist", "index.js");
  const sourceDigest = digest(sourceEntry);
  const hostCore = realpathSync(join(repo, "packages", "core"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-ext-copies-")));
  let passed = 0, failed = 0;
  const check = (name: string, value: boolean): void => {
    if (value) passed++; else failed++;
    console.log(`  ${value ? "✓" : "✗"} ${name}`);
  };
  // A private home, config prefix and npm configuration under `dir`, and the built CLI run inside it.
  const sandbox = (dir: string) => {
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    mkdirSync(join(dir, ".cotal"), { recursive: true });
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    for (const file of ["user.npmrc", "global.npmrc"]) writeFileSync(join(dir, file), "");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"),
      TMPDIR: dir, TMP: dir, TEMP: dir, DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
      npm_config_cache: join(dir, "npm-cache"), npm_config_userconfig: join(dir, "user.npmrc"),
      npm_config_globalconfig: join(dir, "global.npmrc"), npm_config_update_notifier: "false",
    };
    const child = (args: string[], extra?: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, args, { cwd: dir, env: { ...env, ...extra }, encoding: "utf8", timeout: 180_000 });
    const offline = { npm_config_cache: join(dir, "empty-npm-cache"), npm_config_offline: "true" };
    return { prefix: join(xdg, "cotal", "extensions"), env, child, offline, cli: (args: string[], extra?: NodeJS.ProcessEnv) => child([binary, ...args], extra) };
  };
  try {
    if (process.platform === "linux" || process.platform === "darwin") {
      const dir = join(root, "installed-root");
      const { child, env } = sandbox(dir);
      const pkg = join(dir, "prefix/lib/node_modules/cotal-ai");
      mkdirSync(pkg, { recursive: true });
      cpSync(join(repo, "bin/package.json"), join(pkg, "package.json"));
      cpSync(join(repo, "bin/dist"), join(pkg, "dist"), { recursive: true });
      symlinkSync(join(repo, "bin/node_modules"), join(pkg, "node_modules"));
      const entry = join(pkg, "dist/cotal.js");
      const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version as string;
      const expected = join(env.XDG_CONFIG_HOME!, "cotal/installs", createHash("sha256").update(entry).digest("hex"), "sets", version, "cotal/extensions");
      const before = child([entry, "ext", "root"]);
      const listed = child([entry, "ext", "--json"]);
      check("installed root is the retained prefix before initial seeding", before.status === 0 && before.stdout.trim() === expected && listed.status === 0 && JSON.parse(listed.stdout).result.root === expected);
      check("reading the fresh installed root creates no prefix", !existsSync(expected));
      const added = child([entry, "ext", "add", join(repo, "implementations", "acp")]);
      assert.equal(added.status, 0, added.stdout + added.stderr);
      const helpBefore = child([entry, "acp", "--help"]);
      assert.equal(helpBefore.status, 0, helpBefore.stdout + helpBefore.stderr);
      const seeded = child([entry, "ext", "seed"]);
      assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
      const after = child([entry, "ext", "root"]);
      check("initial seeding keeps the advertised installed root", after.status === 0 && after.stdout === before.stdout && existsSync(expected));
      const helpAfter = child([entry, "acp", "--help"]);
      check("initial seeding keeps the installed ACP command", helpAfter.status === 0 && helpAfter.stdout === helpBefore.stdout);
      const listAfter = child([entry, "ext", "list", "--json"]);
      const items = listAfter.status === 0 ? JSON.parse(listAfter.stdout).result.items as { pkg: string; seeded: boolean }[] : [];
      check("initial seeding keeps ACP alongside the seven built-ins", items.some(item => item.pkg === "@cotal-ai/acp" && !item.seeded) && items.filter(item => item.seeded).length === 7);
    }
    {
      const dir = join(root, "remove");
      const { prefix, cli, offline } = sandbox(dir);
      const invalidAdd = cli(["ext", "add", source, "unexpected-extra-argument"]);
      check("remove: surplus add operand refuses with usage", invalidAdd.status === 1 && invalidAdd.stderr.includes("ext add <npm-package>"));
      check("remove: invalid add leaves the prefix absent", !existsSync(prefix));
      const added = cli(["ext", "add", source]);
      assert.equal(added.status, 0, `stock connector install failed: ${added.stderr.slice(-800)}`);
      const kept = join(prefix, "node_modules", keptName);
      check("remove: built-in starts as a copy", !lstatSync(kept).isSymbolicLink() && realpathSync(kept) !== realpathSync(source));
      const manifestBefore = readFileSync(join(prefix, "extensions.json"), "utf8");
      const invalidRemove = cli(["ext", "remove", keptName, "unexpected-extra-argument"]);
      check("remove: surplus remove operand refuses with usage", invalidRemove.status === 1 && invalidRemove.stderr.includes("ext remove <name>"));
      check("remove: invalid remove keeps the manifest and installed package", readFileSync(join(prefix, "extensions.json"), "utf8") === manifestBefore && existsSync(join(kept, "dist", "index.js")));
      const before = digest(join(kept, "dist", "index.js"));
      check("remove: installed bytes match built source", before === sourceDigest);
      const siblingName = "@_cotal-test/_copy-remove";
      const sibling = join(dir, "sibling");
      mkdirSync(sibling);
      writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: siblingName, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
      writeFileSync(join(sibling, "index.js"), `import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "copy-sibling", summary: "fixture", run: async () => {} });\n`);
      const installed = cli(["ext", "add", sibling]);
      assert.equal(installed.status, 0, installed.stderr.slice(-800));
      check("remove: adding a sibling preserves the built-in copy", !lstatSync(kept).isSymbolicLink());
      const removed = cli(["ext", "remove", siblingName], offline);
      if (removed.status !== 0) console.error(removed.stderr.trim());
      check("remove: a package with leading underscores in its scope and name is removed offline with an empty npm cache", removed.status === 0);
      const dotted = "@.cotal-test/copy-remove";
      const meta = join(sibling, "package.json");
      writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, "utf8")), name: dotted }));
      assert.equal(cli(["ext", "add", sibling]).status, 0);
      const listed = JSON.parse(cli(["ext", "list", "--json"]).stdout).result.items as { pkg: string }[];
      const item = listed.find(row => row.pkg === dotted);
      assert.ok(item, "the dotted scope is listed under its installed name");
      assert.equal(cli(["ext", "remove", item.pkg], offline).status, 0);
      assert.ok(!existsSync(join(prefix, "node_modules", dotted)));
      check("remove: unrelated built-in remains a copy", !lstatSync(kept).isSymbolicLink() && realpathSync(kept) !== realpathSync(source));
      check("remove: unrelated built-in bytes are unchanged", digest(join(kept, "dist", "index.js")) === before);
      check("remove: operated package is absent", !existsSync(join(prefix, "node_modules", siblingName)));
      const manifest = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")) as { extensions: { pkg: string }[] };
      check("remove: manifest keeps only the built-in", manifest.extensions.length === 1 && manifest.extensions[0]?.pkg === keptName);
      check("remove: source package remains unchanged", digest(sourceEntry) === sourceDigest);
      check("remove: retained core peer matches the running CLI", realpathSync(join(kept, "node_modules", "@cotal-ai", "core")) === hostCore);
    }
    // A fresh seed child installs in place. The renamed Claude bundle already owns the same
    // providers, so the real seed refuses after npm installs the candidate and must remove it.
    {
      const dir = join(root, "seed-refusal");
      const { prefix, cli, offline } = sandbox(dir);
      const alternateName = "cotal-ext-copy-claude";
      const alternate = join(dir, alternateName);
      mkdirSync(alternate);
      writeFileSync(join(alternate, "package.json"), JSON.stringify({ name: alternateName, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
      cpSync(sourceEntry, join(alternate, "index.js"));
      const added = cli(["ext", "add", alternate]);
      assert.equal(added.status, 0, added.stderr);
      const manifestPath = join(prefix, "extensions.json");
      const manifestBefore = readFileSync(manifestPath, "utf8");
      const refused = cli(["ext", "seed", "--force"], { ...offline, COTAL_ALLOW_CHECKOUT_SEED: "1" });
      const collision = refused.status === 1 && refused.stderr.includes('failed to seed connector "claude"')
        && refused.stderr.includes(`already provided by installed extension ${alternateName}@1.0.0`);
      if (!collision) console.error(refused.stdout + refused.stderr);
      check("seed: the offline seed child refuses on the installed provider collision", collision);
      const modules = join(prefix, "node_modules");
      check("seed: the refused candidate is removed from disk", !existsSync(join(modules, keptName)));
      type Dependencies = Record<string, string>;
      const pkg = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8")) as { dependencies: Dependencies };
      const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")) as { packages: Record<string, { dependencies?: Dependencies }> };
      check("seed: npm metadata records only the survivor as a direct dependency",
        Object.keys(pkg.dependencies).join(",") === alternateName && Object.keys(lock.packages[""]?.dependencies ?? {}).join(",") === alternateName
        && !Object.hasOwn(lock.packages, `node_modules/${keptName}`));
      check("seed: the extension manifest is unchanged", readFileSync(manifestPath, "utf8") === manifestBefore);
      const kept = join(modules, alternateName);
      check("seed: the installed connector stays a copy with unchanged bytes",
        !lstatSync(kept).isSymbolicLink() && digest(join(kept, "index.js")) === sourceDigest);
      check("seed: the surviving core peer matches the running CLI", realpathSync(join(kept, "node_modules", "@cotal-ai", "core")) === hostCore);
    }
    for (const [form, exports] of [
      ["nested", { ".": { import: "./greet.mjs" } }],
      ["shorthand", { import: "./greet.mjs" }],
      ["node-conditional", { ".": { node: { import: "./greet.mjs" }, default: "./fallback.mjs" } }],
    ] as const) {
      const dir = join(root, `exports-entry-${form}`);
      const { prefix, cli } = sandbox(dir);
      const source = join(dir, "example-extension");
      mkdirSync(source);
      const name = "cotal-example-greet";
      const meta = { name, version: "1.0.0", type: "module", exports, peerDependencies: { "@cotal-ai/core": "*" } };
      writeFileSync(join(source, "package.json"), JSON.stringify(meta));
      writeFileSync(join(source, "greet.mjs"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "command", name: "greet-example", summary: "Print a greeting", run() { console.log("Hello from the extension"); } });
`);
      if (form === "node-conditional") {
        writeFileSync(join(source, "fallback.mjs"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "command", name: "greet-example", summary: "Print a fallback greeting", run() { console.log("Hello from the fallback"); } });
registry.register({ kind: "command", name: "greet-fallback", summary: "Fallback provider", run() {} });
`);
      }
      const { record, env } = recordNpmSpawns(dir);
      const added = cli(["ext", "add", "./example-extension"], env);
      assert.equal(added.status, 0, `${form} exports-only ext add failed: ${added.stderr.slice(-800)}`);
      if (form === "node-conditional") {
        check("ext add records the Node import providers instead of the default providers",
          added.stdout.includes("command:greet-example") && !added.stdout.includes("command:greet-fallback"));
      }
      check(`ext add passes windowsHide to the actual npm install for the ${form} root export`, existsSync(record) && readFileSync(record, "utf8").trim().split("\n").every(line => JSON.parse(line).windowsHide === true));
      const greeted = cli(["greet-example"]);
      check(`a fresh CLI loads the installed command through its ${form} root export`, greeted.status === 0 && greeted.stdout.trim() === "Hello from the extension");

      if (form !== "nested") continue;
      checkMissingLocalTarball(dir, prefix, cli);
      const manifestPath = join(prefix, "extensions.json");
      const before = readFileSync(manifestPath, "utf8");
      const noNpm = join(dir, "empty-path");
      mkdirSync(noNpm);
      const unavailable = cli(["ext", "add", "./example-extension"], { PATH: noNpm });
      assert.equal(unavailable.status, 2, unavailable.stderr);
      assert.match(unavailable.stderr, /DEPENDENCY_UNAVAILABLE/);
      assert.match(unavailable.stderr, /npm --version/);
      assert.equal(readFileSync(manifestPath, "utf8"), before);
      assert.equal(cli(["greet-example"]).stdout.trim(), "Hello from the extension");
      writeFileSync(join(source, "README.md"), "# Greeting extension\n");
      writeFileSync(join(source, "package.json"), JSON.stringify({ ...meta, version: "2.0.0", exports: "./greet.mjs", files: ["README.md"] }));
      const omitted = cli(["ext", "add", "./example-extension"]);
      check("ext add explains when npm omits the local entry", omitted.status === 1 &&
        omitted.stderr.includes(`the installed npm package ${name} is missing its entry \`./greet.mjs\``) &&
        omitted.stderr.includes("`npm pack --dry-run ./example-extension`") &&
        omitted.stderr.includes("include the entry in `files` or generate it") &&
        ["cotal", "pnpm cotal"].some((cmd) => omitted.stderr.includes(`\`${cmd} ext add ./example-extension\``)) &&
        !omitted.stderr.includes(".extensions.stage-") && existsSync(join(source, "greet.mjs")));
      check("a package missing its entry leaves the previous manifest intact", readFileSync(manifestPath, "utf8") === before);

      writeFileSync(join(source, "package.json"), JSON.stringify({ ...meta, version: "2.0.0", main: "./greet.mjs", exports: { ".": "./missing.mjs" } }));
      const refused = cli(["ext", "add", "./example-extension"]);
      check("ext add refuses a missing root export even when main exists", refused.status === 1 && refused.stderr.includes("missing.mjs"));
      check("the refusal leaves the previous installation intact", readFileSync(manifestPath, "utf8") === before && cli(["greet-example"]).stdout.trim() === "Hello from the extension");
    }
    // Two extensions that depend on one package with a bin. The second add's stage carries the bin
    // link the prefix already holds, so its promotion copies a link onto an existing one (#5669).
    {
      const dir = join(root, "shared-bin");
      const { prefix, cli } = sandbox(dir);
      const lib = join(dir, "shared-bin-lib");
      mkdirSync(join(lib, "bin"), { recursive: true });
      writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "shared-bin-lib", version: "1.0.0", bin: { "shared-bin": "bin/shared-bin.js" } }));
      writeFileSync(join(lib, "bin", "shared-bin.js"), "#!/usr/bin/env node\n");
      const extension = (name: string): string => {
        const pkg = join(dir, name);
        mkdirSync(pkg);
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" }, dependencies: { "shared-bin-lib": `file:${lib}` } }));
        writeFileSync(join(pkg, "index.js"), `import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "${name}", summary: "fixture", run: async () => {} });\n`);
        return pkg;
      };
      const link = join(prefix, "node_modules", ".bin", "shared-bin");
      const symlinked = (): boolean => process.platform === "win32" || lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true;
      const first = cli(["ext", "add", extension("cotal-ext-bin-first")]);
      check("shared bin: the first add leaves the bin link in the prefix", first.status === 0 && symlinked());
      const second = cli(["ext", "add", extension("cotal-ext-bin-second")]);
      if (second.status !== 0) console.log(second.stderr.slice(-800));
      check("shared bin: an add whose stage carries a link the prefix holds commits", second.status === 0);
      const manifest = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")) as { extensions: { pkg: string }[] };
      check("shared bin: both extensions are recorded and installed",
        manifest.extensions.map((e) => e.pkg).sort().join(",") === "cotal-ext-bin-first,cotal-ext-bin-second" &&
          existsSync(join(prefix, "node_modules", "cotal-ext-bin-first")) && existsSync(join(prefix, "node_modules", "cotal-ext-bin-second")));
      check("shared bin: the bin link still reaches the shared package", symlinked() && existsSync(link));
    }
    // Add uses one candidate metadata snapshot too, even when the entry changes its own file.
    for (const damage of [false, true]) {
      const dir = join(root, damage ? "metadata-changed" : "metadata-control");
      const { prefix, cli } = sandbox(dir);
      const name = damage ? "cotal-ext-metadata-changed" : "cotal-ext-metadata-control";
      const source = join(dir, name);
      mkdirSync(source);
      writeFileSync(join(source, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*", "@cotal-ai/workspace": ">=99.0.0" } }));
      writeFileSync(join(source, "index.js"), `import { writeFileSync } from "node:fs";\nimport { registry } from "@cotal-ai/core";\nvoid registry;\n${damage ? 'writeFileSync(new URL("./package.json", import.meta.url), "{corrupt");' : ''}\nawait import("./missing-export.mjs");\n`);
      writeFileSync(join(source, "missing-export.mjs"), 'import { notAnExportOfWorkspace } from "@cotal-ai/workspace";\nvoid notAnExportOfWorkspace;\n');
      const added = cli(["ext", "add", source]);
      check(`${name}: missing-export add refuses`, added.status === 1 && added.stderr.includes("notAnExportOfWorkspace"));
      check(`${name}: diagnosis keeps the validated peer floor`, added.stderr.includes("The installed @cotal-ai/workspace is BEHIND") && added.stderr.includes(">=99.0.0") && !added.stderr.includes("is corrupt or unreadable"));
      check(`${name}: failed add leaves no installed candidate`, !existsSync(join(prefix, "node_modules", name)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(passed + failed, process.platform === "linux" || process.platform === "darwin" ? 46 : 41, "all expected copy/rollback checks ran");
  console.log(`ext-install-copies smoke: ${passed} passed, ${failed} failed`);
  emitSentinel({ passed, failed });
  process.exit(failed ? 1 : 0);
}

main();

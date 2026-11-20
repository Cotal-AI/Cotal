/** Real npm removal and failed-add cleanup must preserve copied file-based extensions.
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
import { fileURLToPath } from "node:url";
import { emitSentinel } from "@cotal-ai/smoke-kit";

// The pinned-name helper is used by setup/update. A new failed candidate takes its
// npm-remove restore arm, rather than the staged ordinary-add or existing-package snapshot arm.
if (process.argv[2] === "--restore") {
  const { addExtension } = await import("../dist/commands/ext.js");
  await addExtension(process.argv[3]!, process.argv[4]!);
} else {
  const repo = resolve(import.meta.dirname, "../../..");
  const binary = join(repo, "bin", "dist", "cotal.js");
  const tsx = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
  const source = join(repo, "extensions", "connector-claude-code");
  const keptName = "@cotal-ai/connector-claude-code";
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const sourceDigest = digest(join(source, "dist", "index.js"));
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
      HOME: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"),
      TMPDIR: dir, TMP: dir, TEMP: dir, DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
      npm_config_cache: join(dir, "npm-cache"), npm_config_userconfig: join(dir, "user.npmrc"),
      npm_config_globalconfig: join(dir, "global.npmrc"), npm_config_update_notifier: "false",
    };
    const child = (args: string[]) => spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8", timeout: 180_000 });
    return { prefix: join(xdg, "cotal", "extensions"), env, child, cli: (args: string[]) => child([binary, ...args]) };
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
      const seeded = child([entry, "ext", "seed"]);
      assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
      const after = child([entry, "ext", "root"]);
      check("initial seeding keeps the advertised installed root", after.status === 0 && after.stdout === before.stdout && existsSync(expected));
    }
    for (const arm of ["remove", "restore"] as const) {
      const dir = join(root, arm);
      const { prefix, env, child, cli } = sandbox(dir);
      const invalidAdd = cli(["ext", "add", source, "unexpected-extra-argument"]);
      check(`${arm}: surplus add operand refuses with usage`, invalidAdd.status === 1 && invalidAdd.stderr.includes("ext add <npm-package>"));
      check(`${arm}: invalid add leaves the prefix absent`, !existsSync(prefix));
      const added = cli(["ext", "add", source]);
      assert.equal(added.status, 0, `${arm}: stock connector install failed: ${added.stderr.slice(-800)}`);
      const kept = join(prefix, "node_modules", "@cotal-ai", "connector-claude-code");
      check(`${arm}: built-in starts as a copy`, !lstatSync(kept).isSymbolicLink() && realpathSync(kept) !== realpathSync(source));
      const manifestBefore = readFileSync(join(prefix, "extensions.json"), "utf8");
      const invalidRemove = cli(["ext", "remove", keptName, "unexpected-extra-argument"]);
      check(`${arm}: surplus remove operand refuses with usage`, invalidRemove.status === 1 && invalidRemove.stderr.includes("ext remove <name>"));
      check(`${arm}: invalid remove keeps the manifest and installed package`, readFileSync(join(prefix, "extensions.json"), "utf8") === manifestBefore && existsSync(join(kept, "dist", "index.js")));
      const before = digest(join(kept, "dist", "index.js"));
      check(`${arm}: installed bytes match built source`, before === sourceDigest);
      const siblingName = `cotal-ext-copy-${arm}`;
      const sibling = join(dir, siblingName);
      mkdirSync(sibling);
      writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: siblingName, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
      writeFileSync(join(sibling, "index.js"), arm === "remove"
        ? `import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "copy-sibling", summary: "fixture", run: async () => {} });\n`
        : "export {};\n");
      if (arm === "remove") {
        const installed = cli(["ext", "add", sibling]);
        assert.equal(installed.status, 0, installed.stderr.slice(-800));
        check("remove: adding a sibling preserves the built-in copy", !lstatSync(kept).isSymbolicLink());
      }
      env.npm_config_cache = join(dir, "empty-npm-cache");
      env.npm_config_offline = "true";
      if (arm === "remove") {
        const removed = cli(["ext", "remove", siblingName]);
        if (removed.status !== 0) console.error(removed.stderr.trim());
        check("remove: the real command succeeds offline with an empty npm cache", removed.status === 0);
      } else {
        const refused = child([tsx, fileURLToPath(import.meta.url), "--restore", sibling, siblingName]);
        check("restore: failure reaches the no-registration refusal", refused.status === 1 && /registered no extensions/.test(refused.stderr));
      }
      check(`${arm}: unrelated built-in remains a copy`, !lstatSync(kept).isSymbolicLink() && realpathSync(kept) !== realpathSync(source));
      check(`${arm}: unrelated built-in bytes are unchanged`, digest(join(kept, "dist", "index.js")) === before);
      check(`${arm}: operated package is absent`, !existsSync(join(prefix, "node_modules", siblingName)));
      const manifest = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")) as { extensions: { pkg: string }[] };
      check(`${arm}: manifest keeps only the built-in`, manifest.extensions.length === 1 && manifest.extensions[0]?.pkg === keptName);
      check(`${arm}: source package remains unchanged`, digest(join(source, "dist", "index.js")) === sourceDigest);
      check(`${arm}: retained core peer matches the running CLI`, realpathSync(join(kept, "node_modules", "@cotal-ai", "core")) === realpathSync(join(repo, "packages", "core")));
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
      writeFileSync(join(source, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": ">=99.0.0" } }));
      writeFileSync(join(source, "index.js"), `import { writeFileSync } from "node:fs";\nimport { registry } from "@cotal-ai/core";\nvoid registry;\n${damage ? 'writeFileSync(new URL("./package.json", import.meta.url), "{corrupt");' : ''}\nawait import("./missing-export.mjs");\n`);
      writeFileSync(join(source, "missing-export.mjs"), 'import { notAnExportOfCore } from "@cotal-ai/core";\nvoid notAnExportOfCore;\n');
      const added = cli(["ext", "add", source]);
      check(`${name}: missing-export add refuses`, added.status === 1 && added.stderr.includes("notAnExportOfCore"));
      check(`${name}: diagnosis keeps the validated peer floor`, added.stderr.includes("The installed @cotal-ai/core is BEHIND") && added.stderr.includes(">=99.0.0") && !added.stderr.includes("is corrupt or unreadable"));
      check(`${name}: failed add leaves no installed candidate`, !existsSync(join(prefix, "node_modules", name)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(passed + failed, process.platform === "linux" || process.platform === "darwin" ? 40 : 37, "all expected copy/rollback checks ran");
  console.log(`ext-install-copies smoke: ${passed} passed, ${failed} failed`);
  emitSentinel({ passed, failed });
  process.exit(failed ? 1 : 0);
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { executionBinding, executionLaunchBinding, executionDescriptorPath, executionStore, selectExecutionProgram } from "../cotal.js";
import { describeExecutionGeneration, retainExecutionGeneration, writeExecutionDescriptor } from "../execution-store.js";

// Fixtures get the modes a package manager gives its files under the usual umask; the checks that
// need a umask of 0002 set it themselves.
process.umask(0o022);
const repo = join(import.meta.dirname, "../..");
const { engines, scripts } = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8"));
const postinstallScript = scripts.postinstall.replace(/^node /, "");
const scratch = mkdtempSync(join(tmpdir(), "execution-generation-"));
const root = join(scratch, "prefix/lib/node_modules/cotal-ai"), source = join(scratch, "source/cotal-ai");
let checks = 0;
const check = (label: string, run: () => void): void => { run(); checks++; console.log(`✓ ${label}`); };
const packageAt = (directory: string, version: string, message: string): void => {
  mkdirSync(join(directory, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "cotal-ai", version, type: "module", bin: { cotal: "./dist/cotal.js" }, engines }));
  cpSync(join(repo, "bin/dist/cotal.js"), join(directory, "dist/cotal.js"));
  chmodSync(join(directory, "dist/cotal.js"), 0o644);
  writeFileSync(join(directory, "dist/cotal-program.js"), `console.log(${JSON.stringify(message)});`);
};
const run = () => spawnSync(process.execPath, [join(root, "dist/cotal.js"), "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
try {
  packageAt(root, "0.1.0", "initial generation");
  packageAt(source, "0.2.0", "retained generation selected");
  check("bootstrap imports only node built-ins and one selected program", () => {
    for (const file of [join(repo, "bin/cotal.ts"), join(repo, "bin/dist/cotal.js")]) {
      const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      let handoffs = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) assert.ok(ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("node:"));
        if (ts.isExportDeclaration(node)) assert.equal(node.moduleSpecifier, undefined);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          assert.equal(node.arguments.length, 1);
          assert.equal(node.arguments[0]!.getText(tree), "pathToFileURL(selected.entry).href");
          handoffs++;
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
      assert.equal(handoffs, 1);
    }
  });
  check("bootstrap and npm postinstall avoid post-Node-12 syntax and named built-in exports", () => {
    const postNode12FsExports = new Set(["cp", "cpSync", "glob", "globSync", "openAsBlob", "opendir", "opendirSync", "rm", "rmSync", "statfs", "statfsSync"]);
    const disallowedOperators = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ]);
    const postinstall = join(repo, "bin", postinstallScript);
    for (const file of [join(repo, "bin/cotal.ts"), join(repo, "bin/dist/cotal.js"), postinstall]) {
      const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      if (file === postinstall) assert.equal(ts.isExternalModule(tree), false, `${file} must not use ES module syntax`);
      const visit = (node: ts.Node): void => {
        assert.equal(ts.isOptionalChain(node), false, `${file} contains optional chaining: ${node.getText(tree)}`);
        assert.equal(ts.isAwaitExpression(node), false, `${file} contains await: ${node.getText(tree)}`);
        assert.equal(ts.isPrivateIdentifier(node), false, `${file} contains private identifier: ${node.getText(tree)}`);
        assert.equal(ts.isBigIntLiteral(node), false, `${file} contains bigint literal: ${node.getText(tree)}`);
        if (ts.isNumericLiteral(node)) assert.equal(node.getText(tree).includes("_"), false, `${file} contains numeric separator: ${node.getText(tree)}`);
        if (ts.isBinaryExpression(node)) assert.equal(disallowedOperators.has(node.operatorToken.kind), false, `${file} contains post-ES2019 operator: ${node.getText(tree)}`);
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "node:fs") {
          const named = node.importClause?.namedBindings;
          if (named && ts.isNamedImports(named)) {
            for (const element of named.elements) {
              const exported = (element.propertyName ?? element.name).text;
              assert.equal(postNode12FsExports.has(exported), false, `${file} statically imports post-Node-12 fs export ${exported}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
  });
  check("unsupported Node runtimes receive only the floor diagnostic before V8 flags or program load", () => {
    const preload = join(scratch, "preload-old-node.mjs");
    writeFileSync(preload, [
      'import { syncBuiltinESMExports } from "node:module";',
      'import v8 from "node:v8";',
      "const fake = process.env.TEST_FAKE_NODE_VERSION;",
      "if (fake) {",
      '  Object.defineProperty(process.versions, "node", { value: fake, configurable: true });',
      '  Object.defineProperty(process, "version", { value: `v${fake}`, configurable: true });',
      "}",
      "const realSetFlags = v8.setFlagsFromString.bind(v8);",
      'const known = (process.env.TEST_V8_KNOWN_FLAGS ?? "--no-maglev,--no-concurrent-sparkplug").split(",").filter(Boolean);',
      "v8.setFlagsFromString = (flags) => {",
      '  if (process.env.TEST_TRACE_V8_FLAGS === "1") process.stderr.write(`V8_FLAG:${flags}\\n`);',
      "  if (!known.includes(flags)) {",
      '    process.stderr.write(`Error: unrecognized flag ${flags}\\nTry --help for options\\n`);',
      "    return;",
      "  }",
      "  realSetFlags(flags);",
      "};",
      "syncBuiltinESMExports();",
    ].join("\n"));
    const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
    const probe = (entry: string, args: string[], extra: Record<string, string>) =>
      spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, entry, ...args], {
        env: { ...ambient, COTAL_HOME: join(scratch, "old-node-home"), XDG_CONFIG_HOME: join(scratch, "old-node-cfg"), ...extra },
        cwd: scratch,
        encoding: "utf8",
        timeout: 15_000,
      });
    const postinstall = join(repo, "bin", postinstallScript);
    const refusedInstall = probe(postinstall, [], { TEST_FAKE_NODE_VERSION: "12.22.9" });
    assert.equal(refusedInstall.status, 1, refusedInstall.stderr);
    assert.equal(refusedInstall.stdout, "");
    assert.equal(refusedInstall.stderr.trim().split("\n").length, 1);
    assert.ok(refusedInstall.stderr.includes(`requires Node.js ${engines.node.slice(2).trim()} or later, but npm is using v12.22.9`), refusedInstall.stderr);
    assert.match(refusedInstall.stderr, /npm install -g cotal-ai/);
    assert.match(refusedInstall.stderr, /curl -fsSL https:\/\/get\.cotal\.ai \| sh -s -- --no-setup/);
    const control = probe(join(root, "dist/cotal.js"), ["--version"], { TEST_TRACE_V8_FLAGS: "1" });
    assert.equal(control.status, 0, control.stderr);
    assert.match(control.stderr, /V8_FLAG:--no-maglev/);
    assert.match(control.stderr, /V8_FLAG:--no-concurrent-sparkplug/);
    for (const [version, knownFlags, argv] of [
      ["12.22.9", "", ["--version"]],
      ["12.22.9", "", ["doctor"]],
      ["16.20.2", "", ["--version"]],
      ["16.20.2", "", ["--help"]],
      ["18.20.8", "--no-concurrent-sparkplug", ["--version"]],
      ["18.20.8", "--no-concurrent-sparkplug", ["--help"]],
      ["22.9.0", "--no-maglev,--no-concurrent-sparkplug", ["--version"]],
    ] as const) {
      const refused = probe(join(repo, "bin/dist/cotal.js"), [...argv], { TEST_FAKE_NODE_VERSION: version, TEST_V8_KNOWN_FLAGS: knownFlags, TEST_TRACE_V8_FLAGS: "1" });
      assert.equal(refused.status, 1, refused.stderr);
      assert.equal(refused.stdout, "");
      assert.equal(refused.stderr.includes("unrecognized flag"), false, refused.stderr);
      assert.equal(refused.stderr.includes("V8_FLAG:"), false, refused.stderr);
      assert.equal(refused.stderr.startsWith(`\ncotal-ai requires Node.js >= 22.10, but this is v${version}.\n`), true, refused.stderr);
      assert.match(refused.stderr, /nvm install 22\.10 && nvm use 22\.10/);
      assert.match(refused.stderr, /installed Cotal globally with npm, reinstall it with the newer Node[^\n]+\n  npm install -g cotal-ai/);
      assert.match(refused.stderr, /If you use npx, clear its cache instead[^\n]+\n  rm -rf ~\/\.npm\/_npx/);
    }
    const launcher = probe(join(repo, "bin/dist/cotal.js"), ["--version"], { COTAL_LAUNCHER: "1", TEST_FAKE_NODE_VERSION: "18.20.8", TEST_V8_KNOWN_FLAGS: "--no-concurrent-sparkplug" });
    assert.equal(launcher.status, 1, launcher.stderr);
    assert.equal(launcher.stderr.includes("unrecognized flag"), false, launcher.stderr);
    assert.match(launcher.stderr, /The Node this install was pinned to has been replaced with an older one\./);
    assert.doesNotMatch(launcher.stderr, /npm install -g cotal-ai|rm -rf ~\/\.npm\/_npx/);
    const handoff = join(scratch, "handoff.json");
    writeFileSync(handoff, "{}");
    assert.equal(probe(join(repo, "bin/dist/cotal.js"), ["--version"], { COTAL_MANAGED_HANDOFF_FILE: handoff, TEST_FAKE_NODE_VERSION: "16.20.2", TEST_V8_KNOWN_FLAGS: "" }).status, 1);
    assert.equal(existsSync(handoff), true, "non-spawn commands leave the managed handoff file intact");
    assert.equal(probe(join(repo, "bin/dist/cotal.js"), ["spawn"], { COTAL_MANAGED_HANDOFF_FILE: handoff, TEST_FAKE_NODE_VERSION: "16.20.2", TEST_V8_KNOWN_FLAGS: "" }).status, 1);
    assert.equal(existsSync(handoff), false, "spawn unlinks the managed handoff file on runtime refusal");
    const directProgram = probe(join(repo, "bin/dist/cotal-program.js"), ["--version"], { TEST_FAKE_NODE_VERSION: "16.20.2", TEST_V8_KNOWN_FLAGS: "" });
    assert.equal(directProgram.status, 1, directProgram.stderr);
    assert.equal(directProgram.stderr.includes("unrecognized flag"), false, directProgram.stderr);
    assert.equal(directProgram.stderr.startsWith("\ncotal-ai requires Node.js >= 22.10, but this is v16.20.2.\n"), true, directProgram.stderr);
  });
  check("missing descriptor runs the initial tree and writes no cache or store", () => {
    const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "initial generation");
    assert.equal(existsSync(executionStore(root)), false); assert.equal(existsSync(executionDescriptorPath(root)), false);
  });
  check("selected product may import bootstrap primitives without a top-level-await cycle", () => {
    const entry = join(root, "dist/cotal-program.js"), original = readFileSync(entry);
    writeFileSync(entry, "import { executionBinding } from './cotal.js'; console.log(executionBinding(new URL('..', import.meta.url).pathname).version);");
    try { const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "0.1.0"); }
    finally { writeFileSync(entry, original); }
  });
  check("an imported wrapper explicitly delegates the selected program once", () => {
    const wrapper = join(scratch, "wrapper.mjs");
    writeFileSync(wrapper, `const { startExecutionProgram } = await import(${JSON.stringify(pathToFileURL(join(root, "dist/cotal.js")).href)}); startExecutionProgram(); startExecutionProgram();`);
    const result = spawnSync(process.execPath, [wrapper, "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "initial generation");
  });
  check("read-only initial package starts without any materialization", () => {
    chmodSync(root, 0o500);
    try { const result = run(); assert.equal(result.status, 0, result.stderr); } finally { chmodSync(root, 0o700); }
    assert.equal(existsSync(executionStore(root)), false);
  });
  check("desktop runtime refuses staged execution retention and active descriptors on every platform", () => {
    const desktopLayouts = [
      ["linux", join(scratch, "desktop-linux/opt/Cotal/resources/runtime")],
      ["darwin", join(scratch, "desktop-darwin/Cotal.app/Contents/Resources/runtime")],
      ["win32", join(scratch, "desktop-win32/AppData/Local/Cotal/runtime")],
    ] as const;
    for (const [platform, desktopRoot] of desktopLayouts) {
      packageAt(desktopRoot, "0.1.0", `desktop-${platform}`);
      writeFileSync(join(desktopRoot, "desktop-runtime.json"), JSON.stringify({ target: `${platform}-x64`, version: "0.1.0" }));
      assert.equal(selectExecutionProgram(desktopRoot).retained, false);
      assert.throws(() => retainExecutionGeneration(desktopRoot, source), /unavailable on the desktop runtime/);
      assert.throws(() => retainExecutionGeneration(root, desktopRoot), /unavailable on the desktop runtime/);
      assert.throws(() => writeExecutionDescriptor(desktopRoot, describeExecutionGeneration(desktopRoot, { id: "a".repeat(32), root: desktopRoot, version: "0.1.0", inventorySha256: "b".repeat(64) })), /unavailable on the desktop runtime/);
      assert.equal(existsSync(executionStore(desktopRoot)), false);
      assert.equal(existsSync(executionDescriptorPath(desktopRoot)), false);
      mkdirSync(executionStore(desktopRoot), { recursive: true, mode: 0o700 });
      assert.throws(() => selectExecutionProgram(desktopRoot), /unavailable on the desktop runtime/);
      rmSync(executionStore(desktopRoot), { recursive: true, force: true });
    }
  });
  if (!["linux", "darwin"].includes(process.platform)) {
    check("retained stores refuse unsupported platforms before mutation", () => {
      assert.throws(() => retainExecutionGeneration(root, source), /unavailable on this platform/);
      assert.equal(existsSync(executionStore(root)), false);
    });
    console.log(`execution generations: ${checks} checks passed; retained selection unavailable on this platform`);
  } else {
  check("retention restores owner write on user-owned installation directories", () => {
    const directories = [root, join(root, "dist"), join(scratch, "prefix/lib/node_modules"), join(scratch, "prefix/lib")];
    for (const path of directories) chmodSync(path, 0o500);
    const retained = retainExecutionGeneration(root, source);
    for (const path of directories) assert.equal(lstatSync(path).mode & 0o777, 0o700);
    assert.equal(retained.version, "0.2.0");
    rmSync(executionStore(root), { recursive: true });
  });
  // Homebrew keeps `lib` group-writable and npm under a umask of 0002 creates the package that way.
  const managed = [root, join(scratch, "prefix/lib/node_modules"), join(scratch, "prefix/lib")];
  for (const path of managed) chmodSync(path, 0o775);
  process.umask(0o002);
  let generation: ReturnType<typeof retainExecutionGeneration>;
  try { generation = retainExecutionGeneration(root, source); } finally { process.umask(0o022); }
  check("retention under a umask of 0002 leaves no group or other write in the copy", () => {
    const walk = (path: string): void => {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) return;
      assert.equal(info.mode & 0o022, 0, path);
      if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    };
    walk(executionStore(root));
  });
  check("retention copies a complete graph and creates no active descriptor", () => {
    assert.equal(readFileSync(join(generation.root, "dist/cotal-program.js"), "utf8"), readFileSync(join(source, "dist/cotal-program.js"), "utf8"));
    assert.equal(existsSync(executionDescriptorPath(root)), false);
    assert.equal(readdirSync(executionStore(root)).filter(name => /^[a-f0-9]{32}$/.test(name)).length, 1);
  });
  const descriptor = describeExecutionGeneration(root, generation);
  writeExecutionDescriptor(root, descriptor);
  check("real built entry selects and executes the retained program", () => {
    const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "retained generation selected");
    assert.equal(selectExecutionProgram(root).root, generation.root);
  });
  check("a retired package-manager launch route cannot reactivate a cached generation", () => {
    const route = join(scratch, "global-route"); symlinkSync(root, route);
    const entry = join(route, "dist/cotal.js");
    writeExecutionDescriptor(root, { ...descriptor, launch: executionLaunchBinding(root, entry) });
    assert.equal(selectExecutionProgram(root).root, generation.root);
    rmSync(route);
    assert.equal(selectExecutionProgram(root).root, root, "removed launch route invalidates the external selection without deleting retained files");
    symlinkSync(root, route);
    assert.equal(selectExecutionProgram(root).root, root, "recreated route has a different incarnation even when its target is the same");
    rmSync(route); writeExecutionDescriptor(root, descriptor);
  });
  check("npm reinstall with a pinned Node launcher runs the replacement instead of the retained generation", () => {
    const entry = join(scratch, "prefix/bin/cotal"), manifest = join(root, "package.json");
    const direct = "../lib/node_modules/cotal-ai/dist/cotal.js", wrapper = "../lib/node_modules/cotal-ai/dist/cotal-npm";
    const postinstall = join(root, postinstallScript);
    mkdirSync(join(scratch, "prefix/bin")); mkdirSync(join(root, "scripts"));
    chmodSync(join(root, "dist/cotal.js"), 0o755);
    cpSync(join(repo, "bin", postinstallScript), postinstall);
    symlinkSync(direct, entry);
    const launch = () => spawnSync(entry, ["--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
    writeExecutionDescriptor(root, { ...descriptor, launch: executionLaunchBinding(root, entry) });
    assert.equal(launch().stdout.trim(), "retained generation selected");

    const script = spawnSync(process.execPath, [postinstall], { encoding: "utf8", timeout: 10_000 });
    assert.equal(script.status, 0, script.stderr);
    assert.equal(readlinkSync(entry), wrapper);
    assert.equal(launch().stdout.trim(), "retained generation selected", "the wrapper alone does not retire an unchanged package");

    const bytes = readFileSync(manifest), before = lstatSync(manifest, { bigint: true });
    utimesSync(manifest, 1, 1);
    assert.notEqual(lstatSync(manifest, { bigint: true }).ctimeNs, before.ctimeNs);
    assert.deepEqual(readFileSync(manifest), bytes);
    const touched = launch();
    assert.equal(touched.status, 0, touched.stderr);
    assert.equal(touched.stdout.trim(), "retained generation selected", "touching an unchanged manifest keeps the verified update");

    // Keep the same manifest bytes and bootstrap hash. Only the installed package's incarnation changes.
    cpSync(manifest, `${manifest}.new`); renameSync(`${manifest}.new`, manifest);
    const result = launch();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "initial generation");

    rmSync(entry); symlinkSync(join(source, "dist/cotal-npm"), entry);
    writeFileSync(join(source, "dist/cotal-npm"), "foreign launcher");
    assert.throws(() => selectExecutionProgram(root), /execution launch route does not resolve to this bootstrap/);
    rmSync(entry); rmSync(join(source, "dist/cotal-npm"));
    writeExecutionDescriptor(root, descriptor);
  });
  check("version-manager shell symlinks bind to the installation prefix and survive switching Node", () => {
    const prefix = join(scratch, "prefix"), entry = join(prefix, "bin/cotal");
    const otherPrefix = join(scratch, "other-node"), otherRoot = join(otherPrefix, "lib/node_modules/cotal-ai"), otherEntry = join(otherPrefix, "bin/cotal");
    const direct = "../lib/node_modules/cotal-ai/dist/cotal.js";
    packageAt(otherRoot, "0.1.0", "other node installation");
    chmodSync(join(otherRoot, "dist/cotal.js"), 0o755);
    mkdirSync(join(otherPrefix, "bin"), { recursive: true, mode: 0o700 });
    symlinkSync(direct, entry);
    symlinkSync(direct, otherEntry);
    const shells = join(scratch, "fnm_multishells"), shell1 = join(shells, "shell-1"), shell2 = join(shells, "shell-2");
    const fileShell = join(shells, "file-shell");
    mkdirSync(join(fileShell, "bin"), { recursive: true, mode: 0o700 });
    symlinkSync(prefix, shell1);
    symlinkSync(prefix, shell2);
    symlinkSync(entry, join(fileShell, "bin/cotal"));
    const canonicalEntry = join(realpathSync.native(prefix), "bin/cotal");
    const canonicalManifest = join(realpathSync.native(root), "package.json");
    const launchVia = (cli: string) => spawnSync(process.execPath, [cli, "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
    try {
      const bound = executionLaunchBinding(root, join(shell1, "bin/cotal"));
      assert.equal(bound.entry, canonicalEntry);
      assert.equal(bound.path, canonicalManifest);
      assert.deepEqual(executionLaunchBinding(root, join(fileShell, "bin/cotal")), bound);

      // Verify the runtime executionIdentity captures the prefix entry rather than the transient shell symlink.
      const identityModule = pathToFileURL(join(repo, "packages/workspace/dist/execution-identity.js")).href;
      const program = join(generation.root, "dist/cotal-program.js"), savedProgram = readFileSync(program);
      writeFileSync(program, `import { executionIdentity } from ${JSON.stringify(identityModule)}; console.log(executionIdentity().launchEntry);`);
      writeExecutionDescriptor(root, describeExecutionGeneration(root, retainExecutionGeneration(root, generation.root)));
      try {
        const active = JSON.parse(readFileSync(executionDescriptorPath(root), "utf8"));
        writeExecutionDescriptor(root, { ...active, launch: executionLaunchBinding(root, join(shell1, "bin/cotal")) });
        const identityProbe = launchVia(join(shell1, "bin/cotal"));
        assert.equal(identityProbe.status, 0, identityProbe.stderr);
        assert.equal(identityProbe.stdout.trim(), canonicalEntry);
      } finally {
        writeFileSync(program, savedProgram);
      }

      writeExecutionDescriptor(root, { ...descriptor, launch: bound });
      assert.equal(launchVia(join(shell1, "bin/cotal")).stdout.trim(), "retained generation selected");

      // Shell 1 switches to the other Node installation and back; retained generation stays active.
      rmSync(shell1); symlinkSync(otherPrefix, shell1);
      assert.equal(launchVia(join(shell1, "bin/cotal")).stdout.trim(), "other node installation");
      assert.equal(launchVia(join(shell2, "bin/cotal")).stdout.trim(), "retained generation selected");
      rmSync(shell1); symlinkSync(prefix, shell1);
      assert.equal(launchVia(join(shell1, "bin/cotal")).stdout.trim(), "retained generation selected");

      // Shell 1 stays on the other Node installation (or closes) while Shell 2 runs on the updated installation.
      rmSync(shell1); symlinkSync(otherPrefix, shell1);
      const inShell2 = launchVia(join(shell2, "bin/cotal"));
      assert.equal(inShell2.status, 0, inShell2.stderr);
      assert.equal(inShell2.stdout.trim(), "retained generation selected");
      rmSync(shell1);
      assert.equal(launchVia(join(shell2, "bin/cotal")).stdout.trim(), "retained generation selected");

      // An older pre-migration descriptor that recorded a shell directory symlink falls back cleanly when retargeted.
      symlinkSync(prefix, shell1);
      const shellStat = lstatSync(shell1, { bigint: true });
      writeExecutionDescriptor(root, {
        ...descriptor,
        launch: { entry: join(shell1, "bin/cotal"), path: shell1, dev: String(shellStat.dev), ino: String(shellStat.ino), birth: String(shellStat.birthtimeNs), ctime: String(shellStat.ctimeNs) },
      });
      assert.equal(launchVia(join(shell2, "bin/cotal")).stdout.trim(), "retained generation selected");
      rmSync(shell1); symlinkSync(otherPrefix, shell1);
      const fallback = launchVia(join(shell2, "bin/cotal"));
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.equal(fallback.stdout.trim(), "initial generation");
    } finally {
      rmSync(entry, { force: true });
      rmSync(otherPrefix, { recursive: true, force: true });
      rmSync(shells, { recursive: true, force: true });
      for (const name of readdirSync(executionStore(root))) {
        if (/^[a-f0-9]{32}$/.test(name) && name !== generation.id) rmSync(join(executionStore(root), name), { recursive: true, force: true });
      }
      writeExecutionDescriptor(root, descriptor);
    }
  });
  check("external symlinks preserve their launched bootstrap when prefix bin uses a wrapper or regular file", () => {
    const prefix = join(scratch, "prefix"), entry = join(prefix, "bin/cotal");
    const postinstall = join(root, postinstallScript);
    const extDir = join(scratch, "ext-bin"), extJs = join(extDir, "cotal-js"), extNpm = join(extDir, "cotal-npm");
    const identityModule = pathToFileURL(join(repo, "packages/workspace/dist/execution-identity.js")).href;
    const program = join(generation.root, "dist/cotal-program.js"), savedProgram = readFileSync(program);
    mkdirSync(extDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "scripts"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, "dist/cotal.js"), 0o755);
    rmSync(join(root, "dist/cotal-npm"), { force: true });
    cpSync(join(repo, "bin", postinstallScript), postinstall);
    symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", entry);
    try {
      const script = spawnSync(process.execPath, [postinstall], { encoding: "utf8", timeout: 10_000 });
      assert.equal(script.status, 0, script.stderr);
      assert.equal(readlinkSync(entry), "../lib/node_modules/cotal-ai/dist/cotal-npm");

      writeFileSync(program, `import { executionIdentity } from ${JSON.stringify(identityModule)}; console.log(executionIdentity().launchEntry);`);
      const refreshed = retainExecutionGeneration(root, generation.root);
      writeExecutionDescriptor(root, describeExecutionGeneration(root, refreshed));

      symlinkSync(join(root, "dist/cotal.js"), extJs);
      const expectedExtJs = join(realpathSync.native(extDir), "cotal-js");
      assert.equal(executionLaunchBinding(root, extJs).entry, expectedExtJs);
      const viaExtJs = spawnSync(extJs, ["--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
      assert.equal(viaExtJs.status, 0, viaExtJs.stderr);
      assert.equal(viaExtJs.stdout.trim(), expectedExtJs);

      symlinkSync(join(root, "dist/cotal-npm"), extNpm);
      assert.equal(executionLaunchBinding(root, extNpm).entry, join(realpathSync.native(prefix), "bin/cotal"));
      const viaExtNpm = spawnSync(extNpm, ["--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
      assert.equal(viaExtNpm.status, 0, viaExtNpm.stderr);
      assert.equal(viaExtNpm.stdout.trim(), realpathSync.native(join(root, "dist/cotal.js")));

      rmSync(entry);
      writeFileSync(entry, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "dist/cotal.js"))} "$@"\n`, { mode: 0o755 });
      assert.equal(executionLaunchBinding(root, extJs).entry, expectedExtJs);
      const viaExtRegular = spawnSync(extJs, ["--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
      assert.equal(viaExtRegular.status, 0, viaExtRegular.stderr);
      assert.equal(viaExtRegular.stdout.trim(), expectedExtJs);
    } finally {
      writeFileSync(program, savedProgram);
      rmSync(entry, { force: true });
      rmSync(join(root, "dist/cotal-npm"), { force: true });
      rmSync(extDir, { recursive: true, force: true });
      for (const name of readdirSync(executionStore(root))) {
        if (/^[a-f0-9]{32}$/.test(name) && name !== generation.id) rmSync(join(executionStore(root), name), { recursive: true, force: true });
      }
      writeExecutionDescriptor(root, descriptor);
    }
  });
  check("missing, looping, and unreadable prefix bin entries match baseline startup and selection diagnostics", () => {
    const binDir = join(scratch, "prefix/bin"), entry = join(binDir, "cotal");
    const extDir = join(scratch, "ext-err"), extJs = join(extDir, "cotal");
    const canonicalEntry = join(realpathSync.native(binDir), "cotal");
    mkdirSync(extDir, { recursive: true, mode: 0o700 });
    chmodSync(join(root, "dist/cotal.js"), 0o755);
    symlinkSync(join(root, "dist/cotal.js"), extJs);
    try {
      // Unbound descriptor: missing, looping, and unreadable <prefix>/bin do not block external launches.
      rmSync(entry, { force: true });
      const noFile = spawnSync(extJs, ["--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
      assert.equal(noFile.status, 0, noFile.stderr);
      assert.equal(noFile.stdout.trim(), "retained generation selected");

      symlinkSync("cotal", entry);
      const loopExt = spawnSync(extJs, ["--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
      assert.equal(loopExt.status, 0, loopExt.stderr);
      assert.equal(loopExt.stdout.trim(), "retained generation selected");

      rmSync(entry, { force: true });
      symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", entry);
      if (process.getuid?.() !== 0) {
        chmodSync(binDir, 0o000);
        try {
          const eaccesExt = spawnSync(extJs, ["--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
          assert.equal(eaccesExt.status, 0, eaccesExt.stderr);
          assert.equal(eaccesExt.stdout.trim(), "retained generation selected");
        } finally { chmodSync(binDir, 0o755); }
      }

      // Bound descriptor: missing falls back cleanly; loop and EACCES report realpath with reinstall guidance.
      const bound = { ...descriptor, launch: executionLaunchBinding(root, entry) };
      writeExecutionDescriptor(root, bound);
      rmSync(entry);
      const boundMissing = run();
      assert.equal(boundMissing.status, 0, boundMissing.stderr);
      assert.equal(boundMissing.stdout.trim(), "initial generation");

      writeExecutionDescriptor(root, bound);
      symlinkSync("cotal", entry);
      const boundLoop = run();
      assert.equal(boundLoop.status, 1);
      assert.match(boundLoop.stderr.trim(), new RegExp(`^ELOOP: .*realpath '${canonicalEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'; reinstall with npm install -g cotal-ai@latest$`));

      rmSync(entry, { force: true });
      symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", entry);
      if (process.getuid?.() !== 0) {
        writeExecutionDescriptor(root, { ...descriptor, launch: executionLaunchBinding(root, entry) });
        chmodSync(binDir, 0o000);
        try {
          const boundEacces = run();
          assert.equal(boundEacces.status, 1);
          assert.match(boundEacces.stderr.trim(), new RegExp(`^EACCES: .*realpath '${canonicalEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'; reinstall with npm install -g cotal-ai@latest$`));
        } finally { chmodSync(binDir, 0o755); }
      }
    } finally {
      chmodSync(binDir, 0o755);
      rmSync(entry, { force: true });
      rmSync(extDir, { recursive: true, force: true });
      writeExecutionDescriptor(root, descriptor);
    }
  });
  check("a bootstrap bound to a different artifact runs the installed tree without writing", () => {
    const stale = { ...descriptor, binding: { ...descriptor.binding, bootstrapSha256: "0".repeat(64) } };
    writeExecutionDescriptor(root, stale);
    const file = executionDescriptorPath(root), bytes = readFileSync(file), before = lstatSync(file).mtimeMs;
    const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "initial generation");
    assert.deepEqual(readFileSync(file), bytes); assert.equal(lstatSync(file).mtimeMs, before);
    writeExecutionDescriptor(root, descriptor);
  });
  check("transition binding aliases preserve retained selection across manifest publication", () => {
    const file = join(root, "package.json"), bytes = readFileSync(file);
    const next = { ...descriptor.binding, version: "0.3.0" };
    writeExecutionDescriptor(root, { ...descriptor, bindings: [next] });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(bytes.toString()), version: next.version }));
    try {
      const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "retained generation selected");
      assert.equal(selectExecutionProgram(root).root, generation.root);
    } finally { writeFileSync(file, bytes); writeExecutionDescriptor(root, descriptor); }
  });
  check("malformed or excessive transition bindings refuse", () => {
    for (const bindings of [[{}], Array.from({ length: 5 }, () => descriptor.binding)]) {
      writeFileSync(executionDescriptorPath(root), JSON.stringify({ ...descriptor, bindings }));
      assert.throws(() => selectExecutionProgram(root), /invalid execution transition bindings/);
    }
    writeExecutionDescriptor(root, descriptor);
  });
  check("alias selection still refuses unknown protocol and corrupt target", () => {
    const aliased = { ...descriptor, binding: { ...descriptor.binding, version: "0.0.0" }, bindings: [descriptor.binding] };
    writeFileSync(executionDescriptorPath(root), JSON.stringify({ ...aliased, v: 999 }));
    assert.throws(() => selectExecutionProgram(root), /unsupported execution descriptor version/);
    writeExecutionDescriptor(root, { ...aliased, generation: { ...descriptor.generation, id: "f".repeat(32) } });
    assert.notEqual(run().status, 0);
    writeExecutionDescriptor(root, descriptor);
  });
  check("a malformed binding is not proof of a different installed artifact", () => {
    writeFileSync(executionDescriptorPath(root), JSON.stringify({ ...descriptor, binding: {} }));
    assert.throws(() => selectExecutionProgram(root), /invalid execution artifact binding/);
    writeExecutionDescriptor(root, descriptor);
  });
  check("matching unknown descriptor protocol refuses with reinstall guidance", () => {
    writeFileSync(executionDescriptorPath(root), JSON.stringify({ ...descriptor, v: 999 }));
    const result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /unsupported execution descriptor version 999.*reinstall with npm install -g/);
    assert.equal(result.stdout, ""); writeExecutionDescriptor(root, descriptor);
  });
  check("a matching descriptor never falls back after a missing target", () => {
    writeExecutionDescriptor(root, { ...descriptor, generation: { ...descriptor.generation, id: "f".repeat(32) } });
    const result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /reinstall with npm install -g/); assert.equal(result.stdout, "");
    writeExecutionDescriptor(root, descriptor);
  });
  check("inventory modification refuses before any product output", () => {
    const entry = join(generation.root, "dist/cotal-program.js"), bytes = readFileSync(entry);
    writeFileSync(entry, "console.log('corrupted program');");
    const result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /inventory differs/); assert.equal(result.stdout, "");
    writeFileSync(entry, bytes);
  });
  check("extra files also invalidate the retained inventory", () => {
    const extra = join(generation.root, "extra"); writeFileSync(extra, "added");
    assert.throws(() => selectExecutionProgram(root), /inventory differs/); rmSync(extra);
  });
  check("malformed descriptor refuses rather than inferring a fresh install", () => {
    writeFileSync(executionDescriptorPath(root), "{"); const result = run(); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    writeExecutionDescriptor(root, descriptor);
  });
  check("oversized descriptor is refused before parsing", () => {
    writeFileSync(executionDescriptorPath(root), " ".repeat(4 * 1024 * 1024 + 1));
    assert.throws(() => selectExecutionProgram(root), /unsafe execution record/);
    writeExecutionDescriptor(root, descriptor);
  });
  check("a group-writable descriptor cannot select retained code", () => {
    const file = executionDescriptorPath(root); chmodSync(file, 0o620);
    try { assert.throws(() => selectExecutionProgram(root), /unprotected execution entry/); }
    finally { chmodSync(file, 0o600); }
  });
  check("descriptor symlink refuses without reading a foreign record", () => {
    const file = executionDescriptorPath(root); rmSync(file); symlinkSync(join(scratch, "absent"), file);
    assert.throws(() => selectExecutionProgram(root), /unsafe execution record/); rmSync(file); writeExecutionDescriptor(root, descriptor);
  });
  check("retention rejects a dependency link escaping the verified package", () => {
    const link = join(source, "escape"); symlinkSync(root, link);
    assert.throws(() => retainExecutionGeneration(root, source), /link escapes/); rmSync(link);
    assert.equal(readdirSync(executionStore(root)).filter(name => /^[a-f0-9]{32}$/.test(name)).length, 1);
  });
  check("retained directory symlinks cannot substitute a different store", () => {
    const store = executionStore(root), other = join(scratch, "other"); mkdirSync(other);
    const container = join(store, "e".repeat(32)); symlinkSync(other, container);
    writeExecutionDescriptor(root, { ...descriptor, generation: { ...descriptor.generation, id: "e".repeat(32) } });
    assert.throws(() => selectExecutionProgram(root), /unsafe execution generation/); rmSync(container); writeExecutionDescriptor(root, descriptor);
  });
  check("the package manager's group-writable folders are used and keep their modes", () => {
    assert.equal(selectExecutionProgram(root).root, generation.root);
    for (const path of managed) assert.equal(lstatSync(path).mode & 0o777, 0o775, path);
  });
  check("a version check from a 0.164.16 or 0.164.17 updater that will refuse its own copy names the manual install and leaves no staging", () => {
    const store = join(scratch, "stuck/lib/.cotal-generations"), staged = join(store, ".installing-AbC123/lib/node_modules/cotal-ai"), abandoned = join(store, ".installing-Zz9999");
    const stage = (): void => { packageAt(staged, "0.3.0", "staged target"); mkdirSync(abandoned, { recursive: true }); writeFileSync(join(abandoned, "left"), "x"); };
    const under = (umask: string, env: NodeJS.ProcessEnv) => spawnSync("sh", ["-c", `umask ${umask}; exec "$0" "$1" --version`, process.execPath, join(staged, "dist/cotal.js")], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), XDG_RUNTIME_DIR: scratch, ...env }, cwd: scratch, encoding: "utf8", timeout: 10_000 });
    const probe = spawnSync("sh", ["-c", `umask 002; exec "$0" -e 'const fs=require("fs");fs.mkdirSync("from",{mode:0o700});fs.cpSync("from","to",{recursive:true});process.stdout.write(String(fs.lstatSync("to").mode&0o022))'`, process.execPath], { cwd: mkdtempSync(join(scratch, "probe-")), encoding: "utf8", timeout: 10_000 });
    assert.equal(probe.status, 0, probe.stderr);
    const refuses = probe.stdout !== "0";
    stage();
    const old = under("002", { COTAL_SKIP_CONNECTOR_SEED: "1" });
    if (refuses) {
      assert.equal(old.status, 1); assert.equal(old.stdout, "");
      assert.match(old.stderr, /Install the new version once by hand: run npm install -g --prefix .*stuck cotal-ai@latest\. Later updates run on their own$/);
      assert.deepEqual(readdirSync(store), []);
      stage(); mkdirSync(join(scratch, "stuck/nodebin"));
      assert.match(under("002", { COTAL_SKIP_CONNECTOR_SEED: "1" }).stderr, /by hand: run the installer from get\.cotal\.ai again\. Later/);
      stage();
    } else { assert.equal(old.status, 0, old.stderr); assert.equal(old.stdout.trim(), "staged target"); }
    for (const result of [under("002", { COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_EXECUTION_COPY_MODES: "explicit" }), under("022", { COTAL_SKIP_CONNECTOR_SEED: "1" }), under("002", { COTAL_SKIP_CONNECTOR_SEED: "" })]) {
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "staged target");
    }
    assert.deepEqual(readdirSync(store).sort(), [".installing-AbC123", ".installing-Zz9999"]);
    const session = under("022", { COTAL_SKIP_CONNECTOR_SEED: "1", XDG_RUNTIME_DIR: "" });
    if (process.platform === "linux") {
      assert.equal(session.status, 1); assert.match(session.stderr, /cannot finish here: it needs XDG_RUNTIME_DIR, which this session does not set\. Install the new version once by hand: run /);
      assert.deepEqual(readdirSync(store), []);
    } else { assert.equal(session.status, 0, session.stderr); }
    console.log(`  this Node ${refuses ? "applies" : "does not apply"} the umask to copied folders`);
  });
  check("a package other accounts run gets a store they can read, and its owner opens one an earlier version kept private", () => {
    const shared = join(scratch, "shared/lib/node_modules/cotal-ai"), next = join(scratch, "shared-source/cotal-ai");
    packageAt(shared, "0.1.0", "shared initial"); packageAt(next, "0.2.0", "shared retained");
    chmodSync(shared, 0o755);
    const previous = process.umask(0o077);
    let kept: ReturnType<typeof retainExecutionGeneration>;
    try { kept = retainExecutionGeneration(shared, next); writeExecutionDescriptor(shared, describeExecutionGeneration(shared, kept)); }
    finally { process.umask(previous); }
    const store = executionStore(shared), container = join(store, kept.id), inventory = join(container, "inventory.json"), record = executionDescriptorPath(shared);
    const modes = (...paths: string[]) => paths.map(path => (lstatSync(path).mode & 0o777).toString(8));
    assert.deepEqual(modes(store, container, inventory, record, kept.root, join(kept.root, "dist"), join(kept.root, "package.json")), ["755", "755", "644", "644", "755", "755", "644"]);
    assert.equal(selectExecutionProgram(shared).root, kept.root);
    chmodSync(record, 0o600); chmodSync(inventory, 0o600); chmodSync(container, 0o700); chmodSync(store, 0o700);
    assert.equal(selectExecutionProgram(shared).root, kept.root);
    assert.deepEqual(modes(store, container, inventory, record), ["755", "755", "644", "644"]);
  });
  check("an account that cannot read another account's store runs the package its package manager installed", () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) return;
    const lone = join(scratch, "lone/lib/node_modules/cotal-ai"), next = join(scratch, "lone-source/cotal-ai");
    packageAt(lone, "0.1.0", "lone initial"); packageAt(next, "0.2.0", "lone retained");
    const kept = retainExecutionGeneration(lone, next); writeExecutionDescriptor(lone, describeExecutionGeneration(lone, kept));
    assert.equal(selectExecutionProgram(lone).root, kept.root);
    const store = executionStore(lone), bootstrap = join(lone, "dist/cotal.js"), installed = readFileSync(bootstrap);
    chmodSync(store, 0);
    try {
      assert.equal(selectExecutionProgram(lone).retained, false);
      writeFileSync(bootstrap, `${installed.toString("utf8")}\n// cotal execution publication ${"a".repeat(32)}\n`);
      assert.throws(() => selectExecutionProgram(lone), /EACCES/);
    } finally { writeFileSync(bootstrap, installed); chmodSync(store, 0o700); }
  });
  check("binding still names the unchanged declared executable", () => {
    assert.deepEqual(descriptor.binding, executionBinding(root));
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).bin.cotal, "./dist/cotal.js");
  });
  console.log(`execution generations: ${checks} checks passed`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { executionDescriptorPath } from "../cotal.js";
import { describeExecutionGeneration, retainExecutionGeneration, writeExecutionDescriptor } from "../execution-store.js";

if (!["linux", "darwin"].includes(process.platform)) {
  console.log("execution generation CLI: retained execution is unsupported on this platform");
} else {
  const repo = join(import.meta.dirname, "../.."), scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "execution-cli-")));
  const installed = join(scratch, "prefix/lib/node_modules/cotal-ai"), source = join(scratch, "source/cotal-ai");
  const entry = join(installed, "dist/cotal.js");
  try {
    for (const root of [installed, source]) {
      cpSync(join(repo, "bin/dist"), join(root, "dist"), { recursive: true });
      cpSync(join(repo, "bin/package.json"), join(root, "package.json"));
    }
    // Workspace links cannot be retained as a closed package. Defaults use the existing binary's
    // graph; a retained package missing its dependencies must fail instead of borrowing that graph.
    const retained = retainExecutionGeneration(installed, source);
    const descriptor = describeExecutionGeneration(installed, retained);
    symlinkSync(join(repo, "bin/node_modules"), join(installed, "node_modules"));
    const version = spawnSync(process.execPath, [join(installed, "dist/cotal.js"), "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^cotal-ai \d+\.\d+\.\d+/);
    const docs = spawnSync(process.execPath, [join(installed, "dist/cotal.js"), "docs", "--search", "upgrade", "--json"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
    assert.equal(docs.status, 0, docs.stderr);
    assert.equal(JSON.parse(docs.stdout).command, "docs");
    const originalManifest = readFileSync(join(installed, "package.json"), "utf8");
    const originalVersion = JSON.parse(originalManifest).version as string;
    const xdg = join(scratch, "blocked-config"), blocked = join(xdg, "cotal");
    mkdirSync(xdg);
    writeFileSync(blocked, "not a config directory\n");
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
    const withConfig = (config: string, ...args: string[]) => spawnSync(process.execPath, [entry, ...args], {
      env: { ...cleanEnv, HOME: scratch, COTAL_HOME: join(scratch, "home"), XDG_CONFIG_HOME: config }, cwd: scratch, encoding: "utf8", timeout: 15_000,
    });
    const blockedVersion = withConfig(xdg, "version", "--json");
    assert.equal(blockedVersion.status, 4, blockedVersion.stdout + blockedVersion.stderr);
    assert.equal(blockedVersion.stderr, "");
    const receipt = JSON.parse(blockedVersion.stdout);
    assert.equal(receipt.result.version, originalVersion);
    assert.equal(receipt.outcome, "partial");
    assert.equal(receipt.warnings[0].code, "EXTENSIONS_UNREADABLE");
    assert.ok(receipt.warnings[0].message.includes(blocked) && receipt.error.remedy.includes(`move ${blocked} aside`));
    assert.doesNotMatch(blockedVersion.stdout, /ENOTDIR|\.retired-cotal|ext seed --repair/);
    const blockedText = withConfig(xdg, "--version");
    assert.equal(blockedText.status, 4, blockedText.stdout + blockedText.stderr);
    assert.equal(blockedText.stdout.split("\n", 1)[0], `cotal-ai ${originalVersion}`);
    assert.ok(blockedText.stderr.includes(receipt.error.remedy), blockedText.stderr);
    assert.doesNotMatch(blockedText.stderr, /ext seed --repair/);
    const blockedWatch = withConfig(xdg, "watch", "--json");
    assert.equal(blockedWatch.status, 1, blockedWatch.stdout + blockedWatch.stderr);
    assert.equal(blockedWatch.stderr, "");
    const stream = blockedWatch.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(stream.map((entry) => [entry.stream, entry.type]), [["watch", "error"], ["watch", "end"]]);
    assert.equal(stream[0].data.code, "SCHEMA_INVALID");
    assert.ok(stream[0].data.message.includes(blocked) && stream[0].data.remedy.includes(`move ${blocked} aside`));
    assert.equal(stream[1].data.reason, "setup-failed");
    assert.equal(readFileSync(blocked, "utf8"), "not a config directory\n");
    const key = createHash("sha256").update(realpathSync.native(entry)).digest("hex");
    const selectionConfig = join(scratch, "selection-config");
    const set = join(selectionConfig, "cotal", "installs", key, "sets", originalVersion);
    mkdirSync(set, { recursive: true, mode: 0o700 });
    const selection = join(set, "selection.json");
    const unknownSelection = '{"v":2,"futureSelection":true}\n';
    writeFileSync(selection, unknownSelection, { mode: 0o600 });
    const probe = withConfig(selectionConfig, "--version");
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assert.equal(probe.stdout.split("\n", 1)[0], `cotal-ai ${originalVersion}`);
    assert.match(probe.stdout, /cotal ext seed --repair/);
    assert.equal(readFileSync(selection, "utf8"), unknownSelection);
    const wrongEntry = JSON.stringify({ v: 1, entry: join(scratch, "other", "dist", "cotal.js"), version: originalVersion, root: join(set, "cotal") });
    writeFileSync(selection, wrongEntry);
    const wrongText = withConfig(selectionConfig, "--version");
    assert.equal(wrongText.status, 4, wrongText.stdout + wrongText.stderr);
    assert.equal(wrongText.stdout, `cotal-ai ${originalVersion}\n`);
    assert.match(wrongText.stderr, /connector retention selection differs from this installation/);
    assert.doesNotMatch(wrongText.stderr, /extensions manifest|ext seed --repair/);
    const wrongJson = withConfig(selectionConfig, "version", "--json");
    assert.equal(wrongJson.status, 4, wrongJson.stdout + wrongJson.stderr);
    assert.equal(wrongJson.stderr, "");
    const report = JSON.parse(wrongJson.stdout);
    assert.equal(report.result.reconciliation.source, "selection");
    assert.match(report.warnings[0].message, /connector retention selection differs from this installation/);
    assert.equal(report.error.remedy, undefined);
    assert.equal(readFileSync(selection, "utf8"), wrongEntry);
    const legacy = join(scratch, "legacy-config");
    const legacyJournal = join(legacy, "cotal", ".extensions-promotion.json");
    mkdirSync(join(legacy, "cotal"), { recursive: true, mode: 0o700 });
    writeFileSync(legacyJournal, "interrupted journal\n", { mode: 0o600 });
    const legacyVersion = withConfig(legacy, "version", "--json");
    assert.equal(legacyVersion.status, 4, legacyVersion.stdout + legacyVersion.stderr);
    const legacyReport = JSON.parse(legacyVersion.stdout);
    assert.equal(legacyReport.result.reconciliation.source, "promotion");
    assert.match(legacyReport.warnings[0].message, /extension promotion is unfinished/);
    assert.equal(readFileSync(legacyJournal, "utf8"), "interrupted journal\n");
    writeExecutionDescriptor(installed, descriptor);
    writeFileSync(join(installed, "package.json"), JSON.stringify({ ...JSON.parse(originalManifest), version: "99.0.0" }));
    const publishing = spawnSync(process.execPath, [join(installed, "dist/cotal.js"), "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
    assert.equal(publishing.status, 0, publishing.stderr);
    assert.equal(publishing.stdout.split("\n")[0], `cotal-ai ${originalVersion}`, "loaded code identity must not come from newly published canonical metadata");
    assert.equal(existsSync(executionDescriptorPath(installed)), false, "--version retires the descriptor superseded by the package-manager install");
    const daemonIdentity = spawnSync(process.execPath, ["--input-type=module", "-e", `const {binVersion}=await import(${JSON.stringify(pathToFileURL(join(installed, "dist/daemon/command.js")).href)}); console.log(binVersion());`], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
    assert.equal(daemonIdentity.status, 0, daemonIdentity.stderr);
    assert.equal(daemonIdentity.stdout.trim(), originalVersion, "daemon identity must name loaded code, not the canonical manifest");
    // A manual update's closing step runs in the release that started it and must restart the daemon
    // into the release now on disk.
    const closing = spawnSync(process.execPath, ["--input-type=module", "-e", `process.argv[1]=${JSON.stringify(entry)};
Object.defineProperty(globalThis, Symbol.for("cotal.execution.identity"), { value: Object.freeze({ loadedEntry: ${JSON.stringify(entry)} }), writable: false, configurable: false });
const {updateRuntime, installedCliVersion}=await import(${JSON.stringify(pathToFileURL(join(installed, "node_modules/@cotal-ai/cli/dist/commands/update.js")).href)});
console.log(updateRuntime.version(), installedCliVersion());`], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
    assert.equal(closing.status, 0, closing.stderr);
    assert.equal(closing.stdout.trim(), `${originalVersion} 99.0.0`, "the update's closing step must name the installed release while the updater keeps its loaded one");
    writeFileSync(join(installed, "package.json"), originalManifest);
    writeExecutionDescriptor(installed, descriptor);
    const stopped = spawnSync(process.execPath, [join(installed, "dist/cotal.js"), "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
    assert.notEqual(stopped.status, 0, "retained package without runtime dependencies must not silently use the old installed graph");
    assert.match(stopped.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.ok(readFileSync(executionDescriptorPath(installed)).length > 0);
    console.log("execution generation CLI: version retires the superseded descriptor and refuses a retained package missing its closure");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

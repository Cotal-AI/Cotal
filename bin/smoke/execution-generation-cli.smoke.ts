import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { executionDescriptorPath } from "../cotal.js";
import { describeExecutionGeneration, retainExecutionGeneration, writeExecutionDescriptor } from "../execution-store.js";

if (!["linux", "darwin"].includes(process.platform)) {
  console.log("execution generation CLI: retained execution is unsupported on this platform");
} else {
  const repo = join(import.meta.dirname, "../.."), scratch = mkdtempSync(join(tmpdir(), "execution-cli-"));
  const installed = join(scratch, "prefix/lib/node_modules/cotal-ai"), source = join(scratch, "source/cotal-ai");
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
    writeFileSync(join(installed, "package.json"), JSON.stringify({ ...JSON.parse(originalManifest), version: "99.0.0" }));
    const publishing = spawnSync(process.execPath, [join(installed, "dist/cotal.js"), "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
    assert.equal(publishing.status, 0, publishing.stderr);
    assert.equal(publishing.stdout.split("\n")[0], `cotal-ai ${originalVersion}`, "loaded code identity must not come from newly published canonical metadata");
    const daemonIdentity = spawnSync(process.execPath, ["--input-type=module", "-e", `const {binVersion}=await import(${JSON.stringify(pathToFileURL(join(installed, "dist/daemon/command.js")).href)}); console.log(binVersion());`], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
    assert.equal(daemonIdentity.status, 0, daemonIdentity.stderr);
    assert.equal(daemonIdentity.stdout.trim(), originalVersion, "daemon identity must name loaded code, not the canonical manifest");
    // A manual update's closing step runs in the release that started it and must restart the daemon
    // into the release now on disk.
    const entry = join(installed, "dist/cotal.js");
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
    console.log("execution generation CLI: real version/docs defaults pass; retained missing closure refuses");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

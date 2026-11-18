import assert from "node:assert/strict";
import fs, { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { executionDescriptorPath } from "../cotal.js";
import { describeExecutionGeneration, retainExecutionGeneration, writeExecutionDescriptor } from "../execution-store.js";
import { installedGenerationVersion, watchDaemonGeneration } from "../daemon/generation.js";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (!["linux", "darwin"].includes(process.platform)) skipSuite("daemon-generation-idle: retained generations require POSIX");
process.umask(0o022);
const root = mkdtempSync(join(tmpdir(), "daemon-idle-"));
for (const [key, name] of Object.entries({ HOME: "home", COTAL_HOME: "cotal", XDG_CONFIG_HOME: "config", XDG_RUNTIME_DIR: "runtime" })) {
  process.env[key] = join(root, name);
  mkdirSync(process.env[key]!, { mode: 0o700 });
}
// Keep the fixture for the invoking lane's evidence and cleanup barrier.
const installed = join(root, "prefix/lib/node_modules/cotal-ai"), source = join(root, "source");
function packageAt(path: string, version: string): void {
  mkdirSync(join(path, "dist"), { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "cotal-ai", version, type: "module", bin: { cotal: "./dist/cotal.js" } }));
  cpSync(resolve("bin/dist/cotal.js"), join(path, "dist/cotal.js"));
  chmodSync(join(path, "dist/cotal.js"), 0o644);
  writeFileSync(join(path, "dist/cotal-program.js"), "// fixture program\n");
}
packageAt(installed, "0.1.0");
packageAt(source, "0.2.0");
const first = retainExecutionGeneration(installed, source);
writeExecutionDescriptor(installed, describeExecutionGeneration(installed, first));
const logicalEntry = join(installed, "dist/cotal.js");
Object.defineProperty(globalThis, Symbol.for("cotal.execution.identity"), { value: Object.freeze({ logicalEntry, loadedEntry: logicalEntry }), configurable: true });

let reads = 0, ticks = 0;
let pending: string | undefined;
const originalRead = fs.readFileSync;
fs.readFileSync = ((...args: Parameters<typeof readFileSync>) => {
  if (String(args[0]).startsWith(join(root, "prefix/lib/.cotal-generations"))) reads++;
  return Reflect.apply(originalRead, fs, args);
}) as typeof readFileSync;
syncBuiltinESMExports();
const stop = watchDaemonGeneration("0.2.0", async () => { throw new Error("unmarked watcher must not activate"); }, () => {}, (version) => { ticks++; pending = version; }, false);
async function until(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!test() && Date.now() < deadline) await sleep(50);
  assert.ok(test(), label);
}
try {
  await until(() => ticks >= 1, "initial retained selection validates");
  assert.ok(reads > 0, "first poll reads the retained inventory");
  const initialReads = reads;
  await until(() => ticks >= 3, "two unchanged polls complete");
  assert.equal(reads, initialReads, "unchanged idle polls must not read the retained package");

  packageAt(source, "0.3.0");
  const second = retainExecutionGeneration(installed, source);
  const beforePublication = reads;
  writeExecutionDescriptor(installed, describeExecutionGeneration(installed, second));
  await until(() => pending === "0.3.0", "atomic descriptor publication is detected");
  assert.ok(reads > beforePublication, "new selection is fully validated before reporting");
  const selectedReads = reads;
  await sleep(2200);
  assert.equal(reads, selectedReads, "unmarked replacement remains cheap while pending");

  writeFileSync(join(second.root, "dist/cotal-program.js"), "// tampered\n");
  assert.throws(() => installedGenerationVersion(), /inventory differs/, "hosted admission still checks retained contents afresh");
  const descriptor = readFileSync(executionDescriptorPath(installed));
  writeFileSync(executionDescriptorPath(installed), "invalid JSON\n");
  const beforeInvalid = ticks;
  await sleep(1200);
  assert.equal(ticks, beforeInvalid, "invalid changed metadata cannot reuse the cached version");
  assert.throws(() => installedGenerationVersion(), SyntaxError, "invalid selection is never accepted");
  writeExecutionDescriptor(installed, describeExecutionGeneration(installed, first));
  await until(() => pending === undefined, "a repaired descriptor is revalidated");
  assert.equal(installedGenerationVersion(), "0.2.0");

  unlinkSync(executionDescriptorPath(installed));
  await until(() => pending === "0.1.0", "descriptor removal selects the installed package");
  const manifest = join(installed, "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  writeFileSync(`${manifest}.new`, JSON.stringify({ ...pkg, version: "0.4.0" }));
  renameSync(`${manifest}.new`, manifest);
  await until(() => pending === "0.4.0", "bare package-manager manifest replacement is detected");
  writeFileSync(executionDescriptorPath(installed), descriptor);
  assert.equal(installedGenerationVersion(), "0.4.0", "a differently bound descriptor does not select stale execution");
  console.log("daemon-generation-idle: idle reads, publication, removal, repair and uncached integrity checks passed");
} finally {
  stop();
  fs.readFileSync = originalRead;
  syncBuiltinESMExports();
  Reflect.deleteProperty(globalThis, Symbol.for("cotal.execution.identity"));
}

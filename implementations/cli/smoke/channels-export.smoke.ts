/**
 * Hermetic `cotal channels export` output tests: canonical JSON, argument isolation, stdout purity,
 * no-clobber creation, atomic forced replacement, and destination-symlink safety.
 * Run: pnpm smoke:channels-export
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelRegistryFile } from "@cotal-ai/core";
import {
  channels as channelsCommand,
  outputChannelRegistryExport,
  serializeChannelRegistry,
  validateExportArgs,
} from "../src/commands/channels.js";

const channels = Object.fromEntries([
  ["z", { replayWindow: "1h", replay: true, description: "Last" }],
  ["__proto__", { instructions: "Keep me", deliveryClass: "durable" }],
  ["constructor", { replay: false }],
  ["a", { description: "First" }],
]);
const registry: ChannelRegistryFile = {
  defaults: { replayWindow: "24h", replay: false, deliveryClass: "live" },
  channels,
};
const serialized = serializeChannelRegistry(registry);
const parsed = JSON.parse(serialized) as ChannelRegistryFile;

assert.ok(serialized.endsWith("\n") && !serialized.endsWith("\n\n"), "one trailing newline");
assert.deepEqual(parsed, registry, "serialization preserves the complete registry shape");
assert.deepEqual(Object.keys(parsed), ["channels", "defaults"], "top-level keys are canonical");
assert.deepEqual(Object.keys(parsed.channels ?? {}), ["__proto__", "a", "constructor", "z"], "channel keys use locale-independent ordering");
assert.deepEqual(Object.keys(parsed.channels?.z ?? {}), ["description", "replay", "replayWindow"], "config fields are canonical");
assert.equal(serializeChannelRegistry(registry), serialized, "serialization is byte-stable");

for (const flag of ["replay", "no-replay", "window", "desc", "instructions"] as const) {
  assert.throws(
    () => validateExportArgs(["export", "out.json"], { [flag]: flag === "replay" || flag === "no-replay" ? true : "x" }),
    new RegExp(`--${flag} is not valid`),
    `export rejects --${flag}`,
  );
}
assert.throws(() => validateExportArgs(["export", "a", "b"], {}), /at most one output path/);
assert.throws(() => validateExportArgs(["export"], { force: true }), /requires an output path/);
assert.throws(() => validateExportArgs(["export", "-"], { force: true }), /requires an output path/);
assert.equal(validateExportArgs(["export"], {}), undefined);
assert.equal(validateExportArgs(["export", "-"], {}), "-");
for (const positionals of [["list"], ["set", "general"], ["default"]]) {
  await assert.rejects(
    () => channelsCommand({ positionals, values: { force: true }, raw: [] }),
    /--force is only valid with channels export/,
    `${positionals[0]} rejects --force before connecting`,
  );
}

let stdout = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array) => ((stdout += chunk.toString()), true)) as typeof process.stdout.write;
try {
  assert.equal(outputChannelRegistryExport(registry, undefined, false), undefined);
} finally {
  process.stdout.write = realWrite;
}
assert.equal(stdout, serialized, "stdout contains canonical JSON and nothing else");

const dir = mkdtempSync(join(tmpdir(), "cotal-channels-export-"));
try {
  const output = join(dir, "channels.json");
  assert.equal(outputChannelRegistryExport(registry, output, false), output);
  assert.equal(readFileSync(output, "utf8"), serialized, "new file gets canonical JSON");
  assert.equal(statSync(output).mode & 0o777, 0o600, "new exports are private");

  chmodSync(output, 0o600);
  writeFileSync(output, "keep");
  assert.throws(() => outputChannelRegistryExport(registry, output, false), /already exists.*--force/);
  assert.equal(readFileSync(output, "utf8"), "keep", "refused overwrite leaves destination intact");

  assert.equal(outputChannelRegistryExport(registry, output, true), output);
  assert.equal(readFileSync(output, "utf8"), serialized, "--force atomically replaces the destination");
  assert.equal(statSync(output).mode & 0o777, 0o600, "forced replacement stays private");
  assert.deepEqual(readdirSync(dir), ["channels.json"], "forced replacement leaves no temp file");

  if (process.platform !== "win32") {
    const target = join(dir, "target.json");
    const link = join(dir, "link.json");
    writeFileSync(target, "target stays");
    symlinkSync(target, link);
    assert.throws(() => outputChannelRegistryExport(registry, link, false), /already exists.*--force/);
    assert.equal(readFileSync(target, "utf8"), "target stays", "no-clobber mode does not follow a symlink");
    outputChannelRegistryExport(registry, link, true);
    assert.equal(readFileSync(target, "utf8"), "target stays", "forced replacement does not modify the symlink target");
    assert.equal(readFileSync(link, "utf8"), serialized, "forced replacement replaces the symlink entry");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("✓ channels-export smoke passed");

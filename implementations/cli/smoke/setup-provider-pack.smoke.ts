import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");
const out = mkdtempSync(join(tmpdir(), "cotal-setup-provider-pack-"));

function pack(dir: string): string {
  const stdout = execFileSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", out, join(root, dir)], { encoding: "utf8" });
  return join(out, stdout.trim().split("\n").filter(Boolean).pop()!);
}

function list(tgz: string): string {
  return execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" });
}

function entry(tgz: string, path: string): string {
  return execFileSync("tar", ["-xOzf", tgz, path], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

try {
  const cli = pack("implementations/cli");
  const claude = pack("extensions/connector-claude-code");
  const cliFiles = list(cli);
  const cliSetup = entry(cli, "package/dist/commands/setup.js");
  const claudeFiles = list(claude);
  const claudeSetup = entry(claude, "package/dist/index.js");

  assert.doesNotMatch(cliFiles, /\.claude-plugin\/plugin\.json/, "generic CLI tarball ships no harness plugin manifest");
  assert.doesNotMatch(cliSetup, /plugin", "(?:install|update)"|--scope|\.claude-plugin/, "generic CLI compiled setup ships no harness-native invocation or asset path");
  assert.match(claudeFiles, /package\/skills-plugin\/\.claude-plugin\/plugin\.json/, "Claude connector tarball owns the skills plugin manifest");
  assert.match(claudeSetup, /connector-setup/, "Claude connector tarball registers its setup provider");
  assert.match(claudeSetup, /plugin.*install/, "Claude connector tarball owns its native plugin install path");
  assert.match(readFileSync(join(root, "extensions/connector-claude-code/src/extension.ts"), "utf8"), /setup: \{ kind: "connector-setup", name: "claude" \}/, "Claude connector declares its provider ref");

  const xdg = join(out, "xdg");
  const packageDir = join(xdg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-claude-code");
  mkdirSync(packageDir, { recursive: true });
  execFileSync("tar", ["-xzf", claude, "-C", packageDir, "--strip-components=1"]);
  mkdirSync(join(packageDir, "node_modules", "@cotal-ai"), { recursive: true });
  symlinkSync(join(root, "packages", "core"), join(packageDir, "node_modules", "@cotal-ai", "core"), "dir");
  const extensionsDir = join(xdg, "cotal", "extensions");
  writeFileSync(
    join(extensionsDir, "extensions.json"),
    JSON.stringify({ extensions: [{
      pkg: "@cotal-ai/connector-claude-code",
      version: "0.36.0",
      spec: "packed-fixture",
      provides: [{ kind: "connector", name: "claude" }, { kind: "connector-setup", name: "claude" }],
      commands: [],
    }] }),
  );
  process.env.XDG_CONFIG_HOME = xdg;
  const { materializeExtension, setInstalledExtensionsEnabled } = await import("../src/ext-loader.js");
  setInstalledExtensionsEnabled(true);
  const connector = await materializeExtension<{ kind: "connector"; name: string; setup?: { kind: string; name: string } }>({ kind: "connector", name: "claude" });
  assert.deepEqual(connector.setup, { kind: "connector-setup", name: "claude" }, "packed installed connector exposes its setup ref after lazy import");
  const provider = await materializeExtension<{ kind: "connector-setup"; name: string; skills?: unknown }>({ kind: "connector-setup", name: "claude" });
  assert.equal(typeof provider.skills, "object", "packed installed extension lazily materializes connector-setup:claude");
  console.log("setup-provider-pack.smoke: 8 checks passed");
} finally {
  rmSync(out, { recursive: true, force: true });
}

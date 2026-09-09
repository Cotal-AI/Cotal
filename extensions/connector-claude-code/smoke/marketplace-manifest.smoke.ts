/**
 * #1392: `cotal setup` generated `.claude-plugin/marketplace.json` with `plugins` as bare names.
 * Claude Code validates that form and then cannot RESOLVE it, so `plugin marketplace add` and
 * `update` both report success and the install fails with `Plugin "cotal" not found in marketplace
 * "cotal-mesh"`. The message names a stale local copy, so the obvious remedy changes nothing, and
 * re-running setup regenerates the same broken file over a hand repair.
 *
 * The suite grades `marketplaceManifest`, which is the value `writeMarketplace` serializes — not a
 * restatement of it. It does not spawn `claude`: the `plugin marketplace add` call in
 * `writeMarketplace` is the shipped side effect and is out of scope here, so this proves the
 * manifest's SHAPE and not that Claude Code accepts it. The acceptance evidence is on the issue.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marketplaceManifest } from "../src/setup.js";

let passed = 0;
let failed = 0;
const ok = (label: string, fn: () => void): void => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ FAIL: ${label} ${(error as Error).message}`);
  }
};

const root = mkdtempSync(join(tmpdir(), "cotal-1392-"));

function plant(market: string, name: string, description?: string): void {
  mkdirSync(join(market, name, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(market, name, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "0.0.0", ...(description ? { description } : {}) }, null, 2),
  );
}

try {
  const market = join(root, "claude-plugin");
  plant(market, "cotal", "Join the Cotal mesh over NATS.");
  plant(market, "cotal-skills", "Cotal-authored skills.");
  const manifest = marketplaceManifest(market);

  // LIVENESS. Kept first and kept separate so that a builder emitting nothing reddens HERE, and the
  // shape cells below stay honest about what they grade rather than doubling as a count check.
  ok("LIVENESS — the manifest lists every planted plugin", () => {
    assert.equal(manifest.plugins.length, 2, "both planted plugins are listed");
  });

  ok("every plugin entry is an object, never a bare name", () => {
    for (const entry of manifest.plugins) {
      assert.equal(typeof entry, "object", `entry is an object, got ${typeof entry}`);
      assert.notEqual(entry, null, "entry is not null");
    }
  });

  ok("every entry carries the source Claude Code resolves against", () => {
    const sources = manifest.plugins.map((entry) => entry.source);
    assert.deepEqual(sources, ["./cotal", "./cotal-skills"], "source is the plugin's own directory");
  });

  ok("the description is taken from the plugin's own manifest, not restated here", () => {
    const byName = Object.fromEntries(manifest.plugins.map((entry) => [entry.name, entry.description]));
    assert.equal(byName["cotal"], "Join the Cotal mesh over NATS.");
    assert.equal(byName["cotal-skills"], "Cotal-authored skills.");
  });

  ok("a plugin whose manifest states no description still gets a resolvable entry", () => {
    const bare = join(root, "bare");
    plant(bare, "cotal");
    const [entry] = marketplaceManifest(bare).plugins;
    assert.equal(entry.name, "cotal");
    assert.equal(entry.source, "./cotal");
    assert.equal(entry.description, undefined, "absent rather than an empty string");
  });

  ok("an absent plugin directory is omitted rather than listed unresolvably", () => {
    const partial = join(root, "partial");
    plant(partial, "cotal", "only this one exists");
    const names = marketplaceManifest(partial).plugins.map((entry) => entry.name);
    assert.deepEqual(names, ["cotal"], "lists the planted plugin and omits the absent one");
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`marketplace-manifest smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { closureFromConfig } from "./verify-publish-closure.mjs";
import { isMainEntry } from "./main-entry.mjs";

export function coldVersionWrites(manifest, packages, expected, source) {
  assert(manifest.source === source, "cold candidate belongs to another source");
  assert.deepEqual(manifest.packages.map((pkg) => pkg.name).sort(), expected, "cold candidate package census differs");
  const writes = [];
  for (const pkg of manifest.packages) {
    const row = packages.find((row) => row.name === pkg.name);
    assert(row, "cold candidate package is not in this workspace");
    const prepared = JSON.parse(pkg.sourceManifest);
    assert(prepared.name === pkg.name && prepared.version === pkg.version, "cold candidate version metadata differs");
    // Versioning may update internal ranges, but cannot replace scripts or other package policy.
    const stripVersions = (value) => {
      const copy = structuredClone(value); delete copy.version;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const name of Object.keys(copy[field] ?? {})) if (expected.includes(name)) copy[field][name] = "<fixed-group>";
      }
      return copy;
    };
    assert.deepEqual(stripVersions(prepared), stripVersions(row.manifest), "cold candidate changes non-version package fields");
    writes.push([join(row.path, "package.json"), pkg.sourceManifest]);
  }
  return writes;
}

if (isMainEntry(import.meta.url)) {
  const root = resolve(process.env.RELEASE_ROOT ?? resolve(import.meta.dirname, ".."));
  const manifest = JSON.parse(readFileSync(resolve(process.argv[2]), "utf8"));
  const rows = JSON.parse(execFileSync("pnpm", ["list", "-r", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8" }));
  const packages = rows.map((row) => ({ ...row, manifest: JSON.parse(readFileSync(join(row.path, "package.json"), "utf8")) }));
  const expected = closureFromConfig(readFileSync(join(root, ".changeset/config.json"), "utf8"));
  const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const writes = coldVersionWrites(manifest, packages, expected, source);
  for (const [path, contents] of writes) writeFileSync(path, contents);
  console.log(`Applied the ${writes.length} package versions already qualified by the cold matrix`);
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { inspectCandidateArchive } from "./inspect-candidate-archive.mjs";
import { closureFromConfig } from "./verify-publish-closure.mjs";
import { isMainEntry } from "./main-entry.mjs";

export function packColdCandidate({
  root = resolve(import.meta.dirname, ".."),
  output = "cold-candidate",
  exec = execFileSync,
} = {}) {
  output = resolve(output);
  mkdirSync(output);
  const rows = JSON.parse(exec("pnpm", ["list", "-r", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8" }));
  const packages = rows.filter((row) => !JSON.parse(readFileSync(join(row.path, "package.json"), "utf8")).private);
  const expected = closureFromConfig(readFileSync(join(root, ".changeset/config.json"), "utf8"));
  if (JSON.stringify(packages.map((row) => row.name).sort()) !== JSON.stringify(expected)) throw new Error("cold candidate public package census disagrees with the fixed group");
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const guarded = packages.filter((row) => JSON.parse(readFileSync(join(row.path, "package.json"), "utf8")).scripts?.prepublishOnly).map((row) => row.name).sort();
  if (guarded.length) exec("pnpm", ["-r", ...guarded.flatMap((name) => ["--filter", name]), "run", "prepublishOnly"], { cwd: root, stdio: "inherit", timeout: 600_000 });
  const manifest = { source: exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), prepublishOnly: guarded, packages: [] };
  for (const row of packages) {
    const before = new Set(readdirSync(output));
    exec("pnpm", ["--dir", row.path, "pack", "--pack-destination", output], { cwd: root, stdio: "inherit", timeout: 180_000 });
    const added = readdirSync(output).filter((name) => !before.has(name) && name.endsWith(".tgz"));
    if (added.length !== 1) throw new Error(`cold candidate expected one tarball for ${row.name}`);
    const archive = join(output, added[0]);
    const { metadata: info, files } = inspectCandidateArchive(archive);
    if (info?.name !== row.name || info.version !== row.version) throw new Error("cold candidate package identity mismatch");
    const sourceManifest = readFileSync(join(row.path, "package.json"), "utf8");
    const firstPartyPlugin = dirname(resolve(row.path)) === resolve(root, "extensions") && row.name !== "@cotal-ai/connector-core";
    if ((firstPartyPlugin || Object.hasOwn(info, "cotal") || Object.hasOwn(JSON.parse(sourceManifest), "cotal")) &&
        (info.cotal?.contract !== 1 || info.cotal.core !== info.version)) {
      throw new Error(`cold candidate ${row.name} does not declare its bundled core at ${info.version}`);
    }
    if (!Object.keys(files).some((name) => name.startsWith("dist/"))) throw new Error(`cold candidate ${row.name} has no built distribution`);
    manifest.packages.push({ name: row.name, version: row.version, archive: basename(archive), sha256: sha(readFileSync(archive)), files, sourceManifest });
  }
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(`Cold candidate: ${manifest.packages.length} packages at ${manifest.source}`);
  return manifest;
}

if (isMainEntry(import.meta.url)) packColdCandidate({ output: process.argv[2] });

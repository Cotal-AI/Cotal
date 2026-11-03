#!/usr/bin/env node
/** Validate the lockstep Changesets plan and prepare its staging tag and promotion order. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closureFromConfig } from "./verify-publish-closure.mjs";
import { isMainEntry } from "./main-entry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STAGING_TAG = "cotal-staged";

export function releaseManifests(root = ROOT) {
  const directories = [join(root, "bin"), ...["packages", "extensions", "implementations"].flatMap((parent) =>
    readdirSync(join(root, parent), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, parent, entry.name)))];
  return directories.map((directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))).filter((pkg) => !pkg.private);
}

export function stageReleasePlan(document, fixed, manifests, { packed = false } = {}) {
  if (document?.version !== 1 || !Array.isArray(document.plan) || document.plan.some((group) => !Array.isArray(group))) throw new Error("unsupported Changesets publish plan");
  const entries = document.plan.flat();
  const names = entries.map((entry) => entry?.name);
  const expected = [...new Set(fixed)].sort();
  if (names.length !== expected.length || new Set(names).size !== names.length || [...names].sort().some((name, index) => name !== expected[index])) throw new Error("publish plan must contain the complete fixed closure once");
  const packages = new Map(manifests.map((pkg) => [pkg.name, pkg]));
  if (packages.size !== expected.length || expected.some((name) => !packages.has(name))) throw new Error("public workspace packages must match the fixed closure");
  const groups = new Map(document.plan.flatMap((group, index) => group.map((entry) => [entry.name, index])));
  const versions = new Set();
  for (const entry of entries) {
    const pkg = packages.get(entry.name);
    if (!pkg || entry.kind !== "publish" || entry.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(entry.version)) throw new Error(`invalid release entry for ${entry.name}`);
    if (entry.tag !== (packed ? STAGING_TAG : "latest") || entry.access !== "public") throw new Error(`unexpected release tag or access for ${entry.name}`);
    if (packed && (!entry.tarball?.path || !/^sha256-/.test(entry.tarball.integrity ?? ""))) throw new Error(`missing packed archive for ${entry.name}`);
    versions.add(entry.version);
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      if (groups.has(dependency) && groups.get(dependency) >= groups.get(entry.name)) throw new Error(`publish plan dependency order is invalid for ${entry.name}`);
    }
  }
  if (versions.size !== 1 || !names.includes("cotal-ai")) throw new Error("release plan must use one stable version and include cotal-ai");
  const remaining = new Set(expected);
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter((name) => {
      const pkg = packages.get(name);
      return Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).every((dependency) => !remaining.has(dependency));
    }).sort();
    // The binary is the public entry point. All siblings must move before it, including seeded connectors.
    const next = ready.find((name) => name !== "cotal-ai") ?? (remaining.size === 1 ? ready[0] : undefined);
    if (!next) throw new Error("release dependency cycle or a sibling depends on cotal-ai");
    remaining.delete(next);
    ordered.push(`${next}@${packages.get(next).version}`);
  }
  return { document: { ...document, plan: document.plan.map((group) => group.map((entry) => ({ ...entry, tag: STAGING_TAG }))) }, specs: ordered };
}

if (isMainEntry(import.meta.url)) {
  try {
    const [mode, planFile, outputFile] = process.argv.slice(2);
    if (!["stage", "check"].includes(mode) || !planFile || (mode === "stage" && !outputFile)) throw new Error("usage: stage-release-plan.mjs stage|check <plan.json> [output.json]");
    const fixed = closureFromConfig(readFileSync(join(ROOT, ".changeset/config.json"), "utf8"));
    const result = stageReleasePlan(JSON.parse(readFileSync(planFile, "utf8")), fixed, releaseManifests(), { packed: mode === "check" });
    if (mode === "stage") writeFileSync(outputFile, JSON.stringify(result.document, null, 2) + "\n");
    else process.stdout.write(result.specs.join("\n") + "\n");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

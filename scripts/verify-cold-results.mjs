#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainEntry } from "./main-entry.mjs";

export function verifyColdResults(directory, source, candidateSha256) {
  assert(directory && /^[a-f0-9]{40}$/.test(source ?? "") && /^[a-f0-9]{64}$/.test(candidateSha256 ?? ""), "cold result verifier needs an artifact directory, exact source and candidate hash");
  const root = resolve(directory);
  const targets = [
    ["ubuntu-latest", "linux", "x64"], ["ubuntu-24.04-arm", "linux", "arm64"],
    ["macos-15-intel", "darwin", "x64"], ["macos-15", "darwin", "arm64"],
    ["windows-latest", "win32", "x64"], ["windows-11-arm", "win32", "arm64"],
  ];
  let verified = 0;
  for (const [runner, platform, arch] of targets) {
    for (const node of [22, 24, 26]) {
      const result = JSON.parse(readFileSync(join(root, `cold-result-${runner}-node${node}`, "cold-result.json"), "utf8"));
      assert(result.complete === true && result.source === source, "cold result incomplete or belongs to another source");
      assert(result.candidateSha256 === candidateSha256, "cold result qualified another candidate archive set");
      assert(result.platform === platform && result.arch === arch && result.node.startsWith(`v${node}.`), "cold result ran on the wrong operating system, architecture or Node");
      assert(result.assertions === result.checks.length && new Set(result.checks).size === result.assertions && result.generations.length === 2, "cold result omitted lifecycle evidence");
      for (const round of [0, 1]) {
        for (const name of ["Manager, delivery and broker survive startup", "native Manager control answers", "empty Manager roster is an empty seat list", "native shutdown policy is accepted once", "owned broker listener closed"])
          assert(result.checks.includes(`round ${round} ${name}`), "cold result omitted a required lifecycle assertion");
        if (platform === "win32") for (const component of ["manager", "delivery"])
          assert(result.checks.includes(`round ${round} Windows ${component} cleanup handler ran`), "cold result omitted native Windows cleanup evidence");
      }
      assert(result.checks.includes("cold restart replaces every process generation"), "cold result omitted restart identity comparison");
      assert(result.checks.includes("native process identity round-trips before daemon startup"), "cold result omitted the first native identity read");
      for (const rows of result.generations) {
        for (const component of ["nats", "manager", "delivery"]) assert(rows.some((row) => row.name.startsWith(component + ".") && Number.isSafeInteger(row.pid) && row.token), "cold result omitted a native process identity");
      }
      verified++;
    }
  }
  return verified;
}

if (isMainEntry(import.meta.url)) {
  const [directory, source, manifest] = process.argv.slice(2);
  assert(manifest, "cold result verifier needs the qualified candidate manifest");
  const hash = createHash("sha256").update(readFileSync(manifest)).digest("hex");
  console.log(`Verified ${verifyColdResults(directory, source, hash)} native cold setups at ${source}`);
}

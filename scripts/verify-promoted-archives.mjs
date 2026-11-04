#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { closureFromConfig, versionUrl } from "./verify-publish-closure.mjs";
import { PUBLICATION_BUDGET_MS, publicationStartedAt, publicationExecutionDeadline, publicationMap, remainingBudget, withinPublicationBudget } from "./publication-budget.mjs";
import { isMainEntry } from "./main-entry.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireArtifact = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { code: "ERR_RELEASE_ARTIFACT" }); };

export async function verifyPromotedArchives({ root, manifestFile, requestedAt, expectedSha256, tag = "latest", registry = "https://registry.npmjs.org", fetchImpl = fetch, pollIntervalMs = 1_000, recheck = false, attemptStartedAt, log = console.log }) {
  const originalDeadline = publicationStartedAt(requestedAt) + PUBLICATION_BUDGET_MS;
  // Read-only recovery has its own observation window. It never resets the publication clock.
  const deadline = recheck ? Date.now() + 60_000 : publicationExecutionDeadline(requestedAt, attemptStartedAt);
  remainingBudget(deadline);
  const bytes = readFileSync(manifestFile);
  assert.equal(sha(bytes), expectedSha256, "availability probe received another candidate");
  const manifest = JSON.parse(bytes);
  const names = closureFromConfig(readFileSync(join(root, ".changeset/config.json"), "utf8"));
  assert.deepEqual(manifest.packages.map(({ name }) => name).sort(), names, "availability probe needs the complete public census");
  const checked = new Map();
  for (;;) {
    const rows = await publicationMap(manifest.packages, 6, async (pkg) => {
      try {
        await withinPublicationBudget(async (signal) => {
          const options = { redirect: "manual", signal };
          const [response, tagsResponse] = await Promise.all([
            fetchImpl(versionUrl(registry, pkg.name, pkg.version), options),
            fetchImpl(`${registry}/-/package/${encodeURIComponent(pkg.name)}/dist-tags`, options),
          ]);
          assert(response.status === 200 && tagsResponse.status === 200, "registry metadata is not available");
          const [body, tags] = await Promise.all([response.json(), tagsResponse.json()]);
          assert(body.name === pkg.name && body.version === pkg.version, "registry returned another package version");
          assert.equal(tags[tag], pkg.version, "registry dist-tag has not converged");
          const tarball = new URL(body.dist?.tarball);
          requireArtifact(tarball.origin === new URL(registry).origin, "registry tarball points outside the selected registry");
          const matchesIntegrity = (value) => typeof body.dist.integrity === "string" && body.dist.integrity.split(/\s+/).includes(value);
          if (checked.has(pkg.name)) { requireArtifact(matchesIntegrity(checked.get(pkg.name)), "registry integrity changed after archive verification"); return; }
          const archive = await fetchImpl(tarball, options);
          assert.equal(archive.status, 200, "registry archive is not available");
          const expectedSize = statSync(join(dirname(manifestFile), pkg.archive)).size;
          const hash = createHash("sha256"), integrity = createHash("sha512");
          let size = 0;
          for await (const chunk of archive.body) {
            size += chunk.length;
            requireArtifact(size <= expectedSize, "registry archive exceeds qualified size");
            hash.update(chunk); integrity.update(chunk);
          }
          requireArtifact(size === expectedSize && hash.digest("hex") === pkg.sha256, "registry archive differs from qualified bytes");
          const sri = `sha512-${integrity.digest("base64")}`;
          requireArtifact(matchesIntegrity(sri), "registry integrity differs from its archive");
          checked.set(pkg.name, sri);
        }, deadline);
        return { name: pkg.name, available: true };
      } catch (error) {
        if (error.code === "ERR_RELEASE_ARTIFACT") throw error;
        return { name: pkg.name, available: false, reason: error.message };
      }
    });
    if (rows.every(({ available }) => available)) {
      remainingBudget(deadline);
      log(`Verified ${rows.length} registry archives and ${tag} tags against the qualified candidate`);
      return { complete: true, candidateSha256: expectedSha256, requestedAt, verifiedAt: new Date().toISOString(), withinPublicationBudget: Date.now() <= originalDeadline, recheck, packages: rows };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`publication availability was not verified before its execution deadline: ${rows.filter(({ available }) => !available).map(({ name, reason }) => `${name}: ${reason}`).join("; ")}`);
    log(`Registry convergence pending for ${rows.filter(({ available }) => !available).length}/${rows.length} packages`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
}

if (isMainEntry(import.meta.url)) {
  const [manifestFile, tag = "latest", output, ...flags] = process.argv.slice(2);
  const options = { requestedAt: process.env.RELEASE_REQUESTED_AT, attemptStartedAt: process.env.RELEASE_ATTEMPT_STARTED_AT, expectedSha256: process.env.RELEASE_CANDIDATE_SHA256, recheck: false };
  for (const flag of flags) {
    if (flag === "--recheck") options.recheck = true;
    else if (flag.startsWith("--requested-at=")) options.requestedAt = flag.slice("--requested-at=".length);
    else if (flag.startsWith("--candidate-sha256=")) options.expectedSha256 = flag.slice("--candidate-sha256=".length);
    else throw new Error("unknown archive verification flag");
  }
  verifyPromotedArchives({ root: resolve(process.env.RELEASE_ROOT ?? resolve(import.meta.dirname, "..")), manifestFile, tag, ...options })
    .then((receipt) => { if (output) writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 }); })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

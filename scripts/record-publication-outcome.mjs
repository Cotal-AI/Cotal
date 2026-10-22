#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PUBLICATION_BUDGET_MS, publicationStartedAt } from "./publication-budget.mjs";
import { isMainEntry } from "./main-entry.mjs";

export function recordPublicationOutcome({ publicationFile, archivesFile, output, env = process.env, now = Date.now() }) {
  const read = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const publication = read(publicationFile), archives = read(archivesFile);
  const started = publicationStartedAt(env.RELEASE_REQUESTED_AT, now);
  const available = Boolean(archives?.complete === true && archives.candidateSha256 === env.RELEASE_CANDIDATE_SHA256
    && archives.requestedAt === env.RELEASE_REQUESTED_AT && env.INSTALL_OK === "true");
  const receipt = {
    v: 1, requestedAt: env.RELEASE_REQUESTED_AT, observedAt: new Date(now).toISOString(),
    elapsedMs: now - started, available, withinPublicationBudget: available && now - started <= PUBLICATION_BUDGET_MS,
    source: env.RELEASE_SOURCE, publisherSource: env.GITHUB_SHA, candidateSha256: env.RELEASE_CANDIDATE_SHA256,
    publication, archives,
  };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return receipt;
}

if (isMainEntry(import.meta.url)) {
  try {
    const [publicationFile, archivesFile, output] = process.argv.slice(2);
    const receipt = recordPublicationOutcome({ publicationFile, archivesFile, output });
    console.log(`Publication availability verified=${receipt.available}; within original ten-minute budget=${receipt.withinPublicationBudget}; elapsed=${receipt.elapsedMs}ms`);
    if (!receipt.withinPublicationBudget) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

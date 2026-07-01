/**
 * Collect the human-written changeset summaries for a release version out of the workspace
 * CHANGELOG.md files, deduped, as a markdown block. The GitHub Release notes are otherwise generated
 * from merged PR *titles* only (`releases/generate-notes`); this surfaces the actual per-change
 * descriptions that changesets writes into each package's changelog, so a release reads as more than a
 * list of one-line PR titles.
 *
 * Usage: node scripts/release-notes-detail.mjs <version>   (prints nothing if there are no summaries)
 *
 * Reads the `## <version>` section of every package CHANGELOG (the basic `@changesets/cli/changelog`
 * format: top-level `- <hash>: <summary>` bullets, plus `- Updated dependencies …` lines we skip).
 * Because a single changeset is listed under several packages (fixed versioning), the same summary
 * appears in many changelogs — we dedupe by text so each change shows once.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version) {
  process.stderr.write("usage: release-notes-detail.mjs <version>\n");
  process.exit(1);
}

const changelogs = [];
if (existsSync("bin/CHANGELOG.md")) changelogs.push("bin/CHANGELOG.md");
for (const root of ["packages", "extensions", "implementations"]) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const f = join(root, name, "CHANGELOG.md");
    if (existsSync(f)) changelogs.push(f);
  }
}

const summaries = new Set();
for (const file of changelogs) {
  let inSection = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("## ")) {
      inSection = line.slice(3).trim() === version; // a `## <version>` header starts/ends a section
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^- (?:[0-9a-f]{7,40}: )?(.+)$/); // a top-level changeset bullet (optional hash)
    if (!m) continue;
    const summary = m[1].trim();
    if (/^Updated dependencies\b/i.test(summary)) continue; // skip the dependency-bump bookkeeping
    if (/^@?[\w./-]+@\d+\.\d+\.\d+/.test(summary)) continue; // skip bare `pkg@version` dep-bump lines
    summaries.add(summary);
  }
}

if (summaries.size) {
  process.stdout.write("## Changes in this release\n\n");
  for (const s of summaries) process.stdout.write(`- ${s}\n`);
}

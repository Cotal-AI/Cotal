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
  const lines = readFileSync(file, "utf8").split("\n");
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      inSection = line.slice(3).trim() === version; // a `## <version>` header starts/ends a section
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^- (?:[0-9a-f]{7,40}: )?(.+)$/); // a top-level changeset bullet (optional hash)
    if (!m) continue;
    const first = m[1].trim();
    if (/^Updated dependencies\b/i.test(first)) continue; // skip the dependency-bump bookkeeping
    if (/^@?[\w./-]+@\d+\.\d+\.\d+/.test(first)) continue; // skip bare `pkg@version` dep-bump lines
    // A changeset summary may span paragraphs: changesets renders the continuation as blank lines
    // plus 2-space-indented text under the bullet. Capture that whole block (until the next
    // top-level bullet, sub-header, or version header) so the summary is not truncated to one line.
    const body = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s/.test(lines[i + 1]))) {
      body.push(lines[++i]);
    }
    while (body.length && body[body.length - 1].trim() === "") body.pop(); // drop trailing blanks
    summaries.add([first, ...body].join("\n"));
  }
}

if (summaries.size) {
  process.stdout.write("## Changes in this release\n\n");
  // Each summary is `<first line>\n<already 2-space-indented continuation>`, so it re-emits as a
  // valid multi-paragraph markdown list item under the bullet.
  for (const s of summaries) process.stdout.write(`- ${s}\n`);
}

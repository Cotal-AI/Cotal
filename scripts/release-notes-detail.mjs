/**
 * Collect the human-written changeset summaries for a release version out of the workspace
 * CHANGELOG.md files, deduped, as a markdown block. The GitHub Release notes are otherwise generated
 * from merged PR *titles* only (`releases/generate-notes`); this surfaces the actual per-change
 * descriptions that changesets writes into each package's changelog, so a release reads as more than a
 * list of one-line PR titles.
 *
 * Usage: node scripts/release-notes-detail.mjs <version> [--max-bytes=<n>]
 * Missing version sections or sections without summaries fail with a diagnostic on stderr.
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
  process.stderr.write("usage: release-notes-detail.mjs <version> [--max-bytes=<n>]\n");
  process.exit(1);
}
// A GitHub release body is capped at 125000 characters. The caller passes what is left after the
// generated PR list; the block ends at the last summary that fits, with a line saying where the rest is.
const maxArg = process.argv.slice(3).find((a) => a.startsWith("--max-bytes="));
const maxBytes = maxArg ? Number(maxArg.slice("--max-bytes=".length)) : Infinity;
if (!(maxBytes > 0)) {
  process.stderr.write(`release-notes-detail.mjs: --max-bytes must be a positive number, got ${JSON.stringify(maxArg)}\n`);
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
let foundSection = false;
for (const file of changelogs) {
  const lines = readFileSync(file, "utf8").split("\n");
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      inSection = line.slice(3).trim() === version; // a `## <version>` header starts/ends a section
      if (inSection) foundSection = true;
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

if (!foundSection) {
  process.stderr.write(`release-notes-detail.mjs: no changelog section for version ${JSON.stringify(version)}\n`);
  process.exit(1);
}
if (!summaries.size) {
  process.stderr.write(`release-notes-detail.mjs: no release summaries in changelog sections for version ${JSON.stringify(version)}\n`);
  process.exit(1);
}

if (summaries.size) {
  const note = (left) => `\n_${left} more changes did not fit in this release body; each package's CHANGELOG.md at v${version} lists them all._\n`;
  const reserve = Buffer.byteLength(note(summaries.size)); // the longest note the cut could need
  let out = "## Changes in this release\n\n";
  let shown = 0;
  // Each summary is `<first line>\n<already 2-space-indented continuation>`, so it re-emits as a
  // valid multi-paragraph markdown list item under the bullet.
  for (const s of summaries) {
    const item = `- ${s}\n`;
    if (Buffer.byteLength(out + item) + reserve > maxBytes) break;
    out += item;
    shown++;
  }
  if (shown < summaries.size) out += note(summaries.size - shown);
  process.stdout.write(out);
}

/**
 * Write the body of a GitHub Release from the changeset summaries in the workspace CHANGELOG.md
 * files. The notes GitHub generates are merged-PR titles only; this prints what each change does,
 * in two layers: one sentence per change under `## What changed` (the sentence a changeset opens
 * with, minor changes before patches), then every summary in full under a collapsed block. The
 * Discord announcement posts the first layer only (`scripts/release-announcement.mjs`).
 *
 * Usage: node scripts/release-notes-detail.mjs <version> [--since <previous released version>]
 *
 * With `--since`, every `## <v>` section with <previous> < v <= <version> is read, so a version
 * that was cut but never published (its publish refused, or reverted before it reached npm) is
 * described by the release that first carries its changes. Without it only `## <version>` is read.
 * Prints nothing when no section carries a summary.
 *
 * Reads the basic `@changesets/cli/changelog` format: `### Minor Changes` / `### Patch Changes`
 * sub-headers, top-level `- <hash>: <summary>` bullets with their indented continuation, and
 * `- Updated dependencies …` lines, which are skipped. A changeset is listed under every package it
 * bumps (fixed versioning), so summaries are deduped by their text and each change shows once.
 *
 * `--self-test` runs the suite at the bottom of this file against fixture changelogs.
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const parseVersion = (text) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? m.slice(1).map(Number) : undefined;
};

const compareVersions = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Words whose trailing period ends no sentence. */
const ABBREVIATIONS = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|Dr|Mr|Mrs|Ms|Prof|St|No)\.$/i;

/**
 * The same text with every inline code span and every Markdown link replaced by letters of the
 * same length, so a sentence mark inside one never counts as a sentence end. Lengths are kept so
 * an index into the masked text indexes the original.
 */
export const maskMarkdown = (line) =>
  line
    .replace(/(`+)[\s\S]*?\1/g, (m) => "x".repeat(m.length))
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => "x".repeat(m.length));

/**
 * The sentence a summary opens with: its first paragraph (a changeset wraps a paragraph over
 * indented lines; a blank line ends it) up to the first `.`, `!` or `?` that is followed by white
 * space or the end, with any closing quote or bracket after the mark. A mark inside an inline code
 * span or a Markdown link does not count, nor does the period of a listed abbreviation
 * (`ABBREVIATIONS`), a decimal such as `1.5`, or a dotted name such as `Node.js`, since none of
 * those is followed by white space. What follows the mark is not consulted: a next sentence may
 * start with a digit, a lowercase product name or a non-ASCII letter.
 */
export const firstSentence = (text) => {
  const paragraph = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") break;
    paragraph.push(raw.trim());
  }
  const line = paragraph.join(" ");
  const masked = maskMarkdown(line);
  const re = /[.!?]["'\u201d\u2019)\]]*(?=\s|$)/g;
  let m;
  while ((m = re.exec(masked))) {
    const end = m.index + m[0].length;
    if (ABBREVIATIONS.test(masked.slice(0, m.index + 1))) continue;
    return line.slice(0, end);
  }
  return line;
};

const changelogFiles = (root) => {
  const files = [];
  if (existsSync(join(root, "bin/CHANGELOG.md"))) files.push(join(root, "bin/CHANGELOG.md"));
  for (const dir of ["packages", "extensions", "implementations"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const f = join(base, name, "CHANGELOG.md");
      if (existsSync(f)) files.push(f);
    }
  }
  return files;
};

/**
 * Collect the summaries of every changelog section in (since, version], as `{ text, kind }` where
 * kind is "major", "minor" or "patch", deduped by text, major and minor before patch in the order
 * the changelogs list them. A changeset that bumps one package minor and another patch is one
 * change, listed once under the larger bump.
 */
export const collectSummaries = (root, version, since) => {
  const upper = parseVersion(version);
  if (!upper) throw new Error(`not a release version: ${version}`);
  const lower = since === undefined ? undefined : parseVersion(since);
  if (since !== undefined && !lower) throw new Error(`not a release version: ${since}`);
  const inRange = (v) =>
    lower ? compareVersions(v, lower) > 0 && compareVersions(v, upper) <= 0 : compareVersions(v, upper) === 0;

  const RANK = { major: 0, minor: 1, patch: 2 };
  const seen = new Map();
  for (const file of changelogFiles(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    let inSection = false;
    let kind = "patch";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("## ")) {
        const v = parseVersion(line.slice(3));
        inSection = v !== undefined && inRange(v);
        kind = "patch";
        continue;
      }
      if (!inSection) continue;
      const sub = /^### (Major|Minor|Patch) Changes/.exec(line);
      if (sub) {
        kind = sub[1].toLowerCase();
        continue;
      }
      const m = line.match(/^- (?:[0-9a-f]{7,40}: )?(.+)$/);
      if (!m) continue;
      const first = m[1].trim();
      if (/^Updated dependencies\b/i.test(first)) continue;
      if (/^@?[\w./-]+@\d+\.\d+\.\d+/.test(first)) continue;
      // A summary may span paragraphs: changesets renders the continuation as blank lines plus
      // 2-space-indented text under the bullet, up to the next bullet or header.
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s/.test(lines[i + 1]))) {
        body.push(lines[++i]);
      }
      while (body.length && body[body.length - 1].trim() === "") body.pop();
      const text = [first, ...body].join("\n");
      const known = seen.get(text);
      if (!known) seen.set(text, { text, kind });
      else if (RANK[kind] < RANK[known.kind]) known.kind = kind;
    }
  }
  return [...seen.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
};

export const render = (summaries) => {
  if (summaries.length === 0) return "";
  const out = ["## What changed", ""];
  for (const s of summaries) out.push(`- ${firstSentence(s.text)}`);
  out.push("", "<details>", "<summary>Every change in full</summary>", "");
  for (const s of summaries) out.push(`- ${s.text}`);
  out.push("", "</details>", "");
  return out.join("\n");
};

const selfTest = () => {
  const root = mkdtempSync(join(tmpdir(), "release-notes-"));
  try {
    const write = (rel, text) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    write(
      "packages/core/CHANGELOG.md",
      [
        "# @cotal-ai/core",
        "",
        "## 0.81.1",
        "",
        "### Patch Changes",
        "",
        "- aaaaaaa: `cotal spawn -f` now reports a failed launch as partial. It used to exit 0.",
        "- Updated dependencies [aaaaaaa]",
        "  - @cotal-ai/workspace@0.81.1",
        "",
        "## 0.81.0",
        "",
        "## 0.80.0",
        "",
        "### Minor Changes",
        "",
        "- bbbbbbb: A seat never leaves the mesh because its event plane stopped, e.g. on a torn line. The holder re-establishes it.",
        "",
        "  A second paragraph of the same summary.",
        "",
        "### Patch Changes",
        "",
        "- ccccccc: Core validates JSON object members as own properties, as the write path",
        "  already did. Nothing else changes.",
        "",
        "## 0.79.0",
        "",
        "### Patch Changes",
        "",
        "- ddddddd: Released before; must not appear.",
        "",
      ].join("\n"),
    );
    write(
      "extensions/connector-core/CHANGELOG.md",
      [
        "# @cotal-ai/connector-core",
        "",
        "## 0.81.1",
        "",
        "## 0.80.0",
        "",
        "### Minor Changes",
        "",
        "- bbbbbbb: A seat never leaves the mesh because its event plane stopped, e.g. on a torn line. The holder re-establishes it.",
        "",
        "  A second paragraph of the same summary.",
        "",
        "### Patch Changes",
        "",
        "- aaaaaaa: `cotal spawn -f` now reports a failed launch as partial. It used to exit 0.",
        "",
      ].join("\n"),
    );
    write(
      "implementations/cli/CHANGELOG.md",
      [
        "# @cotal-ai/cli",
        "",
        "## 0.80.0",
        "",
        "### Patch Changes",
        "",
        "- bbbbbbb: A seat never leaves the mesh because its event plane stopped, e.g. on a torn line. The holder re-establishes it.",
        "",
        "  A second paragraph of the same summary.",
        "",
      ].join("\n"),
    );

    const since = collectSummaries(root, "0.81.1", "0.79.0");
    assert.deepEqual(
      since.map((s) => [s.kind, firstSentence(s.text)]),
      [
        ["minor", "A seat never leaves the mesh because its event plane stopped, e.g. on a torn line."],
        ["patch", "`cotal spawn -f` now reports a failed launch as partial."],
        ["patch", "Core validates JSON object members as own properties, as the write path already did."],
      ],
      "the range covers every unpublished version, minor first, one entry per change across packages and bump kinds, and the sentence ends where the paragraph says, not where the line wraps",
    );
    assert.equal(since[0].text.split("\n").length, 3, "a multi-paragraph summary keeps its continuation");

    const only = collectSummaries(root, "0.81.1");
    assert.deepEqual(
      only.map((s) => firstSentence(s.text)),
      ["`cotal spawn -f` now reports a failed launch as partial."],
      "without --since only the named version's section is read",
    );
    assert.equal(collectSummaries(root, "0.81.0", "0.80.0").length, 0, "an empty section renders nothing");
    assert.equal(render([]), "");

    const body = render(since);
    const summary = body.slice(0, body.indexOf("<details>"));
    assert.equal(
      summary,
      [
        "## What changed",
        "",
        "- A seat never leaves the mesh because its event plane stopped, e.g. on a torn line.",
        "- `cotal spawn -f` now reports a failed launch as partial.",
        "- Core validates JSON object members as own properties, as the write path already did.",
        "",
        "",
      ].join("\n"),
      "the first layer is one sentence per change",
    );
    assert.ok(
      body.includes("<summary>Every change in full</summary>\n\n- A seat never leaves the mesh") &&
        body.includes("\n\n  A second paragraph of the same summary.\n- `cotal spawn -f`") &&
        body.endsWith("\n</details>\n"),
      "the collapsed layer carries the full text",
    );
    assert.equal(
      firstSentence("Use `node foo.js. Bar` to inspect state. The next sentence is mechanism."),
      "Use `node foo.js. Bar` to inspect state.",
      "punctuation inside an inline code span does not end the sentence",
    );
    assert.equal(
      firstSentence('The command now says "Connected." It reports the actual state.'),
      'The command now says "Connected."',
      "a closing quote after the mark belongs to the sentence",
    );
    assert.equal(firstSentence("Fails on ``a `b` c``. Then more."), "Fails on ``a `b` c``.", "a double-backtick span closes at its own fence");
    assert.equal(firstSentence("An unclosed `span is plain text. Nor this."), "An unclosed `span is plain text.", "a lone backtick is text, not a span");
    assert.equal(firstSentence("Reads 1.5 MB (e.g. two files) at once. Then stops."), "Reads 1.5 MB (e.g. two files) at once.", "a decimal and an abbreviation do not end the sentence");
    assert.equal(
      firstSentence("It supports [Node.js. Docs](https://example.invalid/a.b) links. The next sentence is mechanism."),
      "It supports [Node.js. Docs](https://example.invalid/a.b) links.",
      "a mark inside a Markdown link does not end the sentence",
    );
    assert.equal(firstSentence("The CLI respects Dr. Smith's config. The next sentence is mechanism."), "The CLI respects Dr. Smith's config.", "a title abbreviation does not end the sentence");
    for (const next of ["iOS clients also reconnect.", "\u00dcberlong retries no longer occur.", "24 seats can reconnect at once."])
      assert.equal(firstSentence(`Reconnect now works. ${next}`), "Reconnect now works.", `a next sentence starting with ${next.split(" ")[0]} is not consulted`);
    assert.equal(firstSentence("Node.js is read as one word. Then more."), "Node.js is read as one word.", "a dotted name is not a sentence end");
    assert.throws(() => collectSummaries(root, "v0.81.1"), /not a release version/);
    console.log("release-notes-detail self-test: ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const main = (argv) => {
  if (argv[0] === "--self-test") return selfTest();
  const version = argv[0];
  const sinceAt = argv.indexOf("--since");
  const since = sinceAt === -1 ? undefined : argv[sinceAt + 1];
  if (!version || version.startsWith("--") || (sinceAt !== -1 && !since)) {
    process.stderr.write("usage: release-notes-detail.mjs <version> [--since <previous version>]\n");
    process.exit(1);
  }
  process.stdout.write(render(collectSummaries(process.cwd(), version, since)));
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2));

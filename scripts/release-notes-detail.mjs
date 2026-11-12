/**
 * Write the body of a GitHub Release from the changeset summaries in the workspace CHANGELOG.md
 * files. The notes GitHub generates are merged-PR titles only; this prints what each change does,
 * in two layers: one sentence per change under `## What changed` (the sentence a changeset opens
 * with, minor changes before patches), then every summary in full under a collapsed block. The
 * Discord announcement posts the first layer only (`scripts/release-announcement.mjs`).
 *
 * Usage: node scripts/release-notes-detail.mjs <version> [--since <previous released version>] [--max-bytes=<n>]
 *
 * With `--since`, every `## <v>` section with <previous> < v <= <version> is read, so a version
 * that was cut but never published (its publish refused, or reverted before it reached npm) is
 * described by the release that first carries its changes. Without it only `## <version>` is read.
 * Missing version sections or summaries fail on stderr. A byte budget keeps whole changes in both
 * layers and names omitted changes; a budget that fits no change fails instead of emitting partial notes.
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
import { isMainEntry } from "./main-entry.mjs";
import assert from "node:assert/strict";
import { marked } from "marked";

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
/** A sentence mark, with any closing quote or bracket, followed by white space or the end. */
const SENTENCE_END = /[.!?]["'\u201d\u2019)\]]*(?=\s|$)/g;
const CLOSING_MARK = /[.!?]["'\u201d\u2019)\]]*$/;

/**
 * The sentence a summary opens with. The summary is read as Markdown and the first paragraph's
 * inline tokens are walked in order: a sentence ends at the first mark in plain text that is
 * followed by white space or the end, or at the close of an emphasis span whose text ends with a
 * mark, unless the word before the mark is a listed abbreviation (`ABBREVIATIONS`). A mark inside
 * a code span, a link, an image, an escape or raw HTML belongs to that construct and never ends
 * the sentence, so a decimal, a dotted name or a link title cannot cut it. What follows the mark
 * is not consulted: the next sentence may start with a digit, a lowercase product name or a
 * non-ASCII letter. A summary that does not open with a paragraph is listed by its first line.
 */
export const firstSentence = (text) => {
  const paragraph = marked.lexer(text)[0];
  if (paragraph?.type !== "paragraph") return text.split("\n")[0].trim();
  const flat = (s) => s.replace(/\s*\n\s*/g, " ").trim();
  let out = "";
  const tokens = paragraph.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "text") {
      SENTENCE_END.lastIndex = 0;
      let m;
      while ((m = SENTENCE_END.exec(token.raw))) {
        if (ABBREVIATIONS.test(out + token.raw.slice(0, m.index + 1))) continue;
        return flat(out + token.raw.slice(0, m.index + m[0].length));
      }
      out += token.raw;
      continue;
    }
    out += token.raw;
    const closes = (token.type === "strong" || token.type === "em" || token.type === "del") && CLOSING_MARK.test(token.text);
    const next = tokens[i + 1];
    if (closes && (!next || /^\s/.test(next.raw)) && !ABBREVIATIONS.test(token.text.replace(/["'\u201d\u2019)\]]*$/, ""))) return flat(out);
  }
  return flat(out);
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
  let foundVersion = false;
  for (const file of changelogFiles(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    let inSection = false;
    let kind = "patch";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("## ")) {
        const v = parseVersion(line.slice(3));
        if (v !== undefined && compareVersions(v, upper) === 0) foundVersion = true;
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
  if (!foundVersion) throw new Error(`no changelog section for version ${JSON.stringify(version)}`);
  if (!seen.size) throw new Error(`no release summaries in changelog sections for version ${JSON.stringify(version)}`);
  return [...seen.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
};

export const render = (summaries, maxBytes = Infinity) => {
  if (!(maxBytes > 0)) throw new Error("--max-bytes must be a positive number");
  if (summaries.length === 0) return "";
  const headlines = [], details = [];
  const body = () => {
    const left = summaries.length - headlines.length;
    const note = left ? ["", `_${left} more changes did not fit in this release body; each package's CHANGELOG.md lists them all._`] : [];
    return ["## What changed", "", ...headlines, ...note, "", "<details>",
      `<summary>${left ? "Shown changes" : "Every change"} in full</summary>`, "", ...details, "", "</details>", ""].join("\n");
  };
  for (const summary of summaries) {
    headlines.push(`- ${firstSentence(summary.text)}`);
    details.push(`- ${summary.text}`);
    if (Buffer.byteLength(body()) > maxBytes) {
      headlines.pop(); details.pop();
      break;
    }
  }
  if (!headlines.length) throw new Error("byte budget is too small for a release summary");
  return body();
};

const selfTest = () => {
  let checks = 0;
  const check = Object.fromEntries(["equal", "deepEqual", "ok", "throws"].map(method =>
    [method, (...args) => { assert[method](...args); checks++; }]));
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
    check.deepEqual(
      since.map((s) => [s.kind, firstSentence(s.text)]),
      [
        ["minor", "A seat never leaves the mesh because its event plane stopped, e.g. on a torn line."],
        ["patch", "`cotal spawn -f` now reports a failed launch as partial."],
        ["patch", "Core validates JSON object members as own properties, as the write path already did."],
      ],
      "the range covers every unpublished version, minor first, one entry per change across packages and bump kinds, and the sentence ends where the paragraph says, not where the line wraps",
    );
    check.equal(since[0].text.split("\n").length, 3, "a multi-paragraph summary keeps its continuation");

    const only = collectSummaries(root, "0.81.1");
    check.deepEqual(
      only.map((s) => firstSentence(s.text)),
      ["`cotal spawn -f` now reports a failed launch as partial."],
      "without --since only the named version's section is read",
    );
    check.throws(() => collectSummaries(root, "0.81.0", "0.80.0"), /no release summaries/, "an empty section remains a named refusal");
    check.equal(render([]), "");

    const body = render(since);
    const summary = body.slice(0, body.indexOf("<details>"));
    check.equal(
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
    check.ok(
      body.includes("<summary>Every change in full</summary>\n\n- A seat never leaves the mesh") &&
        body.includes("\n\n  A second paragraph of the same summary.\n- `cotal spawn -f`") &&
        body.endsWith("\n</details>\n"),
      "the collapsed layer carries the full text",
    );
    check.equal(
      firstSentence("Use `node foo.js. Bar` to inspect state. The next sentence is mechanism."),
      "Use `node foo.js. Bar` to inspect state.",
      "punctuation inside an inline code span does not end the sentence",
    );
    check.equal(
      firstSentence('The command now says "Connected." It reports the actual state.'),
      'The command now says "Connected."',
      "a closing quote after the mark belongs to the sentence",
    );
    check.equal(firstSentence("Fails on ``a `b` c``. Then more."), "Fails on ``a `b` c``.", "a double-backtick span closes at its own fence");
    check.equal(firstSentence("An unclosed `span is plain text. Nor this."), "An unclosed `span is plain text.", "a lone backtick is text, not a span");
    check.equal(firstSentence("Reads 1.5 MB (e.g. two files) at once. Then stops."), "Reads 1.5 MB (e.g. two files) at once.", "a decimal and an abbreviation do not end the sentence");
    check.equal(
      firstSentence("It supports [Node.js. Docs](https://example.invalid/a.b) links. The next sentence is mechanism."),
      "It supports [Node.js. Docs](https://example.invalid/a.b) links.",
      "a mark inside a Markdown link does not end the sentence",
    );
    check.equal(firstSentence("The CLI respects Dr. Smith's config. The next sentence is mechanism."), "The CLI respects Dr. Smith's config.", "a title abbreviation does not end the sentence");
    for (const next of ["iOS clients also reconnect.", "\u00dcberlong retries no longer occur.", "24 seats can reconnect at once."])
      check.equal(firstSentence(`Reconnect now works. ${next}`), "Reconnect now works.", `a next sentence starting with ${next.split(" ")[0]} is not consulted`);
    check.equal(firstSentence("Node.js is read as one word. Then more."), "Node.js is read as one word.", "a dotted name is not a sentence end");
    check.equal(
      firstSentence('Reads [the guide](https://example.invalid/a_(b) "Quick. Start") safely. Details follow.'),
      'Reads [the guide](https://example.invalid/a_(b) "Quick. Start") safely.',
      "a link destination with parentheses and a title is one construct",
    );
    check.equal(firstSentence("Reads [nested [v2. Docs] material](https://example.invalid) safely. Details follow."), "Reads [nested [v2. Docs] material](https://example.invalid) safely.", "a nested link label is one construct");
    check.equal(
      firstSentence("Reads [Node.js. Docs][guide] safely. Details follow.\n\n[guide]: https://example.invalid"),
      "Reads [Node.js. Docs][guide] safely.",
      "a reference link defined later in the summary is one construct",
    );
    check.equal(firstSentence("The response is **ready.** The next sentence explains the mechanism."), "The response is **ready.**", "a sentence may end inside strong emphasis");
    check.equal(firstSentence("The response is *ready.* The next sentence explains the mechanism."), "The response is *ready.*", "a sentence may end inside emphasis");
    check.equal(firstSentence("Shows ![a dot. here](img.png) inline. Then more."), "Shows ![a dot. here](img.png) inline.", "an image is one construct");
    check.equal(firstSentence("Ends with a period\\. escaped then real. Then more."), "Ends with a period\\. escaped then real.", "an escaped mark does not end the sentence");
    check.equal(firstSentence("- not a paragraph. second\n- more"), "- not a paragraph. second", "a summary that opens with a list is listed by its first line");
    check.equal(firstSentence("# A headline.\n\nSupporting detail."), "# A headline.");
    check.equal(firstSentence("- A headline.\n\nSupporting detail."), "- A headline.");
    check.throws(() => collectSummaries(root, "v0.81.1"), /not a release version/);
    console.log(`release-notes-detail self-test: ${checks} checks passed`);
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
    process.stderr.write("usage: release-notes-detail.mjs <version> [--since <previous version>] [--max-bytes=<n>]\n");
    process.exit(1);
  }
  const maxArg = argv.find((a) => a.startsWith("--max-bytes="));
  const maxBytes = maxArg ? Number(maxArg.slice("--max-bytes=".length)) : Infinity;
  process.stdout.write(render(collectSummaries(process.cwd(), version, since), maxBytes));
};

if (isMainEntry(import.meta.url)) main(process.argv.slice(2));

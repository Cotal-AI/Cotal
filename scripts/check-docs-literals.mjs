#!/usr/bin/env node
// Binds the operator strings the docs quote to the source that emits them.
//
// A page that quotes a line the binary prints (`registered, no answer within the deadline`) is
// operator guidance: someone greps their output for it. When a source change renames that line
// and leaves the page alone, every other docs gate stays green. The voice check reads only prose
// style, and `check-docs-bundle.mjs` proves only that the generator turns the pages into a
// non-hollow bundle. Neither reads the source, so the stale quote ships in the bundle that
// `cotal_docs` serves.
//
// A candidate is a backticked span in docs/ (docs/design exempt, fenced blocks stripped) that
// reads as emitted operator prose: it starts with a lowercase letter, has four or more words, uses
// only lowercase letters, digits, spaces and `,;:.()'-`, and its first word is not a command or a
// `cotal` subcommand the docs quote, which makes it an invocation rather than output. A
// substituted value is written as a placeholder such as `<id>`.
//
// Each candidate must appear in a string the shipped source holds: a string or template literal,
// or a `+` chain of them, in packages/, extensions/, implementations/ or bin/, with smoke, test
// and mutation files excluded. A placeholder must stand where the source substitutes a value.
// Strings come from the TypeScript parser, so a comment that mentions a line does not count as
// emitting it.
//
// Exit 0 when every candidate is emitted, 1 when a quote names a string the source does not hold.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\0")
  .filter(Boolean);

const pages = tracked.filter((f) => f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/design/"));
const sources = tracked.filter(
  (f) =>
    /^(?:packages|extensions|implementations|bin)\//.test(f) &&
    /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(f) &&
    !/(?:^|\/)(?:smoke|mutations|tests?)\/|\.(?:smoke|selftest|test)\.[cm]?[jt]sx?$/.test(f),
);

const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
const span = /(?<!`)`([^`\n]+)`(?!`)/g;
const placeholder = /<[a-z][a-z0-9-]*>/g;
const prose = /^[a-z][a-z0-9 ,;:.()'-]*$/;
const commands = new Set(["cotal", "pnpm", "npm", "npx", "node", "tsx", "git", "gh", "claude", "codex",
  "opencode", "jcode", "hermes", "pi", "tmux", "cmux", "herdr", "orca", "nats", "nats-server", "docker",
  "systemctl", "journalctl", "curl", "sudo", "cd", "export", "uv"]);

const spans = [];
for (const page of pages) {
  const text = readFileSync(join(repoRoot, page), "utf8").replace(fence, (block) => block.replace(/[^\n]/g, ""));
  for (const m of text.matchAll(span)) {
    const line = text.slice(0, m.index).split("\n").length;
    spans.push({ page, line, text: m[1] });
    const invoked = /^cotal ([a-z][a-z0-9-]*)/.exec(m[1]);
    if (invoked) commands.add(invoked[1]);
  }
}

const candidates = spans.filter(({ text }) => {
  const words = text.split(/\s+/);
  if (text !== text.trim() || words.length < 4 || commands.has(words[0])) return false;
  return prose.test(text.replace(placeholder, "x"));
});

// U+0001 marks a substituted value. No candidate can contain it, so only a placeholder matches it.
const hole = "\u0001";
const strings = [];
const joined = (node) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => hole + s.literal.text).join("");
  if (ts.isParenthesizedExpression(node)) return joined(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = joined(node.left);
    const right = joined(node.right);
    return left === undefined && right === undefined ? undefined : (left ?? hole) + (right ?? hole);
  }
  return undefined;
};
for (const file of sources) {
  const sf = ts.createSourceFile(file, readFileSync(join(repoRoot, file), "utf8"), ts.ScriptTarget.ESNext);
  const visit = (node) => {
    const text = joined(node);
    if (text !== undefined) strings.push(text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = (text) =>
  new RegExp(
    text
      .split(placeholder)
      .map(escape)
      .join(`[^\\s${hole}]*${hole}[^\\s${hole}]*`),
  );

const failures = [];
for (const c of candidates) {
  const re = pattern(c.text);
  if (!strings.some((s) => re.test(s))) failures.push(`${c.page}:${c.line}: \`${c.text}\``);
}

if (failures.length) {
  console.error(
    "Docs literal check failed: these quotes name an operator string no shipped source emits.\n" +
      failures.map((line) => `  ${line}`).join("\n") +
      "\nQuote the string the source holds now, writing a substituted value as a placeholder such as <id>.",
  );
  process.exit(1);
}

console.log(
  `check:docs-literals: ${candidates.length} quoted operator strings found in ${strings.length} source strings (docs/design exempt)`,
);

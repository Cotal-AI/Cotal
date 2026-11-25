import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const allowlistPath = new URL("./comment-history-allowlist.json", import.meta.url);
const updateCommand = "pnpm check:comment-history:update";
const rules = {
  "issue-reference": /#[0-9]{3,}/g,
  "used-to": /\bused\s+to\b/gi,
  previously: /\bpreviously\b/gi,
  "no-longer": /\bno\s+longer\b/gi,
  formerly: /\bformerly\b/gi,
};
const source = /^(?:(?:packages|implementations|extensions)\/[^/]+\/src\/|bin\/(?!scripts\/)).*\.(?:[cm]?[jt]s|[jt]sx)$/;
const excluded = /(?:^|\/)(?:smoke|tests?|__tests__|mutations|dist|node_modules)\/|\.(?:smoke|test|spec|selftest)\.|\.d\.[cm]?ts$|^packages\/smoke-kit\//;

// Token trivia keeps strings, regular expressions, template text and JSX text out of the scan.
function comments(name, text) {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const ranges = new Map();
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (!ts.isToken(node)) return node.getChildren(file).forEach(visit);
    if (ts.isJsxText(node)) return;
    scanner.resetTokenState(node.pos);
    for (let kind = scanner.scan(); kind >= ts.SyntaxKind.FirstTriviaToken && kind <= ts.SyntaxKind.LastTriviaToken; kind = scanner.scan()) {
      if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia)
        ranges.set(scanner.getTokenStart(), scanner.getTokenEnd());
    }
  };
  visit(file);
  return [...ranges].map(([start, end]) => ({ start, text: text.slice(start, end) }));
}

function readAllowlist() {
  const value = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (value.version !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files))
    throw new Error("invalid comment-history allowlist header");
  for (const [name, counts] of Object.entries(value.files)) {
    if (!source.test(name) || excluded.test(name) || !counts || typeof counts !== "object" || Array.isArray(counts) || !Object.keys(counts).length)
      throw new Error(`invalid allowlist file: ${name}`);
    for (const [rule, count] of Object.entries(counts)) {
      if (!Object.hasOwn(rules, rule) || !Number.isSafeInteger(count) || count <= 0)
        throw new Error(`invalid allowlist count: ${name} ${rule}`);
    }
  }
  return value.files;
}

function totals(files) {
  return Object.fromEntries(Object.keys(rules).map((rule) => [rule,
    Object.values(files).reduce((sum, counts) => sum + (counts[rule] ?? 0), 0),
  ]));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--update-allowlist"))
    throw new Error("usage: node scripts/check-comment-history.mjs [--update-allowlist]");
  const names = execFileSync("git", ["ls-files", "-z", "--", "packages", "implementations", "extensions", "bin"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter((name) => source.test(name) && !excluded.test(name)).sort();
  const files = {};
  const locations = new Map();
  for (const name of names) {
    const text = readFileSync(join(root, name), "utf8");
    const counts = {};
    for (const comment of comments(name, text)) {
      const body = comment.text.replace(/^[ \t]*\*/gm, (prefix) => " ".repeat(prefix.length));
      for (const [rule, pattern] of Object.entries(rules)) {
        for (const match of body.matchAll(pattern)) {
          counts[rule] = (counts[rule] ?? 0) + 1;
          const key = `${name}:${rule}`;
          if (!locations.has(key)) locations.set(key, text.slice(0, comment.start + match.index).split(/\r\n|[\r\n\u2028\u2029]/).length);
        }
      }
    }
    if (Object.keys(counts).length) files[name] = counts;
  }
  if (args.length) {
    const entries = Object.entries(files).map(([name, counts]) => {
      const fields = Object.entries(counts).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([rule, count]) => `${JSON.stringify(rule)}: ${count}`).join(", ");
      return `    ${JSON.stringify(name)}: { ${fields} }`;
    });
    writeFileSync(allowlistPath, `{\n  "version": 1,\n  "files": {\n${entries.join(",\n")}\n  }\n}\n`);
    console.log(`check:comment-history: allowlist rewritten for ${Object.keys(files).length} files`);
    return;
  }
  const baseline = readAllowlist();
  const before = totals(baseline);
  const after = totals(files);
  const failures = [];
  for (const rule of Object.keys(rules)) {
    if (after[rule] > before[rule]) failures.push(`repository total ${rule}: ${before[rule]} -> ${after[rule]}`);
  }
  for (const [name, counts] of Object.entries(files)) {
    for (const [rule, count] of Object.entries(counts)) {
      const allowed = baseline[name]?.[rule] ?? 0;
      if (count > allowed) failures.push(`${name}:${locations.get(`${name}:${rule}`)}: ${rule}: ${allowed} -> ${count}`);
    }
  }
  if (failures.length) {
    console.error("Comment history check failed:\n" + failures.map((line) => `  ${line}`).join("\n") +
      `\nDescribe the current contract in comments. For a reviewed source move, rewrite the counts with: ${updateCommand}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check:comment-history: ${names.length} source files passed (${Object.entries(after).map(([rule, count]) => `${rule}=${count}`).join(", ")})`);
}

try {
  main();
} catch (error) {
  console.error(`check:comment-history: ${error.message}`);
  process.exitCode = 2;
}

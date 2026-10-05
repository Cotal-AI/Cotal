import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// A `/** */` block documents the declaration directly below it. When a second doc block sits
// directly below the first, the first documents nothing: TypeScript attaches only the nearer block,
// so the declaration the first was written for has no doc on hover, and a reader of the source sees
// it above the wrong declaration. Scope is shipped source, the `src` trees of packages,
// implementations and extensions, minus smoke and test files and the private smoke-kit.
const source = /^(?:packages|implementations|extensions)\/[^/]+\/src\/.*\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;
const excluded = /\.(?:smoke|test|spec|selftest)\.|\/smoke\/|\/test\/|\/__tests__\/|\.d\.ts$|^packages\/smoke-kit\//;

const files = execFileSync("git", ["ls-files", "-z", "--", "packages", "implementations", "extensions"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((name) => source.test(name) && !excluded.test(name));

// The doc blocks of a file, in source order. Comments live only in the trivia before a token, so
// this walks the parser's tokens and scans that trivia: a `/**` inside a string, a template literal,
// JSX text or another comment is text, never a doc block.
function docBlocks(name, text) {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const isTrivia = (kind) => kind >= ts.SyntaxKind.FirstTriviaToken && kind <= ts.SyntaxKind.LastTriviaToken;
  const blocks = [];
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (!ts.isToken(node)) return node.getChildren(file).forEach(visit);
    if (ts.isJsxText(node)) return;
    scanner.resetTokenState(node.pos);
    for (let kind = scanner.scan(); isTrivia(kind); kind = scanner.scan()) {
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      if (kind === ts.SyntaxKind.MultiLineCommentTrivia && text.startsWith("/**", start) && !text.startsWith("/**/", start))
        blocks.push({ start, end });
    }
  };
  visit(file);
  return blocks;
}

const failures = [];
for (const name of files) {
  const text = readFileSync(`${root}/${name}`, "utf8");
  const line = (offset) => text.slice(0, offset).split("\n").length;
  const blocks = docBlocks(name, text);
  for (let i = 0; i + 1 < blocks.length; i++) {
    const [block, next] = [blocks[i], blocks[i + 1]];
    const before = text.slice(text.lastIndexOf("\n", block.start - 1) + 1, block.start);
    const between = text.slice(block.end, next.start);
    if (before.trim() === "" && between.trim() === "" && between.split("\n").length === 2)
      failures.push(`${name}:${line(block.start)}: doc block is followed by another doc block at line ${line(next.start)}, so it documents nothing`);
  }
}

if (failures.length) {
  console.error(
    "Doc comment check failed. Move each block above the declaration it documents, merge it into the block below, or delete it:\n" +
      failures.map((line) => `  ${line}`).join("\n"),
  );
  process.exit(1);
}

console.log(`check:doc-comments: ${files.length} source files passed`);

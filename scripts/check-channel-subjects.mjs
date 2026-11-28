import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = /^(?:(?:packages|implementations|extensions|examples)\/[^/]+\/(?:src|bin)\/|(?:bin|desktop|website)\/).*\.(?:[cm]?[jt]s|[jt]sx)$/;
const excluded = /(?:^|\/)(?:docs|smoke|tests?|__tests__|fixtures|dist|vendor|node_modules)\/|\.(?:smoke|test|spec|selftest)\.|\.d\.[cm]?ts$|^packages\/smoke-kit\//;
const central = /^packages\/core\/src\/(?:subjects|subject-grammar)\.ts$/;
const address = /(?:^\.chat\.|\bcotal\.[^.\s]+\.chat\.)/;
const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root, encoding: "utf8", windowsHide: true,
}).split("\0").filter((name) => source.test(name) && !excluded.test(name) && !central.test(name));

function check(name) {
  const text = readFileSync(join(root, name), "utf8");
  if (!text.includes("chat")) return;
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest);
  function visit(node) {
    const literal = (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && address.test(node.text);
    const pattern = ts.isRegularExpressionLiteral(node) && node.text.includes("\\.chat\\.");
    if (literal || pattern) {
      const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
      console.error(`${name}:${line + 1}:${character + 1}: use a central channel subject builder or parser`);
      process.exitCode = 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

for (const name of new Set(names)) check(name);
if (!process.exitCode) console.log("check:channel-subjects: all channel address literals are centralized");

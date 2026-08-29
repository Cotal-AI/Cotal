import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));

// docs/design holds working lane documents: frozen review artifacts with their
// own vocabulary. The published-docs voice gate deliberately does not apply
// there. Every other subdirectory of docs/ is scanned.
const exemptDirs = new Set(["design"]);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = relative(docsDir, path);
    if (statSync(path).isDirectory()) {
      if (exemptDirs.has(rel)) continue;
      walk(path);
    } else if (name.endsWith(".md")) {
      files.push(rel);
    }
  }
};
walk(docsDir);

const bannedWord = /\b(?:exactly|fold|folds|folded)\b/i;
const listHeading = /(?:&|,| \/ | \+ |\band\b|\bor\b|:)/i;
const failures = [];

for (const name of files) {
  const lines = readFileSync(join(docsDir, name), "utf8").split("\n");
  let fenced = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^ {0,3}```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    if (line.includes("—")) failures.push(`${name}:${index + 1}: em dash`);
    const word = bannedWord.exec(line);
    if (word) failures.push(`${name}:${index + 1}: banned filler word ${JSON.stringify(word[0])}`);

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading && listHeading.test(heading[2]))
      failures.push(`${name}:${index + 1}: heading reads as a list: ${heading[2]}`);
  }
}

if (failures.length) {
  console.error("Docs voice check failed:\n" + failures.map((line) => `  ${line}`).join("\n"));
  process.exit(1);
}

console.log(`check:docs-voice: ${files.length} pages passed (docs/design exempt)`);

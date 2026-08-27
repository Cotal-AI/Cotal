import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const docsDir = new URL("../docs/", import.meta.url);
const files = readdirSync(docsDir)
  .filter((name) => name.endsWith(".md"))
  .sort();

const bannedWord = /\b(?:exactly|fold|folds|folded)\b/i;
const listHeading = /(?:&|,| \/ | \+ |\band\b|\bor\b|:)/i;
const failures = [];

for (const name of files) {
  const lines = readFileSync(new URL(name, docsDir), "utf8").split("\n");
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

console.log(`check:docs-voice: ${files.length} pages passed`);

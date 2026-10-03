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

const failures = [];
for (const name of files) {
  const lines = readFileSync(`${root}/${name}`, "utf8").split("\n");
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start].trimStart().startsWith("/**")) continue;
    let end = start;
    let rest = lines[start].slice(lines[start].indexOf("/**") + 3);
    while (!rest.includes("*/") && end + 1 < lines.length) rest = lines[++end];
    const after = rest.slice(rest.indexOf("*/") + 2).trim();
    if (after === "" && lines[end + 1]?.trimStart().startsWith("/**"))
      failures.push(`${name}:${start + 1}: doc block is followed by another doc block at line ${end + 2}, so it documents nothing`);
    start = end;
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

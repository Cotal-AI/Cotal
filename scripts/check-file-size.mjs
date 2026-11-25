import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const allowlistPath = new URL("./file-size-allowlist.json", import.meta.url);
const updateCommand = "pnpm check:file-size:update";
const limit = 1500;
const source = /^(?:(?:packages|implementations|extensions)\/[^/]+\/src\/|bin\/(?!scripts\/)).*\.(?:[cm]?[jt]s|[jt]sx)$/;
const excluded = /(?:^|\/)(?:smoke|tests?|__tests__|mutations|dist|node_modules|vendor)\/|\.(?:smoke|test|spec|selftest|generated)\.|\.d\.[cm]?ts$|^packages\/smoke-kit\//;

// Counts lines as an editor numbers them: a last line without a newline still counts.
function lineCount(text) {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function readAllowlist() {
  const value = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (value.version !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files))
    throw new Error("invalid file-size allowlist header");
  for (const [name, count] of Object.entries(value.files)) {
    if (!source.test(name) || excluded.test(name) || !Number.isSafeInteger(count) || count <= limit)
      throw new Error(`invalid allowlist row: ${name}`);
  }
  return value.files;
}

function writeAllowlist(files) {
  const rows = Object.entries(files).map(([name, count]) => `    ${JSON.stringify(name)}: ${count}`);
  writeFileSync(allowlistPath, `{\n  "version": 1,\n  "files": {\n${rows.join(",\n")}\n  }\n}\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--update-allowlist"))
    throw new Error("usage: node scripts/check-file-size.mjs [--update-allowlist]");
  const names = execFileSync("git", ["ls-files", "-z", "--", "packages", "implementations", "extensions", "bin"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter((name) => source.test(name) && !excluded.test(name)).sort();
  const counts = new Map(names.map((name) => [name, lineCount(readFileSync(join(root, name), "utf8"))]));
  const over = Object.fromEntries([...counts].filter(([, count]) => count > limit));
  if (args.length) {
    writeAllowlist(over);
    console.log(`check:file-size: allowlist rewritten for ${Object.keys(over).length} files over ${limit} lines`);
    return;
  }
  const allowed = readAllowlist();
  const failures = [];
  const notes = [];
  for (const [name, recorded] of Object.entries(allowed)) {
    const count = counts.get(name);
    if (count === undefined) notes.push(`${name}: not a tracked source file; its row can go: ${updateCommand}`);
    else if (count <= limit) notes.push(`${name}: ${count} lines, at or under ${limit}; its row can go: ${updateCommand}`);
    else if (count < recorded) notes.push(`${name}: ${recorded} -> ${count} lines; record the new count: ${updateCommand}`);
    else if (count > recorded) failures.push(`${name}: ${recorded} -> ${count} lines; a listed file may not grow`);
  }
  for (const [name, count] of Object.entries(over)) {
    if (!Object.hasOwn(allowed, name)) failures.push(`${name}: ${count} lines, over the ${limit}-line limit`);
  }
  if (notes.length) console.log("check:file-size notes:\n" + notes.map((line) => `  ${line}`).join("\n"));
  if (failures.length) {
    console.error("File size check failed:\n" + failures.map((line) => `  ${line}`).join("\n") +
      `\nPut new code in a new module. After a reviewed split or move, rewrite the counts with: ${updateCommand}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check:file-size: ${names.length} source files passed (${Object.keys(over).length} over ${limit} lines, all listed)`);
}

try {
  main();
} catch (error) {
  console.error(`check:file-size: ${error.message}`);
  process.exitCode = 2;
}

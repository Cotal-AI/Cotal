import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const allowlistPath = new URL("./function-length-allowlist.json", import.meta.url);
const updateCommand = "pnpm check:function-length:update";
const limit = 150;
const source = /^(?:(?:packages|implementations|extensions)\/[^/]+\/src\/|bin\/(?!scripts\/)).*\.(?:[cm]?[jt]s|[jt]sx)$/;
const excluded = /(?:^|\/)(?:smoke|tests?|__tests__|mutations|dist|node_modules|vendor)\/|\.(?:smoke|test|spec|selftest|generated)\.|\.d\.[cm]?ts$|^packages\/smoke-kit\//;

function scriptKind(name) {
  if (name.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (name.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.[cm]?ts$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function isFunction(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function nameOf(node, file) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const holder = node.parent;
  const named = node.name ?? (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder) ? holder.name : undefined);
  return named ? named.getText(file) : "(anonymous)";
}

// A function's lines run from its first token to its closing token, so a doc comment above it does
// not count. A nested function counts on its own as well as inside the function that holds it.
function longFunctions(name, text) {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, scriptKind(name));
  const lineOf = (position) => file.getLineAndCharacterOfPosition(position).line + 1;
  const found = [];
  const visit = (node) => {
    if (isFunction(node) && node.body) {
      const line = lineOf(node.getStart(file));
      const length = lineOf(node.end) - line + 1;
      if (length > limit) found.push({ name: nameOf(node, file), line, length });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.sort((a, b) => b.length - a.length || a.line - b.line);
}

function readAllowlist() {
  const value = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (value.version !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files))
    throw new Error("invalid function-length allowlist header");
  for (const [name, lengths] of Object.entries(value.files)) {
    const valid = Array.isArray(lengths) && lengths.length > 0 &&
      lengths.every((length, index) => Number.isSafeInteger(length) && length > limit && (index === 0 || length <= lengths[index - 1]));
    if (!source.test(name) || excluded.test(name) || !valid) throw new Error(`invalid allowlist row: ${name}`);
  }
  return value.files;
}

function writeAllowlist(files) {
  const rows = Object.entries(files).map(([name, lengths]) => `    ${JSON.stringify(name)}: [${lengths.join(", ")}]`);
  writeFileSync(allowlistPath, `{\n  "version": 1,\n  "files": {\n${rows.join(",\n")}\n  }\n}\n`);
}

// A listed file passes while it has no more long functions than its row and each one, longest
// first, is no longer than the row's entry at that position.
function grade(name, recorded, current) {
  const lengths = current.map((fn) => fn.length);
  const shown = current.map((fn) => `${fn.name} ${fn.length} (line ${fn.line})`).join(", ");
  const change = `[${recorded.join(", ")}] -> [${lengths.join(", ")}] lines`;
  if (lengths.length > recorded.length)
    return { failure: `${name}: ${lengths.length} functions over ${limit} lines, its row lists ${recorded.length}: ${shown}` };
  if (lengths.some((length, index) => length > recorded[index]))
    return { failure: `${name}: ${change}; a listed function may not grow: ${shown}` };
  if (!lengths.length) return { note: `${name}: no function over ${limit} lines; its row can go: ${updateCommand}` };
  if (lengths.join() !== recorded.join()) return { note: `${name}: ${change}; record the new lengths: ${updateCommand}` };
  return {};
}

function scan() {
  const names = execFileSync("git", ["ls-files", "-z", "--", "packages", "implementations", "extensions", "bin"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter((name) => source.test(name) && !excluded.test(name)).sort();
  const long = new Map();
  for (const name of names) {
    const found = longFunctions(name, readFileSync(join(root, name), "utf8"));
    if (found.length) long.set(name, found);
  }
  return { names, long };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--update-allowlist"))
    throw new Error("usage: node scripts/check-function-length.mjs [--update-allowlist]");
  const { names, long } = scan();
  if (args.length) {
    writeAllowlist(Object.fromEntries([...long].map(([name, found]) => [name, found.map((fn) => fn.length)])));
    console.log(`check:function-length: allowlist rewritten for ${long.size} files with a function over ${limit} lines`);
    return;
  }
  const allowed = readAllowlist();
  const tracked = new Set(names);
  const failures = [];
  const notes = [];
  for (const [name, recorded] of Object.entries(allowed)) {
    const { failure, note } = tracked.has(name)
      ? grade(name, recorded, long.get(name) ?? [])
      : { note: `${name}: not a tracked source file; its row can go: ${updateCommand}` };
    if (failure) failures.push(failure);
    if (note) notes.push(note);
  }
  for (const [name, found] of long) {
    if (Object.hasOwn(allowed, name)) continue;
    for (const fn of found) failures.push(`${name}:${fn.line}: ${fn.name} is ${fn.length} lines, over the ${limit}-line limit`);
  }
  if (notes.length) console.log("check:function-length notes:\n" + notes.map((line) => `  ${line}`).join("\n"));
  if (failures.length) {
    console.error("Function length check failed:\n" + failures.map((line) => `  ${line}`).join("\n") +
      `\nSplit the function at its sections, or put new code in a new function. After a reviewed split, rewrite the lengths with: ${updateCommand}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check:function-length: ${names.length} source files passed (${long.size} hold a function over ${limit} lines, all listed)`);
}

try {
  main();
} catch (error) {
  console.error(`check:function-length: ${error.message}`);
  process.exitCode = 2;
}

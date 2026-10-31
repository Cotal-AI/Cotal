import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Run the actual checker, byte-for-byte, against tracked fixture inputs in a private repository.
// No production file or checker implementation is modified by these controls.
const root = mkdtempSync(join(tmpdir(), "doc-comments-"));
const checker = fileURLToPath(new URL("./check-doc-comments.mjs", import.meta.url));
const input = "packages/probe/src/example.tsx";
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
let passed = 0;
let failed = 0;
function check(name, condition) {
  console.log(`  ${condition ? "✓" : "x FAIL:"} ${name}`);
  if (condition) passed++;
  else failed++;
}
function git(...args) {
  const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("fixture git setup failed", { cause: result.error });
}

const cases = [
  { name: "one closed doc block", text: "/** Main documentation. */\nexport const value = 1;", accept: true },
  { name: "adjacent closed blocks", text: "/** Stale. */\n/** Real. */\nexport const value = 1;", accept: false, reason: "followed by another doc block" },
  { name: "string literal", text: 'export const value = "/** stale /** real";', accept: true },
  { name: "template literal", text: 'export const value = `/** stale\n/** real`;', accept: true },
  { name: "JSX text", text: 'export const value = <pre>/** stale /** real</pre>;', accept: true },
  { name: "ordinary comment", text: '/* Text containing /** is not a doc block. */\nexport const value = 1;', accept: true },
  { name: "escaped example opener", text: '/** @example Use &#47;** to start documentation. */\nexport const value = 1;', accept: true },
  { name: "inline swallowed opener", text: '/** Stale. /** Real. */\nexport const value = 1;', accept: false, reason: "contains another doc opener" },
  { name: "literal example opener follows the documented rule", text: '/** @example\n * ```ts\n * /** quoted opener\n * ```\n */\nexport const value = 1;', accept: false, reason: "contains another doc opener" },
  { name: "unterminated at EOF", text: '/** Missing closing delimiter', accept: false, reason: "is not closed", syntaxError: true },
  ...["\n", "\r\n", "\r", " ", " "].map((newline) => ({
    name: `swallowed opener with ${JSON.stringify(newline)} and nonbreaking-space indentation`,
    text: `/** Stale.${newline} /** Real. */${newline}export const value = 1;`,
    accept: false,
    reason: "contains another doc opener",
    line: 2,
  })),
];

try {
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "packages/probe/src"), { recursive: true });
  copyFileSync(checker, join(root, "scripts/check-doc-comments.mjs"));
  check("fixture runs the unchanged checker bytes", readFileSync(checker).equals(readFileSync(join(root, "scripts/check-doc-comments.mjs"))));
  symlinkSync(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), join(root, "node_modules/typescript"), "junction");
  git("init", "--quiet", "--template=");
  writeFileSync(join(root, input), "");
  git("add", "--", input);
  for (const cell of cases) {
    writeFileSync(join(root, input), cell.text);
    const source = ts.createSourceFile(input, cell.text, ts.ScriptTarget.Latest);
    check(`${cell.name}: syntax control`, (source.parseDiagnostics.length > 0) === (cell.syntaxError === true));
    const result = spawnSync(process.execPath, [join(root, "scripts/check-doc-comments.mjs")], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    const expected = cell.accept ? 0 : 1;
    check(`${cell.name}: checker ${cell.accept ? "accepts" : "refuses"}`, !result.error && result.status === expected &&
      (cell.accept ? result.stdout.includes("1 source files passed") : result.stderr.includes(cell.reason)));
    if (cell.line !== undefined) check(`${cell.name}: diagnostic line`, result.stderr.includes(`${input}:${cell.line}:`));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`doc-comment controls: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

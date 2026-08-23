/** Every persona this repo SHIPS declares the channels it reads.
 *
 *  The writer refuses a definition with no read set, which binds every caller that builds an
 *  AgentDef and saves it. Setup does not: it writes its persona files as literal template strings,
 *  so the writer's guard cannot see them and a template that omits the field would ship a persona
 *  whose read set is a guess. This suite is the other half of that coverage.
 *
 *  It also enumerates the writers by OUTPUT PATH rather than by function name. Name-based searches
 *  missed setup twice, because a writer can call any helper it likes but must eventually name the
 *  directory it writes into. A new writer that appears here is not assumed wrong; it has to be
 *  listed deliberately, which is the point.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) {
    fail++;
    console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
    return;
  }
  pass++;
  console.log(`  ✓ ${name}`);
};

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const setupSrc = readFileSync(join(repoRoot, "implementations/cli/src/commands/setup.ts"), "utf8");

// Every frontmatter block in setup's template literals. Anchored on the fences and on a `name:`
// line ANYWHERE inside, not on the block starting with one: the managed-marker comment precedes
// `name:` in the guided team's templates, and anchoring on the first line silently matched only
// the one template that happens to start with it.
const blocks = [...setupSrc.matchAll(/---\n([\s\S]*?)\n---/g)]
  .map((m) => m[1])
  .filter((b) => /^name: /m.test(b));
ok("setup ships at least the default persona plus the guided team", blocks.length >= 4, blocks.length);

for (const raw of blocks) {
  // Drop the `${MANAGED_MARKER}` interpolation line: it is a source-level expression, not YAML, and
  // becomes a `#` comment only once the template is rendered. Reading the source means reading it
  // before interpolation, so the suite has to skip what the file will not contain at runtime.
  const block = raw
    .split("\n")
    .filter((l) => !l.includes("${") && !l.trimStart().startsWith("#"))
    .join("\n");
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(block) as Record<string, unknown>;
  } catch (e) {
    ok(`a shipped template parses as YAML`, false, String(e).slice(0, 120));
    continue;
  }
  const name = String(fm.name ?? "(unnamed)");
  ok(`${name} declares the channels it reads`, Array.isArray(fm.subscribe), fm.subscribe);
  // allowSubscribe defaults to subscribe and allowPublish is default-deny, so neither is required;
  // what must not happen is a shipped persona whose READ SET is left to a default.
}

// The writer enumeration, by output path. Each entry is a file that names an agents directory AND
// writes to it. Readers and path helpers are not listed. A new one fails this cell until someone
// decides which half of the coverage it belongs to: the writer guard, or a template assertion.
const KNOWN_WRITERS = [
  "packages/core/src/agent-file.ts", // saveAgentFile — guards itself
  "implementations/cli/src/commands/setup.ts", // literal templates — asserted above
];
const searched = ["packages/core/src", "packages/workspace/src", "implementations", "extensions", "bin"];
const found = new Set<string>();
const walk = (dir: string) => {
  let entries;
  try {
    entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "smoke") continue;
      walk(rel);
      continue;
    }
    if (!e.name.endsWith(".ts") || e.name.endsWith(".generated.ts")) continue;
    const src = readFileSync(join(repoRoot, rel), "utf8");
    // A writer NAMES a catalog path and WRITES on the same expression. Testing the two conditions
    // file-wide instead flags any file that mentions the catalog anywhere and writes anything
    // anywhere - which is how a persona READER that happens to write an unrelated file, or a caller
    // that delegates the write to saveAgentFile, was counted as a writer. Match the call itself.
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(i, i + 3).join("\n");
      const isWrite = /\bwriteFileSync\(/.test(window);
      if (!isWrite) continue;
      // `agent-file.ts` writes the path it was HANDED, so the call site names no directory. It is
      // the shared writer every other caller routes through, so match it by what it is rather than
      // failing to see the one file the whole guard rests on.
      const target =
        /["'`]agents["'`]|\.cotal\/agents|agentFilePath\(|cotalPath\("agents"/.test(window) ||
        /export function saveAgentFile/.test(src);
      if (target) found.add(rel);
    }
  }
};
for (const d of searched) walk(d);
const unexpected = [...found].filter((f) => !KNOWN_WRITERS.includes(f));
ok("no unlisted writer into the persona catalog", unexpected.length === 0, unexpected);
for (const w of KNOWN_WRITERS) ok(`${w} is still a writer (the search still finds it)`, found.has(w));

console.log(`\npersona templates: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

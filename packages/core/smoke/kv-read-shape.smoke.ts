/**
 * Shape guard: no source file may read a KV bucket by enumerating keys and then fetching each
 * key's value.
 *
 * That pairing costs one `STREAM.MSG.GET` round trip PER KEY, sequentially. It is invisible against
 * a loopback broker and catastrophic anywhere else: 89 membership keys measured 30-34 seconds
 * against a mesh at 534ms RTT. `liveKvEntries` reads the same data in one pass, and additionally
 * refuses to return a partial view when the pass is cut short. Both properties are lost the moment
 * someone open-codes the old shape again, and nothing about it looks wrong in review.
 *
 * The repo has no linter, so this is that lint rule, written the way this repo enforces things.
 *
 * ## What is matched, and what deliberately is not
 *
 * The offence is the PAIRING, not `.keys()`. `Map`/`Set`/`Object.keys()` are everywhere in this
 * codebase, so matching bare `.keys()` would be a false-positive machine that gets suppressed and
 * then ignored. Two things narrow it to a KV read:
 *
 *   - `await` before `.keys()` — you do not await a Map.
 *   - a `.get(...)` inside the loop body whose argument mentions the loop variable — that is what
 *     makes it one round trip per key rather than a bulk read.
 *
 * So `membership-feed.ts`, which walks key NAMES with no per-key fetch, stays green: it does not
 * pay the per-key cost and has nothing to gain from the single pass.
 *
 * Broker-free. Run: pnpm smoke:kv-read-shape
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** First-party source only: the shipped `src` of every workspace package, plus the binary. */
const roots = [
  ...["packages", "implementations", "extensions"].flatMap((group) => {
    const groupDir = join(repoRoot, group);
    let names: string[] = [];
    try { names = readdirSync(groupDir); } catch { return []; }
    return names.map((n) => join(groupDir, n, "src")).filter((p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    });
  }),
  join(repoRoot, "bin"),
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The loop header: `for await (const <k> of await <something>.keys())`, up to its opening brace. */
const LOOP = /for\s+await\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+await\s+[A-Za-z_$][\w$.]*\.keys\(\s*\)\s*\)\s*\{/g;

/** The body of a block that starts at `open` (the index of its `{`), by brace matching. */
function blockBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1); // unbalanced (should not happen in code that compiles)
}

/** A `.get(` call in `body` whose argument mentions `loopVar` — the per-key fetch. */
function fetchesPerKey(body: string, loopVar: string): boolean {
  const usesVar = new RegExp(`\\b${loopVar}\\b`);
  for (const m of body.matchAll(/\.get\(/g)) {
    const arg = body.slice(m.index + m[0].length, m.index + m[0].length + 120);
    if (usesVar.test(arg.split(")")[0] ?? "")) return true;
  }
  return false;
}

const offenders: string[] = [];
let scanned = 0;
for (const root of roots) {
  for (const file of tsFiles(root)) {
    scanned++;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(LOOP)) {
      const open = m.index + m[0].length - 1;
      if (!fetchesPerKey(blockBody(src, open), m[1]!)) continue;
      offenders.push(`${relative(repoRoot, file)}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
}

if (offenders.length) {
  console.error("✗ a KV bucket is being read one key at a time - that is O(N) round trips:");
  for (const o of offenders) console.error(`  - ${o}`);
  console.error("\n  Use liveKvEntries (packages/core/src/kv-scan.ts): one pass, and it throws");
  console.error("  IncompleteKvScan rather than returning a partial view when the pass is cut short.");
  process.exit(1);
}

console.log(`kv-read-shape smoke: ${scanned} source files scanned, 0 read a KV bucket key-by-key`);
process.exit(0);

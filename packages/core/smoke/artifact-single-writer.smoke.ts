/**
 * ONE attachment writer, proven by sweeping the source — and the sweep proves ITSELF first.
 *
 * WHY THIS EXISTS. Gating the expensive confirm-time checks on artifact-part presence is a
 * throughput win only if an attachment row cannot be written by any path that skips them. A second
 * writer turns that gate from an optimisation into a hole, and it would be invisible: every suite
 * stays green because the intended path still works.
 *
 * WHY IT IS BUILT NOW, BEFORE THE SURFACE IS FINISHED. A sweep is a pattern-based guard, and a
 * pattern whose universe does not match the thing it claims to cover reports a confident wrong
 * answer that nobody re-checks. This lane has produced three instances of exactly that — a suite
 * file outside `gate-inventory`'s reach, a single-writer grep that needed a positive control, and a
 * cell counter matching one of two construction forms. So this instrument is built while the right
 * answer is KNOWN: there is exactly one writer today. A pattern that finds zero, or finds something
 * unexpected, is immediately legible as a broken instrument rather than as a clean result.
 *
 * VALIDATE THE INSTRUMENT WHERE THE ANSWER IS KNOWN, THEN USE IT WHERE IT IS NOT.
 *
 * OWED: this proves nothing about the put/fetch chunk verbs, which do not exist yet. It must be
 * re-run as an explicit obligation on the Step 5 completion commit — see the plan's §10. A passing
 * sweep from before those verbs existed must never be read as covering them.
 *
 * Run: pnpm smoke:artifact-single-writer
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const SRC_ROOTS = ["packages", "implementations", "extensions", "bin"];

/** Every production TypeScript file: no smokes, no dist, no node_modules. */
const productionFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist" || e === ".git") continue;
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts")) continue;
      if (p.includes("/smoke/") || p.endsWith(".smoke.ts") || p.endsWith("/smoke.ts")) continue;
      out.push(p);
    }
  };
  for (const r of SRC_ROOTS) walk(join(ROOT, r));
  return out;
};

const files = productionFiles();
console.log(`single-writer sweep over ${files.length} production files\n`);

// The instrument's universe, asserted rather than assumed. A sweep over an empty or tiny file set
// reports "no second writer" for the same reason a correct codebase does.
check("the sweep's universe is non-trivial", files.length > 100, files.length);
check("and it reaches this package's source",
  files.some((f) => f.endsWith("packages/core/src/artifact-attach.ts")), files.length);

// An INVOCATION, not the interface declaration — `putAttachment(...)` in the deps interface is a
// type, not a write.
const INVOCATION = /\.putAttachment\s*\(/;
const callSites = files.filter((f) => INVOCATION.test(readFileSync(f, "utf8")));

// ---- THE POSITIVE CONTROL — before any zero is believed ----------------------------------------
// If the pattern cannot see the ONE writer we know exists, then "no other writers" is a statement
// about a broken regex, not about the codebase. This must pass for the next cell to mean anything.
check("POSITIVE CONTROL: the sweep FINDS the known writer (confirmAttach)",
  callSites.some((f) => f.endsWith("packages/core/src/artifact-attach.ts")),
  callSites.map((f) => relative(ROOT, f)));

// ---- and only that one --------------------------------------------------------------------------
check("exactly ONE production call site writes an attachment row",
  callSites.length === 1, callSites.map((f) => relative(ROOT, f)));

// ---- the named paths that must never write ------------------------------------------------------
// Enumerated by name so a future reader meets the list rather than re-deriving it. Each of these
// touches the same messages and would be a plausible place to "helpfully" attach.
const MUST_NOT_WRITE = [
  "packages/core/src/endpoint.ts",      // fanOutMessage's durable + live arms, catch-up copy, DLV reader, readHistory
  "packages/core/src/artifact-index.ts",// key grammar only
  "packages/core/src/artifact-fetch.ts",// the read gate
  "packages/core/src/artifact-chunk.ts",// sizing
];
for (const rel of MUST_NOT_WRITE) {
  const f = files.find((x) => x.endsWith(rel));
  check(`${rel} writes no attachment row`,
    f !== undefined && !INVOCATION.test(readFileSync(f, "utf8")),
    f === undefined ? "FILE NOT FOUND — the sweep's universe is wrong, not the codebase" : "has a call site");
}

console.log(`\nartifact-single-writer: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

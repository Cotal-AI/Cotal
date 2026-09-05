/**
 * After #964, a plain `Manager.stop()` detaches managed seats. A smoke that spawns a real
 * PTY child and then spare-stops leaks that child unless something else reaps it.
 *
 * This guard reddens a live-PTY smoke teardown that still calls `.stop()` without
 * `{ withAgents: true }`. Suites that ASSERT the spare path are named below; they are
 * the coverage, not the leak. A planted fixture proves the search can still see the
 * banned form: a grep that finds nothing and a grep that cannot find anything print
 * the same zero.
 *
 * Run: pnpm smoke:manager-stop-spare-guard
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SELF = "bin/smoke/manager-stop-spare-guard.smoke.ts";
const SKIP = new Set(["node_modules", "dist", ".git", ".changeset", "coverage", "build", ".internal"]);

/** Suites whose job is to prove the spare path. Each is named, not found by silence. */
const SPARE_COVERAGE = new Set([
  "bin/smoke/manager-stop-reaps-agents.smoke.ts",
  "implementations/manager/smoke/start-model-preflight.smoke.ts",
  "implementations/manager/smoke/preserve-state.smoke.ts",
  "implementations/manager/smoke/lease-loss-keeps-serving.smoke.ts",
]);

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

function smokeSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) smokeSources(p, out);
    else if (p.endsWith(".ts") && /(^|\/)smoke\//.test(relative(ROOT, p)) && !relative(ROOT, p).startsWith("bin/smoke/fixtures/") && relative(ROOT, p) !== SELF) out.push(p);
  }
  return out;
}

/** A Manager.stop / mgr.stop / m1?.stop call whose argument list does not pass withAgents: true.
 *  Identifier class is the manager-shaped names smokes actually use. delivery/broker/ep stops
 *  are not this hazard. */
const SPARE_STOP = /(?:await\s+)?(?:manager|mgr|mgr[0-9A-Z]|m[0-9]|adopting|openMgr|hung|first|next|live|corpse|booting|replacement)\??\.stop\(\s*(?:\{\s*(?!.*withAgents\s*:\s*true)[^}]*\}\s*)?\)/g;

function livePty(text: string): boolean {
  if (!/\bnew\s+Manager\s*\(/.test(text)) return false;
  if (!/\.startAgent\s*\(/.test(text) && !/\bspawnSeat\s*\(/.test(text)) return false;
  if (/\bkind:\s*"fake"/.test(text)) return false;
  return /\bruntime:\s*"pty"/.test(text) || /\bpty\.spawn\s*\(/.test(text);
}

function spareStops(text: string): string[] {
  return [...text.matchAll(SPARE_STOP)].map((m) => m[0].replace(/\s+/g, " ").trim());
}

const files = smokeSources(ROOT);
check("the walk finds a non-trivial population of smoke sources", files.length >= 50, `found ${files.length}`);

const planted = join(ROOT, "bin", "smoke", "fixtures", "manager-stop-spare.planted.ts");
const plantedText = readFileSync(planted, "utf8");
check("the planted control looks like a live-PTY Manager smoke", livePty(plantedText), plantedText.slice(0, 120));
check("the planted control carries a spare stop and the regex sees it", spareStops(plantedText).length > 0, spareStops(plantedText));

const hits: string[] = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  if (SPARE_COVERAGE.has(rel)) continue;
  const text = readFileSync(f, "utf8");
  if (!livePty(text)) continue;
  const found = spareStops(text);
  if (found.length) hits.push(`${rel}: ${found.join(" | ")}`);
}

check(`no live-PTY smoke spare-stops a Manager (${files.length} files walked)`, hits.length === 0, hits);

for (const named of SPARE_COVERAGE) {
  check(`spare-coverage suite is present: ${named}`, files.some((f) => relative(ROOT, f) === named), named);
}

console.log(`\nMANAGER-STOP-SPARE-GUARD ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;

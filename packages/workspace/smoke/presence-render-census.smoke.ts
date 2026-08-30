import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Classification = "honest-text" | "presence-only-glyph/count" | "command-ack" | "non-render/control";
type Entry = {
  path: string;
  anchor: string;
  class: Classification;
  rationale: string;
  proof?: { path: string; anchor: string };
};
type Manifest = {
  expected: Record<"total" | Classification, number>;
  entries: Entry[];
};
type Candidate = { path: string; anchor: string };

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "presence-render-sinks.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const sourceRoots = ["packages", "extensions", "implementations"]
  .flatMap((top) => readdirSync(join(root, top), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, top, entry.name, "src")))
  .filter((path) => { try { return statSync(path).isDirectory(); } catch { return false; } })
  .concat(join(root, "bin"));
const skipDirs = new Set(["dist", "smoke", "test", "tests", "fixtures", "node_modules"]);
const sourceExt = /\.(?:ts|tsx|js|mjs|mts)$/;

function* shippedSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* shippedSources(path);
    else if (sourceExt.test(entry.name) && !/\.generated\./.test(entry.name) && !/\.d\.ts$/.test(entry.name) && statSync(path).size < 2_000_000)
      yield path;
  }
}

/** Candidate syntax, deliberately broader than a literal `working` search. False positives are
 * classified as non-render/control; the gate's job is exhaustive review, not automatic judgement. */
const candidateSyntax = [
  /\bstatusBadge\s*\(/,
  /\bhonestStatus\s*\(/,
  /\bSTATUS\s*\[[^\]]+\]/,
  /\bGLYPH\s*\[[^\]]*(?:p|c|m|sel)\.status[^\]]*\]/,
  /\bcounts\s*\[[^\]]*(?:p|c|m|sel)\.status[^\]]*\]/,
  /\b(?:r\.mesh|status|(?:p|c|m|sel|agent)\.status)\s*===\s*["']working["']/,
  /\$\{[^}\n]*(?:p|c|m|sel|cand|agent)\.status\b[^}\n]*\}/,
  /\besc\s*\([^\n)]*(?:p|c|m|sel|cand|agent)\.status\b/,
  /\bstatus=\{[^}\n]*(?:p|mesh)\.status\b/,
];

function uniqueAnchor(body: string, lines: string[], index: number): string {
  for (let radius = 0; radius < 8; radius++) {
    const start = Math.max(0, index - radius);
    const end = Math.min(lines.length, index + radius + 1);
    const anchor = lines.slice(start, end).join("\n");
    if (body.split(anchor).length - 1 === 1) return anchor;
  }
  throw new Error(`candidate line cannot be given a unique stable anchor: ${lines[index]}`);
}

const candidates: Candidate[] = [];
for (const sourceRoot of sourceRoots) {
  for (const file of shippedSources(sourceRoot)) {
    const path = relative(root, file).split("\\").join("/");
    const body = readFileSync(file, "utf8");
    const lines = body.split("\n");
    for (const [index, raw] of lines.entries()) {
      if (raw.trim() && candidateSyntax.some((pattern) => pattern.test(raw)))
        candidates.push({ path, anchor: uniqueAnchor(body, lines, index) });
    }
  }
}
const candidateKeys = new Set(candidates.map((candidate) => `${candidate.path}\u0000${candidate.anchor}`));
assert.equal(candidateKeys.size, candidates.length, "scanner produced a duplicate path+anchor candidate");
assert.ok(candidates.length > 0, "presence render census found no shipped-source candidates; the scanner is broken");

const sharedStatusBadgeAnchor = 'return c.green("● working · progress unknown");';
const connectorHonestStatusAnchor = 'status === "working" ? "working · progress unknown" : status;';
const connectorRosterProgressAnchor = 'const progress = p.status === "working" ? "working · progress unknown" : p.status;';
const inkDetailStatusAnchor = '<Text color={s.color}>{s.dot + " " + s.word + (status === "working" ? " · progress unknown" : "")}</Text>';
const inkRosterProgressAnchor = 'return progressSignal(undefined, Date.now()).kind === "unknown" ? "progress unknown" : "progress observed";';
const webMonitorProgressAnchor = 'const progress = p.status === "working" && p.progress?.kind === "unknown" ? "working · progress unknown" : p.status;';
const webGraphProgressAnchor = '<div class="d-status ${sel.status}"><span class="dot"></span>${esc(sel.status === "working" && sel.progress?.kind === "unknown" ? "working · progress unknown" : sel.status)}</div>';

const proofAnchors = new Map<string, string>([
  ["extensions/connector-core/src/orientation.ts", connectorHonestStatusAnchor],
  ["extensions/connector-core/src/tool-specs.ts", connectorRosterProgressAnchor],
  ["implementations/cli/src/ui.ts", sharedStatusBadgeAnchor],
  ["implementations/cli/src/console/ui/Detail.tsx", inkDetailStatusAnchor],
  ["implementations/cli/src/console/ui/Roster.tsx", inkRosterProgressAnchor],
  ["implementations/web/src/web/app.js", webMonitorProgressAnchor],
  ["implementations/web/src/web/graph.js", webGraphProgressAnchor],
]);

const entryKeys = new Set<string>();
const counts: Record<Classification, number> = {
  "honest-text": 0,
  "presence-only-glyph/count": 0,
  "command-ack": 0,
  "non-render/control": 0,
};
for (const entry of manifest.entries) {
  assert.ok(entry.rationale.trim().length >= 12, `manifest rationale is missing or too short for ${entry.path}: ${entry.anchor}`);
  const key = `${entry.path}\u0000${entry.anchor}`;
  assert.ok(!entryKeys.has(key), `manifest duplicates candidate ${entry.path}: ${entry.anchor}`);
  entryKeys.add(key);
  const body = readFileSync(join(root, entry.path), "utf8");
  assert.equal(body.split(entry.anchor).length - 1, 1, `manifest anchor must exist exactly once in ${entry.path}: ${entry.anchor}`);
  assert.ok(candidateKeys.has(key), `manifest entry is stale or no longer a scanner candidate: ${entry.path}: ${entry.anchor}`);
  counts[entry.class]++;
  if (entry.class === "honest-text") {
    assert.ok(entry.proof, `honest-text entry lacks output/shared-renderer proof: ${entry.path}: ${entry.anchor}`);
    const proofBody = readFileSync(join(root, entry.proof!.path), "utf8");
    assert.equal(proofBody.split(entry.proof!.anchor).length - 1, 1, `honest-text proof anchor must exist exactly once in ${entry.proof!.path}: ${entry.proof!.anchor}`);
    if (entry.proof!.path.includes("/smoke/")) {
      assert.ok(/assert|check|ok\(/.test(entry.proof!.anchor), `smoke proof is not an output assertion: ${entry.proof!.path}: ${entry.proof!.anchor}`);
    } else {
      assert.equal(
        proofAnchors.get(entry.proof!.path),
        entry.proof!.anchor,
        `honest-text source proof is not one of the checked shared/local honest renderers: ${entry.proof!.path}: ${entry.proof!.anchor}`,
      );
    }
  } else {
    assert.equal(entry.proof, undefined, `${entry.class} entry must not pretend to have honest-text output proof: ${entry.path}: ${entry.anchor}`);
  }
}

const unclassified = candidates.filter((candidate) => !entryKeys.has(`${candidate.path}\u0000${candidate.anchor}`));
if (process.env.COTAL_DUMP_PRESENCE_RENDER_CANDIDATES === "1") {
  process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
  process.exit(0);
}
assert.deepEqual(
  unclassified,
  [],
  `unclassified shipped presence-status render candidate(s):\n${unclassified.map((candidate) => `  ${candidate.path}: ${candidate.anchor}`).join("\n")}\nClassify each narrow sink in ${relative(root, manifestPath)}.`,
);

const actual = { total: candidates.length, ...counts };
assert.deepEqual(actual, manifest.expected, `presence render census count drifted; update the independently reviewed expected totals only after classifying every candidate`);
console.log(
  `presence-render census: ${actual.total} candidates ` +
    `(${actual["honest-text"]} honest-text, ${actual["presence-only-glyph/count"]} presence-only-glyph/count, ` +
    `${actual["command-ack"]} command-ack, ${actual["non-render/control"]} non-render/control)`,
);
console.log("PRESENCE-RENDER-CENSUS: 5 checks passed");

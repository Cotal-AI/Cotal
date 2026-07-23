// The vote — the one piece Cotal does NOT give us (there is no quorum/k-of-N/clustering primitive,
// §13.5/13.6/13.8). Cotal hands us N isolated, schema-clean, attributed samples; keeping only what
// appears in >= k runs stays application logic, ported from the benchmark harness (majority.ts).
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "./contracts.js";

const MODEL = process.env.COTAL_REVIEW_MODEL || "openai/gpt-5.5";
const CLUSTER_TIMEOUT_MS = Number(process.env.COTAL_REVIEW_TIMEOUT_MS || 600_000);

export interface VotedFinding extends Finding {
  /** How many distinct runs reported this issue. Kept only when support >= k. */
  support: number;
}

const tokens = (text: string): Set<string> =>
  new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / (a.size + b.size - hit);
}

const SEV_RANK: Record<string, number> = { HIGH: 3, MED: 2, LOW: 1 };

// The text threshold scales with how precisely the locations agree (same reference-harness heuristic):
// same line +-3 needs only 0.12 overlap, nearby lines 0.35, findings without a line keep 0.5.
function requiredOverlap(a: number | null, b: number | null): number | null {
  if (a !== null && b !== null) {
    if (Math.abs(a - b) <= 3) return 0.12;
    if (Math.abs(a - b) <= 15) return 0.35;
    return null;
  }
  return 0.5;
}

/** Cross-PERSONA merge within one run: the 3 personas often flag one defect in different words, so
 *  collapse those into a single candidate before the cross-run vote. */
export function mergeRun(perPersona: Finding[]): Finding[] {
  const merged: Array<Finding & { tok: Set<string> }> = [];
  for (const f of perPersona) {
    const tok = tokens(f.body);
    const hit = merged.find((m) => {
      if ((m.path || "") !== (f.path || "")) return false;
      const threshold = requiredOverlap(m.line, f.line);
      return threshold !== null && jaccard(m.tok, tok) >= threshold;
    });
    if (hit) {
      if (f.body.length > hit.body.length) hit.body = f.body;
      if ((SEV_RANK[f.severity] || 0) > (SEV_RANK[hit.severity] || 0)) hit.severity = f.severity;
      if (hit.line === null && f.line !== null) hit.line = f.line;
      for (const t of tok) hit.tok.add(t);
    } else {
      merged.push({ ...f, tok });
    }
  }
  return merged.map(({ tok: _t, ...f }) => f);
}

type Tagged = Finding & { run: number };

function representative(members: Tagged[]): VotedFinding {
  const support = new Set(members.map((m) => m.run)).size;
  // Prefer a member with a line anchor, then the highest severity, then the longest body.
  const rep = [...members].sort(
    (a, b) =>
      (b.line !== null ? 1 : 0) - (a.line !== null ? 1 : 0) ||
      (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) ||
      b.body.length - a.body.length,
  )[0];
  return { path: rep.path, line: rep.line, severity: rep.severity, body: rep.body, support };
}

/** Deterministic cross-run clustering: bucket by path + line + normalized text. Same-issue findings
 *  reported identically across runs land in one bucket; per-run noise stays a singleton. Used for
 *  `--mock` (no model) and as the fallback when the clustering model call fails. */
function clusterDeterministic(all: Tagged[]): Tagged[][] {
  const buckets = new Map<string, Tagged[]>();
  for (const f of all) {
    const key = `${f.path ?? ""}|${f.line ?? ""}|${[...tokens(f.body)].sort().join(" ")}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(f);
  }
  return [...buckets.values()];
}

async function clusterWithModel(all: Tagged[]): Promise<Tagged[][]> {
  const items = all.map((f, index) => ({ index, run: f.run, path: f.path, line: f.line, finding: f.body }));
  const prompt = `Below are code-review findings on one pull request from independent review runs (the "run" field). Group findings that report the SAME underlying issue (same defect/root cause), across runs.

Rules:
- Same group only if fixing one defect resolves all members.
- Different facets or call sites are different groups.
- Singletons are groups of one.
- Every index appears in exactly one group.

Output only JSON: { "groups": [[0,3,7],[1],[2]] }

Findings:
${JSON.stringify(items, null, 2)}
`;
  const dir = await mkdtemp(join(tmpdir(), "cotal-cluster-"));
  const promptPath = join(dir, "cluster-prompt.md");
  try {
    await writeFile(promptPath, prompt);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "opencode",
        ["run", "Group duplicate review findings across runs. JSON only.", "--model", MODEL, "--file", promptPath, "--format", "default"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("cluster timed out")); }, CLUSTER_TIMEOUT_MS);
      child.stdout.on("data", (c) => (out += c.toString()));
      child.on("close", () => { clearTimeout(timer); resolve(out); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const fenced = stdout.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
    const parsed = JSON.parse(body.trim()) as { groups?: unknown };
    const groups = Array.isArray(parsed.groups)
      ? parsed.groups.filter((g): g is number[] => Array.isArray(g) && g.every((i) => Number.isInteger(i)))
      : [];
    const seen = new Set<number>();
    const clusters: Tagged[][] = [];
    for (const g of groups) {
      const members = g.filter((i) => i >= 0 && i < all.length && !seen.has(i));
      if (!members.length) continue;
      members.forEach((i) => seen.add(i));
      clusters.push(members.map((i) => all[i]));
    }
    all.forEach((f, i) => { if (!seen.has(i)) clusters.push([f]); }); // unplaced -> singletons (fail-open)
    return clusters;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Cross-run cluster + k-of-N vote. `runs[r]` is run r's per-run candidate list. Keeps only clusters
 *  spanning >= k distinct runs (solution 8 = k=3, N=3), sorted by support then severity. */
export async function clusterAndVote(runs: Finding[][], k: number, mock: boolean): Promise<VotedFinding[]> {
  const all: Tagged[] = runs.flatMap((run, r) => run.map((f) => ({ ...f, run: r })));
  if (!all.length) return [];
  let clusters: Tagged[][];
  if (mock) {
    clusters = clusterDeterministic(all);
  } else {
    try {
      clusters = await clusterWithModel(all);
    } catch (e) {
      console.warn(`  clustering model call failed (${(e as Error).message}); falling back to deterministic bucketing`);
      clusters = clusterDeterministic(all);
    }
  }
  return clusters
    .map(representative)
    .filter((v) => v.support >= k)
    .sort((a, b) => b.support - a.support || (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));
}

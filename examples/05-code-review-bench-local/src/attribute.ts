#!/usr/bin/env node
// Attribute judged TP/FP back to the reviewer (gpt/glm) that produced each candidate.
// Reads the local-judge evaluations plus candidates.json; costs no model calls.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../../..");
const runsRoot = path.join(root, ".runs", "code-review-bench");
const martianRoot = process.env.COTAL_BENCH_MARTIAN_DIR || path.join(runsRoot, "martian");
const offlineRoot = path.join(martianRoot, "offline");
const team = (process.env.COTAL_BENCH_TEAM || "council").toLowerCase();
const toolName = process.env.COTAL_BENCH_TOOL || (team === "council" ? "cotal-council" : `cotal-${team}`);
const localJudgeModel = process.env.COTAL_BENCH_JUDGE_OPENCODE_MODEL || "openai/gpt-5.5";
const judgeModel = process.env.MARTIAN_MODEL || process.env.COTAL_BENCH_JUDGE_MODEL || "openai/gpt-5.5";
const severityFilter = (process.env.COTAL_BENCH_SEVERITY_FILTER || "")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const variantSuffix = severityFilter.length ? `_sev-${severityFilter.join("-")}` : "";

function sanitizeModelName(model: string) {
  return model.trim().replace(/\//g, "_");
}

type Candidate = { text: string; source?: string; votes?: Array<{ persona: string }> };
type Evaluation = {
  skipped?: boolean;
  tp?: number;
  fp?: number;
  fn?: number;
  true_positives?: Array<{ matched_candidate: string }>;
  false_positives?: Array<{ candidate: string }>;
};

async function main() {
  const evaluationsPath = path.join(offlineRoot, "results", `${sanitizeModelName(localJudgeModel)}_opencode_local${variantSuffix}`, "evaluations.json");
  const candidatesPath = path.join(offlineRoot, "results", sanitizeModelName(judgeModel), "candidates.json");
  const evaluations = JSON.parse(await readFile(evaluationsPath, "utf8")) as Record<string, Record<string, Evaluation>>;
  const candidates = JSON.parse(await readFile(candidatesPath, "utf8")) as Record<string, Record<string, Candidate[]>>;

  const perSource: Record<string, { tp: number; fp: number; candidates: number }> = {};
  const bump = (source: string, key: "tp" | "fp" | "candidates") => {
    perSource[source] ||= { tp: 0, fp: 0, candidates: 0 };
    perSource[source][key]++;
  };
  let unattributed = 0;
  let fn = 0;
  let judgedPrs = 0;

  for (const [url, tools] of Object.entries(evaluations)) {
    const evaluation = tools[toolName];
    if (!evaluation || evaluation.skipped) continue;
    judgedPrs++;
    fn += evaluation.fn ?? 0;
    // Merged candidates carry a votes array; credit every voting persona. Pre-merge data
    // (single source string) still works as a one-vote candidate.
    const sourcesByText = new Map<string, string[]>();
    for (const candidate of candidates[url]?.[toolName] || []) {
      const sources = candidate.votes?.length ? candidate.votes.map((vote) => vote.persona) : [candidate.source || "unknown"];
      sourcesByText.set(candidate.text, sources);
      for (const source of sources) bump(source, "candidates");
    }
    for (const tp of evaluation.true_positives || []) {
      const sources = sourcesByText.get(tp.matched_candidate);
      if (sources) for (const source of sources) bump(source, "tp"); else unattributed++;
    }
    for (const fp of evaluation.false_positives || []) {
      const sources = sourcesByText.get(fp.candidate);
      if (sources) for (const source of sources) bump(source, "fp"); else unattributed++;
    }
  }

  const report = {
    tool: toolName,
    judge: `${localJudgeModel} (OpenCode local judge fallback)`,
    judged_prs: judgedPrs,
    combined_fn: fn,
    per_source: Object.fromEntries(
      Object.entries(perSource).map(([source, s]) => [source, {
        ...s,
        precision_vs_own_candidates: s.tp + s.fp ? s.tp / (s.tp + s.fp) : 0,
      }]),
    ),
    unattributed_judgments: unattributed,
    note: "TP/FP attributed to the reviewer that produced each judged candidate. FN is shared (missed by all reviewers). Not a standalone per-vendor benchmark run.",
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

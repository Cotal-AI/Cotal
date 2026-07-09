#!/usr/bin/env node
// Score council variants from ONE judged run: consensus thresholds, weighted approval,
// veto-lens, and small/medium/big council presets. Personas review independently, so a
// smaller council's output is exactly the candidates its personas voted for; no extra
// review or judge calls are needed.
//
// Approximation caveat: the judge matched each golden comment to its single best candidate
// in the FULL union. If a variant drops that candidate, the golden counts as missed even if
// another kept candidate also describes it. Variant metrics are therefore conservative.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../../..");
const runsRoot = path.join(root, ".runs", "code-review-bench");
const martianRoot = process.env.COTAL_BENCH_MARTIAN_DIR || path.join(runsRoot, "martian");
const offlineRoot = path.join(martianRoot, "offline");
const team = (process.env.COTAL_BENCH_TEAM || "council").toLowerCase();
const isTrio = team.startsWith("trio");
const isTwins = team === "twins";
const toolName = process.env.COTAL_BENCH_TOOL || (team === "council" ? "cotal-council" : `cotal-${team}`);
const localJudgeModel = process.env.COTAL_BENCH_JUDGE_OPENCODE_MODEL || "openai/gpt-5.5";
const judgeModel = process.env.MARTIAN_MODEL || process.env.COTAL_BENCH_JUDGE_MODEL || "openai/gpt-5.5";

const WEIGHTS: Record<string, number> = isTwins
  ? { "gen-a": 1.0, "gen-b": 1.0 }
  : isTrio
  ? { "bug-hunter": 1.0, breaker: 1.0, keeper: 1.0 }
  : {
    correctness: 2.0, security: 1.8, "edge-cases": 1.5, performance: 1.2,
    simplicity: 1.0, "data-integrity": 1.0, "attack-surface": 1.0, testing: 1.0, maintainability: 0.8,
  };
const COUNCILS: Record<string, string[]> = isTwins
  ? { twins: Object.keys(WEIGHTS) }
  : isTrio
  ? {
    trio: Object.keys(WEIGHTS),
    "bug-hunter+breaker": ["bug-hunter", "breaker"],
    "bug-hunter+keeper": ["bug-hunter", "keeper"],
    "breaker+keeper": ["breaker", "keeper"],
  }
  : {
    big: Object.keys(WEIGHTS),
    medium: ["correctness", "security", "edge-cases", "performance", "data-integrity", "testing"],
    small: ["correctness", "security", "edge-cases"],
  };
const fullCouncil = isTwins ? "twins" : isTrio ? "trio" : "big";

function sanitizeModelName(model: string) {
  return model.trim().replace(/\//g, "_");
}

type Vote = { persona: string; weight: number };
type Candidate = { text: string; votes?: Vote[]; source?: string };
type Evaluation = {
  skipped?: boolean;
  total_golden?: number;
  fn?: number;
  tp?: number;
  true_positives?: Array<{ matched_candidate: string }>;
};

type Variant = { name: string; keep: (votes: Vote[], council: string[]) => boolean; council: string };

function councilVotes(candidate: Candidate, council: string[]): Vote[] {
  const votes = candidate.votes || (candidate.source ? [{ persona: candidate.source, weight: WEIGHTS[candidate.source] ?? 1 }] : []);
  return votes.filter((vote) => council.includes(vote.persona));
}

function councilWeight(council: string[]) {
  return council.reduce((sum, persona) => sum + (WEIGHTS[persona] ?? 1), 0);
}

async function main() {
  const evaluationsPath = path.join(offlineRoot, "results", `${sanitizeModelName(localJudgeModel)}_opencode_local`, "evaluations.json");
  const candidatesPath = path.join(offlineRoot, "results", sanitizeModelName(judgeModel), "candidates.json");
  const evaluations = JSON.parse(await readFile(evaluationsPath, "utf8")) as Record<string, Record<string, Evaluation>>;
  const candidates = JSON.parse(await readFile(candidatesPath, "utf8")) as Record<string, Record<string, Candidate[]>>;

  const variants: Variant[] = [];
  for (const councilName of Object.keys(COUNCILS)) {
    variants.push({ name: `${councilName}-union`, council: councilName, keep: (votes) => votes.length >= 1 });
    variants.push({ name: `${councilName}-agree>=2`, council: councilName, keep: (votes) => votes.length >= 2 });
  }
  if (!isTwins) variants.push({ name: `${fullCouncil}-agree>=3`, council: fullCouncil, keep: (votes) => votes.length >= 3 });
  if (!isTrio && !isTwins) {
    variants.push({ name: "big-agree>=4", council: "big", keep: (votes) => votes.length >= 4 });
    variants.push({ name: "big-veto-lens", council: "big", keep: (votes) => votes.some((vote) => vote.persona === "correctness" || vote.persona === "security") });
    variants.push({ name: "big-weighted>=25%", council: "big", keep: (votes, council) => votes.reduce((sum, vote) => sum + vote.weight, 0) >= 0.25 * councilWeight(council) });
    variants.push({ name: "big-weighted>=60%", council: "big", keep: (votes, council) => votes.reduce((sum, vote) => sum + vote.weight, 0) >= 0.6 * councilWeight(council) });
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const variant of variants) {
    const council = COUNCILS[variant.council];
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const [url, tools] of Object.entries(evaluations)) {
      const evaluation = tools[toolName];
      if (!evaluation || evaluation.skipped) continue;
      const prCandidates = candidates[url]?.[toolName] || [];
      const kept = new Set(
        prCandidates
          .filter((candidate) => {
            const votes = councilVotes(candidate, council);
            return votes.length > 0 && variant.keep(votes, council);
          })
          .map((candidate) => candidate.text),
      );
      const matched = (evaluation.true_positives || []).filter((truePositive) => kept.has(truePositive.matched_candidate)).length;
      const golden = evaluation.total_golden ?? ((evaluation.tp ?? 0) + (evaluation.fn ?? 0));
      tp += matched;
      fp += kept.size - matched;
      fn += golden - matched;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    rows.push({
      variant: variant.name,
      personas: council.length,
      tp, fp, fn,
      precision: Number(precision.toFixed(3)),
      recall: Number(recall.toFixed(3)),
      f1: Number(f1.toFixed(3)),
    });
  }

  console.log(JSON.stringify({
    tool: toolName,
    judge: `${localJudgeModel} (OpenCode local judge fallback)`,
    note: "Variant metrics are conservative: golden comments are matched only to the judge's single best union candidate.",
    variants: rows,
  }, null, 2));
  console.table(rows);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

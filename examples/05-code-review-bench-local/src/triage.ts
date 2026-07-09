#!/usr/bin/env node
// Paradigm 6: maintainer-triage filter. After the isolated review pass, a single
// "maintainer" call per PR triages ALL merged candidates: for each, would this PR's actual
// human reviewers have flagged it, or is it review noise (plausible-but-tangential, style,
// speculative)? Verdicts are keep/drop only, so post-triage metrics are scored for free by
// filtering the existing judged evaluations (same conservative method as debate.ts).
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../../..");
const runsRoot = path.join(root, ".runs", "code-review-bench");
const martianRoot = process.env.COTAL_BENCH_MARTIAN_DIR || path.join(runsRoot, "martian");
const offlineRoot = path.join(martianRoot, "offline");
const team = (process.env.COTAL_BENCH_TEAM || "trio-r").toLowerCase();
const toolName = process.env.COTAL_BENCH_TOOL || (team.startsWith("trio") ? `cotal-${team}` : "cotal-council");
const personaModel = process.env.COTAL_BENCH_PERSONA_MODEL || "openai/gpt-5.5";
const localJudgeModel = process.env.COTAL_BENCH_JUDGE_OPENCODE_MODEL || "openai/gpt-5.5";
const triageTimeoutMs = Number(process.env.COTAL_BENCH_TRIAGE_TIMEOUT_MS || 600_000);
const maxPatchChars = Number(process.env.COTAL_BENCH_MAX_PATCH_CHARS || 120_000);

function sanitizeModelName(model: string) {
  return model.trim().replace(/\//g, "_");
}

type Vote = { persona: string; weight: number; severity?: string };
type Merged = { path: string | null; line: number | null; body: string; severity?: string; votes: Vote[] };

async function runCommand(command: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

function triagePrompt(candidates: Merged[], prTitle: string, patch: string) {
  const truncated = patch.length > maxPatchChars ? `${patch.slice(0, maxPatchChars)}\n\n[PATCH TRUNCATED]` : patch;
  const items = candidates.map((candidate, index) => ({
    index,
    path: candidate.path,
    line: candidate.line,
    severity: candidate.severity,
    reviewers: candidate.votes.map((vote) => vote.persona),
    finding: candidate.body,
  }));
  return `You are the maintainer of this repository triaging incoming review comments on a pull request.\n\nFor each comment below, decide: would the experienced human reviewers of this PR have raised this issue in their actual review (keep), or is it review noise for THIS change: plausible but tangential, pre-existing rather than introduced by this patch, stylistic, speculative, or too minor to mention (drop)?\n\nBe decisive. A typical PR review raises only the few issues that matter.\n\nOutput only JSON:\n{\n  "verdicts": [\n    {"index": 0, "keep": true, "reason": "one sentence"}\n  ]\n}\n\nPR: ${prTitle}\n\nReview comments to triage:\n${JSON.stringify(items, null, 2)}\n\nPatch:\n${truncated}\n`;
}

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: tsx src/triage.ts <runId>  (a completed run under .runs/code-review-bench)");
    process.exit(2);
  }
  const runRoot = path.join(runsRoot, runId);
  if (!existsSync(runRoot)) throw new Error(`Run dir not found: ${runRoot}`);
  const prDirs = (await readdir(runRoot)).filter((name) => /^\d+__/.test(name)).sort();

  const droppedTexts = new Set<string>();
  let total = 0;
  let dropped = 0;
  for (const prDir of prDirs) {
    const dir = path.join(runRoot, prDir);
    if (!existsSync(path.join(dir, "merged.json"))) continue;
    const merged = JSON.parse(await readFile(path.join(dir, "merged.json"), "utf8")) as Merged[];
    if (!merged.length) continue;
    total += merged.length;
    const pr = JSON.parse(await readFile(path.join(dir, "pr.json"), "utf8")) as { title?: string };
    const patch = await readFile(path.join(dir, "patch.diff"), "utf8");
    const prompt = triagePrompt(merged, pr.title || prDir, patch);
    const promptPath = path.join(dir, "triage-prompt.md");
    await writeFile(promptPath, prompt);
    try {
      const output = await runCommand(
        "opencode",
        ["run", "Triage the attached review comments and return JSON only.", "--model", personaModel, "--file", promptPath, "--title", `${toolName}-triage`, "--format", "default"],
        dir,
        triageTimeoutMs,
      );
      await writeFile(path.join(dir, "triage.stdout.txt"), output.stdout);
      if (output.code !== 0) throw new Error(`triage exited ${output.code}: ${output.stderr.slice(-300)}`);
      const parsed = extractJsonObject(output.stdout) as { verdicts?: Array<{ index?: number; keep?: boolean }> };
      const results = merged.map((candidate, index) => {
        const verdict = (parsed.verdicts || []).find((entry) => entry.index === index);
        // Missing verdicts fail open (keep): a parse gap must not silently delete findings.
        const kept = verdict ? verdict.keep !== false : true;
        if (!kept) {
          dropped++;
          droppedTexts.add(candidate.body);
        }
        return { body: candidate.body, severity: candidate.severity, kept };
      });
      await writeFile(path.join(dir, "triage-results.json"), JSON.stringify(results, null, 2));
      console.log(`${prDir}: ${results.filter((entry) => !entry.kept).length}/${merged.length} dropped`);
    } catch (error) {
      console.warn(`triage failed on ${prDir} (keeping all): ${error instanceof Error ? error.message : error}`);
    }
  }

  const evaluationsPath = path.join(offlineRoot, "results", `${sanitizeModelName(localJudgeModel)}_opencode_local`, "evaluations.json");
  const evaluations = JSON.parse(await readFile(evaluationsPath, "utf8")) as Record<string, Record<string, { skipped?: boolean; total_golden?: number; tp?: number; fn?: number; true_positives?: Array<{ matched_candidate: string }>; false_positives?: Array<{ candidate: string }> }>>;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const tools of Object.values(evaluations)) {
    const evaluation = tools[toolName];
    if (!evaluation || evaluation.skipped) continue;
    const keptTp = (evaluation.true_positives || []).filter((entry) => !droppedTexts.has(entry.matched_candidate)).length;
    const keptFp = (evaluation.false_positives || []).filter((entry) => !droppedTexts.has(entry.candidate)).length;
    const golden = evaluation.total_golden ?? ((evaluation.tp ?? 0) + (evaluation.fn ?? 0));
    tp += keptTp;
    fp += keptFp;
    fn += golden - keptTp;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const summary = { tool: toolName, paradigm: "maintainer-triage filter", candidates: total, dropped, post_triage: { tp, fp, fn, precision, recall, f1 } };
  const outDir = path.join(offlineRoot, "results", `${sanitizeModelName(localJudgeModel)}_opencode_local`);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "triage-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

#!/usr/bin/env node
// Test 1 of the paradigm exploration: a debate round on DISPUTED findings after the
// isolated first pass. Disputed = single-vote HIGH-severity candidates (glock's "disputed
// BLOCKING" rule; severity conflicts >=2 levels also qualify but the trio run had none).
//
// The two reviewers who did NOT produce a disputed finding see it (with the patch) and vote
// keep/drop. Verdict: the original voter counts as keep; the candidate survives unless BOTH
// peers vote drop (majority of 3). Verdicts are keep/drop ONLY, never rewording, so the
// post-debate set is a strict subset of the judged union and is scored for free by
// filtering the existing evaluations (same conservative method as variants.ts).
//
// Transport is pluggable (COTAL_BENCH_DEBATE_TRANSPORT=opencode|cotal): opencode = direct
// CLI calls (no shared context); cotal = the review.debate channel on a Cotal mesh.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import {
  brokerUrl,
  clearStaleManager,
  confirmTornDown,
  cotalEnv,
  killManagerAndBroker,
  parseRunId,
  readTranscript,
  recordMesh,
  removeMeshRecord,
  run as runCli,
  setCotalHome,
  sleep,
  startBroker,
  startObserver,
  stopSharedManager,
  waitForPresent,
} from "./mesh-runtime.js";

const root = path.resolve(import.meta.dirname, "../../..");
const exampleRoot = path.resolve(import.meta.dirname, "..");
const meshTemplates = path.join(exampleRoot, "mesh");
const runsRoot = path.join(root, ".runs", "code-review-bench");
const martianRoot = process.env.COTAL_BENCH_MARTIAN_DIR || path.join(runsRoot, "martian");
const offlineRoot = path.join(martianRoot, "offline");
const team = (process.env.COTAL_BENCH_TEAM || "trio").toLowerCase();
const toolName = process.env.COTAL_BENCH_TOOL || (team === "trio" ? "cotal-trio" : "cotal-council");
const personaModel = process.env.COTAL_BENCH_PERSONA_MODEL || "openai/gpt-5.5";
const localJudgeModel = process.env.COTAL_BENCH_JUDGE_OPENCODE_MODEL || "openai/gpt-5.5";
const debateTimeoutMs = Number(process.env.COTAL_BENCH_DEBATE_TIMEOUT_MS || 600_000);
const transport = process.env.COTAL_BENCH_DEBATE_TRANSPORT || "opencode";
const maxPatchChars = Number(process.env.COTAL_BENCH_MAX_PATCH_CHARS || 120_000);
// cotal transport: fail-fast windows mirroring mesh.ts.
const bootTimeoutMs = Number(process.env.COTAL_BENCH_DEBATE_BOOT_TIMEOUT_MS || 120_000);
const debaterTimeoutMs = Number(process.env.COTAL_BENCH_DEBATE_REVIEWER_TIMEOUT_MS || 240_000);

const TRIO = ["bug-hunter", "breaker", "keeper"];

function sanitizeModelName(model: string) {
  return model.trim().replace(/\//g, "_");
}

type Vote = { persona: string; weight: number; severity?: string };
type Merged = { path: string | null; line: number | null; body: string; severity?: string; votes: Vote[] };

const SEVERITY_RANK: Record<string, number> = { HIGH: 3, MED: 2, LOW: 1 };

function isDisputed(candidate: Merged): boolean {
  const severities = candidate.votes.map((vote) => SEVERITY_RANK[vote.severity?.toUpperCase() || ""] || 0);
  const conflict = candidate.votes.length >= 2 && Math.max(...severities) - Math.min(...severities) >= 2;
  const soloHigh = candidate.votes.length === 1 && (candidate.severity || "").toUpperCase() === "HIGH";
  return soloHigh || conflict;
}

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

function debatePrompt(reviewer: string, disputed: Array<{ index: number; candidate: Merged }>, prTitle: string, patch: string) {
  const truncated = patch.length > maxPatchChars ? `${patch.slice(0, maxPatchChars)}\n\n[PATCH TRUNCATED]` : patch;
  const items = disputed.map(({ index, candidate }) => ({
    index,
    path: candidate.path,
    line: candidate.line,
    severity: candidate.severity,
    raised_by: candidate.votes[0]?.persona,
    finding: candidate.body,
  }));
  return `You are reviewer "${reviewer}" in a code-review debate round.\n\nA teammate flagged the findings below as HIGH severity, but no other reviewer flagged them independently. For each, decide from the patch whether the finding is a real, PR-blocking defect (keep) or not (drop). Be skeptical: a finding that is plausible but not demonstrably a defect in THIS patch should be dropped. Do not reword findings; only vote.\n\nOutput only JSON:\n{\n  "verdicts": [\n    {"index": 0, "keep": true, "reason": "one sentence"}\n  ]\n}\n\nPR: ${prTitle}\n\nDisputed findings:\n${JSON.stringify(items, null, 2)}\n\nPatch:\n${truncated}\n`;
}

type ReviewerPrompt = { reviewer: string; promptPath: string };

/** OpenCode transport: one direct `opencode run` per reviewer, no shared context. */
async function peerVerdictsOpencode(reviewer: string, promptPath: string, runDir: string): Promise<Map<number, boolean>> {
  const output = await runCommand(
    "opencode",
    ["run", "Vote on the attached disputed code-review findings and return JSON only.", "--model", personaModel, "--file", promptPath, "--title", `${toolName}-debate-${reviewer}`, "--format", "default"],
    runDir,
    debateTimeoutMs,
  );
  await writeFile(path.join(runDir, `debate-${reviewer}.stdout.txt`), output.stdout);
  if (output.code !== 0) throw new Error(`debate ${reviewer} exited ${output.code}: ${output.stderr.slice(-500)}`);
  return verdictsFrom(output.stdout);
}

/** Parse a verdicts JSON blob (`{"verdicts": [{index, keep}]}`) into an index→keep map. `keep`
 *  defaults to true when absent (fail-open on a malformed vote). */
function verdictsFrom(text: string): Map<number, boolean> {
  const parsed = extractJsonObject(text) as { verdicts?: Array<{ index?: number; keep?: boolean }> };
  const verdicts = new Map<number, boolean>();
  for (const verdict of parsed.verdicts || []) {
    if (typeof verdict.index === "number") verdicts.set(verdict.index, verdict.keep !== false);
  }
  return verdicts;
}

/** Parse a debater's single DEBATE_JSON message out of the transcript (first one per reviewer wins),
 *  returning its verdict map. Undefined if the reviewer hasn't posted yet. */
function collectDebateVerdicts(transcript: string, reviewer: string): Map<number, boolean> | undefined {
  for (const entry of readTranscript(transcript)) {
    if (entry.type !== "message" || !entry.text || entry.from !== reviewer) continue;
    const marker = entry.text.indexOf("DEBATE_JSON:");
    if (marker === -1) continue;
    try {
      const parsed = JSON.parse(entry.text.slice(marker + "DEBATE_JSON:".length).trim()) as { reviewer?: string; verdicts?: Array<{ index?: number; keep?: boolean }> };
      if (parsed.reviewer !== reviewer) continue;
      const verdicts = new Map<number, boolean>();
      for (const v of parsed.verdicts || []) if (typeof v.index === "number") verdicts.set(v.index, v.keep !== false);
      return verdicts;
    } catch { /* malformed; keep scanning */ }
  }
  return undefined;
}

/** Poll the transcript for a specific debater's DEBATE_JSON verdict, or timeout. */
async function waitForDebater(transcript: string, reviewer: string, timeoutMs: number): Promise<Map<number, boolean> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = collectDebateVerdicts(transcript, reviewer);
    if (v) return v;
    await sleep(5000);
  }
  return collectDebateVerdicts(transcript, reviewer);
}

/**
 * Cotal transport: spin a fresh debate mesh on `review.debate` with the reviewers who have a prompt
 * (the peers who did not raise the disputed findings), DM each its prompt file, and collect the
 * DEBATE_JSON verdicts from the observer transcript. Returns per-reviewer verdict maps (a reviewer
 * that never answered is simply absent → fail-open in the caller). Reuses the mesh.ts scaffolding
 * (big-limit broker owned by the run, spawn -f + registry + COTAL_HOME isolation, DM-driven turns,
 * per-PR fresh manager, scoped teardown) via mesh-runtime.ts.
 */
async function cotalDebateRound(dir: string, prIndex: number, prompts: ReviewerPrompt[]): Promise<Map<string, Map<number, boolean>>> {
  const out = new Map<string, Map<number, boolean>>();
  if (!prompts.length) return out;
  const space = `bench-debate-${prIndex}`;
  const meshDir = path.join(dir, "debate-mesh");
  await mkdir(meshDir, { recursive: true });

  // Render manifest + one debater persona per reviewer (all three; only prompted ones get DMed).
  const manifestPath = path.join(meshDir, "debate.yaml");
  await writeFile(manifestPath, (await readFile(path.join(meshTemplates, "debate.yaml.template"), "utf8")).replace("__SPACE__", space));
  const debaterTemplate = await readFile(path.join(meshTemplates, "debater.md.template"), "utf8");
  for (const reviewer of TRIO) {
    await writeFile(path.join(meshDir, `${reviewer}.md`), debaterTemplate.replaceAll("__NAME__", reviewer));
  }

  recordMesh(space);
  const transcript = path.join(meshDir, "transcript.jsonl");
  const observer = startObserver(space, transcript, path.join(meshDir, "observer.log"));

  let runId: string | undefined;
  try {
    clearStaleManager();
    const spawned = runCli("pnpm", ["cotal", "spawn", "-f", manifestPath], root, cotalEnv({ COTAL_HEADLESS: "1" }));
    await writeFile(path.join(meshDir, "spawn.log"), `${spawned.stdout}\n---stderr---\n${spawned.stderr}`);
    if (spawned.code !== 0) throw new Error(`cotal spawn -f exited ${spawned.code}: ${(spawned.stderr || spawned.stdout).trim().slice(-400)}`);
    runId = parseRunId(spawned.stdout);
    if (!runId) throw new Error(`could not parse run id from spawn output (see ${path.join(meshDir, "spawn.log")})`);

    // Boot gate: only the reviewers we will DM must be present (all three boot, but a peer that
    // raised every disputed finding gets no prompt and needn't be waited on).
    const needed = prompts.map((p) => p.reviewer);
    if (!(await waitForPresent(transcript, needed, bootTimeoutMs))) {
      throw new Error(`debaters did not all register presence within ${bootTimeoutMs}ms — see ${path.join(meshDir, "observer.log")} and ${path.join(root, ".cotal", "manager.log")} (NOT under COTAL_HOME)`);
    }

    // DM each prompted reviewer its prompt file, then wait for its DEBATE_JSON before the next.
    for (const { reviewer, promptPath } of prompts) {
      const dm = runCli("pnpm", ["cotal", "send", "dm", reviewer, `Vote on the disputed findings now: read ${promptPath} and post your DEBATE_JSON verdicts to review.debate.`, "--space", space], root, cotalEnv());
      if (dm.code !== 0) {
        console.warn(`  cotal send dm ${reviewer} failed (exit ${dm.code}): ${(dm.stderr || dm.stdout).trim().slice(-200)}`);
        continue;
      }
      const verdicts = await waitForDebater(transcript, reviewer, debaterTimeoutMs);
      if (verdicts) out.set(reviewer, verdicts);
      else console.warn(`  debater ${reviewer} did not post DEBATE_JSON within ${debaterTimeoutMs}ms — continuing (fail-open)`);
    }
    return out;
  } finally {
    if (runId) {
      const down = runCli("pnpm", ["cotal", "down", "-f", manifestPath, "--run", runId], root, cotalEnv());
      await writeFile(path.join(meshDir, "down.log"), `${down.stdout}\n---stderr---\n${down.stderr}`);
    }
    observer.kill("SIGTERM");
    await confirmTornDown(transcript, TRIO);
    observer.kill("SIGKILL");
    await stopSharedManager();
    removeMeshRecord(space);
  }
}

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: tsx src/debate.ts <runId>  (a completed trio run under .runs/code-review-bench)");
    process.exit(2);
  }
  const runRoot = path.join(runsRoot, runId);
  if (!existsSync(runRoot)) throw new Error(`Run dir not found: ${runRoot}`);
  const prDirs = (await readdir(runRoot)).filter((name) => /^\d+__/.test(name)).sort();

  const debated: Record<string, Array<{ body: string; path: string | null; line: number | null; severity?: string; raised_by?: string; peer_keeps: number; kept: boolean }>> = {};
  let totalDisputed = 0;
  let dropped = 0;

  // cotal transport: one long-lived big-limit broker + isolated COTAL_HOME for the whole debate run
  // (each PR spins its own mesh + fresh manager on it). opencode transport needs neither.
  let broker: ChildProcess | undefined;
  if (transport === "cotal") {
    setCotalHome(runRoot);
    console.log(`cotal transport: broker ${brokerUrl}, isolated COTAL_HOME under ${runRoot}`);
    broker = await startBroker(runRoot);
    const shutdown = () => killManagerAndBroker(broker!);
    process.on("SIGINT", () => { shutdown(); process.exit(130); });
    process.on("SIGTERM", () => { shutdown(); process.exit(143); });
  }

  try {
  for (let prIndex = 0; prIndex < prDirs.length; prIndex++) {
    const prDir = prDirs[prIndex];
    const dir = path.join(runRoot, prDir);
    if (!existsSync(path.join(dir, "merged.json"))) continue;
    const merged = JSON.parse(await readFile(path.join(dir, "merged.json"), "utf8")) as Merged[];
    const pr = JSON.parse(await readFile(path.join(dir, "pr.json"), "utf8")) as { title?: string };
    const disputed = merged.map((candidate, index) => ({ index, candidate })).filter(({ candidate }) => isDisputed(candidate));
    if (!disputed.length) { debated[prDir] = []; continue; }
    totalDisputed += disputed.length;
    console.log(`${prDir}: ${disputed.length} disputed finding(s)`);
    const patch = await readFile(path.join(dir, "patch.diff"), "utf8");

    // Each disputed finding is judged by the two reviewers who did not raise it. Batch per
    // reviewer: every reviewer sees all disputed findings raised by someone else. This per-reviewer
    // batching is identical for both transports; only how a reviewer's verdicts are obtained differs.
    const prompts: ReviewerPrompt[] = [];
    const indicesFor = new Map<string, number[]>();
    for (const reviewer of TRIO) {
      const forReviewer = disputed.filter(({ candidate }) => candidate.votes[0]?.persona !== reviewer);
      if (!forReviewer.length) continue;
      const promptPath = path.join(dir, `debate-${reviewer}-prompt.md`);
      await writeFile(promptPath, debatePrompt(reviewer, forReviewer, pr.title || prDir, patch));
      prompts.push({ reviewer, promptPath });
      indicesFor.set(reviewer, forReviewer.map(({ index }) => index));
    }

    // Collect each reviewer's verdict map by transport.
    const verdictsByReviewer = new Map<string, Map<number, boolean>>();
    if (transport === "cotal") {
      try {
        const result = await cotalDebateRound(dir, prIndex, prompts);
        for (const [reviewer, verdicts] of result) verdictsByReviewer.set(reviewer, verdicts);
      } catch (error) {
        console.warn(`  cotal debate round failed on ${prDir}: ${error instanceof Error ? error.message : error}`);
      }
    } else {
      for (const { reviewer, promptPath } of prompts) {
        try {
          verdictsByReviewer.set(reviewer, await peerVerdictsOpencode(reviewer, promptPath, dir));
        } catch (error) {
          console.warn(`  debate reviewer ${reviewer} failed on ${prDir}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    // Fold per-reviewer verdicts into per-finding keep/drop votes (a reviewer sees only the findings
    // it did not raise, so scope each reviewer's verdicts to its own batch).
    const votesByIndex = new Map<number, boolean[]>();
    for (const [reviewer, verdicts] of verdictsByReviewer) {
      for (const index of indicesFor.get(reviewer) ?? []) {
        const keep = verdicts.get(index);
        if (keep !== undefined) votesByIndex.set(index, [...(votesByIndex.get(index) || []), keep]);
      }
    }

    debated[prDir] = disputed.map(({ index, candidate }) => {
      const peers = votesByIndex.get(index) || [];
      const keeps = peers.filter(Boolean).length;
      // Survives unless BOTH peers vote drop. Missing peer responses count as keep (fail-open:
      // a transport failure must not silently delete findings).
      const kept = peers.length < 2 ? true : keeps >= 1;
      if (!kept) dropped++;
      return { body: candidate.body, path: candidate.path, line: candidate.line, severity: candidate.severity, raised_by: candidate.votes[0]?.persona, peer_keeps: keeps, kept };
    });
    await writeFile(path.join(dir, "debate-results.json"), JSON.stringify(debated[prDir], null, 2));
  }
  } finally {
    if (broker) killManagerAndBroker(broker);
  }

  // Score post-debate: drop the dropped candidate texts from the judged union.
  const evaluationsPath = path.join(offlineRoot, "results", `${sanitizeModelName(localJudgeModel)}_opencode_local`, "evaluations.json");
  const evaluations = JSON.parse(await readFile(evaluationsPath, "utf8")) as Record<string, Record<string, { skipped?: boolean; total_golden?: number; tp?: number; fn?: number; true_positives?: Array<{ matched_candidate: string }>; false_positives?: Array<{ candidate: string }> }>>;
  const droppedTexts = new Set(Object.values(debated).flat().filter((entry) => !entry.kept).map((entry) => entry.body));
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
  const summary = {
    tool: toolName,
    paradigm: `debate-round (${transport} transport)`,
    disputed: totalDisputed,
    dropped,
    post_debate: { tp, fp, fn, precision, recall, f1 },
  };
  const outDir = path.join(offlineRoot, "results", `${sanitizeModelName(localJudgeModel)}_opencode_local`);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "debate-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

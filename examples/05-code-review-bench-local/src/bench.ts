#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type GoldenEntry = {
  pr_title?: string;
  original_url?: string;
  az_comment?: string;
  url: string;
  comments: Array<{ comment: string; severity?: string }>;
};

type Finding = {
  path: string | null;
  line: number | null;
  body: string;
  severity?: string;
  source?: string;
};

const root = path.resolve(import.meta.dirname, "../../..");
const exampleRoot = path.resolve(import.meta.dirname, "..");
const runsRoot = path.join(root, ".runs", "code-review-bench");
const martianRoot = process.env.COTAL_BENCH_MARTIAN_DIR || path.join(runsRoot, "martian");
const offlineRoot = path.join(martianRoot, "offline");
// council = 9-persona glock council; trio = data-derived 3 generalists with the strict
// maintainer-would-block self-filter; trio-r = same trio with the filter softened to
// recover recall (tests whether the precision/recall trade of the filter can be re-tuned).
// twins = two IDENTICAL untilted generalists (isolates tilt value vs pure sampling diversity).
const team = (process.env.COTAL_BENCH_TEAM || "council").toLowerCase();
const toolName = process.env.COTAL_BENCH_TOOL || (team === "council" ? "cotal-council" : `cotal-${team}`);

// The glock-inspired 9-perspective council. Weights and vetoes from glock architecture.md;
// focus text generalized from kit-glock persona files (their bodies are demo-specific).
type Persona = { name: string; weight: number; veto: boolean; focus: string };
const PERSONAS: Persona[] = [
  { name: "correctness", weight: 2.0, veto: true, focus: "real logic errors: behavior that contradicts the stated intent, broken control flow, off-by-one and boundary mistakes, wrong API usage, state lifecycle bugs, docs or comments contradicted by the code" },
  { name: "security", weight: 1.8, veto: true, focus: "adversarial failures: secret or credential exposure, auth bypass, injection, fail-open behavior on errors, weak or misused crypto, trust-boundary violations" },
  { name: "edge-cases", weight: 1.5, veto: false, focus: "boundaries and hostile conditions: empty or malformed inputs, race conditions, concurrent access, retries and restarts, dependency outages, expired or stale state" },
  { name: "performance", weight: 1.2, veto: false, focus: "real performance risks: accidental quadratic work, heavy work per request, unbounded growth, N+1 queries, blocking calls on hot paths; no micro-optimization nitpicks" },
  { name: "simplicity", weight: 1.0, veto: false, focus: "over-complex or misleading design: unnecessary abstraction, dead or unused configuration, cases where a materially simpler and safer alternative exists" },
  { name: "data-integrity", weight: 1.0, veto: false, focus: "persistence and consistency: partial writes, missing transactional boundaries, cache invalidation, stale reads, destructive migrations, lost updates, broken deletion or revocation paths" },
  { name: "attack-surface", weight: 1.0, veto: false, focus: "exposure growth: new routes or endpoints, broadened permissions, tokens or roles with excess power, blast radius of a single compromise, state leaking across boundaries" },
  { name: "testing", weight: 1.0, veto: false, focus: "missing or weakened tests for the changed behavior: untested failure modes, removed or loosened assertions, tests that cannot fail" },
  { name: "maintainability", weight: 0.8, veto: false, focus: "future-reader hazards: misleading names or comments, hidden coupling, configuration that is never read, docs that overstate guarantees" },
];
// The data-derived small team (from the 2026-07-08 council run analysis): generalists
// FIRST, tilt second, fixing the council's "right file, wrong issue" failure mode.
const TRIO: Persona[] = [
  { name: "bug-hunter", weight: 1.0, veto: false, focus: "logic and correctness: behavior contradicting intent, broken control flow, subtle single-line defects" },
  { name: "breaker", weight: 1.0, veto: false, focus: "security and hostile conditions: auth bypass, injection, secret exposure, race conditions, concurrent access, malformed inputs" },
  { name: "keeper", weight: 1.0, veto: false, focus: "data integrity and API misuse: partial writes, cache invalidation, stale reads, lost updates, misused framework APIs, misleading code" },
];
const TWINS: Persona[] = [
  { name: "gen-a", weight: 1.0, veto: false, focus: "general code review: any real defect in the change" },
  { name: "gen-b", weight: 1.0, veto: false, focus: "general code review: any real defect in the change" },
];
const ALL_PERSONAS = [...PERSONAS, ...TRIO, ...TWINS];
const teamPersonas = team === "council" ? PERSONAS : team === "twins" ? TWINS : TRIO;
const personaModel = process.env.COTAL_BENCH_PERSONA_MODEL || "openai/gpt-5.5";
const personaFilter = (process.env.COTAL_BENCH_PERSONAS || "").split(",").map((value) => value.trim()).filter(Boolean);
const activePersonas = personaFilter.length ? teamPersonas.filter((persona) => personaFilter.includes(persona.name)) : teamPersonas;
const totalCouncilWeight = activePersonas.reduce((sum, persona) => sum + persona.weight, 0);
const reviewerTimeoutMs = Number(process.env.COTAL_BENCH_REVIEW_TIMEOUT_MS || 900_000);
const maxPatchChars = Number(process.env.COTAL_BENCH_MAX_PATCH_CHARS || 180_000);
const localJudgeModel = process.env.COTAL_BENCH_JUDGE_OPENCODE_MODEL || "openai/gpt-5.5";
const canaryTimeoutMs = Number(process.env.COTAL_BENCH_CANARY_TIMEOUT_MS || 120_000);
// Direct-OpenAI judge path (bypasses opencode). When COTAL_BENCH_JUDGE_OPENAI_API_KEY is set,
// judge-local calls the real OpenAI API with this model instead of shelling out to opencode.
// gpt-5.2 is Martian's official judge model but is NOT exposed on the ChatGPT/Codex opencode
// subscription, so a metered API key is the only way to reproduce their judge.
const judgeOpenAIKey = process.env.COTAL_BENCH_JUDGE_OPENAI_API_KEY || "";
const judgeOpenAIModel = process.env.COTAL_BENCH_JUDGE_OPENAI_MODEL || "gpt-5.2";
const judgeOpenAIBaseUrl = process.env.COTAL_BENCH_JUDGE_OPENAI_BASE_URL || "https://api.openai.com/v1";
const judgeLimit = Number(process.env.COTAL_BENCH_JUDGE_LIMIT || 0);
// e.g. COTAL_BENCH_SEVERITY_FILTER=HIGH or HIGH,MED: judge only candidates at these severities.
const severityFilter = (process.env.COTAL_BENCH_SEVERITY_FILTER || "")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);

function usage(): never {
  console.error("Usage: tsx src/bench.ts <setup|preflight|run|judge-local> [--limit N] [--repo name] [--pr URL] [--resume runId]");
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd) usage();
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i++;
    } else {
      options[key] = true;
    }
  }
  return { cmd, options };
}

async function ensureMartianRepo() {
  await mkdir(runsRoot, { recursive: true });
  if (existsSync(path.join(martianRoot, ".git"))) {
    console.log(`Martian benchmark already present: ${martianRoot}`);
    return;
  }
  const result = spawnSync("git", ["clone", "https://github.com/withmartian/code-review-benchmark.git", martianRoot], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Failed to clone Martian benchmark repo");
}

async function preflight() {
  await ensureMartianRepo();
  const checks = [
    ["uv", ["--version"]],
    ["opencode", ["--version"]],
    ["git", ["--version"]],
  ] as const;
  for (const [cmd, args] of checks) {
    const result = spawnSync(cmd, args, { cwd: exampleRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${cmd} is not available`);
    console.log(`${cmd}: ${result.stdout.trim() || "ok"}`);
  }
  const models = spawnSync("opencode", ["models"], { cwd: exampleRoot, encoding: "utf8" });
  if (models.status !== 0) throw new Error("opencode models failed");
  for (const model of new Set([personaModel, localJudgeModel])) {
    if (!models.stdout.includes(model)) {
      throw new Error(`Configured model not found in opencode models: ${model}`);
    }
    console.log(`model available: ${model}`);
  }
  console.log(`Martian offline root: ${offlineRoot}`);
}

async function loadGoldenEntries(): Promise<Array<GoldenEntry & { sourceFile: string }>> {
  const folder = path.join(offlineRoot, "golden_comments");
  const files = (await readdir(folder)).filter((file) => file.endsWith(".json")).sort();
  const entries: Array<GoldenEntry & { sourceFile: string }> = [];
  for (const file of files) {
    let parsed: GoldenEntry[];
    try {
      parsed = JSON.parse(await readFile(path.join(folder, file), "utf8")) as GoldenEntry[];
    } catch (error) {
      throw new Error(`Failed to parse golden comments file ${path.join(folder, file)}: ${error instanceof Error ? error.message : error}`);
    }
    for (const entry of parsed) entries.push({ ...entry, sourceFile: file });
  }
  return entries;
}

async function withRetry<T>(label: string, attempts: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delayMs = 2000 * 2 ** (attempt - 1);
      console.warn(`${label} failed (attempt ${attempt}/${attempts}): ${error instanceof Error ? error.message : error}. Retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function fetchText(url: string): Promise<string> {
  return withRetry(`fetch ${url}`, 3, async () => {
    const response = await fetch(url, {
      headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : undefined,
    });
    if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
    return response.text();
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  return withRetry(`fetch ${url}`, 3, async () => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
    return response.json() as Promise<T>;
  });
}

function parseGithubPr(url: string) {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error(`Invalid GitHub PR URL: ${url}`);
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function slugFor(url: string) {
  const { owner, repo, number } = parseGithubPr(url);
  return `${owner}__${repo}__PR${number}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function promptFor(persona: Persona, entry: GoldenEntry, patch: string, prBody: string) {
  const truncatedPatch = patch.length > maxPatchChars
    ? `${patch.slice(0, maxPatchChars)}\n\n[PATCH TRUNCATED TO ${maxPatchChars} CHARS]`
    : patch;
  if (team !== "council") {
    const filterLine = team === "trio"
      ? `Only report findings a senior maintainer would block the PR over. Never flag missing tests, style preferences, or speculative "could theoretically" issues.`
      : `Report real defects, including likely-real defects you are not fully certain about; when unsure, include it and mark severity LOW. Never flag missing tests, style preferences, or speculation without a concrete failure mode.`;
    return `You are a senior code reviewer on a small review team.\n\nReviewer: ${persona.name}\nTilt: ${persona.focus}\n\nTask: Review this pull request patch and report what is actually WRONG. A real defect of any category outranks an on-theme observation; your tilt is only a tiebreaker when choosing where to dig deeper. Check each changed line for subtle errors: wrong operators or comparisons, invalid syntax, falsy vs null confusion, off-by-one mistakes, misused APIs, regex mistakes.\n\n${filterLine} Report at most 8 findings, ranked by severity.\n\nIsolation rules:\n- You do not have access to benchmark golden comments.\n- You do not see other reviewers' output.\n- Do not browse the web.\n- Do not mention benchmark scoring.\n- Output only JSON.\n\nReturn shape:\n{\n  "findings": [\n    {"path": "relative/file", "line": 123, "severity": "HIGH|MED|LOW", "body": "specific issue and why it matters"}\n  ]\n}\n\nPR URL: ${entry.url}\nPR Title: ${entry.pr_title || ""}\nPR Body:\n${prBody || ""}\n\nPatch:\n${truncatedPatch}\n`;
  }
  return `You are one reviewer in a Cotal review council of independent perspectives.\n\nPerspective: ${persona.name}\nFocus: ${persona.focus}\n\nTask: Review this pull request patch strictly through your perspective. Report only real issues inside your focus that you are confident about; other perspectives cover the rest. Avoid style-only comments. Report at most 8 findings.\n\nIsolation rules:\n- You do not have access to benchmark golden comments.\n- You do not see other perspectives' reviews.\n- Do not browse the web.\n- Do not mention benchmark scoring.\n- Output only JSON.\n\nReturn shape:\n{\n  "findings": [\n    {"path": "relative/file", "line": 123, "severity": "HIGH|MED|LOW", "body": "specific issue and why it matters"}\n  ]\n}\n\nPR URL: ${entry.url}\nPR Title: ${entry.pr_title || ""}\nPR Body:\n${prBody || ""}\n\nPatch:\n${truncatedPatch}\n`;
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

// Exhausted provider quotas make `opencode run` hang silently instead of erroring
// (e.g. GLM "Monthly usage limit reached"), so ping each model with a tiny prompt and a
// short timeout before committing to a long run. Skip with COTAL_BENCH_SKIP_CANARY=1.
async function canaryCheck(models: string[], cwd: string) {
  if (process.env.COTAL_BENCH_SKIP_CANARY) return;
  for (const model of [...new Set(models)]) {
    const result = await runCommand(
      "opencode",
      ["run", "Reply with exactly: ok", "--model", model, "--title", `${toolName}-canary`, "--format", "default"],
      cwd,
      canaryTimeoutMs,
    ).catch((error) => ({ stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1 }));
    if (result.code !== 0 || !result.stdout.toLowerCase().includes("ok")) {
      throw new Error(`Canary call for ${model} produced no reply within ${canaryTimeoutMs}ms; the provider quota is likely exhausted (check the opencode log for details). Last stderr: ${result.stderr.slice(-500)}`);
    }
    console.log(`canary ok: ${model}`);
  }
}

// runCommand only rejects on timeout (nonzero exits resolve), so this retries timeouts only.
async function runCommandWithRetry(command: string, args: string[], cwd: string, timeoutMs: number, label: string) {
  return withRetry(label, 2, () => runCommand(command, args, cwd, timeoutMs));
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

function normalizeFindings(raw: unknown, source: string): Finding[] {
  const obj = raw as { findings?: unknown };
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  return findings.flatMap((finding): Finding[] => {
    const f = finding as Record<string, unknown>;
    const body = typeof f.body === "string" ? f.body.trim() : "";
    if (!body) return [];
    return [{
      path: typeof f.path === "string" && f.path.trim() ? f.path.trim() : null,
      line: typeof f.line === "number" && Number.isFinite(f.line) ? f.line : null,
      severity: typeof f.severity === "string" ? f.severity : undefined,
      body,
      source,
    }];
  });
}

async function repairReviewerJson(source: string, rawOutput: string, runDir: string): Promise<unknown> {
  const repairPrompt = `Convert this malformed code-review output into strict JSON.\n\nRequired shape:\n{\n  "findings": [\n    {"path": "relative/file", "line": 123, "severity": "HIGH|MED|LOW", "body": "specific issue"}\n  ]\n}\n\nRules:\n- Preserve every finding you can recover.\n- Escape quotes inside strings correctly.\n- Output JSON only.\n\nMalformed output:\n${rawOutput}\n`;
  const repairPath = path.join(runDir, `${source}-repair-prompt.md`);
  await writeFile(repairPath, repairPrompt);
  const repaired = await runCommandWithRetry(
    "opencode",
    ["run", "Repair the attached malformed JSON and return strict JSON only.", "--model", localJudgeModel, "--file", repairPath, "--title", `${toolName}-${source}-repair`, "--format", "default"],
    runDir,
    reviewerTimeoutMs,
    `${source} JSON repair`,
  );
  await writeFile(path.join(runDir, `${source}.repair.stdout.txt`), repaired.stdout);
  await writeFile(path.join(runDir, `${source}.repair.stderr.txt`), repaired.stderr);
  if (repaired.code !== 0) throw new Error(`repair for ${source} exited ${repaired.code}: ${repaired.stderr}`);
  return extractJsonObject(repaired.stdout);
}

type LocalMatch = {
  golden_index: number;
  candidate_index: number;
  confidence?: number;
  reasoning?: string;
};

function localJudgePrompt(goldenComments: Array<{ comment: string; severity?: string }>, candidateTexts: string[]) {
  return `You are evaluating an AI code-review tool. Determine which candidate issues match the golden expected comments.\n\nRules:\n- A match means the candidate identifies the same underlying issue as the golden comment.\n- Different wording is fine.\n- Do not invent matches.\n- Each golden comment can match at most one best candidate.\n- Each candidate can match at most one best golden comment.\n- Return JSON only.\n\nGolden comments:\n${JSON.stringify(goldenComments.map((gc, index) => ({ index, comment: gc.comment, severity: gc.severity })), null, 2)}\n\nCandidate issues:\n${JSON.stringify(candidateTexts.map((text, index) => ({ index, text })), null, 2)}\n\nReturn shape:\n{\n  "matches": [\n    {"golden_index": 0, "candidate_index": 1, "confidence": 0.9, "reasoning": "same async forEach issue"}\n  ]\n}\n`;
}

// Bipartite golden<->candidate matching -> TP/FP/FN. Shared by the opencode and OpenAI judges
// so both score identically; the only difference between them is which model produced `matches`.
function scoreJudgeMatches(
  goldenComments: Array<{ comment: string; severity?: string }>,
  candidateTexts: string[],
  matches: LocalMatch[],
) {
  const usedGolden = new Set<number>();
  const usedCandidates = new Set<number>();
  const truePositives = [];
  for (const match of matches) {
    if (!Number.isInteger(match.golden_index) || !Number.isInteger(match.candidate_index)) continue;
    if (match.golden_index < 0 || match.golden_index >= goldenComments.length) continue;
    if (match.candidate_index < 0 || match.candidate_index >= candidateTexts.length) continue;
    if (usedGolden.has(match.golden_index) || usedCandidates.has(match.candidate_index)) continue;
    usedGolden.add(match.golden_index);
    usedCandidates.add(match.candidate_index);
    truePositives.push({
      golden_comment: goldenComments[match.golden_index].comment,
      severity: goldenComments[match.golden_index].severity,
      matched_candidate: candidateTexts[match.candidate_index],
      confidence: match.confidence ?? 0,
      reasoning: match.reasoning || "",
    });
  }
  const falseNegatives = goldenComments.flatMap((gc, index) => usedGolden.has(index) ? [] : [{ golden_comment: gc.comment, severity: gc.severity }]);
  const falsePositives = candidateTexts.flatMap((candidate, index) => usedCandidates.has(index) ? [] : [{ candidate }]);
  const tp = truePositives.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  return {
    skipped: false as const,
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    errors: [],
    total_candidates: candidateTexts.length,
    total_golden: goldenComments.length,
    tp,
    fp,
    fn,
    errors_count: 0,
    precision: candidateTexts.length ? tp / candidateTexts.length : 0,
    recall: goldenComments.length ? tp / goldenComments.length : 0,
    tool: toolName,
  };
}

async function runLocalJudgeForPr(goldenUrl: string, entry: { golden_comments?: Array<{ comment: string; severity?: string }> }, candidateTexts: string[], runDir: string) {
  const goldenComments = entry.golden_comments || [];
  if (!goldenComments.length) {
    return { skipped: true as const, reason: "No golden comments" };
  }
  const prompt = localJudgePrompt(goldenComments, candidateTexts);
  const promptPath = path.join(runDir, `${slugFor(goldenUrl)}-local-judge-prompt.md`);
  await writeFile(promptPath, prompt);
  const output = await runCommandWithRetry(
    "opencode",
    ["run", "Judge the attached review candidates against golden comments and return JSON only.", "--model", localJudgeModel, "--file", promptPath, "--title", `${toolName}-judge`, "--format", "default"],
    runDir,
    reviewerTimeoutMs,
    `local judge for ${goldenUrl}`,
  );
  await writeFile(path.join(runDir, `${slugFor(goldenUrl)}-local-judge.stdout.txt`), output.stdout);
  await writeFile(path.join(runDir, `${slugFor(goldenUrl)}-local-judge.stderr.txt`), output.stderr);
  if (output.code !== 0) throw new Error(`local judge exited ${output.code}: ${output.stderr}`);
  const parsed = extractJsonObject(output.stdout) as { matches?: LocalMatch[] };
  const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
  return scoreJudgeMatches(goldenComments, candidateTexts, matches);
}

async function callOpenAIChat(prompt: string, label: string): Promise<{ content: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {
  const url = `${judgeOpenAIBaseUrl}/chat/completions`;
  return withRetry(label, 6, async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${judgeOpenAIKey}`,
      },
      body: JSON.stringify({ model: judgeOpenAIModel, messages: [{ role: "user", content: prompt }] }),
    });
    if (!response.ok) {
      // Heavily rate-limited key: honor Retry-After on 429/5xx before withRetry's own backoff.
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Math.min(Number(response.headers.get("retry-after")) || 0, 60);
        if (retryAfter > 0) await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      }
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI judge HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const content = json.choices?.[0]?.message?.content || "";
    if (!content.trim()) throw new Error("OpenAI judge returned empty content");
    return { content, usage: json.usage };
  });
}

async function runOpenAIJudgeForPr(
  goldenUrl: string,
  entry: { golden_comments?: Array<{ comment: string; severity?: string }> },
  candidateTexts: string[],
  runDir: string,
  tokens: { prompt: number; completion: number; total: number },
) {
  const goldenComments = entry.golden_comments || [];
  if (!goldenComments.length) return { skipped: true as const, reason: "No golden comments" };
  // No candidates -> every golden is a miss; score locally without spending an API call.
  if (!candidateTexts.length) return scoreJudgeMatches(goldenComments, candidateTexts, []);
  const prompt = localJudgePrompt(goldenComments, candidateTexts);
  await writeFile(path.join(runDir, `${slugFor(goldenUrl)}-openai-judge-prompt.md`), prompt);
  const { content, usage } = await callOpenAIChat(prompt, `openai judge for ${goldenUrl}`);
  await writeFile(path.join(runDir, `${slugFor(goldenUrl)}-openai-judge.stdout.txt`), content);
  if (usage) {
    tokens.prompt += usage.prompt_tokens || 0;
    tokens.completion += usage.completion_tokens || 0;
    tokens.total += usage.total_tokens || 0;
  }
  const parsed = extractJsonObject(content) as { matches?: LocalMatch[] };
  const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
  return scoreJudgeMatches(goldenComments, candidateTexts, matches);
}

async function runLocalJudge() {
  const useOpenAIJudge = Boolean(judgeOpenAIKey);
  if (!useOpenAIJudge) await canaryCheck([localJudgeModel], exampleRoot);
  const benchmarkPath = path.join(offlineRoot, "results", "benchmark_data.json");
  const judgeModel = process.env.MARTIAN_MODEL || process.env.COTAL_BENCH_JUDGE_MODEL || "openai/gpt-5.5";
  const candidatesPath = path.join(offlineRoot, "results", sanitizeModelName(judgeModel), "candidates.json");
  const benchmarkData = JSON.parse(await readFile(benchmarkPath, "utf8")) as Record<string, { golden_comments?: Array<{ comment: string; severity?: string }> }>;
  const candidates = JSON.parse(await readFile(candidatesPath, "utf8")) as Record<string, Record<string, Array<{ text: string; severity?: string }>>>;
  if (severityFilter.length) console.log(`Severity filter active: only judging candidates at ${severityFilter.join(", ")}`);
  const evaluations: Record<string, Record<string, unknown>> = {};
  const judgeRunDir = path.join(runsRoot, `local-judge-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(judgeRunDir, { recursive: true });
  const judgeTokens = { prompt: 0, completion: 0, total: 0 };
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let judged = 0;
  for (const [goldenUrl, entry] of Object.entries(benchmarkData)) {
    if (judgeLimit && judged >= judgeLimit) break;
    judged += 1;
    const candidateEntries = candidates[goldenUrl]?.[toolName] || [];
    const filteredEntries = severityFilter.length
      ? candidateEntries.filter((candidate) => candidate.severity && severityFilter.includes(candidate.severity.toUpperCase()))
      : candidateEntries;
    const candidateTexts = filteredEntries.map((candidate) => candidate.text).filter(Boolean);
    const result = useOpenAIJudge
      ? await runOpenAIJudgeForPr(goldenUrl, entry, candidateTexts, judgeRunDir, judgeTokens)
      : await runLocalJudgeForPr(goldenUrl, entry, candidateTexts, judgeRunDir);
    evaluations[goldenUrl] = { [toolName]: result };
    if (!result.skipped) {
      tp += result.tp ?? 0;
      fp += result.fp ?? 0;
      fn += result.fn ?? 0;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const variantSuffix = severityFilter.length ? `_sev-${severityFilter.join("-")}` : "";
  const judgeLabel = useOpenAIJudge ? judgeOpenAIModel : localJudgeModel;
  const transport = useOpenAIJudge ? "openai_direct" : "opencode_local";
  const outputDir = path.join(offlineRoot, "results", `${sanitizeModelName(judgeLabel)}_${transport}${variantSuffix}`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "evaluations.json"), JSON.stringify(evaluations, null, 2));
  const summary = {
    tool: toolName,
    judge: judgeLabel,
    transport,
    severity_filter: severityFilter.length ? severityFilter : null,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    ...(useOpenAIJudge ? { judge_tokens: judgeTokens } : {}),
  };
  await writeFile(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(judgeRunDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (useOpenAIJudge) console.log(`Judge token usage: prompt=${judgeTokens.prompt} completion=${judgeTokens.completion} total=${judgeTokens.total}`);
  console.log(`Local judge artifacts: ${outputDir}`);
}

async function runReviewer(model: string, source: string, promptPath: string, runDir: string): Promise<Finding[]> {
  const output = await runCommandWithRetry(
    "opencode",
    ["run", "Review the attached benchmark PR packet and return JSON only.", "--model", model, "--file", promptPath, "--title", `${toolName}-${source}`, "--format", "default"],
    runDir,
    reviewerTimeoutMs,
    `${source} reviewer`,
  );
  await writeFile(path.join(runDir, `${source}.stdout.txt`), output.stdout);
  await writeFile(path.join(runDir, `${source}.stderr.txt`), output.stderr);
  if (output.code !== 0) throw new Error(`opencode ${source} reviewer exited ${output.code}: ${output.stderr}`);
  try {
    return normalizeFindings(extractJsonObject(output.stdout), source);
  } catch (error) {
    const repaired = await repairReviewerJson(source, output.stdout, runDir);
    return normalizeFindings(repaired, source);
  }
}

type Vote = { persona: string; weight: number; severity?: string };
type MergedFinding = { path: string | null; line: number | null; body: string; severity?: string; votes: Vote[] };

const SEVERITY_RANK: Record<string, number> = { HIGH: 3, MED: 2, LOW: 1 };

function personaWeight(name: string) {
  return ALL_PERSONAS.find((persona) => persona.name === name)?.weight ?? 1;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((word) => word.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// Personas word the same bug very differently (smoke run: six personas flagged the same
// line with pairwise token overlap well under 0.5), so the text threshold scales with how
// precisely the locations agree: same line +-3 needs only 0.12 overlap, nearby lines 0.35,
// and findings without line info keep the strict 0.5.
function mergeFindings(findings: Finding[]): MergedFinding[] {
  const requiredOverlap = (a: number | null, b: number | null) => {
    if (a !== null && b !== null) {
      if (Math.abs(a - b) <= 3) return 0.12;
      if (Math.abs(a - b) <= 15) return 0.35;
      return null;
    }
    return 0.5;
  };
  const merged: Array<MergedFinding & { tokens: Set<string> }> = [];
  for (const finding of findings) {
    const tokens = tokenize(finding.body);
    const existing = merged.find((candidate) => {
      if ((candidate.path || "") !== (finding.path || "")) return false;
      const threshold = requiredOverlap(candidate.line, finding.line);
      return threshold !== null && jaccard(candidate.tokens, tokens) >= threshold;
    });
    const persona = finding.source || "unknown";
    if (existing) {
      if (!existing.votes.some((vote) => vote.persona === persona)) {
        existing.votes.push({ persona, weight: personaWeight(persona), severity: finding.severity });
      }
      if (finding.body.length > existing.body.length) existing.body = finding.body;
      const rank = (severity?: string) => SEVERITY_RANK[severity?.toUpperCase() || ""] || 0;
      if (rank(finding.severity) > rank(existing.severity)) existing.severity = finding.severity;
      if (existing.line === null && finding.line !== null) existing.line = finding.line;
      for (const token of tokens) existing.tokens.add(token);
    } else {
      merged.push({ path: finding.path, line: finding.line, body: finding.body, severity: finding.severity, votes: [{ persona, weight: personaWeight(persona), severity: finding.severity }], tokens });
    }
  }
  return merged.map(({ tokens: _tokens, ...rest }) => ({ ...rest, votes: [...rest.votes].sort((a, b) => b.weight - a.weight) }));
}

function sanitizeModelName(model: string) {
  return model.trim().replace(/\//g, "_");
}

async function runBenchmark(options: Record<string, string | boolean>) {
  await ensureMartianRepo();
  await canaryCheck([personaModel], exampleRoot);
  const entries = await loadGoldenEntries();
  const filtered = entries.filter((entry) => {
    if (typeof options.repo === "string" && !entry.sourceFile.startsWith(options.repo)) return false;
    if (typeof options.pr === "string" && entry.url !== options.pr) return false;
    return true;
  });
  const limit = typeof options.limit === "string" ? Number(options.limit) : undefined;
  const sourceBalanced = options["one-per-source"]
    ? Array.from(new Map(filtered.map((entry) => [entry.sourceFile, entry])).values())
    : filtered;
  const selected = Number.isFinite(limit) ? sourceBalanced.slice(0, limit) : sourceBalanced;
  if (!selected.length) throw new Error("No benchmark PRs selected");

  const resumeId = typeof options.resume === "string" ? options.resume : undefined;
  if (resumeId && !existsSync(path.join(runsRoot, resumeId))) {
    throw new Error(`Cannot resume: run directory not found: ${path.join(runsRoot, resumeId)}`);
  }
  const runId = resumeId || new Date().toISOString().replace(/[:.]/g, "-");
  const runRoot = path.join(runsRoot, runId);
  await mkdir(runRoot, { recursive: true });
  if (resumeId) console.log(`Resuming run ${runId}: PRs with cached findings.json are reused, the rest re-run.`);
  const benchmarkData: Record<string, unknown> = {};
  const candidates: Record<string, Record<string, Array<{ text: string; path: string | null; line: number | null; source: string; severity?: string; votes: Vote[] }>>> = {};
  const failures: Array<{ url: string; error: string }> = [];

  for (let index = 0; index < selected.length; index++) {
    const entry = selected[index];
    const slug = slugFor(entry.url);
    const prRunDir = path.join(runRoot, `${String(index + 1).padStart(2, "0")}__${slug}`);
    await mkdir(prRunDir, { recursive: true });
    console.log(`[${index + 1}/${selected.length}] ${entry.url}`);

    // One failing PR should not kill a long run: record the failure and continue.
    try {
      const { owner, repo, number } = parseGithubPr(entry.url);
      const findingsPath = path.join(prRunDir, "findings.json");
      const prJsonPath = path.join(prRunDir, "pr.json");
      let pr: { title?: string; body?: string; html_url?: string };
      let allFindings: Finding[];
      if (resumeId && existsSync(findingsPath) && existsSync(prJsonPath)) {
        pr = JSON.parse(await readFile(prJsonPath, "utf8"));
        allFindings = JSON.parse(await readFile(findingsPath, "utf8"));
        console.log(`  reusing cached findings (${allFindings.length})`);
      } else {
        const prApi = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
        pr = await fetchJson<{ title?: string; body?: string; html_url?: string }>(prApi);
        const patch = await fetchText(`${entry.url}.patch`);
        await writeFile(path.join(prRunDir, "patch.diff"), patch);
        await writeFile(prJsonPath, JSON.stringify(pr, null, 2));

        // OpenCode stores session state in a local SQLite DB; concurrent CLI runs can
        // collide with `database is locked`, so keep persona passes sequential per PR.
        allFindings = [];
        for (const persona of activePersonas) {
          const prompt = promptFor(persona, { ...entry, pr_title: entry.pr_title || pr.title }, patch, pr.body || "");
          const promptPath = path.join(prRunDir, `${persona.name}-prompt.md`);
          await writeFile(promptPath, prompt);
          allFindings.push(...await runReviewer(personaModel, persona.name, promptPath, prRunDir));
        }
        await writeFile(findingsPath, JSON.stringify(allFindings, null, 2));
      }
      // findings.json caches RAW per-persona findings; the merge is deterministic code,
      // so resume recomputes it and merge improvements apply to cached PRs too.
      const merged = mergeFindings(allFindings);
      await writeFile(path.join(prRunDir, "merged.json"), JSON.stringify(merged, null, 2));

      benchmarkData[entry.url] = {
        pr_title: entry.pr_title || pr.title,
        original_url: entry.original_url || entry.url,
        source_repo: repo,
        golden_comments: entry.comments,
        golden_source_file: entry.sourceFile,
        az_comment: entry.az_comment,
        reviews: [{
          tool: toolName,
          repo_name: `local__${repo}__${toolName}__PR${number}`,
          pr_url: entry.url,
          review_comments: merged.map((finding) => ({
            path: finding.path,
            line: finding.line,
            body: `[${finding.votes.map((vote) => vote.persona).join("+")}${finding.severity ? ` ${finding.severity}` : ""}] ${finding.body}`,
            created_at: new Date().toISOString(),
          })),
        }],
      };
      candidates[entry.url] = {
        [toolName]: merged.map((finding) => ({
          text: finding.body,
          path: finding.path,
          line: finding.line,
          source: finding.votes[0]?.persona || "unknown",
          severity: finding.severity,
          votes: finding.votes,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ url: entry.url, error: message });
      await writeFile(path.join(prRunDir, "error.txt"), message);
      console.warn(`Skipping ${entry.url}: ${message}`);
    }
  }

  if (!Object.keys(benchmarkData).length) {
    throw new Error(`All ${selected.length} selected PRs failed; nothing to score. See error.txt files under ${runRoot}`);
  }
  if (failures.length) {
    console.warn(`Completed with ${failures.length}/${selected.length} PRs skipped:`);
    for (const failure of failures) console.warn(`  ${failure.url}: ${failure.error}`);
  }

  const offlineResults = path.join(offlineRoot, "results");
  await mkdir(offlineResults, { recursive: true });
  await writeFile(path.join(offlineResults, "benchmark_data.json"), JSON.stringify(benchmarkData, null, 2));
  const judgeModel = process.env.MARTIAN_MODEL || process.env.COTAL_BENCH_JUDGE_MODEL || "openai/gpt-5.5";
  const modelDir = path.join(offlineResults, sanitizeModelName(judgeModel));
  await mkdir(modelDir, { recursive: true });
  await writeFile(path.join(modelDir, "candidates.json"), JSON.stringify(candidates, null, 2));
  await writeFile(path.join(runRoot, "benchmark_data.json"), JSON.stringify(benchmarkData, null, 2));
  await writeFile(path.join(runRoot, "candidates.json"), JSON.stringify(candidates, null, 2));
  await writeFile(path.join(runRoot, "run.json"), JSON.stringify({ runId, toolName, personaModel, personas: activePersonas.map((persona) => persona.name), totalCouncilWeight, judgeModel, count: selected.length, completed: Object.keys(benchmarkData).length, failures }, null, 2));
  console.log(`Wrote run artifacts: ${runRoot}`);
  console.log(`Wrote Martian input: ${path.join(offlineResults, "benchmark_data.json")}`);
  console.log(`Wrote Martian candidates: ${path.join(modelDir, "candidates.json")}`);

  if (process.env.MARTIAN_API_KEY && process.env.MARTIAN_BASE_URL) {
    const dedup = spawnSync("uv", ["run", "python", "-m", "code_review_benchmark.step2_5_dedup_candidates", "--tool", toolName], { cwd: offlineRoot, encoding: "utf8", env: process.env });
    process.stdout.write(dedup.stdout || "");
    process.stderr.write(dedup.stderr || "");
    if (dedup.status !== 0) throw new Error(`Martian dedup step failed (exit ${dedup.status}): ${(dedup.stderr || "").trim().slice(-2000)}`);
    const judge = spawnSync("uv", ["run", "python", "-m", "code_review_benchmark.step3_judge_comments", "--tool", toolName, "--dedup-groups", path.join("results", sanitizeModelName(judgeModel), "dedup_groups.json")], { cwd: offlineRoot, encoding: "utf8", env: process.env });
    process.stdout.write(judge.stdout || "");
    process.stderr.write(judge.stderr || "");
    if (judge.status !== 0) throw new Error(`Martian judge step failed (exit ${judge.status}): ${(judge.stderr || "").trim().slice(-2000)}`);
  } else {
    console.log("MARTIAN_API_KEY and MARTIAN_BASE_URL are not both set. Running OpenCode local judge fallback.");
    await runLocalJudge();
  }
}

async function main() {
  const { cmd, options } = parseArgs(process.argv.slice(2));
  if (cmd === "setup") return ensureMartianRepo();
  if (cmd === "preflight") return preflight();
  if (cmd === "run") return runBenchmark(options);
  if (cmd === "judge-local") return runLocalJudge();
  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

#!/usr/bin/env node
// Rank-and-threshold scorer (the leaders' actual filter design, replacing hard unanimity voting):
// for each PR, ONE call scores every cross-run cluster 0-10 against the diff using an impact rubric
// + trigger-feasibility steps. Downstream, candidates are assembled from (score, support) composites
// so a strong finding seen in only one run can survive while weak repeated ones die.
// Usage: tsx src/score.ts <clusters.json> <runDirWithPatches> <outScored.json>
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const [clustersPath, runDir, outPath] = process.argv.slice(2);
if (!clustersPath || !runDir || !outPath) {
  console.error("Usage: tsx src/score.ts <clusters.json> <runDirWithPatches> <outScored.json>");
  process.exit(2);
}
const model = process.env.COTAL_BENCH_PERSONA_MODEL || "openai/gpt-5.5";
const timeoutMs = Number(process.env.COTAL_BENCH_REVIEW_TIMEOUT_MS || 600_000);
const maxPatch = Number(process.env.COTAL_BENCH_MAX_PATCH_CHARS || 120_000);

type Cluster = { support: number; text: string; path?: string | null; line?: number | null; severity?: string; score?: number };

async function runCommand(command: string, args: string[], ms: number) {
  return new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("timeout")); }, ms);
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, code }); });
  });
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

function slugFor(url: string) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`bad url ${url}`);
  return `${m[1]}__${m[2]}__PR${m[3]}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function main() {
  const clusters = JSON.parse(await readFile(clustersPath, "utf8")) as Record<string, Cluster[]>;
  const prDirs = (await readdir(runDir)).filter((n) => /^\d+__/.test(n));
  const out: Record<string, Cluster[]> = {};
  for (const [url, list] of Object.entries(clusters)) {
    if (!list.length) { out[url] = []; continue; }
    const slug = slugFor(url);
    const dir = prDirs.find((d) => d.endsWith(`__${slug}`));
    let patch = "";
    if (dir && existsSync(path.join(runDir, dir, "patch.diff"))) {
      patch = await readFile(path.join(runDir, dir, "patch.diff"), "utf8");
      if (patch.length > maxPatch) patch = patch.slice(0, maxPatch) + "\n[truncated]";
    }
    const items = list.map((c, index) => ({ index, path: c.path, line: c.line, severity: c.severity, runs_reporting: c.support, finding: c.text }));
    const prompt = `You are the senior maintainer of this repository triaging candidate review findings on one pull request. Score EACH finding 0-10 for how likely a busy senior maintainer reviewing THIS diff would post it as a code review comment.\n\nFor each finding, reason through: (1) contextual accuracy - does the diff actually do what the finding claims (verify against the patch); (2) trigger feasibility - is there a concrete input/state/path that makes the defect real; (3) impact - data loss, security, correctness break rank high; style, docs, defensive nits rank low; (4) is it introduced by THIS PR (pre-existing issues rank low).\n\nScale: 0 = factually wrong or unsupported by the diff. 1-3 = real but a maintainer would not bother (nit, speculative, pre-existing). 4-6 = borderline, plausible comment. 7-8 = solid, most maintainers would flag it. 9-10 = certain and high-impact.\n\nThe "runs_reporting" field says how many of 6 independent review runs produced this finding - use it as weak evidence of salience, not as truth.\n\nOutput only JSON: { "scores": [ {"index": 0, "score": 7} ] } - every index exactly once.\n\nFindings:\n${JSON.stringify(items, null, 2)}\n\nPatch:\n${patch}\n`;
    const tmp = path.join("/tmp", `score-${slug.slice(0, 40)}.md`);
    await writeFile(tmp, prompt);
    let scores: Array<{ index?: number; score?: number }> = [];
    try {
      const res = await runCommand("opencode", ["run", "Score the attached review findings. JSON only.", "--model", model, "--file", tmp, "--title", "cluster-score", "--format", "default"], timeoutMs);
      const parsed = extractJsonObject(res.stdout) as { scores?: unknown };
      scores = Array.isArray(parsed.scores) ? parsed.scores as Array<{ index?: number; score?: number }> : [];
    } catch (error) {
      console.warn(`${url}: scoring failed (${error instanceof Error ? error.message : error}); defaulting to score 5`);
    }
    out[url] = list.map((c, index) => {
      const s = scores.find((e) => e.index === index);
      return { ...c, score: typeof s?.score === "number" ? s.score : 5 }; // missing -> neutral 5
    });
    console.log(`${url}: scored ${list.length} clusters (${out[url].filter((c) => (c.score ?? 5) >= 7).length} at >=7)`);
  }
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });

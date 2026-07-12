#!/usr/bin/env node
// Cross-RUN majority voting (Cursor Bugbot's core quality mechanism): take N independent runs of
// the SAME config, cluster their candidates per PR by underlying issue, and keep only issues found
// in >=MIN_SUPPORT distinct runs. This filters SAMPLING noise - a different mechanism from the dead
// cross-persona consensus (which compared different aims, not resamples of one distribution).
// Usage: tsx src/majority.ts <outCandidatesPath> <minSupport> <file1:key1> <file2:key2> [...]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const [outPath, minSupportArg, ...inputs] = process.argv.slice(2);
if (!outPath || !minSupportArg || inputs.length < 2) {
  console.error("Usage: tsx src/majority.ts <out> <minSupport> <candidates.json:toolKey> x N");
  process.exit(2);
}
const minSupport = Number(minSupportArg);
const dedupModel = process.env.COTAL_BENCH_PERSONA_MODEL || "openai/gpt-5.5";
const timeoutMs = Number(process.env.COTAL_BENCH_REVIEW_TIMEOUT_MS || 600_000);
const outTool = process.env.COTAL_BENCH_TOOL || "cotal-majority";

type Cand = { text: string; path?: string | null; line?: number | null; severity?: string; run?: number };

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

async function main() {
  const runs: Array<Record<string, Record<string, Cand[]>>> = [];
  const keys: string[] = [];
  for (const input of inputs) {
    const [file, key] = input.split(":");
    runs.push(JSON.parse(await readFile(file, "utf8")));
    keys.push(key);
  }
  const prUrls = Object.keys(runs[0]);
  const merged: Record<string, Record<string, Cand[]>> = {};
  let total = 0;
  let kept = 0;
  for (const url of prUrls) {
    const all: Cand[] = [];
    runs.forEach((run, runIdx) => {
      const cands = run[url]?.[keys[runIdx]] || [];
      cands.forEach((c) => all.push({ ...c, run: runIdx }));
    });
    total += all.length;
    if (!all.length) { merged[url] = { [outTool]: [] }; continue; }
    const items = all.map((c, index) => ({ index, run: c.run, path: c.path, line: c.line, finding: c.text }));
    const prompt = `Below are code-review findings on one pull request from ${runs.length} independent review runs (the "run" field). Group findings that report the SAME underlying issue (same defect/root cause), across runs.\n\nRules:\n- Same group only if fixing one defect resolves all members.\n- Different facets or call sites are different groups.\n- Singletons are groups of one.\n- Every index appears in exactly one group.\n\nOutput only JSON: { "groups": [[0,3,7],[1],[2]] }\n\nFindings:\n${JSON.stringify(items, null, 2)}\n`;
    const tmp = path.join("/tmp", `majority-${Buffer.from(url).toString("base64url").slice(0, 24)}.md`);
    await writeFile(tmp, prompt);
    let groups: number[][] = [];
    try {
      const out = await runCommand("opencode", ["run", "Group duplicate review findings across runs. JSON only.", "--model", dedupModel, "--file", tmp, "--title", "majority-dedup", "--format", "default"], timeoutMs);
      const parsed = extractJsonObject(out.stdout) as { groups?: unknown };
      groups = Array.isArray(parsed.groups) ? parsed.groups.filter((g): g is number[] => Array.isArray(g) && g.every((i) => Number.isInteger(i))) : [];
    } catch (error) {
      console.warn(`${url}: dedup failed (${error instanceof Error ? error.message : error}), treating each finding as singleton`);
      groups = all.map((_, i) => [i]);
    }
    const seen = new Set<number>();
    const keptCands: Cand[] = [];
    for (const group of groups) {
      const members = group.filter((i) => i >= 0 && i < all.length && !seen.has(i));
      if (!members.length) continue;
      members.forEach((i) => seen.add(i));
      const support = new Set(members.map((i) => all[i].run)).size;
      if (support >= minSupport) {
        const rep = members.map((i) => all[i]).sort((a, b) => (b.line !== null && b.line !== undefined ? 1 : 0) - (a.line !== null && a.line !== undefined ? 1 : 0))[0];
        keptCands.push({ text: rep.text, path: rep.path, line: rep.line, severity: rep.severity });
      }
    }
    // Unplaced indexes (model gaps) are singletons -> below any minSupport>=2, dropped by design.
    kept += keptCands.length;
    merged[url] = { [outTool]: keptCands };
    console.log(`${url}: ${all.length} -> ${keptCands.length} (support>=${minSupport})`);
  }
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(merged, null, 2));
  console.log(`TOTAL: ${total} findings -> ${kept} majority candidates. Wrote ${outPath}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });

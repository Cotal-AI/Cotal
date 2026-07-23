// The three reviewer personas and the shared prompt frame, ported from the benchmark harness that
// won this recipe (its data-derived trio: generalists first, tilt second). Each persona is one
// served command; a handler is a fresh, stateless model call — no cross-command or cross-PR memory,
// so two instances reviewing the same PR with the same persona are two independent samples.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding, Persona, PrPacket } from "./contracts.js";

const MODEL = process.env.COTAL_REVIEW_MODEL || "openai/gpt-5.5";
const REVIEW_TIMEOUT_MS = Number(process.env.COTAL_REVIEW_TIMEOUT_MS || 600_000);
const MAX_PATCH_CHARS = 180_000;

/** The persona tilt text — a tiebreaker for where to dig, never a filter on what counts. */
export const PERSONA_FOCUS: Record<Persona, string> = {
  bughunter:
    "logic and correctness: behavior contradicting intent, broken control flow, subtle single-line defects",
  keeper:
    "data integrity and API misuse: partial writes, cache invalidation, stale reads, lost updates, misused framework APIs, misleading code",
  sweeper:
    "minor but real defects a thorough reviewer still notes: dead or unreachable code, tests that cannot fail or no-op, stale docstrings/comments that contradict behavior, invalid or misspelled properties/identifiers/metric tags, truthiness checks that break on 0/empty/None, unawaited async calls, wrong-variable and copy-paste slips. LOW severity findings are expected and welcome",
};

/** The shared prompt frame. The in-prompt isolation rules are now redundant (the transport makes
 *  isolation structural) but harmless, so they stay verbatim from the reference harness. */
export function promptFor(persona: Persona, packet: PrPacket): string {
  const patch =
    packet.patch.length > MAX_PATCH_CHARS
      ? `${packet.patch.slice(0, MAX_PATCH_CHARS)}\n\n[PATCH TRUNCATED TO ${MAX_PATCH_CHARS} CHARS]`
      : packet.patch;
  const maxFindings = packet.maxFindings ?? 8;
  const contextSection = packet.context
    ? `Full changed files (read these for context; the diff below marks what THIS PR changed):\n${packet.context}\n\n`
    : "";
  return `You are a senior code reviewer on a small review team.

Reviewer: ${persona}
Tilt: ${PERSONA_FOCUS[persona]}

Task: Review this pull request patch and report what is actually WRONG. A real defect of any category outranks an on-theme observation; your tilt is only a tiebreaker when choosing where to dig deeper. Check each changed line for subtle errors: wrong operators or comparisons, invalid syntax, falsy vs null confusion, off-by-one mistakes, misused APIs, regex mistakes.

Only report findings a senior maintainer would block the PR over. Never flag missing tests, style preferences, or speculative "could theoretically" issues. Report at most ${maxFindings} findings, ranked by severity.

Isolation rules:
- You do not see other reviewers' output.
- Do not browse the web.
- Output only JSON.

Return shape:
{
  "findings": [
    {"path": "relative/file", "line": 123, "severity": "HIGH|MED|LOW", "body": "specific issue and why it matters"}
  ]
}

PR URL: ${packet.prUrl}
PR Title: ${packet.title}
PR Body:
${packet.body || ""}

${contextSection}Patch:
${patch}
`;
}

const SEVERITIES = new Set(["HIGH", "MED", "LOW"]);

/** Coerce one raw model finding to the exact output-schema shape, or drop it. The daemon does this
 *  BEFORE replying, so the wire stays schema-clean (the serving boundary re-validates either way). */
export function normalizeFinding(raw: unknown): Finding | null {
  if (raw === null || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const body = typeof f.body === "string" ? f.body.trim() : "";
  if (!body) return null;
  const sev = typeof f.severity === "string" ? f.severity.toUpperCase() : "";
  return {
    path: typeof f.path === "string" && f.path.trim() ? f.path.trim().slice(0, 512) : null,
    line: typeof f.line === "number" && Number.isInteger(f.line) && f.line >= 0 ? f.line : null,
    severity: SEVERITIES.has(sev) ? (sev as Finding["severity"]) : "LOW",
    body: body.slice(0, 4096),
  };
}

function extractFindings(stdout: string, maxFindings: number): Finding[] {
  const fenced = stdout.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
  const parsed = JSON.parse(candidate.trim()) as { findings?: unknown };
  const raw = Array.isArray(parsed.findings) ? parsed.findings : [];
  return raw
    .map((r) => normalizeFinding(r))
    .filter((f): f is Finding => f !== null)
    .slice(0, maxFindings);
}

function runOpencode(promptPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "opencode",
      ["run", "Review this PR. JSON only.", "--model", MODEL, "--file", promptPath, "--format", "default"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`opencode timed out after ${REVIEW_TIMEOUT_MS}ms`));
    }, REVIEW_TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** One persona review through the OpenCode CLI. Parse failure degrades to zero findings (a partial
 *  run), never a malformed reply — the wire schema would reject one anyway. */
export async function runReview(persona: Persona, packet: PrPacket): Promise<Finding[]> {
  const maxFindings = packet.maxFindings ?? 8;
  const dir = await mkdtemp(join(tmpdir(), "cotal-review-"));
  const promptPath = join(dir, `${persona}-prompt.md`);
  try {
    await writeFile(promptPath, promptFor(persona, packet));
    const stdout = await runOpencode(promptPath);
    try {
      return extractFindings(stdout, maxFindings);
    } catch (e) {
      console.warn(`  [${persona}] unparseable model output (${(e as Error).message}); contributing zero findings`);
      return [];
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deterministic canned findings for `--mock`: real defects the fixture plants (identical across
 *  instances, so they survive the vote) plus one instance-specific hallucination (support 1, so the
 *  k-of-N filter removes it). Exercises the whole transport + vote without model quota. */
export function mockReview(persona: Persona, packet: PrPacket, instanceId: string): Finding[] {
  const real: Record<Persona, Finding[]> = {
    bughunter: [
      { path: "src/auth.ts", line: 42, severity: "HIGH", body: "off-by-one: loop uses <= so it reads one past the end of the token array" },
    ],
    keeper: [
      { path: "src/cache.ts", line: 17, severity: "MED", body: "cache entry written before the DB commit; a rollback leaves a stale read" },
    ],
    sweeper: [
      { path: "src/auth.ts", line: 42, severity: "LOW", body: "off-by-one on the token loop bound also trips the boundary test, which can no longer fail" },
    ],
  };
  const noise: Finding = {
    path: "src/util.ts",
    line: 3,
    severity: "LOW",
    body: `speculative: helper on instance ${instanceId.slice(0, 6)} might not handle an empty input`,
  };
  return [...real[persona], noise].slice(0, packet.maxFindings ?? 8);
}

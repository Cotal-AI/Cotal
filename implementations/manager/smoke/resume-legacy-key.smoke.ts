/**
 * Resume-document tolerant read — the `transcript` → `events` rename must not strand a preserved
 * inventory written by the previous binary.
 *
 * WHY THIS EXISTS. `cotal down --preserve` writes the resume document to disk and `cotal up`
 * replays it, so documents spelling the flag `transcript` are on real machines right now. The
 * schema is a `strictObject`, where an unknown key is a REJECTION rather than an ignored field —
 * so a bare rename would make every preserved inventory unreplayable at the exact moment an
 * operator upgraded, with their agents already stopped. This is the upgrade path, not a nicety.
 *
 * MUTATION LEDGER — predicted before the run:
 *   M1  delete `renameLegacyTranscriptKey` from the preprocess
 *       -> MUST kill "legacy transcript document still parses"
 *       -> MUST NOT kill the new-document or missing-flag cells (they never touch the legacy key)
 *   M2  make the helper OR the two values instead of preferring `events`
 *       -> MUST kill "both keys present: events wins, never OR-ed"
 *
 * Run: pnpm smoke:resume-legacy-key
 */
import { parseResumeControlArgs } from "../src/resume.js";

let pass = 0, fail = 0;
const c = (n: string, v: boolean, x?: unknown) => { if (v) { pass++; } else { fail++; console.log("  ✗ FAIL:", n, x ?? ""); } };

const doc = (launchExtra: Record<string, unknown>) => ({
  attemptId: "attempt-1",
  inventory: {
    version: "cotal-manager-resume/v1",
    space: "s",
    createdAt: "2026-08-12T00:00:00Z",
    agents: [{
      space: "s",
      name: "n",
      identity: { mode: "open", id: "i", lifecycleUid: "abcdefghijklmnopqrstuvwxyz" },
      launch: {
        connector: "claude",
        runtime: "pty",
        cwd: "/tmp",
        source: { kind: "persona", ref: "n", configPath: "/tmp/p", configSha256: "a".repeat(64) },
        allowSubscribe: ["general"],
        ...launchExtra,
      },
      dependencies: [],
      spawner: "sp",
      startedAt: "2026-08-12T00:00:00Z",
    }],
  },
});

const launchOf = (v: unknown) => (v as { inventory: { agents: { launch: { events?: boolean } }[] } }).inventory.agents[0].launch;

// ── a document written by the PRE-RENAME binary ──
try {
  const r = parseResumeControlArgs(doc({ transcript: true }));
  c("legacy `transcript` document still parses, mapped to events", launchOf(r).events === true, launchOf(r));
} catch (e) { c("legacy `transcript` document still parses, mapped to events", false, String(e)); }

// ── a document written by THIS binary ──
try {
  const r = parseResumeControlArgs(doc({ events: false }));
  c("new `events` document parses unchanged", launchOf(r).events === false, launchOf(r));
} catch (e) { c("new `events` document parses unchanged", false, String(e)); }

// ── self-contradictory document: `events` wins, and the two are NEVER OR-ed ──
try {
  const r = parseResumeControlArgs(doc({ transcript: true, events: false }));
  c("both keys present: events wins, never OR-ed", launchOf(r).events === false, launchOf(r));
} catch (e) { c("both keys present: events wins, never OR-ed", false, String(e)); }

// ── the flag is still REQUIRED: tolerance must not become optionality ──
try { parseResumeControlArgs(doc({})); c("a document with neither key is still rejected", false, "did not throw"); }
catch { c("a document with neither key is still rejected", true); }

// ── an unrelated unknown key must STILL be rejected: the preprocess must not weaken strictness ──
try { parseResumeControlArgs(doc({ events: true, bogusKey: 1 })); c("an unrelated unknown key is still rejected", false, "did not throw"); }
catch { c("an unrelated unknown key is still rejected", true); }

console.log(`resume-legacy-key smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

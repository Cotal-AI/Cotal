/**
 * A restarted seat must come back to the session it left, not a blank one.
 *
 * Measured on a live seat before this suite existed: `cotal stop` then `cotal spawn` under the same
 * name returned the seat to the same private home with its 112 KB journal still on disk, and the
 * seat answered "NO PRIOR CONTEXT" when asked to recall, from history alone, a file it had written
 * an hour earlier. The host called `createSession` unconditionally, forking a new 1.7 KB session and
 * orphaning the real one. The TUI is spawned with `--resume`, so an attaching human saw a history
 * the agent itself could not remember (#789).
 *
 * This grades the SELECTION RULE, which is where the bug lived - not the SDK, which already offered
 * `listSessions` / `attachSession` and was simply never called.
 */
import assert from "node:assert/strict";
import { chooseSessionToResume, type ResumeCandidate } from "../src/session-resume.js";

let pass = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  const detail = `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`;
  failures.push(detail);
  console.log(`  ✗ ${detail}`);
};

const cwd = "/work/repo";
const other = "/work/elsewhere";
const s = (over: Partial<ResumeCandidate> & { session_id: string }): ResumeCandidate => ({
  working_dir: cwd,
  status: "idle",
  transcript_bytes: 4096,
  archived: false,
  ...over,
});

console.log("\n1. the defect: a restart must not silently start blank");
{
  const prior = s({ session_id: "piglet", transcript_bytes: 112467 });
  const picked = chooseSessionToResume([prior], cwd);
  check("a single matching prior session is resumed", picked?.session_id === "piglet", picked);
  check("resuming is preferred over forking a fresh session", picked !== undefined);
}

console.log("\n2. nothing to resume is a legitimate first launch, not a failure");
{
  check("an empty list yields no candidate", chooseSessionToResume([], cwd) === undefined);
  check("undefined (the API refused or failed) yields no candidate", chooseSessionToResume(undefined, cwd) === undefined);
}

console.log("\n3. a session belonging to a different working dir is NOT ours");
{
  const foreign = s({ session_id: "foreign", working_dir: other });
  check("a foreign working_dir is refused", chooseSessionToResume([foreign], cwd) === undefined, foreign);
  const mixed = [foreign, s({ session_id: "mine" })];
  check("ours is selected out of a mixed list", chooseSessionToResume(mixed, cwd)?.session_id === "mine");
}

console.log("\n4. archived sessions stay archived");
{
  const archived = s({ session_id: "old", archived: true, transcript_bytes: 999999 });
  check("an archived session is never auto-resumed", chooseSessionToResume([archived], cwd) === undefined);
  const mixed = [archived, s({ session_id: "live", transcript_bytes: 10 })];
  check(
    "a live session wins over a larger archived one",
    chooseSessionToResume(mixed, cwd)?.session_id === "live",
  );
}

console.log("\n5. the richest transcript wins, because that is the memory worth keeping");
{
  const list = [
    s({ session_id: "thin", transcript_bytes: 1753 }),
    s({ session_id: "fat", transcript_bytes: 112467 }),
    s({ session_id: "middling", transcript_bytes: 40000 }),
  ];
  check("the largest transcript is chosen", chooseSessionToResume(list, cwd)?.session_id === "fat");
  // The exact live shape: the restart's own fresh 1.7 KB session must never beat the real one.
  check(
    "a fresh stub does not outrank the session it would replace",
    chooseSessionToResume([s({ session_id: "fox", transcript_bytes: 1753 }), s({ session_id: "piglet", transcript_bytes: 112467 })], cwd)
      ?.session_id === "piglet",
  );
}

console.log("\n6. an unusable session is skipped rather than trusted");
{
  const missingDir = { session_id: "nodir", status: "idle", transcript_bytes: 500 } as ResumeCandidate;
  check("a session with no working_dir is refused (cannot prove it is ours)", chooseSessionToResume([missingDir], cwd) === undefined);
  const empty = s({ session_id: "empty", transcript_bytes: 0 });
  check("a zero-byte transcript carries no memory and is skipped", chooseSessionToResume([empty], cwd) === undefined);
  const noBytes = s({ session_id: "unknown", transcript_bytes: undefined });
  check("an unknown transcript size is not assumed rich", chooseSessionToResume([noBytes], cwd) === undefined);
}

console.log("\n7. selection is stable and side-effect free");
{
  const list = [s({ session_id: "a", transcript_bytes: 10 }), s({ session_id: "b", transcript_bytes: 20 })];
  const frozen = JSON.stringify(list);
  const first = chooseSessionToResume(list, cwd)?.session_id;
  const second = chooseSessionToResume(list, cwd)?.session_id;
  check("repeated selection returns the same session", first === second && first === "b");
  check("the input list is not mutated (no in-place sort)", JSON.stringify(list) === frozen);
}

console.log(`\nsession resume: ${pass} cells OK, ${failures.length} failed`);
if (failures.length) {
  assert.fail(`session resume: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
}

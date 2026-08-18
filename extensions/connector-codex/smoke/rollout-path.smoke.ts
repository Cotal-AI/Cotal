/**
 * Resolving a thread's rollout inside the AGENT's own `CODEX_HOME`.
 *
 * This is the seam the campaign's own defect lived in. The vocabulary for this connector was first
 * censused against `~/.codex/sessions`, the OPERATOR's sessions, and every number was true and about
 * the wrong files: a Cotal seat writes under a per-agent home that `prepareCodexHome` builds, and on
 * the laptop where that census ran, 13 such homes existed holding zero of the files that were
 * counted. So the cell that matters most here is not "it finds the file", it is "it finds the file
 * under the home it was given and not under any other".
 *
 * The tree shape is MEASURED from a real app-server thread (`.internal` 3.3b), not assumed:
 * `<home>/sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<thread id>.jsonl`.
 *
 * Run: pnpm smoke:codex-rollout-path
 */
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { findRollout, waitForRollout } from "../src/agui-rollout.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  x FAIL: ${name}`, extra ?? "");
  }
};

const root = mkdtempSync(join(tmpdir(), "cotal-codex-rollout-"));
const THREAD = "01a01586-5f04-7c53-a91b-78386b50a901";
const OTHER = "01a01586-0000-0000-0000-000000000000";

/** Write a rollout into a home, in the real nested shape. */
function plant(home: string, thread: string, stamp = "2026-08-18T18-38-42"): string {
  const dir = join(home, "sessions", "2026", "08", "18");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-${stamp}-${thread}.jsonl`);
  writeFileSync(p, "{}\n");
  return p;
}

try {
  const agentHome = join(root, ".cotal", "codex", "space-seat-abc123def456");
  const operatorHome = join(root, "operator-codex");

  // THE CELL THE CAMPAIGN'S DEFECT WOULD HAVE FAILED. The same thread id exists under BOTH homes.
  // A resolver rooted anywhere but the home it was handed picks the operator's file.
  const wanted = plant(agentHome, THREAD);
  const decoy = plant(operatorHome, THREAD);
  check("finds the rollout under the home it was GIVEN", findRollout(agentHome, THREAD) === wanted, {
    got: findRollout(agentHome, THREAD),
  });
  check("and never reaches into another home holding the same thread id", findRollout(agentHome, THREAD) !== decoy);
  check("the decoy is genuinely findable from its own home", findRollout(operatorHome, THREAD) === decoy);

  // Absence is an answer, not an error: `thread/start` writes NOTHING to disk, so a caller can
  // legitimately arrive before the host's primer inject has materialized the file.
  check("an unknown thread resolves to undefined, not a throw", findRollout(agentHome, OTHER) === undefined);
  check("a home with no sessions tree at all resolves to undefined", findRollout(join(root, "nothing-here"), THREAD) === undefined);

  // The match is on the full `-<id>.jsonl` suffix. A prefix match would let one thread's emitter
  // consume another thread's bytes, which is the same class of fault as keying the log to the
  // wrong thread.
  const sibling = join(root, "sibling");
  plant(sibling, `${THREAD}-extra`);
  check("a thread id that merely PREFIXES a filename does not match", findRollout(sibling, THREAD) === undefined, {
    got: findRollout(sibling, THREAD),
  });

  // A LINK IS REFUSED, NOT FOLLOWED, and the two halves are refused separately because they are two
  // different escapes. `prepareCodexHome` already lstat-refuses a symlinked `.cotal`, `.cotal/codex`
  // or agent home; a walk that followed a link planted anywhere under `sessions` would let whoever
  // planted it choose which bytes this emitter publishes, so the two would enforce different rules
  // over one tree. Same uid, so this is not a new capability; it is one connector holding one rule.
  const outside = join(root, "outside");
  const victim = plant(outside, THREAD, "2026-08-18T00-00-00");

  // (a) a linked DIRECTORY anywhere on the walk
  const linkedDir = join(root, "linked-dir");
  mkdirSync(linkedDir, { recursive: true });
  symlinkSync(join(outside, "sessions"), join(linkedDir, "sessions"));
  check("a symlinked sessions directory is not walked", findRollout(linkedDir, THREAD) === undefined, {
    got: findRollout(linkedDir, THREAD),
  });

  // (b) a linked FILE with a name that would otherwise match. This is the half an `lstat` that only
  // replaced the directory test would still return: the name matches, and the bytes are the
  // victim's.
  const linkedFile = join(root, "linked-file");
  const linkedFileDir = join(linkedFile, "sessions", "2026", "08", "18");
  mkdirSync(linkedFileDir, { recursive: true });
  symlinkSync(victim, join(linkedFileDir, `rollout-2026-08-18T18-38-42-${THREAD}.jsonl`));
  check("a symlinked rollout file with a matching name is refused", findRollout(linkedFile, THREAD) === undefined, {
    got: findRollout(linkedFile, THREAD),
  });

  // The refusal must be about the LINK, not about the tree being unreadable: the same shape with a
  // real file resolves. Without this, a resolver that returned undefined for everything would pass
  // both cells above.
  const realCopy = join(root, "real-copy");
  const realPath = plant(realCopy, THREAD);
  check("and a REAL file in the same shape still resolves", findRollout(realCopy, THREAD) === realPath, {
    got: findRollout(realCopy, THREAD),
  });

  // The waiter exists because the file appears late. It must actually retry, and it must give up.
  const late = join(root, "late");
  mkdirSync(join(late, "sessions"), { recursive: true });
  let ticks = 0;
  const plantedAt = 3;
  const found = await waitForRollout(late, THREAD, {
    attempts: 10,
    intervalMs: 0,
    sleep: async () => {
      ticks++;
      if (ticks === plantedAt) plant(late, THREAD);
    },
  });
  check("waits for a file that appears late", found === join(late, "sessions", "2026", "08", "18", `rollout-2026-08-18T18-38-42-${THREAD}.jsonl`), { found });
  check("and stopped waiting once it appeared", ticks === plantedAt, { ticks });

  let giveUpTicks = 0;
  const never = await waitForRollout(join(root, "never"), THREAD, {
    attempts: 4,
    intervalMs: 0,
    sleep: async () => {
      giveUpTicks++;
    },
  });
  // BOUNDED, and reported. A waiter that blocked forever would hide the fault behind a caller that
  // cannot see it is stuck, and the emitter would have no durable source at all.
  check("gives up after its budget rather than waiting forever", never === undefined);
  // THE SLEEP IS BETWEEN ATTEMPTS, NOT AFTER THE LAST ONE, so a budget of 4 looks costs 3 waits.
  // The trailing sleep was removed deliberately: with a budget of ONE look the caller then resolves
  // on the microtask queue, and a caller holding a one-at-a-time flag across this call releases it
  // before the next event arrives instead of racing it.
  check("and the budget is the one it was given, minus the wait it does not take", giveUpTicks === 3, { giveUpTicks });

  // The count above is a claim about SLEEPS. This one is a claim about LOOKS, and they are different
  // numbers: a file planted on the last wait must still be found, which can only happen if the
  // fourth look happened at all.
  const lastChance = join(root, "last-chance");
  mkdirSync(join(lastChance, "sessions"), { recursive: true });
  let lastTicks = 0;
  const foundLate = await waitForRollout(lastChance, THREAD, {
    attempts: 4,
    intervalMs: 0,
    sleep: async () => {
      lastTicks++;
      if (lastTicks === 3) plant(lastChance, THREAD);
    },
  });
  check("a file planted on the LAST wait is still found, so the final look really happens", foundLate !== undefined, { foundLate, lastTicks });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`codex-rollout-path smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

/**
 * Every workflow that can be pushed to `main` must QUEUE its runs, never evict them.
 *
 * #976 measured the defect: a concurrency group holds ONE pending run by default, so with a run in
 * flight and a run queued, a third push CANCELS the queued one rather than making it wait. Thirteen
 * of twenty-nine consecutive main runs finished with zero jobs. `cancel-in-progress: false` does not
 * prevent that and is what made it look intended. `queue: max` is the part that makes them wait.
 *
 * #980 fixed `ci.yml`. This file exists because that was not enough and could not have been noticed
 * by reading `ci.yml`: `windows.yml` carried the identical shape while its own comment claimed to
 * follow ci.yml's rule, and `changesets.yml` and `installer.yml` carried it in a DIFFERENT shape,
 * the short `concurrency: <string>` form, which silently selects the evicting defaults. The release
 * workflow was one of them. Three identical defects in two spellings, one fixed, is a state a
 * comment cannot hold and a check can.
 *
 * WHAT THIS DOES NOT CLAIM. It reads the workflow text and evaluates the two expression forms this
 * repo uses. It does not run GitHub's expression engine, does not talk to the API, and cannot tell
 * you a queued run actually waited. That property is only observable on `main` after a merge, which
 * is exactly why it needs a static guard: the behaviour it protects cannot be tested on the pull
 * request that changes it.
 *
 * It also refuses rather than guesses. An expression it does not recognise is a FAILURE, not a skip,
 * because a skip is how a reader turns into a green that means nothing.
 *
 * THREE HOLES, NAMED because an unnamed limit gets rediscovered as a surprise. None of them can
 * produce a pass while a workflow is broken, which is the property that matters, and all three fail
 * in the safe direction:
 *
 *   - JOB-LEVEL `concurrency:` is not read at all. Only the top-level block is. A job that declares
 *     its own group is outside this guard entirely.
 *   - `on:` detection is indentation-driven, so a workflow writing its triggers in a shape this
 *     reader does not follow is misclassified. That moves the population counts in section A rather
 *     than passing quietly, so the failure is loud and lands on the count cell.
 *   - The PR half of the rule is unasserted. Section B requires `max` on push and says nothing about
 *     whether a pull_request supersedes, so a workflow could stop superseding without reddening
 *     anything here. That is a scope limit of this test, not a defect in the workflows.
 *
 * Run: pnpm smoke:workflow-concurrency
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/workflow-concurrency.json
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, ".github", "workflows");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}

/** The population this file is asserting over. A count that drifts is a workflow added or removed,
 *  and either deserves a human deciding whether it needs the queue rule, so the numbers are exact
 *  rather than floors. Without them a rename makes every check below vacuously true. */
const EXPECTED_WORKFLOWS = 6;
const EXPECTED_PUSH_TO_MAIN = 5;
/** Of those, the ones that declare a concurrency group and therefore CAN evict. `docs.yml` pushes
 *  to main with no group at all, so its runs are independent and there is nothing to queue. That is
 *  a valid answer to this problem, not an omission, and counting it separately keeps the difference
 *  visible instead of letting a future removal of a group look like compliance. */
const EXPECTED_GROUPED = 4;

/** What a concurrency key can be: absent, a literal, or one of the expressions this repo uses.
 *  `unknown` is deliberately terminal. */
type Resolved = { kind: "literal"; value: string } | { kind: "byEvent"; pr: string; push: string } | { kind: "unknown"; raw: string };

/**
 * Evaluate a concurrency value for the two events that reach these workflows.
 *
 * Only the forms actually present are understood. Anything else returns `unknown` and fails its
 * cell, which is the point: a future edit that introduces a third form gets a red here instead of
 * quietly falling outside the guard.
 */
function resolve(raw: string): Resolved {
  const v = raw.trim();
  if (!v.startsWith("${{")) return { kind: "literal", value: v };
  // `${{ github.event_name == 'pull_request' }}` -> true on PR, false on push.
  if (/^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}$/.test(v)) {
    return { kind: "byEvent", pr: "true", push: "false" };
  }
  // `${{ github.event_name == 'pull_request' && 'a' || 'b' }}` -> 'a' on PR, 'b' on push.
  const m = v.match(/^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'\s*\}\}$/);
  if (m) return { kind: "byEvent", pr: m[1], push: m[2] };
  return { kind: "unknown", raw: v };
}

interface Wf {
  file: string;
  /** True when a push to `main` can start this workflow. */
  pushesMain: boolean;
  /** True when the file uses the short `concurrency: <string>` form, which cannot carry `queue`. */
  shortForm: boolean;
  hasConcurrency: boolean;
  cancel?: string;
  queue?: string;
}

/** Read the `concurrency:` block and whether `push:` names `main`.
 *
 *  Indentation-driven rather than a YAML parse: `bin/` declares no YAML dependency and reaching for
 *  a transitive one would make this guard's own resolution a thing that can break silently. The
 *  shapes here are small and fixed, and anything this reader cannot resolve fails loudly above. */
function parse(file: string): Wf {
  const text = readFileSync(join(DIR, file), "utf8");
  const lines = text.split("\n");

  const wf: Wf = { file, pushesMain: false, shortForm: false, hasConcurrency: false };

  // `on:` block, to the next top-level key.
  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l) || /^on:\s*\S/.test(l));
  if (onIdx >= 0) {
    let inPush = false;
    for (let i = onIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S/.test(l) && l.trim() !== "") break; // dedent to a new top-level key
      if (/^\s{2}push:/.test(l)) inPush = true;
      else if (/^\s{2}\S/.test(l)) inPush = false;
      if (inPush && /^\s+-\s*main\s*$/.test(l)) wf.pushesMain = true;
      if (inPush && /branches:\s*\[.*\bmain\b.*\]/.test(l)) wf.pushesMain = true;
    }
  }

  const cIdx = lines.findIndex((l) => /^concurrency:/.test(l));
  if (cIdx >= 0) {
    wf.hasConcurrency = true;
    const head = lines[cIdx].slice("concurrency:".length).trim();
    if (head !== "") {
      wf.shortForm = true; // `concurrency: <string>` cannot carry cancel-in-progress or queue
    } else {
      for (let i = cIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === "" || /^\s*#/.test(l)) continue;
        if (!/^\s{2}\S/.test(l)) break; // dedent ends the mapping
        const kv = l.match(/^\s{2}([a-z-]+):\s*(.*)$/);
        if (!kv) continue;
        if (kv[1] === "cancel-in-progress") wf.cancel = kv[2].trim();
        if (kv[1] === "queue") wf.queue = kv[2].trim();
      }
    }
  }
  return wf;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
const all = files.map(parse);
const pushers = all.filter((w) => w.pushesMain);

console.log("A. the population, so no check below can pass by finding nothing");
check(`exactly ${EXPECTED_WORKFLOWS} workflow files (update deliberately if you added one)`,
  files.length === EXPECTED_WORKFLOWS, { found: files.length, files });
check(`exactly ${EXPECTED_PUSH_TO_MAIN} of them can be started by a push to main`,
  pushers.length === EXPECTED_PUSH_TO_MAIN, { found: pushers.map((w) => w.file) });

const grouped = pushers.filter((w) => w.hasConcurrency);
check(`exactly ${EXPECTED_GROUPED} of those declare a concurrency group, so only those can evict`,
  grouped.length === EXPECTED_GROUPED, { found: grouped.map((w) => w.file) });

console.log("\nB. every push-to-main workflow that HAS a group queues rather than evicts");
// A workflow with no group cannot evict: nothing is grouped, so nothing is ever pending behind
// anything. It is checked above by count rather than waived silently here, so removing a group
// somewhere else shows up as a moved number rather than as one fewer cell.
for (const w of grouped) {
  // The short form is the trap `changesets.yml` and `installer.yml` sat in. It reads as a
  // deliberate minimal choice and silently selects `queue: single`, the evicting default.
  check(`${w.file}: uses the mapping form, so it can carry \`queue\``, !w.shortForm, { shortForm: w.shortForm });
  if (w.shortForm) continue;

  const q = w.queue === undefined ? undefined : resolve(w.queue);
  check(`${w.file}: declares \`queue\``, q !== undefined);
  if (!q) continue;
  check(`${w.file}: \`queue\` is a form this check understands`, q.kind !== "unknown", { raw: w.queue });
  const onPush = q.kind === "literal" ? q.value : q.kind === "byEvent" ? q.push : undefined;
  check(`${w.file}: resolves to \`max\` on a push to main (got ${onPush ?? "unresolvable"})`, onPush === "max");
}

console.log("\nC. nothing can resolve to the forbidden pairing");
// `queue: max` together with `cancel-in-progress: true` is a workflow VALIDATION error, so a file
// that can reach that combination for any event does not merely misbehave, it fails to parse and
// the workflow stops running at all. Checked per event rather than per file, because both keys are
// event-conditional and a per-file glance cannot see the combination.
for (const w of all) {
  if (!w.hasConcurrency || w.shortForm) continue;
  const q = w.queue === undefined ? { kind: "literal", value: "single" } as Resolved : resolve(w.queue);
  const c = w.cancel === undefined ? { kind: "literal", value: "false" } as Resolved : resolve(w.cancel);
  if (q.kind === "unknown" || c.kind === "unknown") {
    check(`${w.file}: both concurrency keys are resolvable`, false, { queue: w.queue, cancel: w.cancel });
    continue;
  }
  for (const ev of ["pr", "push"] as const) {
    const qv = q.kind === "literal" ? q.value : q[ev];
    const cv = c.kind === "literal" ? c.value : c[ev];
    check(`${w.file}: on ${ev === "pr" ? "pull_request" : "push"}, not (queue=max AND cancel-in-progress=true)`,
      !(qv === "max" && cv === "true"), { queue: qv, cancel: cv });
  }
}

console.log(`\n${fail === 0 ? "WORKFLOW CONCURRENCY SMOKE OK ✅" : "WORKFLOW CONCURRENCY SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
// Printed on BOTH outcomes, deliberately, and this is not cosmetic. The marker means the suite
// REACHED ITS END, not that it passed, which is what lets mutation-proof tell a real named red from
// a run that died in the middle and reddened for an unrelated reason. Gating it on success graded
// all three mutations INCONCLUSIVE: each was red and correctly named, and each was refused for
// having stopped early, because the only evidence it had not was the line this print withheld.
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

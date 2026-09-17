#!/usr/bin/env node
/**
 * One cell per seat name for `scripts/check-attribution.mjs`, graded through the entry points the
 * real CI step uses.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE GRADER'S OWN SELF-TEST. The grader carries its fixtures
 * inline, so a change that weakens a rule and relaxes its fixture in the same edit stays green,
 * and a revert of the file takes the fixtures with it. This suite lives beside it and imports
 * nothing the fix ADDS: `findings` and `gradeCommits` are the two functions the check has exported
 * all along, and `gradeCommits` is what the `--range` path calls. So the module graph still
 * resolves against any older revision of the grader, and each cell reports on BEHAVIOUR rather
 * than on the presence of a new export.
 *
 * WHY ONE NAME PER CELL. The seat fixtures inside the grader bundled four or five names into one
 * string and asserted the string produced `['seat']`. A fixture like that cannot report that one
 * name among several was missed, because the others satisfy the assertion on their own, which is
 * how three uncaught names sat inside a PASSING seat fixture for the life of #1560. Here a name
 * that stops being caught reddens its own row and prints itself.
 *
 * EVERY NAME IN THIS FILE IS SYNTHETIC. Each one is constructed to exercise one part of the
 * grammar. None is an identifier from any deployment, host or fleet.
 *
 * Run: pnpm smoke:attribution-seat-names
 */
import { findings, gradeCommits } from './check-attribution.mjs';
import { createSuite } from '../bin/smoke/sentinel.mjs';

const { check, finish } = createSuite();

/** Rule ids the grader reports for one line of message text. */
const messageRules = (text) => findings(text, 'cell').map((f) => f.rule);

/** Rule ids the grader reports for one commit's AUTHOR field, through the real range path.
 *  `gradeCommits` is what `--range` calls, so a cell here grades the field as CI grades it, not a
 *  helper this suite chose. The message is deliberately clean so every rule reported comes from
 *  the identity. */
const authorRules = (identity) =>
  gradeCommits([{ sha: '0'.repeat(40), author: identity, committer: 'Jane Doe <jane@example.org>', message: 'chore: a clean subject' }])
    .filter((f) => f.where.endsWith('author'))
    .map((f) => f.rule);

/** Same, for the committer field. */
const committerRules = (identity) =>
  gradeCommits([{ sha: '0'.repeat(40), author: 'Jane Doe <jane@example.org>', committer: identity, message: 'chore: a clean subject' }])
    .filter((f) => f.where.endsWith('committer'))
    .map((f) => f.rule);

// ---- Seat names, one cell each -------------------------------------------------------------
//
// The first group is what the old literal alternatives already caught, so the widening is held to
// losing none of them. The second group is the gap: every name in it passed the old vocabulary.
const CAUGHT_BEFORE = [
  ['digits immediately after the prefix', 'mgr-0001-foo'],
  ['a model-family suffix', 'rev-i0002-opus'],
  ['the legacy worker prefix', 'w-0003-task'],
  ['a lane-qualified worker', 'p2-impl-0773-a2'],
  ['a host-bound legacy seat', 'fm-mac-example'],
];

const THE_GAP = [
  ['a letter precedes the serial', 'mgr-t0001'],
  ['an underscore joins the trailing segment', 'rev-i0002-opus_2'],
  ['the role word is spelled in full and the serial sits inside a segment', 'worker-w0003-task-r2'],
  ['a version counter stands in for a serial', 'orchestrator-v0'],
  ['a role word the old prefix list never enumerated', 'verifier-0042-check'],
  ['every join is an underscore', 'reviewer_0107_pass'],
];

for (const [why, seat] of [...CAUGHT_BEFORE, ...THE_GAP]) {
  const got = messageRules(seat);
  check(`seat name graded alone (${why}): ${seat}`, got.includes('seat'), `expected [seat], got [${got}]`);
}

// ---- The author and committer fields ---------------------------------------------------------
//
// These grade the field a merge makes permanent. A seat name there cannot be reworded after the
// fact the way a message can, so each identity is its own cell and both fields are covered: a rule
// wired to one and not the other is a half-graded commit.
const REFUSED_IDENTITIES = [
  ['a machine slug carrying a serial', 'mgr-t0001 <seat@example.invalid>'],
  ['a machine slug whose role word the seat rule never lists', 'dispatcher-0044 <seat@example.invalid>'],
  ['an underscore-joined machine slug', 'runner_0009_b <seat@example.invalid>'],
  ['a version-counter slug', 'orchestrator-v0 <seat@example.invalid>'],
];

for (const [why, identity] of REFUSED_IDENTITIES) {
  check(
    `author field refuses a machine identity (${why})`,
    authorRules(identity).length > 0,
    `expected at least one finding, got [${authorRules(identity)}]`,
  );
  check(
    `committer field refuses a machine identity (${why})`,
    committerRules(identity).length > 0,
    `expected at least one finding, got [${committerRules(identity)}]`,
  );
}

// ---- Controls that must stay GREEN -----------------------------------------------------------
//
// These are what show the suite still RAN rather than reporting a blanket refusal. A rule widened
// until it refuses everything would pass every cell above and redden every cell here.
const PERMITTED_IDENTITIES = [
  ['a plain human name', 'Jane Doe <jane@users.noreply.github.com>'],
  ['a hyphenated human surname', 'Jane Doe-Smith <jane@example.org>'],
  ['the bot account GitHub itself sets on a merge', 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>'],
  ['a hyphenated handle with no serial segment', 'jane-doe <jane@example.org>'],
];

for (const [why, identity] of PERMITTED_IDENTITIES) {
  const got = authorRules(identity);
  check(`author field permits a human identity (${why})`, got.length === 0, `expected [], got [${got}]`);
}

const PERMITTED_PROSE = [
  ['a reviewer described by role rather than by name',
    'Reviewed at exact head by two independent panel reviewers, both APPROVE; the lane manager folded it.'],
  ['hyphenated words that are not seat names',
    'docs: rev-2 of the prev-1 layout; see path/rev-3-gpt/file and version-mgr-4.'],
  ['a seat-shaped segment inside a filesystem path',
    'chore: drop the stale worktree at /home/example/wt/mgr-t0001 after the rebase.'],
  ['a product name in a scoped subject',
    'fix(connector-claude-code): list marketplace plugins as objects with a source (#1416)'],
];

for (const [why, text] of PERMITTED_PROSE) {
  const got = messageRules(text);
  check(`message prose stays clean (${why})`, got.length === 0, `expected [], got [${got}]`);
}

// The grader must still report the leaks it was written for, or a rule rewritten in the seat rule's
// neighbourhood could take one of them down without any cell above noticing.
check(
  'an attribution trailer is still refused',
  messageRules('Co-Authored-By: Claude Code <noreply@anthropic.com>').includes('trailer'),
);
check(
  'a model id in prose is still refused',
  messageRules('Verdicts from gemini-3.8-flash and glm-5.3 were APPROVE.').includes('model'),
);

finish();

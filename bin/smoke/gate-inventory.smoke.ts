/**
 * Every `smoke:*` script must be RUN by something, or be listed here with a reason.
 *
 * This exists because the same defect kept arriving by different routes: a suite that proves
 * something real, is never executed by any automated path, and therefore proves nothing until
 * somebody runs it by hand. `smoke:manager-coexist` was the case that finally got it named — it
 * existed, passed 4/0, and had never been in `smoke:ci`. It was found by accident.
 *
 * A one-off diff someone remembers to run has exactly the failure mode it is checking for, so the
 * inventory is a gated suite: anything ungated and not on {@link UNGATED} fails here, immediately,
 * in the same run that added it.
 *
 * WHAT THIS DOES NOT CATCH, so nobody mistakes it for full coverage: a suite can be gated and still
 * prove nothing. `smoke:sibling-mint-fence` and `smoke:secret-store-seam` sat inside `smoke:ci`
 * while dying in their own setup on a stale `serverConfig` signature — present, named after the
 * thing they claimed to prove, and vacuous. The script graph checks that a suite is REACHED, never
 * that it asserts anything once reached.
 *
 * The suite census below reads the entry file of every reached suite for two shapes a run cannot
 * see (#1114): a `finally` that calls `process.exit` with no catch arm that fails, which turns any
 * throw into the exit status of the last line reached; and a suite with no pinned cell count, which
 * stays green when a cell is deleted. Every suite must exit non-zero on a throw. Only suites absent
 * from `unpinned-suites.txt` must pin a count; the list is the existing debt, bound to it by a digest here.
 *
 * Run: pnpm smoke:gate-inventory
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readCiSuites, ciChainBody } from "./ci-suites.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Suites deliberately not run by any automated path, each with the reason it is excluded.
 *
 * BE HONEST ABOUT WHAT THIS LIST IS. The entries below were the state of the repo when this check
 * was introduced; they are GRANDFATHERED DEBT, not forty-two individually justified decisions. The
 * reasons are grouped by inspection and several deserve a closer look than they have had. Recording
 * them as inventory is the point: the set stops growing silently, and shrinking it is ordinary work
 * against a written list rather than an archaeology exercise.
 *
 * ADDING A LINE HERE IS A DECISION, NOT A FIX. If a suite proves shipped behaviour, gate it.
 *
 * TWO KINDS OF EXCLUSION LIVE HERE AND THEY ARE NOT THE SAME KIND OF THING.
 *
 *   A STANDING DECISION - "no CI runner has this tooling", "this needs a real broker and an
 *   install tree". Nothing is expected to change. The entry is permanent and correct.
 *
 *   DEBT WITH A FUSE - "this suite is red" or "this suite is flaky". Something IS wrong, someone
 *   is expected to fix it, and the entry is supposed to disappear.
 *
 * Until now both were written the same way: a key and a sentence. So a red suite parked here was
 * indistinguishable from one that legitimately does not belong in CI, and the list could not tell
 * you how much debt it was carrying. That is how `smoke:auth` sat here for six weeks with its
 * cause correctly diagnosed in its own reason string - the note was accurate, and nothing counted
 * it or expected it to end.
 *
 * So the second kind carries a {@link BROKEN} prefix and is counted separately, the way UNTRIAGED
 * already is. The count is not a failure and is not enforced: it is a number that is supposed to
 * go down, printed where the person adding the next entry will see it.
 */

/** Reason prefix for the debt-with-a-fuse class: the suite is red, flaky, or otherwise not
 *  working, and the entry is expected to be removed once it is fixed. Distinct from a standing
 *  decision, which needs no fuse and is written as a plain reason. */
const BROKEN = "BROKEN:";

type UngatedExemption = { reason: string; recheckBy: string };
// 26 → 25: `smoke:delivery-broker-coupling` left the untriaged set by being gated, not by being
// re-explained. It had been exempt as debt while silently grading nothing, the daemon it spawned
// refused at startup, and the refusal satisfied its own "exits when the broker is gone" assertion.
// 25 → 15: the whole remaining untriaged set went the same way on 2026-10-01, ten suites run and
// then gated. What is left is standing decisions plus the five BROKEN backup suites below.
const EXPECTED_EXEMPTIONS = 15;
const standing = (reason: string): UngatedExemption => ({ reason, recheckBy: "2026-11-30" });
const untriagedExemption = (reason: string): UngatedExemption => ({ reason, recheckBy: "2026-09-30" });
/** The BROKEN class carried `untriagedExemption`, which says nobody has looked. Someone had: each
 *  backup entry below names its issue, its commit, and the assertion that failed. What they need is a
 *  fuse tied to the issue rather than a marker that misreports the state of the record. Premise
 *  re-verified 2026-10-01: #643 and #1285 are both still OPEN, so every entry's stated cause still
 *  holds and none of them can enter CI while red. Re-dated with that decision, not bumped. These
 *  cannot be discharged by running them here: #1285 is under a standing instruction not to resume,
 *  and the other four are live backup suites blocked behind it on the same chain. */
const brokenExemption = (reason: string): UngatedExemption => ({ reason, recheckBy: "2026-11-30" });

const UNGATED: Record<string, UngatedExemption> = {
  // Need external tooling no CI runner has.
  "smoke:orca:live": standing("drives the public orca CLI"),
  "smoke:orca-e2e:live": standing("drives the public orca CLI"), "smoke:pi": standing("needs a pi install"), "smoke:codex-live": standing("needs a logged-in codex CLI"),
  "smoke:codex-tui-live": standing("needs a codex TUI session"),
  "smoke:jcode-live": standing("needs an installed, authenticated jcode CLI (COTAL_E2E_JCODE=1)"),
  "smoke:down-manifest-usermode:live": standing("needs a claude CLI on PATH to boot a real connector child"),
  "smoke:backup-usermode:live": brokenExemption("BROKEN: red; cause unconfirmed (measured on a host with a live stack); #1285; already-red so it cannot enter CI"),
  // These four are #643's to fix (backup live coverage that can fail), not an inventory mystery.
  "smoke:backup-perms:live": brokenExemption("BROKEN: red on CI at 2850a5a2e (backup-live.smoke.ts:125 zero-delivery New consumer preserves its creation frontier, 1 !== 2); #643; already-red so it cannot enter CI"),
  "smoke:backup-restore:live": brokenExemption("BROKEN: never executed; blocked behind failing backup-perms:live on the && chain at 2850a5a2e; status unknown; #643"),
  "smoke:backup-conservation:live": brokenExemption("BROKEN: never executed; blocked behind failing backup-perms:live on the && chain at 2850a5a2e; status unknown; #643"),
  "smoke:backup-faults:live": brokenExemption("BROKEN: never executed; blocked behind failing backup-perms:live on the && chain at 2850a5a2e; status unknown; #643"),
  // A STANDING DECISION, and only for the REAL-SESSION arm. The same suite is GATED as
  // `smoke:agui-map`, pointed at a fixture DERIVED from a real session by
  // `scripts/redact-claude-session.mjs` (whitelist by construction, identifiers pseudonymised
  // stably, free text collapsed), so every cell runs in CI. This arm names an operator's actual
  // session file, which cannot be committed, and it buys two things the fixture cannot: it sees
  // TODAY's harness rather than a snapshot, so a new `origin.kind` shows up here as a throw before
  // it shows up in production; and it shares no assumption with the redactor, which itself encodes
  // a belief about which fields matter and could be wrong in the same direction as the mapper.
  "smoke:agui-map:real": standing("names an operator's own uncommittable session JSONL (COTAL_AGUI_SESSION); the fixture arm is gated as smoke:agui-map"),
  // Full-stack live suites: boot a real broker + install tree, too slow/stateful for the PR gate.
  "smoke:manager-singleton:live": standing("full live stack"), "smoke:seed-tarball:live": standing("packs a tarball"),
  // `smoke:user-spawn:live` left this list when it was gated: it had thrown at section B1e on a
  // missing explicit `tls` and stopped after 14 of its 66 cells, and being ungated is why nobody
  // heard about it. "Too slow for the gate" was 105 seconds.
  // Untriaged debt. These are the ones that should shrink, and on 2026-10-01 they shrank to none.
  // All ten entries whose reason read only "UNTRIAGED" hit their recheckBy date and reddened this
  // gate. Each was run: attention 14 checks, attention:auth 14, delivery-boot-retry:auth 4/0,
  // delivery-old-manager 5/0, feedback 12 checks, lifecycle-files OK, manager-console OK,
  // plane3-activation:auth 6/0, plane3-gate:auth 3/0, self-serve-join-coverage:auth 17/0. All ten
  // passed, so all ten were GATED through `bin/smoke/ci-suites.d/` fragments rather than
  // re-explained, which is the exit this gate asks for and the one that takes the count down instead
  // of resetting its clock. `untriagedExemption` is kept because the next entry will want it.
};

/**
 * Suites the working plan record cites BY PASS COUNT as proof of shipped behaviour, which nothing
 * runs. This is the worst cell of the table: an ungated suite is merely unverified, but a CITED
 * ungated suite is actively misleading, because a reader of the plan sees "37/37" next to a claim
 * and reasonably concludes something checks it. Nothing does.
 *
 * HAND-MAINTAINED ON PURPOSE. The citations live in the private `.internal` submodule, and a suite
 * in the public gate must not depend on a private one — it would fail for anyone without it, which
 * is a worse defect than the one this catches. So the list is copied here rather than computed, and
 * that is a real limitation: it goes stale silently if the plan adds a citation. Derived
 * 2026-08-09 by intersecting `smoke:*` mentions in the plan record with the unreached set.
 */
const CITED_IN_PLAN = new Set([
  "smoke:auth", "smoke:channel-attention", "smoke:channel-attention:auth", "smoke:channels",
  "smoke:doctor-auth", "smoke:install", "smoke:ledger",
  "smoke:manifest-launch", "smoke:members", "smoke:membership-feed:auth", "smoke:presence-scrub",
  "smoke:start-model", "smoke:static-lifecycle",
  "smoke:user-spawn:live",
]);

const packagePath = join(ROOT, "package.json");
const packageText = readFileSync(packagePath, "utf8");
const packageSource = ts.parseJsonText(packagePath, packageText);

/** JSON.parse silently keeps the final value of a duplicate object key. Walk TypeScript's JSON AST,
 *  which preserves every property, so a duplicate script cannot hide behind the same parsed map the
 *  inventory is auditing. Recurse through every object: the invariant belongs to the manifest, not
 *  only today's `scripts` shape. */
function duplicateObjectKeys(node: ts.Node, path = "$"): string[] {
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap((element, index) => duplicateObjectKeys(element, `${path}[${index}]`));
  if (!ts.isObjectLiteralExpression(node)) return [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name =
      ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
        ? property.name.text
        : property.name.getText(packageSource);
    const next = `${path}.${name}`;
    if (seen.has(name)) duplicates.push(next);
    else seen.add(name);
    duplicates.push(...duplicateObjectKeys(property.initializer, next));
  }
  return duplicates;
}

const rootExpression = (packageSource.statements[0] as ts.ExpressionStatement | undefined)?.expression;
const duplicatePackageKeys = rootExpression ? duplicateObjectKeys(rootExpression) : [];
const pkg = JSON.parse(packageText) as { scripts: Record<string, string> };
// THE AUDITED SET INCLUDES THE BARE `smoke` SCRIPT. An earlier version filtered on `smoke:` and so
// could not see `"smoke": "tsx packages/core/smoke.ts"` — a real suite that nothing runs, invisible
// to the audit BY CONSTRUCTION. Found by a second, independent derivation, not by this file.
// `smoke:ci` is the gate, not a suite, and `smoke:ci:offline` is the same gate run without its
// live-shaped suites (`bin/smoke/shard.mjs --offline`). Neither is a suite the gate could run, so
// neither is audited; the offline script is named here rather than exempted in UNGATED because an
// exemption is a suite the gate leaves out, and this is the gate leaving suites out.
const GATE_SCRIPTS = new Set(["smoke:ci", "smoke:ci:offline"]);
const all = new Set(Object.keys(pkg.scripts).filter((k) => (k === "smoke" || k.startsWith("smoke:")) && !GATE_SCRIPTS.has(k)));

/** Suites INVOKED by a script body. Anchored on `pnpm [run] <name>`, because a script is reached by
 *  being invoked, not by being mentioned.
 *
 *  A delimiter-anchored match on the bare word is NOT sufficient and briefly shipped here: every
 *  suite path contains `/smoke/`, so `tsx packages/core/smoke/members.smoke.ts` matched the bare
 *  `smoke` script and marked it reached. The audited set then looked one larger AND one more
 *  reached, and the unreached count did not move — a wrong answer that changed nothing visible.
 *  The pattern written to be careful about boundaries was less careful than the one it replaced. */
function suitesIn(body: string): string[] {
  return [...body.matchAll(/\bpnpm\s+(?:run\s+)?(smoke(?::[A-Za-z0-9:_-]+)?)(?![A-Za-z0-9:_/.-])/g)].map((m) => m[1]);
}

/** The body to GRADE for a script. `smoke:ci` runs a list file rather than naming its suites inline
 *  (`node bin/smoke/shard.mjs 0 1`), so its literal body names nothing and both directions below
 *  would go quiet on 228 suites at once — the reachability walk would call every one of them
 *  ungated, and the resolver would stop checking that any of them exists. Grading the synthesized
 *  chain keeps both directions pointed at the same suites they were pointed at when the chain was a
 *  string; the file is the source. This is the projection of it that the existing checks can read. */
const bodyOf = (name: string): string => (name === "smoke:ci" ? ciChainBody() : pkg.scripts[name] ?? "");

// REACHED MEANS REACHABLE FROM A ROOT THAT ACTUALLY RUNS, transitively — not "mentioned somewhere".
// The two relations agree on today's graph, which is why the weaker one survived: an allowlisted
// UNREACHABLE parent naming a child marks the child reached under "mentioned by", though nothing
// runs either. Roots are what CI actually invokes. `check` is a developer convenience
// chain; no workflow runs it, so it is not a root.
const ROOTS = ["smoke:ci", "test"];
const wfDir = join(ROOT, ".github", "workflows");
const roots = new Set<string>(ROOTS.filter((r) => r in pkg.scripts));
for (const f of readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")))
  for (const s of suitesIn(readFileSync(join(wfDir, f), "utf8"))) if (s in pkg.scripts) roots.add(s);

const reached = new Set<string>();
const frontier = [...roots];
while (frontier.length) {
  const cur = frontier.pop() as string;
  if (reached.has(cur)) continue;
  reached.add(cur);
  for (const s of suitesIn(bodyOf(cur))) if (s !== cur && s in pkg.scripts) frontier.push(s);
}

const ungated = [...all].filter((s) => !reached.has(s)).sort();
// A REASON IS TESTED FOR CONTENT, NOT PRESENCE. `s in UNGATED` passed on `""`, so this file could
// print "every ungated suite is listed with a reason" while an entry carried nothing at all. An
// exclusion with a stated reason is a decision; one without is the bug, and a key test cannot tell
// them apart. `UNTRIAGED` is a legitimate value — it is honest debt — but it is counted separately
// below rather than being allowed to read as a justification.
const MIN_REASON = 8;
const unexplained = ungated.filter((s) => !(s in UNGATED) || (UNGATED[s]?.reason ?? "").trim().length < MIN_REASON);
const staleAllowlist = Object.keys(UNGATED).filter((s) => !all.has(s) || reached.has(s)).sort();

const reviewDate = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
};
const reviewExemptions = (
  entries: Record<string, UngatedExemption>,
  today: string,
): { examined: number; invalid: string[]; expired: string[] } => {
  const invalid: string[] = [];
  const expired: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const date = reviewDate(entry.recheckBy);
    if (date === null) invalid.push(name);
    else if (date < today) expired.push(name);
  }
  return { examined: Object.keys(entries).length, invalid, expired };
};
const today = new Date().toISOString().slice(0, 10);
const exemptionReviews = reviewExemptions(UNGATED, today);
const expiryControl = reviewExemptions({ control: { reason: "control", recheckBy: "2000-01-01" } }, "2026-08-30");

let fail = 0;
console.log(`gate inventory: ${all.size} smoke scripts, ${all.size - ungated.length} reached, ${ungated.length} not run by anything\n`);

if (duplicatePackageKeys.length) {
  fail++;
  console.log(`  ✗ FAIL: root package JSON has ${duplicatePackageKeys.length} duplicate object key(s):`);
  for (const key of duplicatePackageKeys) console.log(`      ${key}`);
  console.log(`    JSON.parse keeps only the last value, so every downstream inventory sees a false unique map.`);
} else {
  console.log(`  ✓ root package JSON has no duplicate object keys`);
}

if (unexplained.length) {
  fail++;
  console.log(`  ✗ FAIL: ${unexplained.length} suite(s) exist but nothing runs them, and they are not in UNGATED:`);
  for (const s of unexplained) console.log(`      ${s}`);
  console.log(`    Gate it in smoke:ci, or add it to UNGATED with the reason it is excluded.`);
} else {
  console.log(`  ✓ every ungated suite is listed with a reason`);
}

console.log(`  exemption freshness examined: ${exemptionReviews.examined} of ${EXPECTED_EXEMPTIONS}`);
if (exemptionReviews.examined !== EXPECTED_EXEMPTIONS) {
  fail++;
  console.log(`  ✗ FAIL: exemption freshness did not examine every UNGATED entry`);
} else if (expiryControl.examined !== 1 || expiryControl.expired.length !== 1) {
  fail++;
  console.log(`  ✗ FAIL: exemption expiry control did not expire its one past-due entry`);
} else if (exemptionReviews.invalid.length || exemptionReviews.expired.length) {
  fail++;
  if (exemptionReviews.invalid.length) {
    console.log(`  ✗ FAIL: ${exemptionReviews.invalid.length} UNGATED exemption(s) have an invalid recheckBy date:`);
    for (const s of exemptionReviews.invalid) console.log(`      ${s}`);
  }
  if (exemptionReviews.expired.length) {
    console.log(`  ✗ FAIL: ${exemptionReviews.expired.length} UNGATED exemption(s) are past their recheckBy date ${today}:`);
    for (const s of exemptionReviews.expired) console.log(`      ${s}`);
    console.log(`    Re-verify the premise, gate the suite, or set a new review date with the decision.`);
  }
} else {
  console.log(`  ✓ all ${exemptionReviews.examined} UNGATED exemptions have a current recheckBy date`);
}

// THE REVERSE DIRECTION, and the gate needs both. Everything above asks "is this script reached?".
// This asks "does this chain entry resolve?" — a composite naming a script that does not exist.
// pnpm fails loudly on it, so it is not silent like the others, but it is the same family and it
// costs nothing to pin: a rename that updates the definition and not the chain, or updates the
// chain and not the definition, breaks the gate at the point of the rename rather than later. It
// came out of a real three-way merge where one side's chain named two scripts the other side had
// renamed away.
// A segment carrying `-F`/`--filter <pkg>` resolves its script in THAT PACKAGE's manifest, so
// `smoke:backup-perms:live` delegating to `smoke:backup:live` is correct even though no root script
// has that name. An earlier version flagged it (a phantom), and the repair SKIPPED every delegating
// segment — which silenced the branch instead of teaching it where to look, so
// `pnpm -F @cotal-ai/core smoke:not-real` produced no finding and passed. A check that cannot
// resolve a target must say so, not say nothing: SKIPPING IS "I COULD NOT CHECK THIS AND KEPT QUIET".
// It now reads the named package's manifest and resolves there; an unreadable or unknown package is
// itself reported rather than exempted.
const workspaceManifest = (pkgName: string): { dir: string; scripts: Record<string, string> } | null => {
  for (const dir of ["packages", "implementations", "extensions", "bin"]) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const pj = join(base, entry, "package.json");
      if (!existsSync(pj)) continue;
      try {
        const d = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; scripts?: Record<string, string> };
        if (d.name === pkgName) return { dir: join(dir, entry), scripts: d.scripts ?? {} };
      } catch { /* unparseable manifest is reported by the caller, not swallowed here */ }
    }
  }
  return null;
};
const dangling: Array<[string, string]> = [];
for (const name of Object.keys(pkg.scripts))
  for (const segment of bodyOf(name).split("&&")) {
    const filtered = /(?:^|\s)(?:-F|--filter)\s+(\S+)/.exec(segment);
    if (filtered) {
      // `pnpm -F <pkg>... build` selects a dependency closure; only a smoke target needs resolving.
      const target = suitesIn(segment).find((t) => t !== name);
      if (!target) continue;                       // a build step, nothing to resolve
      const pkgName = filtered[1].replace(/\.\.\.$/, "");
      const found = workspaceManifest(pkgName);
      if (found === null) dangling.push([name, `${target} (in unresolvable package ${pkgName})`]);
      else if (!(target in found.scripts)) dangling.push([name, `${target} (absent from ${pkgName})`]);
      continue;
    }
    for (const target of suitesIn(segment))
      if (target !== name && !(target in pkg.scripts)) dangling.push([name, target]);
  }
if (dangling.length) {
  fail++;
  console.log(`  ✗ FAIL: ${dangling.length} composite entr(ies) name a script that does not exist:`);
  for (const [host, missing] of dangling) console.log(`      ${host} -> ${missing}`);
} else {
  console.log(`  ✓ every composite entry resolves to a defined script`);
}

// THE CHAIN FILE'S OWN TWO PROPERTIES, neither of which the checks above can see. Resolution is
// covered — `bodyOf` feeds the chain into both directions — but those checks are satisfied by a
// chain of one entry and by a chain that names the same suite twice, and both of those are the
// gate quietly running less than it says. An empty chain is the sharp one: `smoke:ci` would exit 0
// in seconds and every branch would read green.
const chain = readCiSuites() as string[];
const missingChainEntries = chain.filter((suite) => !(suite in pkg.scripts));
const dupes = [...new Set(chain.filter((s, i) => chain.indexOf(s) !== i))].sort();
if (missingChainEntries.length) {
  fail++;
  console.log(`  ✗ FAIL: bin/smoke/ci-suites.txt names ${missingChainEntries.length} missing script(s): ${missingChainEntries.join(", ")}`);
} else if (chain.length < 2) {
  fail++;
  console.log(`  ✗ FAIL: bin/smoke/ci-suites.txt holds ${chain.length} suite(s) — a chain that runs nothing exits 0`);
} else if (dupes.length) {
  fail++;
  console.log(`  ✗ FAIL: bin/smoke/ci-suites.txt names ${dupes.length} suite(s) twice: ${dupes.join(", ")}`);
  console.log(`    A duplicate costs a full run of that suite and hides which copy a merge added.`);
} else {
  console.log(`  ✓ the smoke:ci chain file holds ${chain.length} suites, no duplicates`);
}

// An allowlist that outlives its entries rots into a place where gating a suite goes unnoticed.
if (staleAllowlist.length) {
  fail++;
  console.log(`  ✗ FAIL: UNGATED lists ${staleAllowlist.length} suite(s) that no longer need listing (gated now, or gone):`);
  for (const s of staleAllowlist) console.log(`      ${s}`);
  console.log(`    Remove them, so the list keeps meaning what it says.`);
} else {
  console.log(`  ✓ no stale UNGATED entries`);
}

// THE SUITE CENSUS (#1114). A reached suite can still be unable to fail, and no run shows it: a
// swallowed throw exits 0 and a deleted cell lowers a tally nothing compares. So the entry file of
// each reached suite is parsed here, and both predicates are first run over controls that must red,
// because a census that cannot fire is the defect it is looking for. Both accept only shapes whose
// failure they can follow to the exit status; anything else is refused rather than guessed at.
const UNPINNED_PATH = join(ROOT, "bin", "smoke", "unpinned-suites.txt");
/** sha256 of the entries of `unpinned-suites.txt` with any `paid ` prefix removed. Paying an entry keeps
 *  this; adding or renaming one changes it, so the debt cannot take in a new suite without editing the gate. */
const UNPINNED_DIGEST = "8d7a911e3c2411715048ab2f4cfd196fbbf82bba1cae07a133288aa7e9cfd842";
const SUITE_FILE = /(?:^|\s)["']?([\w./-]+\.(?:ts|tsx|mts|mjs|js|cjs))["']?(?=\s|$)/g;
const PIN_NAME = /^EXPECTED(?:_[A-Z0-9]+)*$/;
/** `==` and `!=` coerce, so a tally of "2" matches a pin of 2. */
const EQUALITY = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken];

const parseSuite = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Every node under `root` matching `pred`, not descending into nested functions unless `deep`. */
function findIn<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T, deep = false): T[] {
  const found: T[] = [];
  const visit = (n: ts.Node) => {
    if (pred(n)) found.push(n);
    if (!deep && n !== root && ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}
/** `n` without the parentheses and type assertions around it, which change nothing at run time. */
const unwrap = (n: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n) ? unwrap(n.expression) : n;
/** `process.<name>`, or `process["<name>"]`, which reads and writes the same property. */
const isProcessMember = (n: ts.Node, name: string) =>
  (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && unwrap(n.expression).getText() === "process" &&
  (ts.isPropertyAccessExpression(n) ? n.name.text === name : ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === name);
const isExitCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && isProcessMember(unwrap(n.expression), "exit");
const nonZeroLiteral = (n: ts.Node | undefined): boolean => !!n && ts.isNumericLiteral(n) && Number(n.text) !== 0;
const isExitCode = (n: ts.Node) => isProcessMember(n, "exitCode");
/** The values `n` can take when it is a numeric literal, a lookup into an object literal of them, or a sum
 *  of those. A lookup can miss, which gives undefined, and a sum with a miss gives NaN. */
function numericValues(n: ts.Node): Array<number | undefined> | undefined {
  const e = unwrap(n);
  if (ts.isNumericLiteral(e)) return [Number(e.text)];
  if (ts.isElementAccessExpression(e)) {
    const table = unwrap(e.expression);
    const values = ts.isObjectLiteralExpression(table) ? table.properties.map((p) => (ts.isPropertyAssignment(p) ? numericValues(p.initializer) : undefined)) : [undefined];
    return values.every(Boolean) ? [...values.flatMap((v) => v!), undefined] : undefined;
  }
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  const [left, right] = [numericValues(e.left), numericValues(e.right)];
  return left && right && left.flatMap((l) => right.map((r) => (l ?? NaN) + (r ?? NaN)));
}
/** Whether `status` fails the run: every value it can take is an integer from 1 to 255. The OS keeps only
 *  the low eight bits, so `process.exit(256)` exits 0. With `orThrows`, a number that is not an integer
 *  also counts, since `process.exit` throws on it rather than exiting. `process.exit(undefined)` exits 0. */
const failingStatus = (status: ts.Node | undefined, orThrows = false): boolean => {
  const values = status && numericValues(status);
  return !!values?.length && values.every((v) => v !== undefined && (Number.isInteger(v) ? v >= 1 && v <= 255 : orThrows));
};
const isAssignment = (k: ts.SyntaxKind) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
const LOGICAL = [
  ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
];
/** The node that writes `ref`: an assignment, `++`, `--`, `delete`, a `for in`/`for of` head, or the
 *  destructuring assignment `ref` is a target of. Undefined when `ref` is only read. */
function writeOf(ref: ts.Node): ts.Node | undefined {
  const p = ref.parent;
  if (unwrap(p) !== p || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) return writeOf(p);
  if ((ts.isShorthandPropertyAssignment(p) && p.name === ref) || (ts.isPropertyAssignment(p) && p.initializer === ref) || ts.isSpreadAssignment(p)) return writeOf(p.parent);
  // A `=` inside a destructuring target is a default value; the destructuring assignment is the write.
  if (ts.isBinaryExpression(p) && p.left === ref && isAssignment(p.operatorToken.kind)) return (p.operatorToken.kind === ts.SyntaxKind.EqualsToken && writeOf(p)) || p;
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return p;
  if (ts.isDeleteExpression(p) || ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === ref)) return p;
  return undefined;
}
const failingCode = (w: ts.Node) => ts.isBinaryExpression(w) && w.operatorToken.kind === ts.SyntaxKind.EqualsToken && isExitCode(unwrap(w.left)) && failingStatus(w.right);
/** An exit status that keeps a non-zero `process.exitCode`: none, `process.exitCode`, or `process.exitCode ?? <n>`. */
const honorsExitCode = (status: ts.Expression | undefined): boolean => {
  if (!status) return true;
  const s = unwrap(status);
  return isExitCode(s) || (ts.isBinaryExpression(s) && s.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && isExitCode(unwrap(s.left)) && ts.isNumericLiteral(unwrap(s.right)));
};
const statementExpr = (s: ts.Node): ts.Node => unwrap(ts.isExpressionStatement(s) ? s.expression : s);
const exitsWith = (s: ts.Node, status: (arg: ts.Expression | undefined) => boolean) => {
  const e = statementExpr(s);
  return isExitCall(e) && status(e.arguments[0]);
};
const setsFailingCode = (s: ts.Node) => failingCode(statementExpr(s));
const endsRun = (s: ts.Node) => ts.isThrowStatement(s) || ts.isReturnStatement(s) || exitsWith(s, () => true);
/** The statements `arm` runs in order, up to the first that ends it, or an arrow body expression. Each runs
 *  only when none before it throws. A statement nested in a branch, loop or callback is not one of them. */
const runs = (arm: ts.Node): ts.Node[] => {
  const list = ts.isBlock(arm) ? [...arm.statements] : [arm];
  const end = list.findIndex(endsRun);
  return end < 0 ? list : list.slice(0, end + 1);
};
const enclosingFunction = (n: ts.Node): ts.Node | undefined => (ts.isSourceFile(n.parent) ? undefined : ts.isFunctionLike(n.parent) ? n.parent : enclosingFunction(n.parent));
const within = (n: ts.Node, outer: ts.Node) => outer.pos <= n.pos && n.end <= outer.end;

/** The key `name` binds or reads: an identifier, a literal, or a computed literal. */
const nameKey = (name: ts.Node | undefined): string | undefined =>
  name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text : name && ts.isComputedPropertyName(name) ? nameKey(name.expression) : undefined;
/** The key a member access reads: `o.k`, or `o["k"]` with a literal key. */
const memberKey = (n: ts.Node): string | undefined => (ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) ? nameKey(n.argumentExpression) : undefined);

/** One pass over a suite: a checker that resolves a name to the declaration it binds, the way the
 *  language scopes it, the writes to each variable and to `process.exitCode`, and every value the file
 *  binds to each property key, on any object. */
type SuiteIndex = { checker: ts.TypeChecker; writes: Map<ts.Symbol, ts.Node[]>; exitCodeWrites: ts.Node[]; keyed: Map<string, ts.Node[]> };
const suiteIndexes = new WeakMap<ts.SourceFile, SuiteIndex>();
function indexSuite(sf: ts.SourceFile): SuiteIndex {
  const cached = suiteIndexes.get(sf);
  if (cached) return cached;
  const host = ts.createCompilerHost({});
  host.getSourceFile = (f) => (f === sf.fileName ? sf : undefined);
  const checker = ts.createProgram([sf.fileName], { noLib: true, noResolve: true, allowJs: true, types: [] }, host).getTypeChecker();
  const ix: SuiteIndex = { checker, writes: new Map(), exitCodeWrites: [], keyed: new Map() };
  const visit = (n: ts.Node) => {
    const w = ts.isIdentifier(n) || isExitCode(n) ? writeOf(n) : undefined;
    if (w && isExitCode(n)) ix.exitCodeWrites.push(w);
    // The name in `({ x } = o)` resolves to the property; the variable it writes is the value symbol.
    const sym = !w || !ts.isIdentifier(n) ? undefined : ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
    if (sym) (ix.writes.get(sym) ?? ix.writes.set(sym, []).get(sym)!).push(w!);
    const [key, value] =
      ts.isMethodDeclaration(n) ? [nameKey(n.name), n]
      : ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n) ? [nameKey(n.name), n.initializer]
      : ts.isShorthandPropertyAssignment(n) ? [n.name.text, n.name]
      : ts.isBinaryExpression(n) && isAssignment(n.operatorToken.kind) ? [memberKey(unwrap(n.left)), n.right]
      : [];
    if (key !== undefined && value) (ix.keyed.get(key) ?? ix.keyed.set(key, []).get(key)!).push(value);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  suiteIndexes.set(sf, ix);
  return ix;
}

/** Every value the file gives `target`: itself, the declarations and writes of a name, and every value
 *  bound to a member's key on any object, since which object a member is read from is not tracked. */
function valuesOf(sf: ts.SourceFile, target: ts.Node, out = new Set<ts.Node>()): Set<ts.Node> {
  const t = unwrap(target);
  if (out.has(t)) return out;
  out.add(t);
  // `?:`, `||`, `&&`, `??` and `||=`, `&&=`, `??=` evaluate to one of their operands; a comma and any other assignment to the right side.
  const operands =
    ts.isConditionalExpression(t) ? [t.whenTrue, t.whenFalse]
    : !ts.isBinaryExpression(t) ? []
    : LOGICAL.includes(t.operatorToken.kind) ? [t.left, t.right]
    : t.operatorToken.kind === ts.SyntaxKind.CommaToken || isAssignment(t.operatorToken.kind) ? [t.right]
    : [];
  for (const o of operands) valuesOf(sf, o, out);
  const { checker, writes, keyed } = indexSuite(sf);
  // `const { k } = o` reads `o.k`. `process.exit` is the exit itself, so no function of the file named `exit` stands for it.
  const key = isProcessMember(t, "exit") ? undefined : ts.isBindingElement(t) && ts.isObjectBindingPattern(t.parent) ? nameKey(t.propertyName ?? t.name) : memberKey(t);
  for (const v of (key !== undefined && keyed.get(key)) || []) valuesOf(sf, v, out);
  const sym = !ts.isIdentifier(t) ? undefined : ts.isShorthandPropertyAssignment(t.parent) && t.parent.name === t ? checker.getShorthandAssignmentValueSymbol(t.parent) : checker.getSymbolAtLocation(t);
  for (const d of sym ? [...(sym.declarations ?? []), ...(writes.get(sym) ?? [])] : []) {
    const v = ts.isVariableDeclaration(d) ? d.initializer : d;
    if (v) valuesOf(sf, v, out);
  }
  return out;
}
/** `process.exit` itself, or a name destructured from `process` as `exit`. */
const isExitRef = (v: ts.Node): boolean => {
  if (!ts.isBindingElement(v)) return isProcessMember(v, "exit");
  const decl = v.parent.parent;
  return ts.isObjectBindingPattern(v.parent) && nameKey(v.propertyName ?? v.name) === "exit" && ts.isVariableDeclaration(decl) && !!decl.initializer && unwrap(decl.initializer).getText() === "process";
};
const namesExit = (sf: ts.SourceFile, callee: ts.Node) => [...valuesOf(sf, callee)].some(isExitRef);
/** A `process.exit` call a run can make: where it is, and its status. */
type Exit = { site: ts.Node; status: ts.Expression | undefined };
/** The exits calling `callee` can make, as `site` with first argument `status`: itself when it names
 *  `process.exit`, and those of every function of the file it names, each followed once into `seen`. */
function exitsOfCall(sf: ts.SourceFile, callee: ts.Node, site: ts.Node, status: ts.Expression | undefined, seen: Set<ts.Node>): Exit[] {
  return [...valuesOf(sf, callee)].flatMap((v) => {
    if (isExitRef(v)) return [{ site, status }];
    if (!ts.isFunctionLike(v) || seen.has(v)) return [];
    seen.add(v);
    return exitsIn(sf, v, seen);
  });
}
/** The exits running `n` can make, directly or through the calls it makes. */
function exitsIn(sf: ts.SourceFile, n: ts.Node, seen = new Set<ts.Node>()): Exit[] {
  return findIn(n, ts.isCallExpression).flatMap((c) => exitsOfCall(sf, c.expression, c, c.arguments[0], seen));
}
const canExitZero = (sf: ts.SourceFile, n: ts.Node) => exitsIn(sf, n).some((e) => !failingStatus(e.status));
/** Whether a run can stop at `s` without failing, or never get past it: `s` ends its list, a branch or block
 *  in it returns, or running it can exit 0. A function declaration runs none of its body. */
const canEndRun = (sf: ts.SourceFile, s: ts.Node) => endsRun(s) || (!ts.isFunctionLike(s) && (findIn(s, ts.isReturnStatement).length > 0 || canExitZero(sf, s)));
/** Whether a failing `process.exitCode` set at `at` holds to the end: every code the file writes fails, and
 *  every exit that can follow reads the code or fails. A top-level exit before a top-level `at` ran first. */
const codeHolds = (sf: ts.SourceFile, at: ts.Node) =>
  indexSuite(sf).exitCodeWrites.every(failingCode) &&
  findIn(sf, ts.isCallExpression, true).every((c) => !namesExit(sf, c.expression) || (c.end <= at.pos && !enclosingFunction(c) && !enclosingFunction(at)) || failingStatus(c.arguments[0]) || honorsExitCode(c.arguments[0]));
/** Whether a throw from `n` fails the run: no function or `try` with a catch encloses it. */
const throwEscapes = (n: ts.Node) => {
  for (let p = n; !ts.isSourceFile(p); p = p.parent)
    if (ts.isFunctionLike(p.parent) || (ts.isTryStatement(p.parent) && p.parent.tryBlock === p && p.parent.catchClause)) return false;
  return true;
};
/** Whether running `arm` fails the run: a statement of its runs exits with a failing status, sets a failing
 *  code that holds, or throws where a throw escapes, and every statement before it can neither end the run
 *  nor throw past it where a throw would not escape. */
function armFails(sf: ts.SourceFile, arm: ts.Node): boolean {
  const list = runs(arm);
  const escapes = throwEscapes(arm);
  const i = list.findIndex((r) => exitsWith(r, failingStatus) || (setsFailingCode(r) && codeHolds(sf, r)) || (ts.isThrowStatement(r) && escapes));
  return i === 0 || (i > 0 && escapes && !list.slice(0, i).some((r) => canEndRun(sf, r)));
}

/** An exit status that cannot be 0: a failing status, or a variable whose every declaration initializes
 *  it to one and whose every write assigns one or is the last statement of the guarded `try`, which runs
 *  only once every risky line succeeded (a fail-closed default). */
function cannotBeZero(sf: ts.SourceFile, arg: ts.Expression | undefined, guarded?: ts.Block): boolean {
  if (failingStatus(arg)) return true;
  const id = arg && unwrap(arg);
  if (!id || !ts.isIdentifier(id)) return false;
  const { checker, writes } = indexSuite(sf);
  const sym = checker.getSymbolAtLocation(id);
  const last = guarded?.statements[guarded.statements.length - 1];
  // The zeroing statement runs last in the try: it is the try's last statement, or ends a block or an `if` arm that is.
  const runsLast = (w: ts.Node): boolean => {
    let n = w.parent;
    if (!guarded || !ts.isExpressionStatement(n)) return false;
    for (let p = n.parent; p !== guarded; n = p, p = p.parent)
      if (!(ts.isBlock(p) && p.statements[p.statements.length - 1] === n) && !(ts.isIfStatement(p) && p.expression !== n)) return false;
    return n === last;
  };
  return !!sym?.declarations?.length && sym.declarations.every((d) => ts.isVariableDeclaration(d) && failingStatus(d.initializer)) && (writes.get(sym) ?? []).every(
    (w) => (ts.isBinaryExpression(w) && w.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(w.left)) && failingStatus(w.right)) || runsLast(w),
  );
}

/** A catch arm keeps a throw from leaving through a `finally` exit of `status` with status 0 when its first
 *  statement exits with a status that cannot be 0, or sets `process.exitCode` to a failing status that the
 *  exit honors while nothing in `scope` (the arm, the `finally` and the functions they call) writes any other
 *  code. A statement before it can throw past it into the `finally`, and a rethrow does not count: the
 *  `finally` exit ends the process first. */
function catchFails(sf: ts.SourceFile, arm: ts.Node | undefined, status: ts.Expression | undefined, scope: ts.Node[], guarded?: ts.Block): boolean {
  if (!arm) return false;
  const first = ts.isBlock(arm) ? arm.statements[0] : arm;
  const keepsCode = honorsExitCode(status) && indexSuite(sf).exitCodeWrites.filter((w) => scope.some((s) => within(w, s))).every(failingCode);
  return !!first && (exitsWith(first, (status) => cannotBeZero(sf, status, guarded)) || (keepsCode && setsFailingCode(first)));
}

/** Lines of `process.exit` calls a `finally` can make, directly or through the calls it makes, that can turn
 *  a throw into exit 0: a try/finally or a promise `.finally` whose catch arm does not fail through that
 *  exit, and whose exit status can be 0. */
function swallowedThrows(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  // `seen` collects the functions the `finally` and the catch arm call; a code they write can clear the arm's.
  const flag = (collect: (seen: Set<ts.Node>) => Exit[], block: ts.Node, catchArm: ts.Node | undefined, guarded?: ts.Block) => {
    const seen = new Set<ts.Node>();
    const exits = collect(seen);
    if (catchArm) exitsIn(sf, catchArm, seen);
    const scope = [block, ...(catchArm ? [catchArm] : []), ...seen];
    for (const exit of exits)
      if (!failingStatus(exit.status, true) && !cannotBeZero(sf, exit.status, guarded) && !catchFails(sf, catchArm, exit.status, scope, guarded))
        lines.push(sf.getLineAndCharacterOfPosition(exit.site.getStart(sf)).line + 1);
  };
  const visit = (n: ts.Node) => {
    if (ts.isTryStatement(n) && n.finallyBlock) flag((seen) => exitsIn(sf, n.finallyBlock!, seen), n.finallyBlock, n.catchClause?.block, n.tryBlock);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "finally") {
      const handler = n.arguments[0];
      // Only a `.catch` directly before `.finally` sees every rejection; an earlier one misses a later `.then`.
      const prev = n.expression.expression;
      const caught = ts.isCallExpression(prev) && ts.isPropertyAccessExpression(prev.expression) && prev.expression.name.text === "catch" ? prev.arguments[0] : undefined;
      // Calling a generator `.catch` handler runs none of its body.
      if (handler) flag((seen) => exitsOfCall(sf, handler, handler, undefined, seen), handler, caught && (ts.isArrowFunction(caught) || (ts.isFunctionExpression(caught) && !caught.asteriskToken)) ? caught.body : undefined);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/** The expression statements that call `fn`: `f()`, `await f()`, `void f()`, or a `.then`, `.catch` or
 *  `.finally` chained on that call. A callback argument or an assigned result does not count. */
function callersOf(sf: ts.SourceFile, fn: ts.SignatureDeclaration): ts.ExpressionStatement[] {
  let decl = fn.parent;
  while (ts.isParenthesizedExpression(decl)) decl = decl.parent;
  const { checker, writes } = indexSuite(sf);
  const name = ts.isFunctionDeclaration(fn) ? fn.name : ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name : undefined;
  // A call by name reaches `fn` only through a binding that is declared once and never written.
  const sym = name && checker.getSymbolAtLocation(name);
  const binding = sym && sym.declarations?.length === 1 && !writes.has(sym) ? sym : undefined;
  const calls = (e: ts.Node): boolean => {
    e = unwrap(e);
    if (ts.isAwaitExpression(e) || ts.isVoidExpression(e)) return calls(e.expression);
    if (!ts.isCallExpression(e)) return false;
    const callee = unwrap(e.expression);
    if (callee === fn || (binding && ts.isIdentifier(callee) && checker.getSymbolAtLocation(callee) === binding)) return true;
    return ts.isPropertyAccessExpression(callee) && ["then", "catch", "finally"].includes(callee.name.text) && calls(callee.expression);
  };
  return findIn(sf, ts.isExpressionStatement, true).filter((s) => calls(s.expression));
}

/** Whether every run that passes gets to `stmt`: no earlier statement of its list can end the run, and that
 *  list runs whenever its own statement does. That holds for the file, a bare block, a `try` or `finally`
 *  block, and the body of a function that a reached statement calls; never for a branch, loop or catch arm.
 *  A throw before `stmt` skips it, so a catch arm or rejection handler on the way out must fail the run. */
function runsTo(sf: ts.SourceFile, stmt: ts.Statement, seen = new Set<ts.Node>()): boolean {
  const list = stmt.parent;
  if (!ts.isSourceFile(list) && !ts.isBlock(list)) return false;
  for (const s of list.statements) {
    if (s === stmt) break;
    if (canEndRun(sf, s)) return false;
  }
  if (ts.isSourceFile(list)) return true;
  const owner = list.parent;
  // A throw before `stmt` lands in the catch arm, and a `return` in the `finally` drops it.
  if (ts.isTryStatement(owner) && owner.tryBlock === list && ((owner.catchClause && !armFails(sf, owner.catchClause.block)) || (owner.finallyBlock && findIn(owner.finallyBlock, ts.isReturnStatement).length > 0)))
    return false;
  if (ts.isSourceFile(owner) || ts.isBlock(owner) || ts.isTryStatement(owner)) return runsTo(sf, ts.isTryStatement(owner) ? owner : list, seen);
  // Calling a generator runs none of its body.
  if (!(ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isArrowFunction(owner)) || owner.asteriskToken || seen.has(owner)) return false;
  seen.add(owner);
  // An async body can stop at an await while the statements after an unawaited call run on, so none of them may exit.
  const preempts = (s: ts.ExpressionStatement) =>
    !!(ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Async) && !ts.isAwaitExpression(unwrap(s.expression)) &&
    findIn(sf, ts.isCallExpression, true).some((c) => c.pos >= s.end && enclosingFunction(c) === enclosingFunction(s) && (isExitCall(c) || canExitZero(sf, c)));
  const handled = (s: ts.ExpressionStatement) =>
    findIn(s, ts.isCallExpression).every((c) => {
      const m = unwrap(c.expression);
      const handler = !ts.isPropertyAccessExpression(m) ? undefined : m.name.text === "catch" ? c.arguments[0] : m.name.text === "then" ? c.arguments[1] : undefined;
      return !handler || ((ts.isArrowFunction(handler) || (ts.isFunctionExpression(handler) && !handler.asteriskToken)) && armFails(sf, handler.body));
    });
  return callersOf(sf, owner).some((s) => runsTo(sf, s, seen) && handled(s) && !preempts(s));
}

/** A suite pins its count when an `EXPECTED*` constant, declared once, initialized to a positive literal
 *  and never written, is compared by equality with a tally as the whole condition of a statement every
 *  run reaches, and the mismatch side fails the run with a status `<n>` from 1 to 255: an `if` whose
 *  mismatch arm always runs `process.exit(<n>)`, sets `process.exitCode = <n>` when no other code is
 *  written and every exit that can follow honors it, or throws outside any function or `try` with a
 *  catch; or `process.exit(<cmp> ? 0 : <n>)`. Equality catches a lost cell and an added one; `<` lets the total
 *  drift up. Any other shape pins nothing. */
function pinsCellCount(sf: ts.SourceFile): boolean {
  const { checker, writes } = indexSuite(sf);
  const isPin = (n: ts.Node) => {
    const o = unwrap(n);
    const sym = ts.isIdentifier(o) && PIN_NAME.test(o.text) ? checker.getSymbolAtLocation(o) : undefined;
    const decl = sym?.declarations?.length === 1 ? sym.declarations[0] : undefined;
    return !!decl && ts.isVariableDeclaration(decl) && nonZeroLiteral(decl.initializer) && !writes.has(sym!);
  };
  // True when `cond` is true on a mismatch, false when it is true on a match, undefined when it is not a pin comparison.
  const onMismatch = (cond: ts.Node): boolean | undefined => {
    const b = unwrap(cond);
    if (!ts.isBinaryExpression(b) || !EQUALITY.includes(b.operatorToken.kind)) return undefined;
    const [pin, tally] = isPin(b.left) ? [b.left, b.right] : [b.right, b.left];
    if (!isPin(pin) || isPin(tally) || ts.isLiteralExpression(unwrap(tally))) return undefined;
    return b.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  };
  const failsOnMismatch = (s: ts.Node): boolean => {
    if (ts.isIfStatement(s)) {
      const mismatch = onMismatch(s.expression);
      const arm = mismatch === undefined ? undefined : mismatch ? s.thenStatement : s.elseStatement;
      return !!arm && armFails(sf, arm);
    }
    const e = statementExpr(s);
    const status = isExitCall(e) && e.arguments[0] ? unwrap(e.arguments[0]) : undefined;
    if (!status || !ts.isConditionalExpression(status)) return false;
    const mismatch = onMismatch(status.condition);
    return mismatch !== undefined && failingStatus(mismatch ? status.whenTrue : status.whenFalse);
  };
  return findIn(sf, (n): n is ts.Statement => ts.isIfStatement(n) || ts.isExpressionStatement(n), true).some((s) => failsOnMismatch(s) && runsTo(sf, s));
}

// Controls: each predicate must red on the defect shape and pass the repaired one, or the census
// below proves nothing.
const control = (src: string) => parseSuite("control.ts", src);
const pinsWith = (body: string) => pinsCellCount(control(`const EXPECTED_CELLS = 5; ${body}`));
const swallows = (src: string) => swallowedThrows(control(src)).length === 1;
const fails = (src: string) => swallowedThrows(control(src)).length === 0;
const censusControls: Array<[string, boolean]> = [
  ["a finally exit with no catch arm is a swallowed throw", swallows(`try { throw new Error("x"); } finally { process.exit(process.exitCode ?? 0); }`)],
  ["a catch arm that only logs still swallows", swallows(`try { f(); } catch (e) { console.error(e); } finally { process.exit(fail ? 1 : 0); }`)],
  ["a promise .finally exit with no .catch is a swallowed throw", swallows(`main().finally(() => process.exit(process.exitCode ?? 0));`)],
  ["a catch arm setting exitCode = 1 fails the run", fails(`try { f(); } catch (e) { process.exitCode = 1; } finally { process.exit(process.exitCode ?? 0); }`)],
  ["a .catch setting exitCode = 1 fails the run", fails(`main().catch(() => { process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0));`)],
  ["a fail-closed default exit status fails the run", fails(`let code = 1; try { f(); code = 0; } finally { process.exit(code); }`)],
  ["a rethrow does not fail through a finally exit", swallows(`try { f(); } catch (e) { throw e; } finally { process.exit(process.exitCode ?? 0); }`)],
  ["an exitCode the finally exit ignores does not fail the run", swallows(`try { f(); } catch (e) { process.exitCode = 1; } finally { process.exit(fail ? 1 : 0); }`)],
  ["an exitCode the finally exit inverts does not fail the run", swallows(`try { f(); } catch (e) { process.exitCode = 1; } finally { process.exit(process.exitCode ? 0 : 1); }`)],
  ["an exitCode set only in a branch of the catch arm still swallows", swallows(`try { f(); } catch (e) { if (x) process.exitCode = 1; } finally { process.exit(process.exitCode ?? 0); }`)],
  ["a computed exitCode in the catch arm still swallows", swallows(`try { f(); } catch (e) { process.exitCode = Number(x); } finally { process.exit(process.exitCode ?? 0); }`)],
  ["a fail-closed default cleared before the risky line swallows", swallows(`let code = 1; try { code = 0; f(); } finally { process.exit(code); }`)],
  ["a catch arm that calls anything before failing swallows", swallows(`try { f(); } catch (e) { cleanup(); process.exitCode = 1; } finally { process.exit(process.exitCode ?? 0); }`)],
  ["a catch arm exiting 256 swallows, since the status keeps eight bits", swallows(`try { f(); } catch (e) { process.exit(256); } finally { process.exit(0); }`)],
  ["an exitCode decremented in the finally swallows", swallows(`try { f(); } catch (e) { process.exitCode = 1; } finally { process.exitCode--; process.exit(process.exitCode ?? 0); }`)],
  ["a sum that can be 0 is not a failing status", swallows(`let code = -1; try { f(); } finally { process.exit(1 + code); }`)],
  ["a status looked up in a catch arm can miss and throw past it", swallows(`try { f(); } catch (e) { process.exit(128 + ({ SIGINT: 2 })[sig]); } finally { process.exit(0); }`)],
  ["a signal status looked up in a table of failing sums fails the run", fails(`try { f(); } finally { process.exit(128 + ({ SIGINT: 2, SIGTERM: 15 } as Record<string, number>)[sig]!); }`)],
  ["a generator .catch handler runs none of its body", swallows(`main().catch(function* () { process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0));`)],
  ["a bare lookup that misses exits 0", swallows(`try { f(); } finally { process.exit(({ SIGTERM: 15 })[sig]); }`)],
  ["a .catch before a later .then misses its throw", swallows(`main().catch(() => { process.exitCode = 1; }).then(g).finally(() => process.exit(process.exitCode ?? 0));`)],
  ["a finally calling a function that exits 0 swallows", swallows(`function cleanup() { process.exit(0); } try { f(); } finally { cleanup(); }`)],
  ["a named .finally handler that exits 0 swallows", swallows(`function cleanup() { process.exit(0); } main().finally(cleanup);`)],
  ["a suite with no pinned count is unpinned", !pinsCellCount(control(`let ran = 0; ran++; console.log(ran);`))],
  ["a one-sided pin is unpinned", !pinsWith(`if (ran < EXPECTED_CELLS) process.exit(1);`)],
  ["an equality pin that exits non-zero is pinned", pinsWith(`if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["an equality pin that sets exitCode is pinned", pinsWith(`if (ran !== EXPECTED_CELLS) { console.log(ran); process.exitCode = 1; }`)],
  ["a ?: exit status on the pin is pinned", pinsWith(`process.exit(ran === EXPECTED_CELLS ? 0 : 1);`)],
  ["a pin in an async main that runs is pinned", pinsCellCount(control(`async function main() { const EXPECTED_CELLS = 5; if (ran !== EXPECTED_CELLS) process.exit(1); } main().catch(() => { process.exitCode = 1; });`))],
  ["a pin that is only logged is unpinned", !pinsWith(`console.log(ran !== EXPECTED_CELLS);`)],
  ["a pin after an exit is unpinned", !pinsWith(`process.exit(0); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin compared with itself is unpinned", !pinsWith(`if (EXPECTED_CELLS !== EXPECTED_CELLS) process.exit(1);`)],
  ["a parenthesized pin compared with itself is unpinned", !pinsWith(`if ((EXPECTED_CELLS) !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a block that exits 0 is unpinned", !pinsWith(`{ process.exit(0); } if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a branch that returns is unpinned", !pinsWith(`function main() { if (ran < EXPECTED_CELLS) return; if (ran !== EXPECTED_CELLS) process.exit(1); } main();`)],
  ["a pin after a branch that exits 1 is pinned", pinsWith(`if (failed) process.exit(1); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a call to a function that exits 0 is unpinned", !pinsWith(`const skip = () => { process.exit(0); }; skip(); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a call to a binding reassigned to exit 0 is unpinned", !pinsWith(`let skip = () => {}; skip = () => process.exit(0); skip(); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a call to a function that exits 1 is pinned", pinsWith(`function bail() { process.exit(1); } if (failed) bail(); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a loose != pin is unpinned, since it coerces", !pinsWith(`if (ran != EXPECTED_CELLS) process.exit(1);`)],
  ["a reassigned pin is unpinned", !pinsWith(`EXPECTED_CELLS = ran; if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a mismatch exitCode a later exit overrides is unpinned", !pinsWith(`if (ran !== EXPECTED_CELLS) process.exitCode = 1; process.exit(0);`)],
  ["a mismatch exitCode a bracket write clears is unpinned", !pinsWith(`if (ran !== EXPECTED_CELLS) process.exitCode = 1; process["exitCode"] = 0;`)],
  ["a mismatch throw a catch swallows is unpinned", !pinsWith(`try { if (ran !== EXPECTED_CELLS) throw new Error("x"); } catch (e) { console.error(e); }`)],
  ["a mismatch counted in a failure tally is unpinned", !pinsWith(`let fail = 0; if (ran !== EXPECTED_CELLS) fail++; fail = 0; process.exit(fail ? 1 : 0);`)],
  ["a pin inside a conjunction is unpinned", !pinsWith(`if (ran !== EXPECTED_CELLS && false) process.exit(1);`)],
  ["a pin inside a disjunction is unpinned", !pinsWith(`if (ran === EXPECTED_CELLS || true) {} else process.exit(1);`)],
  ["a pin held in a variable is unpinned", !pinsWith(`const complete = ran === EXPECTED_CELLS; process.exit(complete ? 1 : 0);`)],
  ["a pin passed to a check function is unpinned", !pinsWith(`const check = (ok) => { if (ran < 0) process.exit(1); }; check(ran === EXPECTED_CELLS);`)],
  ["a pin in a function called only from a dead branch is unpinned", !pinsWith(`function main() { if (ran !== EXPECTED_CELLS) process.exit(1); } if (false) main();`)],
  ["a mismatch exitCode of 256 is unpinned", !pinsWith(`if (ran !== EXPECTED_CELLS) process.exitCode = 256;`)],
  ["a pin in a generator nothing iterates is unpinned", !pinsWith(`function* main() { if (ran !== EXPECTED_CELLS) process.exit(1); } main();`)],
  ["a pin shadowed by a parameter is unpinned", !pinsWith(`function main(EXPECTED_CELLS) { if (ran !== EXPECTED_CELLS) process.exit(1); } main(1);`)],
  ["a call to a function that shadows main reaches no pin", !pinsWith(`function main() { if (ran !== EXPECTED_CELLS) process.exit(1); } { const main = () => {}; main(); }`)],
  ["a pin in an async main the file exits before is unpinned", !pinsWith(`async function main() { await f(); if (ran !== EXPECTED_CELLS) process.exit(1); } main(); process.exit(0);`)],
  ["a pin in an async main a later call exits before is unpinned", !pinsWith(`async function main() { await f(); if (ran !== EXPECTED_CELLS) process.exit(1); } function skip() { process.exit(0); } main(); skip();`)],
  ["a pin after an alias of process.exit is unpinned", !pinsWith(`const stop = process.exit; stop(0); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a bracket call of a method that exits 0 is unpinned", !pinsWith(`const r = { stop() { process.exit(0); } }; r["stop"](); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a method of a replaced object that exits 0 is unpinned", !pinsWith(`let o = { skip() {} }; o = { skip() { process.exit(0); } }; o.skip(); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a method bound with ||= that exits 0 is unpinned", !pinsWith(`const o = {}; o.skip ||= () => process.exit(0); o.skip(); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin after a conditional callee that can exit 0 is unpinned", !pinsWith(`const stop = x ? () => process.exit(0) : () => {}; stop(); if (ran !== EXPECTED_CELLS) process.exit(1);`)],
  ["a pin a caught throw can skip is unpinned", !pinsWith(`try { f(); if (ran !== EXPECTED_CELLS) process.exit(1); } catch {}`)],
  ["a pin a caught rejection can skip is unpinned", !pinsWith(`async function main() { await f(); if (ran !== EXPECTED_CELLS) process.exit(1); } main().catch(() => {});`)],
  ["a pin a failing catch arm guards is pinned", pinsWith(`try { f(); if (ran !== EXPECTED_CELLS) process.exit(1); } catch { process.exit(1); }`)],
];
const brokenControls = censusControls.filter(([, ok]) => !ok).map(([name]) => name);

/** Reached suites whose body names no file the census can read, each with the reason. */
const CENSUS_UNREAD: Record<string, string> = {
  "smoke:feed-agent": "delegates to node --test over a glob in examples/06-feed-agent; the test runner fails the run and counts its tests",
};
/** The entry files a script body runs, as repo paths: the paths it names, quoted or not, and those of
 *  a `-F <pkg> smoke:*` delegation, read from that package's manifest. */
function entryFiles(body: string, dir = ""): string[] {
  const files = [...body.matchAll(SUITE_FILE)].map((m) => join(dir, m[1])).filter((f) => existsSync(join(ROOT, f)));
  for (const m of body.matchAll(/(?:-F|--filter)\s+["']?([^\s"']+)["']?\s+(?:run\s+)?(smoke(?::[A-Za-z0-9:_-]+)?)(?![A-Za-z0-9:_/.-])/g)) {
    const found = workspaceManifest(m[1].replace(/\.\.\.$/, ""));
    const script = found?.scripts[m[2]];
    if (found && script) files.push(...entryFiles(script, found.dir));
  }
  return files;
}
const suiteFiles = new Map<string, string>();
const unread: string[] = [];
for (const name of [...reached].filter((s) => all.has(s)).sort()) {
  const files = entryFiles(pkg.scripts[name] ?? "");
  for (const f of files) if (!suiteFiles.has(f)) suiteFiles.set(f, name);
  // A composite is censused through the root scripts it runs; a leaf that resolves nothing is unread.
  if (!files.length && !suitesIn(pkg.scripts[name] ?? "").some((t) => t !== name && t in pkg.scripts)) unread.push(name);
}
const unreadNew = unread.filter((s) => !(s in CENSUS_UNREAD));
const unreadStale = Object.keys(CENSUS_UNREAD).filter((s) => !unread.includes(s));
const listEntries = readFileSync(UNPINNED_PATH, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
// A paid entry stays in the file so the digest still covers it, but it grandfathers nothing.
const unpinnedList = listEntries.filter((l) => !l.startsWith("paid "));
const debtDigest = createHash("sha256").update(listEntries.map((l) => l.replace(/^paid /, "")).join("\n")).digest("hex");
const grandfathered = new Set(unpinnedList);
const swallowing: string[] = [];
const unpinnedNew: string[] = [];
const pinnedListed: string[] = [];
let pinned = 0;
for (const [file, script] of suiteFiles) {
  const sf = parseSuite(file, readFileSync(join(ROOT, file), "utf8"));
  for (const line of swallowedThrows(sf)) swallowing.push(`${file}:${line} (${script})`);
  if (pinsCellCount(sf)) {
    pinned++;
    if (grandfathered.has(file)) pinnedListed.push(file);
  } else if (!grandfathered.has(file)) unpinnedNew.push(`${file} (${script})`);
}
const goneListed = unpinnedList.filter((f) => !suiteFiles.has(f));

console.log(`  suite census: ${suiteFiles.size} reached suite files, ${pinned} pin a cell count, ${grandfathered.size} listed unpinned`);
if (brokenControls.length) {
  fail++;
  console.log(`  ✗ FAIL: ${brokenControls.length} suite census control(s) did not hold, so the census cannot be trusted:`);
  for (const s of brokenControls) console.log(`      ${s}`);
} else {
  console.log(`  ✓ all ${censusControls.length} suite census controls hold`);
}
if (swallowing.length) {
  fail++;
  console.log(`  ✗ FAIL: ${swallowing.length} finally exit(s) can turn a throw into exit 0:`);
  for (const s of swallowing) console.log(`      ${s}`);
  console.log(`    Start the catch arm with process.exitCode = 1, or exit with a status computed to fail by default.`);
} else {
  console.log(`  ✓ no reached suite exits from a finally in a way that can swallow a throw`);
}
if (unpinnedNew.length) {
  fail++;
  console.log(`  ✗ FAIL: ${unpinnedNew.length} suite(s) pin no expected cell count and are not in bin/smoke/unpinned-suites.txt:`);
  for (const s of unpinnedNew) console.log(`      ${s}`);
  console.log(`    Declare const EXPECTED_CELLS = <n> and fail when the cells run !== EXPECTED_CELLS, after the failures.`);
} else {
  console.log(`  ✓ every suite outside bin/smoke/unpinned-suites.txt pins its cell count`);
}
if (unreadNew.length || unreadStale.length) {
  fail++;
  console.log(`  ✗ FAIL: ${unreadNew.length} reached suite(s) name no entry file the census can read, ${unreadStale.length} CENSUS_UNREAD entr(ies) are stale:`);
  for (const s of unreadNew) console.log(`      ${s} -> ${pkg.scripts[s]}`);
  for (const s of unreadStale) console.log(`      ${s} (reads now, or is not reached)`);
  console.log(`    Name the entry file in the script, or list the suite in CENSUS_UNREAD with the reason it cannot be read.`);
} else {
  console.log(`  ✓ every reached suite names an entry file the census reads, or is listed in CENSUS_UNREAD`);
}
if (debtDigest !== UNPINNED_DIGEST) {
  fail++;
  console.log(`  ✗ FAIL: bin/smoke/unpinned-suites.txt no longer names the debt it started with (UNPINNED_DIGEST). A new or renamed suite pins its count rather than joining the debt, and a paid entry is marked \`paid <path>\`, not deleted.`);
} else {
  console.log(`  ✓ bin/smoke/unpinned-suites.txt names only the debt it started with`);
}
if (pinnedListed.length || goneListed.length) {
  fail++;
  console.log(`  ✗ FAIL: bin/smoke/unpinned-suites.txt has ${pinnedListed.length + goneListed.length} stale entr(ies):`);
  for (const f of pinnedListed) console.log(`      ${f} (pins its count now)`);
  for (const f of goneListed) console.log(`      ${f} (not a reached suite file)`);
  console.log(`    Mark them \`paid <path>\`, so the debt only shrinks.`);
} else {
  console.log(`  ✓ no stale bin/smoke/unpinned-suites.txt entries`);
}

const untriaged = ungated.filter((s) => UNGATED[s]?.reason === "UNTRIAGED");
console.log(`\n  ${untriaged.length} of the ungated set are UNTRIAGED debt (not a failure; the number should go down).`);

// The debt-with-a-fuse class, named so the list can say how much of itself is broken rather than
// merely excluded. Reported, not enforced, for the same reason as UNTRIAGED: every entry here is
// an exclusion someone already accepted, and failing the gate on it would block CI on debt that
// was consciously taken. What was missing was never enforcement — it was the COUNT. `smoke:auth`
// sat in this list for six weeks with its cause correctly written in its own reason string, and
// nothing anywhere said "one suite here is broken and is supposed to stop being broken".
const broken = ungated.filter((s) => (UNGATED[s]?.reason ?? "").startsWith(BROKEN)).sort();
console.log(`  ${broken.length} are BROKEN — red or flaky, and expected to be fixed and removed, not kept:`);
for (const s of broken) console.log(`      ${s} — ${(UNGATED[s]?.reason ?? "").slice(BROKEN.length).trim()}`);

// Reported, not enforced: every entry here is already an accepted exclusion, so failing on them
// would just block the gate on debt that was consciously taken. The number is the point.
const citedUnrun = ungated.filter((s) => CITED_IN_PLAN.has(s)).sort();
console.log(`  ${citedUnrun.length} are CITED IN THE PLAN RECORD BY PASS COUNT and run by nothing —`);
console.log(`    a reader of the plan sees a number and concludes something checks it. Nothing does:`);
for (const s of citedUnrun) console.log(`      ${s}`);
// A citation for a suite that IS reached needs no listing; a stale one here hides a real gap.
const staleCited = [...CITED_IN_PLAN].filter((s) => !all.has(s)).sort();
if (staleCited.length) console.log(`    (CITED_IN_PLAN names ${staleCited.length} script(s) that no longer exist: ${staleCited.join(", ")})`);

console.log(`\nGATE INVENTORY ${fail === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(fail === 0 ? 0 : 1);

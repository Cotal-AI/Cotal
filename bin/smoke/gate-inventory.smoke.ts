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
 * from `unpinned-suites.txt` must pin a count; the list is the existing debt, held to a ceiling here.
 *
 * Run: pnpm smoke:gate-inventory
 */
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
// because a census that cannot fire is the defect it is looking for.
const UNPINNED_PATH = join(ROOT, "bin", "smoke", "unpinned-suites.txt");
/** The entry count of `unpinned-suites.txt`. A longer list is refused, so a new suite cannot join the
 *  debt without editing this gate, and a higher number than the list is refused so the bound falls. */
const UNPINNED_CEILING = 599;
const SUITE_FILE = /(?:^|\s)["']?([\w./-]+\.(?:ts|tsx|mts|mjs|js|cjs))["']?(?=\s|$)/g;
const PIN_NAME = /^EXPECTED(?:_[A-Z0-9]+)*$/;
const EQUALITY = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];

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
const isExitCall = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.getText() === "process.exit";
const nonZeroLiteral = (n: ts.Node | undefined): boolean => !!n && ts.isNumericLiteral(n) && Number(n.text) !== 0;
const setsFailingCode = (n: ts.Node): n is ts.BinaryExpression =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText() === "process.exitCode" && !(ts.isNumericLiteral(n.right) && Number(n.right.text) === 0);
const identifiersIn = (n: ts.Node): string[] => findIn(n, ts.isIdentifier, true).map((i) => i.text);

/** One pass over a suite, by name: its variable declarations, the writes to each variable (assignments,
 *  compound assignments, `++` and `--`), its named functions, and the names it calls. */
type SuiteIndex = { decls: Map<string, ts.VariableDeclaration[]>; writes: Map<string, ts.Node[]>; functions: Map<string, ts.Node>; called: Set<string>; kitChecks: Map<string, string> };
const suiteIndexes = new WeakMap<ts.SourceFile, SuiteIndex>();
function indexSuite(sf: ts.SourceFile): SuiteIndex {
  const cached = suiteIndexes.get(sf);
  if (cached) return cached;
  const ix: SuiteIndex = { decls: new Map(), writes: new Map(), functions: new Map(), called: new Set(), kitChecks: new Map() };
  const add = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      add(ix.decls, n.name.text, n);
      if (n.initializer && ts.isFunctionLike(n.initializer)) ix.functions.set(n.name.text, n.initializer);
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body) ix.functions.set(n.name.text, n.body);
    // `const { check, finish } = createSuite()` from the smoke kit: `finish` fails the run on a failed check.
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText() === "createSuite") {
      const pattern = n.name;
      const bound = (prop: string) => pattern.elements.find((e) => (e.propertyName ?? e.name).getText() === prop)?.name.getText();
      const [check, finish] = [bound("check"), bound("finish")];
      if (check && finish) ix.kitChecks.set(check, finish);
    }
    if (ts.isIdentifier(n) && ts.isCallExpression(n.parent)) ix.called.add(n.text);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left)) add(ix.writes, n.left.text, n);
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && ts.isIdentifier(n.operand)) add(ix.writes, n.operand.text, n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  suiteIndexes.set(sf, ix);
  return ix;
}

/** An exit status that cannot be 0: a non-zero literal, `128 + n` signal arithmetic, or a variable
 *  initialized to a non-zero literal whose only other writes are non-zero literals or the last
 *  statement of the guarded `try`, which runs only once every risky line succeeded (a fail-closed default). */
function cannotBeZero(sf: ts.SourceFile, arg: ts.Expression | undefined, guarded?: ts.Block): boolean {
  if (!arg) return false;
  if (nonZeroLiteral(arg)) return true;
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return nonZeroLiteral(arg.left) || nonZeroLiteral(arg.right);
  if (!ts.isIdentifier(arg)) return false;
  const { decls, writes } = indexSuite(sf);
  const last = guarded?.statements[guarded.statements.length - 1];
  // The zeroing statement runs last in the try: it is the try's last statement, or ends a block or an `if` arm that is.
  const runsLast = (w: ts.Node): boolean => {
    let n = w.parent;
    if (!guarded || !ts.isExpressionStatement(n)) return false;
    for (let p = n.parent; p !== guarded; n = p, p = p.parent)
      if (!(ts.isBlock(p) && p.statements[p.statements.length - 1] === n) && !(ts.isIfStatement(p) && p.expression !== n)) return false;
    return n === last;
  };
  return (decls.get(arg.text) ?? []).length > 0 && decls.get(arg.text)!.every((d) => nonZeroLiteral(d.initializer)) && (writes.get(arg.text) ?? []).every(
    (w) => (ts.isBinaryExpression(w) && w.operatorToken.kind === ts.SyntaxKind.EqualsToken && nonZeroLiteral(w.right)) || runsLast(w),
  );
}

/** A catch arm keeps a throw from leaving through this `finally` exit with status 0 when it exits
 *  non-zero itself, or sets a non-zero `process.exitCode` that the exit honors (no status, or one that
 *  reads `process.exitCode`). A rethrow does not count: the `finally` exit ends the process first. */
function catchFails(sf: ts.SourceFile, body: ts.Node | undefined, exit: ts.CallExpression, guarded?: ts.Block): boolean {
  if (!body) return false;
  if (findIn(body, isExitCall).some((c) => cannotBeZero(sf, c.arguments[0], guarded))) return true;
  const status = exit.arguments[0];
  const honors = !status || findIn(status, (n): n is ts.Node => n.getText() === "process.exitCode").length > 0;
  return honors && findIn(body, setsFailingCode).length > 0;
}

/** Lines of `process.exit` calls in a `finally` that can turn a throw into exit 0: a try/finally or a
 *  promise `.finally` whose catch arm does not fail through that exit, and whose exit status can be 0. */
function swallowedThrows(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const flag = (block: ts.Node, catchArm: ts.Node | undefined, guarded?: ts.Block) => {
    for (const exit of findIn(block, isExitCall))
      if (!cannotBeZero(sf, exit.arguments[0], guarded) && !catchFails(sf, catchArm, exit, guarded))
        lines.push(sf.getLineAndCharacterOfPosition(exit.getStart(sf)).line + 1);
  };
  const visit = (n: ts.Node) => {
    if (ts.isTryStatement(n) && n.finallyBlock) flag(n.finallyBlock, n.catchClause?.block, n.tryBlock);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "finally") {
      const handler = n.arguments[0];
      // Only a `.catch` directly before `.finally` sees every rejection; an earlier one misses a later `.then`.
      const prev = n.expression.expression;
      const caught = ts.isCallExpression(prev) && ts.isPropertyAccessExpression(prev.expression) && prev.expression.name.text === "catch" ? prev.arguments[0] : undefined;
      if (handler && ts.isFunctionLike(handler)) flag(handler, caught && ts.isFunctionLike(caught) ? caught : undefined);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/** Whether the run gets to `node`: no earlier statement of an enclosing block ends it (`process.exit`,
 *  `throw`, `return`), and every enclosing function is called, or passed to a call, somewhere. */
function reachedIn(sf: ts.SourceFile, node: ts.Node): boolean {
  const ends = (s: ts.Statement) => ts.isThrowStatement(s) || ts.isReturnStatement(s) || (ts.isExpressionStatement(s) && isExitCall(s.expression));
  for (let n = node; n !== sf; n = n.parent) {
    const p = n.parent;
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p))
      for (const s of p.statements as ts.NodeArray<ts.Statement>) {
        if (s === n) break;
        if (ends(s)) return false;
      }
    if (!ts.isFunctionLike(n)) continue;
    let site = n.parent;
    while (ts.isParenthesizedExpression(site)) site = site.parent;
    if (ts.isCallExpression(site)) continue;
    const name = ts.isFunctionDeclaration(n) ? n.name : ts.isVariableDeclaration(site) && ts.isIdentifier(site.name) ? site.name : undefined;
    if (!name || !indexSuite(sf).called.has(name.text)) return false;
  }
  return true;
}

/** A suite pins its count when an `EXPECTED*` constant initialized to a positive literal is compared by
 *  equality with a tally, where the run reaches it and a mismatch fails the run: the condition of an
 *  `if` whose mismatch arm fails, of a `?:` exit status whose mismatch arm cannot be 0, an argument of
 *  a check function in the file that fails or of the smoke kit's `check` when `finish()` runs, or the
 *  value of a variable the exit status reads. Equality catches a lost cell and an added one; `<` lets
 *  the total drift up. A comparison that is only logged, or follows an exit, pins nothing. */
function pinsCellCount(sf: ts.SourceFile): boolean {
  const pins = [...indexSuite(sf).decls].filter(([name]) => PIN_NAME.test(name)).flatMap(([, ds]) => ds.filter((d) => nonZeroLiteral(d.initializer)));
  const isPin = (o: ts.Node, at: ts.Node) =>
    ts.isIdentifier(o) && pins.some((d) => (d.name as ts.Identifier).text === o.text && d.parent.parent.parent.pos <= at.pos && at.end <= d.parent.parent.parent.end);
  const directFail = (arm: ts.Node) =>
    findIn(arm, ts.isThrowStatement).length > 0 || findIn(arm, setsFailingCode).length > 0 || findIn(arm, isExitCall).some((c) => cannotBeZero(sf, c.arguments[0]));
  // Variables that feed the exit status: read by `process.exit`, by a `process.exitCode` write, or by
  // the condition of an `if` that throws or exits non-zero.
  const failVars = new Set([
    ...findIn(sf, isExitCall, true).flatMap((c) => c.arguments.flatMap(identifiersIn)),
    ...findIn(sf, setsFailingCode, true).flatMap((b) => identifiersIn(b.right)),
    ...findIn(sf, ts.isIfStatement, true).filter((s) => directFail(s.thenStatement)).flatMap((s) => identifiersIn(s.expression)),
  ]);
  const { decls, writes, functions, kitChecks, called } = indexSuite(sf);
  // A variable whose value reaches the status reaches it too: follow declarations and assignments.
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of [...failVars])
      for (const src of [...(decls.get(v) ?? []).map((d) => d.initializer), ...(writes.get(v) ?? []).map((w) => (ts.isBinaryExpression(w) ? w.right : undefined))])
        for (const id of src ? identifiersIn(src) : [])
          if (!failVars.has(id)) {
            failVars.add(id);
            grew = true;
          }
  }
  const failWrites = new Set([...failVars].flatMap((v) => writes.get(v) ?? []));
  const localFunction = (callee: ts.Expression) => (ts.isIdentifier(callee) ? functions.get(callee.text) : undefined);
  const armFails = (arm: ts.Node, depth = 0): boolean =>
    directFail(arm) ||
    findIn(arm, (n): n is ts.Node => failWrites.has(n)).length > 0 ||
    findIn(arm, ts.isCallExpression).some((c) => {
      if (ts.isPropertyAccessExpression(c.expression) && ts.isIdentifier(c.expression.expression) && failVars.has(c.expression.expression.text) && c.expression.name.text === "push") return true;
      const f = depth < 2 ? localFunction(c.expression) : undefined;
      return !!f && armFails(f, depth + 1);
    });
  const mismatchFails = (b: ts.BinaryExpression): boolean => {
    let n: ts.Node = b;
    let onMismatch = b.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || b.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
    for (let p = n.parent; ; n = p, p = p.parent) {
      if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) onMismatch = !onMismatch;
      else if (!ts.isParenthesizedExpression(p) && !(ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind))) break;
    }
    const at = n.parent;
    if (ts.isIfStatement(at) && at.expression === n) {
      const arm = onMismatch ? at.thenStatement : at.elseStatement;
      return !!arm && armFails(arm);
    }
    if (ts.isConditionalExpression(at) && at.condition === n) {
      let status: ts.Node = at;
      while (ts.isParenthesizedExpression(status.parent)) status = status.parent;
      const exits = (isExitCall(status.parent) && status.parent.arguments[0] === status) || (setsFailingCode(status.parent) && status.parent.right === status);
      return exits && cannotBeZero(sf, onMismatch ? at.whenTrue : at.whenFalse);
    }
    if (ts.isCallExpression(at) && at.arguments.some((a) => a === n)) {
      const f = localFunction(at.expression);
      const kitFinish = ts.isIdentifier(at.expression) ? kitChecks.get(at.expression.text) : undefined;
      return (!!f && armFails(f)) || (!!kitFinish && called.has(kitFinish));
    }
    // A verdict held in a variable the exit status reads: `const complete = ran === EXPECTED_CELLS`.
    if (ts.isVariableDeclaration(at) && at.initializer === n) return ts.isIdentifier(at.name) && failVars.has(at.name.text);
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.EqualsToken && at.right === n) return ts.isIdentifier(at.left) && failVars.has(at.left.text);
    return false;
  };
  return findIn(sf, ts.isBinaryExpression, true).some((b) => {
    if (!EQUALITY.includes(b.operatorToken.kind)) return false;
    const [pin, tally] = isPin(b.left, b) ? [b.left, b.right] : [b.right, b.left];
    return isPin(pin, b) && !isPin(tally, b) && !ts.isLiteralExpression(tally) && mismatchFails(b) && reachedIn(sf, b);
  });
}

// Controls: each predicate must red on the defect shape and pass the repaired one, or the census
// below proves nothing.
const control = (src: string) => parseSuite("control.ts", src);
const censusControls: Array<[string, boolean]> = [
  ["a finally exit with no catch arm is a swallowed throw", swallowedThrows(control(`try { throw new Error("x"); } finally { process.exit(process.exitCode ?? 0); }`)).length === 1],
  ["a catch arm that only logs still swallows", swallowedThrows(control(`try { f(); } catch (e) { console.error(e); } finally { process.exit(fail ? 1 : 0); }`)).length === 1],
  ["a promise .finally exit with no .catch is a swallowed throw", swallowedThrows(control(`main().finally(() => process.exit(process.exitCode ?? 0));`)).length === 1],
  ["a catch arm setting exitCode = 1 fails the run", swallowedThrows(control(`try { f(); } catch (e) { process.exitCode = 1; } finally { process.exit(process.exitCode ?? 0); }`)).length === 0],
  ["a .catch setting exitCode = 1 fails the run", swallowedThrows(control(`main().catch(() => { process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0));`)).length === 0],
  ["a fail-closed default exit status fails the run", swallowedThrows(control(`let code = 1; try { f(); code = 0; } finally { process.exit(code); }`)).length === 0],
  ["a rethrow does not fail through a finally exit", swallowedThrows(control(`try { f(); } catch (e) { throw e; } finally { process.exit(process.exitCode ?? 0); }`)).length === 1],
  ["an exitCode the finally exit ignores does not fail the run", swallowedThrows(control(`try { f(); } catch (e) { process.exitCode = 1; } finally { process.exit(fail ? 1 : 0); }`)).length === 1],
  ["a fail-closed default cleared before the risky line swallows", swallowedThrows(control(`let code = 1; try { code = 0; f(); } finally { process.exit(code); }`)).length === 1],
  ["a .catch before a later .then misses its throw", swallowedThrows(control(`main().catch(() => { process.exitCode = 1; }).then(g).finally(() => process.exit(process.exitCode ?? 0));`)).length === 1],
  ["a suite with no pinned count is unpinned", !pinsCellCount(control(`let ran = 0; ran++; console.log(ran);`))],
  ["a one-sided pin is unpinned", !pinsCellCount(control(`const EXPECTED_CELLS = 5; if (ran < EXPECTED_CELLS) process.exit(1);`))],
  ["an equality pin on a literal count is pinned", pinsCellCount(control(`const EXPECTED_CELLS = 5; if (ran !== EXPECTED_CELLS) process.exit(1);`))],
  ["a pin that is only logged is unpinned", !pinsCellCount(control(`const EXPECTED_CELLS = 5; console.log(ran !== EXPECTED_CELLS);`))],
  ["a pin after an exit is unpinned", !pinsCellCount(control(`const EXPECTED_CELLS = 5; process.exit(0); if (ran !== EXPECTED_CELLS) process.exit(1);`))],
  ["a pin compared with itself is unpinned", !pinsCellCount(control(`const EXPECTED_CELLS = 5; if (EXPECTED_CELLS !== EXPECTED_CELLS) process.exit(1);`))],
  ["a pin in an async main that runs is pinned", pinsCellCount(control(`async function main() { const EXPECTED_CELLS = 5; if (ran !== EXPECTED_CELLS) process.exit(1); } main().catch(() => { process.exitCode = 1; });`))],
  ["a pin in a check function that fails is pinned", pinsCellCount(control(`let fail = 0; const check = (ok) => { if (!ok) fail++; }; const EXPECTED = 5; check(pass + fail === EXPECTED); process.exit(fail ? 1 : 0);`))],
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
const unpinnedList = readFileSync(UNPINNED_PATH, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
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
const listDupes = [...new Set(unpinnedList.filter((f, i) => unpinnedList.indexOf(f) !== i))];

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
  console.log(`    Add a catch arm that sets process.exitCode = 1, or exit with a status computed to fail by default.`);
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
if (unpinnedList.length !== UNPINNED_CEILING) {
  fail++;
  console.log(unpinnedList.length > UNPINNED_CEILING
    ? `  ✗ FAIL: bin/smoke/unpinned-suites.txt holds ${unpinnedList.length} entries, above its ceiling of ${UNPINNED_CEILING}. A new suite pins its count rather than joining the debt.`
    : `  ✗ FAIL: bin/smoke/unpinned-suites.txt holds ${unpinnedList.length} entries; lower UNPINNED_CEILING to ${unpinnedList.length} so the list cannot grow back.`);
} else {
  console.log(`  ✓ bin/smoke/unpinned-suites.txt holds ${UNPINNED_CEILING} entries, its ceiling`);
}
if (pinnedListed.length || goneListed.length || listDupes.length) {
  fail++;
  console.log(`  ✗ FAIL: bin/smoke/unpinned-suites.txt has ${pinnedListed.length + goneListed.length + listDupes.length} stale entr(ies):`);
  for (const f of pinnedListed) console.log(`      ${f} (pins its count now)`);
  for (const f of goneListed) console.log(`      ${f} (not a reached suite file)`);
  for (const f of listDupes) console.log(`      ${f} (listed twice)`);
  console.log(`    Remove them, so the list only shrinks.`);
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

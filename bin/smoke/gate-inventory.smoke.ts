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
 * thing they claimed to prove, and vacuous. This checks that a suite is REACHED, never that it
 * asserts anything once reached. The two halves need different instruments.
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
const EXPECTED_EXEMPTIONS = 20;
const standing = (reason: string): UngatedExemption => ({ reason, recheckBy: "2026-11-30" });
const untriagedExemption = (reason: string): UngatedExemption => ({ reason, recheckBy: "2026-09-30" });

const UNGATED: Record<string, UngatedExemption> = {
  // Need external tooling no CI runner has.
  "smoke:orca:live": standing("drives the public orca CLI"),
  "smoke:orca-e2e:live": standing("drives the public orca CLI"), "smoke:pi": standing("needs a pi install"), "smoke:codex-live": standing("needs a logged-in codex CLI"),
  "smoke:codex-tui-live": standing("needs a codex TUI session"),
  "smoke:jcode-live": standing("needs an installed, authenticated jcode CLI (COTAL_E2E_JCODE=1)"),
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
  // Untriaged debt. These are the ones that should shrink.
  "smoke:attention": untriagedExemption("UNTRIAGED"),
  "smoke:attention:auth": untriagedExemption("UNTRIAGED"),
 "smoke:delivery-boot-retry:auth": untriagedExemption("UNTRIAGED"),
  "smoke:delivery-broker-coupling": untriagedExemption("UNTRIAGED"), "smoke:delivery-old-manager": untriagedExemption("UNTRIAGED"),
  "smoke:feedback": untriagedExemption("UNTRIAGED"),
  "smoke:lifecycle-files": untriagedExemption("UNTRIAGED"), "smoke:manager-console": untriagedExemption("UNTRIAGED"),
  "smoke:plane3-activation:auth": untriagedExemption("UNTRIAGED"),
  "smoke:plane3-gate:auth": untriagedExemption("UNTRIAGED"),
  "smoke:self-serve-join-coverage:auth": untriagedExemption("UNTRIAGED"),
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
const all = new Set(Object.keys(pkg.scripts).filter((k) => (k === "smoke" || k.startsWith("smoke:")) && k !== "smoke:ci"));

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
 *  string; the file is the source, this is the projection of it that the existing checks can read. */
const bodyOf = (name: string): string => (name === "smoke:ci" ? ciChainBody() : pkg.scripts[name] ?? "");

// REACHED MEANS REACHABLE FROM A ROOT THAT ACTUALLY RUNS, transitively — not "mentioned somewhere".
// The two relations agree on today's graph, which is why the weaker one survived: an allowlisted
// UNREACHABLE parent naming a child marks the child reached under "mentioned by", though nothing
// runs either. Roots are what CI and a developer actually invoke.
const ROOTS = ["smoke:ci", "check", "test"];
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
const workspaceManifest = (pkgName: string): Record<string, string> | null => {
  for (const dir of ["packages", "implementations", "extensions", "bin"]) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const pj = join(base, entry, "package.json");
      if (!existsSync(pj)) continue;
      try {
        const d = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; scripts?: Record<string, string> };
        if (d.name === pkgName) return d.scripts ?? {};
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
      const scripts = workspaceManifest(pkgName);
      if (scripts === null) dangling.push([name, `${target} (in unresolvable package ${pkgName})`]);
      else if (!(target in scripts)) dangling.push([name, `${target} (absent from ${pkgName})`]);
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

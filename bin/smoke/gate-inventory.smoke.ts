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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_RE = /(smoke:[A-Za-z0-9:_-]+)/g;

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
 */
const UNGATED: Record<string, string> = {
  // Need external tooling no CI runner has.
  "smoke:orca:live": "drives the public orca CLI",
  "smoke:orca-e2e:live": "drives the public orca CLI", "smoke:pi": "needs a pi install", "smoke:codex-live": "needs a logged-in codex CLI",
  "smoke:codex-tui-live": "needs a codex TUI session",
  // Known-red or documented flakes, tracked separately; gating them would make the gate lie.
  "smoke:auth": "pre-existing red on main (mgr-cred presence-KV CONSUMER.CREATE)",
  "smoke:channels": "documented timing flake + fixed-port cleanup leak",
  // EXPECTED RED BY DESIGN, and the one entry here that is a decision rather than debt. It
  // reproduces an OPEN defect (renewManagedStaticCred reads the terminal latch at entry, then does
  // four awaits before two writes that retirement cleanup has already deleted, leaving a valid
  // credential and an `active` durable row for a retired lifecycle). Gating a known red is how a
  // chain teaches its readers to skim reds, which is the most expensive habit a gate can pick up.
  "smoke:renewal-terminal-race": "reproduction of an open defect; gate when the fix lands",
  // Full-stack live suites: boot a real broker + install tree, too slow/stateful for the PR gate.
  "smoke:manager-singleton:live": "full live stack", "smoke:seed-tarball:live": "packs a tarball",
  "smoke:user-auth-launch:live": "full live stack", "smoke:user-spawn:live": "full live stack",
  "smoke:web-seed:live": "full live stack",
  // NOT dead, despite the obvious reading. v0.4 removed the MANAGER's ctl tiers, not the ctl rail:
  // `ctl.delivery` survives as the delivery daemon's carve-out, still built by subjects.ts and still
  // served by endpoint.ts (CONTROL_DELIVERY / CONTROL_DELIVERY_ADMIN). This suite pins the security
  // properties of that LIVE rail - that the broker forge-locks the subject's identity slots to the
  // connection's minted grant, and that serveControl's guards reject a payload disagreeing with the
  // subject. It is ungated because it needs a real user-auth broker plus a real callout, not because
  // it is obsolete. Deleting it would drop a security proof for shipped code.
  "smoke:ctl-trust:live": "needs a real user-auth broker + callout; pins the LIVE ctl.delivery rail",
  // The bare `smoke` script — `tsx packages/core/smoke.ts`, documented in AGENTS.md as the core
  // smoke entry point, and reached by nothing. Invisible to this file until the audited set stopped
  // filtering on `smoke:`, and found by a second independent derivation rather than by this check.
  "smoke": "UNTRIAGED",
  // Untriaged debt. These are the ones that should shrink.
  "smoke:attention": "UNTRIAGED",
  "smoke:attention:auth": "UNTRIAGED", "smoke:channel-attention": "UNTRIAGED",
  "smoke:channel-attention:auth": "UNTRIAGED", "smoke:delivery-boot-retry:auth": "UNTRIAGED",
  "smoke:delivery-broker-coupling": "UNTRIAGED", "smoke:delivery-old-manager": "UNTRIAGED",
  "smoke:doctor-auth": "UNTRIAGED",
  "smoke:feedback": "UNTRIAGED", "smoke:install": "UNTRIAGED",
  "smoke:lifecycle-files": "UNTRIAGED", "smoke:manager-console": "UNTRIAGED", "smoke:manifest-launch": "UNTRIAGED",
  "smoke:members": "UNTRIAGED", "smoke:membership": "UNTRIAGED",
  "smoke:membership-feed:auth": "UNTRIAGED", "smoke:plane3-activation:auth": "UNTRIAGED",
  "smoke:plane3-gate:auth": "UNTRIAGED", "smoke:presence-scrub": "UNTRIAGED",
  "smoke:self-serve-join-coverage:auth": "UNTRIAGED", "smoke:send": "UNTRIAGED",
  "smoke:start-model": "UNTRIAGED",
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
  "smoke:ctl-trust:live", "smoke:doctor-auth", "smoke:install", "smoke:ledger",
  "smoke:manifest-launch", "smoke:members", "smoke:membership-feed:auth", "smoke:presence-scrub",
  "smoke:start-model", "smoke:static-lifecycle", "smoke:user-auth-launch:live",
  "smoke:user-spawn:live", "smoke:web-seed:live",
]);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
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
  for (const s of suitesIn(pkg.scripts[cur] ?? "")) if (s !== cur && s in pkg.scripts) frontier.push(s);
}

const ungated = [...all].filter((s) => !reached.has(s)).sort();
// A REASON IS TESTED FOR CONTENT, NOT PRESENCE. `s in UNGATED` passed on `""`, so this file could
// print "every ungated suite is listed with a reason" while an entry carried nothing at all. An
// exclusion with a stated reason is a decision; one without is the bug, and a key test cannot tell
// them apart. `UNTRIAGED` is a legitimate value — it is honest debt — but it is counted separately
// below rather than being allowed to read as a justification.
const MIN_REASON = 8;
const unexplained = ungated.filter((s) => !(s in UNGATED) || (UNGATED[s] ?? "").trim().length < MIN_REASON);
const staleAllowlist = Object.keys(UNGATED).filter((s) => !all.has(s) || reached.has(s)).sort();

let fail = 0;
console.log(`gate inventory: ${all.size} smoke scripts, ${all.size - ungated.length} reached, ${ungated.length} not run by anything\n`);

if (unexplained.length) {
  fail++;
  console.log(`  ✗ FAIL: ${unexplained.length} suite(s) exist but nothing runs them, and they are not in UNGATED:`);
  for (const s of unexplained) console.log(`      ${s}`);
  console.log(`    Gate it in smoke:ci, or add it to UNGATED with the reason it is excluded.`);
} else {
  console.log(`  ✓ every ungated suite is listed with a reason`);
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
for (const [name, body] of Object.entries(pkg.scripts))
  for (const segment of body.split("&&")) {
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
    for (const m of segment.matchAll(SCRIPT_RE))
      if (m[1] !== name && !(m[1] in pkg.scripts)) dangling.push([name, m[1]]);
  }
if (dangling.length) {
  fail++;
  console.log(`  ✗ FAIL: ${dangling.length} composite entr(ies) name a script that does not exist:`);
  for (const [host, missing] of dangling) console.log(`      ${host} -> ${missing}`);
} else {
  console.log(`  ✓ every composite entry resolves to a defined script`);
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

const untriaged = ungated.filter((s) => UNGATED[s] === "UNTRIAGED");
console.log(`\n  ${untriaged.length} of the ungated set are UNTRIAGED debt (not a failure; the number should go down).`);

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

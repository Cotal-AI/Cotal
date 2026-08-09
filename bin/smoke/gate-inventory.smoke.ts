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
import { readFileSync, readdirSync } from "node:fs";
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
  // Untriaged debt. These are the ones that should shrink.
  "smoke:attach-repaint": "UNTRIAGED", "smoke:attention": "UNTRIAGED",
  "smoke:attention:auth": "UNTRIAGED", "smoke:channel-attention": "UNTRIAGED",
  "smoke:channel-attention:auth": "UNTRIAGED", "smoke:delivery-boot-retry:auth": "UNTRIAGED",
  "smoke:delivery-broker-coupling": "UNTRIAGED", "smoke:delivery-old-manager": "UNTRIAGED",
  "smoke:delivery-shards-reject": "UNTRIAGED", "smoke:doctor-auth": "UNTRIAGED",
  "smoke:feedback": "UNTRIAGED", "smoke:install": "UNTRIAGED", "smoke:ledger": "UNTRIAGED",
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
const all = new Set(Object.keys(pkg.scripts).filter((k) => k.startsWith("smoke:") && k !== "smoke:ci"));

// A suite counts as REACHED if any composite script or any workflow invokes it. `smoke:ci` is the
// gate, but `check` and the workflows run suites of their own, and counting only `smoke:ci` would
// over-report the gap.
const reached = new Set<string>();
for (const [name, body] of Object.entries(pkg.scripts))
  for (const m of body.matchAll(SCRIPT_RE)) if (m[1] !== name) reached.add(m[1]);
const wfDir = join(ROOT, ".github", "workflows");
for (const f of readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")))
  for (const m of readFileSync(join(wfDir, f), "utf8").matchAll(SCRIPT_RE)) reached.add(m[1]);

const ungated = [...all].filter((s) => !reached.has(s)).sort();
const unexplained = ungated.filter((s) => !(s in UNGATED));
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
// Only ROOT invocations can dangle. A segment carrying `-F`/`--filter <pkg>` resolves its script in
// THAT PACKAGE's package.json, so `smoke:backup-perms:live` delegating to `smoke:backup:live` is
// correct even though no root script has that name — the first version of this check flagged it and
// it was a phantom. Split on `&&` so one delegating segment does not excuse the others.
const dangling: Array<[string, string]> = [];
for (const [name, body] of Object.entries(pkg.scripts))
  for (const segment of body.split("&&")) {
    if (/(^|\s)(-F|--filter)\s/.test(segment)) continue; // resolves in another package
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

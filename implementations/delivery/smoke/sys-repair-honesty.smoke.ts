/**
 * THE `$SYS` REPAIR ADVICE NAMES ONLY COMMANDS THIS ROOT CAN RUN
 * (`docs/design/space-segmentation-p7-p1.md` §6, promoted from the probe that found this).
 *
 * The delivery daemon reports a missing or half-rotated `$SYS` pair and tells the operator how to
 * repair it. On a multi-tenant root it used to name `cotal down` then `cotal up --rotate-sys`, and
 * BOTH of those refuse there: they are broker-wide, `assertSingleSpaceBroker` turns them away naming
 * the tenants, and the refusal itself explains that the per-space form does not exist yet. So the
 * operator whose observer is missing was handed a command, ran it, and was refused — advice that
 * cannot succeed, which is the same defect `healMembershipDataCreds`'s own comment records. It was
 * reachable on a real root, not a hypothesis; this suite is the executed proof, kept.
 *
 * THE PROPERTY IS A BICONDITIONAL, not "multi-tenant roots get a different string": the advice names
 * a runnable command EXACTLY when the guard would let that command run. Stating it in both
 * directions is what stops the two obvious wrong fixes — advice that never names a command (useless
 * on the single-tenant root where the command works) and advice that always does (the defect).
 *
 * THE CORRUPT-INVENTORY ROOT IS THE CELL THAT MATTERS, and it is here because a plausible fix does
 * not pass it. `repairAdvice` must ASK the guard, not re-derive "is this root single-tenant" from a
 * tenant count of its own: `assertSingleSpaceBroker` also refuses fail-CLOSED on an unreadable
 * account record, and a hand-rolled `spaces.length > 1` would hand out `up --rotate-sys` on exactly
 * that root while the verb refuses. A count is not the guard, and only this root can tell them apart.
 *
 * Hermetic — no broker, no network, no CLI. Every leg carries a POSITIVE CONTROL in the same run, so
 * an all-negative read caused by a harness that provisioned nothing is distinguishable from the
 * finding. Root construction follows `implementations/cli/smoke/multi-space.smoke.ts` (gate-covered).
 *
 * Run: pnpm smoke:sys-repair-honesty
 * Mutation-proof: pnpm mutation-proof --config bin/smoke/mutations/sys-repair-honesty.json
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, mintConnectionEvictorCreds,
  mintMembershipObserverCreds, newIdentity,
} from "@cotal-ai/core";
import {
  assertSingleSpaceBroker, authDir, connectionEvictorCredsKey, CONNECTION_EVICTOR_CREDS_KIND,
  DELIVERY_CREDS_KIND, membershipObserverCredsKey, MEMBERSHIP_OBSERVER_CREDS_KIND,
  MEMBERSHIP_RW_CREDS_KIND, REMINTABLE_DAEMON_CREDS, saveBrokerAuth, saveSpaceAccountAuth,
  segmentedKey, workspaceSecretStore,
} from "@cotal-ai/workspace";
import { loadSysPair, repairAdvice } from "../src/sys-creds.js";

// `findCotalRoot()` is never called here, but the repo's own `.cotal/` is the one directory on the
// box guaranteed to look provisioned, so every root below is an mkdtemp with its own empty `.cotal/`.
const home = mkdtempSync(join(tmpdir(), "cotal-sysrepair-home-"));
process.env.COTAL_HOME = home;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** A label no caller would ever pass, so the operation half of the guard's message can be located
 *  and removed rather than guessed at. */
const SENTINEL = "<<operation>>";

/** What the guard itself says about this root, or "" when it would permit. The suite asks the same
 *  question the daemon does, through the same function, rather than predicting the answer. */
function guardRefusal(root: string): string {
  try { assertSingleSpaceBroker(authDir(root), SENTINEL); return ""; }
  catch (e) { return (e as Error).message; }
}

/** The guard's own REASONING — its message with the caller-supplied operation label stripped off.
 *
 *  This is the part the advice must reproduce verbatim, and the part that carries the decision: how
 *  many tenants, which ones, or which record would not read. The leading label is by construction
 *  the caller's own words (`repairAdvice` names the repair, `up --rotate-sys` names the rotation),
 *  so requiring THAT to match would only assert that this suite guessed a private constant right.
 *  The cell below proves the label is really embedded, because if it were not, the slice would
 *  silently return something else and every comparison after it would be weaker than it reads. */
function guardReasoning(root: string): string {
  const msg = guardRefusal(root);
  const at = msg.indexOf(SENTINEL);
  return msg === "" || at === -1 ? "" : msg.slice(at + SENTINEL.length);
}

/** A root under ONE broker trust chain holding an account per named space, `$SYS` pair ABSENT. */
async function makeRoot(label: string, spaces: string[]) {
  const root = mkdtempSync(join(tmpdir(), `cotal-sysrepair-${label}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const broker = await createBrokerAuth(label);
  saveBrokerAuth(authDir(root), broker);
  const accounts = [];
  for (const space of spaces) {
    const account = await createSpaceAccountAuth(broker, space);
    saveSpaceAccountAuth(authDir(root), account);
    accounts.push(account);
  }
  return { root, broker, accounts };
}

/** The two $SYS KINDS. `repairAdvice` takes kinds, not keys: the workstation arm names files an
 *  operator recognises, and the hosted arm segments them itself for the host's store. */
const BOTH_KINDS = [MEMBERSHIP_OBSERVER_CREDS_KIND, CONNECTION_EVICTOR_CREDS_KIND];
/** A source's composition. Every root here is a workstation one except the hosted CONTROL below. */
const fsSource = (root: string, space: string) => ({ secrets: workspaceSecretStore(root), space, injected: false as const, root });
/** The imperative half of the workstation advice — the phrase that TELLS an operator to run
 *  something. The refusal quotes `cotal up --rotate-sys` while explaining that it refuses, which is
 *  honest, so a bare substring search for the verb name cannot separate the two. `cotal down` can:
 *  it appears only in the instruction, never in the refusal. */
const INSTRUCTS = (advice: string) => advice.includes("cotal down");

const roots: string[] = [];
try {
  console.log("1) the biconditional: advice instructs iff the guard would permit");
  // Four roots spanning both sides of the guard, including the one a tenant COUNT gets wrong.
  const cases = [
    { label: "solo", spaces: ["solo"], corruptRecord: false, permits: true },
    { label: "two", spaces: ["alpha", "beta"], corruptRecord: false, permits: false },
    { label: "three", spaces: ["a", "b", "c"], corruptRecord: false, permits: false },
    { label: "corrupt", spaces: ["one"], corruptRecord: true, permits: false },
  ];
  const built = new Map<string, string>();
  for (const c of cases) {
    const { root } = await makeRoot(c.label, c.spaces);
    roots.push(root);
    if (c.corruptRecord) writeFileSync(join(authDir(root), "account.zznothex.json"), JSON.stringify({ space: "x" }));
    built.set(c.label, root);
    const refusal = guardRefusal(root);
    const advice = repairAdvice(fsSource(root, c.spaces[0]), BOTH_KINDS);
    check(
      `the ${c.label} root: the guard ${c.permits ? "PERMITS" : "REFUSES"} and the advice ${c.permits ? "instructs" : "does not instruct"}`,
      (refusal === "") === c.permits && INSTRUCTS(advice) === c.permits,
      { refusal, advice },
    );
  }

  console.log("\n2) where it refuses, the advice carries the guard's OWN words and offers nothing else");
  const two = built.get("two") as string;
  const twoAdvice = repairAdvice(fsSource(two, "alpha"), BOTH_KINDS);
  // Without this the extraction below could silently degrade into comparing against "", and every
  // verbatim cell that follows would pass on any advice at all.
  check("the guard embeds the operation label it was given, so the reasoning can be isolated", guardRefusal(two).includes(SENTINEL), guardRefusal(two));
  const twoReasoning = guardReasoning(two);
  check("the advice quotes the guard's reasoning verbatim, so the two can never disagree", twoReasoning !== "" && twoAdvice.includes(twoReasoning), { twoReasoning, twoAdvice });
  check("the refusal names the tenants, so the operator can see WHY", twoAdvice.includes("alpha") && twoAdvice.includes("beta"), twoAdvice);
  check("the advice states that NO other command mints the pair", twoAdvice.includes("no other command that mints"), twoAdvice);
  check("...and names the kinds it is talking about", twoAdvice.includes(MEMBERSHIP_OBSERVER_CREDS_KIND) && twoAdvice.includes(CONNECTION_EVICTOR_CREDS_KIND), twoAdvice);
  // The corrupt root proves the advice consults the GUARD and not a tenant count: the count is one.
  const corruptRoot = built.get("corrupt") as string;
  const corruptAdvice = repairAdvice(fsSource(corruptRoot, "one"), BOTH_KINDS);
  check("the corrupt root refuses on UNREADABILITY, not on a count (its readable count is one)", corruptAdvice.includes("not fully readable") && corruptAdvice.includes("account.zznothex.json"), corruptAdvice);

  console.log("\n3) the arms that must NOT change");
  const solo = built.get("solo") as string;
  const soloAdvice = repairAdvice(fsSource(solo, "solo"), BOTH_KINDS);
  // POSITIVE CONTROL for section 1: the working command is still handed out where it works, so the
  // biconditional is not satisfied by advice that simply never names anything.
  check("CONTROL: the single-tenant root still gets the real command, unchanged", soloAdvice === "re-mint it with `cotal down` then `cotal up --rotate-sys`", soloAdvice);
  // POSITIVE CONTROL: the hosted arm forks on the composition root's own fact and names no CLI verb
  // on ANY root — including the multi-tenant one, where a host has no `cotal` to run either way.
  for (const [label, root] of built) {
    const hosted = repairAdvice({ secrets: workspaceSecretStore(root), space: "hosted", injected: true }, [MEMBERSHIP_OBSERVER_CREDS_KIND]);
    check(`CONTROL: the hosted arm names no CLI verb on the ${label} root`, !hosted.includes("cotal ") && hosted.includes("system-account rotation"), hosted);
    // A host `put`s exactly what this string names, so naming the bare KIND here would send it to the
    // pre-P7 flat key — a location the daemon never reads, failing as a cred that is simply not found.
    check(`...and names the SEGMENTED key, not the bare kind, on the ${label} root`, hosted.includes(segmentedKey(MEMBERSHIP_OBSERVER_CREDS_KIND, "hosted")), hosted);
  }

  console.log("\n4) the pair still has exactly two writers, and neither is reachable here");
  // Source-asserted, not recalled: this is the structural half of the finding, and drift must break
  // this suite rather than quietly invalidate the claim that no minting path exists on such a root.
  const upSrc = readFileSync("implementations/cli/src/commands/up.ts", "utf8");
  const rotSrc = readFileSync("packages/workspace/src/system-rotation.ts", "utf8");
  // As of P7 the pair is written through the SecretStore under the per-space key builders, never at a
  // path a caller composed, so the probe anchors on the builders: a `put` keyed by either of them IS
  // a write of the pair, and there is no other spelling that reaches the canonical location.
  const writers = (s: string) => (s.match(/put\(\s*(?:membershipObserverCredsKey|connectionEvictorCredsKey)\(/g) ?? []).length;
  check("up.ts writes the pair in exactly ONE function (provisionMembershipCreds)", writers(upSrc) === 2, writers(upSrc));
  check("...and that function has exactly ONE call site, in the fresh-space branch", (upSrc.match(/provisionMembershipCreds\(/g) ?? []).length === 2, (upSrc.match(/provisionMembershipCreds\(/g) ?? []).length);
  check("system-rotation.ts writes the pair in exactly ONE function (rotateSystemCreds)", writers(rotSrc) === 2, writers(rotSrc));
  check("no OTHER module writes the pair at all", writers(upSrc) + writers(rotSrc) === 4);
  check("rotateSystemCreds is guarded by the single-space broker assert", /assertSingleSpaceBroker\(authDir\(root\), "a system-account rotation/.test(rotSrc));
  // And the standing renewal owner is excluded by design, so nothing repairs it on a timer either.
  const remintable = REMINTABLE_DAEMON_CREDS.map((r) => r.kind);
  check("REMINTABLE_DAEMON_CREDS excludes both $SYS creds, so renewal never repairs them", !remintable.includes(MEMBERSHIP_OBSERVER_CREDS_KIND) && !remintable.includes(CONNECTION_EVICTOR_CREDS_KIND), remintable);
  check("CONTROL: it DOES carry the two seed-backed kinds, so that list is not simply empty", remintable.includes(DELIVERY_CREDS_KIND) && remintable.includes(MEMBERSHIP_RW_CREDS_KIND), remintable);

  console.log("\n5) the daemon REPORTS the incomplete bundle it is advising about");
  const emptyPair = await loadSysPair(fsSource(two, "alpha"), "both");
  check("both $SYS creds report MISSING on the unprovisioned root, named by KIND not by segmented key", emptyPair.missing.length === 2 && emptyPair.missing.includes(MEMBERSHIP_OBSERVER_CREDS_KIND) && emptyPair.missing.includes(CONNECTION_EVICTOR_CREDS_KIND), emptyPair.missing);
  // POSITIVE CONTROL: a provisioned root reads CLEAN through the very same call, so "missing" is the
  // root's state and not a reader that cannot see creds it was handed.
  const soloBuilt = await makeRoot("provisioned", ["provisioned"]);
  roots.push(soloBuilt.root);
  const auth = composeSpaceAuth(soloBuilt.broker, soloBuilt.accounts[0]);
  const store = workspaceSecretStore(soloBuilt.root);
  const provisioned = { injected: false as const, root: soloBuilt.root };
  await store.put(membershipObserverCredsKey("provisioned", provisioned), await mintMembershipObserverCreds(auth, newIdentity()));
  await store.put(connectionEvictorCredsKey("provisioned", provisioned), await mintConnectionEvictorCreds(auth, newIdentity()));
  const fullPair = await loadSysPair(fsSource(soloBuilt.root, "provisioned"), "both");
  check("CONTROL: a provisioned root reports NOTHING missing through the same reader", fullPair.missing.length === 0 && typeof fullPair.observer === "string", fullPair.missing);

  console.log(`\nSYS-REPAIR-HONESTY SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);

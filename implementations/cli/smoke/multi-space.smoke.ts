/**
 * Multi-space-per-broker boundaries — hermetic, no broker needed.
 * Run: pnpm smoke:multi-space
 *
 * Covers the facts W4 slices 1 & 2 rest on:
 *
 *  1. BROKER-WIDE LIFECYCLE REFUSALS, driven through the REAL command entry points (`down`, `clean`,
 *     `backup`, `up --restore`), not just the guard helper: each acts on the one broker process, its
 *     one JetStream store and the one broker trust record every account is signed under, so on a root
 *     holding several accounts it must refuse and NAME the tenants, leaving the auth material intact.
 *     `clean restore-attempt|restore-fallback` are refused too — the guard runs BEFORE their branch,
 *     so the broker-wide `rollbackRestore`/`cleanupRestoreFallback` recovery verbs cannot bypass it.
 *
 *  2. THE ACCOUNT FILE IS INJECTIVE AND NOT THE USER-AUTH MARKER. Account files are keyed by an
 *     injective, case-safe hex of the space name (`account.<hex>.json`), so two case-differing tenants
 *     never collapse to one file (which would silently defeat the broker-wide refusal on a
 *     case-insensitive FS). The user-auth marker is a provider pin inside a real DIRECTORY, never the
 *     bare existence of a path — so a space named `broker.json`/`creds` cannot alias a sibling file/dir
 *     into reading as user-mode.
 *
 *  3. THE TENANT LIST IS AUTHORITATIVE AND FAIL-CLOSED. Enumeration takes each record's own `space`
 *     and round-trips it; a file in the account namespace that will not validate makes the broker-wide
 *     guard refuse (uncertain blast radius), never silently undercount.
 *
 *  4. BROKER TRUST HAS ONE OWNER. Overwriting `broker.json` with a different operator would orphan
 *     every account signed by the current one, so it is refused; a same-operator sys rotation is not.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-multispace-home-"));
process.env.COTAL_HOME = home;
const originalCwd = process.cwd();

await import("../src/index.js"); // register the base local-process lifecycle descriptors
const { createBrokerAuth, createSpaceAccountAuth, createSpaceAuth, composeSpaceAuth, rotateSystemAccount } = await import("@cotal-ai/core");
const {
  assertSingleSpaceBroker, authDir, agentCredsDir, brokerAuthPath, hasUserAuthState, isWorkspaceTargetError,
  listSpaceAccounts, loadSpaceAuth, resolveMeshTarget, saveBrokerAuth, saveSpaceAccountAuth, soleSpaceOf,
  spaceAccountPath, userAuthStateDir,
} = await import("@cotal-ai/workspace");
const { down } = await import("../src/commands/down.js");
const { clean } = await import("../src/commands/clean.js");
const { backup } = await import("../src/commands/backup.js");
const { up } = await import("../src/commands/up.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** Capture the message a command/guard throws (or "" if it did not throw). */
async function refusal(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

/** Provision a root under ONE broker trust chain holding an account per named space. */
async function makeRoot(label: string, spaces: string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `cotal-multispace-${label}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const broker = await createBrokerAuth(label);
  saveBrokerAuth(authDir(root), broker);
  for (const space of spaces) saveSpaceAccountAuth(authDir(root), await createSpaceAccountAuth(broker, space));
  return root;
}

const roots: string[] = [];
try {
  console.log("1) one broker, several space accounts");
  const multi = await makeRoot("multi", ["alpha", "beta"]);
  roots.push(multi);
  check("both accounts are enumerated off disk", listSpaceAccounts(authDir(multi)).join(",") === "alpha,beta", listSpaceAccounts(authDir(multi)));
  check("each account composes against the SAME broker trust", ["alpha", "beta"].every((s) => Boolean(loadSpaceAuth(authDir(multi), s))));
  check("the two accounts are distinct", loadSpaceAuth(authDir(multi), "alpha")!.account.pub !== loadSpaceAuth(authDir(multi), "beta")!.account.pub);

  console.log("\n2) the account file is injective (case-safe) and case-differing tenants do not collapse");
  const cased = await makeRoot("cased", ["alpha", "Alpha"]);
  roots.push(cased);
  check("alpha and Alpha get DISTINCT account paths", spaceAccountPath(authDir(cased), "alpha") !== spaceAccountPath(authDir(cased), "Alpha"));
  check("both case-differing tenants enumerate (no collapse even on a case-insensitive FS)", listSpaceAccounts(authDir(cased)).length === 2);
  check("the broker-wide guard therefore still sees TWO tenants", (await refusal(() => assertSingleSpaceBroker(authDir(cased), "cotal down"))).includes("2 spaces"));

  console.log("\n3) the account record never fakes the user-auth marker");
  const solo = await makeRoot("solo", ["solo"]);
  roots.push(solo);
  check("a static-mode space is NOT user-auth on disk", hasUserAuthState(solo, "solo") === false, readdirSync(authDir(solo)));
  check("its account is a flat file beside broker.json", spaceAccountPath(authDir(solo), "solo").startsWith(join(authDir(solo), "account.")));
  check("the account path is not inside the provider's state dir", !spaceAccountPath(authDir(solo), "solo").startsWith(userAuthStateDir(solo, "solo") + sep));
  check('a space named "broker.json" does NOT alias the broker file into user-mode', hasUserAuthState(solo, "broker.json") === false);
  mkdirSync(agentCredsDir(solo), { recursive: true });
  writeFileSync(join(agentCredsDir(solo), "x.creds"), "cred");
  check('a space named "creds" does NOT alias the creds dir into user-mode', hasUserAuthState(solo, "creds") === false);
  const realState = userAuthStateDir(solo, "userspace");
  mkdirSync(realState, { recursive: true });
  writeFileSync(join(realState, "idp.json"), "{}");
  check("a real state dir WITH a provider pin IS user-auth", hasUserAuthState(solo, "userspace") === true);
  mkdirSync(userAuthStateDir(solo, "halfspace"), { recursive: true });
  check("an empty state dir (crashed enable) is NOT user-auth", hasUserAuthState(solo, "halfspace") === false);
  for (const space of ["alpha", "beta"]) check(`…and neither is "${space}" on the multi-space root`, hasUserAuthState(multi, space) === false);

  console.log("\n4) an unreadable account record makes the guard refuse (fail-closed), never undercount");
  const corrupt = await makeRoot("corrupt", ["one"]);
  roots.push(corrupt);
  writeFileSync(join(authDir(corrupt), "account.zznothex.json"), JSON.stringify({ space: "x" }));
  check("assertSingleSpaceBroker REFUSES on a non-hex account file", (await refusal(() => assertSingleSpaceBroker(authDir(corrupt), "cotal clean all"))).includes("not fully readable"));
  rmSync(join(authDir(corrupt), "account.zznothex.json"));
  const swapKey = Buffer.from("two", "utf8").toString("hex");
  writeFileSync(join(authDir(corrupt), `account.${swapKey}.json`), JSON.stringify({ space: "three", account: {} }));
  check("assertSingleSpaceBroker REFUSES when doc.space disagrees with the filename key", (await refusal(() => assertSingleSpaceBroker(authDir(corrupt), "cotal clean all"))).includes("not fully readable"));
  rmSync(join(authDir(corrupt), `account.${swapKey}.json`));
  check("…and permits again once the stray record is gone", (await refusal(() => assertSingleSpaceBroker(authDir(corrupt), "cotal clean all"))) === "");

  console.log("\n5) space-blind resolution fails loud rather than picking a tenant");
  check("soleSpaceOf answers on a single-space root", soleSpaceOf(authDir(solo)) === "solo");
  const blind = await refusal(() => soleSpaceOf(authDir(multi)));
  check("soleSpaceOf refuses on a multi-space root", blind.includes("refuses to pick one"), blind);
  check("…and names every tenant it refused to choose between", blind.includes("alpha") && blind.includes("beta"), blind);
  // The resolver must surface that as a CATCHABLE target error (not a raw throw), so a reader like
  // `cotal status` reports "ambiguous target" instead of crashing on an uncaught exception.
  let targetErr: unknown;
  try { resolveMeshTarget(multi, {}); } catch (e) { targetErr = e; }
  check("resolveMeshTarget on a multi-space root throws a typed target error", isWorkspaceTargetError(targetErr) && (targetErr as { code: string }).code === "ambiguous-target", (targetErr as Error)?.message);

  console.log("\n6) broker-wide operations refuse THROUGH THE REAL COMMANDS, naming the tenants");
  process.chdir(multi); // the commands resolve their root from cwd
  const commands: Array<[string, () => Promise<unknown>]> = [
    ["cotal down", () => down({ positionals: [], values: {} } as never)],
    ["cotal clean store", () => clean({ positionals: ["store"], values: { force: true } } as never)],
    ["cotal clean all", () => clean({ positionals: ["all"], values: { force: true } } as never)],
    ["cotal clean restore-attempt", () => clean({ positionals: ["restore-attempt"], values: { force: true, attempt: "x" } } as never)],
    ["cotal clean restore-fallback", () => clean({ positionals: ["restore-fallback"], values: { force: true, attempt: "x" } } as never)],
    ["cotal backup", () => backup({ positionals: ["create", join(home, "artifact")], values: {} } as never)],
    ["cotal up --restore", () => up({ positionals: [], values: { restore: join(home, "artifact") } } as never)],
  ];
  for (const [label, run] of commands) {
    const msg = await refusal(run);
    check(`${label} refuses on a multi-space broker`, msg.includes("broker-wide"), msg);
    check(`…${label} names the tenants it would have destroyed`, msg.includes("alpha") && msg.includes("beta"), msg);
  }
  // Blocker-2 witness: the restore-recovery verbs must be refused by the BROKER-WIDE guard, not by
  // their own inner "no such attempt" check — that only fires if the guard runs first.
  const restoreMsg = await refusal(() => clean({ positionals: ["restore-attempt"], values: { force: true, attempt: "x" } } as never));
  check("clean restore-attempt is stopped by the guard, not its inner attempt check", restoreMsg.includes("broker-wide") && !restoreMsg.includes("no pre-commit restore attempt"), restoreMsg);
  process.chdir(originalCwd);
  check("no refusal touched the auth material", listSpaceAccounts(authDir(multi)).join(",") === "alpha,beta" && existsSync(brokerAuthPath(authDir(multi))));

  console.log("\n7) broker trust has one owner: a different operator is refused, a sys rotation is not");
  const owned = await makeRoot("owned", ["only"]);
  roots.push(owned);
  const ownedBroker = await reloadBroker(owned);
  const intruder = await createBrokerAuth("intruder");
  check("saveBrokerAuth REFUSES overwriting with a different operator", (await refusal(() => saveBrokerAuth(authDir(owned), intruder))).includes("different broker operator"));
  const account = await createSpaceAccountAuth(ownedBroker, "only");
  const rotated = await rotateSystemAccount(composeSpaceAuth(ownedBroker, account));
  check("a sys-account rotation keeps the operator seed", rotated.operator.seed === ownedBroker.operator.seed);
  check("saveBrokerAuth ALLOWS a same-operator sys rotation", (await refusal(() => saveBrokerAuth(authDir(owned), rotated))) === "");

  console.log("\n8) the same operations pass on a single-space root, and auth is intact");
  check("assertSingleSpaceBroker permits on a single-space root", ["cotal down", "cotal backup"].every((op) => {
    try { assertSingleSpaceBroker(authDir(solo), op); return true; } catch { return false; }
  }));

  console.log(`\nMULTI-SPACE SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exitCode = 1;
} finally {
  process.chdir(originalCwd);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

/** Reload the persisted broker trust (seed + jwt) so a sys rotation runs against the real on-disk
 *  operator. Kept tiny and local — the smoke needs a full BrokerAuth to feed `rotateSystemAccount`. */
async function reloadBroker(root: string): Promise<import("@cotal-ai/core").BrokerAuth> {
  const { loadBrokerAuth } = await import("@cotal-ai/workspace");
  const broker = loadBrokerAuth(authDir(root));
  if (!broker) throw new Error("reloadBroker: no broker trust on disk");
  return broker;
}

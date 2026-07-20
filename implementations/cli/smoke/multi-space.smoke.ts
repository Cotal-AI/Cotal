/**
 * Multi-space-per-broker boundaries — hermetic, no broker needed.
 * Run: pnpm smoke:multi-space
 *
 * Covers the two facts W4 slice 2 rests on:
 *
 *  1. BROKER-WIDE LIFECYCLE REFUSALS. `down`, `clean store|all`, `backup` and `up --restore` act on
 *     the one broker process, its one JetStream store and the one broker trust record every space
 *     account is signed under. On a root holding several accounts they would take out every tenant,
 *     and no `--space` can scope them (two of them do not even accept one). Each must refuse and
 *     NAME the tenants, and must leave the auth material untouched.
 *
 *  2. THE ACCOUNT RECORD IS NOT THE USER-AUTH MARKER. `<authDir>/<space>/` is the auth provider's
 *     state dir, and its bare existence is how the CLI, the manager and the workspace layer decide a
 *     space is user-mode. A space account therefore lives in a FLAT `account.<space>.json` beside
 *     `broker.json`; persisting one must never make a static-mode space read as user-mode. Getting
 *     this wrong made every space look user-mode and would have refused every static-mode manager.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-multispace-home-"));
process.env.COTAL_HOME = home;

await import("../src/index.js"); // register the base local-process lifecycle descriptors
const { createBrokerAuth, createSpaceAccountAuth } = await import("@cotal-ai/core");
const {
  assertSingleSpaceBroker, authDir, listSpaceAccounts, loadSpaceAuth,
  saveBrokerAuth, saveSpaceAccountAuth, soleSpaceOf, spaceAccountPath, userAuthStateDir,
} = await import("@cotal-ai/workspace");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

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

  console.log("\n2) the account record never fakes the user-auth marker");
  const solo = await makeRoot("solo", ["solo"]);
  roots.push(solo);
  check("a static-mode space has NO user-auth state dir", !existsSync(userAuthStateDir(solo, "solo")), readdirSync(authDir(solo)));
  check("its account is a flat file beside broker.json", spaceAccountPath(authDir(solo), "solo") === join(authDir(solo), "account.solo.json"));
  check("the account path is not inside the provider's state dir", !spaceAccountPath(authDir(solo), "solo").startsWith(userAuthStateDir(solo, "solo") + sep));
  for (const space of ["alpha", "beta"]) check(`…and neither does "${space}" on the multi-space root`, !existsSync(userAuthStateDir(multi, space)));

  console.log("\n3) space-blind resolution fails loud rather than picking a tenant");
  check("soleSpaceOf answers on a single-space root", soleSpaceOf(authDir(solo)) === "solo");
  let blind = "";
  try { soleSpaceOf(authDir(multi)); } catch (e) { blind = (e as Error).message; }
  check("soleSpaceOf refuses on a multi-space root", blind.includes("refuses to pick one"), blind);
  check("…and names every tenant it refused to choose between", blind.includes("alpha") && blind.includes("beta"), blind);

  console.log("\n4) broker-wide operations refuse, and say why a --space cannot help");
  for (const op of ["cotal down", "cotal clean all", "cotal clean store", "cotal backup", "cotal up --restore"]) {
    let msg = "";
    try { assertSingleSpaceBroker(authDir(multi), op); } catch (e) { msg = (e as Error).message; }
    check(`${op} refuses on a multi-space broker`, msg.includes("broker-wide"), msg);
    check("…names the tenants it would have destroyed", msg.includes("alpha") && msg.includes("beta"), msg);
    check("…and does not send the operator after a --space that cannot scope it", msg.includes("cannot scope it"), msg);
  }
  check("the same operations pass on a single-space root", ["cotal down", "cotal backup"].every((op) => {
    try { assertSingleSpaceBroker(authDir(solo), op); return true; } catch { return false; }
  }));
  check("no refusal touched the auth material", listSpaceAccounts(authDir(multi)).join(",") === "alpha,beta" && existsSync(join(authDir(multi), "broker.json")));

  console.log(`\nMULTI-SPACE SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exit(1);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

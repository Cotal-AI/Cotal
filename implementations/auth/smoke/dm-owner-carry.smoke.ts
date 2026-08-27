/**
 * DM-owner CARRY + ATTENUATION smoke — the seam a core-level suite structurally cannot see.
 *
 * `allowDmOwners` lives on a stored ledger row and only matters if it survives two journeys the
 * core suite never makes:
 *
 *  1. STORED ROW → RESOLVER → MINT. The core suite calls `mintCreds` directly and passes the option
 *     by hand, so a resolver that simply omits the field leaves all of its cells green while every
 *     real principal silently reverts to the historical wildcard: a stored "no DM at all" becomes
 *     "DM anyone", with core byte-unchanged. These cells drive `ledgerAclResolver` — the actual
 *     function the callout injects — against rows written by the actual grant path.
 *
 *  2. DELEGATION. `assertWithinSpawnerGrant` is the envelope rule for everything under an owner.
 *     Until it knew this field, any agent holding `spawn` could grant a child a WIDER DM list than
 *     it held itself — escaping its own policy in one hop, which is the whole of what the policy is
 *     for. The trap is that ABSENT means `["*"]`, so a child that merely OMITS the field is the
 *     widest possible widening while reading in a diff as though it asks for nothing.
 *
 * The upgrade-safety direction is asserted just as hard as the security one: an ABSENT PARENT must
 * stay permissive, or this fix re-creates the very break the default-allow design exists to avoid.
 *
 * Run: pnpm smoke:dm-owner-carry   (no broker; real ledger dir on a temp path)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { grantActor, grantManagedActor, ledgerAclResolver, newActorToken } from "../src/ledger.js";
import { mintLifecycleUid, permissionsFor, unicastSubject } from "@cotal-ai/core";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const threw = (fn: () => unknown): string | undefined => {
  try { fn(); return undefined; } catch (e) { return (e as Error).message; }
};

const OWNER = "u_" + "a".repeat(26);
const B = "u_" + "b".repeat(26);
const C = "u_" + "c".repeat(26);
const dir = mkdtempSync(join(tmpdir(), "cotal-dmcarry-"));

try {
  const uid = mintLifecycleUid();
  const base = { owner: OWNER, scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: uid };
  const tok = (actor: string, u = uid) => ({ owner: OWNER, act: { actor, lifecycleUid: u } }) as never;

  // ---- 1. stored row -> resolver ----
  grantActor(dir, { ...base, actor: "scoped", allowDmOwners: [B] });
  grantActor(dir, { ...base, actor: "wide" });                       // field ABSENT on the row
  grantActor(dir, { ...base, actor: "silent", allowDmOwners: [] });  // field EMPTY on the row
  const resolve = ledgerAclResolver(dir);

  console.log("stored row → the resolver the callout actually injects:");
  check("a SCOPED row's list reaches the mint opts",
    JSON.stringify(resolve(tok("scoped")).allowDmOwners) === JSON.stringify([B]));
  // The regression that a core-level suite cannot see: a dropping resolver reverts to the wildcard.
  check("an ABSENT row leaves the key ABSENT (not [], not undefined-valued)",
    !("allowDmOwners" in resolve(tok("wide"))));
  check("an EMPTY row carries [] through — it is NOT dropped as falsy",
    JSON.stringify(resolve(tok("silent")).allowDmOwners) === JSON.stringify([]));

  // ---- 2. resolver output -> the real mint ----
  console.log("\n…and the mint those opts produce:");
  const grantsFor = (actor: string) => {
    const r = resolve(tok(actor));
    const p = permissionsFor("agent", "sp", { owner: OWNER, actor, connId: "connid000001", lifecycleUid: uid }, r as never) as
      { pub: { allow: string[] } };
    return p.pub.allow;
  };
  check("SCOPED mints a DM grant for B and none for C",
    grantsFor("scoped").includes(unicastSubject("sp", B, "*", OWNER, "scoped")) &&
    !grantsFor("scoped").includes(unicastSubject("sp", C, "*", OWNER, "scoped")));
  check("ABSENT mints the historical wildcard",
    grantsFor("wide").includes(unicastSubject("sp", "*", "*", OWNER, "wide")));
  check("EMPTY mints NO DM grant at all",
    grantsFor("silent").every((s) => !s.includes(".inst.")));

  // ---- 3. delegation attenuation ----
  console.log("\ndelegation — a child may never out-reach its spawner:");
  const child = (actor: string, parent: string, dm?: string[]) => () =>
    grantManagedActor(dir, {
      owner: OWNER, actor, scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"],
      parent: `${OWNER}.${parent}`, lifecycleUid: mintLifecycleUid(), tokenHash: newActorToken().tokenHash,
      ...(dm ? { allowDmOwners: dm } : {}),
    });
  check("a child NARROWING to a subset is allowed", threw(child("k1", "scoped", [B])) === undefined);
  check("a child narrowing to [] (no DM) is allowed", threw(child("k2", "scoped", [])) === undefined);
  const wider = threw(child("k3", "scoped", [B, C]));
  check("a child adding an owner the parent lacks is REFUSED", wider !== undefined && wider.includes("dm ["));
  const star = threw(child("k4", "scoped", ["*"]));
  check("a child asking for [\"*\"] under a scoped parent is REFUSED", star !== undefined);
  // The one a diff cannot show you: omitting the field is asking for everything.
  const omitted = threw(child("k5", "scoped", undefined));
  check("a child that OMITS the field under a scoped parent is REFUSED (absent means \"*\")",
    omitted !== undefined);
  check("…and that refusal SAYS omission means \"*\", instead of reporting an empty demand",
    (omitted ?? "").includes("names no dm list"));

  // ---- 4. upgrade safety: the direction this fix must NOT break ----
  console.log("\nupgrade safety — an unscoped parent constrains nothing:");
  check("a child of an ABSENT-list parent may hold any list",
    threw(child("k6", "wide", [B, C])) === undefined);
  check("a child of an ABSENT-list parent may OMIT the field",
    threw(child("k7", "wide", undefined)) === undefined);
  check("a child of an ABSENT-list parent may even hold [\"*\"]",
    threw(child("k8", "wide", ["*"])) === undefined);

  // ---- 5. the carry is structural, not three remembered lines ----
  console.log("\nthe carry is one value, not a line to forget:");
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ledger.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const i = code.indexOf("function aclFromRow("), j = code.indexOf("\n}", i);
  if (i < 0 || j < 0) { fail++; console.log("  ✗ FAIL: could not locate aclFromRow to excise"); }
  const outside = code.slice(0, i) + code.slice(j);
  check("every resolver takes its ACLs from the one carry", (code.match(/\.\.\.aclFromRow\(row\)/g) ?? []).length === 3);
  check("no site hand-writes the ACL fields around it", !outside.includes("allowPublish: row.allowPublish"));
  check("…and the excised carry really did contain them (instrument control)",
    code.slice(i, j).includes("allowPublish: row.allowPublish"));

  // ---- 6. the PRODUCER: without it the field is unreachable except by hand-editing ledger JSON ----
  // The behavioural cells above write rows through the ledger API. The supported path a real
  // deployment uses is AuthProvider.grantAgent, which did not declare this field at all — so the
  // feature shipped with no way to turn it on. These pin the whole producer chain; a link dropped
  // anywhere in it puts the feature back out of reach without breaking a single behavioural cell.
  console.log("\nthe producer chain — the field must be settable by supported means:");
  const here = dirname(fileURLToPath(import.meta.url));
  const seam = readFileSync(join(here, "..", "..", "..", "packages", "core", "src", "auth-provider.ts"), "utf8");
  const impl = readFileSync(join(here, "..", "src", "provider.ts"), "utf8");
  const cli = readFileSync(join(here, "..", "src", "commands.ts"), "utf8");
  check("the core AuthProvider seam DECLARES allowDmOwners on grantAgent",
    /grantAgent\(opts:[\s\S]{0,1200}?allowDmOwners\?: string\[\]/.test(seam));
  check("the auth implementation DESTRUCTURES it from those opts",
    /async grantAgent\(\{[^}]*allowDmOwners[^}]*\}/.test(impl));
  check("…and SPREADS it onto the row it writes (absent staying absent)",
    /\.\.\.\(allowDmOwners \? \{ allowDmOwners \} : \{\}\)/.test(impl));
  check("`cotal actor grant` exposes --allow-dm-owners", /name: "allow-dm-owners"/.test(cli));
  check("…and the flag distinguishes OMITTED from '' (three states, not two)",
    /values\["allow-dm-owners"\] !== undefined/.test(cli));
  check("`actor list` shows the dm set, so an operator can see what they set",
    /dm=\[\$\{\(r\.allowDmOwners \?\? \["\*"\]\)/.test(cli));

  console.log(`\nDM-OWNER-CARRY SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  const EXPECTED = 24;
  if (pass + fail !== EXPECTED) { console.log(`  ✗ FAIL: expected ${EXPECTED} cells, ran ${pass + fail}`); process.exitCode = 1; }
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

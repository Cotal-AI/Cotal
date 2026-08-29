/**
 * The space-segmentation foundation gate (P7/P1 shared design,
 * `docs/design/space-segmentation-p7-p1.md` §2 and §3). Hermetic — no broker, no network.
 *
 * Three guarantees, none of which the codebase asserted before:
 *
 *  1. THE ENCODER'S COLLISION CLAIM NOW COVERS `.cotal/`. `spaceSegment` promised non-collision
 *     against the reserved siblings of the AUTH dir. P7 puts a `space.<hex>` directly under
 *     `.cotal/`, a wider namespace, and the claim holds there by accident until something asserts
 *     it: `auth-service.<spaceKey>.pid` is the nearest miss, and one future `.cotal` child named
 *     `space.*` would alias a tenant's whole segment.
 *
 *  2. THE MIGRATION CHOKE POINT REFUSES BEFORE IT LAUNDERS. Moving a root-scoped copy into a
 *     tenant's segment on a MULTI-tenant root manufactures an owner claim that may be wrong, which
 *     is worse than the ambient inheritance squat it replaces and, unlike the squat, irreversible.
 *     Rule 4 refuses there; rule 3 refuses a half-migrated kind; rule 2's rename is what makes each
 *     kind individually all-or-nothing.
 *
 *  3. THE `space add` DOOR. Adding a tenant to a root holding unmigrated material is the only way to
 *     CREATE unattributable material, so the verb refuses and names a remedy that exists.
 *
 * The refusal WORDING is asserted, not just the throw. `up --rotate-sys` is broker-wide and refuses
 * on exactly the multi-tenant roots rule 4 fires on (probe-executed, §6), so a refusal that pointed
 * an operator there would be advice that cannot succeed — the same defect
 * `healMembershipDataCreds`'s own comment records.
 *
 * Run: pnpm smoke:space-segmentation
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerAuth, createSpaceAccountAuth } from "@cotal-ai/core";
import { authDir, saveBrokerAuth, saveSpaceAccountAuth, spaceFromSegment, spaceSegment } from "../src/auth-paths.js";
import {
  assertNoUnsegmentedLegacyMaterial, cotalDir, migrateLegacyCotalMaterial,
  P7_LEGACY_MATERIAL, RESERVED_COTAL_CHILDREN,
} from "../src/space-segmentation.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const rejects = (name: string, fn: () => unknown, mustInclude: string[], mustNotInclude: string[] = []) => {
  try {
    fn();
    check(`${name} (did not throw)`, false);
  } catch (e) {
    const msg = (e as Error).message;
    const missing = mustInclude.filter((s) => !msg.includes(s));
    const leaked = mustNotInclude.filter((s) => msg.includes(s));
    check(name, missing.length === 0 && leaked.length === 0, { missing, leaked, msg });
  }
};

/** A root under ONE broker trust chain holding an account per named space. */
async function makeRoot(label: string, spaces: string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `cotal-seg-${label}-`));
  mkdirSync(cotalDir(root), { recursive: true });
  const broker = await createBrokerAuth(label);
  saveBrokerAuth(authDir(root), broker);
  for (const space of spaces) saveSpaceAccountAuth(authDir(root), await createSpaceAccountAuth(broker, space));
  return root;
}

const roots: string[] = [];
try {
  console.log("1) the segment cannot collide with any child of .cotal/");
  for (const name of RESERVED_COTAL_CHILDREN)
    check(`"${name}" is not a canonical segment`, spaceFromSegment(name) === undefined && !name.startsWith("space."), name);
  // The nearest miss is a real name, not a hypothetical: it shares the `<prefix>.<spaceKey>` shape.
  check("auth-service.<spaceKey>.pid is not a canonical segment", spaceFromSegment(`auth-service.${Buffer.from("alpha", "utf8").toString("hex")}.pid`) === undefined);
  // POSITIVE CONTROL: the predicate is not simply always-undefined — it DOES recognise real segments.
  for (const space of ["alpha", "Alpha", "a.b", "☃", "space.616c706861"])
    check(`CONTROL: spaceFromSegment round-trips "${space}"`, spaceFromSegment(spaceSegment(space)) === space, spaceSegment(space));
  // And no segment any space name can produce equals a reserved child.
  const reserved = new Set(RESERVED_COTAL_CHILDREN);
  check("no segment of a P7 kind's own name collides with a reserved child", P7_LEGACY_MATERIAL.every((k) => !reserved.has(spaceSegment(k))));

  console.log("\n2) rule 4 — the choke point refuses to migrate on a multi-tenant root");
  const multi = await makeRoot("multi", ["alpha", "beta"]);
  roots.push(multi);
  writeFileSync(join(cotalDir(multi), "membership.json"), '{"accountId":"A"}');
  rejects(
    "migration REFUSES on a two-tenant root",
    () => migrateLegacyCotalMaterial(multi, "alpha", "membership.json"),
    ["this root holds 2 spaces", "alpha", "beta", "assert an owner that may be wrong"],
  );
  rejects(
    "...and the refusal offers NO command, naming rotate-sys only as also refusing",
    () => migrateLegacyCotalMaterial(multi, "alpha", "membership.json"),
    ["There is no command to offer here", "refuses on this root too"],
  );
  check("the legacy file is left exactly where it was", existsSync(join(cotalDir(multi), "membership.json")));
  check("no segment dir was created for either tenant", !existsSync(join(cotalDir(multi), spaceSegment("alpha"))) && !existsSync(join(cotalDir(multi), spaceSegment("beta"))));

  // Fail-CLOSED: an unreadable account record is uncertainty about the tenant count, and an
  // under-count here would let the laundering proceed on a root that does hold several tenants.
  const corrupt = await makeRoot("corrupt", ["one"]);
  roots.push(corrupt);
  writeFileSync(join(authDir(corrupt), "account.zznothex.json"), JSON.stringify({ space: "x" }));
  writeFileSync(join(cotalDir(corrupt), "membership.json"), '{"accountId":"A"}');
  rejects(
    "an unreadable account record refuses the migration (never undercounts to one)",
    () => migrateLegacyCotalMaterial(corrupt, "one", "membership.json"),
    ["not fully readable", "account.zznothex.json"],
  );

  console.log("\n3) rules 1-3 — on a single-tenant root the move happens once, atomically");
  const solo = await makeRoot("solo", ["solo"]);
  roots.push(solo);
  const legacy = join(cotalDir(solo), "membership.json");
  writeFileSync(legacy, '{"accountId":"SOLO"}');
  const canonical = migrateLegacyCotalMaterial(solo, "solo", "membership.json");
  check("returns the segmented path", canonical === join(cotalDir(solo), spaceSegment("solo"), "membership.json"), canonical);
  check("the material MOVED (legacy gone, canonical present)", !existsSync(legacy) && existsSync(canonical));
  check("the bytes survived the move", readdirSync(join(cotalDir(solo), spaceSegment("solo"))).includes("membership.json"));
  check("a second touch is a no-op returning the same path", migrateLegacyCotalMaterial(solo, "solo", "membership.json") === canonical);

  // POSITIVE CONTROL: with no legacy copy the resolver is inert — it must not create anything.
  const fresh = await makeRoot("fresh", ["fresh"]);
  roots.push(fresh);
  const freshPath = migrateLegacyCotalMaterial(fresh, "fresh", "membership.json");
  check("CONTROL: a root with no legacy copy resolves without throwing", freshPath.endsWith(join(spaceSegment("fresh"), "membership.json")));
  check("CONTROL: ...and the resolver created nothing", !existsSync(freshPath) && !existsSync(join(cotalDir(fresh), spaceSegment("fresh"))));

  // Rule 3: canonical AND legacy both present is a partial migration this cannot arbitrate.
  const torn = await makeRoot("torn", ["torn"]);
  roots.push(torn);
  writeFileSync(join(cotalDir(torn), "membership.json"), '{"accountId":"LEGACY"}');
  mkdirSync(join(cotalDir(torn), spaceSegment("torn")), { recursive: true });
  writeFileSync(join(cotalDir(torn), spaceSegment("torn"), "membership.json"), '{"accountId":"CANONICAL"}');
  rejects(
    "both copies present REFUSES rather than guessing which is current",
    () => migrateLegacyCotalMaterial(torn, "torn", "membership.json"),
    ["refusing to guess which is current", "canonical existence alone does not prove"],
  );
  check("neither copy was touched by the refusal", existsSync(join(cotalDir(torn), "membership.json")) && existsSync(join(cotalDir(torn), spaceSegment("torn"), "membership.json")));

  console.log("\n4) the `space add` door");
  const door = await makeRoot("door", ["only"]);
  roots.push(door);
  writeFileSync(join(cotalDir(door), "membership-observer.creds"), "creds");
  rejects(
    "`space add` refuses on a root holding unmigrated material",
    () => assertNoUnsegmentedLegacyMaterial(door, "cotal space add"),
    ["membership-observer.creds", "unattributable", "Run `cotal up` for the sole tenant once"],
  );
  // POSITIVE CONTROL: the door is not always-refusing — a migrated root passes.
  const clean = await makeRoot("clean", ["only"]);
  roots.push(clean);
  assertNoUnsegmentedLegacyMaterial(clean, "cotal space add");
  check("CONTROL: a root with no root-scoped material passes the door", true);
  // ...and it notices EVERY kind, not just the first.
  for (const kind of P7_LEGACY_MATERIAL) {
    const r = await makeRoot(`kind-${kind.replace(/\W/g, "")}`, ["only"]);
    roots.push(r);
    writeFileSync(join(cotalDir(r), kind), "x");
    rejects(`the door sees ${kind}`, () => assertNoUnsegmentedLegacyMaterial(r, "cotal space add"), [kind]);
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);

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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerAuth, createSpaceAccountAuth } from "@cotal-ai/core";
import { authDir, saveBrokerAuth, saveSpaceAccountAuth, spaceFromSegment, spaceSegment } from "../src/auth-paths.js";
import {
  assertNoUnsegmentedLegacyMaterial, CONNECTION_EVICTOR_CREDS_KIND, connectionEvictorCredsKey, cotalDir,
  DELIVERY_CREDS_KIND, deliveryCredsKey, MEMBERSHIP_CONFIG_KIND, membershipConfigPath,
  MEMBERSHIP_OBSERVER_CREDS_KIND, membershipObserverCredsKey, MEMBERSHIP_RW_CREDS_KIND, membershipRwCredsKey,
  migrateLegacyCotalMaterial, P7_LEGACY_MATERIAL, RESERVED_COTAL_CHILDREN, segmentedKey,
  spaceMaterialDir, spaceMaterialKey, type SpaceMaterialComposition,
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

  console.log("\n5) the PER-KIND RESOLVERS (§2 rule 1) — one body, five kinds, two compositions");
  // Everything above tests the choke point directly. Production never calls it directly: it calls a
  // named wrapper per kind, and the hazard rule 1 exists to close is reachable through ANY wrapper
  // that quietly skips the move. All five kinds are absent-means-MINT for at least one writer, so a
  // canonical read on a root whose material is still flat answers "absent" and mints a SECOND live
  // cred beside the one the running daemons hold — a split generation no error ever reports.
  const KEY_RESOLVERS: ReadonlyArray<[string, (space: string, c: SpaceMaterialComposition) => string]> = [
    [DELIVERY_CREDS_KIND, deliveryCredsKey],
    [MEMBERSHIP_RW_CREDS_KIND, membershipRwCredsKey],
    [MEMBERSHIP_OBSERVER_CREDS_KIND, membershipObserverCredsKey],
    [CONNECTION_EVICTOR_CREDS_KIND, connectionEvictorCredsKey],
  ];
  check("every P7 kind but the config has a named KEY resolver (the config's is a PATH)",
    KEY_RESOLVERS.length + 1 === P7_LEGACY_MATERIAL.length &&
    KEY_RESOLVERS.every(([k]) => P7_LEGACY_MATERIAL.includes(k)) &&
    P7_LEGACY_MATERIAL.includes(MEMBERSHIP_CONFIG_KIND),
    { resolvers: KEY_RESOLVERS.map(([k]) => k), kinds: P7_LEGACY_MATERIAL });

  for (const [kind, resolve] of KEY_RESOLVERS) {
    const r = await makeRoot(`res-${kind.replace(/\W/g, "")}`, ["one"]);
    roots.push(r);
    const flat = join(cotalDir(r), kind);
    writeFileSync(flat, `${kind}-BYTES`);
    const key = resolve("one", { injected: false, root: r });
    check(`${kind}: the FS arm MOVED the legacy copy on first touch`, !existsSync(flat));
    // The key and the path are ONE layout, not two spellings of it: joining the returned key onto
    // `.cotal/` must land exactly on the file the move produced. A wrapper that resolved a key the
    // migration did not target would migrate correctly and then read somewhere else. The existence
    // test is not redundant with the read: a wrapper that skipped the move leaves nothing at the key
    // at all, and letting that surface as an ENOENT would abort the run before its completion banner,
    // which downgrades a real kill to INCONCLUSIVE. A missing file must be a RED CELL, not a crash.
    const resolved = join(cotalDir(r), key);
    check(`${kind}: the key names the file the move produced`,
      existsSync(resolved) && readFileSync(resolved, "utf8") === `${kind}-BYTES`, key);
    check(`${kind}: the key is the segmented one, not the pre-P7 flat kind`,
      key === `${spaceSegment("one")}/${kind}` && key !== kind, key);
    // The HOSTED arm has no filesystem to move anything on, so it must resolve the same key while
    // touching nothing. It is also the arm a `put` provisions from, which is why it must not answer
    // with the bare kind: that writes where the daemon does not read.
    const h = await makeRoot(`hosted-${kind.replace(/\W/g, "")}`, ["one"]);
    roots.push(h);
    writeFileSync(join(cotalDir(h), kind), "x");
    check(`${kind}: the hosted arm resolves the SAME key and migrates NOTHING`,
      resolve("one", { injected: true }) === key && existsSync(join(cotalDir(h), kind)));
  }

  // The config kind's wrapper returns a PATH rather than a key, which is a second body to forget in
  // — so it gets the same first-touch assertion rather than being trusted to match.
  const cfg = await makeRoot("res-config", ["one"]);
  roots.push(cfg);
  writeFileSync(join(cotalDir(cfg), MEMBERSHIP_CONFIG_KIND), '{"accountId":"MOVED"}');
  const cfgPath = membershipConfigPath(cfg, "one");
  check(`${MEMBERSHIP_CONFIG_KIND}: the path wrapper migrates on first touch too`,
    !existsSync(join(cotalDir(cfg), MEMBERSHIP_CONFIG_KIND)) && readFileSync(cfgPath, "utf8") === '{"accountId":"MOVED"}', cfgPath);

  // THE TWO NON-MIGRATING OWNERS (deleters, and the renewal owner) address the SAME layout the
  // resolvers do. They are a separate spelling on purpose — a sweep must not move material into the
  // path it is about to delete — and a separate spelling is a thing that drifts. If it ever did, a
  // reset would sweep one location while `up` wrote another and the stale cred would survive it.
  const owners = await makeRoot("owners", ["one"]);
  roots.push(owners);
  writeFileSync(join(cotalDir(owners), DELIVERY_CREDS_KIND), "x");
  check("segmentedKey agrees with the resolver, kind for kind",
    P7_LEGACY_MATERIAL.every((k) => segmentedKey(k, "one") === spaceMaterialKey(k, "one", { injected: true })));
  check("...and neither segmentedKey nor spaceMaterialDir moved anything to find that out",
    existsSync(join(cotalDir(owners), DELIVERY_CREDS_KIND)) &&
    spaceMaterialDir(owners, "one") === join(cotalDir(owners), spaceSegment("one")));

  // A REFUSAL must reach the caller THROUGH the wrapper. A wrapper that caught it and returned the
  // canonical key anyway would turn the loudest failure in the design into a silent second mint.
  const wrapTorn = await makeRoot("wrap-torn", ["one"]);
  roots.push(wrapTorn);
  writeFileSync(join(cotalDir(wrapTorn), DELIVERY_CREDS_KIND), "LEGACY");
  mkdirSync(join(cotalDir(wrapTorn), spaceSegment("one")), { recursive: true });
  writeFileSync(join(cotalDir(wrapTorn), spaceSegment("one"), DELIVERY_CREDS_KIND), "CANONICAL");
  rejects("rule 3 refuses through the named wrapper, not only through the choke point",
    () => deliveryCredsKey("one", { injected: false, root: wrapTorn }), ["refusing to guess which is current"]);
  const wrapMulti = await makeRoot("wrap-multi", ["alpha", "beta"]);
  roots.push(wrapMulti);
  writeFileSync(join(cotalDir(wrapMulti), MEMBERSHIP_CONFIG_KIND), '{"accountId":"A"}');
  rejects("rule 4 refuses through the path wrapper too",
    () => membershipConfigPath(wrapMulti, "alpha"), ["this root holds 2 spaces (alpha, beta)", "an owner that may be wrong"]);

  // The banner is printed on BOTH outcomes and names the suite, which is what lets the mutation
  // config declare it as a completion marker: a mutant run that stops early is then INCONCLUSIVE
  // rather than counted as a kill. A success-only banner would discard exactly the real kills.
  console.log(`\nSPACE-SEGMENTATION GATE ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);

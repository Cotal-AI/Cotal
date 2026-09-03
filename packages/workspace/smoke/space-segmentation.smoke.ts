/**
 * The space-segmentation foundation gate (P7/P1 shared design,
 * `docs/design/space-segmentation-p7-p1.md` §2 and §3). Hermetic — no broker, no network.
 *
 * Four guarantees, none of which the codebase asserted before:
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
 *  4. `space rm`'s STEP 7 REAP, AND WHERE ITS QUESTION IS ASKED. The reap runs past §2.2's point of
 *     no return, so it cannot refuse and cannot throw; the refusable precondition is asked at step 1
 *     instead. It removes ONE tenant's material from a root the others keep using, which makes the
 *     neighbour cell — not the removal cell — the one that catches a `.cotal/space.*` sweep.
 *
 * The refusal WORDING is asserted, not just the throw. `up --rotate-sys` is broker-wide and refuses
 * on exactly the multi-tenant roots rule 4 fires on (probe-executed, §6), so a refusal that pointed
 * an operator there would be advice that cannot succeed — the same defect
 * `healMembershipDataCreds`'s own comment records. That is why both doors now COMPOSE their remedy
 * from rule 4's own answer: the sentence that is right for the single-tenant root a door usually
 * sees is advice that cannot succeed on the roots §2.1 says bypass the doors entirely.
 *
 * Run: pnpm smoke:space-segmentation
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  canonicalLocalProcessPath, DELIVERY_LOGFILE, DELIVERY_PIDFILE, MANAGER_DELIVERY_AWARE_MARKER,
  MANAGER_LOGFILE, MANAGER_PIDFILE,
} from "../src/local-process.js";
import { createBrokerAuth, createSpaceAccountAuth, type SecretStore } from "@cotal-ai/core";
import { authDir, saveBrokerAuth, saveSpaceAccountAuth, spaceFromSegment, spaceSegment } from "../src/auth-paths.js";
import {
  assertNoUnsegmentedLegacyMaterial, assertSpaceMaterialReapable, CONNECTION_EVICTOR_CREDS_KIND,
  connectionEvictorCredsKey, cotalDir, DELIVERY_CREDS_KIND, deliveryCredsKey, MEMBERSHIP_CONFIG_KIND,
  membershipConfigPath, MEMBERSHIP_OBSERVER_CREDS_KIND, membershipObserverCredsKey, MEMBERSHIP_RW_CREDS_KIND,
  membershipRwCredsKey, migrateLegacyCotalMaterial, P7_LEGACY_MATERIAL, reapSpaceMaterial,
  RESERVED_COTAL_CHILDREN, segmentedKey, spaceMaterialDir, spaceMaterialKey, type SpaceMaterialComposition,
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
  // The nearest misses are real names, not hypotheticals: they share the `<prefix>.<spaceKey>.<suffix>`
  // shape. The five runtime records joined that shape when the pid/log namespace became per-space, so
  // they are expanded through the SHIPPED helper here rather than restated as literals.
  const nearMisses = [
    `auth-service.${Buffer.from("alpha", "utf8").toString("hex")}.pid`,
    ...[MANAGER_PIDFILE, MANAGER_LOGFILE, MANAGER_DELIVERY_AWARE_MARKER, DELIVERY_PIDFILE, DELIVERY_LOGFILE]
      .map((template) => basename(canonicalLocalProcessPath(template, { root: join(tmpdir(), "unused"), space: "alpha" }))),
  ];
  for (const name of nearMisses)
    check(`"${name}" is not a canonical segment`, spaceFromSegment(name) === undefined && !name.startsWith("space."), name);
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

  // --- 6) `space rm` STEP 7's REAP, and the step-1 precondition that guards it ------------------
  //
  // The reap is the second half of what §5 started: `clean` resets a whole root, this removes ONE
  // tenant from a root the others keep using. Everything below turns on WHERE in §2.2 each half
  // runs. Step 5 deletes the tenant's streams and buckets and cannot be undone; step 7 is the local
  // cleanup after it. So the refusable question is asked at step 1, and the reap itself cannot
  // refuse — a throw at step 7 strands the journal entry, and since the same throw recurs on every
  // re-run, the removal a crash is supposed to be able to finish could never finish at all.
  console.log("\n6) `space rm` step 7: the reap, and the step-1 precondition");

  const reapKinds = [DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND,
    MEMBERSHIP_OBSERVER_CREDS_KIND, CONNECTION_EVICTOR_CREDS_KIND];
  /** A `SecretStore` in memory, so the SEAM's behaviour is asserted rather than the FS adapter's —
   *  including the failure the reap must RETURN instead of throwing, which a real store will not
   *  produce on demand. */
  function memStore(seed: Record<string, string>, failOn?: string) {
    const m = new Map(Object.entries(seed));
    return {
      store: {
        get: async (k: string) => m.get(k),
        put: async (k: string, v: string) => void m.set(k, v),
        delete: async (k: string) => {
          if (k === failOn) throw new Error("seam is down");
          m.delete(k);
        },
      } satisfies SecretStore,
      keys: () => [...m.keys()].sort(),
    };
  }
  /** One tenant's segment, staged POST-P7 as this suite's staging rule requires. */
  function stageSegment(root: string, space: string): void {
    mkdirSync(spaceMaterialDir(root, space), { recursive: true });
    for (const k of [...reapKinds, MEMBERSHIP_CONFIG_KIND])
      writeFileSync(join(spaceMaterialDir(root, space), k), `${space}-${k}`);
  }
  const seeded = (space: string) => Object.fromEntries(reapKinds.map((k) => [segmentedKey(k, space), `${space}-${k}`]));
  /**
   * "Cannot throw" is the reap's headline contract, so the cells that assert it must survive a build
   * that breaks it. An unguarded `await` on a throwing mutant aborts the run AFTER the cells that
   * caught it went red but BEFORE the completion banner, which grades a real kill INCONCLUSIVE —
   * the same trap the resolver loop's `existsSync` closes, reached from the other side. The sentinel
   * deliberately carries neither the key nor the segment, so every cell downstream reads red.
   */
  const noThrow = async (fn: () => Promise<{ removed: string[]; failed: string[] }>) => {
    try { return await fn(); } catch (e) { return { removed: [], failed: [`THREW: ${(e as Error).message}`] }; }
  };

  // THE PRECONDITION refuses on the root where the reap has no right answer: root-scoped material on
  // a root with more than one tenant is unattributable, so reaping AROUND it strands what may be the
  // departing tenant's live pair, and reaping IT may take a survivor's. There is no third answer,
  // and this is asked while refusing is still free.
  const reapBlocked = await makeRoot("reap-blocked", ["alpha", "beta"]);
  roots.push(reapBlocked);
  stageSegment(reapBlocked, "alpha");
  writeFileSync(join(cotalDir(reapBlocked), DELIVERY_CREDS_KIND), "ROOT-SCOPED");
  rejects("the precondition refuses to reap around root-scoped material",
    () => assertSpaceMaterialReapable(reapBlocked, "alpha", "`cotal space rm`"),
    ["still holds root-scoped", DELIVERY_CREDS_KIND, "strand", "nothing on disk records which"]);
  // ...and its remedy is COMPOSED from rule 4's answer, not assumed. `cotal up` is the migration an
  // operator would be told to run, and on THIS root it refuses — the population §2.1 says bypasses
  // both doors. Advice that cannot succeed is the exact defect commit 2 removed from `repairAdvice`.
  rejects("...naming a remedy that exists on THIS root, not the one that refuses here",
    () => assertSpaceMaterialReapable(reapBlocked, "alpha", "`cotal space rm`"),
    ["not available on this root either", "this root holds 2 spaces (alpha, beta)"],
    ["Run `cotal up` for the sole tenant once"]);
  // The `space add` door carried the SAME latent defect and is fixed by the same ask. Both doors
  // weigh the same unmigrated set, so they must agree about it — and about what to do next.
  rejects("the `space add` door's remedy is honest on that root too",
    () => assertNoUnsegmentedLegacyMaterial(reapBlocked, "`cotal space add`"),
    ["not available on this root either"], ["Run `cotal up` for the sole tenant once"]);
  // POSITIVE CONTROL for that fix: on the single-tenant root the door usually sees, `cotal up` IS
  // the remedy and must still be offered. A "fix" that dropped the sentence everywhere would pass
  // every cell above while making the common refusal useless. (§4's door cell asserts it too.)
  const reapSolo = await makeRoot("reap-solo", ["one"]);
  roots.push(reapSolo);
  writeFileSync(join(cotalDir(reapSolo), MEMBERSHIP_RW_CREDS_KIND), "ROOT-SCOPED");
  rejects("CONTROL: ...and still says `cotal up` where `cotal up` actually works",
    () => assertNoUnsegmentedLegacyMaterial(reapSolo, "`cotal space add`"),
    ["Run `cotal up` for the sole tenant once"], ["not available on this root either"]);

  // THE REAP itself, on the only root shape `space rm` ever runs on: multi-tenant (§2.2 step 2
  // refuses the last tenant) and fully migrated (the precondition above).
  const reaped = await makeRoot("reaped", ["alpha", "beta"]);
  roots.push(reaped);
  stageSegment(reaped, "alpha");
  stageSegment(reaped, "beta");
  check("CONTROL: the precondition passes once nothing is root-scoped",
    ((): boolean => { try { assertSpaceMaterialReapable(reaped, "alpha", "op"); return true; } catch { return false; } })());
  const reapStore = memStore({ ...seeded("alpha"), ...seeded("beta") });
  const first = await noThrow(() => reapSpaceMaterial(reaped, "alpha", reapStore.store));
  check("the reap removes this space's segment", !existsSync(spaceMaterialDir(reaped, "alpha")));
  // A reap spelled `.cotal/space.*` is the shape a reader reaches for after seeing a directory
  // removal, and on the multi-tenant root this verb runs on it takes every survivor's live material
  // and reports success. The neighbour is the only cell that catches it — which is exactly why the
  // read is guarded: a build that takes the neighbour's segment leaves nothing here to read, and an
  // ENOENT would abort the run before the banner and grade its own catch INCONCLUSIVE. `noThrow`
  // covers the calls; a cell that READS state a wrong build deletes needs the same care.
  const neighbour = join(spaceMaterialDir(reaped, "beta"), DELIVERY_CREDS_KIND);
  check("...and leaves the neighbour tenant's segment untouched",
    existsSync(neighbour) && readFileSync(neighbour, "utf8") === `beta-${DELIVERY_CREDS_KIND}`, neighbour);
  // It sweeps EVERY store-backed kind, not just the two `clean` names. `clean` has a raw sweep of
  // `.cotal/` behind it; this does not, and for an INJECTED store the segment removal reaches
  // nothing at all — so a kind missing from the seam loop outlives its tenant with no second net.
  check("...deletes all four store-backed kinds at their SEGMENTED keys",
    reapStore.keys().join(",") === Object.keys(seeded("beta")).sort().join(","), reapStore.keys().join(","));
  check("...and reports each removal by the key it removed",
    reapKinds.every((k) => first.removed.includes(`.cotal/${segmentedKey(k, "alpha")}`)) && first.failed.length === 0,
    { removed: first.removed, failed: first.failed });
  // §2.2 needs steps 5-7 individually idempotent so a re-run after a crash FINISHES the removal.
  const second = await noThrow(() => reapSpaceMaterial(reaped, "alpha", reapStore.store));
  check("the reap is idempotent: a re-run removes nothing and does not throw",
    second.removed.length === 0 && second.failed.length === 0, second);

  // A REAPER IS A DELETER, so it addresses `segmentedKey` and never a resolver. Staged here as a
  // rule 3 tear — legacy and canonical both present — which is exactly what a resolver refuses. A
  // reap built on one would throw past the point of no return over material it does not even want.
  const reapTorn = await makeRoot("reap-torn", ["one"]);
  roots.push(reapTorn);
  stageSegment(reapTorn, "one");
  writeFileSync(join(cotalDir(reapTorn), DELIVERY_CREDS_KIND), "LEGACY");
  const tornStore = memStore(seeded("one"));
  const torn2 = await noThrow(() => reapSpaceMaterial(reapTorn, "one", tornStore.store));
  check("the reap does not migrate: a rule 3 tear neither throws nor moves",
    torn2.failed.length === 0 && existsSync(join(cotalDir(reapTorn), DELIVERY_CREDS_KIND)) &&
    readFileSync(join(cotalDir(reapTorn), DELIVERY_CREDS_KIND), "utf8") === "LEGACY", torn2);

  // PAST THE POINT OF NO RETURN A FAILURE IS DATA. A throw here strands the journal entry that gates
  // every other verb on the root; returning it lets step 7 finish what it can and lets the re-run
  // finish the rest. Same posture, and the same reason, as `remintDaemonCreds`.
  const reapFail = await makeRoot("reap-fail", ["alpha", "beta"]);
  roots.push(reapFail);
  stageSegment(reapFail, "alpha");
  const failing = memStore(seeded("alpha"), segmentedKey(MEMBERSHIP_OBSERVER_CREDS_KIND, "alpha"));
  const partial = await noThrow(() => reapSpaceMaterial(reapFail, "alpha", failing.store));
  check("a seam failure is RETURNED, not thrown",
    partial.failed.length === 1 && partial.failed[0]?.includes(MEMBERSHIP_OBSERVER_CREDS_KIND) === true, partial.failed);
  check("...and the rest of the reap still runs — the other kinds AND the segment dir",
    reapKinds.filter((k) => k !== MEMBERSHIP_OBSERVER_CREDS_KIND)
      .every((k) => partial.removed.includes(`.cotal/${segmentedKey(k, "alpha")}`)) &&
    partial.removed.some((r) => r.startsWith(`.cotal/${spaceSegment("alpha")} `)) &&
    !existsSync(spaceMaterialDir(reapFail, "alpha")), partial.removed);

  // The banner is printed on BOTH outcomes and names the suite, which is what lets the mutation
  // config declare it as a completion marker: a mutant run that stops early is then INCONCLUSIVE
  // rather than counted as a kill. A success-only banner would discard exactly the real kills.
  console.log(`\nSPACE-SEGMENTATION GATE ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);

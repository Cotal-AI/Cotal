/**
 * The per-agent standing secrets' segmentation gate — series P1 of
 * `docs/design/space-segmentation-p7-p1.md` (§1's second inventory, §3's second placement, §4).
 * Hermetic — no broker, no network. The foundation's own rules are proved next door in
 * space-segmentation.smoke.ts; this asserts what P1 adds on top of it.
 *
 * Four guarantees:
 *
 *  1. THE MOVE HAPPENS AT THE CHOKE POINT, PER FILE, AND TAKES THE WHOLE FAMILY. P1's kind set is
 *     OPEN (one file per agent per kind), so rule 2's "one `renameSync`" is per FILE here. The
 *     non-secret `<base>.auth-health.json` moves with its three secrets even though it is never a
 *     store key: the manager weighs actor-token + sentinel + health as ONE owned family and refuses
 *     a mixed one, so a migration that left the health file flat would break a resume it was
 *     supposed to preserve. Every key and path builder resolves through the choke point, which is
 *     what makes "first touch" mean every flow rather than the ones someone remembered.
 *
 *  2. A SEGMENT IS NOT MATERIAL. A co-resident tenant's segment can never be swept into another
 *     tenant's — the aliasing the layout exists to prevent — and neither can a stray no valid
 *     provisioning wrote, nor a DIRECTORY that merely happens to be named like material. Those are
 *     three different exclusions in the enumeration and each is graded on its own.
 *
 *  3. A RECORDED PATH MAY NOT CHOOSE A TENANT. `agentSecretKeyForFile` takes the space from the
 *     CALLER's authority and checks the path against it. Reading the segment out of the path would
 *     have compiled, changed no call site, and let a record written for tenant A hand back a key
 *     into tenant B's material — which the manager then reads, overwrites, or DELETES. This is the
 *     one signature change in the commit that is not bookkeeping, so it is graded by execution.
 *
 *  4. THE SWEEP REPORTS BOTH LEVELS. `agentSecretKeysUnder` is a DELETER (§3.1): root-wide,
 *     migration-free, and reporting the segmented keys of EVERY tenant plus any pre-P1 file still
 *     flat in the creds dir. Dropping the flat level would reintroduce this series' own defect
 *     inside the sweeper — a `clean all` that leaves an unmigrated root's agent creds on disk and
 *     reports success.
 *
 * Run: pnpm smoke:agent-secret-segmentation
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerAuth, createSpaceAccountAuth } from "@cotal-ai/core";
import { authDir, saveBrokerAuth, saveSpaceAccountAuth, spaceSegment } from "../src/auth-paths.js";
import {
  agentCredsDir, agentCredsKey, agentCredsRoot, agentLifecycleSecretFilePaths, agentSecretFilePaths,
  agentSecretKeyForFile, agentSecretKeysUnder,
} from "../src/agent-secrets.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
/** Read a file that an assertion expects to EXIST, without throwing when it does not. Every
 *  surviving-state assertion below goes through this: a broken implementation is exactly the run in
 *  which the file is missing, and an ENOENT out of the assertion itself aborts the suite before its
 *  completion marker — which grades a real red as INCONCLUSIVE and discards the kill. */
const readIf = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
};
const rejects = (name: string, fn: () => unknown, mustInclude: string[]) => {
  try {
    fn();
    check(`${name} (did not throw)`, false);
  } catch (e) {
    const msg = (e as Error).message;
    const missing = mustInclude.filter((s) => !msg.includes(s));
    check(name, missing.length === 0, { missing, msg });
  }
};

/** A root under ONE broker trust chain holding an account per named space — the same staging the
 *  foundation gate uses, because rule 4 counts THESE records. */
async function makeRoot(label: string, spaces: string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `cotal-agsec-${label}-`));
  const broker = await createBrokerAuth(label);
  saveBrokerAuth(authDir(root), broker);
  for (const space of spaces) saveSpaceAccountAuth(authDir(root), await createSpaceAccountAuth(broker, space));
  return root;
}

/** Write files DIRECTLY into `<root>/.cotal/auth/creds` — the pre-P1 layout, staged the way a root
 *  that predates this series actually holds it. */
function stageFlat(root: string, files: Record<string, string>): void {
  const parent = agentCredsRoot(root);
  mkdirSync(parent, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(parent, name), body);
}

const roots: string[] = [];
try {
  console.log("1) first touch moves the whole family, per file, into the space's segment");
  const solo = await makeRoot("solo", ["solo"]);
  roots.push(solo);
  const UID = "01hzzzzzzzzzzzzzzzzzzzzzzz";
  stageFlat(solo, {
    "worker.creds": "WORKER-CREDS",
    "worker.actor-token": "WORKER-TOKEN",
    "worker.sentinel.creds": "WORKER-SENTINEL",
    "worker.auth-health.json": '{"state":"healthy"}',
    [`worker.${UID}.creds`]: "INCARNATION-CREDS",
  });
  const flat = agentCredsRoot(solo);
  const dir = agentCredsDir(solo, "solo");
  check("the choke point answers with the segmented dir", dir === join(flat, spaceSegment("solo")), dir);
  const files = agentSecretFilePaths(solo, "solo", "worker");
  check("all three secret kinds MOVED (canonical present, flat gone)",
    ["worker.creds", "worker.actor-token", "worker.sentinel.creds"].every((f) => existsSync(join(dir, f)) && !existsSync(join(flat, f))));
  check("the bytes survived the move", readIf(files.creds) === "WORKER-CREDS" && readIf(files.sentinelCreds) === "WORKER-SENTINEL");
  check("the non-secret HEALTH file moved WITH the family (the manager weighs all four as one)",
    existsSync(files.health) && !existsSync(join(flat, "worker.auth-health.json")));
  check("the lifecycle-keyed incarnation file moved too (the base grammar, not a fixed kind list)",
    existsSync(agentLifecycleSecretFilePaths(solo, "solo", "worker", UID).creds) && !existsSync(join(flat, `worker.${UID}.creds`)));
  check("a second touch is a no-op returning the same dir", agentCredsDir(solo, "solo") === dir);

  // The key builders resolve through the same choke point on the FS composition — a builder that
  // composed the prefix itself would return the right STRING past unmoved material.
  const late = await makeRoot("late", ["late"]);
  roots.push(late);
  stageFlat(late, { "scout.creds": "SCOUT-CREDS" });
  const lateKey = agentCredsKey("late", "scout", { injected: false, root: late });
  // The expected dir is composed here rather than asked of `agentCredsDir`: asking would MIGRATE, so
  // the cell would pass on the strength of its own assertion and grade a key builder that resolved
  // nothing as if it had.
  const lateSeg = join(agentCredsRoot(late), spaceSegment("late"));
  check("a key builder on the FS arm MOVED the legacy copy on first touch",
    existsSync(join(lateSeg, "scout.creds")) && !existsSync(join(agentCredsRoot(late), "scout.creds")));
  check("...and the key names the segment", lateKey === `auth/creds/${spaceSegment("late")}/scout.creds`, lateKey);

  // The hosted arm has no root to migrate on and must answer with the SAME key: a host provisions
  // from this string, so a flat answer here writes where no agent reads.
  const hosted = await makeRoot("hosted", ["hosted"]);
  roots.push(hosted);
  stageFlat(hosted, { "scout.creds": "SCOUT-CREDS" });
  check("the hosted arm resolves the SAME key shape",
    agentCredsKey("hosted", "scout", { injected: true }) === `auth/creds/${spaceSegment("hosted")}/scout.creds`);
  check("...and migrates NOTHING", existsSync(join(agentCredsRoot(hosted), "scout.creds")));

  console.log("\n2) a segment is not material, and neither is a stray");
  const twoSeg = await makeRoot("twoseg", ["alpha"]);
  roots.push(twoSeg);
  stageFlat(twoSeg, { "weird name.creds": "STRAY", "notes.txt": "STRAY" });
  // A sibling tenant's segment, populated, sitting in the parent the migration enumerates.
  const betaSeg = join(agentCredsRoot(twoSeg), spaceSegment("beta"));
  mkdirSync(betaSeg, { recursive: true });
  writeFileSync(join(betaSeg, "peer.creds"), "BETA-CREDS");
  // A DIRECTORY whose NAME ends in a migratable suffix. This is the case the `isDirectory` guard is
  // actually alone in catching: a sibling's `space.<hex>` is already excluded by the suffix filter,
  // but `ghost.creds` passes that filter, and without the guard `renameSync` is handed a whole TREE
  // to relocate under a tenant's segment.
  const ghost = join(agentCredsRoot(twoSeg), "ghost.creds");
  mkdirSync(ghost, { recursive: true });
  writeFileSync(join(ghost, "inside"), "GHOST");
  agentCredsDir(twoSeg, "alpha");
  check("the neighbour tenant's segment was NOT swept into alpha's",
    readIf(join(betaSeg, "peer.creds")) === "BETA-CREDS" && !existsSync(join(agentCredsRoot(twoSeg), spaceSegment("alpha"), spaceSegment("beta"))));
  check("a DIRECTORY named like material is not material either, so the tree stays where it is",
    readIf(join(ghost, "inside")) === "GHOST" && !existsSync(join(agentCredsRoot(twoSeg), spaceSegment("alpha"), "ghost.creds")));
  check("a name no valid provisioning could have written is left alone",
    existsSync(join(agentCredsRoot(twoSeg), "weird name.creds")) && existsSync(join(agentCredsRoot(twoSeg), "notes.txt")));

  console.log("\n3) rules 3 and 4 arrive through the shared choke point, at P1's placement");
  const multi = await makeRoot("multi", ["alpha", "beta"]);
  roots.push(multi);
  stageFlat(multi, { "worker.creds": "AMBIGUOUS" });
  rejects(
    "migration REFUSES on a two-tenant root (rule 4, the same wording as P7's)",
    () => agentCredsDir(multi, "alpha"),
    ["this root holds 2 spaces", "alpha", "beta", "assert an owner that may be wrong"],
  );
  check("the legacy file is left exactly where it was", existsSync(join(agentCredsRoot(multi), "worker.creds")));
  rejects("...and the refusal travels OUT through the key builder too, unswallowed",
    () => agentCredsKey("alpha", "worker", { injected: false, root: multi }), ["this root holds 2 spaces"]);

  const torn = await makeRoot("torn", ["torn"]);
  roots.push(torn);
  stageFlat(torn, { "worker.creds": "LEGACY" });
  mkdirSync(join(agentCredsRoot(torn), spaceSegment("torn")), { recursive: true });
  writeFileSync(join(agentCredsRoot(torn), spaceSegment("torn"), "worker.creds"), "CANONICAL");
  rejects(
    "both copies of ONE file present REFUSES rather than guessing which is current (rule 3)",
    () => agentCredsDir(torn, "torn"),
    ["refusing to guess which is current"],
  );
  check("neither copy was touched by the refusal",
    readIf(join(agentCredsRoot(torn), "worker.creds")) === "LEGACY" &&
    readIf(join(agentCredsRoot(torn), spaceSegment("torn"), "worker.creds")) === "CANONICAL");

  console.log("\n4) a recorded path may not choose which tenant's material is addressed");
  const own = agentSecretFilePaths(solo, "solo", "worker");
  check("CONTROL: a path in the caller's OWN segment resolves to its key",
    agentSecretKeyForFile(own.creds, "solo") === `auth/creds/${spaceSegment("solo")}/worker.creds`);
  const foreign = join(agentCredsRoot(solo), spaceSegment("neighbour"), "worker.creds");
  rejects(
    "a path in ANOTHER tenant's segment is refused, and the refusal names that tenant",
    () => agentSecretKeyForFile(foreign, "solo"),
    ['is not in space "solo"', spaceSegment("solo"), 'it names space "neighbour"', "may not choose which tenant"],
  );
  rejects(
    "a pre-P1 FLAT path is refused too — it carries no tenant claim at all",
    () => agentSecretKeyForFile(join(agentCredsRoot(solo), "worker.creds"), "solo"),
    ["not a per-space segment at all"],
  );
  rejects("a non-secret filename is still refused on its filename first",
    () => agentSecretKeyForFile(own.health, "solo"), ["is not an agent-secret filename"]);
  rejects("a secret suffix on an unprovisionable base is still refused",
    () => agentSecretKeyForFile(join(agentCredsDir(solo, "solo"), "weird name.creds"), "solo"), ["not a provisionable agent-secret filename"]);

  console.log("\n5) the sweep is root-wide, migration-free, and reports BOTH levels");
  const sweep = await makeRoot("sweep", ["alpha", "beta"]);
  roots.push(sweep);
  // Two tenants already segmented, one file still flat (an unmigrated root a reset must not strand),
  // plus the two things that are NOT keys: a health file and a stray subdirectory.
  for (const [space, name] of [["alpha", "a-worker"], ["beta", "b-worker"]] as const) {
    const seg = join(agentCredsRoot(sweep), spaceSegment(space));
    mkdirSync(seg, { recursive: true });
    writeFileSync(join(seg, `${name}.creds`), "C");
    writeFileSync(join(seg, `${name}.sentinel.creds`), "S");
    writeFileSync(join(seg, `${name}.auth-health.json`), "{}");
  }
  stageFlat(sweep, { "legacy-worker.creds": "OLD", "legacy-worker.auth-health.json": "{}" });
  mkdirSync(join(agentCredsRoot(sweep), "not-a-segment"), { recursive: true });
  writeFileSync(join(agentCredsRoot(sweep), "not-a-segment", "impostor.creds"), "X");
  const keys = agentSecretKeysUnder(sweep).sort();
  check("BOTH tenants' segmented keys are reported",
    keys.includes(`auth/creds/${spaceSegment("alpha")}/a-worker.creds`) &&
    keys.includes(`auth/creds/${spaceSegment("alpha")}/a-worker.sentinel.creds`) &&
    keys.includes(`auth/creds/${spaceSegment("beta")}/b-worker.creds`), keys);
  check("the pre-P1 FLAT key is reported too (a reset must not strand an unmigrated root)",
    keys.includes("auth/creds/legacy-worker.creds"), keys);
  check("health files are not keys, and a stray subdirectory is not descended into",
    keys.length === 5 && !keys.some((k) => k.includes("auth-health") || k.includes("not-a-segment")), keys);
  check("the sweep MIGRATED NOTHING — the flat file is still flat",
    existsSync(join(agentCredsRoot(sweep), "legacy-worker.creds")));
  check("a root with no creds dir sweeps empty", agentSecretKeysUnder(mkdtempSync(join(tmpdir(), "cotal-agsec-empty-"))).length === 0);

  // The banner is printed on BOTH outcomes and names the suite, which is what lets the mutation
  // config declare it as a completion marker: a mutant run that stops early is then INCONCLUSIVE
  // rather than counted as a kill. A success-only banner would discard exactly the real kills.
  console.log(`\nAGENT-SECRET SEGMENTATION GATE ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);

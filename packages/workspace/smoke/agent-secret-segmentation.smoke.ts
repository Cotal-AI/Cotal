/**
 * The per-agent standing secrets' segmentation gate — series P1 of
 * `docs/design/space-segmentation-p7-p1.md` (§1's second inventory, §3's second placement, §4).
 * Hermetic — no broker, no network. The foundation's own rules are proved next door in
 * space-segmentation.smoke.ts; this asserts what P1 adds on top of it.
 *
 * Five guarantees:
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
 *  5. ONE TENANT'S SECRETS CAN BE REAPED, AND ONLY ONE TENANT'S. `space rm` step 7 removes what a
 *     departing tenant owned without touching a survivor's, cannot refuse (it runs past the point of
 *     no return), and never migrates — a reap that resolved through the choke point would move a
 *     pre-P1 flat file INTO the segment it is about to delete and destroy it. Its precondition is
 *     asked at step 1, where refusing is free, and it refuses over exactly that flat material: the
 *     removal itself is what would later make an unowned file look owned.
 *
 * Run: pnpm smoke:agent-secret-segmentation
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerAuth, createSpaceAccountAuth, type SecretStore } from "@cotal-ai/core";
import { authDir, saveBrokerAuth, saveSpaceAccountAuth, spaceSegment } from "../src/auth-paths.js";
import {
  agentCredsDir, agentCredsKey, agentCredsRoot, agentLifecycleSecretFilePaths, agentSecretFilePaths,
  agentSecretKeyForFile, agentSecretKeysForSpace, agentSecretKeysUnder, assertAgentSecretsReapable,
  reapAgentSecrets, unsegmentedAgentSecrets,
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
const rejects = (name: string, fn: () => unknown, mustInclude: string[], mustExclude: string[] = []) => {
  try {
    fn();
    check(`${name} (did not throw)`, false);
  } catch (e) {
    const msg = (e as Error).message;
    const missing = mustInclude.filter((s) => !msg.includes(s));
    const present = mustExclude.filter((s) => msg.includes(s));
    check(name, missing.length === 0 && present.length === 0, { missing, present, msg });
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

  console.log("\n6) `space rm` reaps ONE tenant's agent secrets (step 7), and refuses at step 1 where refusing is free");
  /** One tenant's segment staged POST-P1, with the family the manager owns. Returns the three
   *  SECRET keys — the health file is written too and is deliberately not among them. */
  function stageAgentSegment(root: string, space: string, name: string) {
    const seg = join(agentCredsRoot(root), spaceSegment(space));
    mkdirSync(seg, { recursive: true });
    for (const [suffix, body] of [[".creds", "creds"], [".actor-token", "token"], [".sentinel.creds", "sentinel"]])
      writeFileSync(join(seg, `${name}${suffix}`), `${space}-${name}-${body}`);
    writeFileSync(join(seg, `${name}.auth-health.json`), "{}");
    const key = (suffix: string) => `auth/creds/${spaceSegment(space)}/${name}${suffix}`;
    return { dir: seg, creds: key(".creds"), actorToken: key(".actor-token"), sentinelCreds: key(".sentinel.creds") };
  }
  const seedFrom = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, `stored:${k}`]));
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
  /** "Cannot throw" is the reap's headline contract, so the cells asserting it must survive a build
   *  that breaks it: an unguarded `await` on a throwing mutant aborts the run after its cells went
   *  red but BEFORE the banner, which grades a real kill INCONCLUSIVE. The sentinel carries neither
   *  a key nor the enumerator's wording, so every cell downstream reads red. */
  const noThrow = async (fn: () => Promise<{ removed: string[]; failed: string[] }>) => {
    try { return await fn(); } catch (e) { return { removed: [], failed: [`THREW: ${(e as Error).message}`] }; }
  };

  // THE PRECONDITION, on the root where the reap has no right answer: files sitting flat in the
  // creds dir name no tenant, so reaping around them strands what may be the departing tenant's and
  // reaping them may take a survivor's.
  const reapBlocked = await makeRoot("reap-blocked", ["alpha", "beta"]);
  roots.push(reapBlocked);
  stageAgentSegment(reapBlocked, "alpha", "a-worker");
  stageFlat(reapBlocked, { "orphan.creds": "UNOWNED", "orphan.auth-health.json": "{}" });
  rejects("the reap precondition refuses while pre-P1 files sit flat in the creds dir",
    () => assertAgentSecretsReapable(reapBlocked, "alpha", "`cotal space rm`"),
    ["2 pre-P1 agent secret file(s) directly in auth/creds", "orphan.creds", "which name no space"]);
  // P1's refusal is SHARPER than P7's, and the message has to carry the reason or an operator reads
  // it as mere residue. Those files are inert only because rule 4 refuses on a multi-tenant root;
  // step 7 deletes the departing tenant's account record, and on a two-tenant root that leaves the
  // single-tenant condition under which rule 4 stops refusing — so the survivor's next spawn, mint
  // or `doctor auth` MOVES them into the survivor's segment. The removal is what arms it.
  rejects("...naming the mechanism that makes the mis-attribution automatic, not just the residue",
    () => assertAgentSecretsReapable(reapBlocked, "alpha", "`cotal space rm`"),
    ["the removal leaves one space in the inventory", "records an owner nobody chose"]);
  // The remedy is ASKED of rule 4 rather than assumed, the `repairAdvice` lesson: on THIS root no
  // migration is available at all, so offering one would be advice that cannot succeed.
  rejects("...and offers no migration on the root that refuses one, only the manual move",
    () => assertAgentSecretsReapable(reapBlocked, "alpha", "`cotal space rm`"),
    ["not available on this root either", "this root holds 2 spaces (alpha, beta)", "move it into that tenant's segment"],
    ["cotal doctor auth"]);
  // POSITIVE CONTROL, and the one cell that grades WHICH verb is named. P7's remedy says `cotal up`;
  // `up` never touches a P1 resolver (the call sites are spawn, mint, doctor auth, the manager and
  // the manifest ledger), so reusing that sentence here would hand an operator a command that leaves
  // these files exactly where they are. `doctor auth` is named because it migrates without minting.
  const reapSolo = await makeRoot("reap-solo", ["one"]);
  roots.push(reapSolo);
  stageFlat(reapSolo, { "orphan.creds": "UNOWNED" });
  rejects("CONTROL: on a single-tenant root the remedy names the verb that actually moves this material",
    () => assertAgentSecretsReapable(reapSolo, "one", "`cotal space rm`"),
    ["Run `cotal doctor auth` for the sole tenant once"], ["cotal up", "not available on this root either"]);
  check("the door weighs the MIGRATABLE set - health file included, a tenant's segment excluded",
    unsegmentedAgentSecrets(reapBlocked).slice().sort().join(",") === "orphan.auth-health.json,orphan.creds",
    unsegmentedAgentSecrets(reapBlocked));
  // The per-space enumerator is the root-wide sweep MINUS the flat level, and that subtraction is the
  // whole difference: `clean all` must name a flat file or strand it, a per-space reap must not,
  // because attributing an unowned file to the tenant being removed is a guess acted on.
  const blockedKeys = agentSecretKeysForSpace(reapBlocked, "alpha");
  check("the per-space enumerator reports only this tenant's segment, never the flat level",
    blockedKeys.length === 3 && blockedKeys.every((k) => k.startsWith(`auth/creds/${spaceSegment("alpha")}/`)), blockedKeys);

  // THE REAP, on the only root shape `space rm` runs on: multi-tenant (§2.2 step 2 refuses the last
  // tenant) and fully migrated (the precondition above).
  const reaped = await makeRoot("reaped", ["alpha", "beta"]);
  roots.push(reaped);
  const alpha = stageAgentSegment(reaped, "alpha", "a-worker");
  const beta = stageAgentSegment(reaped, "beta", "b-worker");
  const alphaKeys = [alpha.creds, alpha.actorToken, alpha.sentinelCreds];
  const betaKeys = [beta.creds, beta.actorToken, beta.sentinelCreds];
  check("CONTROL: the precondition passes once nothing is flat",
    ((): boolean => { try { assertAgentSecretsReapable(reaped, "alpha", "op"); return true; } catch { return false; } })());
  const reapStore = memStore(seedFrom([...alphaKeys, ...betaKeys]));
  const first = await noThrow(() => reapAgentSecrets(reaped, "alpha", reapStore.store));
  check("the reap removes this tenant's whole segment, health file and all", !existsSync(alpha.dir));
  // The parent `auth/creds` is SHARED — every tenant's segment is a child of it — so a reap that
  // reached for the parent, or spelled the segment as a glob, would take every survivor's live
  // material and report success. The reads are guarded because a build that does exactly that leaves
  // nothing here to read, and an ENOENT out of the assertion would abort before the banner.
  check("the neighbour tenant's agent secrets are untouched",
    readIf(join(beta.dir, "b-worker.creds")) === "beta-b-worker-creds" && existsSync(agentCredsRoot(reaped)));
  check("...and only this tenant's keys left the store",
    reapStore.keys().join(",") === betaKeys.slice().sort().join(","), reapStore.keys());
  check("...each removal is reported by the key it removed, and nothing failed",
    alphaKeys.every((k) => first.removed.includes(`.cotal/${k}`)) &&
    first.removed.some((r) => r.startsWith(`.cotal/auth/creds/${spaceSegment("alpha")} `)) &&
    first.failed.length === 0, first);
  // §2.2 needs steps 5-7 individually idempotent so a re-run after a crash FINISHES the removal.
  const second = await noThrow(() => reapAgentSecrets(reaped, "alpha", reapStore.store));
  check("the reap is idempotent: a re-run removes nothing and does not throw",
    second.removed.length === 0 && second.failed.length === 0, second);

  // A REAPER IS A DELETER (§3.1), so it addresses the on-disk segment and never the choke point.
  // Here that is worse than the tidiness argument P7 makes: `agentCredsDir` would MOVE the flat file
  // into the very segment the next line removes, so a reap built on it destroys material the
  // precondition exists to protect - and on a single-tenant root nothing refuses the move first.
  const reapTorn = await makeRoot("reap-torn", ["one"]);
  roots.push(reapTorn);
  const tornSeg = stageAgentSegment(reapTorn, "one", "worker");
  stageFlat(reapTorn, { "orphan.creds": "UNOWNED" });
  const tornStore = memStore(seedFrom([tornSeg.creds, tornSeg.actorToken, tornSeg.sentinelCreds]));
  const tornResult = await noThrow(() => reapAgentSecrets(reapTorn, "one", tornStore.store));
  check("a pre-P1 flat file is still flat after the reap",
    readIf(join(agentCredsRoot(reapTorn), "orphan.creds")) === "UNOWNED" && tornResult.failed.length === 0, tornResult);

  // THE ENUMERATION IS AN I/O STEP P7's REAP DOES NOT HAVE. P7 sweeps a fixed array of four kinds;
  // P1's key set is open and read off the disk, so there is a `readdirSync` BEFORE the first seam
  // call, and an unguarded one throws straight out of a function that has promised not to. Staged as
  // a FILE where the segment belongs, which fails with ENOTDIR rather than the ENOENT the empty case
  // already returns.
  const reapUnreadable = await makeRoot("reap-unreadable", ["alpha", "beta"]);
  roots.push(reapUnreadable);
  mkdirSync(agentCredsRoot(reapUnreadable), { recursive: true });
  writeFileSync(join(agentCredsRoot(reapUnreadable), spaceSegment("alpha")), "NOT-A-DIR");
  const unreadable = await noThrow(() => reapAgentSecrets(reapUnreadable, "alpha", memStore({}).store));
  check("an unreadable segment is REPORTED, not thrown past the point of no return",
    unreadable.failed.length === 1 && unreadable.failed[0]?.includes("enumerating this space's agent secrets") === true,
    unreadable);

  // PAST THE POINT OF NO RETURN A FAILURE IS DATA. A throw here strands the journal entry that gates
  // every other verb on the root, and recurs identically on the re-run §2.2 relies on to finish the
  // removal. Same posture, and the same reason, as `reapSpaceMaterial` and `remintDaemonCreds`.
  const reapFail = await makeRoot("reap-fail", ["alpha", "beta"]);
  roots.push(reapFail);
  const failSeg = stageAgentSegment(reapFail, "alpha", "a-worker");
  const failing = memStore(seedFrom([failSeg.creds, failSeg.actorToken, failSeg.sentinelCreds]), failSeg.actorToken);
  const partial = await noThrow(() => reapAgentSecrets(reapFail, "alpha", failing.store));
  check("a seam failure is RETURNED, not thrown",
    partial.failed.length === 1 && partial.failed[0]?.startsWith(`${failSeg.actorToken}: `) === true, partial.failed);
  check("...and the rest of the reap still runs - the other keys AND the segment dir",
    partial.removed.length === 3 && !existsSync(failSeg.dir), partial.removed);

  // The banner is printed on BOTH outcomes and names the suite, which is what lets the mutation
  // config declare it as a completion marker: a mutant run that stops early is then INCONCLUSIVE
  // rather than counted as a kill. A success-only banner would discard exactly the real kills.
  console.log(`\nAGENT-SECRET SEGMENTATION GATE ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);

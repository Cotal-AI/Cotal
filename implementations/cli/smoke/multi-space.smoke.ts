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
 *
 *  5. EVERY TENANT-KEYED NAMESPACE SHARES THE ONE INJECTIVE KEY (`space.<hex>` / `account.<hex>`):
 *     the account file, the user-auth state dir, and the machine mesh registry. A namespace with its
 *     own case-preserving encoding is how `alpha`/`Alpha` collapse on a case-insensitive FS and a
 *     tenant silently absorbs its case-sibling. Pre-hex layouts migrate (state dir) or sweep
 *     (registry) — byte-exact, never case-folded.
 *
 *  6. EVERY READER OF TRUST STATE FAILS CLOSED, not just the guard: a non-regular entry in the
 *     account namespace is CORRUPT (an lstat skip is an under-count); the user-auth marker throws on
 *     any errno but ENOENT (an `existsSync` false is a static-mode flip); the broker record refuses
 *     a stale same-operator system account (a persisted generation, compare-and-swap - `iat` is second-resolution and cannot order same-second generations) and refuses a fresh operator while
 *     tenant accounts exist (orphaning); the resolver refuses `--server`/local auto-picks whenever
 *     the disk says several tenants (or an unreadable one) exist.
 */
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-multispace-home-"));
process.env.COTAL_HOME = home;
const originalCwd = process.cwd();

await import("../src/index.js"); // register the base local-process lifecycle descriptors
const { createBrokerAuth, createSpaceAccountAuth, createSpaceAuth, composeSpaceAuth, jwtIssuedAt, mintCreds, newIdentity, rotateSystemAccount, stripSpaceAuth } = await import("@cotal-ai/core");
const {
  accountInventory, assertSingleSpaceBroker, authDir, agentCredsDir, brokerAuthPath, hasUserAuthState,
  isWorkspaceTargetError, listSpaceAccounts, loadMeshes, loadSpaceAccountAuth, loadSpaceAuth, localProcessPath,
  recordMesh, removeMesh, resolveMeshTarget, saveBrokerAuth, saveSpaceAccountAuth, soleSpaceOf, spaceAccountPath,
  spaceKey, userAuthSpacesOnDisk, userAuthStateDir,
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

  console.log("\n9) a NON-REGULAR entry in the account namespace is corrupt, never an under-count");
  const sym = await makeRoot("sym", ["alpha", "beta"]);
  roots.push(sym);
  const betaPath = spaceAccountPath(authDir(sym), "beta");
  renameSync(betaPath, `${betaPath}.aside`);
  try {
    symlinkSync(`${betaPath}.aside`, betaPath);
  } catch (e) {
    // Windows runners without the symlink privilege cannot build this fixture; a directory in the
    // account namespace exercises the same non-regular ⇒ corrupt path.
    if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
    mkdirSync(betaPath);
  }
  const symInv = accountInventory(authDir(sym));
  check("a non-regular account entry is CORRUPT in the inventory, not skipped", symInv.corrupt.length === 1 && symInv.spaces.join(",") === "alpha", symInv);
  check("the broker-wide guard REFUSES on it (the entry may hide a real tenant)", (await refusal(() => assertSingleSpaceBroker(authDir(sym), "cotal clean all"))).includes("not fully readable"));
  check("loadSpaceAccountAuth refuses to go THROUGH it (readers agree with the inventory)", (await refusal(() => loadSpaceAccountAuth(authDir(sym), "beta"))).includes("not a regular file"));

  console.log("\n10) every tenant-keyed namespace is case-safe, and pre-hex layouts migrate");
  const cs = await makeRoot("cs", ["solo2"]);
  roots.push(cs);
  check("state dirs for alpha vs Alpha are DISTINCT paths", userAuthStateDir(cs, "alpha") !== userAuthStateDir(cs, "Alpha"));
  mkdirSync(userAuthStateDir(cs, "alpha"), { recursive: true });
  writeFileSync(join(userAuthStateDir(cs, "alpha"), "idp.json"), "{}");
  check('enabling "alpha" does not flip "Alpha" (no case-fold alias)', hasUserAuthState(cs, "alpha") === true && hasUserAuthState(cs, "Alpha") === false);
  const legacyDir = join(authDir(cs), encodeURIComponent("legacyspace"));
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "idp.json"), "{}");
  check("a pre-hex state dir still reads user-auth AND migrates to the canonical segment", hasUserAuthState(cs, "legacyspace") === true && existsSync(userAuthStateDir(cs, "legacyspace")) && !existsSync(legacyDir));
  check("enumeration sees canonical + migrated spaces alike", userAuthSpacesOnDisk(authDir(cs)).sort().join(",") === "alpha,legacyspace", userAuthSpacesOnDisk(authDir(cs)));
  const meshEntry = (space: string) => ({ space, server: "nats://127.0.0.1:9999", root: cs, mode: "open" as const, ts: new Date().toISOString() });
  recordMesh(meshEntry("gamma"));
  recordMesh(meshEntry("Gamma"));
  check("case-differing meshes keep DISTINCT registry records", loadMeshes().map((m) => m.space).sort().join(",") === "Gamma,gamma", loadMeshes().map((m) => m.space));
  writeFileSync(join(home, "meshes", "legacyname.json"), JSON.stringify(meshEntry("legacyname")));
  check("a pre-hex registry record still loads", loadMeshes().some((m) => m.space === "legacyname"));
  recordMesh(meshEntry("legacyname"));
  check("recordMesh sweeps the pre-hex file (one record per space)", loadMeshes().filter((m) => m.space === "legacyname").length === 1 && !existsSync(join(home, "meshes", "legacyname.json")));
  writeFileSync(join(home, "meshes", "legacyname.json"), JSON.stringify(meshEntry("legacyname")));
  removeMesh("legacyname");
  check("removeMesh removes canonical AND pre-hex forms (no resurrection)", !loadMeshes().some((m) => m.space === "legacyname"));
  for (const s of ["gamma", "Gamma"]) removeMesh(s);

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    console.log("\n11) the user-auth marker fails CLOSED on an unreadable state dir");
    const ea = await makeRoot("eaccess", ["solo3"]);
    roots.push(ea);
    const eaDir = userAuthStateDir(ea, "solo3");
    mkdirSync(eaDir, { recursive: true });
    writeFileSync(join(eaDir, "idp.json"), "{}");
    chmodSync(eaDir, 0o000);
    const eaMsg = await refusal(() => hasUserAuthState(ea, "solo3"));
    chmodSync(eaDir, 0o700);
    check("an EACCES on the pin THROWS (never reads as static mode)", eaMsg.includes("EACCES"), eaMsg);
    check("…and reads user-auth again once readable", hasUserAuthState(ea, "solo3") === true);
  } else {
    console.log("\n11) (skipped: chmod-000 semantics need a non-root POSIX runner)");
  }

  console.log("\n12) the broker record is generation-safe: a STALE same-operator value cannot roll $SYS back");
  // PINNED same-second: mint the base and its rotation until their sys `iat` are EQUAL (retrying
  // across a second boundary), because `iat` is second-resolution and cannot order two
  // generations minted in one second - the live rollback the panel proved an iat-based guard
  // cannot stop. Merely "no sleep" would let an iat-only regression pass on a boundary run; the
  // equality is asserted, never assumed.
  let gen!: string, genV0!: Awaited<ReturnType<typeof reloadBroker>>, genV1!: Awaited<ReturnType<typeof rotateSystemAccount>>;
  for (let t = 0; ; t++) {
    const root = await makeRoot("gen", ["only2"]);
    roots.push(root);
    const v0 = await reloadBroker(root);
    const v1 = await rotateSystemAccount(composeSpaceAuth(v0, await createSpaceAccountAuth(v0, "only2")));
    if (jwtIssuedAt(v1.sys.jwt) === jwtIssuedAt(v0.sys.jwt)) { gen = root; genV0 = v0; genV1 = v1; break; }
    if (t >= 9) throw new Error("could not mint a same-second rotation pair in 10 tries");
  }
  check("the pair is genuinely same-second (equal iat) with DISTINCT authorities",
    jwtIssuedAt(genV0.sys.jwt) === jwtIssuedAt(genV1.sys.jwt) && genV0.sys.pub !== genV1.sys.pub);
  check("a fresh record persists at generation 0", (genV0.gen ?? 0) === 0, genV0.gen);
  check("an idempotent re-save of the current value is allowed", (await refusal(() => saveBrokerAuth(authDir(gen), genV0))) === "");
  saveBrokerAuth(authDir(gen), genV1);
  check("the rotation advanced the persisted generation", (await reloadBroker(gen)).gen === 1);
  const staleMsg = await refusal(() => saveBrokerAuth(authDir(gen), genV0));
  check("a stale pre-rotation same-seed write is REFUSED, same-second included", staleMsg.includes("generation"), staleMsg);
  check("on-disk sys.pub stays at the rotated value", (await reloadBroker(gen)).sys.pub === genV1.sys.pub);
  // The panel's exact sequence: the ROTATED value is the FIRST thing ever persisted (the record
  // never held the pre-rotation authority). The pre-rotation copy is still generations behind the
  // successor rule, so it refuses - this is the case a plain same-generation CAS cannot see.
  const seq = mkdtempSync(join(tmpdir(), "cotal-multispace-seq-"));
  roots.push(seq);
  mkdirSync(join(seq, ".cotal"), { recursive: true });
  let seqV0!: Awaited<ReturnType<typeof createBrokerAuth>>, seqV1!: Awaited<ReturnType<typeof rotateSystemAccount>>;
  for (let t = 0; ; t++) {
    seqV0 = await createBrokerAuth("seq");
    seqV1 = await rotateSystemAccount(composeSpaceAuth(seqV0, await createSpaceAccountAuth(seqV0, "seqspace")));
    if (jwtIssuedAt(seqV1.sys.jwt) === jwtIssuedAt(seqV0.sys.jwt)) break;
    if (t >= 9) throw new Error("could not mint a same-second rotation-persisted-first pair in 10 tries");
  }
  saveBrokerAuth(authDir(seq), seqV1);
  check("rotation-persisted-first: the pre-rotation value STILL refuses (pinned same-second, no prior record)",
    (await refusal(() => saveBrokerAuth(authDir(seq), seqV0))).includes("generation"));
  // Descent stays ergonomic: the SAVED value may rotate again without a reload (it IS the current
  // record); skipping a save in between is refused.
  const genV2 = await rotateSystemAccount(composeSpaceAuth(genV1, await createSpaceAccountAuth(genV1, "only2")));
  check("rotating the saved value again (no reload) is a legal direct successor", (await refusal(() => saveBrokerAuth(authDir(gen), genV2))) === "" && (await reloadBroker(gen)).gen === 2);
  const genV3 = await rotateSystemAccount(composeSpaceAuth(genV2, await createSpaceAccountAuth(genV2, "only2")));
  const genV4 = await rotateSystemAccount(composeSpaceAuth(genV3, await createSpaceAccountAuth(genV3, "only2")));
  check("skipping a save between rotations is refused (not the direct successor)",
    (await refusal(() => saveBrokerAuth(authDir(gen), genV4))).includes("generation"));
  // A hand-edited generation must fail CLOSED before any arithmetic: the record reaches the guard
  // through a bare JSON cast, and a string would launder straight through it ("0"+1 is "01"),
  // while an unsafe integer satisfies gen === gen+1 - either destroys the successor discriminator.
  const genRecordPath = brokerAuthPath(authDir(gen));
  const genDoc = JSON.parse(readFileSync(genRecordPath, "utf8"));
  const genDocValid = JSON.stringify(genDoc, null, 2);
  genDoc.gen = String(genDoc.gen);
  writeFileSync(genRecordPath, JSON.stringify(genDoc, null, 2));
  check("a STRING generation on disk refuses a sys change as corrupt (no arithmetic laundering)",
    (await refusal(() => saveBrokerAuth(authDir(gen), genV3))).includes("not a non-negative integer"));
  check("…and a rotation from the corrupt record refuses at the rotate step too",
    (await refusal(async () => rotateSystemAccount(composeSpaceAuth(await reloadBroker(gen), await createSpaceAccountAuth(genV2, "only2")))) ).includes("not a non-negative integer"));
  genDoc.gen = Number.MAX_SAFE_INTEGER + 2; // serializes as an unsafe float - gen+1 === gen up there
  writeFileSync(genRecordPath, JSON.stringify(genDoc, null, 2));
  check("an UNSAFE-integer generation refuses a sys change as corrupt",
    (await refusal(() => saveBrokerAuth(authDir(gen), genV3))).includes("not a non-negative integer"));
  writeFileSync(genRecordPath, genDocValid); // restore the fixture's valid record
  // The dual-rotation race: two rotations off the SAME loaded base both mint generation N+1 with
  // DIFFERENT sys. First write lands as the successor; the second is equal-generation with a
  // different authority - neither the idempotent no-op (that needs byte-identical sys.pub AND
  // sys.jwt) nor a successor. First-writer-wins loud, never last-writer - the case a
  // monotonic-greater guard would wrongly admit (the equal-iat hole reborn at the gen layer).
  const raceBase = await reloadBroker(gen);
  const raceA = await rotateSystemAccount(composeSpaceAuth(raceBase, await createSpaceAccountAuth(raceBase, "only2")));
  const raceB = await rotateSystemAccount(composeSpaceAuth(raceBase, await createSpaceAccountAuth(raceBase, "only2")));
  saveBrokerAuth(authDir(gen), raceA);
  check("dual rotation off one base: the second equal-generation different-sys write is REFUSED",
    (await refusal(() => saveBrokerAuth(authDir(gen), raceB))).includes("generation"));
  check("…and the FIRST writer's system account is what persists", (await reloadBroker(gen)).sys.pub === raceA.sys.pub);
  // An explicit `"gen": null` in the CURRENT record is tampering, never migration - a
  // pre-generation record OMITS the field (the writer always emits a number). Defaulting null to 0
  // would turn the doctored record into a "generation-0 predecessor" and re-admit the same-second
  // stale rollback through it.
  const nullDoc = JSON.parse(readFileSync(genRecordPath, "utf8"));
  const nullDocValid = JSON.stringify(nullDoc, null, 2);
  nullDoc.gen = null;
  writeFileSync(genRecordPath, JSON.stringify(nullDoc, null, 2));
  check("an explicit NULL generation refuses a stale sys write as corrupt (never reads as absent)",
    (await refusal(() => saveBrokerAuth(authDir(gen), genV2))).includes("not a non-negative integer"));
  check("…and refuses at the rotate step too (no ?? laundering)",
    (await refusal(async () => rotateSystemAccount(composeSpaceAuth(await reloadBroker(gen), await createSpaceAccountAuth(raceA, "only2"))))).includes("not a non-negative integer"));
  writeFileSync(genRecordPath, nullDocValid);
  check("…and the doctored record never rolled sys back", (await reloadBroker(gen)).sys.pub === raceA.sys.pub);
  // A malformed INCOMING generation refuses even when sys is byte-identical: a corrupt input never
  // gets a success exit from a trust write, idempotent path included.
  const idem = await reloadBroker(gen);
  check("a malformed incoming generation refuses even on the byte-identical idempotent path",
    (await refusal(() => saveBrokerAuth(authDir(gen), { ...idem, gen: "bad" as never }))).includes("not a non-negative integer"));

  console.log("\n13) a missing broker.json does not license a fresh operator while tenants exist");
  const orphan = await makeRoot("orphan", ["alpha", "beta"]);
  roots.push(orphan);
  const orphanOwner = await reloadBroker(orphan);
  rmSync(brokerAuthPath(authDir(orphan)));
  const freshOp = await createBrokerAuth("intruder2");
  const orphanMsg = await refusal(() => saveBrokerAuth(authDir(orphan), freshOp));
  check("a FRESH operator is refused while account records exist", orphanMsg.includes("orphaned"), orphanMsg);
  check("the refusal left every tenant record intact", listSpaceAccounts(authDir(orphan)).join(",") === "alpha,beta");
  check("re-writing the ORIGINAL operator is allowed (a broker.json repair, verified per account)", (await refusal(() => saveBrokerAuth(authDir(orphan), orphanOwner))) === "");
  rmSync(brokerAuthPath(authDir(orphan)));
  writeFileSync(join(authDir(orphan), "account.zznothex.json"), "{}");
  check("the repair is refused while ANY record is unreadable (validated inventory, not the parseable subset)", (await refusal(() => saveBrokerAuth(authDir(orphan), orphanOwner))).includes("unreadable"));
  rmSync(join(authDir(orphan), "account.zznothex.json"));
  saveBrokerAuth(authDir(orphan), orphanOwner);

  console.log("\n14) the resolver refuses to auto-pick whenever the disk names several tenants");
  recordMesh({ space: "r-one", server: "nats://127.0.0.1:7777", root: cs, mode: "open", ts: new Date().toISOString() });
  recordMesh({ space: "r-two", server: "nats://127.0.0.1:7777", root: cs, mode: "open", ts: new Date().toISOString() });
  let srvErr: unknown;
  try { resolveMeshTarget(home, { server: "nats://127.0.0.1:7777" }); } catch (e) { srvErr = e; }
  check("--server with TWO spaces on that server throws ambiguous-target", isWorkspaceTargetError(srvErr) && (srvErr as { code: string }).code === "ambiguous-target", (srvErr as Error)?.message);
  for (const s of ["r-one", "r-two"]) removeMesh(s);
  recordMesh({ space: "alpha", server: "nats://127.0.0.1:8888", root: multi, mode: "auth", ts: new Date().toISOString() });
  let partialErr: unknown;
  try { resolveMeshTarget(multi, {}); } catch (e) { partialErr = e; }
  check("a partially-registered 2-tenant root throws ambiguous-target (the DISK is the tenant authority)", isWorkspaceTargetError(partialErr) && (partialErr as { code: string }).code === "ambiguous-target", (partialErr as Error)?.message);
  check("…naming both tenants, not just the recorded one", String((partialErr as Error)?.message).includes("alpha") && String((partialErr as Error)?.message).includes("beta"));
  removeMesh("alpha");

  console.log("\n15) the stripped signer bundle (mint --signer) still loads under the broker/account split");
  const fullChain = await createSpaceAuth("signer9");
  const container = mkdtempSync(join(tmpdir(), "cotal-multispace-container-"));
  roots.push(container);
  mkdirSync(authDir(container), { recursive: true });
  writeFileSync(join(authDir(container), "auth.json"), JSON.stringify(stripSpaceAuth(fullChain), null, 2));
  const bundle = loadSpaceAuth(authDir(container), "signer9");
  check("a mounted stripped monolith loads for its own space (no broker chain to verify - trust is the mount)",
    bundle?.space === "signer9" && bundle.account.signingSeed === fullChain.account.signingSeed && bundle.operator.seed === "");
  check("…and mints an agent cred through it (the container manager's whole job)", Boolean(await mintCreds(bundle!, newIdentity(), "agent", { lifecycleUid: "smokesigner0123456789abcdef" })));
  check("…but never for a DIFFERENT space", loadSpaceAuth(authDir(container), "elsewhere") === undefined);
  const noSigner = stripSpaceAuth(fullChain);
  noSigner.account.signingSeed = "";
  writeFileSync(join(authDir(container), "auth.json"), JSON.stringify(noSigner, null, 2));
  check("a blanked monolith WITHOUT signing material still fails loud through composition",
    (await refusal(() => loadSpaceAuth(authDir(container), "signer9"))).includes("operator material"));
  writeFileSync(join(authDir(solo), "auth.json"), JSON.stringify(stripSpaceAuth(loadSpaceAuth(authDir(solo), "solo")!), null, 2));
  check("split records take PRECEDENCE over a stray stripped monolith beside them",
    Boolean(loadSpaceAuth(authDir(solo), "solo")!.operator.seed));
  rmSync(join(authDir(solo), "auth.json"));

  console.log("\n16) a legal legacy space name that ALIASES a canonical segment fails LOUD, never a static flip");
  // A space literally named `space.<validhex>` has a pre-hex state dir whose name IS the canonical
  // segment of a DIFFERENT space (`space.616c706861` = the legacy dir of this space AND alpha's
  // canonical home). Nothing on disk says which tenant owns it, so migration must refuse - the old
  // bug read it as static and let `mint` write admin creds onto a user-auth space.
  const collide = await makeRoot("collide", ["realspace"]);
  roots.push(collide);
  const aliasName = "space.616c706861"; // encodeURIComponent(this) === alpha's canonical segment
  const legacyAliasDir = join(authDir(collide), encodeURIComponent(aliasName));
  mkdirSync(legacyAliasDir, { recursive: true });
  writeFileSync(join(legacyAliasDir, "idp.json"), "{}");
  check("hasUserAuthState on the colliding space THROWS ambiguous, not a silent static flip",
    (await refusal(() => hasUserAuthState(collide, aliasName))).includes("ambiguous"));
  check("a normal space's legacy dir still migrates unaffected (the guard is precise to the collision)",
    (() => {
      const legacyNorm = join(authDir(collide), encodeURIComponent("plainspace"));
      mkdirSync(legacyNorm, { recursive: true });
      writeFileSync(join(legacyNorm, "idp.json"), "{}");
      return hasUserAuthState(collide, "plainspace") === true && existsSync(userAuthStateDir(collide, "plainspace")) && !existsSync(legacyNorm);
    })());

  console.log("\n17) --server names a BROKER: a partially-registered multi-tenant root refuses, not auto-picks");
  const partial = await makeRoot("partial", ["alpha", "beta"]);
  roots.push(partial);
  recordMesh({ space: "alpha", server: "nats://127.0.0.1:9911", root: partial, mode: "auth", ts: new Date().toISOString() });
  let srvPartialErr: unknown;
  try { resolveMeshTarget(partial, { server: "nats://127.0.0.1:9911" }); } catch (e) { srvPartialErr = e; }
  check("--server with one registry row but TWO accounts on that broker's root throws ambiguous-target",
    isWorkspaceTargetError(srvPartialErr) && (srvPartialErr as { code: string }).code === "ambiguous-target", (srvPartialErr as Error)?.message);
  check("…naming both tenants the disk proves, not the single recorded one",
    String((srvPartialErr as Error)?.message).includes("alpha") && String((srvPartialErr as Error)?.message).includes("beta"));
  removeMesh("alpha");
  // Over-refusal guard: a GENUINELY single-tenant broker via --server must still resolve (disk N=1).
  const oneTenant = await makeRoot("one-tenant", ["only9"]);
  roots.push(oneTenant);
  recordMesh({ space: "only9", server: "nats://127.0.0.1:9912", root: oneTenant, mode: "auth", ts: new Date().toISOString() });
  check("--server on a genuinely single-tenant broker STILL resolves (no over-refusal)",
    resolveMeshTarget(oneTenant, { server: "nats://127.0.0.1:9912" }).space === "only9");
  removeMesh("only9");

  console.log("\n18) the validated inventory validates the account SHAPE, so status never crashes on a semantic-empty record");
  const shape = await makeRoot("shape", ["good"]); // a REAL account beside the corrupt one
  roots.push(shape);
  writeFileSync(spaceAccountPath(authDir(shape), "alpha"), JSON.stringify({ space: "alpha" })); // round-trips its name, but NO account material
  const shapeInv = accountInventory(authDir(shape));
  check("the semantic-empty record is CORRUPT while the REAL account beside it stays a valid tenant (no over-classification)",
    shapeInv.spaces.join(",") === "good" && shapeInv.corrupt.length === 1, shapeInv);
  check("loadSpaceAccountAuth refuses the empty one loud (never returns a record compose will crash on)",
    (await refusal(() => loadSpaceAccountAuth(authDir(shape), "alpha"))).includes("missing its account material"));
  check("…and still loads the good account fine (the shape check is precise)", Boolean(loadSpaceAuth(authDir(shape), "good")));

  console.log("\n19) shape is necessary not sufficient: a record that passes shape but fails COMPOSITION is caught at the consumer");
  // A non-empty-string `account.jwt` passes the cheap shape gate but breaks composeSpaceAuth - a
  // malformed JWT (decode throws) or a well-formed one signed by a FOREIGN operator (iss mismatch).
  // Inventory deliberately stays shape-only (the broker-wide-guard/resolver/repair paths have no
  // broker to bind against), so the "can this compose into usable trust" check lives at the load.
  // (a) malformed JWT: real broker.json + a shape-passing account whose jwt won't decode.
  const badJwt = await makeRoot("badjwt", ["good9"]); // its own real broker.json, plus a real donor account
  roots.push(badJwt);
  const donorAcct = JSON.parse(readFileSync(spaceAccountPath(authDir(badJwt), "good9"), "utf8"));
  writeFileSync(spaceAccountPath(authDir(badJwt), "alpha"), JSON.stringify({ space: "alpha", account: { ...donorAcct.account, jwt: "not-a-jwt" } }));
  check("a shape-passing record with a MALFORMED account JWT fails loud at load (not a silent bad compose)",
    (await refusal(() => loadSpaceAuth(authDir(badJwt), "alpha"))) !== "");
  // (b) foreign operator: this root's own broker, but an account well-formed under a DIFFERENT operator.
  const foreign = await makeRoot("foreign", []); // has its own broker.json (makeRoot writes it)
  roots.push(foreign);
  const foreignBroker = await createBrokerAuth("foreign-op");
  saveSpaceAccountAuth(authDir(foreign), await createSpaceAccountAuth(foreignBroker, "alpha"));
  check("a well-formed account signed by a FOREIGN operator fails loud at load (iss mismatch), never composes",
    (await refusal(() => loadSpaceAuth(authDir(foreign), "alpha"))).includes("not this broker's operator"));

  console.log("\n20) the ONE key builder is injective over Unicode: a lone surrogate is refused, real names pass");
  // `Buffer.from(s,"utf8")` folds EVERY lone surrogate to U+FFFD, so without a guard `"\uD800"` and
  // `"\uDFFF"` both key to `efbfbd` - two spaces collapse to one account/registry/state key and the
  // undercount/aliasing class hex closed re-opens, sourced from malformed Unicode. Reject at the ONE
  // builder; every legitimate name passes.
  for (const bad of ["\uD800", "\uDFFF", "\uDBFF", "a\uD800b"])
    check(`lone surrogate ${JSON.stringify(bad)} refused at spaceKey (no efbfbd collapse)`, (await refusal(() => spaceKey(bad))).includes("well-formed"));
  check("distinct lone surrogates cannot collide on one account file (both refused before any write)",
    spaceKey("😀") !== undefined && (await refusal(() => spaceKey("\uD800"))) !== "" && (await refusal(() => spaceKey("\uDFFF"))) !== "");
  check("legitimate names still round-trip distinctly: café / 中 / 𝔘 / 😀 / U+FFFD",
    new Set(["café", "中", "𝔘", "😀", "�"].map((s) => spaceKey(s))).size === 5);
  const surRoot = await makeRoot("surrogate", []);
  roots.push(surRoot);
  check("saveSpaceAccountAuth refuses a lone-surrogate space (never writes account.efbfbd.json)",
    (await refusal(async () => saveSpaceAccountAuth(authDir(surRoot), await createSpaceAccountAuth(await createBrokerAuth("s"), "\uD800")))).includes("well-formed"));

  console.log("\n21) a {space}-keyed process file admits its PRE-HEX name so an upgrade never orphans the auth-service signer");
  const upgrade = await makeRoot("upgrade", ["only21"]);
  roots.push(upgrade);
  const ctx21 = { root: upgrade, space: "only21", userAuth: true };
  const legacyPidName = `auth-service.${encodeURIComponent("only21")}.pid`;
  const hexPidName = `auth-service.${spaceKey("only21")}.pid`;
  writeFileSync(join(authDir(upgrade), "..", legacyPidName), "4242"); // pre-hex build's pidfile
  check("localProcessPath resolves to the pre-hex pidfile when the canonical hex one is absent",
    localProcessPath("auth-service.{space}.pid", ctx21).endsWith(legacyPidName));
  writeFileSync(join(authDir(upgrade), "..", hexPidName), "4343");
  check("both the pre-hex AND canonical file present ⇒ fails loud (ambiguous), never silently picks",
    (await refusal(() => localProcessPath("auth-service.{space}.pid", ctx21))).includes("ambiguous"));
  rmSync(join(authDir(upgrade), "..", legacyPidName));
  check("with only the canonical present it resolves to the hex name (no over-admission)",
    localProcessPath("auth-service.{space}.pid", ctx21).endsWith(hexPidName));
  rmSync(join(authDir(upgrade), "..", hexPidName));
  check("a non-{space} template (nats.pid) is unaffected by the legacy lookup",
    localProcessPath("nats.pid", ctx21).endsWith("nats.pid"));

  console.log("\n22) a record that fails COMPOSITION surfaces as a typed target error (status exits 0, never a raw throw)");
  const composeFail = await makeRoot("composefail", []);
  roots.push(composeFail);
  await saveSpaceAccountAuth(authDir(composeFail), await createSpaceAccountAuth(await createBrokerAuth("other-op"), "alpha")); // foreign-signed under composeFail's own broker
  let composeErr: unknown;
  try { resolveMeshTarget(composeFail, {}); } catch (e) { composeErr = e; }
  check("resolveMeshTarget throws a typed unreadable-auth (a surface catches it and exits 0, not crashes)",
    isWorkspaceTargetError(composeErr) && (composeErr as { code: string }).code === "unreadable-auth", (composeErr as Error)?.message);

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

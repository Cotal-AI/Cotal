/**
 * SpaceAuth-through-the-seam gate (W3 increment 4). The space trust bundle — the SIGNING AUTHORITY,
 * whoever holds it mints any cred in the account — moves behind the SecretStore seam. This proves,
 * with `.cotal/auth/auth.json` NEVER on disk and the bundle only in an INJECTED (in-memory) store:
 *
 *   1. put/get roundtrip; `sys.signingSeed` STRIPPED at rest (put), never returned; the data-account
 *      signingSeed IS persisted (minting needs it). Local FS composition stays byte-for-byte.
 *   2. THE MANAGER'S SIGNER SOURCE: getSpaceAuth(store, space) yields a bundle that mints the exact
 *      creds manager.start() mints (supervisor + provisioner + agent) — while loadSpaceAuth(authDir)
 *      on the FS is undefined, i.e. the signer is NOT sourced from disk. (manager.ts calling that FS
 *      reader is the manager:479 trap the grep gate + this composition proof close.)
 *   3. THE RENEWAL SPLIT-AUTHORITY FIX (renewal:69): remintDaemonCreds(root, injectedStore) re-signs
 *      the daemon cred INTO the same store (identity preserved), with auth.json still absent — and
 *      with NO store passed and an empty disk it is `no-auth`, proving the disk is genuinely empty so
 *      only the injected store made the re-sign possible. Before the fix the signer came from FS and
 *      this remint would fail (or, worse, split authority against a stale disk bundle).
 *   4. NON-MATERIAL ERRORS: an expected-space mismatch and a corrupt/malformed store value fail loud
 *      without echoing seeds, JWTs, or the stored bytes.
 *
 * Pure in-memory + FS-absence; no broker. Complements smoke:lifecycle-e2e (the live manager mint on
 * the FS-default composition) and the manager.ts/renewal.ts grep gate (zero loadSpaceAuth in either).
 *
 * Run: pnpm smoke:space-auth-store
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSpaceAuth, identityFromCreds, mintCreds, mintLifecycleUid, newIdentity, type SecretStore, type SpaceAuth } from "@cotal-ai/core";
import { authDir, deleteSpaceAuth, getSpaceAuth, loadSpaceAuth, putSpaceAuth, saveSpaceAuth, SPACE_AUTH_KEY } from "../src/auth-paths.js";
import { workspaceSecretStore } from "../src/secret-store-fs.js";
import { DELIVERY_CREDS_KEY, remintDaemonCreds } from "../src/renewal.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const rejects = async (name: string, fn: () => Promise<unknown> | unknown, mustInclude: string, mustNotInclude?: string) => {
  try {
    await fn();
    check(`${name} (did not throw)`, false);
  } catch (e) {
    const msg = (e as Error).message;
    check(name, msg.includes(mustInclude) && (mustNotInclude === undefined || !msg.includes(mustNotInclude)), msg);
  }
};

/** In-memory SecretStore double — the hosted composition's stand-in. Every value lives HERE, never
 *  on the workspace FS, so a disk read of the signer would be provably empty. */
class MemStore implements SecretStore {
  readonly map = new Map<string, string>();
  async get(k: string) { return this.map.get(k); }
  async put(k: string, v: string) { this.map.set(k, v); }
  async delete(k: string) { this.map.delete(k); }
}

const isCreds = (s: string | undefined): boolean => !!s && s.includes("BEGIN NATS USER JWT") && s.includes("BEGIN USER NKEY SEED");

const space = "seam-space";
const auth = await createSpaceAuth(space);
const root = mkdtempSync(join(tmpdir(), "cotal-spaceauth-store-")); // an EMPTY workspace root — no .cotal/auth
const authJson = join(authDir(root), "auth.json");
try {
  const mem = new MemStore();

  // ---- 1. put/get + strip + byte-for-byte local parity ----
  check("nothing on disk to begin with", !existsSync(authJson));
  await putSpaceAuth(mem, auth);
  check("the bundle landed in the injected store (not on disk)", mem.map.has(SPACE_AUTH_KEY) && !existsSync(authJson));

  const storedRaw = mem.map.get(SPACE_AUTH_KEY)!;
  const stored = JSON.parse(storedRaw) as SpaceAuth;
  check("createSpaceAuth carries sys.signingSeed in memory (pre-strip)", auth.sys.signingSeed !== undefined);
  check("putSpaceAuth STRIPS sys.signingSeed at rest", stored.sys.signingSeed === undefined);
  check("putSpaceAuth PERSISTS the data-account signingSeed (minting needs it)", typeof stored.account.signingSeed === "string" && stored.account.signingSeed.length > 0);

  const got = await getSpaceAuth(mem, space);
  check("getSpaceAuth returns the stored bundle", got?.space === space && got?.account.signingSeed === auth.account.signingSeed);
  check("getSpaceAuth never resurrects sys.signingSeed", got?.sys.signingSeed === undefined);

  // Local FS composition: putSpaceAuth via the workspace store == saveSpaceAuth, byte-for-byte.
  const fsA = mkdtempSync(join(tmpdir(), "cotal-spaceauth-fsA-"));
  const fsB = mkdtempSync(join(tmpdir(), "cotal-spaceauth-fsB-"));
  try {
    await putSpaceAuth(workspaceSecretStore(fsA), auth);
    saveSpaceAuth(authDir(fsB), auth);
    check("FS store key maps to the canonical .cotal/auth/auth.json", existsSync(join(authDir(fsA), "auth.json")));
    check("putSpaceAuth (store) == saveSpaceAuth (FS) byte-for-byte",
      readFileSync(join(authDir(fsA), "auth.json"), "utf8") === readFileSync(join(authDir(fsB), "auth.json"), "utf8"));
  } finally {
    rmSync(fsA, { recursive: true, force: true });
    rmSync(fsB, { recursive: true, force: true });
  }

  // ---- 2. the manager's signer source: mint from the injected store, NOT the disk ----
  check("the disk signer is genuinely absent (loadSpaceAuth undefined)", loadSpaceAuth(authDir(root)) === undefined);
  const signer = (await getSpaceAuth(mem, space))!;
  const supervisor = await mintCreds(signer, newIdentity(), "supervisor");
  const provisioner = await mintCreds(signer, newIdentity(), "provisioner");
  const agent = await mintCreds(signer, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() });
  check("manager mints its SUPERVISOR cred from the injected-store signer", isCreds(supervisor));
  check("manager mints a PROVISIONER cred from the injected-store signer", isCreds(provisioner));
  check("manager mints a per-agent cred from the injected-store signer", isCreds(agent));
  check("still no auth.json on disk after minting", !existsSync(authJson));

  // ---- 3. renewal split-authority fix: re-sign INTO the injected store, disk stays empty ----
  const deliveryId = newIdentity();
  const initialDelivery = await mintCreds(auth, deliveryId, "delivery");
  await mem.put(DELIVERY_CREDS_KEY, initialDelivery);
  const results = await remintDaemonCreds(root, mem); // root's disk is empty; the signer MUST come from `mem`
  const delivery = results.find((r) => r.file === DELIVERY_CREDS_KEY);
  check("remintDaemonCreds re-signed the delivery cred from the injected-store signer", delivery?.ok === true, delivery);
  const resigned = mem.map.get(DELIVERY_CREDS_KEY)!;
  check("the re-signed cred was written back INTO the injected store", isCreds(resigned));
  check("the daemon identity is preserved across the re-sign", identityFromCreds(resigned).id === deliveryId.id);
  check("renewal NEVER wrote the signer to disk (auth.json still absent)", !existsSync(authJson));

  // The negative: with NO store and an empty disk, the signer is genuinely unreachable → no-auth.
  const emptyRoot = mkdtempSync(join(tmpdir(), "cotal-spaceauth-empty-"));
  try {
    const noAuth = await remintDaemonCreds(emptyRoot); // FS default over an empty root
    check("no store + empty disk ⇒ no-auth (proves the disk path was truly empty)",
      noAuth.every((r) => r.skipped === "no-auth"), noAuth);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }

  // ---- 4. non-material errors ----
  const seed = auth.account.signingSeed; // a real seed we must never see leak into an error string
  await rejects("expected-space mismatch fails loud, names only the space labels",
    () => getSpaceAuth(mem, "some-other-space"), "some-other-space", seed);
  const corrupt = new MemStore();
  await corrupt.put(SPACE_AUTH_KEY, "{ not json — SEED_LEAK_CANARY");
  await rejects("corrupt store value fails loud without echoing the bytes",
    () => getSpaceAuth(corrupt), "not valid JSON", "SEED_LEAK_CANARY");
  const shapeless = new MemStore();
  await shapeless.put(SPACE_AUTH_KEY, JSON.stringify({ nope: true }));
  await rejects("malformed bundle (no space name) fails loud", () => getSpaceAuth(shapeless), "malformed");

  // ---- delete ----
  await deleteSpaceAuth(mem);
  check("deleteSpaceAuth removes the bundle from the store", (await getSpaceAuth(mem)) === undefined);
  await deleteSpaceAuth(mem); // idempotent
  check("deleteSpaceAuth is idempotent", true);

  // ---- grep gate (EXECUTABLE): the two hosted-reachable signer owners must read the signer only
  // through the store seam, never the sync FS `loadSpaceAuth`. A regression that reintroduces a
  // `loadSpaceAuth` in either would split authority on a hosted store (signer<-disk, cred<-store). ----
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const rel of ["implementations/manager/src/manager.ts", "packages/workspace/src/renewal.ts"]) {
    const src = readFileSync(join(repoRoot, rel), "utf8");
    check(`${rel} reads the signer only through the store (no loadSpaceAuth)`, !src.includes("loadSpaceAuth"));
  }

  console.log(`\nSPACE-AUTH-STORE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Auth secret-store smoke: the four secret kinds (callout account, issuer keys, owner secret,
 * service key projection) ride the SecretStore seam with canonical `auth/space.<hex>/<file>` keys
 * (the workspace-wide injective space segment). Locks, without a broker:
 *
 *  1. LAYOUT — the workspace filesystem composition lands byte-for-byte on the state-dir layout
 *     (`.cotal/auth/space.<hex>/<file>`, 0600 under 0700), the same dir `userAuthStateDir` names;
 *     a pre-hex workstation layout is renamed there by that path builder's one-time shim, so an
 *     upgraded workstation keeps reading its existing material.
 *  2. STABILITY — ensure* is load-or-create: a second call returns the SAME material.
 *  3. KEY EDGES — a space name that would alias outside its own segment (`.`/`..`/empty) is
 *     refused at the key builder; a slash-bearing name stays ONE encoded segment.
 *  4. FAIL-LOUD — torn/edited/foreign-space material surfaces as a legible sentence naming the
 *     key, never a raw parse error or a silent regenerate.
 *  5. DAEMON BOUNDARY — with a store injected into `runAuthService`, the four kinds come ONLY
 *     from it: absent keys are a hard error naming what's missing (never local generation), a
 *     fully provisioned store is read straight through it (the daemon proceeds to its broker
 *     probe with nothing but the IdP pin on disk), and the daemon's read path never writes.
 *  6. FAIL BEFORE MUTATION — a degenerate space is refused at the ENTRY POINTS
 *     (`runAuthService`, `prepareServer`) before any non-seam state is touched: a planted
 *     discovery-file sentinel at the aliased path survives, and no IdP pin is written.
 *  7. DEPROVISION — the delete half of the pair: `deprovisionSecrets` removes exactly the four
 *     canonical keys, attempts every key even when one fails (then throws naming the failures),
 *     and absent keys are idempotent no-ops.
 *
 * Run: pnpm smoke:auth-store
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs, SecretStore } from "@cotal-ai/core";
import { userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import {
  authCalloutKey,
  authIssuerKey,
  authOwnerSecretKey,
  authServiceKeysKey,
  ensureIssuer,
  ensureOwnerSecret,
  loadIssuer,
  loadOwnerSecret,
  loadServiceKeys,
  saveServiceKeys,
} from "../src/store.js";
import { exportSigningKey, generateSigningKey } from "../src/issuer.js";
import { runAuthService } from "../src/service.js";
import { cotalAuthProvider } from "../src/provider.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const rejects = async (name: string, fn: () => Promise<unknown>, msgPart: string) => {
  try {
    await fn();
    check(`${name} (did not throw)`, false);
  } catch (e) {
    check(name, (e as Error).message.includes(msgPart), (e as Error).message);
  }
};

const root = mkdtempSync(join(tmpdir(), "cotal-authstore-"));
const startCwd = process.cwd();
const SPACE = "main";
const store = workspaceSecretStore(root);

try {
  // ---------- 1+2. layout byte-for-byte + load-or-create stability ----------
  console.log("1) filesystem composition lands on the pre-seam layout");
  const secret = await ensureOwnerSecret(store, SPACE);
  const legacyPath = join(userAuthStateDir(root, SPACE), "owner-secret.json");
  check("owner secret lands exactly at the pre-seam path (.cotal/auth/<space>/owner-secret.json)", existsSync(legacyPath));
  if (process.platform !== "win32") {
    check("owner secret file is 0600", (statSync(legacyPath).mode & 0o777) === 0o600);
    check("its space segment dir is 0700", (statSync(userAuthStateDir(root, SPACE)).mode & 0o777) === 0o700);
  }
  const again = await ensureOwnerSecret(store, SPACE);
  check("second ensureOwnerSecret returns the SAME 32 bytes (load-or-create, no regenerate)",
    secret.length === 32 && Buffer.from(secret).equals(Buffer.from(again)));
  const loaded = await loadOwnerSecret(store, SPACE);
  check("loadOwnerSecret round-trips the bytes", !!loaded && Buffer.from(loaded).equals(Buffer.from(secret)));

  const issuer = await ensureIssuer(store, SPACE);
  check("issuer lands at the pre-seam path", existsSync(join(userAuthStateDir(root, SPACE), "issuer.json")));
  const issuerAgain = await ensureIssuer(store, SPACE);
  check("second ensureIssuer keeps the SAME active kid (outstanding bearers keep verifying)",
    issuer.activeKid() === issuerAgain.activeKid());

  await saveServiceKeys(store, SPACE, { dataAccount: { pub: "A_PUB", signingSeed: "S_SEED" } });
  const keys = await loadServiceKeys(store, SPACE);
  check("service key projection round-trips", keys?.dataAccount.pub === "A_PUB" && keys.dataAccount.signingSeed === "S_SEED");
  check("service keys land at the pre-seam path", existsSync(join(userAuthStateDir(root, SPACE), "service-keys.json")));

  // ---------- 3. key builders + their edges ----------
  console.log("3) canonical keys + segment containment");
  // The segment is the workspace-wide injective hex key (`space.<hex>`): case-safe on a
  // case-insensitive FS (a raw/percent segment let `alpha`/`Alpha` share one dir and alias each
  // other's owner secrets) and collision-free with the auth dir's reserved siblings.
  check("callout key is auth/space.<hex>/callout.json", authCalloutKey("main") === "auth/space.6d61696e/callout.json");
  check("issuer key mirrors the layout", authIssuerKey("main") === "auth/space.6d61696e/issuer.json");
  check("owner-secret key mirrors the layout", authOwnerSecretKey("main") === "auth/space.6d61696e/owner-secret.json");
  check("service-keys key mirrors the layout", authServiceKeysKey("main") === "auth/space.6d61696e/service-keys.json");
  check("a slash-bearing space stays ONE flat hex segment", authCalloutKey("a/b") === "auth/space.612f62/callout.json");
  await ensureOwnerSecret(store, "a/b");
  check("…and its file lands inside .cotal/auth/ (no nested dir escape)",
    existsSync(join(root, ".cotal", "auth", "space.612f62", "owner-secret.json")));
  check("case-differing spaces get DISTINCT keys (no case-fold alias)", authOwnerSecretKey("main") !== authOwnerSecretKey("Main"));
  const caseLower = await ensureOwnerSecret(store, "casecheck");
  check("…and a case-sibling reads NOTHING through the other's key", (await loadOwnerSecret(store, "Casecheck")) === undefined);
  const caseUpper = await ensureOwnerSecret(store, "Casecheck");
  check("…so the two hold independent secrets", !Buffer.from(caseLower).equals(Buffer.from(caseUpper)));
  for (const bad of ["..", ".", ""]) {
    try {
      authOwnerSecretKey(bad);
      check(`space ${JSON.stringify(bad)} is refused at the key builder (did not throw)`, false);
    } catch (e) {
      check(`space ${JSON.stringify(bad)} is refused at the key builder`, /cannot name a space|space name is required/.test((e as Error).message), (e as Error).message);
    }
  }

  // ---------- 4. fail-loud on torn / foreign material ----------
  console.log("4) torn or foreign material fails loud, naming the key");
  await store.put(authIssuerKey("torn"), "{not json");
  await rejects("torn issuer material is a legible sentence naming the key",
    () => loadIssuer(store, "torn"), `${authIssuerKey("torn")}: the issuer key entry is not valid JSON`);
  await store.put(authOwnerSecretKey("wrongver"), JSON.stringify({ ver: 99, secretB64: "x" }));
  await rejects("an unknown version refuses to guess",
    () => loadOwnerSecret(store, "wrongver"), "unknown owner secret version 99");
  // Foreign-space material: space B carrying space A's persisted issuer must refuse to mint.
  await store.put(authIssuerKey("other"), (await store.get(authIssuerKey(SPACE)))!);
  await rejects("issuer material persisted under another space's pin refuses to mint",
    () => ensureIssuer(store, "other"), "belongs to a different space");

  // ---------- 5. runAuthService injected-store boundary ----------
  console.log("5) daemon boundary: an injected store is the four kinds' ONLY source");
  // The daemon resolves its non-seam state dir ambiently (findCotalRoot walks up from cwd) —
  // give it the sandbox as its workspace.
  mkdirSync(join(root, ".cotal"), { recursive: true });
  process.chdir(root);
  const argsFor = (space: string): ParsedArgs => ({ values: { space, server: "nats://127.0.0.1:1" }, positionals: [], raw: [] } as unknown as ParsedArgs);

  const reads: string[] = [];
  const recordingEmpty: SecretStore = {
    get: async (key) => { reads.push(key); return undefined; },
    put: async () => { throw new Error("BUG: the auth-service read path must never put"); },
    delete: async () => { throw new Error("BUG: the auth-service read path must never delete"); },
  };
  await rejects("injected + absent keys is a hard error naming the missing kinds — never local generation",
    () => runAuthService(argsFor("hosted"), recordingEmpty),
    "user-auth material is missing (service keys, callout account, issuer keys, owner secret");
  await rejects("…and the error names the hosted recovery",
    () => runAuthService(argsFor("hosted"), recordingEmpty),
    "the hosted composition must provision the secret store before starting this daemon");
  check("the daemon asked the injected store for exactly the four canonical keys",
    ["service-keys.json", "callout.json", "issuer.json", "owner-secret.json"]
      .every((f) => reads.includes(`auth/space.686f73746564/${f}`)), reads.join(", "));
  check("no secret file was created on disk by the refused starts", !existsSync(join(root, ".cotal", "auth", "hosted")));

  // A fully provisioned injected store: the daemon reads all four kinds through it (only the IdP
  // pin is on disk) and proceeds to its broker probe — the next failure past the material gate.
  const provisioned = new Map<string, string>();
  const signing = await generateSigningKey();
  provisioned.set(authIssuerKey("hosted"), JSON.stringify({
    ver: 1, issuer: "urn:cotal:auth:hosted", activeKid: signing.kid, keys: [await exportSigningKey(signing)],
  }));
  provisioned.set(authOwnerSecretKey("hosted"), JSON.stringify({ ver: 1, secretB64: Buffer.alloc(32, 7).toString("base64") }));
  provisioned.set(authServiceKeysKey("hosted"), JSON.stringify({ ver: 1, dataAccount: { pub: "A_PUB", signingSeed: "S_SEED" } }));
  provisioned.set(authCalloutKey("hosted"), JSON.stringify({
    ver: 1,
    callout: {
      account: { pub: "A_CALLOUT", jwt: "jwt" },
      calloutCreds: "creds", sentinelCreds: "creds",
      xkey: { pub: "X_PUB", seed: "SX_SEED" },
    },
  }));
  const hostedStore: SecretStore = {
    get: async (key) => provisioned.get(key),
    put: async () => { throw new Error("BUG: the auth-service read path must never put"); },
    delete: async () => { throw new Error("BUG: the auth-service read path must never delete"); },
  };
  const hostedDir = userAuthStateDir(root, "hosted");
  mkdirSync(hostedDir, { recursive: true });
  writeFileSync(join(hostedDir, "idp.json"), JSON.stringify({
    ver: 1, url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example", jwksUri: "https://idp.example/api/auth/jwks",
  }));
  await rejects("a provisioned injected store carries the daemon past the material gate to its broker probe",
    () => runAuthService(argsFor("hosted"), hostedStore),
    "can't reach the broker");

  // ---------- 6. entry points fail BEFORE any non-seam mutation ----------
  console.log("6) degenerate spaces are refused before the entry points touch anything");
  // The exact aliased victim: userAuthStateDir(root, "..") used to normalize to `<root>/.cotal`,
  // and the daemon's pre-flight discovery scrub deleted `<root>/.cotal/auth-service.json` there
  // BEFORE the key guard fired. Plant that sentinel and prove it survives the refusal.
  const sentinel = join(root, ".cotal", "auth-service.json");
  writeFileSync(sentinel, JSON.stringify({ ver: 1, url: "http://127.0.0.1:1", pid: 1, cap: "x" }));
  for (const bad of ["..", "."]) {
    await rejects(`runAuthService --space ${JSON.stringify(bad)} is refused at the space name`,
      () => runAuthService(argsFor(bad), recordingEmpty), "cannot name a space");
    check(`…and the aliased discovery sentinel SURVIVES (no pre-guard mutation, space ${JSON.stringify(bad)})`, existsSync(sentinel));
  }
  // prepareServer: the pre-guard mutation was the IdP probe/pin at a caller-provided dir. With a
  // degenerate space it must refuse FIRST — before the probe fetch and before idp.json exists.
  const aliasedDir = join(root, ".cotal"); // what an unguarded caller would have built for ".."
  await rejects('prepareServer with space ".." is refused before the IdP probe/pin',
    () => cotalAuthProvider.prepareServer({
      space: "..", operatorSeed: "SEED", account: { pub: "P", signingSeed: "S" },
      store: recordingEmpty, dir: aliasedDir, idpUrl: "http://127.0.0.1:1/api/auth",
    }), "cannot name a space");
  check("…and no IdP pin was written at the aliased dir", !existsSync(join(aliasedDir, "idp.json")));

  // ---------- 7. deprovision: the delete half of the pair ----------
  console.log("7) deprovisionSecrets deletes the four kinds through the store, all-attempt + fail-loud");
  const deleted: string[] = [];
  const recordingDeleter: SecretStore = {
    get: async () => undefined,
    put: async () => { throw new Error("BUG: deprovision must never put"); },
    delete: async (key) => { deleted.push(key); },
  };
  await cotalAuthProvider.deprovisionSecrets({ store: recordingDeleter, space: "hosted" });
  check("deprovision deletes exactly the four canonical keys",
    deleted.length === 4 && ["callout.json", "issuer.json", "owner-secret.json", "service-keys.json"]
      .every((f) => deleted.includes(`auth/space.686f73746564/${f}`)), deleted.join(", "));
  const failingDeleter: SecretStore = {
    get: async () => undefined,
    put: async () => { throw new Error("BUG: deprovision must never put"); },
    delete: async (key) => { deleted.push(key); if (key.endsWith("issuer.json")) throw new Error("backend down"); },
  };
  deleted.length = 0;
  await rejects("one failed delete still attempts the rest, then throws naming the key",
    () => cotalAuthProvider.deprovisionSecrets({ store: failingDeleter, space: "hosted" }),
    `1 of 4 keys (${authIssuerKey("hosted")}: backend down`);
  check("…all four deletes were attempted despite the failure", deleted.length === 4, deleted.join(", "));
  // End-to-end on the real filesystem composition: the material section 1 persisted is removed
  // through the store (absent callout = idempotent no-op), leaving no secret files behind.
  await cotalAuthProvider.deprovisionSecrets({ store, space: SPACE });
  check("FS deprovision removes the persisted kinds (absent callout is a no-op)",
    !existsSync(join(userAuthStateDir(root, SPACE), "owner-secret.json")) &&
    !existsSync(join(userAuthStateDir(root, SPACE), "issuer.json")) &&
    !existsSync(join(userAuthStateDir(root, SPACE), "service-keys.json")));
} finally {
  process.chdir(startCwd); // chdir OUT before cleanup (win32 EBUSY on rmdir-of-cwd)
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nAUTH-STORE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;

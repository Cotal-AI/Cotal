/** Broker-free backup trust + retained-principal regression smoke. */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth } from "@cotal-ai/core";
import { userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import {
  cotalAuthProvider,
  ensurePinnedIdp,
  exportSigningKey,
  findInteractiveActor,
  findManagedActor,
  generateSigningKey,
  grantActor,
  loadPinnedIdp,
  USER_AUTH_TRUST_SCHEME,
} from "../src/index.js";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}
async function rejects(name: string, fn: () => unknown | Promise<unknown>, needle: string): Promise<void> {
  try {
    await fn();
    check(`${name} (expected rejection)`, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, message.includes(needle), message);
  }
}

function snapshot(dir: string): string {
  const entries: Array<{ path: string; sha256: string; mode: number; mtimeMs: number }> = [];
  const walk = (path: string, relative: string): void => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const rel = relative ? `${relative}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else entries.push({
        path: rel,
        sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
        mode: st.mode,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  walk(dir, "");
  return JSON.stringify(entries);
}

const SPACE = "backup-auth";
const OWNER = `u_${"a".repeat(26)}`;
const OTHER_OWNER = `u_${"b".repeat(26)}`;
const IDP = "http://127.0.0.1:49151/api/auth";
// The seam split, composed the way the CLI does it: secret kinds ride the store (rooted at
// <root>/.cotal, keys auth/<space>/…), the ledger/pin stay under the state dir — byte-for-byte
// the same on-disk paths, so the drift mutations below poke the exact files the store reads.
const root = mkdtempSync(join(tmpdir(), "cotal-auth-continuity-"));
const dir = userAuthStateDir(root, SPACE);
const store = workspaceSecretStore(root);
const missingRoot = mkdtempSync(join(tmpdir(), "cotal-auth-continuity-missing-"));
const missing = userAuthStateDir(missingRoot, SPACE);
const missingStore = workspaceSecretStore(missingRoot);
mkdirSync(missing, { recursive: true });

try {
  // Pin first so prepareServer remains entirely broker/network-free.
  ensurePinnedIdp(dir, IDP);
  const auth = await createSpaceAuth(SPACE);
  await cotalAuthProvider.prepareServer({
    space: SPACE,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store,
    dir,
  });
  grantActor(dir, {
    owner: OWNER,
    actor: "cli",
    scope: ["spawn", "admin"],
    allowSubscribe: ["ops", "general"],
    allowPublish: ["ops", "general"],
    label: "first label",
  });
  const retained = await cotalAuthProvider.grantAgent({
    store,
    dir,
    space: SPACE,
    owner: OWNER,
    actor: "worker",
    scope: ["spawn"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
    role: "worker",
    parent: `${OWNER}.cli`,
  });

  console.log("A. canonical trust fingerprint");
  const first = await cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE });
  check("fingerprint uses the versioned non-secret scheme", first.scheme === USER_AUTH_TRUST_SCHEME);
  check("fingerprint is a sha256 hex value", /^[0-9a-f]{64}$/.test(first.value));
  await rejects(
    "another space name cannot even address this space's material (key segmentation fails closed)",
    () => cotalAuthProvider.trustFingerprint({ store, dir, space: "other-space" }),
    "missing",
  );
  // The cross-PASTE vector the key segmentation cannot see: this space's documents copied under
  // another space's keys. The issuer's in-document binding still refuses.
  cpSync(join(root, ".cotal", "auth", SPACE), join(root, ".cotal", "auth", "other-space"), { recursive: true });
  await rejects(
    "the same state cannot be fingerprinted as another space",
    () => cotalAuthProvider.trustFingerprint({ store, dir, space: "other-space" }),
    "not space",
  );

  // Rewriting the same authority changes grantedAt/label and reverses set-like lists only.
  grantActor(dir, {
    owner: OWNER,
    actor: "cli",
    scope: ["admin", "spawn"],
    allowSubscribe: ["general", "ops"],
    allowPublish: ["general", "ops"],
    label: "non-authority metadata changed",
  });
  const reordered = await cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE });
  check("set order and non-authority metadata do not change the fingerprint", reordered.value === first.value);

  grantActor(dir, {
    owner: OWNER,
    actor: "cli",
    scope: ["spawn"],
    allowSubscribe: ["general", "ops"],
    allowPublish: ["general", "ops"],
  });
  const narrowed = await cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE });
  check("authority narrowing changes the fingerprint", narrowed.value !== first.value);

  // Restore the original authority before validating the retained child envelope.
  grantActor(dir, {
    owner: OWNER,
    actor: "cli",
    scope: ["spawn", "admin"],
    allowSubscribe: ["ops", "general"],
    allowPublish: ["ops", "general"],
  });

  console.log("B. retained managed principal");
  const beforeReads = snapshot(dir);
  const authority = await cotalAuthProvider.validateRetainedAgent({
    store,
    dir,
    space: SPACE,
    owner: OWNER,
    actor: "worker",
    actorToken: retained.actorToken,
    sentinelCreds: retained.sentinelCreds,
  });
  check(
    "existing token + sentinel reuse the same principal and ledger authority",
    authority.owner === OWNER && authority.actor === "worker" && authority.role === "worker" &&
      authority.parent === `${OWNER}.cli` && authority.scope.join(",") === "spawn",
    authority,
  );
  await rejects(
    "a wrong retained agent token is refused without rotation",
    () => cotalAuthProvider.validateRetainedAgent({ store, dir, space: SPACE, owner: OWNER, actor: "worker", actorToken: "wrong", sentinelCreds: retained.sentinelCreds }),
    "wrong secret",
  );
  await rejects(
    "a foreign retained sentinel is refused",
    () => cotalAuthProvider.validateRetainedAgent({ store, dir, space: SPACE, owner: OWNER, actor: "worker", actorToken: retained.actorToken, sentinelCreds: "wrong" }),
    "does not match",
  );
  await rejects(
    "a missing managed row never provisions a replacement",
    () => cotalAuthProvider.validateRetainedAgent({ store, dir, space: SPACE, owner: OWNER, actor: "missing", actorToken: retained.actorToken, sentinelCreds: retained.sentinelCreds }),
    "unknown agent",
  );
  await rejects(
    "retained material cannot be adopted into another space",
    () => cotalAuthProvider.validateRetainedAgent({ store, dir, space: "other-space", owner: OWNER, actor: "worker", actorToken: retained.actorToken, sentinelCreds: retained.sentinelCreds }),
    "not space",
  );
  rmSync(join(root, ".cotal", "auth", "other-space"), { recursive: true, force: true });
  await cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE });
  check("fingerprint and retained-agent validation do not mutate provider state", snapshot(dir) === beforeReads);

  console.log("C. missing state");
  await rejects(
    "missing trust state fails closed",
    () => cotalAuthProvider.trustFingerprint({ store: missingStore, dir: missing, space: SPACE }),
    "missing the data-account identity",
  );
  check("a missing-state read creates no files", readdirSync(missing).length === 0);

  console.log("D. trust-input drift");
  const serviceKeysPath = join(dir, "service-keys.json");
  const serviceKeysJson = readFileSync(serviceKeysPath, "utf8");
  const otherAuth = await createSpaceAuth("other-account");
  writeFileSync(serviceKeysPath, JSON.stringify({
    ver: 1,
    dataAccount: { pub: otherAuth.account.pub, signingSeed: otherAuth.account.signingSeed },
  }, null, 2));
  await rejects(
    "account identity drift fails its callout binding",
    () => cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE }),
    "callout account JWT",
  );
  writeFileSync(serviceKeysPath, serviceKeysJson);

  const ownerSecretPath = join(dir, "owner-secret.json");
  const ownerSecretJson = readFileSync(ownerSecretPath, "utf8");
  writeFileSync(ownerSecretPath, JSON.stringify({ ver: 1, secretB64: Buffer.alloc(32, 7).toString("base64") }, null, 2));
  const ownerDrift = await cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE });
  check("owner-secret drift changes the fingerprint", ownerDrift.value !== first.value);
  writeFileSync(ownerSecretPath, ownerSecretJson);

  const idpPath = join(dir, "idp.json");
  const idpJson = readFileSync(idpPath, "utf8");
  const pin = loadPinnedIdp(dir)!;
  writeFileSync(idpPath, JSON.stringify({ ver: 1, ...pin, audience: "https://changed.example" }, null, 2));
  const idpDrift = await cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE });
  check("IdP authority drift changes the fingerprint", idpDrift.value !== first.value);
  writeFileSync(idpPath, idpJson);

  const issuerPath = join(dir, "issuer.json");
  const issuerJson = readFileSync(issuerPath, "utf8");
  const replacement = await generateSigningKey();
  writeFileSync(issuerPath, JSON.stringify({
    ver: 1,
    issuer: `urn:cotal:auth:${SPACE}`,
    activeKid: replacement.kid,
    keys: [await exportSigningKey(replacement)],
  }, null, 2));
  const issuerDrift = await cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE });
  check("issuer identity drift changes the fingerprint", issuerDrift.value !== first.value);
  writeFileSync(issuerPath, issuerJson);

  const calloutPath = join(dir, "callout.json");
  const calloutJson = readFileSync(calloutPath, "utf8");
  const calloutFile = JSON.parse(calloutJson) as { callout: { sentinelCreds: string } };
  calloutFile.callout.sentinelCreds += "\n";
  writeFileSync(calloutPath, JSON.stringify(calloutFile, null, 2));
  const sentinelDrift = await cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE });
  check("callout/sentinel trust drift changes the fingerprint", sentinelDrift.value !== first.value);
  writeFileSync(calloutPath, calloutJson);

  console.log("E. canonical ledger paths");
  const managedDir = join(dir, "managed-actors");
  const managedName = `${OWNER}.worker.json`;
  renameSync(join(managedDir, managedName), join(managedDir, "renamed.json"));
  await rejects(
    "a row outside its canonical principal filename is refused",
    () => cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE }),
    "filename does not match",
  );
  renameSync(join(managedDir, "renamed.json"), join(managedDir, managedName));

  const duplicatePath = join(dir, "actors", managedName);
  const managedRow = JSON.parse(readFileSync(join(managedDir, managedName), "utf8")) as Record<string, unknown>;
  delete managedRow.tokenHash;
  writeFileSync(duplicatePath, JSON.stringify(managedRow, null, 2));
  await rejects(
    "the same principal in both ledger spaces is refused",
    () => cotalAuthProvider.trustFingerprint({ store, dir, space: SPACE }),
    "BOTH the interactive and managed row spaces",
  );
  rmSync(duplicatePath);

  console.log("F. direct ledger lookup binding");
  const workerPath = join(managedDir, managedName);
  const workerJson = readFileSync(workerPath, "utf8");
  const retainedB = await cotalAuthProvider.grantAgent({
    store,
    dir,
    space: SPACE,
    owner: OWNER,
    actor: "worker_b",
    scope: [],
    allowSubscribe: ["general"],
    allowPublish: [],
  });
  const workerBPath = join(managedDir, `${OWNER}.worker_b.json`);
  writeFileSync(workerPath, readFileSync(workerBPath));
  const rowBAtRowASnapshot = snapshot(dir);
  await rejects(
    "direct managed lookup detects row B content at row A's canonical path",
    () => findManagedActor(dir, OWNER, "worker"),
    "does not match requested canonical principal",
  );
  await rejects(
    "row B content at row A's canonical path cannot authenticate as row A",
    () => cotalAuthProvider.validateRetainedAgent({
      store,
      dir,
      space: SPACE,
      owner: OWNER,
      actor: "worker",
      actorToken: retainedB.actorToken,
      sentinelCreds: retainedB.sentinelCreds,
    }),
    "unknown agent or wrong secret",
  );
  check("row-B/path-A rejection does not mutate provider state", snapshot(dir) === rowBAtRowASnapshot);
  writeFileSync(workerPath, workerJson);

  const ownerMismatch = JSON.parse(workerJson) as Record<string, unknown>;
  ownerMismatch.owner = OTHER_OWNER;
  delete ownerMismatch.parent;
  writeFileSync(workerPath, JSON.stringify(ownerMismatch, null, 2));
  const ownerMismatchSnapshot = snapshot(dir);
  await rejects(
    "direct managed lookup detects an owner mismatch",
    () => findManagedActor(dir, OWNER, "worker"),
    "does not match requested canonical principal",
  );
  await rejects(
    "a managed row whose owner differs from its requested canonical key is refused",
    () => cotalAuthProvider.validateRetainedAgent({
      store,
      dir,
      space: SPACE,
      owner: OWNER,
      actor: "worker",
      actorToken: retained.actorToken,
      sentinelCreds: retained.sentinelCreds,
    }),
    "unknown agent or wrong secret",
  );
  check("owner-mismatch rejection does not mutate provider state", snapshot(dir) === ownerMismatchSnapshot);
  writeFileSync(workerPath, workerJson);

  const interactivePath = join(dir, "actors", `${OWNER}.cli.json`);
  const interactiveJson = readFileSync(interactivePath, "utf8");
  const actorMismatch = JSON.parse(interactiveJson) as Record<string, unknown>;
  actorMismatch.actor = "other_cli";
  writeFileSync(interactivePath, JSON.stringify(actorMismatch, null, 2));
  const actorMismatchSnapshot = snapshot(dir);
  await rejects(
    "an interactive row whose actor differs from its requested canonical key is refused",
    () => findInteractiveActor(dir, OWNER, "cli"),
    "does not match requested canonical principal",
  );
  check("actor-mismatch rejection does not mutate provider state", snapshot(dir) === actorMismatchSnapshot);
  writeFileSync(interactivePath, interactiveJson);

  if (process.platform !== "win32") {
    const externalRow = join(missing, "worker.json");
    writeFileSync(externalRow, workerJson);
    rmSync(workerPath);
    symlinkSync(externalRow, workerPath);
    await rejects(
      "a canonical row path cannot delegate authority through an identical-byte symlink",
      () => findManagedActor(dir, OWNER, "worker"),
      "non-symlink file",
    );
    rmSync(workerPath);
    writeFileSync(workerPath, workerJson);

    const linkedRowSpace = join(missing, "managed-actors");
    symlinkSync(managedDir, linkedRowSpace, "dir");
    await rejects(
      "a symlinked ledger row-space directory cannot supply managed authority",
      () => findManagedActor(missing, OWNER, "worker"),
      "must be a real directory",
    );
    rmSync(linkedRowSpace);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(missingRoot, { recursive: true, force: true });
}

console.log(`\nbackup continuity smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

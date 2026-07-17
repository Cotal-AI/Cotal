/**
 * FsSecretStore contract smoke: the key→path containment rules (traversal, absolute, NUL, empty,
 * root-itself, and a FILESYSTEM-ROOT base — the `root + sep` prefix regression), the
 * get/put/delete roundtrip (absent → undefined, whole-value replace, idempotent delete), and the
 * byte-for-byte layout invariant (key == relative path, 0600 file under a 0700 parent). Plus the
 * per-agent standing-secret surface: key/path builders off ONE guarded name segment (hostile
 * names refused before any key or path exists), the `clean all` sweep enumeration, and the
 * materialize-to-file projection subprocesses read. Pure filesystem, no broker.
 *
 * Run: pnpm smoke:secret-store
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSecretStore, workspaceSecretStore } from "../src/secret-store-fs.js";
import {
  agentActorTokenKey,
  agentCredsDir,
  agentCredsKey,
  agentSecretFilePaths,
  agentSecretKeysUnder,
  agentSentinelCredsKey,
  materializeSecretToFile,
} from "../src/auth-paths.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`); } };
const rejects = async (name: string, fn: () => Promise<unknown> | unknown, msgPart: string) => {
  try {
    await fn();
    check(`${name} (did not throw)`, false);
  } catch (e) {
    check(name, (e as Error).message.includes(msgPart));
  }
};

const dir = mkdtempSync(join(tmpdir(), "cotal-secret-store-"));
try {
  const store = new FsSecretStore(dir);

  // Roundtrip + layout
  check("absent key → undefined", (await store.get("delivery.creds")) === undefined);
  await store.put("delivery.creds", "v1");
  check("get returns what was put", (await store.get("delivery.creds")) === "v1");
  check("key == relative path on disk (byte-for-byte)", readFileSync(join(dir, "delivery.creds"), "utf8") === "v1");
  if (process.platform !== "win32") {
    check("secret file lands 0600", (statSync(join(dir, "delivery.creds")).mode & 0o777) === 0o600);
  }
  await store.put("delivery.creds", "v2");
  check("put replaces the whole value", (await store.get("delivery.creds")) === "v2");
  await store.put("auth/callout.json", "{}");
  check("nested key creates the parent dir", (await store.get("auth/callout.json")) === "{}");
  if (process.platform !== "win32") {
    check("created parent dir is 0700", (statSync(join(dir, "auth")).mode & 0o777) === 0o700);
  }
  await store.delete("delivery.creds");
  check("after delete, get is absent", (await store.get("delivery.creds")) === undefined);
  await store.delete("delivery.creds"); // must not throw
  check("delete is idempotent", true);

  // Containment (fail-closed key → path)
  await rejects("empty key rejected", () => store.get(""), "invalid key");
  await rejects("NUL key rejected", () => store.get("a\0b"), "invalid key");
  await rejects("absolute key rejected", () => store.get(join(dir, "x")), "must be relative");
  await rejects("root-itself key rejected", () => store.get("."), "under the root");
  await rejects("traversal key rejected", () => store.get("../escape"), "under the root");
  await rejects("nested traversal rejected", () => store.get("a/../../escape"), "under the root");
  check("inside-then-back key stays valid", (await store.get("a/../inside")) === undefined);
  await rejects("empty root rejected at construction", () => new FsSecretStore(""), "root is required");

  // A trailing-separator root normalizes to the same store
  const trailing = new FsSecretStore(dir + (process.platform === "win32" ? "\\" : "/"));
  await trailing.put("trail.creds", "t");
  check("trailing-sep root reads/writes the same tree", (await store.get("trail.creds")) === "t");

  // FILESYSTEM-ROOT base: containment must be via path.relative, not a root+sep prefix (which
  // doubles the separator at "/" and rejects every key). Read-only probes — nothing is written.
  const fsRoot = new FsSecretStore(process.platform === "win32" ? "C:\\" : "/");
  check("root-base get of an absent key → undefined, not a containment throw",
    (await fsRoot.get("definitely-not-present-cotal-secret")) === undefined);
  await rejects("root-base traversal still rejected", () => fsRoot.get(".."), "under the root");

  // ---- per-agent standing secrets: builders, sweep, materialize ----
  const root = mkdtempSync(join(tmpdir(), "cotal-agent-secrets-"));
  try {
    const ws = workspaceSecretStore(root);
    const files = agentSecretFilePaths(root, "smoke-agent");
    await ws.put(agentCredsKey("smoke-agent"), "CREDS");
    await ws.put(agentActorTokenKey("smoke-agent"), "TOKEN");
    await ws.put(agentSentinelCredsKey("smoke-agent"), "SENTINEL");
    check("agent creds key lands byte-for-byte at the canonical path", readFileSync(files.creds, "utf8") === "CREDS");
    check("actor-token key ↔ path", readFileSync(files.actorToken, "utf8") === "TOKEN");
    check("sentinel key ↔ path", readFileSync(files.sentinelCreds, "utf8") === "SENTINEL");
    check("valid name with _ and - builds the expected key", agentCredsKey("a_B-2") === "auth/creds/a_B-2.creds");

    // The guarded segment — executed boundary probes on both surfaces (key AND path builders).
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a b", "../x", "a\0b", "a.b"])
      await rejects(`hostile agent name ${JSON.stringify(bad)} refused by the key builder`, () => agentCredsKey(bad), "unsafe agent name");
    await rejects("hostile agent name refused by the path builder too", () => agentSecretFilePaths(root, "../x"), "unsafe agent name");

    // Sweep enumeration: exactly the three secret kinds; health + strays are NOT keys; the
    // sentinel filename parses under its LONGEST suffix, never as `<x>.sentinel` + `.creds`.
    writeFileSync(join(agentCredsDir(root), "smoke-agent.auth-health.json"), "{}");
    writeFileSync(join(agentCredsDir(root), "weird name.creds"), "stray");
    const keys = agentSecretKeysUnder(root).sort();
    check("sweep finds exactly the three secret kinds",
      keys.length === 3 &&
      keys.includes("auth/creds/smoke-agent.creds") &&
      keys.includes("auth/creds/smoke-agent.actor-token") &&
      keys.includes("auth/creds/smoke-agent.sentinel.creds"));
    check("sweep on a root with no creds dir is empty", agentSecretKeysUnder(mkdtempSync(join(tmpdir(), "cotal-empty-root-"))).length === 0);

    // Materialize: the projection a subprocess reads — store value, 0600, absent key fails loud.
    const target = join(root, "elsewhere", "token-file");
    await materializeSecretToFile(ws, agentActorTokenKey("smoke-agent"), target);
    check("materialize writes the store value at the explicit path", readFileSync(target, "utf8") === "TOKEN");
    if (process.platform !== "win32") {
      check("materialized file lands 0600", (statSync(target).mode & 0o777) === 0o600);
      check("materialize hardens the parent to 0700", (statSync(join(root, "elsewhere")).mode & 0o777) === 0o700);
    }
    await rejects("materialize of an absent key fails loud", () => materializeSecretToFile(ws, agentCredsKey("ghost"), join(root, "x")), "not in the store");

    // The delete half of the pair removes the canonical file (byte-identity).
    await ws.delete(agentActorTokenKey("smoke-agent"));
    check("deleted actor token is gone from disk", !existsSync(files.actorToken));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nSECRET-STORE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

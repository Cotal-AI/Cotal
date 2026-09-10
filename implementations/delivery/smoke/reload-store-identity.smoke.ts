/**
 * The #773 reload-store identity is the store the daemon actually reloads.
 * A `--creds` file in a subdirectory of workspace B must name that directory
 * (the FsSecretStore root), never findCotalRoot() of cwd or of the file.
 * Naming the enclosing workspace would certify a two-root composition.
 *
 * Run: pnpm smoke:reload-store-identity  (no broker)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findCotalRoot } from "@cotal-ai/workspace";
import { reloadStoreIdentityFromCredsPath, reloadStoreIdentityOf } from "../src/delivery.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const throws = (name: string, fn: () => unknown, needle: string) => {
  try {
    fn();
  } catch (e) {
    ok(name, String((e as Error).message).includes(needle), (e as Error).message);
    return;
  }
  throw new Error(`FAIL: ${name} - expected a loud throw`);
};

const dir = mkdtempSync(join(tmpdir(), "cotal-773-id-"));
try {
  const workspaceA = join(dir, "a");
  const workspaceB = join(dir, "b");
  mkdirSync(join(workspaceA, ".cotal"), { recursive: true });
  mkdirSync(join(workspaceB, ".cotal", "space.aa"), { recursive: true });
  const credsB = join(workspaceB, ".cotal", "space.aa", "delivery.creds");
  writeFileSync(credsB, "x");
  const storeDir = dirname(credsB);

  const fromCreds = reloadStoreIdentityFromCredsPath(credsB);
  ok("--creds names the file's directory (the FsSecretStore root)", fromCreds.kind === "fs" && fromCreds.root === storeDir, fromCreds);
  ok("--creds identity is not the enclosing workspace", fromCreds.root !== workspaceB);
  ok("--creds identity is not findCotalRoot of the file", fromCreds.root !== findCotalRoot(dirname(credsB)));
  ok("--creds identity is not cwd A", fromCreds.root !== workspaceA);
  ok("enclosing workspace B is a different findCotalRoot from the --creds store", findCotalRoot(workspaceB) === workspaceB && findCotalRoot(workspaceB) !== fromCreds.root);

  const prev = process.env.COTAL_SECRET_STORE;
  delete process.env.COTAL_SECRET_STORE;
  throws(
    "injected identity refuses a silent local-root fallback",
    () => reloadStoreIdentityOf({ injected: true, identity: { kind: "fs", root: workspaceA } }),
    "COTAL_SECRET_STORE",
  );
  process.env.COTAL_SECRET_STORE = "vault:prod";
  const injected = reloadStoreIdentityOf({ injected: true, identity: { kind: "fs", root: workspaceA } });
  ok("injected identity is the coordinate, never the dummy fs root", injected.kind === "injected" && injected.coordinate === "vault:prod");
  if (prev === undefined) delete process.env.COTAL_SECRET_STORE;
  else process.env.COTAL_SECRET_STORE = prev;

  ok("non-injected identity is the recorded fs root", reloadStoreIdentityOf({ injected: false, identity: { kind: "fs", root: storeDir } }).root === storeDir);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nRELOAD-STORE-IDENTITY SMOKE OK  (${pass} passed)`);

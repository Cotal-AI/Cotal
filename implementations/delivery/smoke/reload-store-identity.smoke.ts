/**
 * The #773 reload-store identity is the store the daemon actually reloads.
 *
 * Canonical `--creds` (`<root>/.cotal/<spaceSegment>/delivery.creds`) names the
 * workstation root, the same identity the canonical arm reports. A `--creds` file
 * outside that two-segment layout names its own directory. `findCotalRoot` is never
 * the identity: walking ancestors would certify a two-root composition.
 *
 * Run: pnpm smoke:reload-store-identity  (no broker)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sameSecretStoreIdentity } from "@cotal-ai/core";
import { findCotalRoot, spaceSegment } from "@cotal-ai/workspace";
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
  const workspaceC = join(dir, "c");
  mkdirSync(join(workspaceA, ".cotal"), { recursive: true });
  mkdirSync(join(workspaceB, ".cotal", "space.aa"), { recursive: true });
  mkdirSync(join(workspaceC, ".cotal", spaceSegment("unified")), { recursive: true });
  const credsB = join(workspaceB, ".cotal", "space.aa", "delivery.creds");
  writeFileSync(credsB, "x");
  const storeDirB = dirname(credsB);
  const credsC = join(workspaceC, ".cotal", spaceSegment("unified"), "delivery.creds");
  writeFileSync(credsC, "x");
  const credsForeign = join(workspaceA, "mounted", "delivery.creds");
  mkdirSync(dirname(credsForeign), { recursive: true });
  writeFileSync(credsForeign, "x");

  const fromB = reloadStoreIdentityFromCredsPath(credsB);
  ok("non-canonical --creds keeps the file's directory", fromB.kind === "fs" && fromB.root === storeDirB, fromB);
  ok("non-canonical --creds is not the enclosing workspace", fromB.root !== workspaceB);
  ok("non-canonical --creds is not findCotalRoot of the file", fromB.root !== findCotalRoot(dirname(credsB)));
  ok("non-canonical --creds is not cwd A", fromB.root !== workspaceA);
  ok("enclosing workspace B is a different findCotalRoot from a non-canonical --creds store", findCotalRoot(workspaceB) === workspaceB && findCotalRoot(workspaceB) !== fromB.root);

  const canonicalArm = { kind: "fs" as const, root: resolve(workspaceC) };
  const fromC = reloadStoreIdentityFromCredsPath(credsC);
  ok("canonical --creds names the workstation root", fromC.kind === "fs" && fromC.root === resolve(workspaceC), fromC);
  ok("canonical --creds agrees with the canonical arm at the same root", sameSecretStoreIdentity(canonicalArm, fromC));
  ok("canonical --creds is not the .cotal/<segment> directory", fromC.root !== dirname(credsC));
  ok("canonical --creds under a different root still diverges", !sameSecretStoreIdentity(canonicalArm, reloadStoreIdentityFromCredsPath(credsB)));
  ok("foreign --creds (no .cotal/<segment>) keeps dirname", reloadStoreIdentityFromCredsPath(credsForeign).root === dirname(resolve(credsForeign)));

  const decoy = join(workspaceC, ".cotal", "auth", spaceSegment("unified"), "delivery.creds");
  mkdirSync(dirname(decoy), { recursive: true });
  writeFileSync(decoy, "x");
  const fromDecoy = reloadStoreIdentityFromCredsPath(decoy);
  ok("decoy .cotal/auth/<segment> does not collapse to the workstation root", fromDecoy.root !== resolve(workspaceC), fromDecoy);
  ok("decoy .cotal/auth/<segment> keeps dirname", fromDecoy.root === dirname(resolve(decoy)));

  const legacyShallow = join(workspaceC, ".cotal", "delivery.creds");
  writeFileSync(legacyShallow, "x");
  const fromLegacy = reloadStoreIdentityFromCredsPath(legacyShallow);
  ok("legacy --creds <root>/.cotal/delivery.creds keeps .cotal, not the workstation root", fromLegacy.root === join(resolve(workspaceC), ".cotal"), fromLegacy);
  ok("legacy shallow --creds still diverges from the canonical arm", !sameSecretStoreIdentity(canonicalArm, fromLegacy));

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

  ok("non-injected identity is the recorded fs root", reloadStoreIdentityOf({ injected: false, identity: { kind: "fs", root: storeDirB } }).root === storeDirB);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nRELOAD-STORE-IDENTITY SMOKE OK  (${pass} passed)`);

/**
 * The #773 reload-store identity is the store the daemon actually reloads.
 *
 * Collapse to the workstation root only for THE FILE THE MANAGER WRITES:
 * `<root>/.cotal/<spaceSegment(space)>/delivery.creds`. Another space's segment,
 * a decoy basename, `.cotal/auth/...`, a legacy shallow path, and a foreign
 * mount keep `dirname`. `findCotalRoot` is never the identity.
 *
 * Run: pnpm smoke:reload-store-identity  (no broker)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sameSecretStoreIdentity } from "@cotal-ai/core";
import { DELIVERY_CREDS_KIND, findCotalRoot, spaceSegment } from "@cotal-ai/workspace";
import { assertUninjectedCredsSharesCwdRoot, reloadStoreIdentityFromCredsPath, reloadStoreIdentityOf } from "../src/delivery.js";

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

const SPACE = "unified";
const OTHER = "other";
const id = (p: string) => reloadStoreIdentityFromCredsPath(p, SPACE);

const dir = mkdtempSync(join(tmpdir(), "cotal-773-id-"));
try {
  const workspaceA = join(dir, "a");
  const workspaceB = join(dir, "b");
  const workspaceC = join(dir, "c");
  mkdirSync(join(workspaceA, ".cotal"), { recursive: true });
  mkdirSync(join(workspaceB, ".cotal", "space.aa"), { recursive: true });
  mkdirSync(join(workspaceC, ".cotal", spaceSegment(SPACE)), { recursive: true });
  mkdirSync(join(workspaceC, ".cotal", spaceSegment(OTHER)), { recursive: true });
  const credsB = join(workspaceB, ".cotal", "space.aa", DELIVERY_CREDS_KIND);
  writeFileSync(credsB, "x");
  const storeDirB = dirname(credsB);
  const credsC = join(workspaceC, ".cotal", spaceSegment(SPACE), DELIVERY_CREDS_KIND);
  writeFileSync(credsC, "x");
  const credsForeign = join(workspaceA, "mounted", DELIVERY_CREDS_KIND);
  mkdirSync(dirname(credsForeign), { recursive: true });
  writeFileSync(credsForeign, "x");

  const fromB = id(credsB);
  ok("non-canonical --creds keeps the file's directory", fromB.kind === "fs" && fromB.root === storeDirB, fromB);
  ok("non-canonical --creds is not the enclosing workspace", fromB.root !== workspaceB);
  ok("non-canonical --creds is not findCotalRoot of the file", fromB.root !== findCotalRoot(dirname(credsB)));
  ok("non-canonical --creds is not cwd A", fromB.root !== workspaceA);
  ok("enclosing workspace B is a different findCotalRoot from a non-canonical --creds store", findCotalRoot(workspaceB) === workspaceB && findCotalRoot(workspaceB) !== fromB.root);

  const canonicalArm = { kind: "fs" as const, root: resolve(workspaceC) };
  const fromC = id(credsC);
  ok("canonical --creds names the workstation root", fromC.kind === "fs" && fromC.root === resolve(workspaceC), fromC);
  ok("canonical --creds agrees with the canonical arm at the same root", sameSecretStoreIdentity(canonicalArm, fromC));
  ok("canonical --creds is not the .cotal/<segment> directory", fromC.root !== dirname(credsC));
  ok("canonical --creds under a different root still diverges", !sameSecretStoreIdentity(canonicalArm, id(credsB)));
  ok("foreign --creds (no .cotal/<segment>) keeps dirname", id(credsForeign).root === dirname(resolve(credsForeign)));

  const decoy = join(workspaceC, ".cotal", "auth", spaceSegment(SPACE), DELIVERY_CREDS_KIND);
  mkdirSync(dirname(decoy), { recursive: true });
  writeFileSync(decoy, "x");
  const fromDecoy = id(decoy);
  ok("decoy .cotal/auth/<segment> does not collapse to the workstation root", fromDecoy.root !== resolve(workspaceC), fromDecoy);
  ok("decoy .cotal/auth/<segment> keeps dirname", fromDecoy.root === dirname(resolve(decoy)));

  const legacyShallow = join(workspaceC, ".cotal", DELIVERY_CREDS_KIND);
  writeFileSync(legacyShallow, "x");
  const fromLegacy = id(legacyShallow);
  ok("legacy --creds <root>/.cotal/delivery.creds keeps .cotal, not the workstation root", fromLegacy.root === join(resolve(workspaceC), ".cotal"), fromLegacy);
  ok("legacy shallow --creds still diverges from the canonical arm", !sameSecretStoreIdentity(canonicalArm, fromLegacy));

  const otherSpace = join(workspaceC, ".cotal", spaceSegment(OTHER), DELIVERY_CREDS_KIND);
  writeFileSync(otherSpace, "x");
  const fromOther = id(otherSpace);
  ok("another space's segment diverges", !sameSecretStoreIdentity(canonicalArm, fromOther), fromOther);
  ok("another space's segment keeps dirname", fromOther.root === dirname(resolve(otherSpace)));

  const wrongKind = join(workspaceC, ".cotal", spaceSegment(SPACE), "decoy.creds");
  writeFileSync(wrongKind, "x");
  const fromWrongKind = id(wrongKind);
  ok("correct segment with a wrong basename diverges", !sameSecretStoreIdentity(canonicalArm, fromWrongKind), fromWrongKind);
  ok("wrong basename keeps dirname", fromWrongKind.root === dirname(resolve(wrongKind)));
  ok("correct space + delivery.creds still SAME", sameSecretStoreIdentity(canonicalArm, id(credsC)));
  ok("canonical arm still agrees", sameSecretStoreIdentity(canonicalArm, fromC));

  assertUninjectedCredsSharesCwdRoot({ injected: false, identity: fromC, cwdRoot: resolve(workspaceC) });
  ok("--creds canonical under the cwd root is accepted", true);
  throws(
    "--creds canonical under a different cwd is refused naming both roots",
    () => assertUninjectedCredsSharesCwdRoot({ injected: false, identity: fromC, cwdRoot: resolve(workspaceA) }),
    resolve(workspaceC),
  );
  throws(
    "--creds vs cwd refusal also names the cwd root",
    () => assertUninjectedCredsSharesCwdRoot({ injected: false, identity: fromC, cwdRoot: resolve(workspaceA) }),
    resolve(workspaceA),
  );
  assertUninjectedCredsSharesCwdRoot({ injected: true, identity: fromC, cwdRoot: resolve(workspaceA) });
  ok("injected composition is unaffected by a cwd mismatch", true);

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

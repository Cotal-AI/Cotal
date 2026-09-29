/**
 * retireManagerInstanceIdentity deletes a space's persisted manager instance identity only when the
 * stored record is the complete expected identity. Every refusal leaves the entry in place, a
 * missing record is a retryable `absent`, and another space's record is never touched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authDir,
  createManagerInstanceIdentity,
  loadManagerInstanceIdentity,
  retireManagerInstanceIdentity,
  saveManagerInstanceIdentity,
  type ManagerInstanceIdentity,
  type RetireManagerInstanceIdentityOpts,
} from "../src/auth-paths.js";

const root = mkdtempSync(join(tmpdir(), "cotal-retire-"));
let passed = 0;
let examined = 0;
let refused = 0;
let removed = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`  ✓ ${name}`); passed++; };
const ident = (n: string, seed = `seed-${n}`): ManagerInstanceIdentity => ({ instanceId: `inst-${n}`, serveIdentity: { id: `U${n}`, seed } });
const file = (space: string) => join(authDir(root), `manager-instance.${Buffer.from(space, "utf8").toString("hex")}.json`);
const retire = (space: string, expected: ManagerInstanceIdentity, opts?: RetireManagerInstanceIdentityOpts) => {
  examined++;
  try {
    const r = retireManagerInstanceIdentity(root, space, expected, opts);
    if (r.outcome === "removed") removed++;
    return r;
  } catch (e) {
    if (!/^manager-instance-identity-retire-refused/.test((e as Error).message)) throw e;
    refused++;
    return { outcome: "refused" as const, error: (e as Error).message };
  }
};
const noStrays = () => readdirSync(authDir(root)).every((n) => !n.includes(".retiring."));

try {
  const created = createManagerInstanceIdentity(root, "alpha", ident("a"));
  const sibling = createManagerInstanceIdentity(root, "beta", ident("b"));

  check("a foreign successor generation refuses", retire("alpha", ident("z")).outcome === "refused");
  check("a successor with the same instanceId but another serve nkey refuses",
    retire("alpha", { instanceId: created.instanceId, serveIdentity: { id: "Uother", seed: created.serveIdentity.seed } }).outcome === "refused");
  check("a successor with the same instanceId and nkey but another seed refuses",
    retire("alpha", { ...created, serveIdentity: { id: created.serveIdentity.id, seed: "seed-other" } }).outcome === "refused");
  check("every refusal leaves the provisioned identity in place", JSON.stringify(loadManagerInstanceIdentity(root, "alpha")) === JSON.stringify(created));

  // Provisioned A, then a successor replaced it: compensation for A must not delete the successor.
  const successor = ident("s");
  saveManagerInstanceIdentity(root, "alpha", successor);
  check("compensating the provisioned identity refuses once a successor holds the space", retire("alpha", created).outcome === "refused");
  check("the successor survives the refused compensation", JSON.stringify(loadManagerInstanceIdentity(root, "alpha")) === JSON.stringify(successor));

  writeFileSync(file("alpha"), "{ not json");
  check("an unparseable record refuses", retire("alpha", successor).outcome === "refused");
  check("the unparseable record is kept", readFileSync(file("alpha"), "utf8") === "{ not json");
  writeFileSync(file("alpha"), JSON.stringify({ instanceId: "inst-s" }));
  check("a malformed record refuses", retire("alpha", successor).outcome === "refused");
  check("the malformed record is kept", existsSync(file("alpha")));

  const outside = join(root, "outside.json");
  writeFileSync(outside, JSON.stringify(successor));
  rmSync(file("alpha"));
  symlinkSync(outside, file("alpha"));
  check("a symlinked record refuses even when its target matches", retire("alpha", successor).outcome === "refused");
  check("the symlink and its target are kept", existsSync(file("alpha")) && readFileSync(outside, "utf8") === JSON.stringify(successor));
  rmSync(file("alpha"));
  mkdirSync(file("alpha"));
  check("a directory at the record path refuses", retire("alpha", successor).outcome === "refused");
  rmSync(file("alpha"), { recursive: true });

  saveManagerInstanceIdentity(root, "alpha", successor);
  check("the complete expected identity is removed", retire("alpha", successor).outcome === "removed");
  check("the removed record is gone and no capture file remains", !existsSync(file("alpha")) && noStrays());
  check("a retry after removal reports absent, not removed", retire("alpha", successor).outcome === "absent");
  check("a space never provisioned reports absent", retire("gamma", ident("g")).outcome === "absent");
  check("the other space's identity is untouched", JSON.stringify(loadManagerInstanceIdentity(root, "beta")) === JSON.stringify(sibling));

  // ── Concurrent race & link-back collision proof (competing writers with real 0600 files) ──
  const raceSpace = "concurrent";
  let racesTriggered = 0;
  const genA = ident("race-a");
  const genB = ident("race-b");
  const genC = ident("race-c");
  const genD = ident("race-d");
  const genE = ident("race-e");

  saveManagerInstanceIdentity(root, raceSpace, genA);
  check("identity file is written with 0600 permissions", (statSync(file(raceSpace)).mode & 0o777) === 0o600);

  // Race 1: Competing writer writes foreign successor genB before renameSync
  const r1 = retire(raceSpace, genA, {
    onBeforeRename: () => {
      racesTriggered++;
      saveManagerInstanceIdentity(root, raceSpace, genB);
    },
  });
  check("a record changed by a competing writer before rename is put back and refuses",
    r1.outcome === "refused" && (r1 as { error?: string }).error?.includes("the record changed before deletion and was put back") === true);
  check("the competing successor survives the race unchanged and uncorrupted",
    JSON.stringify(loadManagerInstanceIdentity(root, raceSpace)) === JSON.stringify(genB));
  check("no stray capture file remains after link-back restoration", noStrays());

  // Race 2: Link-back collision: competing writer 1 writes genC before rename,
  // and competing writer 2 writes genD to canonical path before linkSync
  let capturedCollisionPath = "";
  const r2 = retire(raceSpace, genB, {
    onBeforeRename: () => {
      racesTriggered++;
      saveManagerInstanceIdentity(root, raceSpace, genC);
    },
    onBeforeLinkBack: () => {
      racesTriggered++;
      const strays = readdirSync(authDir(root)).filter((n) => n.includes(".retiring."));
      if (strays.length > 0) capturedCollisionPath = join(authDir(root), strays[0]);
      saveManagerInstanceIdentity(root, raceSpace, genD);
    },
  });
  check("link-back collision preserves both generations and refuses naming captured path",
    r2.outcome === "refused" &&
    (r2 as { error?: string }).error?.includes("the record changed before deletion and could not be put back; it is kept at") === true &&
    capturedCollisionPath.length > 0 && (r2 as { error?: string }).error?.includes(capturedCollisionPath) === true);
  check("the successor written during link-back survives at canonical path",
    JSON.stringify(loadManagerInstanceIdentity(root, raceSpace)) === JSON.stringify(genD));
  check("the captured record is preserved at its captured path",
    existsSync(capturedCollisionPath) &&
    JSON.stringify(JSON.parse(readFileSync(capturedCollisionPath, "utf8"))) === JSON.stringify(genC));
  rmSync(capturedCollisionPath);

  // Race 3: Competing removal before rename (competing process unlinks canonical file)
  saveManagerInstanceIdentity(root, raceSpace, genD);
  const r3 = retire(raceSpace, genD, {
    onBeforeRename: () => {
      racesTriggered++;
      rmSync(file(raceSpace));
    },
  });
  check("competing removal before rename reports absent", r3.outcome === "absent");
  check("no stray files remain after competing removal", noStrays());

  // Clean retirement of true owned complete identity
  saveManagerInstanceIdentity(root, raceSpace, genE);
  check("a true owned complete identity can retire cleanly", retire(raceSpace, genE).outcome === "removed");
  check("the retired identity is gone and no strays remain", !existsSync(file(raceSpace)) && noStrays());
  check("a retry after retirement reports absent", retire(raceSpace, genE).outcome === "absent");

  check("all 4 intended race conditions actually executed", racesTriggered === 4);
  check("exact counts: 16 examined, 10 refused, 2 removed", examined === 16 && refused === 10 && removed === 2);
  console.log(`manager instance retire: ${passed} passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

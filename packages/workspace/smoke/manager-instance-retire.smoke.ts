/**
 * retireManagerInstanceIdentity deletes a space's persisted manager instance identity only when the
 * stored record is the complete expected identity. Every refusal leaves the entry in place, a
 * missing record is a retryable `absent`, and another space's record is never touched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authDir,
  createManagerInstanceIdentity,
  loadManagerInstanceIdentity,
  retireManagerInstanceIdentity,
  saveManagerInstanceIdentity,
  type ManagerInstanceIdentity,
} from "../src/auth-paths.js";

const root = mkdtempSync(join(tmpdir(), "cotal-retire-"));
let passed = 0;
let examined = 0;
let refused = 0;
let removed = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`  ✓ ${name}`); passed++; };
const ident = (n: string, seed = `seed-${n}`): ManagerInstanceIdentity => ({ instanceId: `inst-${n}`, serveIdentity: { id: `U${n}`, seed } });
const file = (space: string) => join(authDir(root), `manager-instance.${Buffer.from(space, "utf8").toString("hex")}.json`);
const retire = (space: string, expected: ManagerInstanceIdentity) => {
  examined++;
  try {
    const r = retireManagerInstanceIdentity(root, space, expected);
    if (r.outcome === "removed") removed++;
    return r;
  } catch (e) {
    if (!/^manager-instance-identity-retire-refused/.test((e as Error).message)) throw e;
    refused++;
    return { outcome: "refused" as const };
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
  check("exact counts: 11 examined, 8 refused, 1 removed", examined === 11 && refused === 8 && removed === 1);
  console.log(`manager instance retire: ${passed} passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

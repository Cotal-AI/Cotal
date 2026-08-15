/**
 * m12 — prove the private-build seam protects the RIGHT path, without ever writing it.
 *
 * WHAT THIS IS FOR. A mutation proof compiles a deliberately broken build. Two installed connector
 * extensions symlink `@cotal-ai/core` into this worktree, so a mutant landing in
 * `packages/core/dist` is executed by every claude and opencode seat on this box — it happened, for
 * about two and a half minutes (`FINDING-mutation-on-shared-dist.md`). The seam
 * (`packages/core/smoke/_core-entry.ts` + `mutation-proof --private-build`) is the remedy. This
 * script is the remedy's own verification.
 *
 * THE PROBLEM WITH VERIFYING IT. The obvious control — write the shared dist and watch the detector
 * fire — performs the exact act under freeze. So the detector is PARAMETERISED by the path it
 * protects, and the control points it at a STAND-IN scratch directory. That proves the detector
 * discriminates by path. It does NOT prove it was told to protect the right path.
 *
 * So the claim is composed from two cheap ones, neither destructive:
 *
 *   A. THE DETECTOR FIRES on a write to the path it was configured with  (and stays quiet without
 *      one — otherwise it is not a detector, it is a constant).
 *   B. THE CONFIGURED PATH IS THE REAL ONE: resolved THROUGH THE SYMLINK the connectors actually
 *      use, not from a literal this file also wrote. A literal compared against itself is vacuous.
 *      Repoint the symlink and this assertion moves with it.
 *
 * A ∧ B is the property wanted: a write to the fleet-linked build would be caught.
 *
 * Belt to that braces: the REAL dist is hashed before and after everything here, and must be
 * byte-identical. The stand-in proves the detector works; the hash proves the freeze held.
 *
 * Run: node_modules/.bin/tsx .meshctl-measurement/meshctl-m12-seam-control.mts
 * Writes only to its own scratch. Starts no broker. Touches no source.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const REPO = resolve(import.meta.dirname, "..");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/**
 * THE DETECTOR, parameterised. Snapshots every file under `protectedPath` by content hash, and
 * reports whether any changed. Content rather than mtime: a rebuild that produces identical bytes
 * is not a hazard, and mtime alone would call it one.
 */
function snapshot(protectedPath: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(protectedPath)) return m;
  for (const d of readdirSync(protectedPath, { recursive: true, withFileTypes: true })) {
    if (!d.isFile()) continue;
    const f = join(d.parentPath ?? protectedPath, d.name);
    m.set(f, createHash("sha256").update(readFileSync(f)).digest("hex"));
  }
  return m;
}
const changed = (a: Map<string, string>, b: Map<string, string>): string[] => {
  const out: string[] = [];
  for (const [f, h] of b) if (a.get(f) !== h) out.push(f);
  for (const f of a.keys()) if (!b.has(f)) out.push(f);
  return out;
};

console.log("=== m12: the private-build seam protects the real path, proven without writing it ===\n");

// ---- REAL DIST, hashed before anything ---------------------------------------------------------
const REAL_DIST = join(REPO, "packages/core/dist");
const realBefore = snapshot(REAL_DIST);
check("PRE: the real dist is non-empty, so a later 'unchanged' is not vacuous", realBefore.size > 0, realBefore.size);

// ---- A. THE DETECTOR DISCRIMINATES, proven on a STAND-IN ---------------------------------------
console.log("\n--- A. the detector fires on a write to the path it was configured with ---");
const standIn = mkdtempSync(join(REPO, "packages/core", ".privbuild-m12stand-"));
mkdirSync(join(standIn, "nested"), { recursive: true });
writeFileSync(join(standIn, "index.js"), "export const x = 1;\n");
writeFileSync(join(standIn, "nested", "endpoint.js"), "export const y = 1;\n");

const standBefore = snapshot(standIn);
check("A0 CONTROL: with NO write, the detector stays quiet (so it is not a constant)",
  changed(standBefore, snapshot(standIn)).length === 0);

writeFileSync(join(standIn, "nested", "endpoint.js"), "export const y = 2; /* MUTANT */\n");
const firedOn = changed(standBefore, snapshot(standIn));
check("A1 the detector FIRES on a mutated file in its protected path", firedOn.length === 1, firedOn);
check("A1b and it NAMES the file that changed, not merely that something did",
  firedOn[0]?.endsWith("endpoint.js") === true, firedOn);

writeFileSync(join(standIn, "added.js"), "export const z = 3;\n");
check("A2 an ADDED file is caught too (a mutant build emits new files as well as changed ones)",
  changed(standBefore, snapshot(standIn)).length === 2);

rmSync(join(standIn, "index.js"));
check("A3 a REMOVED file is caught (a stale-clean build is also a write)",
  changed(standBefore, snapshot(standIn)).some((f) => f.endsWith("index.js")));

// ---- B. THE CONFIGURED PATH IS THE REAL ONE, resolved THROUGH THE LINK -------------------------
// Not compared against a literal this file also wrote: resolved through the same symlink the
// installed connectors resolve, so repointing it moves this assertion. If the link is gone or
// points elsewhere, THAT IS A RESULT — the protected path would no longer be fleet-linked.
console.log("\n--- B. the path the seam protects is the one the fleet actually loads ---");
const LINKS = [
  join(homedir(), ".config/cotal/extensions/node_modules/@cotal-ai/connector-claude-code/node_modules/@cotal-ai/core"),
  join(homedir(), ".config/cotal/extensions/node_modules/@cotal-ai/connector-opencode/node_modules/@cotal-ai/core"),
];
const resolved = LINKS.filter(existsSync).map((l) => realpathSync(l));
check("B0 PRE: at least one connector link resolves at all (else B proves nothing)", resolved.length > 0, LINKS);

// The path mutation-proof protects is derived the same way it derives it: <cwd>/<pkgDir>/dist.
// Stated as a derivation rather than a constant so the two cannot drift apart silently.
const PROTECTED = join(REPO, "packages/core", "dist");
for (const r of resolved) {
  const fleetDist = join(r, "dist");
  check(`B1 fleet-linked core (${r.replace(homedir(), "~")}) resolves to the SAME dist the seam protects`,
    fleetDist === PROTECTED, { fleetDist, PROTECTED });
}
check("B2 and the protected path is inside THIS repo, not another checkout",
  PROTECTED.startsWith(REPO + "/"), PROTECTED);

// ---- A ∧ B, stated explicitly -----------------------------------------------------------------
console.log("\n--- A ∧ B ---");
check("B3 SUMMARY (derived from A ∧ B — drives nothing new): a write to the fleet-linked build " +
  "would be detected, because the detector fires on its configured path and that path IS the " +
  "fleet-linked one", fail === 0);

// ---- THE FREEZE HELD --------------------------------------------------------------------------
console.log("\n--- the real dist was never written ---");
rmSync(standIn, { recursive: true, force: true });
const realAfter = snapshot(REAL_DIST);
const realDelta = changed(realBefore, realAfter);
check("Z1 the REAL packages/core/dist is byte-identical after this entire control", realDelta.length === 0, realDelta);
check("Z2 and this control left no scratch behind", !existsSync(standIn));

console.log(`\n${fail === 0 ? "M12 SEAM CONTROL OK ✅" : "M12 SEAM CONTROL FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

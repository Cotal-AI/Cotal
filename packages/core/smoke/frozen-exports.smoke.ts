/**
 * The CLASS-CLOSURE guard for the exported-mutable-security-collection class (afa715b/be454a7,
 * the panel's find-N-miss-M convergence). Every prior instance was found REACTIVELY: a conceded
 * HIGH, then a cold read asking "any OTHER mutable security export?". A manual sweep certifies the
 * hash it ran on; it does NOT enforce the next export. This smoke IS the enforcement: it
 * dynamically enumerates every runtime export of `@cotal-ai/core` and recursively asserts every
 * exported array and plain-object collection is deep-frozen. A NEW export added without freezing
 * fails HERE, at authoring time, not in the following audit.
 *
 * The reasoning (the WHAT/WHY/NEXT the failure teaches): TypeScript `readonly`/`as const` is
 * type-level only; at runtime an exported array/object is mutable, and any seam that reads it live
 * (a grant builder, a validator, a head-arity guard) can have its decision changed by a
 * post-import mutation. Freezing at declaration closes that; a seam on the mint/authz path should
 * ALSO read a private module-load snapshot (e.g. AUTHORITY_HEAD_ARITY) so it survives even a
 * defeated freeze. Over-freezing a non-security vocabulary is harmless, so the guard freezes
 * EVERY exported collection, no security allowlist to drift.
 *
 * Run: pnpm smoke:frozen-exports   (broker-free; part of smoke:ci)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as core from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

/** A plain data object (its own vocabulary), not a class instance / function / exotic. Class
 *  instances (prototype !== Object.prototype) are runtime machinery, not a declared collection. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Recursively assert every array / plain-object reachable from an exported root is frozen.
 *  Cycle-safe (a WeakSet of visited containers). Returns the FIRST unfrozen path, or null. */
function firstUnfrozen(root: unknown, path: string, seen: WeakSet<object>): string | null {
  if (typeof root !== "object" || root === null) return null;
  const isArr = Array.isArray(root);
  if (!isArr && !isPlainObject(root)) return null; // functions, class instances, Maps/Sets: not declared collections
  if (seen.has(root)) return null;
  seen.add(root);
  if (!Object.isFrozen(root)) return path;
  // Recurse into members (a frozen array of unfrozen defs is still a hole, the afa715b case).
  const entries: [string, unknown][] = isArr
    ? (root as unknown[]).map((v, i) => [`[${i}]`, v])
    : Object.entries(root as Record<string, unknown>);
  for (const [k, v] of entries) {
    const hit = firstUnfrozen(v, isArr ? `${path}${k}` : `${path}.${k}`, seen);
    if (hit !== null) return hit;
  }
  return null;
}

// Self-test: the detector must CATCH an unfrozen collection (a green run over core must mean the
// guard works, not that it is blind). A frozen array holding an unfrozen def is a hole too.
c("the detector flags a top-level unfrozen array", firstUnfrozen(["x"], "fake", new WeakSet()) === "fake");
c("the detector flags an unfrozen nested def inside a frozen array (the afa715b shape)",
  firstUnfrozen(Object.freeze([{ a: 1 }]), "fake", new WeakSet()) === "fake[0]");
c("the detector passes a deep-frozen structure",
  firstUnfrozen(Object.freeze([Object.freeze({ a: 1 })]), "fake", new WeakSet()) === null);
c("the detector ignores a class instance (not a declared collection)",
  firstUnfrozen(new WeakSet(), "fake", new WeakSet()) === null);

const seen = new WeakSet<object>();
const roots = Object.entries(core as Record<string, unknown>);
let arrays = 0, objects = 0;
const misses: string[] = [];
for (const [name, value] of roots) {
  if (Array.isArray(value)) arrays++;
  else if (isPlainObject(value)) objects++;
  else continue; // only array / plain-object exports are declared collections
  const hit = firstUnfrozen(value, name, seen);
  if (hit !== null) misses.push(hit);
}

// The single load-bearing assertion, with the teaching message baked into the failure output.
if (misses.length > 0) {
  for (const m of misses) {
    console.log(`  ✗ FAIL: exported collection ${JSON.stringify(m)} is NOT runtime-frozen.`);
    console.log(`      WHY: TypeScript readonly is type-only; a seam that reads this live (a grant`);
    console.log(`           builder / validator / head-arity guard) can be defeated by a`);
    console.log(`           post-import mutation (the afa715b identity-vs-integrity class).`);
    console.log(`      FIX: Object.freeze it at declaration (deep-freeze its members too), and if a`);
    console.log(`           mint/authz seam reads it, also compile a private module-load snapshot`);
    console.log(`           the seam consults instead of the live export (see AUTHORITY_HEAD_ARITY).`);
  }
  fail += misses.length;
} else {
  ok++;
}
c(`every exported array (${arrays}) and plain-object (${objects}) collection in @cotal-ai/core is deep-frozen`, misses.length === 0, misses);

// The COMPLETENESS coupling (the critic's 212781d argument): scanning `core.*` covers the WHOLE
// external-mutation surface ONLY because core's package `exports` map exposes no collection OFF the
// barrel. The map is the barrel "." plus a bounded allow-list of RE-EXPORT-ONLY subpaths — a
// subpath is safe ONLY if every runtime export it exposes is the SAME object the barrel already
// scanned + froze (identity), so it adds no new mutation surface. A future "./*" wildcard, an
// opaque deep-import subpath, or a subpath exposing an off-barrel collection fails HERE, at
// authoring time. (P2 item 6 added "./session-browser": the browser-safe session rail + frame
// codec re-export for the console bundle.)
{
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { exports?: Record<string, unknown> };
  const keys = Object.keys(pkg.exports ?? {});
  const ALLOWED_SUBPATHS = new Set(["./session-browser"]);
  const unexpected = keys.filter((k) => k !== "." && !ALLOWED_SUBPATHS.has(k));
  c(`core's package "exports" map is the barrel "." plus only allow-listed re-export subpaths (no wildcard/opaque deep import)`,
    keys.includes(".") && unexpected.length === 0, unexpected);
  // Prove each allow-listed subpath is a faithful RE-EXPORT of barrel-covered symbols: every
  // runtime export it exposes is IDENTICAL (===) to the barrel's same-named export, so it can
  // surface no collection the barrel scan above did not already reach and freeze.
  const sb = await import("../src/session-browser.js") as Record<string, unknown>;
  const offBarrel = Object.keys(sb).filter((k) => sb[k] !== (core as Record<string, unknown>)[k]);
  c(`"./session-browser" is a faithful re-export (every export === the barrel's, so no off-barrel collection)`, offBarrel.length === 0, offBarrel);
}

console.log(`\nFROZEN-EXPORTS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed; ${arrays} arrays + ${objects} plain-objects scanned)`);
if (fail > 0) process.exit(1);

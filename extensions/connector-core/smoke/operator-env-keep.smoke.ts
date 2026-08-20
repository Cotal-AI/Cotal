/**
 * OPERATOR_ENV_KEEP completeness, DERIVED FROM THE CONNECTOR SOURCES.
 *
 * WHAT THE DESIGN RESTS ON. `launchEnv` resets Cotal's whole `COTAL_*` prefix and then re-adds
 * {@link OPERATOR_ENV_KEEP}. The prefix strip needs no maintenance: a connector that starts setting
 * a new `COTAL_` name is covered the day it is written, which is the entire reason the reset is a
 * prefix and not a deny-list. The re-added list is the half that CAN rot, and it rots in exactly one
 * direction - somebody adds a name to it that a connector actually assigns per spawn, and that
 * name silently starts crossing from one agent into the next.
 *
 * THE PROPERTY, STATED AS A TEST RATHER THAN AS A DOC COMMENT. A name qualifies for the keep list
 * if and only if NO connector assigns it per spawn. That is checkable against the sources instead of
 * against a second hand-written list, so it cannot drift the way a snapshot does: this census reads
 * the connectors themselves and intersects what they assign with what the production list keeps.
 *
 * WHAT THIS DOES NOT CLAIM. It does not prove the keep list is COMPLETE in the other direction (that
 * every safe name is on it); an absent name simply means a child does not get it, which is a
 * usability question and not a containment one. It grades the direction that leaks.
 *
 * Run: pnpm smoke:operator-env-keep
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATOR_ENV_KEEP } from "../src/launch.js";

const extensionsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every connector/adapter source file. Keyed on location rather than a hardcoded list of the five
 *  connectors that exist today, so a SIXTH is graded the day it is added rather than the day someone
 *  remembers to extend this file. That is the same reasoning the prefix strip rests on. */
function* connectorSources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    // Suites are excluded, and by SHAPE rather than by one spelling: they live under a `smoke/`
    // directory, or are named `x.smoke.ts`, or are a bare `smoke.ts` beside the package. Missing the
    // third spelling is not hypothetical - `orca/smoke.ts` assigns COTAL_ORCA_BIN to build a
    // fixture, and an earlier version of this census read that as a connector assigning it per
    // spawn and reddened on a name that is genuinely operator-level.
    if (e.isDirectory()) { if (e.name !== "smoke") yield* connectorSources(p); }
    else if (e.name.endsWith(".ts") && !e.name.includes(".smoke.") && e.name !== "smoke.ts" && statSync(p).size < 2_000_000) yield p;
  }
}

/** A per-spawn assignment, written the way the connectors write it: `env.COTAL_X = ...`,
 *  `COTAL_X: value` inside the env literal, or a computed `env[LAUNCH_MATERIAL_ENV]`-style entry
 *  resolved through its constant. Matching the ASSIGNMENT and not a bare mention is what keeps a
 *  doc comment or an import from registering as a producer. */
const ASSIGN = [
  /\benv\.(COTAL_[A-Z0-9_]+)\s*=/g,
  /^\s*(COTAL_[A-Z0-9_]+):\s/gm,
  /\[(LAUNCH_MATERIAL_ENV)\]\s*:/g,
];
/** `LAUNCH_MATERIAL_ENV` is a constant, not a literal name. Resolve it, or the sharpest variable in
 *  the codebase would be invisible to a census that only reads string literals. */
const CONSTANTS: Record<string, string> = { LAUNCH_MATERIAL_ENV: "COTAL_LAUNCH_MATERIAL" };

const assigned = new Map<string, string>(); // name -> first file that assigns it
for (const file of connectorSources(extensionsRoot)) {
  const body = readFileSync(file, "utf8");
  for (const re of ASSIGN) {
    for (const m of body.matchAll(re)) {
      const name = CONSTANTS[m[1]] ?? m[1];
      if (!assigned.has(name)) assigned.set(name, relative(extensionsRoot, file).split("\\").join("/"));
    }
  }
}

// A census that found nothing is not a pass. Connectors assign these constantly, so a zero here
// means the scan stopped seeing files, not that the tree became clean.
assert.ok(
  assigned.size >= 10,
  `the census found only ${assigned.size} per-spawn COTAL_ assignments across the connectors, which means the scan is broken rather than the tree being clean`,
);

// THE INVARIANT. Every name the keep list carries must be one no connector assigns.
const conflicts = [...OPERATOR_ENV_KEEP].filter((k) => assigned.has(k));
assert.deepEqual(
  conflicts.map((k) => `${k} (assigned in ${assigned.get(k)})`),
  [],
  "OPERATOR_ENV_KEEP names a variable that a connector assigns PER SPAWN. Inheriting it means one " +
    "agent's value reaching another agent that was never given it. Remove the name from the keep " +
    "list; the prefix strip already covers it, and a per-spawn name never needed to be inherited.",
);

// The census must actually see the dangerous families, or the intersection above is empty for the
// wrong reason: a scan that missed the connectors entirely would also report no conflicts.
for (const witness of ["COTAL_LIFECYCLE_UID", "COTAL_ROLE", "COTAL_LAUNCH_MATERIAL"])
  assert.ok(
    assigned.has(witness),
    `the census did not see ${witness} being assigned, so its "no conflicts" result is not evidence of anything`,
  );

console.log(
  `operator-env-keep smoke: ${assigned.size} per-spawn COTAL_ names found across the connectors, ` +
    `${OPERATOR_ENV_KEEP.length} keep-list names, 0 conflicts`,
);

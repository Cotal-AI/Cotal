/**
 * OPERATOR_ENV_KEEP completeness, DERIVED FROM THE CONNECTOR SOURCES.
 *
 * WHAT THE DESIGN RESTS ON. `launchEnv` builds the child from a fixed OS allow-list and then copies
 * {@link OPERATOR_ENV_KEEP} by name. There is no inherit mode, so a connector that starts setting a
 * new `COTAL_` name cannot leak it: the name is simply not on the keep list. The keep list is the
 * half that CAN rot, and it rots in exactly one direction - somebody adds a name to it that a
 * connector actually assigns per spawn, and that name silently starts crossing from one agent into
 * the next.
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
import { strict as nodeAssert } from "node:assert";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { OPERATOR_ENV_KEEP } from "../src/launch.js";
import { ASSIGN, extensionsRoot, perSpawnAssignments, repoRoot, sources } from "./_per-spawn-census.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

/** THIS CENSUS'S OWN BOUNDARY, CHECKED RATHER THAN ASSUMED.
 *
 *  Assignments are read from `extensions/`. That is the right scope only while every
 *  `launchEnv` caller either lives there or contributes no `COTAL_*` name of its own, and nothing in
 *  the census can notice when that stops being true: a scan's blind spot and a clean tree produce the
 *  same output.
 *
 *  It is not hypothetical that callers live elsewhere. Two example composition roots call
 *  `launchEnv()`, and the first version of this guard - which simply required every caller to sit
 *  under `extensions/` - reddened on them. They are legitimate: an example configures and
 *  orchestrates and adds no env names of its own, which is exactly the property asserted here.
 *  Requiring the PROPERTY rather than the LOCATION is what keeps this from being an allow-list that
 *  rots the same way the keep list would.
 */
const callers = [...sources(repoRoot)].filter((f) => /(?<!function )\blaunchEnv\(/.test(readFileSync(f, "utf8")));
assert.ok(
  callers.length >= 5,
  `found only ${callers.length} launchEnv call sites, so this boundary check is not reading the tree`,
);
assert.deepEqual(
  callers
    .filter((f) => !f.startsWith(extensionsRoot))
    .filter((f) => ASSIGN.some((re) => new RegExp(re.source, re.flags).test(readFileSync(f, "utf8"))))
    .map((f) => relative(repoRoot, f).split("\\").join("/")),
  [],
  "a launchEnv caller outside extensions/ assigns a COTAL_ name into the env it spawns with. This " +
    "census does not walk that file, so its keep-list result is blind to it: widen `sources` to " +
    "cover that tree, or the census will keep reporting 0 conflicts about code it never reads.",
);

const assigned = perSpawnAssignments();

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
// The last two are the constant-indirected assignments this census used to be blind to, one of them
// bound in a different file from its use. They are witnesses rather than history: if constant
// resolution ever stops working, these go missing while the other connectors keep the count high and
// the anti-vacuity floor above stays satisfied.
for (const witness of [
  "COTAL_LIFECYCLE_UID", "COTAL_ROLE", "COTAL_LAUNCH_MATERIAL",
  "COTAL_CODEX_REMOTE_TOKEN", "COTAL_MCP_TOKEN",
])
  assert.ok(
    assigned.has(witness),
    `the census did not see ${witness} being assigned, so its "no conflicts" result is not evidence of anything`,
  );

console.log(
  `operator-env-keep smoke: ${assigned.size} per-spawn COTAL_ names found across the connectors, ` +
    `${OPERATOR_ENV_KEEP.length} keep-list names, 0 conflicts, ` +
    `${callers.length} launchEnv call sites, none outside the walked tree contributing a COTAL_ name`,
);
emitSentinel({ passed: cells(), failed: 0 });

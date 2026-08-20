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
const repoRoot = join(extensionsRoot, "..");

/** Every connector/adapter source file. Keyed on location rather than a hardcoded list of the five
 *  connectors that exist today, so a SIXTH is graded the day it is added rather than the day someone
 *  remembers to extend this file. That is the same reasoning the prefix strip rests on. */
function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    // Suites are excluded, and by SHAPE rather than by one spelling: they live under a `smoke/`
    // directory, or are named `x.smoke.ts`, or are a bare `smoke.ts` beside the package. Missing the
    // third spelling is not hypothetical - `orca/smoke.ts` assigns COTAL_ORCA_BIN to build a
    // fixture, and an earlier version of this census read that as a connector assigning it per
    // spawn and reddened on a name that is genuinely operator-level.
    if (e.isDirectory()) { if (e.name !== "smoke") yield* sources(p); }
    else if (e.name.endsWith(".ts") && !e.name.includes(".smoke.") && e.name !== "smoke.ts" && statSync(p).size < 2_000_000) yield p;
  }
}

/** A per-spawn assignment, matched BY SHAPE. Four forms, because the connectors use four:
 *  `env.COTAL_X = v`, a `COTAL_X: v` entry, a computed `[IDENT]: v` key, and a bracket-string
 *  `env["COTAL_X"] = v`. Matching the ASSIGNMENT rather than a bare mention is what keeps a doc
 *  comment or an import from registering as a producer.
 *
 *  WHY THE COMPUTED FORM RESOLVES A MAP AND NOT A NAME. This pattern was once literally
 *  `/\[(LAUNCH_MATERIAL_ENV)\]\s*:/`, with the constant baked into the regex. That did not miss a
 *  SHAPE; it matched the right shape and then refused every instance of it except the one the author
 *  had in mind. Two real per-spawn assignments were invisible to it - `[TOKEN_ENV]` in codex's tui.ts
 *  and `[MCP_TOKEN_ENV]` in its host.ts, the latter declared in a different file again - and adding
 *  those two names to a lookup would have rebuilt the same failure one level up, silent again the day
 *  a third constant is declared. So the constants are DERIVED from the tree: any `const IDENT =
 *  "COTAL_..."` anywhere in the walked sources, collected in a first pass, resolved in the second.
 *  A new constant is graded the day it is written, which is what the prefix strip and the by-shape
 *  file walk already rest on.
 *
 *  The declarations are collected from the WHOLE repo while assignments are still only read from
 *  `extensions/`, and the difference is not an oversight. `LAUNCH_MATERIAL_ENV` is declared in
 *  `packages/core`, so a map built from the connectors alone cannot resolve the sharpest name in the
 *  codebase - the first version of this repair narrowed the map to `extensions/` and the
 *  `COTAL_LAUNCH_MATERIAL` witness below went red on exactly that. Collecting declarations wider is
 *  safe because a declaration only ever RESOLVES a name; it never adds an assignment. */
const CONST_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*"(COTAL_[A-Z0-9_]+)"/g;
const constants = new Map<string, string>();
for (const file of sources(repoRoot))
  for (const m of readFileSync(file, "utf8").matchAll(CONST_DECL)) {
    const prev = constants.get(m[1]);
    assert.ok(
      prev === undefined || prev === m[2],
      `two different COTAL_ names are bound to the constant ${m[1]} (${prev} and ${m[2]}); this ` +
        `census resolves computed keys by constant name across the tree and cannot disambiguate them`,
    );
    constants.set(m[1], m[2]);
  }

const ASSIGN = [
  /\benv\.(COTAL_[A-Z0-9_]+)\s*=/g,
  /^\s*(COTAL_[A-Z0-9_]+):\s/gm,
  /\[([A-Za-z_$][\w$]*)\]\s*:/g,
  /\benv\[\s*["'](COTAL_[A-Z0-9_]+)["']\s*\]\s*=/g,
];

/** THIS CENSUS'S OWN BOUNDARY, CHECKED RATHER THAN ASSUMED.
 *
 *  Assignments above are read from `extensions/`. That is the right scope only while every
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

const assigned = new Map<string, string>(); // name -> first file that assigns it
for (const file of sources(extensionsRoot)) {
  const body = readFileSync(file, "utf8");
  for (const re of ASSIGN) {
    for (const m of body.matchAll(re)) {
      const name = m[1].startsWith("COTAL_") ? m[1] : constants.get(m[1]);
      if (name === undefined) continue; // a computed key bound to something that is not a COTAL_ name
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

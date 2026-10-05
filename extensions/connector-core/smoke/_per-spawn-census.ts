/**
 * The per-spawn `COTAL_` census, as a function rather than a suite, so a second instrument can
 * grade it. `operator-env-keep` intersects its result with the keep list; `seat-env-scope` A10
 * requires every `COTAL_` name a real `buildLaunch` emits to be in it. The two fail in opposite
 * directions: this parser is silent about spellings it does not recognise, and observation is
 * silent about paths nobody drives. Each checks the other's blind spot.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const extensionsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const repoRoot = join(extensionsRoot, "..");

/** Every connector/adapter source file. Keyed on location rather than a hardcoded list of the five
 *  connectors that exist today, so a SIXTH is graded the day it is added rather than the day someone
 *  remembers to extend this file. That is the same reasoning the prefix strip rests on. */
export function* sources(dir: string): Generator<string> {
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
 *  `COTAL_LAUNCH_MATERIAL` witness in `operator-env-keep` went red on exactly that. Collecting
 *  declarations wider is safe because a declaration only ever RESOLVES a name; it never adds an
 *  assignment.
 *
 *  These patterns still learn spellings one at a time. A spelling they miss on a path `buildLaunch`
 *  drives is caught by `seat-env-scope` A10; one on a path nothing drives is not caught by either. */
const CONST_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*"(COTAL_[A-Z0-9_]+)"/g;

export const ASSIGN = [
  /\benv\.(COTAL_[A-Z0-9_]+)\s*=/g,
  /^\s*(COTAL_[A-Z0-9_]+):\s/gm,
  /\[([A-Za-z_$][\w$]*)\]\s*:/g,
  /\benv\[\s*["'](COTAL_[A-Z0-9_]+)["']\s*\]\s*=/g,
];

/** Every `COTAL_` name a connector source assigns per spawn, mapped to the first file that assigns
 *  it (relative to `extensions/`). Throws when one constant is bound to two different names, since
 *  computed keys resolve by constant name across the tree and could not be disambiguated. */
export function perSpawnAssignments(): Map<string, string> {
  const constants = new Map<string, string>();
  for (const file of sources(repoRoot))
    for (const m of readFileSync(file, "utf8").matchAll(CONST_DECL)) {
      const prev = constants.get(m[1]);
      if (prev !== undefined && prev !== m[2])
        throw new Error(
          `two different COTAL_ names are bound to the constant ${m[1]} (${prev} and ${m[2]}); this ` +
            `census resolves computed keys by constant name across the tree and cannot disambiguate them`,
        );
      constants.set(m[1], m[2]);
    }

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
  return assigned;
}

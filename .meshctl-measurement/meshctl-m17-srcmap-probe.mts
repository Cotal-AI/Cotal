/**
 * SUBJECT-SIDE GATE for `mutation-proof --private-src`: does the module the suite imports actually
 * resolve to the private COPY, or to the tree?
 *
 * WHY THIS FILE EXISTS. The build-mode gate asserts CLASS IDENTITY on the object the subject
 * constructs, because a bare-specifier redirect can be defeated by an importer that opted out. A
 * src-copy run is redirected at RESOLUTION, so the question is different and narrower: did the
 * resolver actually rewrite the URL for the specifier the suite uses? A run that grades a mutant
 * nothing loaded reports a clean SURVIVED — the exact failure recorded in
 * `FINDING-mx14-survived-vacuously.md` — so this must fail CLOSED.
 *
 * TWO ARMS, because one is satisfiable by an instrument that rewrites everything:
 *   IN-MAP     the subject's own specifier must resolve UNDER the copy root.
 *   OUT-OF-MAP a specifier outside the mapped prefix must NOT be rewritten.
 * Without the second, a hook with a bug that redirected every import would pass the first and the
 * proof would grade a process whose whole module graph had been replaced.
 */
const MAP = process.env.COTAL_PRIVATE_SRC_MAP;
if (!MAP) { console.log("VERDICT: no src map in the environment"); process.exit(1); }
const [FROM, TO] = MAP.split("::");

// The specifier the graded suite uses for its subject, written the same way it writes it, and a
// specifier OUTSIDE the mapped prefix. Both are parameters rather than constants: the gate has to
// name the subject of the run it is gating, and a probe hard-wired to one package would quietly
// certify a different one. Defaults cover the connector suite; core runs pass the pair explicitly.
const SUBJECT = process.env.COTAL_PROBE_SUBJECT ?? "../extensions/connector-core/src/agent.js";
const CONTROL = process.env.COTAL_PROBE_CONTROL ?? "../packages/core/src/index.js";
if (SUBJECT === CONTROL) { console.log("VERDICT: probe misconfigured — subject and control are the same specifier"); process.exit(1); }

const subjectUrl = import.meta.resolve(SUBJECT);
const controlUrl = import.meta.resolve(CONTROL);
const toUrl = new URL(`file://${TO}/`).href;
const fromUrl = new URL(`file://${FROM}/`).href;

const inMap = subjectUrl.startsWith(toUrl);
const controlUntouched = !controlUrl.startsWith(toUrl);

console.log(`  map        ${FROM}\n          -> ${TO}`);
console.log(`  subject    ${subjectUrl}`);
console.log(`  control    ${controlUrl}`);
console.log(`  IN-MAP     ${inMap ? "yes — the subject resolves into the copy" : `NO — it still resolves under ${fromUrl}`}`);
console.log(`  OUT-OF-MAP ${controlUntouched ? "untouched — the hook is selective, not total" : "REWRITTEN — the hook is rewriting everything, so IN-MAP proves nothing"}`);

// The subject must also LOAD from there, not merely resolve: a resolve hook that returns a path
// nothing can import would satisfy the string check and fail the run in a way that reads as a
// killed mutation rather than as a broken instrument.
const mod = await import(SUBJECT);
// Any export will do: the question is whether the resolved URL IMPORTS, not what it contains. A
// named check would tie this gate to one module's surface and fail for the wrong reason elsewhere.
const loadable = Object.keys(mod).length > 0;
console.log(`  LOADS      ${loadable ? `yes — ${Object.keys(mod).length} export(s) from the resolved URL` : "NO — the resolved module did not import"}`);

if (inMap && controlUntouched && loadable) {
  console.log("VERDICT: the subject resolves to the PRIVATE src copy");
  process.exit(0);
}
console.log("VERDICT: the subject does NOT resolve to the private src copy");
process.exit(1);

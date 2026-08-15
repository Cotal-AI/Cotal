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

// The specifier the graded suite uses for its subject, written the same way it writes it.
const SUBJECT = "../extensions/connector-core/src/agent.js";
// Outside the mapped prefix by construction: a different package's source.
const CONTROL = "../packages/core/src/index.js";

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
const loadable = typeof mod.MeshAgent === "function";
console.log(`  LOADS      ${loadable ? "yes — MeshAgent imported from the resolved URL" : "NO — the resolved module did not import"}`);

if (inMap && controlUntouched && loadable) {
  console.log("VERDICT: the subject resolves to the PRIVATE src copy");
  process.exit(0);
}
console.log("VERDICT: the subject does NOT resolve to the private src copy");
process.exit(1);

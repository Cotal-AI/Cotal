/**
 * The not-yet-durable seam is GONE, and this suite keeps it gone.
 *
 * The seam was the reference handler's refusal of effects it could not yet perform durably
 * (`NotYetDurable`, raised as L5016, holding the run for a capable host). Every effect the
 * language defines performs on the mesh handler now, and the docs say so. Three things can drift
 * apart from here: a handler method can go missing again, a refusal can come back under the old
 * code, and the docs can promise what the code no longer does. Each is a source-level claim,
 * read where the text lives; the anchor cell keeps the span honest rather than assumed.
 *
 * The catalog row for L5016 stays: another host may still refuse an effect, and the code has to
 * mean what the spec says when it does.
 *
 * Run: pnpm smoke:runtime-mesh-seam   (no broker: nothing here reaches a plane, which is the point)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let ok = 0, fail = 0;
const c = (label: string, cond: boolean, detail?: unknown): void => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, detail ?? ""); }
};

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, "..", "src");
const ROOT = join(here, "..", "..", "..");
const handler = readFileSync(join(SRC_DIR, "mesh-handler.ts"), "utf8");
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (name.endsWith(".ts")) yield p;
  }
}
const runtimeSources = [...sources(SRC_DIR)];

console.log("\n── the span this suite reads, asserted rather than assumed ──");
c("mesh-handler.ts is readable and carries the handler class",
  handler.length > 10_000 && count(handler, "export class MeshHandler") === 1, { bytes: handler.length });
c("the runtime source tree was walked and is non-trivial", runtimeSources.length >= 5, runtimeSources.length);

console.log("\n── every effect the language defines has a performing method on the handler ──");
const EFFECTS = ["sleep", "checkpoint", "wait", "notify", "spawn", "turn", "ask", "monitor", "openConclave", "closeConclave"];
for (const name of EFFECTS) {
  c(`the handler performs \`${name}\``, count(handler, `\n  async ${name}(`) === 1, { sites: count(handler, `\n  async ${name}(`) });
}

console.log("\n── the refusal never comes back under the old code ──");
const raisers = runtimeSources.filter((p) => readFileSync(p, "utf8").includes("L5016"));
c("no runtime source names L5016: the reference handler refuses nothing as not-yet-durable", raisers.length === 0, raisers);
const seamClass = runtimeSources.filter((p) => readFileSync(p, "utf8").includes("NotYetDurable"));
c("the NotYetDurable class is gone from the runtime", seamClass.length === 0, seamClass);

console.log("\n── the catalog row stays, because another host may still refuse ──");
const catalog = readFileSync(join(ROOT, "packages", "lang", "src", "errors.ts"), "utf8");
c("the lang catalog still carries L5016 with its meaning", count(catalog, 'L5016: "Effect not durable on this host"') === 1);

console.log("\n── the docs promise exactly what the code does ──");
const docs = readFileSync(join(ROOT, "docs", "workflows.md"), "utf8").replace(/\s+/g, " ");
c("workflows.md states that nothing is refused as not-yet-durable any more",
  docs.includes("Every effect the language defines performs on the mesh handler; nothing is refused as not-yet-durable any more."));

console.log(`\nmesh-seam.smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

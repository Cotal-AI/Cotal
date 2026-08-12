/**
 * Every example this package SHIPS must parse.
 *
 * §11's promise is that a primitive error carries the failing callee's signature plus one working
 * example. "Working" is a claim about a string, and a claim about a string is worth exactly as much
 * as the last time somebody ran it. Two of the twelve did not parse when this suite was written:
 * `spawn`'s and `monitor`'s, both rejected by L2013, the structured-concurrency rule this same
 * package introduced and enforces. They shipped inside the error a confused author sees, which is
 * the worst possible place for an invalid example, because it is read at exactly the moment the
 * reader has no idea which of the two of you is wrong.
 *
 * This is the third place the same defect was found: the design document's worked example, three
 * more blocks in that document, and then these. The rule that produced them was executed against
 * the code and never against the prose ABOUT the code, and an example is prose until something
 * parses it.
 *
 * A note on this suite's own instrument, because it drew blood before it drew truth. The first
 * version supplied a fixed preamble declaring `team`, `builder`, `planner` and friends so that
 * examples referring to outer names would resolve. It then reported `spawn`'s example as invalid
 * AFTER the example had already been fixed, because the preamble's `const builder` collided with
 * the example's own `const builder`. Had that been trusted, the fix would have been to break a
 * correct example to satisfy a broken instrument. So the preamble now omits any name the example
 * declares for itself, and the collision case is asserted below rather than assumed away: score the
 * control first, or a weak control licenses every result beside it.
 */
import { PRIMITIVES } from "../src/primitives.js";
import { validate } from "../src/grammar.js";
import { LangErrors } from "../src/errors.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

/** Names an excerpt may refer to without declaring. Each is a value of the right shape. */
const PREAMBLE: Readonly<Record<string, string>> = {
  team: 'const team = channel("feat-auth");',
  builder: 'const builder = await spawn("builder", { name: "builder" });',
  planner: 'const planner = await spawn("planner", { name: "planner" });',
  linter: 'const linter = await spawn("linter", { name: "linter" });',
  tester: 'const tester = await spawn("tester", { name: "tester" });',
  reviewer: 'const reviewer = await spawn("reviewer", { name: "reviewer" });',
  // Each entry must be SELF-CONTAINED. An entry referring to another preamble name is only
  // inserted when the example mentions the referrer, so its dependency would be missing and the
  // example would be condemned for the preamble's incompleteness rather than its own defect.
  agents: 'const agents = [await spawn("g1", { name: "g1" }), await spawn("g2", { name: "g2" })];',
  reviewers:
    'const reviewers = { security: await spawn("r1", { name: "r1" }), perf: await spawn("r2", { name: "r2" }) };',
  a: 'const a = await spawn("a", { name: "a" });',
  b: 'const b = await spawn("b", { name: "b" });',
};

/** Top-level names the example declares itself. Supplying these too would be a redeclaration. */
const declaredBy = (src: string): Set<string> => {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1] as string);
  return out;
};

const harness = (src: string): string => {
  const mine = declaredBy(src);
  const needed = Object.entries(PREAMBLE)
    .filter(([n]) => !mine.has(n) && new RegExp(`\\b${n}\\b`).test(src))
    .map(([, decl]) => decl);
  return needed.join("\n") + (needed.length > 0 ? "\n" : "") + src + "\n";
};

// ---- 1) the instrument discriminates, checked before it is trusted -----------------------------

{
  // The exact false red that this suite's first version produced. If the preamble filter regressed,
  // this collision would come back and start condemning correct examples.
  const collides = 'const builder = await spawn("builder", { worktree: "wt-1" })';
  ok("the preamble omits a name the example declares", !harness(collides).startsWith("const builder = await spawn(\"builder\", { name"), harness(collides).split("\n")[0]);
  ok("and still supplies one the example only reads", harness("await turn(builder, { name: \"go\" })").includes('const builder ='));

  // And the instrument must be able to FAIL, or the sweep below proves nothing at all.
  let rejected = false;
  try {
    validate(harness('const x = spawn("p")'), "control");
  } catch {
    rejected = true;
  }
  ok("an unawaited spawn is still rejected through the harness", rejected);
}

// ---- 2) every shipped example parses ------------------------------------------------------------

{
  const bad: string[] = [];
  let checked = 0;
  for (const [name, spec] of Object.entries(PRIMITIVES)) {
    const example = (spec as { example?: string }).example;
    if (example === undefined) continue;
    checked += 1;
    try {
      validate(harness(example), `example:${name}`);
    } catch (e) {
      const codes = e instanceof LangErrors ? [...new Set(e.errors.map((x) => x.code))].join(",") : String(e);
      bad.push(`${name}: ${codes}`);
    }
  }
  ok("every primitive carries an example", checked === Object.keys(PRIMITIVES).length, {
    withExample: checked,
    primitives: Object.keys(PRIMITIVES).length,
  });
  ok("and every shipped example parses", bad.length === 0, bad);
}

// ---- 3) the signature in the error names the options the validator actually accepts -------------

{
  // The other half of §11's promise. A signature that lists an option the validator rejects, or
  // omits one it accepts, misleads in the one place a reader has no way to check.
  const wrong: string[] = [];
  for (const [name, spec] of Object.entries(PRIMITIVES)) {
    const s = spec as { signature: string; options: readonly string[] };
    for (const opt of s.options) {
      if (!s.signature.includes(opt)) wrong.push(`${name}.signature omits accepted option ${opt}`);
    }
  }
  ok("every accepted option appears in the printed signature", wrong.length === 0, wrong);
}

console.log(`examples.smoke: ${pass} checks passed`);

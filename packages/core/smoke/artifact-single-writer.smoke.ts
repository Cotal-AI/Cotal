/**
 * ONE attachment writer, proven by sweeping the source — and the sweep proves ITSELF first.
 *
 * WHY THIS EXISTS. Gating the expensive confirm-time checks on artifact-part presence is a
 * throughput win only if an attachment row cannot be written by any path that skips them. A second
 * writer turns that gate from an optimisation into a hole, and it would be invisible: every suite
 * stays green because the intended path still works.
 *
 * WHY IT IS BUILT NOW, BEFORE THE SURFACE IS FINISHED. A sweep is a pattern-based guard, and a
 * pattern whose universe does not match the thing it claims to cover reports a confident wrong
 * answer that nobody re-checks. This lane has produced three instances of exactly that — a suite
 * file outside `gate-inventory`'s reach, a single-writer grep that needed a positive control, and a
 * cell counter matching one of two construction forms. So this instrument is built while the right
 * answer is KNOWN: there is exactly one writer today. A pattern that finds zero, or finds something
 * unexpected, is immediately legible as a broken instrument rather than as a clean result.
 *
 * VALIDATE THE INSTRUMENT WHERE THE ANSWER IS KNOWN, THEN USE IT WHERE IT IS NOT.
 *
 * OWED: this proves nothing about the put/fetch chunk verbs, which do not exist yet. It must be
 * re-run as an explicit obligation on the Step 5 completion commit — see the plan's §10. A passing
 * sweep from before those verbs existed must never be read as covering them.
 *
 * Run: pnpm smoke:artifact-single-writer
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const SRC_ROOTS = ["packages", "implementations", "extensions", "bin"];

/** Every production TypeScript file: no smokes, no dist, no node_modules. */
const productionFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist" || e === ".git") continue;
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts")) continue;
      if (p.includes("/smoke/") || p.endsWith(".smoke.ts") || p.endsWith("/smoke.ts")) continue;
      out.push(p);
    }
  };
  for (const r of SRC_ROOTS) walk(join(ROOT, r));
  return out;
};

const files = productionFiles();
console.log(`single-writer sweep over ${files.length} production files\n`);

// The instrument's universe, asserted rather than assumed. A sweep over an empty or tiny file set
// reports "no second writer" for the same reason a correct codebase does.
check("the sweep's universe is non-trivial", files.length > 100, files.length);
check("and it reaches this package's source",
  files.some((f) => f.endsWith("packages/core/src/artifact-attach.ts")), files.length);

// An INVOCATION, not the interface declaration — `putAttachment(...)` in the deps interface is a
// type, not a write.
//
// IT COVERS THE DELETE PATH TOO, AND FOR ONE REVISION IT DID NOT — a gap introduced by the very
// change that added `dropAttachment`. The invariant this suite enforces is that the attachment index
// is UNREACHABLE except through `confirmAttach`; a sweep matching only `.putAttachment(` quantified
// over half of that. A second mutator arrived, every cell here stayed green, and the suite's own
// summary line still read "exactly ONE production call site writes an attachment row".
//
// The general form, which is why this comment is long: **a structural sweep is only as wide as its
// pattern, and its pattern is a claim about what mutation looks like.** Adding a new way to mutate
// the thing under guard silently narrows the guard, and nothing about the guard's output changes to
// say so. The list of verbs below is the part to extend when the next one lands.
//
// IT LANDED, AND THE LIST WAS NOT EXTENDED — the comment above named the maintenance obligation and
// nothing discharged it, which is the same shape one level out. `artifact-index.ts` exports the raw
// mutators as FREE FUNCTIONS taking a `kv`, and `index.ts`'s `export * from "./artifact-index.js"`
// makes them public API of `@cotal-ai/core`. A leading `\.` matches a deps METHOD and can never match
// `deleteAttachment(kv, …)`, so the suite's own invariant — the attachment index is UNREACHABLE
// except through `confirmAttach` — was false against either of them. Proven by SURVIVAL before it was
// fixed: a real `await deleteAttachment(...)` planted in `artifact-fetch.ts` left this suite 11/0
// green, with the cell asserting that very file writes no attachment row passing.
//
// TWO PATTERNS RATHER THAN ONE ALTERNATION, because they discriminate differently: a deps call is
// always dotted, a raw helper call never is, and the raw form must not match the DECLARATION in the
// module that legitimately defines it.
const INVOCATION_VIA_DEPS = /\.(putAttachment|dropAttachment)\s*\(/;
const RAW_MUTATORS = ["putAttachmentIfAbsent", "deleteAttachment"] as const;
const INVOCATION_RAW = new RegExp(`(?<!function\\s)\\b(${RAW_MUTATORS.join("|")})\\s*\\(`);
const INVOCATION = new RegExp(`${INVOCATION_VIA_DEPS.source}|${INVOCATION_RAW.source}`);
const callSites = files.filter((f) => INVOCATION.test(readFileSync(f, "utf8")));

// ---- THE POSITIVE CONTROL — before any zero is believed ----------------------------------------
// If the pattern cannot see the ONE writer we know exists, then "no other writers" is a statement
// about a broken regex, not about the codebase. This must pass for the next cell to mean anything.
check("POSITIVE CONTROL: the sweep FINDS the known writer (confirmAttach)",
  callSites.some((f) => f.endsWith("packages/core/src/artifact-attach.ts")),
  callSites.map((f) => relative(ROOT, f)));

// ---- A CONTROL PER MUTATING VERB, because one control proves one pattern alternative ------------
// The combined regex is an alternation, and an alternation can rot one branch at a time while the
// other keeps the control green. That is the same shape as a suite whose single control proves
// `grep` is alive without proving it reached the corpus.
{
  const attachSrc = readFileSync(files.find((f) => f.endsWith("packages/core/src/artifact-attach.ts"))!, "utf8");
  for (const verb of ["putAttachment", "dropAttachment"]) {
    check(`POSITIVE CONTROL: the sweep's \`${verb}\` branch matches a real call site`,
      new RegExp(`\\.${verb}\\s*\\(`).test(attachSrc), verb);
  }
}

// ---- SYNTHETIC CONTROLS for the raw-helper branches, and why they cannot take the form above -----
// The controls above point each branch at a REAL call site. For the raw helpers there is deliberately
// no production caller — that absence is the property this suite guards — so a control of that form
// is impossible here, and a branch carrying NO control is exactly the rot the controls exist to
// prevent. So each raw branch is proven against fixed samples instead.
//
// TWO ARMS, and the second is the load-bearing one. Matching an invocation proves the branch is
// ALIVE. Refusing the DECLARATION proves it DISCRIMINATES — without that, the widened pattern matches
// `artifact-index.ts`'s own `export async function deleteAttachment(` and the MUST_NOT_WRITE cell
// below fails on the one file that is supposed to define these. A pattern that fires on everything
// is not a wider guard, it is a broken one, and it fails on the innocent file first.
for (const verb of RAW_MUTATORS) {
  check(`POSITIVE CONTROL: the sweep's raw \`${verb}\` branch matches an INVOCATION`,
    INVOCATION.test(`  await ${verb}(kv, digest, channel);`), verb);
  check(`NEGATIVE CONTROL: the sweep's raw \`${verb}\` branch does NOT match its DECLARATION`,
    !INVOCATION.test(`export async function ${verb}(kv: AttachmentKv, digest: string) {`), verb);
}

// ---- and only that one --------------------------------------------------------------------------
check("exactly ONE production call site writes an attachment row",
  callSites.length === 1, callSites.map((f) => relative(ROOT, f)));

// ---- the named paths that must never write ------------------------------------------------------
// Enumerated by name so a future reader meets the list rather than re-deriving it. Each of these
// touches the same messages and would be a plausible place to "helpfully" attach.
const MUST_NOT_WRITE = [
  "packages/core/src/endpoint.ts",      // fanOutMessage's durable + live arms, catch-up copy, DLV reader, readHistory
  "packages/core/src/artifact-index.ts",// key grammar + the raw helpers, which take a kv, not the deps
  "packages/core/src/artifact-fetch.ts",// the read gate
  "packages/core/src/artifact-chunk.ts",// sizing
  "packages/core/src/artifact-transfer.ts", // the planner — added when Step 5 landed, per the owed re-run
];
for (const rel of MUST_NOT_WRITE) {
  const f = files.find((x) => x.endsWith(rel));
  check(`${rel} writes no attachment row`,
    f !== undefined && !INVOCATION.test(readFileSync(f, "utf8")),
    f === undefined ? "FILE NOT FOUND — the sweep's universe is wrong, not the codebase" : "has a call site");
}

// ---- THE EXPORT SURFACE, WHICH IS WHERE THIS SUITE'S UNIVERSE ENDS -------------------------------
// Everything above is a scan of THIS REPO. The invariant it enforces — the attachment index is
// unreachable except through `confirmAttach` — is a claim about ALL callers, and an out-of-tree
// consumer is outside the sweep's universe by construction. `index.ts` used to `export *` from
// `artifact-index.js`, which put `putAttachmentIfAbsent` and `deleteAttachment` on the public runtime
// surface of `@cotal-ai/core`: `import { deleteAttachment } from "@cotal-ai/core"` wrote the index
// with no succession fence and no possession check, and every cell above stayed green.
//
// **A structural sweep's PATTERN is a claim about what mutation looks like; its UNIVERSE is a claim
// about where mutation can happen. The pattern was widened once already; this is the universe.**
//
// Asserted against the RUNTIME surface, not the text of `index.ts`. A re-export can arrive by a route
// no grep of that one file would catch (a barrel file, a renamed alias, a nested `export *`), and the
// property that matters is what a consumer can actually import.
{
  const surface = await import("../src/index.js");
  const pub = surface as unknown as Record<string, unknown>;

  // POSITIVE CONTROL FIRST: an absence assertion is vacuously true against a module that failed to
  // load or resolved to something empty. This is the fourth instrument on this lane where the arm
  // that must PASS is the only thing distinguishing a real measurement from a broken one.
  check("POSITIVE CONTROL: the public surface loaded and carries the non-mutating index exports",
    typeof pub.possessionBucket === "function" && typeof pub.attachmentBucket === "function"
      && typeof pub.confirmAttach === "function",
    { possessionBucket: typeof pub.possessionBucket, confirmAttach: typeof pub.confirmAttach });

  for (const verb of RAW_MUTATORS) {
    check(`the public surface of @cotal-ai/core does NOT export \`${verb}\``,
      pub[verb] === undefined, typeof pub[verb]);
  }
}

console.log(`\nartifact-single-writer: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/**
 * The conformance corpus is a shipped artifact, and three parties must agree about it: the JSON
 * on disk, the accessor that serves it, and a fresh build from the language reference. The cells
 * are ordered so each disagreement names itself: parse, accessor, floors, verdicts, bytes.
 */
import { readFileSync } from "node:fs";
import { conformanceCorpus } from "../src/conformance.js";
import { LangErrors } from "../src/errors.js";
import { validate } from "../src/grammar.js";
import { CORPUS_PATH, buildCorpus, renderCorpus } from "./_conformance-build.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const codesOf = (source: string): string[] => {
  try {
    validate(source);
    return [];
  } catch (e) {
    if (e instanceof LangErrors) return e.errors.map((x) => x.code);
    throw e;
  }
};

const onDisk = readFileSync(CORPUS_PATH, "utf8");
const parsed = JSON.parse(onDisk) as { cases?: unknown };
ok("the shipped artifact parses to a cases array", Array.isArray(parsed.cases));

const corpus = conformanceCorpus();
ok("the accessor serves the artifact as it is on disk", JSON.stringify(corpus) === JSON.stringify(JSON.parse(onDisk)));

const accepted = corpus.cases.filter((c) => c.verdict === "accepted");
const refusedCases = corpus.cases.filter((c) => c.verdict !== "accepted");
ok(
  "the corpus carries at least seven cases, acceptance and refusal both",
  corpus.cases.length >= 7 && accepted.length >= 1 && refusedCases.length >= 1,
  { cases: corpus.cases.length, accepted: accepted.length, refused: refusedCases.length },
);
ok(
  "and the corpus is served frozen",
  Object.isFrozen(corpus) && Object.isFrozen(corpus.cases) && corpus.cases.every((c) => Object.isFrozen(c)),
);

const disagreements = corpus.cases
  .map((c) => {
    const codes = codesOf(c.source);
    const holds = c.verdict === "accepted" ? codes.length === 0 : codes.includes(c.verdict.refused);
    return holds
      ? undefined
      : `block ${c.index} (${c.heading}): recorded ${c.verdict === "accepted" ? "accepted" : c.verdict.refused}, validator answered ${codes.join(",") || "accepted"}`;
  })
  .filter((d): d is string => d !== undefined);
ok("every recorded verdict holds against the validator today", disagreements.length === 0, disagreements);

ok("the artifact is byte-identical to a fresh build from the reference", renderCorpus(buildCorpus()) === onDisk);

console.log(`conformance.smoke: ${pass} checks passed`);

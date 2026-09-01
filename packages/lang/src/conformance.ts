/**
 * The conformance corpus: every ```js block in the language reference (spec/cotal-lang.md), with
 * the verdict the validator gives it. It ships as a JSON artifact (`conformance/corpus.json`) so
 * a second implementation can run the same claims from the file alone, and the artifact carries
 * its own adjudication rule so the file needs no other document to say how a claim is checked.
 * `conformanceCorpus()` is the in-process reader. `pnpm gen:conformance` regenerates the
 * artifact from the reference, and `pnpm smoke:lang-conformance` holds the shipped bytes
 * identical to a fresh build.
 */
import { readFileSync } from "node:fs";
import { CATALOG, type LangErrorCode } from "./errors.js";

export interface ConformanceCase {
  /** 1-based position of the block in the reference, matching the surface suite's "block N". */
  readonly index: number;
  /** The nearest section heading above the block. */
  readonly heading: string;
  /** The program text, byte for byte as the reference carries it. */
  readonly source: string;
  /**
   * `"accepted"` means the validator answers no codes. A refusal names ONE code the validator's
   * answer must include; the answer may carry more (the reference's first block answers four),
   * so the check is membership in the answered set, never equality with a single code.
   */
  readonly verdict: "accepted" | { readonly refused: LangErrorCode };
}

/**
 * The adjudication rule, carried inside the artifact itself so a reader holding only the JSON
 * knows how to check a claim. The accessor refuses an artifact whose rule drifted from this text.
 */
export const ADJUDICATION =
  "a refused verdict names one code the validator's answer must include, and the answer may carry more; an accepted verdict means the validator answers no codes";

export interface ConformanceCorpus {
  /** The document the corpus is generated from. */
  readonly source: "spec/cotal-lang.md";
  /** How a recorded verdict is checked against a validator's answer; always `ADJUDICATION`. */
  readonly adjudication: string;
  readonly cases: readonly ConformanceCase[];
}

// The annotation sits on the const: TypeScript only narrows after a never-returning call when
// the declaration itself carries the explicit type.
const fail: (detail: string) => never = (detail) => {
  throw new Error(`conformance corpus is malformed: ${detail}`);
};

const checkCase = (value: unknown, at: number): ConformanceCase => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`case ${at} is not a record`);
  const c = value as Record<string, unknown>;
  if (typeof c.index !== "number" || typeof c.heading !== "string" || typeof c.source !== "string") {
    fail(`case ${at} is missing index, heading, or source`);
  }
  if (c.verdict !== "accepted") {
    const v = c.verdict;
    const code = v === null || typeof v !== "object" ? undefined : (v as Record<string, unknown>).refused;
    if (typeof code !== "string") fail(`case ${at} carries no verdict`);
    if (!(code in CATALOG)) fail(`case ${at} refuses with ${code}, a code the catalog does not carry`);
    Object.freeze(c.verdict);
  }
  return Object.freeze(c) as unknown as ConformanceCase;
};

let cached: ConformanceCorpus | undefined;

/** Reads the shipped corpus artifact. Throws on a missing or malformed artifact. */
export function conformanceCorpus(): ConformanceCorpus {
  if (cached !== undefined) return cached;
  const raw = readFileSync(new URL("../conformance/corpus.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") fail("the artifact is not a record");
  const rec = parsed as Record<string, unknown>;
  if (rec.source !== "spec/cotal-lang.md") fail(`unexpected source ${String(rec.source)}`);
  if (rec.adjudication !== ADJUDICATION) fail("the artifact does not carry the adjudication rule");
  const list = rec.cases;
  if (!Array.isArray(list) || list.length === 0) fail("expected a non-empty cases array");
  const cases = list.map((c, i) => checkCase(c, i + 1));
  cached = Object.freeze({ source: "spec/cotal-lang.md", adjudication: ADJUDICATION, cases: Object.freeze(cases) }) as ConformanceCorpus;
  return cached;
}

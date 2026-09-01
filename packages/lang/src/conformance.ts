/**
 * The conformance corpus: every ```js block in the language reference (spec/cotal-lang.md), with
 * the verdict the validator gives it. It ships as a JSON artifact (`conformance/corpus.json`) so
 * a second implementation can run the same claims from the file alone; `conformanceCorpus()` is
 * the in-process reader. `pnpm gen:conformance` regenerates the artifact from the reference, and
 * `pnpm smoke:lang-conformance` holds the shipped bytes identical to a fresh build.
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
  /** `"accepted"`, or the code the validator refuses the program with. */
  readonly verdict: "accepted" | { readonly refused: LangErrorCode };
}

export interface ConformanceCorpus {
  /** The document the corpus is generated from. */
  readonly source: "spec/cotal-lang.md";
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
  const list = rec.cases;
  if (!Array.isArray(list) || list.length === 0) fail("expected a non-empty cases array");
  const cases = list.map((c, i) => checkCase(c, i + 1));
  cached = Object.freeze({ source: "spec/cotal-lang.md", cases: Object.freeze(cases) }) as ConformanceCorpus;
  return cached;
}

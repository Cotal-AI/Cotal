/**
 * Builds the conformance corpus from the language reference: every ```js block in
 * spec/cotal-lang.md, with the verdict the validator gives it today. A block whose first line is
 * `// refused: LXXXX` must refuse with that code; any other block must validate clean. The
 * builder throws on any disagreement, so a stale marker can never be rendered into the artifact.
 *
 * Shared by `scripts/generate-conformance-corpus.ts` (writes the artifact) and by
 * `conformance.smoke.ts` (holds the checked-in artifact byte-identical to a fresh build). This
 * module is test/tooling support and is not shipped.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConformanceCase, ConformanceCorpus } from "../src/conformance.js";
import { LangErrors, type LangErrorCode } from "../src/errors.js";
import { validate } from "../src/grammar.js";

export const CORPUS_PATH = fileURLToPath(new URL("../conformance/corpus.json", import.meta.url));

const SPEC_PATH = fileURLToPath(new URL("../../../spec/cotal-lang.md", import.meta.url));

const codesOf = (source: string): string[] => {
  try {
    validate(source);
    return [];
  } catch (e) {
    if (e instanceof LangErrors) return e.errors.map((x) => x.code);
    throw e;
  }
};

export function buildCorpus(): ConformanceCorpus {
  // Fold CRLF exactly as the surface suite does: on a CRLF checkout the fence regex would find
  // no block at all, and an empty corpus is refused below rather than rendered.
  const text = readFileSync(SPEC_PATH, "utf8").replace(/\r\n/g, "\n");
  const headings = [...text.matchAll(/^#{2,3} (.+)$/gm)].map((m) => ({ at: m.index ?? -1, title: (m[1] as string).trim() }));
  const cases: ConformanceCase[] = [];
  for (const [i, m] of [...text.matchAll(/```js\n([\s\S]*?)```/g)].entries()) {
    const source = m[1] as string;
    const at = m.index ?? -1;
    const heading = [...headings].reverse().find((h) => h.at < at)?.title ?? "";
    const marker = /^\/\/ refused: (L\d{4})/.exec(source);
    const codes = codesOf(source);
    if (marker !== null) {
      const code = marker[1] as LangErrorCode;
      if (!codes.includes(code)) {
        throw new Error(
          `spec block ${i + 1} (${heading}) declares "// refused: ${code}" but the validator answered ${codes.join(",") || "accepted"}`,
        );
      }
      cases.push({ index: i + 1, heading, source, verdict: { refused: code } });
    } else {
      if (codes.length > 0) throw new Error(`spec block ${i + 1} (${heading}) does not validate: ${codes.join(",")}`);
      cases.push({ index: i + 1, heading, source, verdict: "accepted" });
    }
  }
  if (cases.length === 0) throw new Error("no ```js blocks found in spec/cotal-lang.md; the corpus cannot be empty");
  return { source: "spec/cotal-lang.md", cases };
}

export const renderCorpus = (corpus: ConformanceCorpus): string => `${JSON.stringify(corpus, null, 2)}\n`;

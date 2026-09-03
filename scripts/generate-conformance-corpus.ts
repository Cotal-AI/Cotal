/**
 * Regenerates packages/lang/conformance/corpus.json from spec/cotal-lang.md.
 * Run with `pnpm gen:conformance`. The build logic lives beside the suite that gates it, in
 * packages/lang/smoke/_conformance-build.ts, so the generator and the gate can never disagree.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CORPUS_PATH, buildCorpus, renderCorpus } from "../packages/lang/smoke/_conformance-build.js";

const corpus = buildCorpus();
mkdirSync(dirname(CORPUS_PATH), { recursive: true });
writeFileSync(CORPUS_PATH, renderCorpus(corpus));
console.log(`gen:conformance: wrote ${corpus.cases.length} cases from ${corpus.source} → packages/lang/conformance/corpus.json`);

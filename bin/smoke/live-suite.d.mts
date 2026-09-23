// Generated from live-suite.mjs by gen-ci-suites-dts.mts. Do not edit: run `pnpm gen:ci-suites-dts`.
// The .mjs module is the only source of truth; `pnpm smoke:ci-declarations` fails if this drifts.

/**
 * The leading header of a suite: shebang, then block and line comments and blank lines until
 * the first non-comment token. That is the suite's own declaration of what it drives. Later
 * comments in the body are not consulted, so a cell that mentions "REAL Manager" cannot
 * reclassify a non-infrastructure suite.
 *
 * @param {string} source
 * @returns {string}
 */
export function leadingSuiteHeader(source: string): string;
/**
 * @typedef {{ live: boolean, declarations: string[], brokerDeclarations: string[] }} LiveClassification
 */
/**
 * Classify a suite from its source text. The script name is not an argument, so a rename
 * cannot change the answer while the source still declares the same property.
 *
 * @param {string} source
 * @returns {LiveClassification}
 */
export function classifyLiveSuiteSource(source: string): LiveClassification;
/**
 * Last `tsx`/`node` path in a package script body. Composite wrappers (`pnpm --filter … build
 * && tsx path`) still resolve to the suite they execute. A body with no such path is not a
 * classifiable suite source.
 *
 * @param {string} command
 * @returns {string | null}
 */
export function suiteSourceFromScript(command: string): string | null;
/**
 * Classify a repository-relative suite file. Path hygiene matches mutation-suite-metadata:
 * a source that is not a normalised POSIX path inside the root is refused, not classified.
 *
 * @param {string} root
 * @param {string} sourcePath
 * @returns {LiveClassification}
 */
export function classifyLiveSuiteFile(root: string, sourcePath: string): LiveClassification;
/**
 * Classify a public `smoke:*` script by resolving its package.json body to a source file
 * and reading that file's leading header. The script NAME is used only as a key into the
 * scripts map; it is never tested for a `-live` / `:live` suffix.
 *
 * @param {string} root
 * @param {string} scriptName
 * @param {Record<string, string>} scripts
 * @returns {LiveClassification & { source: string | null }}
 */
export function classifyLiveSmokeScript(root: string, scriptName: string, scripts: Record<string, string>): LiveClassification & {
    source: string | null;
};
/** Declarations that make a suite live. Exact phrases, not a prose heuristic. */
export const LIVE_INFRASTRUCTURE_DECLARATIONS: readonly string[];
/** Recorded on the classification, never sufficient on their own. */
export const LIVE_BROKER_DECLARATIONS: readonly string[];
export type LiveClassification = {
    live: boolean;
    declarations: string[];
    brokerDeclarations: string[];
};

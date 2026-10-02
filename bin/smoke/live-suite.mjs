// @ts-check
/**
 * Classify whether a smoke suite drives real infrastructure.
 *
 * The standing host rule is "never run a -live suite". A name is not a description of
 * behaviour: `smoke:seat-input` targets `seat-input-live.smoke.ts`, whose header declares a
 * REAL Manager, REAL JWT broker and REAL pty children, and a suffix matcher classifies it
 * non-live. The inverse is also true: a `:live` script whose source does not declare those
 * properties is not live by this guard.
 *
 * Live is a source-level property. The runner answers it by reading the suite's own leading
 * header for the exact declarations `REAL Manager`, `REAL agent processes`, or `REAL pty
 * children`. `REAL broker` / `REAL JWT broker` are recorded (a sandboxed nats-server is
 * ordinary and not the hazard) but they are not sufficient. Script names and file names are
 * never consulted.
 *
 * The six unsuffixed scripts whose headers already declare the property:
 *   smoke:manager-service
 *   smoke:manager-service-ops
 *   smoke:manager-service-invoke
 *   smoke:manager-spawn-action
 *   smoke:persona-announce
 *   smoke:seat-input
 */
import { readFileSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";

/** Declarations that make a suite live. Exact phrases, not a prose heuristic. */
export const LIVE_INFRASTRUCTURE_DECLARATIONS = Object.freeze([
  "REAL Manager",
  "REAL agent processes",
  "REAL pty children",
]);

/** Recorded on the classification, never sufficient on their own. */
export const LIVE_BROKER_DECLARATIONS = Object.freeze(["REAL JWT broker", "REAL broker"]);

/**
 * The leading header of a suite: shebang, then block and line comments and blank lines until
 * the first non-comment token. That is the suite's own declaration of what it drives. Later
 * comments in the body are not consulted, so a cell that mentions "REAL Manager" cannot
 * reclassify a non-infrastructure suite.
 *
 * @param {string} source
 * @returns {string}
 */
export function leadingSuiteHeader(source) {
  if (typeof source !== "string") throw new Error("leadingSuiteHeader: source must be a string");
  let i = 0;
  if (source.startsWith("#!")) {
    const nl = source.indexOf("\n");
    i = nl === -1 ? source.length : nl + 1;
  }
  let out = "";
  while (i < source.length) {
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return out + source.slice(i);
      out += source.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? source.length : nl + 1;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += ch;
      i++;
      continue;
    }
    break;
  }
  return out;
}

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
export function classifyLiveSuiteSource(source) {
  const header = leadingSuiteHeader(source);
  const declarations = LIVE_INFRASTRUCTURE_DECLARATIONS.filter((d) => header.includes(d));
  const brokerDeclarations = LIVE_BROKER_DECLARATIONS.filter((d) => header.includes(d));
  return { live: declarations.length > 0, declarations, brokerDeclarations };
}

/**
 * Last `tsx`/`node` path in a package script body. Composite wrappers (`pnpm --filter … build
 * && tsx path`) still resolve to the suite they execute. A body with no such path is not a
 * classifiable suite source.
 *
 * @param {string} command
 * @returns {string | null}
 */
export function suiteSourceFromScript(command) {
  if (typeof command !== "string") throw new Error("suiteSourceFromScript: command must be a string");
  const matches = [...command.matchAll(/(?:^|[\s&;])(?:tsx|node)\s+([^\s]+\.(?:ts|mjs|js|mts|cjs))/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

/**
 * @param {string} root
 * @param {string} source
 */
function inside(root, source) {
  const rel = relative(root, source);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Classify a repository-relative suite file. Path hygiene matches mutation-suite-metadata:
 * a source that is not a normalised POSIX path inside the root is refused, not classified.
 *
 * @param {string} root
 * @param {string} sourcePath
 * @returns {LiveClassification}
 */
export function classifyLiveSuiteFile(root, sourcePath) {
  if (typeof root !== "string" || root.length === 0) throw new Error("classifyLiveSuiteFile: root is required");
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error("classifyLiveSuiteFile: sourcePath is required");
  }
  const segments = sourcePath.split("/");
  if (
    sourcePath.startsWith("/") ||
    sourcePath.endsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    /[\s:\\]/u.test(sourcePath) ||
    posix.normalize(sourcePath) !== sourcePath
  ) {
    throw new Error(`classifyLiveSuiteFile: not a normalised repository-relative POSIX path: ${JSON.stringify(sourcePath)}`);
  }
  const absolute = resolve(root, sourcePath);
  if (!inside(root, absolute)) {
    throw new Error(`classifyLiveSuiteFile: source escapes the repository root: ${JSON.stringify(sourcePath)}`);
  }
  return classifyLiveSuiteSource(readFileSync(absolute, "utf8"));
}

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
export function classifyLiveSmokeScript(root, scriptName, scripts) {
  if (typeof scriptName !== "string" || scriptName.length === 0) {
    throw new Error("classifyLiveSmokeScript: scriptName is required");
  }
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error("classifyLiveSmokeScript: scripts must be a map of script names to bodies");
  }
  const command = scripts[scriptName];
  if (typeof command !== "string") {
    throw new Error(`classifyLiveSmokeScript: missing script ${JSON.stringify(scriptName)}`);
  }
  const source = suiteSourceFromScript(command);
  if (source === null) {
    return { live: false, declarations: [], brokerDeclarations: [], source: null };
  }
  return { ...classifyLiveSuiteFile(root, source), source };
}

/**
 * Emit `reap-smoke-brokers.d.mts` from `reap-smoke-brokers.mjs`, so the two cannot disagree.
 *
 * WHY THIS EXISTS. The reaper stays plain `.mjs` on purpose: it runs from the CI runner before any
 * workspace build, so it must not depend on a built package or on a TypeScript loader. Its consumers
 * are `.ts`, so it needs a declaration beside it. A hand written declaration is a SECOND source of
 * truth, and this one drifted twice: first a regex guard read it and passed over a real arity
 * mismatch, then an AST guard read it and passed over an alias re-export, a default export, a
 * namespace merge and every type in the file. Both guards were an enumeration of shapes someone
 * thought of, and both were beaten by a shape nobody did.
 *
 * So the declaration is no longer written. It is emitted by the compiler from the module itself, and
 * the suite asserts the committed file is byte for byte what the compiler emits today. There is no
 * shape to miss, because nothing is being recognised: a change to the module that the declaration
 * does not follow changes these bytes, whatever kind of change it is.
 *
 * `reap-smoke-brokers.mjs` carries `// @ts-check`, so its JSDoc is checked against its own
 * implementation as well. A type that stops being true stops the emit, and this refuses to write a
 * declaration it could not typecheck rather than writing a weaker one.
 *
 * This file is `.mts` rather than `.mjs` on purpose: it is a development tool run under `tsx`, so it
 * has no reason to avoid TypeScript, and a second `.mjs` here would need a declaration of its own and
 * reopen the very question it closes.
 *
 *   pnpm gen:reaper-dts    rewrite the declaration after editing the module
 *   pnpm smoke:reaper      fail if the committed declaration is not what the module emits
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const MODULE_PATH = fileURLToPath(new URL("./reap-smoke-brokers.mjs", import.meta.url));
export const DECLARATION_PATH = fileURLToPath(new URL("./reap-smoke-brokers.d.mts", import.meta.url));

const BANNER = `// Generated from reap-smoke-brokers.mjs by gen-reaper-dts.mjs. Do not edit: run \`pnpm gen:reaper-dts\`.
// The module is the only source of truth for these types; \`pnpm smoke:reaper\` fails if they drift.

`;

/**
 * The declaration the compiler emits for the reaper today, banner included.
 *
 * Throws rather than returning a weaker declaration when the module does not typecheck, because a
 * declaration emitted over an error describes a shape the compiler was guessing at.
 */
export function renderReaperDeclaration(): string {
  let emitted: string | undefined;
  const program = ts.createProgram({
    rootNames: [MODULE_PATH],
    options: {
      allowJs: true,
      declaration: true,
      emitDeclarationOnly: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      noEmit: false,
    },
  });

  const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const first = errors
      .slice(0, 5)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
      .join("; ");
    throw new Error(`reap-smoke-brokers.mjs does not typecheck, so its declaration was not emitted: ${first}`);
  }

  const result = program.emit(undefined, (_fileName: string, text: string) => {
    emitted = text;
  });
  if (emitted === undefined) {
    throw new Error(`the compiler emitted no declaration for ${MODULE_PATH} (emitSkipped=${result.emitSkipped})`);
  }
  return BANNER + emitted;
}

/**
 * The declaration as committed, with line endings normalised so a CRLF checkout is not a drift, or
 * `undefined` when the file is not there at all. Absence is a comparison the suite can report rather
 * than a throw that ends the run before its banner.
 */
export function readCommittedDeclaration(): string | undefined {
  try {
    return readFileSync(DECLARATION_PATH, "utf8").replace(/\r\n/g, "\n");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = renderReaperDeclaration();
  writeFileSync(DECLARATION_PATH, text);
  console.log(`wrote ${DECLARATION_PATH} (${text.length} bytes)`);
}

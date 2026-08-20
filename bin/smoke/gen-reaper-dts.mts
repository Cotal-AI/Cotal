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
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const MODULE_PATH = fileURLToPath(new URL("./reap-smoke-brokers.mjs", import.meta.url));
export const DECLARATION_PATH = fileURLToPath(new URL("./reap-smoke-brokers.d.mts", import.meta.url));

const BANNER = `// Generated from reap-smoke-brokers.mjs by gen-reaper-dts.mts. Do not edit: run \`pnpm gen:reaper-dts\`.
// The module is the only source of truth for these types; \`pnpm smoke:reaper\` fails if they drift.

`;

/**
 * The compiler options the emit runs under: the repository's own shared base config, plus the five
 * that make this an emit rather than a check.
 *
 * They are READ rather than restated on purpose, and read from the ROOT config, because that is the
 * project that actually typechecks this module's `.ts` consumers. A generator that hand lists
 * `target`, `strict` and `moduleResolution` produces a declaration that is correct under its own
 * settings and possibly wrong under the ones its consumers are checked with, which is the
 * second-source-of-truth problem one level up from the one this file exists to remove. It is not a
 * style point: a generator on `target: ESNext` emits `Promise.withResolvers()` as
 * `PromiseWithResolvers<any>`, `skipLibCheck` lets a consumer on `lib: ES2023` swallow the
 * unresolved type as `any`, and the declaration then certifies arbitrary operations on a value the
 * runtime does not have. Reading the consumers' own config makes that a loud refusal instead: the
 * emit fails with "Property 'withResolvers' does not exist", the declaration is not rewritten, and
 * the suite reds.
 */
function emitOptions(): ts.CompilerOptions {
  const configPath = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(`could not read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  if (parsed.errors.length > 0) {
    throw new Error(`could not parse ${configPath}: ${ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, " ")}`);
  }
  return {
    ...parsed.options,
    allowJs: true,
    declaration: true,
    declarationMap: false,
    sourceMap: false,
    emitDeclarationOnly: true,
  };
}

/**
 * A declared type reduced to the part a runtime value can be held to.
 *
 * `opaque` is the honest exit: a shape this cannot reduce is reported as unchecked rather than
 * quietly treated as satisfied, so a caller can say which leaves were actually witnessed.
 */
export type DeclaredShape =
  | { readonly kind: "primitive"; readonly name: string }
  | { readonly kind: "array"; readonly of: DeclaredShape }
  | { readonly kind: "object"; readonly props: Readonly<Record<string, DeclaredShape>> }
  | { readonly kind: "union"; readonly of: readonly DeclaredShape[] }
  | { readonly kind: "opaque"; readonly text: string };

const PRIMITIVES = new Set(["string", "number", "boolean", "undefined", "void", "null", "never", "any", "unknown"]);

/**
 * What the COMMITTED declaration says this module exports, and what each exported function returns,
 * read out of the declaration by the compiler rather than restated here.
 *
 * This exists because a hand-written consumer is an enumeration, which is the failure this whole
 * guard removes one level down: a consumer that happens to touch `reaped[].owner` and not
 * `supported` cannot see a declaration that lies about `supported`. Reading the surface OUT of the
 * declaration means a field or an export that nobody thought of is still covered, and a new one
 * shows up as a name the suite has not witnessed rather than as silence.
 *
 * PARAMETERS ARE READ FOR THE SAME REASON THE RETURN IS. Recording only the return left the other
 * half of every signature unread: a security review widened `reportReaped`'s `@param {string}` to
 * `{string | number}`, kept the body string-only behind a double cast, and this whole suite stayed
 * at 34 of 34, because the consumer passes one string and a string still satisfies the wider
 * declaration. A consumer written to the newly declared `number` arm then compiled with zero
 * diagnostics and threw at runtime. A parameter domain nothing exercises is a promise nothing
 * holds, so the arms come back here and the suite passes a value of each.
 */
export function declaredModuleSurface(): {
  readonly exports: readonly string[];
  readonly returns: Readonly<Record<string, DeclaredShape>>;
  readonly params: Readonly<Record<string, readonly DeclaredShape[]>>;
  readonly signatures: Readonly<Record<string, number>>;
} {
  const options: ts.CompilerOptions = {
    ...emitOptions(),
    allowJs: false,
    checkJs: false,
    declaration: false,
    emitDeclarationOnly: false,
    noEmit: true,
  };
  const program = ts.createProgram({ rootNames: [DECLARATION_PATH], options });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(DECLARATION_PATH);
  if (source === undefined) throw new Error(`could not load ${DECLARATION_PATH}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`${DECLARATION_PATH} is not a module`);

  const shapeOf = (type: ts.Type, depth: number): DeclaredShape => {
    const text = checker.typeToString(type);
    if (PRIMITIVES.has(text)) return { kind: "primitive", name: text === "void" ? "undefined" : text };
    // A LITERAL IS ITS BASE PRIMITIVE HERE. `boolean` is `true | false` to the checker, and neither
    // arm's text is in the set above, so each was walked for properties and came back as an object
    // whose `valueOf` is opaque: an optional `boolean` parameter would have reported two
    // unverifiable leaves that no runtime value could ever fail. The literal carries no obligation
    // a runtime value can be held to beyond its primitive, so it reduces to that.
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { kind: "primitive", name: "boolean" };
    if (type.flags & ts.TypeFlags.StringLiteral) return { kind: "primitive", name: "string" };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { kind: "primitive", name: "number" };
    if (depth > 4) return { kind: "opaque", text };
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type as ts.TypeReference);
      return element === undefined ? { kind: "opaque", text } : { kind: "array", of: shapeOf(element, depth + 1) };
    }
    // Deduped, because reducing literals collapses arms that were distinct only as literals:
    // `boolean` arrives as two arms that are now the same shape, and a union that repeats an arm
    // says nothing more than one that does not.
    if (type.isUnion()) {
      const seen = new Map<string, DeclaredShape>();
      for (const member of type.types) {
        const shape = shapeOf(member, depth + 1);
        const key = JSON.stringify(shape);
        if (!seen.has(key)) seen.set(key, shape);
      }
      const of = [...seen.values()];
      return of.length === 1 ? of[0]! : { kind: "union", of };
    }
    const properties = type.getProperties();
    if (properties.length === 0) return { kind: "opaque", text };
    const props: Record<string, DeclaredShape> = {};
    for (const property of properties) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? source;
      props[property.getName()] = shapeOf(checker.getTypeOfSymbolAtLocation(property, declaration), depth + 1);
    }
    return { kind: "object", props };
  };

  const exports: string[] = [];
  const returns: Record<string, DeclaredShape> = {};
  const params: Record<string, DeclaredShape[]> = {};
  // How many call signatures each export declares, recorded BEFORE anything is skipped. Only the
  // first signature is read below, so a second one would be enumerated by nothing and checked by
  // nothing, and a zero-signature export would drop out of `params` and be exercised by nothing.
  // Both are silent today, which is the failure this number exists to make loud: the suite refuses
  // any count other than one rather than quietly covering signature 0.
  const signatures: Record<string, number> = {};
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = exported.getName();
    exports.push(name);
    const declaration = exported.valueDeclaration ?? exported.declarations?.[0];
    if (declaration === undefined) { signatures[name] = 0; continue; }
    const callSignatures = checker.getTypeOfSymbolAtLocation(exported, declaration).getCallSignatures();
    signatures[name] = callSignatures.length;
    const [signature] = callSignatures;
    if (signature === undefined) continue;
    returns[name] = shapeOf(signature.getReturnType(), 0);
    params[name] = signature.getParameters().map((parameter) =>
      shapeOf(checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration ?? declaration), 0));
  }
  return { exports: exports.sort(), returns, params, signatures };
}

/**
 * Typecheck `source` as a `.mts` consumer sitting beside the module, and hand back its diagnostics.
 *
 * The point is WHICH file answers `./reap-smoke-brokers.mjs` for it. `allowJs` is off here, so the
 * module's own text is not a resolution target and the only route to those names is the committed
 * declaration. A consumer that compiles under this compiled against the declaration alone.
 *
 * Nothing is written to disk: the consumer's path exists only to place it in the module's directory,
 * where its relative import resolves the way a real consumer's would.
 */
export function checkDeclarationConsumer(source: string): readonly string[] {
  const consumerPath = fileURLToPath(new URL("./declaration-consumer.mts", import.meta.url));
  const options: ts.CompilerOptions = {
    ...emitOptions(),
    allowJs: false,
    checkJs: false,
    declaration: false,
    emitDeclarationOnly: false,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const isConsumer = (fileName: string) => ts.sys.resolvePath(fileName) === ts.sys.resolvePath(consumerPath);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (fileName) => (isConsumer(fileName) ? source : readFile(fileName));
  host.fileExists = (fileName) => isConsumer(fileName) || fileExists(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    isConsumer(fileName)
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [consumerPath], options, host });
  return ts.getPreEmitDiagnostics(program)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/**
 * The same consumer text as runnable JavaScript, so one source can be both checked and executed.
 *
 * `fileName` is not decoration: under `NodeNext` the emitted module format is decided by the file
 * the text claims to be, and with no name the compiler assumes CommonJS and writes `exports.` into
 * something node then loads as ESM.
 */
export function transpileConsumer(source: string): string {
  return ts.transpileModule(source, {
    fileName: fileURLToPath(new URL("./declaration-consumer.mts", import.meta.url)),
    compilerOptions: { ...emitOptions(), module: ts.ModuleKind.NodeNext, declaration: false, emitDeclarationOnly: false },
  }).outputText;
}

/**
 * The declaration the compiler emits for the reaper today, banner included.
 *
 * Throws rather than returning a weaker declaration when the module does not typecheck, because a
 * declaration emitted over an error describes a shape the compiler was guessing at.
 *
 * `source` replaces the module's own text at its own path, for the suite's probe that the check is
 * live. It is an override of CONTENT only: the path, and therefore every resolution the compiler
 * does from it, is unchanged, and nothing is written to disk. Reading the module is the default.
 */
export function renderReaperDeclaration(source?: string): string {
  let emitted: string | undefined;
  const options = emitOptions();
  const host = ts.createCompilerHost(options);
  if (source !== undefined) {
    const isModule = (fileName: string) => ts.sys.resolvePath(fileName) === ts.sys.resolvePath(MODULE_PATH);
    const readFile = host.readFile.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.readFile = (fileName) => (isModule(fileName) ? source : readFile(fileName));
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      isModule(fileName)
        ? ts.createSourceFile(fileName, source, languageVersion, true)
        : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  }
  const program = ts.createProgram({ rootNames: [MODULE_PATH], options, host });

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

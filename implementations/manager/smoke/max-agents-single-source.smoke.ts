/**
 * MAX_AGENTS has one production meaning: the manager's live+in-flight+cooling ceiling
 * and the resume inventory schema's array cap. Those used to be two private copies that
 * failed with different error classes (#1462). This suite proves the shipped source still
 * has one definition and that both consumers acquire that definition.
 *
 * WHAT THIS DISCOVERS, rather than names. It walks `implementations/manager/src` and
 * parses every `.ts` file with the TypeScript compiler API. Definitions are
 * `VariableDeclaration`s whose binding is `MAX_AGENTS`. Acquisition is a value-level
 * named import of that binding whose specifier resolves to the defining file, or a use
 * of the binding in the defining file. A hand-enumerated pair of filenames is not the
 * universe: a third `const MAX_AGENTS` in any other production file in that tree is a
 * finding, and a consumer that stops importing the definition is a finding even if the
 * two well-known files still exist.
 *
 * WHAT IT CANNOT SEE, said first:
 *   - Runtime copies (a number written into a message, a rebuilt dist). This is a
 *     source-acquisition proof.
 *   - A namespace import (`import * as resume` then `resume.MAX_AGENTS`). Named import
 *     is the acquisition this tree uses; a shift to namespace import fails the import
 *     cell rather than being silently accepted.
 *   - Comments, strings, and type-only imports. Those are not value acquisition.
 *
 * Run: pnpm smoke:max-agents-single-source
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const srcRoot = join(repo, "implementations", "manager", "src");
const skipDirs = new Set(["dist", "smoke", "test", "tests", "fixtures", "node_modules"]);

let ok = 0;
let fail = 0;
const check = (label: string, cond: boolean, detail?: unknown): void => {
  if (cond) {
    ok++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${label}`, detail ?? "");
  }
};

function* walk(path: string): Generator<string> {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (path.endsWith(".ts") && !path.endsWith(".d.ts")) yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) yield child;
  }
}

type Definition = { file: string; exported: boolean; numeric: boolean };
type NamedImport = { file: string; from: string; typeOnly: boolean };

const definitions: Definition[] = [];
const namedImports: NamedImport[] = [];
const schemaCapFiles: string[] = [];
const importedUseFiles: string[] = [];
const localUseFiles: string[] = [];
const unboundUses: Array<{ file: string; text: string }> = [];

function isMaxAgentsIdentifier(node: ts.Node): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === "MAX_AGENTS";
}

function exportedVariable(node: ts.VariableDeclaration): boolean {
  const statement = node.parent?.parent;
  return !!statement && ts.isVariableStatement(statement)
    && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const resolved = resolve(dirname(fromFile), spec);
  return resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts`
    : resolved.endsWith(".ts") ? resolved
    : `${resolved}.ts`;
}

function isBindingSite(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
  return false;
}

function isSchemaCapArgument(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  return ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "max";
}

const files = [...walk(srcRoot)];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let defines = false;
  let valueImport = false;

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && isMaxAgentsIdentifier(node.name)) {
      defines = true;
      definitions.push({
        file,
        exported: exportedVariable(node),
        numeric: !!node.initializer && ts.isNumericLiteral(node.initializer),
      });
    }
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const imported = el.propertyName ?? el.name;
          if (isMaxAgentsIdentifier(imported) || isMaxAgentsIdentifier(el.name)) {
            const typeOnly = node.importClause.isTypeOnly || el.isTypeOnly;
            if (!typeOnly) valueImport = true;
            namedImports.push({ file, from: node.moduleSpecifier.text, typeOnly });
          }
        }
      }
    }
    if (isMaxAgentsIdentifier(node) && !isBindingSite(node)) {
      if (isSchemaCapArgument(node)) schemaCapFiles.push(file);
      if (defines) localUseFiles.push(file);
      else if (valueImport) importedUseFiles.push(file);
      else unboundUses.push({ file, text: node.parent?.getText().slice(0, 80) ?? node.getText() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const rel = (file: string): string => relative(repo, file);
const unique = (xs: string[]): string[] => [...new Set(xs)];
const definition = definitions[0];
const valueImports = namedImports.filter((row) => !row.typeOnly);
const importsOfDefinition = valueImports.filter((row) => definition !== undefined && resolveSpecifier(row.file, row.from) === definition.file);
const schemaCaps = unique(schemaCapFiles);
const acquiringSchemaCaps = schemaCaps.filter((file) =>
  (definition !== undefined && file === definition.file) || importsOfDefinition.some((row) => row.file === file),
);

console.log("\n── discovery ──");
check(
  `production manager src walk found files (floor 20, found ${files.length})`,
  files.length >= 20,
  { files: files.length, root: rel(srcRoot) },
);

console.log("\n── one definition ──");
check(
  "exactly one production MAX_AGENTS VariableDeclaration",
  definitions.length === 1,
  definitions.map((d) => ({ file: rel(d.file), exported: d.exported, numeric: d.numeric })),
);
check("the single MAX_AGENTS definition is exported", !!definition && definition.exported, definition && rel(definition.file));
check("the single MAX_AGENTS definition is a numeric literal", !!definition && definition.numeric, definition);

console.log("\n── both consumers acquire it ──");
check(
  "a value import of MAX_AGENTS resolves to the definition",
  importsOfDefinition.length >= 1,
  { imports: valueImports.map((row) => ({ file: rel(row.file), from: row.from, resolved: resolveSpecifier(row.file, row.from) })) },
);
check(
  "every value import of MAX_AGENTS resolves to that same definition",
  valueImports.length > 0 && importsOfDefinition.length === valueImports.length,
  { extra: valueImports.filter((row) => !importsOfDefinition.includes(row)).map((row) => rel(row.file)) },
);
check(
  "the imported binding is used (manager capacity path)",
  unique(importedUseFiles).length >= 1,
  unique(importedUseFiles).map(rel),
);
check(
  "the defining file uses its local MAX_AGENTS binding",
  !!definition && unique(localUseFiles).includes(definition.file),
  unique(localUseFiles).map(rel),
);
check(
  "an acquiring file caps the resume inventory array with MAX_AGENTS",
  acquiringSchemaCaps.length >= 1,
  { schemaCaps: schemaCaps.map(rel), acquiring: acquiringSchemaCaps.map(rel) },
);
check(
  "no production file uses MAX_AGENTS without defining or importing it",
  unboundUses.length === 0,
  unboundUses.map((row) => ({ file: rel(row.file), text: row.text })),
);

console.log(`\nMAX-AGENTS SINGLE-SOURCE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed; scanned ${files.length} files)`);
if (fail > 0) process.exitCode = 1;

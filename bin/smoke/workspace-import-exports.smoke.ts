/**
 * Static workspace import/export check.
 *
 * Type-only imports disappear when a smoke runs under tsx, and most smoke trees are not included in
 * their package's TypeScript project. That allowed one manager smoke to import `MeshAgent` from core
 * even though connector-core defines and exports it. Scan every TypeScript tree with the compiler's
 * module resolver and require every named import from a workspace package to be publicly exported.
 *
 * Run: pnpm smoke:workspace-import-exports
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_ROOTS = ["packages", "extensions", "implementations", "examples", "bin"];
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);
const SKIP_DIRS = new Set(["dist", "node_modules"]);

const sourceFiles: string[] = [];
const walk = (path: string): void => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) sourceFiles.push(fullPath);
  }
};
for (const root of SOURCE_ROOTS) walk(join(ROOT, root));

const configPath = join(ROOT, "tsconfig.base.json");
const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(rawConfig.error, undefined, "tsconfig.base.json parses");
const parsedConfig = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, ROOT, {
  noEmit: true,
  skipLibCheck: true,
});
assert.equal(parsedConfig.errors.length, 0, "tsconfig.base.json options resolve");

const program = ts.createProgram(sourceFiles, parsedConfig.options);
const checker = program.getTypeChecker();
const failures: string[] = [];
let importCount = 0;
let nameCount = 0;

for (const filePath of sourceFiles) {
  const source = program.getSourceFile(filePath);
  assert.ok(source, `compiler loaded ${relative(ROOT, filePath)}`);

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const packageName = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!packageName.startsWith("@cotal-ai/") || clause === undefined) continue;

    importCount++;
    const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
    const line = source.getLineAndCharacterOfPosition(statement.moduleSpecifier.getStart()).line + 1;
    if (moduleSymbol === undefined) {
      failures.push(`${relative(ROOT, filePath)}:${line}: package does not resolve: ${packageName}`);
      continue;
    }

    const exportedNames = new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name));
    const checkName = (importedName: string, position: number): void => {
      nameCount++;
      if (exportedNames.has(importedName)) return;
      const importLine = source.getLineAndCharacterOfPosition(position).line + 1;
      failures.push(
        `${relative(ROOT, filePath)}:${importLine}: ${packageName} does not export ${importedName}`,
      );
    };

    if (clause.name !== undefined) checkName("default", clause.name.getStart());
    if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        checkName((element.propertyName ?? element.name).text, element.name.getStart());
      }
    }
  }
}

assert.ok(importCount > 0, "workspace imports were found");
assert.ok(nameCount > 0, "workspace import names were checked");
assert.deepEqual(failures, [], failures.join("\n"));
console.log(`WORKSPACE IMPORT EXPORTS: ${nameCount} names across ${importCount} imports`);

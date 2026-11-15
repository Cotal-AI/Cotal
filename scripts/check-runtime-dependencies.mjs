#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function runtimeImports(text, file = 'output.js') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error(`${file}: emitted JavaScript did not parse`);
  const imports = [];
  const add = node => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      imports.push({ specifier: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    } else if (node) {
      imports.push({ expression: node.getText(source), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(callee) && callee.text === 'require' ||
          ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' &&
          (ts.isIdentifier(callee.expression) && callee.expression.text === 'require' || callee.expression.getText(source) === 'import.meta')) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

export function packageName(specifier) {
  if (isBuiltin(specifier) || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return undefined;
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

// These are file/native/plugin boundaries, not missing npm dependencies. New expressions refuse.
const COMPUTED_LOADS = new Map([
  ['cotal-ai/dist/cotal.js/pathToFileURL(selected.entry).href', 'inventory-validated retained or installed execution program'],
  ['cotal-ai/dist/daemon-cwd.js/entry.href', 'adjacent CLI file URL'],
  ['cotal-ai/dist/daemon-native.js/entry.href', 'adjacent CLI file URL'],
  ['@cotal-ai/lang/dist/engine/worker-entry.js/module', 'host-provided workflow effect module'],
  ['@cotal-ai/seat/dist/peercred.js/path', 'shipped native binding path'],
  ['@cotal-ai/workspace/dist/darwin-process.js/fileURLToPath(path)', 'shipped native binding file URL'],
  ['@cotal-ai/workspace/dist/win32-process.js/fileURLToPath(path)', 'shipped native binding file URL'],
  ['@cotal-ai/workspace/dist/extensions.js/name', 'declared peer of an operator-installed extension'],
  ['@cotal-ai/workspace/dist/materialize.js/pathToFileURL(join(dir, entry)).href', 'operator-installed extension entry'],
]);

export function runtimeDependencyExemption(name, file, specifier) {
  if (name === '@cotal-ai/connector-jcode' && file === 'dist/index.js' && specifier === 'tsx')
    return 'The source-launch branch resolves the TypeScript loader; published dist selects host.js without evaluating that branch.';
  return undefined;
}

export function auditPackage(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const dist = join(directory, 'dist');
  if (!existsSync(dist)) throw new Error(`${manifest.name}: dist is missing; build before auditing runtime dependencies`);
  const declared = new Set([manifest.name, ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  const violations = [], files = [], imports = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (/\.(?:[cm]?js)$/.test(entry.name)) files.push(name);
    }
  };
  walk(dist);
  if (!files.length) throw new Error(`${manifest.name}: dist has no emitted JavaScript`);
  for (const file of files) for (const item of runtimeImports(readFileSync(file, 'utf8'), file)) {
    const builtFile = relative(directory, file).split(sep).join('/');
    if (item.expression) {
      const key = `${manifest.name}/${builtFile}/${item.expression}`;
      if (COMPUTED_LOADS.has(key)) continue;
      if (manifest.name === '@cotal-ai/web' && /^dist\/web\/assets\/controller-[A-Za-z0-9_-]+\.js$/.test(builtFile) && item.expression === 'e') continue; // Vite's browser-relative preload URL resolver.
      // The bundled broker selects one of the manifest's platform-specific optional dependencies.
      if (key === '@cotal-ai/cli/dist/lib/nats-bin.js/pkg' &&
          Object.keys(manifest.optionalDependencies ?? {}).some(name => name.startsWith('@eplightning/nats-server-'))) continue;
      violations.push({ package: manifest.name, file: builtFile, ...item, specifier: item.expression, dependency: '<computed load requires classification>' });
      continue;
    }
    if (runtimeDependencyExemption(manifest.name, builtFile, item.specifier)) continue;
    const dependency = packageName(item.specifier);
    if (!dependency) continue;
    const row = { package: manifest.name, file: builtFile, ...item, dependency };
    imports.push(row);
    if (!declared.has(dependency)) violations.push(row);
  }
  return { name: manifest.name, files: files.length, imports, violations };
}

export function auditRepository(root) {
  const rows = JSON.parse(execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }));
  const packages = rows.filter(row => !JSON.parse(readFileSync(join(row.path, 'package.json'), 'utf8')).private);
  const fixed = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8')).fixed.flat().sort();
  if (!packages.length || JSON.stringify(packages.map(row => row.name).sort()) !== JSON.stringify(fixed))
    throw new Error('published package census disagrees with the fixed release group');
  return packages.map(row => auditPackage(row.path));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = auditRepository(resolve(import.meta.dirname, '..'));
  const violations = results.flatMap(result => result.violations);
  if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else {
    for (const row of violations) console.error(`${row.package} ${row.file}:${row.line}: ${row.specifier} is not declared in dependencies or peerDependencies`);
    console.log(`runtime dependencies: ${results.length} published packages, ${results.reduce((n, r) => n + r.files, 0)} built JavaScript files, ${violations.length} undeclared imports`);
  }
  process.exitCode = violations.length ? 1 : 0;
}

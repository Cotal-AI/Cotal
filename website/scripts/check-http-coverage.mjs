import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const parse = path => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
const visit = (node, fn) => { fn(node); ts.forEachChild(node, child => visit(child, fn)); };
const sourceFiles = [];
for (const base of ['implementations', 'extensions', 'packages', 'bin']) {
  const scan = path => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (['node_modules', 'dist', 'smoke', '.git'].includes(entry.name)) continue;
      const next = join(path, entry.name);
      if (entry.isDirectory()) scan(next);
      else if (entry.name.endsWith('.ts')) sourceFiles.push(next);
    }
  };
  scan(base);
}
const trees = new Map(sourceFiles.map(path => [path, parse(path)]));
const definitions = new Map();
for (const tree of trees.values()) visit(tree, node => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (node.name.text.endsWith('_PATH') || node.name.text === 'CHAT_SESSION_PATHS')) definitions.set(node.name.text, node.initializer);
});
const value = node => {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node) && definitions.has(node.text)) return value(definitions.get(node.text));
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return value(node.expression);
  if (ts.isCallExpression(node) && node.expression.getText() === 'Object.freeze') return value(node.arguments[0]);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText().replaceAll('"', ''), value(p.initializer)]));
  if (ts.isPropertyAccessExpression(node)) return value(node.expression)?.[node.name.text];
};
const methods = node => {
  const result = new Set();
  visit(node, item => {
    if (!ts.isBinaryExpression(item)) return;
    for (const [left, right] of [[item.left, item.right], [item.right, item.left]]) {
      if (left.getText().endsWith('.method') && ts.isStringLiteralLike(right) && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(right.text)) result.add(right.text.toLowerCase());
    }
  });
  return [...result];
};
const auth = trees.get('implementations/auth/src/service.ts');
const functions = new Map();
visit(auth, node => { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node); });
const tables = {};
visit(auth, node => {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !['ROUTES', 'routes'].includes(node.name.text)) return;
  const initializer = node.initializer;
  if (!initializer || !ts.isNewExpression(initializer) || initializer.expression.getText() !== 'Map' || !ts.isArrayLiteralExpression(initializer.arguments?.[0])) return;
  tables[node.name.text] = initializer.arguments[0].elements.map(entry => {
    assert(ts.isArrayLiteralExpression(entry), 'Auth route entry must be a tuple');
    const path = value(entry.elements[0]);
    assert(typeof path === 'string', `Unresolved Auth route: ${entry.elements[0].getText()}`);
    let accepted = methods(entry.elements[1]);
    if (ts.isIdentifier(entry.elements[1]) && functions.has(entry.elements[1].text)) accepted.push(...methods(functions.get(entry.elements[1].text)));
    visit(entry.elements[1], item => {
      if (ts.isCallExpression(item) && ts.isIdentifier(item.expression) && functions.has(item.expression.text)) accepted.push(...methods(functions.get(item.expression.text)));
    });
    return { path, methods: [...new Set(accepted.length ? accepted : ['get'])] };
  });
});
assert(tables.ROUTES?.length && tables.routes?.length, 'Both Auth listener tables must be inspected');
const publicPaths = new Set(tables.routes.map(route => route.path));
const dispatch = (file, excluded) => {
  const tree = trees.get(file);
  const result = new Map();
  visit(tree, node => {
    if (!ts.isIfStatement(node)) return;
    const paths = new Set();
    visit(node.expression, expression => {
      if (ts.isBinaryExpression(expression)) for (const [left, right] of [[expression.left, expression.right], [expression.right, expression.left]]) {
        if (left.getText() === 'path') {
          const path = value(right);
          if (typeof path === 'string' && path.startsWith('/')) paths.add(path);
        }
      }
      if (ts.isCallExpression(expression) && expression.expression.getText() === 'path.startsWith') {
        const prefix = value(expression.arguments[0]);
        if (prefix === '/session/') paths.add(prefix + '{name}');
        else if (prefix === '/api/channels/' && node.expression.getText().includes('path.endsWith("/history")')) paths.add('/api/channels/{channel}/history');
        else assert.fail(`Unclassified HTTP route prefix ${prefix} in ${file}`);
      }
    });
    let accepted = methods(node.expression);
    if (!accepted.length) accepted = ['get'];
    for (const path of paths) {
      if (excluded.includes(path)) continue;
      if (path === '/session/{name}') {
        const handler = [];
        visit(tree, item => { if (ts.isMethodDeclaration(item) && item.name.getText() === '#onSession') handler.push(...methods(item)); });
        accepted = [...new Set(handler)];
        assert(accepted.length, 'Manager session method must be read from its handler');
      }
      for (const method of accepted) result.set(`${method} ${path}`, { path, method });
    }
  });
  return [...result.values()];
};
const audiences = [
  { id: 'auth', spec: 'implementations/auth/openapi.json', operations: tables.routes.flatMap(route => route.methods.map(method => ({ path: route.path, method }))) },
  { id: 'auth-host', spec: 'implementations/auth/host.openapi.json', operations: tables.ROUTES.filter(route => !publicPaths.has(route.path)).flatMap(route => route.methods.map(method => ({ path: route.path, method }))) },
  { id: 'dashboard', spec: 'implementations/web/openapi.json', operations: dispatch('implementations/web/src/web.ts', ['/']) },
  { id: 'manager-console', spec: 'implementations/manager/openapi.json', operations: dispatch('implementations/manager/src/attach-endpoint.ts', ['/favicon.ico']) },
  { id: 'feedback-intake', spec: 'implementations/delivery/openapi.json', operations: dispatch('implementations/delivery/src/feedback-intake.ts', []) },
];
const applicationListeners = new Set(['implementations/auth/src/service.ts', 'implementations/web/src/web.ts', 'implementations/manager/src/attach-endpoint.ts', 'implementations/delivery/src/feedback-intake.ts']);
const exclusions = new Map([
  ['extensions/connector-codex/src/mcp.ts', 'Ephemeral loopback /mcp is standard MCP Streamable HTTP, owned by the MCP SDK.'],
  ['implementations/linear/src/oauth.ts', 'Ephemeral /callback is the one-use OAuth PKCE login callback.'],
  ['implementations/auth/dev-idp.ts', 'Development-only Better Auth provider, outside shipped HTTP references.'],
]);
let listenerFiles = 0;
for (const [file, tree] of trees) {
  const imports = new Set();
  visit(tree, node => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !['node:http', 'node:https'].includes(node.moduleSpecifier.text)) return;
    for (const item of node.importClause?.namedBindings?.elements ?? []) if ((item.propertyName ?? item.name).text === 'createServer') imports.add(item.name.text);
  });
  let creates = false;
  visit(tree, node => { if (ts.isCallExpression(node) && imports.has(node.expression.getText())) creates = true; });
  if (!creates) continue;
  listenerFiles++;
  assert(applicationListeners.has(file) || exclusions.has(file), `Unclassified production HTTP listener: ${file}`);
}
const failures = [];
let count = 0;
for (const audience of audiences) {
  assert(audience.operations.length, `No routes found for ${audience.id}`);
  let specification;
  if (process.argv.includes('--baseline')) {
    try { specification = execFileSync('git', ['show', `HEAD:${audience.spec}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { specification = undefined; }
  } else if (existsSync(join(root, audience.spec))) specification = read(audience.spec);
  const documented = specification ? JSON.parse(specification).paths : {};
  for (const { path, method } of audience.operations) {
    if (!documented[path]?.[method]) failures.push(`${audience.id}: missing ${method.toUpperCase()} ${path}`);
    count++;
  }
  const actual = new Set(audience.operations.map(({ path, method }) => `${method} ${path}`));
  for (const [path, item] of Object.entries(documented)) for (const method of Object.keys(item).filter(method => /^(get|post|put|patch|delete|head|options)$/.test(method))) {
    if (!actual.has(`${method} ${path}`)) failures.push(`${audience.id}: documented operation absent from dispatcher: ${method.toUpperCase()} ${path}`);
  }
}
console.log(JSON.stringify({ listenerFiles, operations: count, audiences: audiences.map(({ id, operations }) => ({ id, operations: operations.length })), exclusions: Object.fromEntries(exclusions), otherExclusions: ['Manager and Dashboard HTML, scripts, styles and favicon resources are not data APIs.', 'The embedding MCP gateway defines a handler but no fixed listener address.', 'node:net sockets and temporary port-reservation probes are not HTTP APIs.'] }, null, 2));
assert.equal(failures.length, 0, `HTTP reference coverage gaps:\n${failures.join('\n')}`);
console.log(`check-http-coverage: ${count} operations match application dispatchers; ${exclusions.size} other HTTP listeners classified`);

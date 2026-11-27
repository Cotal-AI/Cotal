import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const apis = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
const isChildProcess = (node) => node && ts.isStringLiteralLike(node) && /^(node:)?child_process$/.test(node.text);
const shipped = /^(?:(?:packages|extensions|implementations)\/[^/]+\/(?:src|bin)\/|bin\/|desktop\/src-tauri\/installers\/)/;
const excluded = /(?:^|\/)(?:smoke|tests?|__tests__|fixtures|dist|vendor)\/|\.(?:smoke|test|spec|acceptance)\.|\.d\.[cm]?ts$|^packages\/smoke-kit\/|^bin\/scripts\/(?!pin-npm-node\.cjs$)/;
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const allowlist = JSON.parse(readFileSync(new URL("./windows-child-process-allowlist.json", import.meta.url), "utf8"));

function resolve(node, imports, locals, seen = new Set()) {
  if (!node) return;
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return resolve(node.expression, imports, locals, seen);
  if (ts.isIdentifier(node)) {
    if (imports.has(node.text)) return imports.get(node.text);
    if (seen.has(node.text)) return;
    seen.add(node.text);
    return resolve(locals.get(node.text), imports, locals, seen);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : "";
    if (apis.has(name) && resolve(node.expression, imports, locals, seen) === "*") return name;
  }
  if (ts.isCallExpression(node)) {
    if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === "require") && isChildProcess(node.arguments[0])) return "*";
    if (/^(?:\w+\.)?promisify$/.test(node.expression.getText())) return resolve(node.arguments[0], imports, locals, seen);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    return resolve(node.right, imports, locals, seen);
  if (ts.isConditionalExpression(node)) {
    return resolve(node.whenTrue, imports, locals, new Set(seen)) ?? resolve(node.whenFalse, imports, locals, new Set(seen));
  }
}

function collect(file) {
  const imports = new Map();
  const locals = new Map();
  const destructured = [];
  const calls = [];
  const snippets = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (isChildProcess(node.moduleSpecifier)) {
        if (node.importClause?.name) imports.set(node.importClause.name.text, "*");
        if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, "*");
        if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) {
          const api = (entry.propertyName ?? entry.name).text;
          if (apis.has(api)) imports.set(entry.name.text, api);
          if (api === "default") imports.set(entry.name.text, "*");
        }
      } else if (/\/broker-spawn\.js$/.test(node.moduleSpecifier.text) && bindings && ts.isNamedImports(bindings)) {
        // The wrapper forwards the options and serves both foreground and detached brokers.
        for (const entry of bindings.elements) {
          if ((entry.propertyName ?? entry.name).text === "spawnBroker") imports.set(entry.name.text, "spawn");
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) locals.set(node.name.text, node.initializer);
      if (ts.isObjectBindingPattern(node.name) && node.initializer) destructured.push(node);
    } else if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isStringLiteralLike(node) && /(?:child_process|\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\()/.test(node.text)) {
      // Generated scripts assembled from string literals keep one virtual source line per real line.
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      snippets.push({ line, text: node.text });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const node of destructured) {
    if (resolve(node.initializer, imports, locals) !== "*") continue;
    for (const el of node.name.elements) {
      const name = el.propertyName && ts.isStringLiteralLike(el.propertyName) ? el.propertyName.text : (el.propertyName ?? el.name).getText();
      if (apis.has(name)) imports.set(el.name.getText(), name);
    }
  }
  return { imports, locals, calls, snippets };
}

// undefined means the object has no windowsHide property; false includes unknown values.
function windowOption(node, locals, seen = new Set()) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return windowOption(node.expression, locals, seen);
  if (ts.isConditionalExpression(node)) {
    const a = windowOption(node.whenTrue, locals, new Set(seen));
    const b = windowOption(node.whenFalse, locals, new Set(seen));
    return a === b ? a : false;
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    seen.add(node.text);
    return locals.has(node.text) ? windowOption(locals.get(node.text), locals, seen) : false;
  }
  if (!ts.isObjectLiteralExpression(node)) return false;
  for (let i = node.properties.length - 1; i >= 0; i--) {
    const p = node.properties[i];
    if (ts.isSpreadAssignment(p)) {
      const option = windowOption(p.expression, locals, new Set(seen));
      if (option !== undefined) return option;
    }
    const name = p.name && ts.isComputedPropertyName(p.name) ? p.name.expression : p.name;
    if (name && ts.isComputedPropertyName(p.name) && !ts.isStringLiteralLike(name)) return false;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "windowsHide") {
      return ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
  }
  return undefined;
}

function sites(file, embedded = false) {
  const { imports, locals, calls, snippets } = collect(file);
  const found = [];
  for (const call of calls) {
    const api = resolve(call.expression, imports, locals);
    if (!api || api === "*") continue;
    const [, second, third] = call.arguments;
    const hasCallbackThird = third && (ts.isArrowFunction(third) || ts.isFunctionExpression(third));
    const opts = /^exec(?:Sync)?$/.test(api) || hasCallbackThird ? second : third ?? second;
    const { line } = file.getLineAndCharacterOfPosition(call.getStart(file));
    const argv = call.arguments.slice(0, 2).map((arg) => arg.getText(file).replace(/\s+/g, " "));
    found.push({ line: line + 1, key: `${api}(${argv.join(", ")})`, hidden: windowOption(opts, locals) === true });
  }
  if (!embedded && snippets.some(({ text }) => /\b(?:require|from).*child_process/.test(text))) {
    const lines = [];
    for (const { line, text } of snippets) lines[line] = (lines[line] ?? "") + text.replaceAll("\n", " ");
    found.push(...sites(parse(file.fileName, lines.join("\n")), true));
  }
  return found;
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", windowsHide: true })
    .split("\0").filter((file) => /\.[cm]?[jt]sx?$/.test(file) && shipped.test(file) && !excluded.test(file));
  const exceptions = new Map(Object.entries(allowlist).flatMap(([file, rows]) => Object.entries(rows).map(([key, reason]) => [`${file}\t${key}`, reason])));
  let failed = 0, total = 0, allowed = 0;
  const report = process.argv.includes("--list");
  for (const name of new Set(files)) {
    const text = readFileSync(join(root, name), "utf8");
    if (!/child_process|broker-spawn\.js/.test(text)) continue;
    const occurrences = new Map();
    for (const site of sites(parse(name, text))) {
      total++;
      const occurrence = (occurrences.get(site.key) ?? 0) + 1;
      occurrences.set(site.key, occurrence);
      const signature = occurrence === 1 ? site.key : `${site.key} [${occurrence}]`;
      const key = `${name}\t${signature}`;
      const reason = site.hidden ? undefined : exceptions.get(key);
      if (reason) { exceptions.delete(key); allowed++; }
      if (report) console.log(`${site.hidden ? "hidden" : reason ? "allowed" : "missing"}\t${name}:${site.line}\t${signature}${reason ? `\t${reason}` : ""}`);
      if (!site.hidden && !reason) {
        failed++;
        console.error(`${name}:${site.line}: ${signature} must pass windowsHide: true or have a reason in windows-child-process-allowlist.json`);
      }
    }
  }
  for (const [key] of exceptions) {
    failed++;
    console.error(`Unused Windows child process allowlist entry: ${key}`);
  }
  console.log(`check:windows-child-process: ${total} launch sites, ${allowed} exceptions, ${failed} failures`);
  process.exitCode = failed ? 1 : 0;
}

main();

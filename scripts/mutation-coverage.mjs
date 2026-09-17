#!/usr/bin/env node
/**
 * Report how many executed smoke-suite cells have been observed failing under a mutation.
 *
 * With no paths, configs are discovered from this checkout's index. Every config is examined even
 * when an earlier one is refused or cannot be parsed. Live-shaped commands (live-named smoke
 * tokens or suite sources that declare real infrastructure) use the same fail-closed predicate as
 * mutation-reproof and are refused before any child is spawned. A discovered (no-path) run
 * enumerates and validates but does not execute unless --execute-discovered is passed. The final
 * summary names the checkout HEAD when git can resolve it, and exits non-zero if any config was
 * not graded. Live-shaped refusals and discovered fences are named skips, not grading failures.
 *
 *   node scripts/mutation-coverage.mjs <config.json> …              # just these (live still refused)
 *   node scripts/mutation-coverage.mjs --execute-discovered         # every config; live still refused
 *   node scripts/mutation-coverage.mjs --gradable-only [config...]   # validate reachability, do not execute
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";
import { liveShapedCommandReason } from "./mutation-command-safety.mjs";
import { parseSuiteSources } from "./mutation-suite-metadata.mjs";
import { gradeCellTarget } from "./mutation-cell-witness.mjs";

const FLAG_EXECUTE_DISCOVERED = "--execute-discovered";
const FLAG_GRADABLE_ONLY = "--gradable-only";
const rawArgs = process.argv.slice(2);
const executeDiscovered = rawArgs.includes(FLAG_EXECUTE_DISCOVERED);
const gradableOnly = rawArgs.includes(FLAG_GRADABLE_ONLY);
const args = rawArgs.filter((arg) => arg !== FLAG_EXECUTE_DISCOVERED && arg !== FLAG_GRADABLE_ONLY);
const discovered = args.length === 0;
const configs = discovered
  ? execSync("git ls-files '*/mutations/*.json' '*.mutations.json'", { encoding: "utf8" }).split("\n").filter(Boolean)
  : args;

if (configs.length === 0) {
  console.error("no mutation configs found under any mutations/ directory");
  process.exit(1);
}

let checkoutHead = "unknown";
try {
  checkoutHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  checkoutHead = "unknown";
}
let cells = 0, named = 0, mutations = 0, unkillable = 0;
let examined = 0, graded = 0, unparsed = 0, failed = 0;
let fencedDiscovered = 0;
const rows = [];
const probes = [];
const tools = [];
const refusals = [];
const refused = [];
const REQUIRED = ["name", "file", "find", "expectRed", "cell"];
const REQUIRED_MAY_BE_EMPTY = ["replace"];
const packageRoot = (p) => p.split("/").slice(0, 2).join("/");
const LAUNCHERS = ["spawnSync", "spawn", "execFileSync", "execFile"];
/** `pty.spawn` starts a real child exactly as `child_process.spawn` does, so it is a launcher too. */
const LAUNCHER_MODULES = ["child_process", "@lydell/node-pty"];
const COPIERS = ["cpSync", "copyFileSync"];
const JOINERS = ["join", "resolve", "dirname", "fileURLToPath"];
/** `fileURLToPath` is a joiner for this tool's purpose but it is exported by `url`, not `path`. */
const JOINER_MODULES = ["path", "url"];
/** A loader CLI that occupies the first positional and executes the NEXT one (tsx's own cli.mjs). */
const RUNNER_CLI = /(?:^|\/)(?:tsx|ts-node|tsimp)(?:\/dist)?\/(?:cli|esm)\.(?:m?js|cjs)$/i;
/**
 * Ask `namedAliases` about ANY imported binding rather than a named export of a named module.
 *
 * A distinct object, not a string or `"*"`, so it can never collide with a real module specifier or
 * export name. It is used by the one witness whose question is "did this value leave this file
 * through a binding something else owns", where the module is genuinely open.
 */
const ANY_IMPORT = Symbol("any imported binding");

const calleeText = (expr) => {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) return expr.name.text;
  return "";
};

/**
 * Does the callee AT THIS CALL SITE resolve to one of `originals`, imported from `fromSpec`?
 *
 * Provenance is the whole point. Seeding a set with the canonical spellings admitted any name that
 * merely looks right, so `function readFileSync(){ return "" }` or a local `spawnSync` returning
 * `{ status: 0 }` was graded as the real call and the suite earned coverage of a file it never
 * opens. But an import is a fact about the MODULE, not about the callee the program reaches, so a
 * name recorded once and matched everywhere is only half the question. Two shapes slip through it:
 * a parameter named `readFileSync` shadows the import for the whole body it is declared in, and
 * `import * as fs` binds `fs.readFileSync` rather than a bare `readFileSync`, so crediting the bare
 * spelling lets an unrelated namespace import vouch for a local decoy. This therefore returns a
 * PREDICATE over the callee expression, and the name counts only when the binding the call site
 * actually resolves to is the imported one: a named import reached through no shadowing
 * declaration, or a member of a namespace this file imported from the expected module.
 * An alias is still honest coverage, so `readFileSync as readData` binds `readData`, and so is
 * `import * as pty` followed by `pty.spawn`. `fromSpec` may be several modules, for a callee the
 * repo genuinely reaches through more than one.
 */
const namedAliases = (source, fromSpec, originals) => {
  const anyModule = fromSpec === ANY_IMPORT;
  const anyName = originals === ANY_IMPORT;
  const specs = anyModule ? []
    : (Array.isArray(fromSpec) ? fromSpec : [fromSpec]).flatMap((spec) => [spec, `node:${spec}`]);
  const names = new Set();
  const namespaces = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!anyModule && !specs.includes(node.moduleSpecifier.text)) return;
      // A default import binds a callee exactly as a named one does, and it is only consulted for
      // the ANY question: the witnesses that name their module ask about a specific export.
      if (anyName && node.importClause?.name !== undefined) names.add(node.importClause.name.text);
      const named = node.importClause?.namedBindings;
      if (!named) return;
      if (ts.isNamespaceImport(named)) {
        namespaces.add(named.name.text);
        return;
      }
      if (!ts.isNamedImports(named)) return;
      for (const el of named.elements) {
        const orig = (el.propertyName ?? el.name).text;
        if (anyName || originals.includes(orig)) names.add(el.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast("alias.ts", source));
  // Every name a binding introduces. `const { readFileSync } = fake` and `function run({ readFileSync })`
  // bind exactly as `const readFileSync = …` does, so reading only `ts.isIdentifier(name)` misses a
  // shadow and credits the import for a callee the program never reaches. Nested patterns, renames,
  // defaults, array elements and rest all bind, and a property KEY does not: in `{ readFileSync: r }`
  // the name introduced is `r`.
  const boundNames = (name, out = []) => {
    if (name === undefined) return out;
    if (ts.isIdentifier(name)) { out.push(name.text); return out; }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isOmittedExpression(el)) continue;
        boundNames(el.name, out);
      }
    }
    return out;
  };
  const functionLike = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node);
  const isScope = (node) => ts.isSourceFile(node) || ts.isModuleBlock(node) || functionLike(node)
    || ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node)
    || ts.isForInStatement(node) || ts.isCatchClause(node) || ts.isCaseBlock(node);
  /**
   * Does THIS scope itself bind `name`?
   *
   * Only its own declarations count, so the walk stops at every nested scope boundary. Scanning a
   * whole subtree instead reads a `const` out of a sibling block that has already closed, which
   * refuses an honest call that reaches the real import: the mirror image of the false accept, and
   * the one that costs coverage silently. `var` is the exception the language itself makes, since it
   * hoists out of blocks up to the enclosing function, so a nested block is still searched for one.
   *
   * A NAMED FUNCTION EXPRESSION binds its own name inside its own body, which no enclosing scope
   * declares: in `const run = function readFileSync() { readFileSync(...) }` the call reaches the
   * function itself. A CLASS declaration binds its name exactly as a `function` declaration does,
   * and a call to it runs a constructor rather than the import. Both are ordinary bindings, and
   * missing either credits the import for a callee the program never reaches.
   */
  const scopeBinds = (scope, name) => {
    if (scope.parameters?.some((param) => boundNames(param.name).includes(name))) return true;
    if (ts.isCatchClause(scope) && boundNames(scope.variableDeclaration?.name).includes(name)) return true;
    // A function expression's own name is in scope throughout its body, and a class expression's
    // name behaves the same way.
    if ((ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name?.text === name) return true;
    const isVar = (declaration) =>
      (declaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
    let found = false;
    const walk = (node, varsOnly) => {
      if (found) return;
      if (ts.isVariableDeclaration(node) && boundNames(node.name).includes(name)
        && (!varsOnly || isVar(node))) { found = true; return; }
      if (!varsOnly && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
        && node.name?.text === name) { found = true; return; }
      // A nested function carries its own `var`s too, so nothing inside it binds here.
      if (functionLike(node)) return;
      // A `catch (e)` binding belongs to its own clause and does not hoist the way `var` does, so
      // descending past one must not carry its parameter out. Its declaration node has no
      // let/const flag, which would otherwise read as a `var` and let a sibling catch shadow a
      // call that never sits inside it.
      if (ts.isCatchClause(node)) {
        if (node.block !== undefined) walk(node.block, true);
        return;
      }
      const inner = varsOnly || isScope(node);
      ts.forEachChild(node, (child) => walk(child, inner));
    };
    ts.forEachChild(scope, (child) => walk(child, false));
    return found;
  };
  // Is the callee's name rebound by some scope that lexically ENCLOSES this use? Walking outward
  // from the use is what makes the question lexical: only a scope the use actually sits inside can
  // shadow it, which is the language's own rule.
  const shadowed = (use, name) => {
    for (let cur = use.parent; cur !== undefined; cur = cur.parent) {
      if (isScope(cur) && scopeBinds(cur, name)) return true;
    }
    return false;
  };
  return (expr) => {
    if (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) {
      return ts.isIdentifier(expr.expression) && namespaces.has(expr.expression.text)
        && (anyName || originals.includes(expr.name.text)) && !shadowed(expr.expression, expr.expression.text);
    }
    if (!ts.isIdentifier(expr)) return false;
    return names.has(expr.text) && !shadowed(expr, expr.text);
  };
};

const pathEval = (suite, source, env = new Map()) => {
  const sf = ast(suite, source);
  const joiners = namedAliases(source, JOINER_MODULES, JOINERS);
  // A scalar binding is resolved at the USE SITE, by walking outward to the nearest enclosing
  // scope that declares the name. A flat name->value map is not a binding: a same-named `ENTRY`
  // in an unrelated function would stand in for the one the launcher actually passes, which
  // asserts a data-flow fact the program does not have. That is the #1586 class, and fixing it
  // for an argv ARRAY while leaving it for the SCALAR the array holds only moves the hole.
  const functionLike = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isClassDeclaration(node);
  // A block is a scope. Treating only functions as scopes reads a `const` from a sibling `if`
  // branch that never ran, which is the same false-accept one level down.
  const blockLike = (node) => ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node)
    || ts.isForInStatement(node) || ts.isCatchClause(node) || ts.isCaseBlock(node) || ts.isModuleBlock(node);
  const scopeOf = (node) => {
    for (let s = node; s !== undefined; s = s.parent) {
      if (ts.isSourceFile(s) || functionLike(s) || blockLike(s)) return s;
    }
    return sf;
  };
  // Textual position is not execution order. A use inside a function body runs when that function
  // is INVOKED: `function run(){ spawn([ENTRY]) } const ENTRY = target; run()` initializes ENTRY
  // before the call and is a real launch, while `run(); const ENTRY = target; function run(){...}`
  // reads ENTRY in its dead zone and is not. The identifier's own offset cannot tell those apart,
  // so the position compared against a declaration is the earliest CALL of the enclosing function.
  const namedFunction = (node) => {
    if (ts.isFunctionDeclaration(node)) return node.name?.text;
    const parent = node.parent;
    if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
      && (ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return parent.name.text;
    return undefined;
  };
  const earliestCall = (name, within) => {
    let earliest;
    const scan = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        const pos = node.getStart(sf);
        if (earliest === undefined || pos < earliest) earliest = pos;
      }
      ts.forEachChild(node, scan);
    };
    scan(within);
    return earliest;
  };
  // Where `use` actually evaluates, relative to declarations in `scope`: its own offset when no
  // function boundary separates the two, and otherwise the earliest call of each function crossed
  // on the way out. `undefined` means the order could not be established -- an anonymous or
  // never-called function -- and every caller must treat that as a refusal rather than a value.
  // A refusal is a claim this tool can back; a guess at invocation order is not.
  const executionPos = (use, scope) => {
    let pos = use.getStart(sf);
    for (let s = use.parent; s !== undefined && s !== scope; s = s.parent) {
      if (!functionLike(s)) continue;
      const name = namedFunction(s);
      if (name === undefined) return undefined;
      const call = earliestCall(name, scope);
      if (call === undefined) return undefined;
      pos = call;
    }
    return pos;
  };
  // A destructuring pattern is a binding. `function run({ENTRY})` declares ENTRY, and reading it as
  // no binding at all lets an outer target-valued ENTRY stand in for the parameter the call really
  // passes, which witnesses a launch THAT IS NOT THERE -- the dangerous direction. The value a
  // pattern binds is not one this tool can follow, so a pattern that can bind the name stops
  // resolution instead of letting the walk continue outward.
  const bindsName = (nameNode, name) => {
    if (ts.isIdentifier(nameNode)) return nameNode.text === name;
    if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      return nameNode.elements.some((element) => ts.isBindingElement(element) && bindsName(element.name, name));
    }
    return false;
  };
  // Declared here, but with no value this tool may claim: a parameter, a declaration with no
  // initializer, or one that appears after the use. Each SHADOWS an outer binding of the same
  // name, so resolution stops rather than walking outward and reporting the outer one's value.
  const OPAQUE = Symbol("declared, value unknown");
  const declarationKind = (declaration) => {
    const list = declaration.parent;
    if (list === undefined || !ts.isVariableDeclarationList(list)) return "other";
    if (list.flags & ts.NodeFlags.Let) return "let";
    if (list.flags & ts.NodeFlags.Const) return "const";
    return "var";
  };
  // What `scope` itself declares for `name`, by the language's rules rather than an approximation
  // of them, because every place the approximation differs is a data-flow fact the program does
  // not have. `var` hoists out of inner blocks to its function and so is collected from them; a
  // `let` or `const` in an inner block is not visible here and is deliberately not collected.
  const declaredIn = (scope, name, useNode) => {
    const usePos = executionPos(useNode, scope);
    let found;
    const record = (value) => { if (found === undefined) found = value; };
    const scan = (node, hoistedOnly) => {
      if (found !== undefined) return;
      if (node !== scope && (functionLike(node) || ts.isSourceFile(node))) return;
      if (node !== scope && blockLike(node)) { ts.forEachChild(node, (child) => scan(child, true)); return; }
      if (!hoistedOnly && ts.isParameter(node) && bindsName(node.name, name)) record(OPAQUE);
      if (ts.isVariableDeclaration(node) && (!hoistedOnly || declarationKind(node) === "var")) {
        if (ts.isIdentifier(node.name) && node.name.text === name) {
          record(node.initializer === undefined || usePos === undefined || node.end > usePos ? OPAQUE : node.initializer);
        } else if (!ts.isIdentifier(node.name) && bindsName(node.name, name)) record(OPAQUE);
      }
      ts.forEachChild(node, (child) => scan(child, hoistedOnly));
    };
    scan(scope, false);
    return found;
  };
  // The repository root, and ONLY where the program actually computes it. An identifier's spelling
  // is not evidence of its value: `const root = mkdtempSync(...)` is a temp directory, and reading
  // it as the repo root invents a data-flow fact that does not exist. A name-shaped root was the
  // exact class #1434 is about, so nothing here looks at identifier text. A binding reaches this
  // value only by evaluating to it, through its declaration.
  const rootish = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 0 && node.expression.getText() === "process.cwd") return true;
    if (ts.isPropertyAccessExpression(node)) {
      const t = node.getText();
      return t === "import.meta.dirname" || t === "process.cwd";
    }
    return false;
  };
  const evalPath = (node) => {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node)) return evalPath(node.expression);
    const literal = stringValue(node);
    if (literal !== undefined) return literal;
    if (ts.isIdentifier(node)) {
      // `const A = B` beside `const B = A` is a program, and it terminates here because a cycle
      // needs one edge pointing at a later declaration, which the use-position rule below stops.
      // A visited set as well would be a second guard for the same case, and mutating either one
      // then proves nothing, because the other still holds.
      for (let scope = scopeOf(node); scope !== undefined;
        scope = ts.isSourceFile(scope) ? undefined : scopeOf(scope.parent)) {
        const declared = declaredIn(scope, node.text, node);
        if (declared === OPAQUE) return undefined;
        if (declared !== undefined) return evalPath(declared);
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "import.meta") {
      if (node.name.text === "dirname") return dirname(resolve(suite));
      if (node.name.text === "url") return resolve(suite);
    }
    if (rootish(node)) return process.cwd();
    // A variable the COMMAND assigned is a known string inside the process it starts.
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "process.env") {
      return env.get(node.name.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return evalPath(node.left) ?? evalPath(node.right);
    }
    // `new URL(spec, import.meta.url)` is how a suite names a sibling file without `path`. It is
    // the same resolution `join` performs, spelled through the URL constructor, so it is evaluated
    // here rather than left undefined. Otherwise every suite using it loses its launch witness.
    if (ts.isNewExpression(node) && calleeText(node.expression) === "URL") {
      const spec = evalPath(node.arguments?.[0]);
      const base = node.arguments?.[1] ? evalPath(node.arguments[1]) : undefined;
      if (typeof spec === "string" && typeof base === "string") return resolve(dirname(base), spec);
      if (typeof spec === "string" && spec.startsWith("file:")) return spec.slice("file://".length);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeText(node.expression);
      const parts = [];
      for (const arg of node.arguments) {
        if (ts.isSpreadElement(arg)) continue;
        parts.push(evalPath(arg) ?? (rootish(arg) ? process.cwd() : undefined));
      }
      if (name === "dirname" && parts.length === 1 && parts[0] !== undefined) return dirname(parts[0]);
      if ((name === "join" || name === "resolve") && joiners(node.expression) && parts.every((part) => part !== undefined)) {
        return resolve(...parts);
      }
      if (name === "fileURLToPath" && parts.length === 1 && parts[0] !== undefined) return parts[0];
    }
    return undefined;
  };
  return { sf, evalPath };
};

const coversPath = (got, want) => {
  if (got === undefined || got === null) return false;
  const g = resolve(got).replaceAll("\\", "/");
  const w = resolve(want).replaceAll("\\", "/");
  return g === w || g.startsWith(w + "/");
};

const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-pe"]);
const NODE_VALUE_FLAGS = new Set([
  "-e", "--eval", "-p", "--print", "-pe",
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "-C", "--conditions", "--env-file", "--env-file-if-exists", "--input-type", "--title",
]);

const flagName = (text) => (typeof text === "string" && text.startsWith("-") ? text.split("=")[0] : "");

const isNodeExecutable = (evalPath, node) => {
  if ((ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node))
    && node.expression.getText() === "process" && node.name.text === "execPath") return true;
  const value = stringValue(node) ?? evalPath(node);
  if (typeof value !== "string") return false;
  const base = value.replaceAll("\\", "/").split("/").pop() ?? "";
  return /^(node|nodejs|tsx)(\.exe|\.cmd)?$/i.test(base);
};

const argvElements = (node) => {
  if (Array.isArray(node)) return node;
  if (!ts.isArrayLiteralExpression(node)) return [];
  return node.elements.filter((el) => !ts.isOmittedExpression(el) && !ts.isSpreadElement(el));
};

/** Node's first positional after flags, or undefined when -e/--eval/-p runs code instead of a file. */
const launchedScriptArg = (evalPath, argvNode) => {
  const tokens = argvElements(argvNode);
  for (let i = 0; i < tokens.length; i++) {
    const raw = stringValue(tokens[i]) ?? evalPath(tokens[i]);
    const text = typeof raw === "string" ? raw : "";
    if (text === "--") return tokens[i + 1];
    const flag = flagName(text);
    if (flag) {
      if (NODE_EVAL_FLAGS.has(flag)) return undefined;
      if (!text.includes("=") && NODE_VALUE_FLAGS.has(flag)) i += 1;
      continue;
    }
    // `node <tsx-cli> <script>` runs the script THROUGH a loader whose own CLI occupies the first
    // positional. The launched file is then the next positional, and it is still an argument of
    // this call in the slot that gets executed, not a path found somewhere nearby.
    if (RUNNER_CLI.test(text.replaceAll("\\", "/"))) return launchedScriptArg(evalPath, tokens.slice(i + 1));
    return tokens[i];
  }
  return undefined;
};

/**
 * The argument arrays a launcher's argv expression can actually be at run time.
 *
 * A genuine invocation often binds its argument list first, as in
 * `const args = mode ? [a, ...] : [b, ...]`, and each branch is a real argv for that call.
 * Resolving them is not a widening: every branch
 * is still an argument of THIS launcher, and the launched-script slot is still located by Node's
 * own flag rules inside it. Refusing these would reject real launches for their spelling, which is
 * the mirror of the mention-shaped accepts this witness exists to close.
 */
const argvCandidates = (node, arrays, depth = 0, use = node) => {
  if (!node || depth > 4) return [];
  if (ts.isParenthesizedExpression(node)) return argvCandidates(node.expression, arrays, depth + 1, use);
  if (ts.isArrayLiteralExpression(node)) return [node];
  if (ts.isConditionalExpression(node)) {
    return [...argvCandidates(node.whenTrue, arrays, depth + 1, use),
      ...argvCandidates(node.whenFalse, arrays, depth + 1, use)];
  }
  if (ts.isIdentifier(node)) return (arrays.get(node.text, use) ?? []);
  return [];
};

/**
 * Paths a `-e`/`--eval` program itself LOADS, by parsing the evaluated source as a module.
 *
 * `node -e "import { f } from '<abs path>'; f()"` runs that file as surely as naming it in the
 * script slot. This is not the mention case the eval rule exists to refuse: the path is not merely
 * near the call, it is a module specifier inside the program being executed, and it is read by
 * parsing that program rather than by matching text around it.
 */
const evaluatedProgramLoads = (evalPath, argvNode) => {
  const tokens = argvElements(argvNode);
  const found = [];
  // A template literal is how a suite injects a computed path into the program it evaluates. Each
  // interpolated span is resolved with the same path evaluator used everywhere else, so the program
  // text is reconstructed before it is parsed; a span that cannot be resolved leaves a placeholder,
  // which simply fails to be an absolute specifier and witnesses nothing.
  const programText = (node) => {
    if (!node) return undefined;
    const literal = stringValue(node);
    if (literal !== undefined) return literal;
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans) {
        // `JSON.stringify(p)` is the ordinary way to quote a path safely inside generated source.
        // Its argument is the path, and the quotes it adds are exactly the quotes the specifier
        // needs, so the resolved value is emitted already quoted.
        const inner = ts.isCallExpression(span.expression)
          && span.expression.expression.getText() === "JSON.stringify"
          ? span.expression.arguments[0] : undefined;
        const quotedValue = inner ? evalPath(inner) : undefined;
        const value = quotedValue !== undefined ? JSON.stringify(quotedValue) : evalPath(span.expression);
        out += (typeof value === "string" ? value : "\u0000") + span.literal.text;
      }
      return out;
    }
    return evalPath(node);
  };
  for (let i = 0; i < tokens.length; i++) {
    const raw = stringValue(tokens[i]) ?? evalPath(tokens[i]);
    const text = typeof raw === "string" ? raw : "";
    const flag = flagName(text);
    let program;
    if (NODE_EVAL_FLAGS.has(flag) && text.includes("=")) program = text.slice(text.indexOf("=") + 1);
    else if (NODE_EVAL_FLAGS.has(flag)) program = programText(tokens[i + 1]);
    if (typeof program !== "string") continue;
    for (const specifier of relativeImports("eval.mts", program)) {
      if (specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier)) found.push(specifier);
    }
  }
  return found;
};

/**
 * Does this suite READ the mutated file's bytes? Only the path argument of a reader counts.
 *
 * Not every mutated file is a module. A manifest or a fixture reaches the suite through
 * `readFileSync(path)`, and mutating it changes what the suite asserts on just as surely as
 * mutating imported source. This is the same shape as the launcher and copier rules: the path must
 * be the argument the call actually reads, not a value sitting near it.
 *
 * A NAMED read of an importable SOURCE module is not an execution witness, and that distinction is
 * the whole point of this tool. Reading a file proves the suite depends on its TEXT. For a data
 * file the text IS the artifact, so a read is the strongest witness available. For a `.ts`/`.js`
 * module the text is not the behaviour: a suite that does `readFileSync("mesh-handler.ts")` and
 * counts `"export class MeshHandler"` reddens when the SPELLING changes and stays green when the
 * SEMANTICS change. Grading that as coverage is the original defect of this tool wearing a
 * data-flow costume, because the read really is evaluated and the path really does resolve; the
 * fact it establishes is simply not execution. A source module has a stronger witness available
 * (import, launch, build), so requiring one costs nothing.
 *
 * A RECURSIVE SWEEP IS THE OPPOSITE CASE AND IS DELIBERATELY LEFT ALONE. A lint that walks
 * `src/**` and asserts a property over every file it finds NEVER NAMES its subjects: the text is
 * not standing in for behaviour, the text IS what the suite asserts about, and a new file in the
 * tree is picked up precisely because nothing enumerated it. `surface.smoke.ts` walking the package
 * for uncatalogued error codes is real coverage of every file it reads, and refusing it would trade
 * a false accept for a false refusal.
 */
/**
 * Environment variables the command itself assigns, as `NAME=value` prefixes on a run step.
 *
 * `COTAL_AGUI_SESSION=<path> tsx suite.ts` is how a workflow points a suite at a fixture. The path
 * is data the command supplies to the process it starts, so a `readFileSync(process.env.NAME)` in
 * that suite really does read that file. Reading it here keeps the witness a data-flow fact: the
 * value comes from the command, not from the variable's spelling.
 */
const commandEnv = (command) => {
  const env = new Map();
  for (const segment of expandScripts(command).split(/&&|;|\|/)) {
    for (const token of segment.trim().split(/\s+/)) {
      const eq = token.indexOf("=");
      if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq))) break;
      env.set(token.slice(0, eq), token.slice(eq + 1).replace(/^["']|["']$/g, ""));
    }
  }
  return env;
};

/**
 * Does this node introduce a lexical scope?
 *
 * Used to RESOLVE a name to its binding rather than to recognise its spelling. A function, a class
 * and a block each bind, and a `for` header binds its own loop variable, so a walk that skipped
 * blocks would report an outer binding for a name an inner `const` had already taken.
 */
const isScopeNode = (node) => ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)
  || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
  || ts.isCatchClause(node) || ts.isCaseBlock(node) || ts.isFunctionDeclaration(node)
  || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
  || ts.isConstructorDeclaration(node) || ts.isClassDeclaration(node);

/** Does this binding name, including a destructuring pattern, bind `ident`? */
const bindingBinds = (nameNode, ident) => {
  if (nameNode === undefined) return false;
  if (ts.isIdentifier(nameNode)) return nameNode.text === ident;
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    return nameNode.elements.some((element) => ts.isBindingElement(element) && bindingBinds(element.name, ident));
  }
  return false;
};

/**
 * Does THIS scope itself declare `ident`, by any binding form the language has?
 *
 * Deliberately over-inclusive: a parameter, an import, a `var`/`let`/`const`, a destructured
 * element, a function or class declaration all count. Over-reporting a binding can only make a
 * name fail to resolve to the global, and an unresolved name is treated as OPEN, which makes the
 * sweep count. Under-reporting would bless a shadowed local as the global conversion, which is the
 * false-identity route sol found at v2.
 */
const declaresLocally = (scope, ident) => {
  let found = false;
  const visit = (node) => {
    if (found) return;
    // A function or class DECLARATION binds its own name in the enclosing scope, so it is recorded
    // before the walk declines to descend into its body.
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && node.name !== undefined && node.name.text === ident) { found = true; return; }
    if (ts.isVariableDeclaration(node) && bindingBinds(node.name, ident)) { found = true; return; }
    if (ts.isParameter(node) && bindingBinds(node.name, ident)) { found = true; return; }
    if (ts.isImportSpecifier(node) && node.name.text === ident) { found = true; return; }
    if (ts.isNamespaceImport(node) && node.name.text === ident) { found = true; return; }
    if (ts.isImportClause(node) && node.name !== undefined && node.name.text === ident) { found = true; return; }
    if (ts.isCatchClause(node) && bindingBinds(node.variableDeclaration?.name, ident)) { found = true; return; }
    if (node !== scope && isScopeNode(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
};

/**
 * Are the entries this listing produces actually READ?
 *
 * A directory listing by itself observes names, not bytes: mutating a file's contents cannot change
 * it. The listing therefore witnesses a read only when its entries flow into a reader, which is the
 * `for (const f of readdirSync(...)) readFileSync(<f>)` shape. The binding is followed by identity,
 * so a loop that reads some other path does not count.
 *
 * A sweep also has to still BE a sweep at the point of the read. A listing is real coverage because
 * it never enumerates its subjects, so a new file is caught precisely because nothing named it. One
 * `continue` on an equality against a single known path takes that away: the loop still walks the
 * tree, but only one entry ever reaches the reader, and the suite is back to reading a file it
 * names. The question is the CARDINALITY the guard chain admits rather than the presence of a
 * particular spelling, so the conditions that must hold for control to reach a reader are collected
 * and a reader that only one value of the loop variable can reach is not counted.
 */
const listingIsRead = (call, readers, evalPath) => {
  for (let cur = call.parent; cur !== undefined; cur = cur.parent) {
    if (!ts.isForOfStatement(cur)) continue;
    const decl = cur.initializer;
    const name = ts.isVariableDeclarationList(decl) && decl.declarations[0]
      && ts.isIdentifier(decl.declarations[0].name) ? decl.declarations[0].name.text : undefined;
    if (name === undefined) return false;
    // Does this expression carry the loop entry at all? An any-occurrence walk, which is what a
    // reader's ARGUMENT needs: it decides whether the read reads the entry, not how many entries
    // reach it. A loop-local `const` alias is followed to its initializer, because
    // `const entry = String(f); readFileSync(join(DIR, entry))` reads the entry just as surely as
    // spelling `String(f)` in the argument. Not following it refuses an entirely OPEN aliased
    // sweep, which is the failure with no alarm attached: nothing reds, coverage just stops
    // counting. That refusal is live at `cbf0ab8c3` and this is what fixes it.
    const mentions = (e, seen) => {
      if (!e) return false;
      if (ts.isIdentifier(e)) {
        if (e.text === name) return true;
        const visited = seen ?? new Set();
        if (visited.has(e.text)) return false;
        visited.add(e.text);
        const declaration = aliasDeclaration(e);
        return declaration !== undefined && mentions(declaration.initializer, visited);
      }
      let found = false;
      ts.forEachChild(e, (c) => { if (mentions(c, seen)) found = true; });
      return found;
    };
    // The `const` declaration this identifier resolves to, when it is a loop-local alias whose
    // value cannot change between the binding and the guard. Everything here is a REASON the alias
    // is the same value, not a shape: it must be declared inside this loop's body, be `const`, have
    // a plain identifier name, and never appear as an assignment target. A `let`, a parameter, a
    // destructured element or an outer binding all return undefined, and an unresolved alias is
    // simply not an identity, which leaves the guard OPEN and the sweep counting.
    const aliasDeclaration = (node) => {
      for (let s = node.parent; s !== undefined; s = s.parent) {
        if (!isScopeNode(s)) continue;
        let found;
        const visit = (n) => {
          if (found !== undefined) return;
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === node.text) {
            found = n; return;
          }
          if (n !== s && isScopeNode(n)) return;
          ts.forEachChild(n, visit);
        };
        ts.forEachChild(s, visit);
        if (found === undefined) {
          // Not bound here. Stop at the loop: a binding outside the loop body is not a per-entry
          // alias, so it is not followed.
          if (s === cur) return undefined;
          continue;
        }
        const list = found.parent;
        if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
        // Inside THIS loop's body, or it is not a per-entry binding.
        let inLoop = false;
        for (let p = found; p !== undefined; p = p.parent) if (p === cur) { inLoop = true; break; }
        if (!inLoop) return undefined;
        // `const` cannot be reassigned, but a declaration this walk mis-identified could be; the
        // check costs nothing and makes the "never reassigned" clause of the contract explicit.
        if (reassignedIn(cur, node.text)) return undefined;
        return found;
      }
      return undefined;
    };
    // Is this name ever an assignment target inside the loop?
    const reassignedIn = (root, ident) => {
      let assigned = false;
      const visit = (n) => {
        if (assigned) return;
        if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && n.left.text === ident
          && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) { assigned = true; return; }
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
          && ts.isIdentifier(n.operand) && n.operand.text === ident
          && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
          assigned = true; return;
        }
        ts.forEachChild(n, visit);
      };
      visit(root);
      return assigned;
    };
    // `a === b` pins the entry when it HOLDS and one side is the entry, value-preserving, while the
    // other resolves to a single known string. A side counts as known when the path evaluator
    // resolves it, which covers a literal and a constant the program computes.
    const pinsEquality = (cond, holds) => {
      if (!holds) return false;
      const known = (n) => (stringValue(n) ?? evalPath(n)) !== undefined;
      return (entryIdentity(cond.left) && known(cond.right)) || (entryIdentity(cond.right) && known(cond.left));
    };
    // Does this identifier RESOLVE to the global `String`, or has some enclosing scope bound the
    // name to something else? Resolution, not spelling. v2 compared the callee's terminal NAME, so
    // `helper.String(f)` and a shadowed local `const String = v => …` both read as the global
    // conversion: the first refused a legitimate open sweep, the second blessed a many-to-one
    // projection as identity. Walking out to the source file and asking each scope whether it
    // declares the name answers the question the name cannot.
    const resolvesToGlobalString = (node) => {
      if (!ts.isIdentifier(node) || node.text !== "String") return false;
      for (let s = node.parent; s !== undefined; s = s.parent) {
        if (!isScopeNode(s)) continue;
        if (declaresLocally(s, "String")) return false;
      }
      return true;
    };
    // Is this expression the loop entry, VALUE-PRESERVING?
    //
    // `mentions` is an any-occurrence walk, which is what a reader's argument needs but is far too
    // loose for an equality: `String(f).slice(-3) !== ".ts"` mentions `f` and sits next to a known
    // string, yet it pins an EXTENSION and not an entry. Only an identity-preserving projection
    // counts, meaning one that sends distinct entries to distinct values. A bare identifier is one.
    // `String(f)` is one when `String` really is the global, because it fixes the representation
    // and nothing else. `f.slice(…)`, `basename(f)`, `f.toLowerCase()` and `f + x` are NOT: each
    // sends many entries onto one value, so an equality against a single known string leaves the
    // sweep open.
    //
    // A `const` bound to an identity inside the loop is the SAME VALUE under a second name, so it
    // is followed to its initializer. `let` is not: a reassignment elsewhere in the body would make
    // the binding's value at the guard something this walk cannot claim.
    const entryIdentity = (e, depth = 0) => {
      if (!e || depth > 16) return false;
      // Type-only and grouping wrappers carry no runtime value change, so they are transparent.
      // `as`/`satisfies`/`!` are erased before the program runs; parentheses never existed.
      if (ts.isParenthesizedExpression(e)) return entryIdentity(e.expression, depth + 1);
      if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)
        || ts.isTypeAssertionExpression(e)) return entryIdentity(e.expression, depth + 1);
      if (ts.isIdentifier(e)) {
        if (e.text === name) return true;
        // A loop-local alias. The declaration has to be inside the loop body, `const`, and never
        // reassigned, or the value at the guard is not the one the initializer gives.
        const declaration = aliasDeclaration(e);
        return declaration !== undefined && entryIdentity(declaration.initializer, depth + 1);
      }
      // A call is identity only when the callee RESOLVES to the global `String`, called DIRECTLY.
      // A property access is never the global binding however its terminal name is spelled, so
      // `helper.String(f)` and `globalThis.String(f)` are both projections here; the first really
      // is many-to-one, and the second is refused only as a conservative OPEN, which counts.
      return ts.isCallExpression(e) && resolvesToGlobalString(e.expression)
        && e.arguments.length === 1 && entryIdentity(e.arguments[0], depth + 1);
    };
    // Does `cond`, when it evaluates to `holds`, constrain the entry to exactly ONE value?
    //
    // A THREE-VALUED EVALUATION over the boolean structure, not a match against known spellings.
    // The crucial property is the default: ANYTHING THIS CANNOT CLASSIFY IS OPEN. An unrecognised
    // guard therefore makes the sweep COUNT; it never lets a named read masquerade as a sweep.
    // That is what makes a spelling nobody enumerated safe, and it is why v1 and v2 both fell:
    // each answered the question by recognising a finite set of shapes, and the set of ways to
    // write a condition is open.
    const pins = (cond, holds, depth = 0) => {
      if (!cond || depth > 32) return false;
      if (ts.isParenthesizedExpression(cond)) return pins(cond.expression, holds, depth + 1);
      // `!` inverts the SENSE rather than dropping out: reaching a read guarded by `!(f !== ONE)`
      // being TRUE is reaching it with `f !== ONE` being FALSE, which is the case that pins.
      if (ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken) {
        return pins(cond.operand, !holds, depth + 1);
      }
      if (ts.isBinaryExpression(cond)) {
        const kind = cond.operatorToken.kind;
        // A true `&&` makes BOTH operands true, so an operand that pins pins the whole branch. A
        // false `&&` says merely that SOME operand was false, which narrows nothing: past
        // `if (f !== ONE && other) continue` the entry is still free. `||` is the mirror image.
        if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          return holds ? (pins(cond.left, true, depth + 1) || pins(cond.right, true, depth + 1)) : false;
        }
        if (kind === ts.SyntaxKind.BarBarToken) {
          return holds ? false : (pins(cond.left, false, depth + 1) || pins(cond.right, false, depth + 1));
        }
        // `a !== b` is `a === b` with the sense flipped, so it delegates rather than repeating the
        // equality rule with the operator table inverted.
        if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken) {
          const eq = ts.factory.createBinaryExpression(cond.left, ts.SyntaxKind.EqualsEqualsEqualsToken, cond.right);
          return pinsEquality(eq, !holds);
        }
        if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken) {
          return pinsEquality(cond, holds);
        }
        return false;
      }
      // A ternary is a boolean value like any other, so it is EVALUATED rather than matched.
      // With boolean-literal arms it reduces to its condition, which is the shape sol defeated v2
      // with. With other arms, control reaching `holds` can come through EITHER branch that can
      // yield `holds`, so every such branch must pin, or some branch leaves the entry free.
      if (ts.isConditionalExpression(cond)) {
        const arm = (e) => (e.kind === ts.SyntaxKind.TrueKeyword ? true
          : e.kind === ts.SyntaxKind.FalseKeyword ? false : undefined);
        const whenTrue = arm(cond.whenTrue);
        const whenFalse = arm(cond.whenFalse);
        if (whenTrue !== undefined && whenFalse !== undefined) {
          if (whenTrue === whenFalse) return false;
          return pins(cond.condition, whenTrue === holds, depth + 1);
        }
        // Each branch that can still produce `holds` has to pin on its own, together with the
        // condition that selects it.
        const viaTrue = whenTrue === undefined || whenTrue === holds;
        const viaFalse = whenFalse === undefined || whenFalse === holds;
        const truePins = !viaTrue
          || (pins(cond.condition, true, depth + 1) || pins(cond.whenTrue, holds, depth + 1));
        const falsePins = !viaFalse
          || (pins(cond.condition, false, depth + 1) || pins(cond.whenFalse, holds, depth + 1));
        return (viaTrue || viaFalse) && truePins && falsePins;
      }
      // Anything else is OPEN. This is the default that makes the classifier safe.
      return false;
    };
    const exits = (stmt) => {
      if (!stmt) return false;
      if (ts.isContinueStatement(stmt) || ts.isBreakStatement(stmt)
        || ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
      return ts.isBlock(stmt) && stmt.statements.length > 0 && stmt.statements.some(exits);
    };
    // Conditions that MUST hold for control to reach this node, walking out to the loop. Two
    // sources: a branch of an enclosing `if` this node sits in, and a preceding `if (…) continue`
    // in the same block, whose condition must have been FALSE for the node to be reached at all.
    const narrowedToOneEntry = (node) => {
      for (let n = node; n !== undefined && n !== cur; n = n.parent) {
        const parent = n.parent;
        if (parent === undefined) break;
        if (ts.isIfStatement(parent)) {
          if (parent.thenStatement === n && pins(parent.expression, true)) return true;
          if (parent.elseStatement === n && pins(parent.expression, false)) return true;
        }
        if (ts.isBlock(parent)) {
          const index = parent.statements.indexOf(n);
          for (const earlier of parent.statements.slice(0, index < 0 ? 0 : index)) {
            if (ts.isIfStatement(earlier) && earlier.elseStatement === undefined
              && exits(earlier.thenStatement) && pins(earlier.expression, false)) return true;
          }
        }
      }
      return false;
    };
    let read = false;
    const scan = (n) => {
      if (read) return;
      if (ts.isCallExpression(n) && readers(n.expression)) {
        const arg = n.arguments[0];
        if (mentions(arg) && !narrowedToOneEntry(n)) read = true;
        else if (mentions(arg) && evalPath) evalPath.narrowed = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(cur.statement);
    return read;
  }
  return false;
};

/**
 * Is this node inside a branch a literal condition excludes?
 *
 * `if (false) { … }` and the `else` of `if (true)` never run. Only literal `true`/`false` is
 * folded: any other condition is a value the program computes, and guessing at it would be the
 * same kind of proxy this module exists to avoid.
 */
const inDeadBranch = (node) => {
  for (let cur = node; cur.parent !== undefined; cur = cur.parent) {
    const parent = cur.parent;
    if (!ts.isIfStatement(parent)) continue;
    const kind = parent.expression.kind;
    if (kind === ts.SyntaxKind.FalseKeyword && parent.thenStatement === cur) return true;
    if (kind === ts.SyntaxKind.TrueKeyword && parent.elseStatement === cur) return true;
  }
  return false;
};

/**
 * Does this call INVOKE the function it is handed, and in this argument slot?
 *
 * An allowlist, deliberately. The alternative is to assume every callee invokes its arguments,
 * which is how `console.log(used)` came to count as execution. Being wrong here must mean
 * REFUSING a real load (a missing entry costs a gradable config, and shows up as a lost config in
 * the corpus sweep, which is visible) rather than ACCEPTING a load that never happens (which is
 * invisible and is the #1434 defect itself).
 */
const INVOKING_CALLS = new Map([
  ["queueMicrotask", [0]], ["setTimeout", [0]], ["setInterval", [0]], ["setImmediate", [0]],
  ["then", [0, 1]], ["catch", [0]], ["finally", [0]],
  ["map", [0]], ["forEach", [0]], ["filter", [0]], ["find", [0]], ["findIndex", [0]],
  ["some", [0]], ["every", [0]], ["flatMap", [0]], ["sort", [0]], ["reduce", [0]],
  ["on", [1]], ["once", [1]], ["addEventListener", [1]], ["addListener", [1]],
  ["process.nextTick", [0]], ["Promise.all", []], ["it", [1]], ["test", [1]], ["describe", [1]],
  ["before", [0]], ["after", [0]], ["beforeEach", [0]], ["afterEach", [0]],
]);
const invokesArgument = (call, arg) => {
  const callee = calleeText(call.expression);
  const method = callee.includes(".") ? callee.slice(callee.lastIndexOf(".") + 1) : callee;
  const slots = INVOKING_CALLS.get(callee) ?? INVOKING_CALLS.get(method);
  if (slots === undefined) return false;
  const index = call.arguments.indexOf(arg);
  return index >= 0 && slots.includes(index);
};

/**
 * Does control reach this node when the module is loaded?
 *
 * Top-level code runs on load. Code inside a function runs only if something calls that function,
 * so a deferred site is admitted only when its enclosing function is actually reachable: a callback
 * passed straight to a call, or a binding whose name is used somewhere other than its declaration.
 */
const evaluated = (node, sf) => {
  if (inDeadBranch(node)) return false;
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    const isFn = ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur)
      || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur);
    if (!isFn) continue;
    const parent = cur.parent;
    // Passed directly to a call (a callback) or immediately invoked: it runs.
    if (parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent))
      && parent.expression !== cur) return true;
    if (parent && ts.isParenthesizedExpression(parent) && parent.parent
      && ts.isCallExpression(parent.parent)) return true;
    const name = ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)
      ? (cur.name && ts.isIdentifier(cur.name) ? cur.name.text : undefined)
      : (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined);
    if (name === undefined) return false;
    // MENTIONING a function is not RUNNING it. `void used;` and `export { used }` reference the
    // binding without ever transferring control into it, so the body never executes and a load
    // inside it never happens. Only a site that actually invokes the name counts: a call, a `new`,
    // or handing the function to another call that will invoke it (a callback).
    let invoked = false;
    const scan = (n) => {
      if (invoked) return;
      if (ts.isIdentifier(n) && n.text === name && n !== cur.name && !inDeadBranch(n)) {
        const parentNode = n.parent;
        const isCallee = parentNode
          && (ts.isCallExpression(parentNode) || ts.isNewExpression(parentNode))
          && parentNode.expression === n;
        // Being an ARGUMENT is not being CALLED. `console.log(used)` receives the function object
        // and never invokes it, so the body does not run. Argument position is another cheap proxy
        // for invocation, in the same family as the identifier-reference proxy it replaced, and it
        // errs the same way: toward accepting too much. Acceptance therefore requires an API that
        // is KNOWN to invoke what it is handed, in the parameter slot where it does so.
        const isCallbackArg = parentNode
          && (ts.isCallExpression(parentNode) || ts.isNewExpression(parentNode))
          && invokesArgument(parentNode, n);
        if (isCallee || isCallbackArg) invoked = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(sf);
    if (!invoked) return false;
    // The enclosing function is reached; keep walking outward for further nesting.
  }
  return true;
};

const READERS = ["readFileSync", "readFile", "openSync", "createReadStream"];
/**
 * Is this file an importable source MODULE, as opposed to data?
 *
 * The test is the file's own extension, which is what decides whether a module loader will execute
 * it. That is a property of the artifact, not a witness about any suite, so it is a fair thing to
 * read off a path: `.ts` means a loader can run it, `.json`/`.yml`/`.md` means nothing executes it
 * and its bytes are its entire contribution. `.json` is deliberately DATA here even though it is
 * importable, because importing JSON yields a value rather than behaviour, so a read of it and an
 * import of it establish the same fact.
 */
const SOURCE_MODULE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const isSourceModule = (file) => SOURCE_MODULE.has(extname(file));
/**
 * A recursive directory read is a read of every file under that directory.
 *
 * `readdirSync(dir, { recursive: true })` followed by a read of each entry is how a suite grades a
 * whole tree, and mutating any file in the tree changes its result. The witness is the RECURSIVE
 * flag in the call the suite makes, not a path spelling: a non-recursive listing covers only its
 * own directory, and is treated that way.
 */
const READDIRS = ["readdirSync", "readdir", "globSync", "glob"];
const readsFile = (suite, source, file, env = new Map(), audit) => {
  const { sf, evalPath } = pathEval(suite, source, env);
  const readers = namedAliases(source, "fs", READERS);
  let hit = false;
  const listers = namedAliases(source, "fs", READDIRS);
  const want = resolve(file);
  const visit = (node) => {
    if (ts.isCallExpression(node) && readers(node.expression) && evaluated(node, sf)) {
      const target = node.arguments[0];
      // A read of a file the suite NAMES is a proxy for that file's behaviour, and for a source
      // module the text is not the behaviour: this is the `mesh-seam` shape, where the suite counts
      // `export class MeshHandler` in `mesh-handler.ts`. A source module always has a stronger
      // witness available, so requiring one costs nothing. Data files keep the read, because for
      // them the bytes ARE the artifact and no stronger witness exists.
      if (target && !ts.isSpreadElement(target) && coversPath(evalPath(target), file)
        && !isSourceModule(file)) hit = true;
    }
    if (ts.isCallExpression(node) && listers(node.expression) && evaluated(node, sf)) {
      const dir = evalPath(node.arguments[0]);
      const options = node.arguments[1];
      const recursive = options !== undefined && ts.isObjectLiteralExpression(options)
        && options.properties.some((prop) => ts.isPropertyAssignment(prop)
          && prop.name.getText() === "recursive"
          && prop.initializer.kind === ts.SyntaxKind.TrueKeyword);
      if (typeof dir === "string") {
        const base = resolve(dir);
        const under = want === base || want.startsWith(base.endsWith("/") ? base : base + "/");
        if (under && (recursive || dirname(want) === base) && listingIsRead(node, readers, evalPath)) hit = true;
        if (under && evalPath.narrowed && audit) audit.narrowed = true;
        if (!under && audit) audit.outside = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
};

/** Every repo path this suite hands to a launcher in the slot that actually gets executed. */
const launchedPaths = (suite, source) => {
  const { sf, evalPath } = pathEval(suite, source);
  const launchers = namedAliases(source, LAUNCHER_MODULES, LAUNCHERS);
  // Resolve an argv identifier the way the language does: to the declaration that is actually in
  // scope at the use site. A flat name->value map is not a binding, it is a name collision waiting
  // to happen: a same-named `args` in an unrelated function would stand in for the launcher's own,
  // which asserts a data-flow fact the program does not have. Lookup therefore walks outward from
  // the use and stops at the nearest enclosing scope that declares the name.
  const declaresIn = (scope, name) => {
    let found;
    const scan = (node) => {
      if (found !== undefined) return;
      if (node !== scope && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node))) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
        && node.initializer) found = node.initializer;
      ts.forEachChild(node, scan);
    };
    scan(scope);
    return found;
  };
  const arrays = {
    get: (name, use) => {
      for (let scope = use?.parent; scope !== undefined; scope = scope.parent) {
        const initializer = declaresIn(scope, name);
        if (initializer !== undefined) return argvCandidates(initializer, arrays, 0, initializer);
      }
      return undefined;
    },
  };
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && launchers(node.expression) && evaluated(node, sf)) {
      const args = node.arguments.filter((arg) => !ts.isSpreadElement(arg));
      const command = args[0];
      const argv = args[1] && !ts.isObjectLiteralExpression(args[1]) ? args[1] : undefined;
      const direct = command ? evalPath(command) : undefined;
      if (typeof direct === "string") found.push(direct);
      if (command && isNodeExecutable(evalPath, command) && argv) {
        for (const candidate of argvCandidates(argv, arrays, 0, argv)) {
          const script = launchedScriptArg(evalPath, candidate);
          const value = script ? evalPath(script) : undefined;
          if (typeof value === "string") found.push(value);
          for (const loaded of evaluatedProgramLoads(evalPath, candidate)) found.push(loaded);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};



/**
 * Does this suite COPY the declared root? Only the source argument's own VALUE counts.
 *
 * `cpSync(src, dest, options)` copies `src`. Scanning every argument let an options object carry
 * the root, such as `{ note: join(ROOT, "packages", "seat") }` or a `filter` mentioning it, and that is a
 * mention again, one argument to the right of the one that does the work.
 *
 * Scanning the source argument's whole SUBTREE is the same defect one level further in, and it is
 * live: `cpSync(elsewhere(join(ROOT, "packages", "seat")), dest)` copies whatever `elsewhere`
 * returns, while the declared root sits inside an argument of that call and never names the tree
 * copied. So the source expression is EVALUATED, by the same path evaluator every other witness
 * here uses, and the root counts only when the value the copier receives covers it. A source this
 * evaluator cannot resolve is a refusal, which costs a config visibly, rather than an accept, which
 * is silent.
 */
const copiesRoot = (suite, source, root) => {
  const { sf, evalPath } = pathEval(suite, source);
  const copiers = namedAliases(source, "fs", COPIERS);
  let hit = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && copiers(node.expression) && evaluated(node, sf)) {
      const from = node.arguments[0];
      if (from && !ts.isSpreadElement(from) && coversPath(evalPath(from), root)) hit = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
};

/**
 * Does this suite VALUE-import the mutated file, resolving the specifier to a real path?
 *
 * The predicate this replaced asked only whether some `../src/` specifier existed anywhere in the
 * suite, which is the same mention-shaped accept one layer up: any same-package suite importing any
 * source file admitted every other file in that package. So the specifier is resolved with the same
 * candidate-extension rule the rest of the tool uses, and the walk continues through the imported
 * file's own relative imports, because a suite that imports a barrel does reach what the barrel
 * re-exports. A type-only import is erased before anything runs and is therefore never a load.
 */
const importsSource = (path, source, target) => {
  const want = resolve(target);
  const seen = new Set();
  const queue = [];
  const specOk = (value) => {
    if (typeof value !== "string") return false;
    return value.startsWith(".");
  };
  const collect = (from, src) => {
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true && node.moduleSpecifier) {
        // `import { type X }` puts the modifier on each specifier; a clause whose bindings are ALL
        // type-only is erased exactly like `import type`, so it is not a load either.
        const named = node.importClause?.namedBindings;
        const allTypeOnly = named !== undefined && ts.isNamedImports(named) && named.elements.length > 0
          && named.elements.every((el) => el.isTypeOnly === true)
          && node.importClause?.name === undefined;
        if (!allTypeOnly && specOk(stringValue(node.moduleSpecifier))) queue.push([from, stringValue(node.moduleSpecifier)]);
      }
      if (ts.isExportDeclaration(node) && node.isTypeOnly !== true && node.moduleSpecifier) {
        if (specOk(stringValue(node.moduleSpecifier))) queue.push([from, stringValue(node.moduleSpecifier)]);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // A dynamic import loads when it is EVALUATED. One parked inside a function nobody calls
        // never runs, so the module never loads and a mutation in it cannot change this suite's
        // result. Appearing in the file is not evaluation.
        if (specOk(stringValue(node.arguments[0])) && evaluated(node, sf)) {
          queue.push([from, stringValue(node.arguments[0])]);
        }
      }
      ts.forEachChild(node, visit);
    };
    const sf = ast(from, src);
    visit(sf);
  };
  collect(path, source);
  while (queue.length > 0 && seen.size < SOURCE_REACH_LIMIT) {
    const [from, specifier] = queue.shift();
    const next = candidateFiles(resolve(dirname(from), specifier));
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    if (next === want) return true;
    let nextSource;
    try { nextSource = readFileSync(next, "utf8"); } catch { continue; }
    collect(next, nextSource);
  }
  return false;
};

/**
 * Value-imports of a package's BUILT output, as source-root relative directories.
 *
 * A suite that `await import("../dist/index.js")` is loading bytes the build produced from that
 * package's `src`. That is a genuine data-flow fact, but only when the command actually builds the
 * package, so `buildsPackage` remains the other half of the pair. Without the build it is a stale
 * artifact and proves nothing, which is exactly why this is not a witness on its own.
 */
/**
 * Map a built artifact back to the ONE source file the compiler emits it from.
 *
 * `dist/index.js` is produced by `src/index.ts` under the package's own `rootDir`/`outDir`, so the
 * mapping is a fact the build config states, not a guess. Reducing the import to the package root
 * instead would make every file under the package look loaded, including smoke helpers that are
 * never compiled into dist at all.
 */
const sourceOfBuilt = (absolute) => {
  const root = packageRoot(relative(process.cwd(), absolute));
  if (!root) return undefined;
  let out = "dist", src = "src";
  try {
    const cfg = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    out = (cfg.compilerOptions?.outDir ?? out).replace(/^\.\//, "").replace(/\/$/, "");
    src = (cfg.compilerOptions?.rootDir ?? src).replace(/^\.\//, "").replace(/\/$/, "");
  } catch { /* defaults above are this repo's convention */ }
  const rel = relative(resolve(root, out), absolute).replaceAll("\\", "/");
  if (rel.startsWith("..")) return undefined;
  return candidateFiles(resolve(root, src, rel));
};

/**
 * Is the object carrying this `entry` property HANDED to a call that can start the thread?
 *
 * The property records a path; only passing the object to something else makes that path run. The
 * receiving callee must resolve to an imported binding, by the same provenance rule the launcher,
 * reader and copier witnesses use: a local `function runInWorker(){}` starts no thread, and neither
 * does `console.log`. The call must also be reached on load, so a helper nothing invokes does not
 * count. The object is followed through one `const` binding, because
 * `const options = { entry: … }; runInWorker(input, options)` hands it over exactly as an inline
 * literal does.
 */
const handedToImportedCall = (property, sf, imported) => {
  const object = property.parent;
  if (!ts.isObjectLiteralExpression(object)) return false;
  const passedTo = (expr) => {
    const parent = expr.parent;
    if (parent === undefined) return false;
    if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) return false;
    if (!parent.arguments?.includes(expr)) return false;
    return imported(parent.expression) && evaluated(parent, sf);
  };
  if (passedTo(object)) return true;
  const declaration = object.parent;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)
    || !ts.isIdentifier(declaration.name)) return false;
  const name = declaration.name.text;
  let hit = false;
  const scan = (node) => {
    if (hit) return;
    if (ts.isIdentifier(node) && node.text === name && node !== declaration.name && passedTo(node)) {
      hit = true;
      return;
    }
    ts.forEachChild(node, scan);
  };
  scan(sf);
  return hit;
};

const importsBuiltOutput = (path, source) => {
  const roots = [];
  const sf = ast(path, source);
  const imported = namedAliases(source, ANY_IMPORT, ANY_IMPORT);
  // A worker entry is written as `new URL(spec, import.meta.url)`, as a plain string, or as a
  // const holding one. An identifier is resolved to the initialiser it is DECLARED with rather
  // than by its spelling, so the fact recorded is the path the program actually hands over.
  const declared = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declared.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const distUrlText = (node) => {
    let target = node;
    if (ts.isIdentifier(target)) {
      const bound = declared.get(target.text);
      if (bound === undefined) return undefined;
      target = bound;
    }
    if (ts.isNewExpression(target) && calleeText(target.expression) === "URL" && target.arguments?.[0]) {
      target = target.arguments[0];
    }
    return stringValue(target);
  };
  const record = (value) => {
    if (typeof value !== "string") return;
    const v = value.replaceAll("\\", "/");
    if (!/(?:^|\/)dist\//.test(v) && !/(?:^|\/)dist$/.test(v)) return;
    const entry = sourceOfBuilt(resolve(dirname(path), v));
    if (entry !== undefined) roots.push(entry);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true && node.moduleSpecifier) {
      record(stringValue(node.moduleSpecifier));
    }
    if (ts.isExportDeclaration(node) && node.isTypeOnly !== true && node.moduleSpecifier) {
      record(stringValue(node.moduleSpecifier));
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(stringValue(node.arguments[0]));
    }
    // A worker thread's entry is EXECUTED, not imported, so it never appears as an import
    // declaration. The thread is started by `new Worker(options.entry)` inside the worker helper,
    // so the fact that identifies the running module is the dist URL THIS file hands over as the
    // `entry` it asks to be run: `{ entry: new URL("../dist/engine/worker-entry.js", ...) }`. The
    // mutated source is compiled into that artifact, so the caller still pairs this with a build
    // exactly as for a dist import, because without one the thread starts a stale artifact. Only a
    // `dist` path is recorded, by the same `record` that guards every other route here.
    //
    // HANDING IT OVER is the whole fact, so the property alone is not enough: writing
    // `const options = { entry: new URL("../dist/index.js", …) }; console.log(options)` starts no
    // thread, and recording it is the mention-shaped accept of #1434 arriving one route over. The
    // object therefore has to be an argument of a call that actually runs, and the callee has to be
    // a binding an import put there, by the same provenance rule the launcher and reader witnesses
    // use. A local helper or a global writer receiving the object proves nothing about a thread.
    if (ts.isPropertyAssignment(node) && node.name.getText() === "entry" && handedToImportedCall(node, sf, imported)) {
      record(distUrlText(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return roots;
};

const validStringArray = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "");

const candidateFiles = (path) => {
  const out = [path];
  if ([".js", ".mjs", ".cjs"].includes(extname(path))) {
    out.push(path.slice(0, -extname(path).length) + ".ts");
    out.push(path.slice(0, -extname(path).length) + ".mts");
    out.push(path.slice(0, -extname(path).length) + ".cts");
  }
  out.push(resolve(path, "index.ts"), resolve(path, "index.mts"), resolve(path, "index.js"));
  return [...new Set(out)].find(existsSync);
};

const ast = (path, source) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const stringValue = (node) => ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
/**
 * Specifiers this file LOADS at run time. Type-only imports are erased by the compiler and never
 * load anything, so they cannot carry a mutation to the running program.
 */
const relativeImports = (path, source) => {
  const found = [];
  const valueImport = (node) => {
    if (node.importClause?.isTypeOnly === true) return false;
    const named = node.importClause?.namedBindings;
    if (named !== undefined && ts.isNamedImports(named) && named.elements.length > 0
      && named.elements.every((el) => el.isTypeOnly === true)
      && node.importClause?.name === undefined) return false;
    return true;
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      if (valueImport(node)) {
        const value = stringValue(node.moduleSpecifier);
        if (value !== undefined) found.push(value);
      }
    } else if (ts.isExportDeclaration(node) && node.isTypeOnly !== true && node.moduleSpecifier) {
      const value = stringValue(node.moduleSpecifier);
      if (value !== undefined) found.push(value);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const value = stringValue(node.arguments[0]);
      if (value !== undefined) found.push(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast(path, source));
  return found;
};

/**
 * Does `entry`'s own source tree load `target`, following only relative specifiers?
 *
 * This is the data-flow fact behind a suite that launches a package's real entrypoint under a TS
 * runner: the entrypoint is source, its relative imports are source, and the mutated file is one
 * of them. Resolution is by the same candidate-extension rule the executes walk uses, so a `.js`
 * specifier finds the `.ts` that produces it. Bare specifiers stop the walk: a by-name import
 * resolves to a package's dist, which a source mutation does not reach.
 */
const SOURCE_REACH_LIMIT = 400;
const sourceReachCache = new Map();
const sourceReaches = (entry, target) => {
  const start = candidateFiles(resolve(entry));
  if (start === undefined) return false;
  const want = resolve(target);
  const key = `${start}\u0000${want}`;
  if (sourceReachCache.has(key)) return sourceReachCache.get(key);
  const seen = new Set();
  const queue = [start];
  let hit = false;
  while (queue.length > 0 && seen.size < SOURCE_REACH_LIMIT) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    if (path === want) { hit = true; break; }
    let source;
    try { source = readFileSync(path, "utf8"); } catch { continue; }
    for (const specifier of relativeImports(path, source)) {
      if (!specifier.startsWith(".")) continue;
      const next = candidateFiles(resolve(dirname(path), specifier));
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
  }
  sourceReachCache.set(key, hit);
  return hit;
};

const manifestByName = new Map();
let packageManifests = [];
try {
  packageManifests = execFileSync("git", ["ls-files", "*package.json"], { encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  packageManifests = [];
}
for (const path of packageManifests) {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (typeof manifest.name === "string") manifestByName.set(manifest.name, { path, manifest });
  } catch { /* malformed manifests are diagnosed when their config is examined */ }
}
const entryPackageCache = new Map();

/** Package imports reachable from a declared repo entrypoint, plus first-party package dependencies. */
const entryPackages = (entry) => {
  if (entryPackageCache.has(entry)) return entryPackageCache.get(entry);
  const packages = new Set();
  const seenFiles = new Set();
  const seenPackages = new Set();
  const visitPackage = (name) => {
    if (seenPackages.has(name)) return;
    seenPackages.add(name);
    const found = manifestByName.get(name);
    if (!found) return;
    packages.add(name);
    for (const dependency of Object.keys({ ...found.manifest.dependencies, ...found.manifest.optionalDependencies })) {
      if (dependency === "cotal-ai" || dependency.startsWith("@cotal-ai/")) visitPackage(dependency);
    }
  };
  const visitFile = (path) => {
    const actual = candidateFiles(path);
    if (!actual || seenFiles.has(actual)) return;
    seenFiles.add(actual);
    const source = readFileSync(actual, "utf8");
    for (const specifier of relativeImports(actual, source)) {
      if (specifier.startsWith(".")) visitFile(resolve(dirname(actual), specifier));
      else if (specifier === "cotal-ai" || specifier.startsWith("@cotal-ai/")) visitPackage(specifier.split("/").slice(0, 2).join("/"));
    }
  };
  visitFile(resolve(entry));
  entryPackageCache.set(entry, packages);
  return packages;
};

const normalizedPath = (value) => resolve(value).replaceAll("\\", "/");
/**
 * Does this suite LAUNCH the declared entrypoint, in the slot the child actually executes?
 *
 * This asked a weaker question: whether the declared path appeared ANYWHERE in a launcher's argv,
 * with the argv identifier resolved through a flat name->value map. Three facts were asserted that
 * the program does not have. A name is not a binding, so a same-named `args` in an unrelated
 * function stood in for the launcher's own and witnessed a launch that never happens. An element is
 * not the script slot, so a path sitting after `-e` counted as executed when node runs the eval
 * program and never opens the file. A spelling is not an import, so any callee named `spawnProc`
 * counted, including one imported from a local helper. A conditional argv resolved to `undefined`
 * and crashed the walk, which surfaced as a config refused for a TypeError rather than a reason.
 *
 * `launchedPaths` already answers the real question, and answers it with evidence: bindings are
 * resolved by walking outward to the nearest enclosing scope that declares the name, the executed
 * slot is located by node's own flag rules, launcher aliases come from the child_process import,
 * and dead code is excluded. An entrypoint is witnessed here when it is one of those paths.
 */
const spawnsEntrypoint = (suite, entry, source) => {
  const target = normalizedPath(entry);
  return launchedPaths(suite, source).some((path) => normalizedPath(path) === target);
};

const packageName = (file) => {
  const manifest = resolve(packageRoot(file), "package.json");
  if (!existsSync(manifest)) return undefined;
  return JSON.parse(readFileSync(manifest, "utf8")).name;
};

/**
 * The command with `pnpm <script>` replaced by what that script actually runs.
 *
 * Configs name the workflow (`pnpm smoke:hermes-boot-requirement`), and the build lives inside the
 * script body. Reading the manifest is a fact about this checkout, not a guess about the string:
 * without it a real `pnpm --filter ... build &&` is invisible purely because it was named indirectly.
 */
const SCRIPT_EXPANSION_DEPTH = 4;
let rootScripts;
const expandScripts = (command, depth = SCRIPT_EXPANSION_DEPTH) => {
  if (rootScripts === undefined) {
    try { rootScripts = JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts ?? {}; }
    catch { rootScripts = {}; }
  }
  if (depth <= 0) return command;
  let changed = false;
  const expanded = command.split(/(?=&&|;)/).map((segment) => {
    const tokens = segment.replace(/^(?:&&|;)\s*/, "").trim().split(/\s+/);
    const lead = segment.startsWith("&&") ? "&& " : segment.startsWith(";") ? "; " : "";
    if (tokens[0] !== "pnpm" || tokens.length !== 2) return segment;
    const body = rootScripts[tokens[1]];
    if (typeof body !== "string") return segment;
    changed = true;
    return `${lead}${body}`;
  }).join(" ");
  return changed ? expandScripts(expanded, depth - 1) : command;
};

const buildsPackage = (command, name) => {
  if (!name) return false;
  // `build`, and its variants `build:emit`, `build:types`. A package splits its build into named
  // steps, and `pnpm --filter <pkg> build:emit` really does emit that package's dist. A variant
  // counts only when the PACKAGE ITSELF DECLARES that script and the script runs a compiler, so
  // the fact comes from the manifest rather than from the `build:` spelling: a `build:docs` that
  // shells out to a doc generator produces no dist and is not a build for this purpose.
  const emitsDist = (script) => {
    const found = manifestByName.get(name);
    const body = found?.manifest?.scripts?.[script];
    if (typeof body !== "string") return false;
    return /(^|\s|&&|;)(tsc|tsup|rollup|esbuild|vite|swc|babel)(\s|$)/.test(body);
  };
  const isBuildScript = (token) => token === "build" || (token.startsWith("build:") && emitsDist(token));
  for (const segment of expandScripts(command).split(/&&|;/)) {
    const tokens = segment.trim().split(/\s+/);
    if (tokens.includes("||")) continue;
    if (tokens[0] !== "pnpm") continue;
    if (tokens[1] !== undefined && isBuildScript(tokens[1])) return true;
    const filter = tokens.findIndex((token) => token === "--filter" || token.startsWith("--filter="));
    if (filter < 0) continue;
    const value = tokens[filter].startsWith("--filter=") ? tokens[filter].slice(9) : tokens[filter + 1];
    if (value?.replace(/\.\.\.$/, "") !== name) continue;
    if (tokens.slice(filter + (tokens[filter].startsWith("--filter=") ? 1 : 2)).some(isBuildScript)) return true;
  }
  return false;
};

/**
 * Repo directories this suite packs into a tarball whose BUILT contents it then inspects.
 *
 * `npm pack <dir>` publishes that package's compiled output, and a suite that reads
 * `package/dist/<file>` out of the tarball is observing the artifact the build produced from that
 * package's source. Paired with a build of the same package (as every dist witness here is), a
 * mutation in the source it compiles from really does change what the suite reads. The directory
 * comes from the pack call's own argument, not from text near it.
 */
/**
 * Values a parameter can actually hold, read from the call sites of its enclosing function.
 *
 * This substitutes arguments for parameters, which is what the program does at run time. It is
 * bounded to the function's own declared parameter position, so an unrelated call cannot supply it.
 */
const paramBindings = (sf, expr, evalPath) => {
  const names = [];
  const collect = (n) => {
    if (ts.isIdentifier(n)) names.push(n.text);
    ts.forEachChild(n, collect);
  };
  collect(expr);
  if (names.length === 0) return [];
  let fn;
  for (let cur = expr.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) { fn = cur; break; }
  }
  if (fn === undefined) return [];
  const fnName = ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text
    : (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined);
  if (fnName === undefined) return [];
  const slots = new Map();
  fn.parameters.forEach((param, index) => {
    if (ts.isIdentifier(param.name) && names.includes(param.name.text)) slots.set(param.name.text, index);
  });
  if (slots.size === 0) return [];
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fnName) {
      const bound = new Map();
      for (const [name, index] of slots) {
        const arg = node.arguments[index];
        const value = arg ? evalPath(arg) : undefined;
        if (value === undefined) return;
        bound.set(name, value);
      }
      const substituted = substitutePath(expr, bound, evalPath);
      if (substituted !== undefined) out.push(substituted);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

/** Evaluate `expr` with the given identifier bindings substituted in. */
const substitutePath = (expr, bound, evalPath) => {
  const local = (node) => {
    if (!node) return undefined;
    if (ts.isIdentifier(node) && bound.has(node.text)) return bound.get(node.text);
    const direct = evalPath(node);
    if (direct !== undefined) return direct;
    if (ts.isCallExpression(node)) {
      const name = calleeText(node.expression);
      if (name === "join" || name === "resolve") {
        const parts = node.arguments.map(local);
        if (parts.every((part) => part !== undefined)) return resolve(...parts);
      }
    }
    return undefined;
  };
  return local(expr);
};

/**
 * npm/pnpm flags whose VALUE is the next argv element, so that element is not the packed directory.
 *
 * `--pack-destination <dir>` names where the tarball is WRITTEN. Reading it as a packed root
 * credits a suite with observing the build output of a tree it only wrote a file into, which is the
 * mention shape this witness exists to refuse. `-C`/`--dir` names the working directory the pack
 * resolves from, which is the packed tree only when no positional follows, so it is not read as one
 * either.
 */
const PACK_VALUE_FLAGS = new Set(["--pack-destination", "-C", "--dir", "--filter", "--workspace", "-w"]);

/**
 * The directories an `npm pack` call actually packs: its positional arguments after `pack`.
 *
 * A flag and the value it consumes are skipped by the tool's own argument grammar, the same way the
 * launched-script slot is located by node's flag rules. Taking every non-literal element instead let
 * `["pack", "--pack-destination", <seat>, <clone>]` report `seat` as packed when the tarball it
 * produces is of `clone`.
 */
const packPositionals = (argv) => {
  const elements = argvElements(argv);
  const out = [];
  let seenPack = false;
  for (let i = 0; i < elements.length; i++) {
    const text = stringValue(elements[i]);
    if (!seenPack) {
      if (text === "pack") seenPack = true;
      continue;
    }
    if (typeof text === "string" && text.startsWith("-")) {
      if (!text.includes("=") && PACK_VALUE_FLAGS.has(flagName(text))) i += 1;
      continue;
    }
    out.push(elements[i]);
  }
  return out;
};

const packedRoots = (suite, source) => {
  const { sf, evalPath } = pathEval(suite, source);
  // The pack has to be performed by a REAL launcher, for the #1612 reason: a local function
  // spelled `execFileSync` packs nothing, so a tarball witness resting on the spelling credits a
  // suite for reading an artifact that was never produced.
  const launchers = namedAliases(source, LAUNCHER_MODULES, LAUNCHERS);
  const roots = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = calleeText(node.expression);
      if ((callee === "execFileSync" || callee === "execFile" || callee === "spawnSync")
        && launchers(node.expression)) {
        const program = evalPath(node.arguments[0]);
        const argv = node.arguments[1];
        if (program !== undefined && /(?:^|\/)npm$/.test(String(program).replaceAll("\\", "/"))
          && argv && ts.isArrayLiteralExpression(argv)
          && argv.elements.some((el) => stringValue(el) === "pack")) {
          for (const el of packPositionals(argv)) {
            const value = evalPath(el);
            if (typeof value === "string") { roots.push(value); continue; }
            // The packed directory is often a parameter of a small helper (`pack(dir)`). Resolve it
            // the way the program does: through the arguments its own call sites actually pass.
            for (const bound of paramBindings(sf, el, evalPath)) roots.push(bound);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return roots;
};

const executedWitness = (suite, source, command, mutation, executes) => {
  const name = packageName(mutation.file);
  for (const entry of executes) {
    if (!spawnsEntrypoint(suite, entry, source)) continue;
    if (resolve(entry) === resolve(mutation.file)) return true;
    if (name && buildsPackage(command, name) && entryPackages(entry).has(name)) return true;
  }
  // The same rule, but sourced from a launch this suite demonstrably performs rather than from a
  // declaration. An entrypoint reaches a workspace package by BARE specifier, which resolves to
  // that package's dist, so the mutated source is loaded only when the command rebuilds it.
  if (!name || !buildsPackage(command, name)) return false;
  return launchedPaths(suite, source).some((entry) => entryPackages(entry).has(name));
};

const assertGradable = (configPath, cfg, suites, mutation) => {
  // A mutation may override the config's command with its own; that override is what actually runs
  // for this mutation, so it is the command every build/env witness below must be read from.
  const command = typeof mutation.command === "string" && mutation.command !== "" ? mutation.command : cfg.command;
  // A suite that launches a repo entrypoint under a TS runner executes that entrypoint's own
  // source tree, so the mutated file is covered when the entrypoint's relative imports reach it.
  // A value-import of a package's dist reaches the mutated source only through a build the command
  // actually runs; both halves are required, because the import alone loads a stale artifact.
  const audit = {};
  for (const suite of suites) {
    const source = readFileSync(suite, "utf8");
    if (resolve(mutation.file) === resolve(suite)) return;
    if (launchedPaths(suite, source).some((entry) => sourceReaches(entry, mutation.file))) return;
    if (readsFile(suite, source, mutation.file, commandEnv(command), audit)) return;
    if (packageRoot(mutation.file) === packageRoot(suite) && importsSource(suite, source, mutation.file)) return;
    const assembled = (cfg.assembles ?? []).find((root) => mutation.file === root || mutation.file.startsWith(root + "/"));
    if (assembled !== undefined && copiesRoot(suite, source, assembled)) return;
    // A dist import reaches the mutated file only when the source behind that artifact really
    // loads it, and only when the command builds the package so the artifact is not stale.
    if (buildsPackage(command, packageName(mutation.file))
      && importsBuiltOutput(suite, source).some((entry) => sourceReaches(entry, mutation.file))) return;
    // Same pairing, sourced from a tarball the suite packs out of the package and then reads.
    if (buildsPackage(command, packageName(mutation.file))
      && packedRoots(suite, source).some((root) => coversPath(resolve(mutation.file), resolve(root)))) return;
    if (executedWitness(suite, source, command, mutation, cfg.executes ?? [])) return;
  }
  if (audit.narrowed) {
    throw new Error(
      `mutation "${mutation.name}" targets ${mutation.file}, which is reached only by a recursive sweep narrowed to a single literal path`,
    );
  }
  if (audit.outside) {
    throw new Error(
      `mutation "${mutation.name}" targets ${mutation.file}, which is outside the swept tree`,
    );
  }
  throw new Error(
    `mutation "${mutation.name}" targets ${mutation.file}, which none of [${suites.join(", ")}] imports by source path, ` +
    `reaches through a declared assembled tree, nor reaches through a declared subprocess entrypoint. A by-name ` +
    `import resolves that package to dist. Use a suite in ${packageRoot(mutation.file)} that reaches into ../src, ` +
    `declare the copied source tree in "assembles", declare the spawned repo entrypoint in "executes" with the ` +
    `target package built by the command, or record the mutation as unkillable with its reason.`,
  );
};

/**
 * Refuse a mutation whose named `cell` cannot be the assertion proving the guard it edits.
 *
 * `expectRed` is checked to redden; nothing checked that the reddening assertion is the one that
 * PROVES the mutated guard, so an entry could edit an end-to-end guard, name a parser-only cell,
 * and grade KILLED off the collateral red. `mutation-proof` cannot see this: WRONG-RED fires when
 * the named assertion does NOT redden, never when it reddens for an unrelated reason.
 *
 * The decidable half is the necessary condition. A cell whose verdict rests on nothing outside the
 * suite's own text cannot be proving anything about a file in another module, because no edit to
 * that file can change what it prints. That is what is refused, and the message says exactly that
 * rather than claiming the aim is wrong.
 *
 * NOT "the named cell must be the ONLY one that reds". Collateral reddening is normal and correct,
 * and a gate demanding exclusivity would pressure an author to weaken the neighbouring cells until
 * they stop noticing. Measured on #1521: the two MIS-targeted mutants each reddened exactly one
 * cell, while the correctly targeted one reddened five.
 */
const assertCellObserves = (suites, mutation) => {
  if (typeof mutation.cell !== "string" || mutation.cell === "") return;
  const sources = suites.map((path) => ({ path, sf: ast(path, readFileSync(path, "utf8")), cell: mutation.cell }));
  const graded = gradeCellTarget(mutation.file, sources);
  if (graded.verdict !== "self-fed") return;
  throw new Error(
    `mutation "${mutation.name}" edits ${mutation.file}, but its named cell ${JSON.stringify(mutation.cell)} `
    + "reaches no launch, file read, or module import: every value its verdict rests on is written in the suite "
    + "source itself, so no edit to that file can change what this cell prints and it cannot be the assertion "
    + "that proves the mutated guard. Name the cell that exercises the guard end to end, or move the mutation to "
    + "the code this cell does read.",
  );
};

const lastMatch = (output, re) => [...output.matchAll(re)].at(-1);

const parseSummary = (cfg, output) => {
  const tallied = lastMatch(output, /(\d+) passed, (\d+) failed/g);
  if (tallied) return { executed: Number(tallied[1]), failures: Number(tallied[2]) };
  const checks = lastMatch(output, /(?:(\d+)\s*\/\s*)?(\d+) checks passed/g);
  if (checks) {
    const executed = Number(checks[2]);
    if (checks[1] !== undefined && Number(checks[1]) !== executed) return undefined;
    return { executed, failures: 0 };
  }
  // completionMarker locates the line that may carry a complete N/N
  // fraction. Presence of the marker string is never itself a total.
  if (typeof cfg.completionMarker === "string") {
    const line = output.split(/\r?\n/).filter((candidate) => candidate.includes(cfg.completionMarker)).at(-1);
    const completeFraction = line?.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (completeFraction && Number(completeFraction[1]) === Number(completeFraction[2])) {
      return { executed: Number(completeFraction[2]), failures: 0 };
    }
  }
  return undefined;
};

const validate = (path, cfg) => {
  const gradesTool = cfg.grades === "tool";
  const suites = parseSuiteSources(process.cwd(), path, cfg.suite);
  if (typeof cfg.command !== "string" || cfg.command === "") throw new Error('is missing "command"');
  if (!Array.isArray(cfg.mutations)) throw new Error('is missing a "mutations" array');
  if (cfg.completionMarker !== undefined && (typeof cfg.completionMarker !== "string" || cfg.completionMarker === "")) {
    throw new Error('"completionMarker" must be a non-empty string');
  }
  if (cfg.progressPattern !== undefined) {
    if (typeof cfg.progressPattern !== "string" || cfg.progressPattern === "") throw new Error('"progressPattern" must be a non-empty regular expression string');
    try { new RegExp(cfg.progressPattern, "gm"); } catch (error) { throw new Error(`"progressPattern" is invalid: ${error.message}`); }
  }
  if (cfg.minTicks !== undefined && (!Number.isInteger(cfg.minTicks) || cfg.minTicks < 1)) {
    throw new Error('"minTicks" must be a positive integer');
  }
  for (const key of ["assembles", "executes"]) {
    if (cfg[key] !== undefined && !validStringArray(cfg[key])) throw new Error(`"${key}" must be an array of non-empty repo paths`);
  }
  const required = gradesTool ? REQUIRED.filter((key) => key !== "cell") : REQUIRED;
  for (const mutation of cfg.mutations) {
    for (const key of required) {
      if (typeof mutation[key] !== "string" || mutation[key] === "") throw new Error(`mutation "${mutation.name ?? "(unnamed)"}" is missing "${key}"`);
    }
    for (const key of REQUIRED_MAY_BE_EMPTY) {
      if (typeof mutation[key] !== "string") throw new Error(`mutation "${mutation.name ?? "(unnamed)"}" is missing "${key}"`);
    }
    if (!gradesTool) {
      assertGradable(path, cfg, suites, mutation);
      assertCellObserves(suites, mutation);
    }
  }
  return { gradesTool, suites };
};

for (const path of configs) {
  examined++;
  let cfg;
  let gradesTool;
  let suites;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
    ({ gradesTool, suites } = validate(path, cfg));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    refusals.push([path, reason]);
    console.error(`REFUSED ${path}: ${reason}`);
    continue;
  }

  if (gradableOnly) {
    console.log(`ACCEPTED ${path}`);
    graded++;
    continue;
  }
  if (discovered && !executeDiscovered) {
    fencedDiscovered++;
    console.error(`FENCED ${path}: discovered configs are not executed; pass --execute-discovered to run them`);
    continue;
  }
  const liveReason = liveShapedCommandReason(cfg.command, { cwd: process.cwd() });
  if (liveReason) {
    refused.push([path, cfg.command, liveReason]);
    continue;
  }

  let output;
  try {
    output = execSync(cfg.command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    failed++;
    console.error(`FAILED ${path}: command exited ${error.status ?? "without a status"}: ${cfg.command}`);
    const transcript = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    if (transcript) console.error(transcript);
    continue;
  }

  const summary = parseSummary(cfg, output);
  if (!summary) {
    unparsed++;
    const hasPattern = typeof cfg.progressPattern === "string";
    const hasTicks = Number.isInteger(cfg.minTicks) && cfg.minTicks > 0;
    let why = "command completed but printed no trustworthy executed-cell total";
    if (hasPattern && !hasTicks) {
      why += "; progressPattern is present and minTicks is absent, so the progress path could not produce a total";
    } else if (hasTicks && !hasPattern) {
      why += "; minTicks is present and progressPattern is absent, so the progress path cannot run at all because minTicks is only ever consumed by that path";
    } else if (hasPattern && hasTicks) {
      why += "; progress ticks are not an executed-cell total; the instrument grades only a number the suite printed";
    }
    console.error(`UNPARSED ${path}: ${why}`);
    continue;
  }
  if (summary.failures !== 0) {
    failed++;
    console.error(`FAILED ${path}: suite is already red (${summary.failures} failed); coverage over red is not graded`);
    continue;
  }

  const executed = summary.executed;
  const suiteLabel = suites.join(", ");
  if (gradesTool) {
    tools.push([path, cfg.mutations.length, executed]);
    graded++;
    continue;
  }
  if (cfg.kind === "unasserted-probe") {
    probes.push([suiteLabel, cfg.mutations.length, executed]);
    graded++;
    continue;
  }
  const distinct = new Set(cfg.mutations.map((mutation) => mutation.cell));
  if (distinct.size > executed) {
    failed++;
    console.error(`FAILED ${path}: names ${distinct.size} distinct cells but the suite ran ${executed}`);
    continue;
  }
  if (distinct.size !== cfg.mutations.length) console.log(`  note: ${path} has ${cfg.mutations.length} mutations naming ${distinct.size} distinct cells`);
  cells += executed;
  named += distinct.size;
  mutations += cfg.mutations.length;
  unkillable += (cfg.unkillable ?? []).length;
  rows.push([suiteLabel, executed, distinct.size]);
  graded++;
}

const width = Math.max(5, ...rows.map((row) => row[0].length));
for (const [suite, executed, distinct] of rows) {
  console.log(`${suite.padEnd(width)}  ${String(distinct).padStart(3)} / ${String(executed).padStart(3)} cells observed failing`);
}
if (rows.length) console.log(`${"TOTAL".padEnd(width)}  ${named} / ${cells} = ${Math.round((named / cells) * 100)}%`);
console.log(`${mutations} mutations run, ${unkillable} recorded unkillable by construction and not run.`);
if (rows.length) {
  console.log("A lower bound: a mutation may redden more cells than the one it names, and those are not claimed here.");
  console.log("The ratio measures guards authors aimed at, not every guard that exists.");
}
if (probes.length) {
  console.log("\nUnasserted-guard probes:");
  for (const [suite, count, executed] of probes) console.log(`  ${suite}  ${count} probes against a suite of ${executed} cells`);
}
if (tools.length) {
  console.log("\nInstrument configs:");
  for (const [path, count, executed] of tools) console.log(`  ${path}  ${count} mutations against a self-test of ${executed} cells`);
}
if (refusals.length) {
  console.error("\nRefused configs:");
  for (const [path, reason] of refusals) console.error(`  ${path}: ${reason}`);
}
if (refused.length) {
  console.log("\nLive-shaped configs — refused before execution, counted and named so the denominator stays honest.");
  for (const [path, command, reason] of refused) {
    console.log(`  ${path}  REFUSED \`${command}\` (${reason})`);
  }
  console.log(`${refused.length} live-shaped config(s) refused.`);
}
console.log(
  `MUTATION COVERAGE SUMMARY head=${checkoutHead} enumerated=${configs.length} examined=${examined} graded=${graded} ` +
  `refused-with-reason=${refusals.length} unparsed=${unparsed} command-failed=${failed} ` +
  `fenced-live=${refused.length} fenced-discovered=${fencedDiscovered}`,
);
if (refusals.length || unparsed || failed || examined !== configs.length || graded + refused.length + fencedDiscovered !== configs.length) process.exitCode = 1;

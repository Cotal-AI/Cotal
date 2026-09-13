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
const COPIERS = ["cpSync", "copyFileSync"];
const JOINERS = ["join", "resolve", "dirname", "fileURLToPath"];
/** A loader CLI that occupies the first positional and executes the NEXT one (tsx's own cli.mjs). */
const RUNNER_CLI = /(?:^|\/)(?:tsx|ts-node|tsimp)(?:\/dist)?\/(?:cli|esm)\.(?:m?js|cjs)$/i;

const calleeText = (expr) => {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) return expr.name.text;
  return "";
};

const namedAliases = (source, fromSpec, originals) => {
  const names = new Set(originals);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      if (from !== fromSpec && from !== `node:${fromSpec}`) return;
      const named = node.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) return;
      for (const el of named.elements) {
        const orig = (el.propertyName ?? el.name).text;
        if (originals.includes(orig)) names.add(el.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast("alias.ts", source));
  return names;
};

const pathEval = (suite, source, env = new Map()) => {
  const sf = ast(suite, source);
  const joiners = namedAliases(source, "path", JOINERS);
  const variables = new Map();
  // The repository root, and ONLY where the program actually computes it. An identifier's spelling
  // is not evidence of its value: `const root = mkdtempSync(...)` is a temp directory, and reading
  // it as the repo root invents a data-flow fact that does not exist. A name-shaped root was the
  // exact class #1434 is about, so nothing here looks at identifier text. A binding reaches this
  // value only by evaluating to it, through the `variables` map.
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
    if (ts.isIdentifier(node)) return variables.get(node.text);
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
      if ((name === "join" || name === "resolve") && joiners.has(name) && parts.every((part) => part !== undefined)) {
        return resolve(...parts);
      }
      if (name === "fileURLToPath" && parts.length === 1 && parts[0] !== undefined) return parts[0];
    }
    return undefined;
  };
  const walk = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = evalPath(node.initializer);
      if (value !== undefined) variables.set(node.name.text, value);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return { sf, evalPath };
};

const coversPath = (got, want) => {
  if (got === undefined || got === null) return false;
  const g = resolve(got).replaceAll("\\", "/");
  const w = resolve(want).replaceAll("\\", "/");
  return g === w || g.startsWith(w + "/");
};

const exprCovers = (evalPath, node, want) => {
  if (coversPath(evalPath(node), want)) return true;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((el) => !ts.isOmittedExpression(el) && !ts.isSpreadElement(el) && exprCovers(evalPath, el, want));
  }
  let hit = false;
  ts.forEachChild(node, (child) => { if (exprCovers(evalPath, child, want)) hit = true; });
  return hit;
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
 * Are the entries this listing produces actually READ?
 *
 * A directory listing by itself observes names, not bytes: mutating a file's contents cannot change
 * it. The listing therefore witnesses a read only when its entries flow into a reader, which is the
 * `for (const f of readdirSync(...)) readFileSync(<f>)` shape. The binding is followed by identity,
 * so a loop that reads some other path does not count.
 */
const listingIsRead = (call, readers) => {
  for (let cur = call.parent; cur !== undefined; cur = cur.parent) {
    if (!ts.isForOfStatement(cur)) continue;
    const decl = cur.initializer;
    const name = ts.isVariableDeclarationList(decl) && decl.declarations[0]
      && ts.isIdentifier(decl.declarations[0].name) ? decl.declarations[0].name.text : undefined;
    if (name === undefined) return false;
    let read = false;
    const scan = (n) => {
      if (read) return;
      if (ts.isCallExpression(n) && readers.has(calleeText(n.expression))) {
        const arg = n.arguments[0];
        const mentions = (e) => {
          if (!e) return false;
          if (ts.isIdentifier(e)) return e.text === name;
          let found = false;
          ts.forEachChild(e, (c) => { if (mentions(c)) found = true; });
          return found;
        };
        if (mentions(arg)) read = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(cur.statement);
    return read;
  }
  return false;
};

const READERS = ["readFileSync", "readFile", "openSync", "createReadStream"];
/**
 * A recursive directory read is a read of every file under that directory.
 *
 * `readdirSync(dir, { recursive: true })` followed by a read of each entry is how a suite grades a
 * whole tree, and mutating any file in the tree changes its result. The witness is the RECURSIVE
 * flag in the call the suite makes, not a path spelling: a non-recursive listing covers only its
 * own directory, and is treated that way.
 */
const READDIRS = ["readdirSync", "readdir", "globSync", "glob"];
const readsFile = (suite, source, file, env = new Map()) => {
  const { sf, evalPath } = pathEval(suite, source, env);
  const readers = namedAliases(source, "fs", READERS);
  let hit = false;
  const listers = namedAliases(source, "fs", READDIRS);
  const want = resolve(file);
  const visit = (node) => {
    if (ts.isCallExpression(node) && readers.has(calleeText(node.expression))) {
      const target = node.arguments[0];
      if (target && !ts.isSpreadElement(target) && coversPath(evalPath(target), file)) hit = true;
    }
    if (ts.isCallExpression(node) && listers.has(calleeText(node.expression))) {
      const dir = evalPath(node.arguments[0]);
      const options = node.arguments[1];
      const recursive = options !== undefined && ts.isObjectLiteralExpression(options)
        && options.properties.some((prop) => ts.isPropertyAssignment(prop)
          && prop.name.getText() === "recursive"
          && prop.initializer.kind === ts.SyntaxKind.TrueKeyword);
      if (typeof dir === "string") {
        const base = resolve(dir);
        const under = want === base || want.startsWith(base.endsWith("/") ? base : base + "/");
        if (under && (recursive || dirname(want) === base) && listingIsRead(node, readers)) hit = true;
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
  const launchers = namedAliases(source, "child_process", LAUNCHERS);
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
    if (ts.isCallExpression(node) && launchers.has(calleeText(node.expression))) {
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

const invokesFile = (suite, source, file) =>
  launchedPaths(suite, source).some((path) => coversPath(path, file));

const stringsCover = (suite, source, want) => {
  const { sf, evalPath } = pathEval(suite, source);
  let hit = false;
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) && coversPath(evalPath(node) ?? node.text, want)) hit = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
};


/**
 * Does this suite COPY the declared root? Only the source argument counts.
 *
 * `cpSync(src, dest, options)` copies `src`. Scanning every argument let an options object carry
 * the root, such as `{ note: join(ROOT, "packages", "seat") }` or a `filter` mentioning it, and that is a
 * mention again, one argument to the right of the one that does the work.
 */
const copiesRoot = (suite, source, root) => {
  const { sf, evalPath } = pathEval(suite, source);
  const copiers = namedAliases(source, "fs", COPIERS);
  let hit = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && copiers.has(calleeText(node.expression))) {
      const from = node.arguments[0];
      if (from && !ts.isSpreadElement(from) && !ts.isObjectLiteralExpression(from)
        && exprCovers(evalPath, from, root)) hit = true;
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
/**
 * Does control reach this node when the module is loaded?
 *
 * Top-level code runs on load. Code inside a function runs only if something calls that function,
 * so a deferred site is admitted only when its enclosing function is actually reachable: a callback
 * passed straight to a call, or a binding whose name is used somewhere other than its declaration.
 */
const evaluated = (node, sf) => {
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
    let used = false;
    const scan = (n) => {
      if (used) return;
      if (ts.isIdentifier(n) && n.text === name && n !== cur.name && !(n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n)) used = true;
      ts.forEachChild(n, scan);
    };
    scan(sf);
    if (!used) return false;
    // The enclosing function is reached; keep walking outward for further nesting.
    node = cur;
  }
  return true;
};

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

const importsBuiltOutput = (path, source) => {
  const roots = [];
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
    ts.forEachChild(node, visit);
  };
  visit(ast(path, source));
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
const spawnsEntrypoint = (suite, entry, source) => {
  const variables = new Map();
  const target = normalizedPath(entry);
  const evalPath = (node) => {
    if (!node) return undefined;
    const literal = stringValue(node);
    if (literal !== undefined) return literal;
    if (ts.isIdentifier(node)) return variables.get(node.text);
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "import.meta") {
      if (node.name.text === "dirname") return dirname(resolve(suite));
      if (node.name.text === "url") return resolve(suite);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const parts = node.arguments.map(evalPath);
      if (parts.some((part) => part === undefined)) return undefined;
      if (node.expression.text === "dirname" && parts.length === 1) return dirname(parts[0]);
      if (node.expression.text === "join" || node.expression.text === "resolve") return resolve(...parts);
      if (node.expression.text === "fileURLToPath" && parts.length === 1) return parts[0];
    }
    return undefined;
  };
  const entryArray = (node) => {
    if (ts.isIdentifier(node)) node = variables.get(node.text);
    if (!ts.isArrayLiteralExpression(node)) return false;
    return node.elements.some((element) => {
      const value = evalPath(element);
      return value !== undefined && normalizedPath(value) === target;
    });
  };
  const executableIsNode = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "process" && node.name.text === "execPath") return true;
    const value = evalPath(node);
    return value !== undefined && /(?:^|\/)tsx(?:\.cmd)?$/.test(value.replaceAll("\\", "/"));
  };
  let witnessed = false;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variables.set(node.name.text, ts.isArrayLiteralExpression(node.initializer) ? node.initializer : evalPath(node.initializer));
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? `${node.expression.expression.getText()}.${node.expression.name.text}` : "";
      if (["spawn", "spawnSync", "spawnProc", "pty.spawn"].includes(callee)
        && executableIsNode(node.arguments[0]) && node.arguments[1] && entryArray(node.arguments[1])) witnessed = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast(suite, source));
  return witnessed;
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
  for (const segment of expandScripts(command).split(/&&|;/)) {
    const tokens = segment.trim().split(/\s+/);
    if (tokens.includes("||")) continue;
    if (tokens[0] !== "pnpm") continue;
    if (tokens[1] === "build") return true;
    const filter = tokens.findIndex((token) => token === "--filter" || token.startsWith("--filter="));
    if (filter < 0) continue;
    const value = tokens[filter].startsWith("--filter=") ? tokens[filter].slice(9) : tokens[filter + 1];
    if (value?.replace(/\.\.\.$/, "") !== name) continue;
    if (tokens.slice(filter + (tokens[filter].startsWith("--filter=") ? 1 : 2)).includes("build")) return true;
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

const packedRoots = (suite, source) => {
  const { sf, evalPath } = pathEval(suite, source);
  const roots = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = calleeText(node.expression);
      if (callee === "execFileSync" || callee === "execFile" || callee === "spawnSync") {
        const program = evalPath(node.arguments[0]);
        const argv = node.arguments[1];
        if (program !== undefined && /(?:^|\/)npm$/.test(String(program).replaceAll("\\", "/"))
          && argv && ts.isArrayLiteralExpression(argv)
          && argv.elements.some((el) => stringValue(el) === "pack")) {
          for (const el of argv.elements) {
            if (stringValue(el) !== undefined) continue;
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
  for (const suite of suites) {
    const source = readFileSync(suite, "utf8");
    if (resolve(mutation.file) === resolve(suite) || invokesFile(suite, source, mutation.file)) return;
    if (launchedPaths(suite, source).some((entry) => sourceReaches(entry, mutation.file))) return;
    if (readsFile(suite, source, mutation.file, commandEnv(command))) return;
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
  throw new Error(
    `mutation "${mutation.name}" targets ${mutation.file}, which none of [${suites.join(", ")}] imports by source path, ` +
    `reaches through a declared assembled tree, nor reaches through a declared subprocess entrypoint. A by-name ` +
    `import resolves that package to dist. Use a suite in ${packageRoot(mutation.file)} that reaches into ../src, ` +
    `declare the copied source tree in "assembles", declare the spawned repo entrypoint in "executes" with the ` +
    `target package built by the command, or record the mutation as unkillable with its reason.`,
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
    if (!gradesTool) assertGradable(path, cfg, suites, mutation);
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

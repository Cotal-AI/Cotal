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
 *   node scripts/mutation-coverage.mjs --gradable-only [config…]    # validate reachability, do not execute
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
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
const RELATIVE_SRC = /(?:^|\/)(?:\.\.\/)+src\//;

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

const pathEval = (suite, source) => {
  const sf = ast(suite, source);
  const joiners = namedAliases(source, "path", JOINERS);
  const variables = new Map();
  const rootish = (node) => {
    if (ts.isIdentifier(node)) {
      const n = node.text;
      return n === "ROOT" || n === "root" || n === "repo" || n === "repoRoot" || n === "pkgRoot"
        || n === "here" || n === "base" || n.endsWith("Root") || n.endsWith("Clone");
    }
    if (ts.isCallExpression(node) && node.arguments.length === 0 && node.expression.getText() === "process.cwd") return true;
    if (ts.isPropertyAccessExpression(node)) {
      const t = node.getText();
      return t === "import.meta.dirname" || t === "import.meta.url" || t === "process.cwd";
    }
    return false;
  };
  const evalPath = (node) => {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node)) return evalPath(node.expression);
    const literal = stringValue(node);
    if (literal !== undefined) return literal;
    if (ts.isIdentifier(node)) {
      if (variables.has(node.text)) return variables.get(node.text);
      if (rootish(node)) return process.cwd();
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "import.meta") {
      if (node.name.text === "dirname") return dirname(resolve(suite));
      if (node.name.text === "url") return resolve(suite);
    }
    if (rootish(node)) return process.cwd();
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
    return tokens[i];
  }
  return undefined;
};

const invokesFile = (suite, source, file) => {
  const { sf, evalPath } = pathEval(suite, source);
  const launchers = namedAliases(source, "child_process", LAUNCHERS);
  let hit = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && launchers.has(calleeText(node.expression))) {
      const args = node.arguments.filter((arg) => !ts.isSpreadElement(arg));
      const command = args[0];
      const argv = args[1] && !ts.isObjectLiteralExpression(args[1]) ? args[1] : undefined;
      if (command && coversPath(evalPath(command), file)) hit = true;
      else if (command && isNodeExecutable(evalPath, command) && argv) {
        const script = launchedScriptArg(evalPath, argv);
        if (script && coversPath(evalPath(script), file)) hit = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
};

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


const copiesRoot = (suite, source, root) => {
  const { sf, evalPath } = pathEval(suite, source);
  const copiers = namedAliases(source, "fs", COPIERS);
  let hit = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && copiers.has(calleeText(node.expression))) {
      for (const arg of node.arguments) {
        if (!ts.isSpreadElement(arg) && exprCovers(evalPath, arg, root)) hit = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
};

const importsSource = (path, source) => {
  let hit = false;
  const specOk = (value) => {
    if (typeof value !== "string") return false;
    const v = value.replaceAll("\\", "/");
    return RELATIVE_SRC.test(v) || v.startsWith("./src/");
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true && node.moduleSpecifier) {
      if (specOk(stringValue(node.moduleSpecifier))) hit = true;
    }
    if (ts.isExportDeclaration(node) && node.isTypeOnly !== true && node.moduleSpecifier) {
      if (specOk(stringValue(node.moduleSpecifier))) hit = true;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (specOk(stringValue(node.arguments[0]))) hit = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast(path, source));
  return hit;
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
const relativeImports = (path, source) => {
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
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

const buildsPackage = (command, name) => {
  if (!name) return false;
  for (const segment of command.split(/&&|;/)) {
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

const executedWitness = (suite, source, command, mutation, executes) => {
  for (const entry of executes) {
    if (!spawnsEntrypoint(suite, entry, source)) continue;
    if (resolve(entry) === resolve(mutation.file)) return true;
    const name = packageName(mutation.file);
    if (name && buildsPackage(command, name) && entryPackages(entry).has(name)) return true;
  }
  return false;
};

const assertGradable = (configPath, cfg, suites, mutation) => {
  for (const suite of suites) {
    const source = readFileSync(suite, "utf8");
    if (resolve(mutation.file) === resolve(suite) || invokesFile(suite, source, mutation.file)) return;
    if (packageRoot(mutation.file) === packageRoot(suite) && importsSource(suite, source)) return;
    const assembled = (cfg.assembles ?? []).find((root) => mutation.file === root || mutation.file.startsWith(root + "/"));
    if (assembled !== undefined && copiesRoot(suite, source, assembled)) return;
    if (executedWitness(suite, source, cfg.command, mutation, cfg.executes ?? [])) return;
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

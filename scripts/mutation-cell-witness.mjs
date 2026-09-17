/**
 * Does a mutation's named `cell` OBSERVE anything at all?
 *
 * `expectRed` is machine-checked to redden (`mutation-proof.mjs` grades WRONG-RED when the named
 * assertion never printed its failure, and again when it printed its green text unchanged). What no
 * check asked was whether the assertion that reddened is the one PROVING the guard being mutated.
 * A mutation can edit an end-to-end guard while naming a parser-only cell, the suite goes red
 * somewhere real, the named cell reddens with it, and the entry grades KILLED having proved nothing
 * about the code it edits. PR #1521 shipped two such entries.
 *
 * WHAT IS DECIDABLE HERE, AND WHAT IS NOT. "This assertion proves that guard" is a semantic claim,
 * and no static reader can settle it. What IS decidable, from the suite's own text, is the
 * NECESSARY CONDITION: a cell whose verdict rests on nothing outside the suite source cannot be
 * proving anything about a file in another module, because no edit to that file can change what it
 * prints. That is the whole claim this module makes, and the refusal is worded as that claim.
 *
 * So the question asked of each cell is: what does its verdict OBSERVE? The answer is a list of
 * witnesses -- subprocess launches, file reads, and module imports reachable from the expression the
 * cell is reported with. An EMPTY list is the refusable state.
 *
 * WHY THE RELATION AND NOT THE CELL ALONE. The issue names the trap explicitly: "the named cell is
 * the ONLY cell that reddened" is NOT a valid form of this check, because collateral reddening is
 * normal and a gate demanding exclusivity would pressure an author to weaken the other cells until
 * they stop noticing. This reasons about the cell against the mutated FILE: a cell in the same file
 * the mutation edits is exempt (a suite mutating its own source observes it by running), and
 * otherwise the cell must observe something. Containment, not exclusivity.
 *
 * EVERY UNKNOWN RESOLVES TO "OBSERVES SOMETHING". An unresolved name, an unreadable reporter, a
 * parameter this analysis did not bind, a `let` filled from who knows where: each becomes a witness
 * rather than an absence. A refusal is an accusation against an author, and the only refusals worth
 * making are those the tool can back. The cost is that this under-reports; the benefit is that it
 * never manufactures a finding out of an analysis gap.
 *
 * WHAT THIS CANNOT CATCH, stated plainly because a check claiming more than it proves is this
 * issue's own defect one level up:
 *
 *   - A cell that observes the RIGHT KIND of thing but the WRONG ONE. Two end-to-end cells driving
 *     the same binary through different paths both carry launch witnesses, so naming either one
 *     passes here. That is the larger half of the class and it stays open.
 *   - Whether the witness is reached at RUNTIME. This reads text, so a launch behind a branch that
 *     never runs counts.
 *   - Whether the mutated guard is on the path the witness exercises. `mutation-coverage`'s
 *     gradability check answers a related question for the FIXTURE; nothing answers it per CELL.
 *   - Anything about a fixture with no `cell` at all, or one whose cell this cannot locate in the
 *     declared suite sources. Both are reported as UNLOCATED and neither is refused here.
 */
import ts from "typescript";

/** Calls that run another program. Their result is an observation of whatever they ran. */
const LAUNCHERS = new Set(["spawnSync", "spawn", "execFileSync", "execFile", "execSync", "exec", "fork"]);
/** Calls that read the filesystem. Their result is an observation of whatever is on disk. */
const READERS = new Set(["readFileSync", "readFile", "readdirSync", "readdir", "existsSync", "statSync",
  "lstatSync", "realpathSync", "readlinkSync", "openSync", "createReadStream"]);

const functionLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
  || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
  || ts.isGetAccessor(n) || ts.isSetAccessor(n);
const blockLike = (n) => ts.isBlock(n) || ts.isForStatement(n) || ts.isForOfStatement(n)
  || ts.isForInStatement(n) || ts.isCatchClause(n) || ts.isCaseBlock(n) || ts.isModuleBlock(n);
const scopeLike = (n) => ts.isSourceFile(n) || functionLike(n) || blockLike(n) || ts.isClassDeclaration(n);

const calleeName = (expr) => ts.isIdentifier(expr) ? expr.text
  : (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) ? expr.name.text : "";

/**
 * What does `name` resolve to, read from `use` outward?
 *
 * Scope by scope, nearest first, the way the language does. A flat file-wide name map would let a
 * same-named binding in an unrelated function stand in for the one actually in scope, which asserts
 * a data-flow fact the program does not have.
 */
const bindingFor = (use, name) => {
  const inScope = (scope) => {
    let found;
    const scan = (node) => {
      if (found !== undefined) return;
      // Function and class declarations are checked BEFORE the nested-scope bail, because such a
      // declaration IS a scope: bailing first makes every top-level `function helper()`
      // unresolvable, and an unresolved name is treated as ambient, which is the permissive answer
      // arriving for the wrong reason.
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) { found = { kind: "function", node }; return; }
      if (ts.isClassDeclaration(node) && node.name?.text === name) { found = { kind: "class", node }; return; }
      if (node !== scope && scopeLike(node)) return;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
        // A type-only import is erased before the program runs, so it observes nothing.
        const seen = (typeOnly) => { found = { kind: typeOnly || clause?.isTypeOnly === true ? "type" : "import", spec }; };
        if (clause?.name?.text === name) { seen(false); return; }
        const bindings = clause?.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) { if (bindings.name.text === name) seen(false); }
          else for (const el of bindings.elements) if (el.name.text === name) seen(el.isTypeOnly);
        }
        return;
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) { found = { kind: "param", node }; return; }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) { found = { kind: "variable", node }; return; }
      if (ts.isCatchClause(node) && node.variableDeclaration !== undefined
        && ts.isIdentifier(node.variableDeclaration.name) && node.variableDeclaration.name.text === name) {
        found = { kind: "catch", node };
        return;
      }
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        // Resolve to the declaration this name was destructured OUT of, so the closure reaches that
        // initializer. Leaving it unresolved reads as an ambient global, which is permissive for
        // the wrong reason.
        let owner = node.parent;
        while (owner !== undefined && !ts.isVariableDeclaration(owner) && !ts.isParameter(owner)) owner = owner.parent;
        if (owner !== undefined && ts.isVariableDeclaration(owner)) found = { kind: "variable", node: owner };
        else if (owner !== undefined && ts.isParameter(owner)) found = { kind: "param", node: owner };
        else found = { kind: "unresolved" };
        return;
      }
      ts.forEachChild(node, scan);
    };
    scan(scope);
    return found;
  };
  for (let scope = use; scope !== undefined; scope = scope.parent) {
    if (!scopeLike(scope)) continue;
    const found = inScope(scope);
    if (found !== undefined) return found;
  }
  return undefined;
};

const isConst = (decl) => {
  const list = decl.parent;
  return list !== undefined && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
};

/** The root of a reference chain: `builds`, for `builds`, `builds.pin`, and `builds[k].at(0)`. */
const rootOf = (node) => {
  let cur = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur) || ts.isPropertyAccessChain(cur)
      || ts.isElementAccessExpression(cur) || ts.isNonNullExpression(cur)
      || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) { cur = cur.expression; continue; }
    return cur;
  }
};

/**
 * Every expression written into `name` anywhere in this file, plus the calls through which a write
 * inside a callback could have happened.
 *
 * NAME-BASED, deliberately. Unlike the scope-correct read above, this can only ADD expressions to
 * the closure and never remove one, so an unrelated same-named binding makes the analysis see MORE
 * than the program does and therefore refuse LESS.
 */
const writesInto = (sf, name) => {
  const found = [];
  const roots = (node) => {
    const root = rootOf(node);
    if (ts.isIdentifier(root)) return root.text === name;
    // A destructuring assignment target: `({ brokerPid: orphanPid } = JSON.parse(text))`.
    if (ts.isObjectLiteralExpression(root) || ts.isArrayLiteralExpression(root)) {
      let hit = false;
      const dig = (node2) => {
        if (hit) return;
        if (ts.isIdentifier(node2) && node2.text === name) { hit = true; return; }
        if (ts.isPropertyAssignment(node2)) { dig(node2.initializer); return; }
        if (ts.isShorthandPropertyAssignment(node2)) { dig(node2.name); return; }
        ts.forEachChild(node2, dig);
      };
      dig(root);
      return hit;
    }
    return false;
  };
  /**
   * A write performed inside a CALLBACK is performed by whoever invokes that callback, and the only
   * thing in this file naming them is where the callback ESCAPES. So walk out to the value that
   * leaves: the function itself when it is passed straight to a call, and otherwise the object,
   * class, or proxy holding it. `let changes = 0; observer.watchMembership(() => { changes++; })`
   * writes nothing this file can evaluate, and the registration is what joins the closure.
   */
  const escapes = (site) => {
    let escaping;
    for (let node = site.parent; node !== undefined; node = node.parent) {
      if (functionLike(node)) { escaping = node; continue; }
      if (escaping === undefined) continue;
      if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isClassExpression(node)
        || ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
        || ts.isShorthandPropertyAssignment(node) || ts.isSpreadAssignment(node)
        || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
        escaping = node;
        continue;
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && (node.arguments ?? []).includes(escaping)) return [node];
      // Returned rather than passed: the callback escapes through its enclosing function, so that
      // function's own escape is the one that matters and the walk continues outward.
      if (ts.isReturnStatement(node)) continue;
      if (node.parent !== undefined && ts.isArrowFunction(node.parent) && node.parent.body === node) continue;
      // Bound to a name first: every call handed that name is a place it can be invoked.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const bound = node.name.text;
        const uses = [];
        const scan = (candidate) => {
          if ((ts.isCallExpression(candidate) || ts.isNewExpression(candidate))
            && (candidate.arguments ?? []).some((arg) => ts.isIdentifier(rootOf(arg)) && rootOf(arg).text === bound)) uses.push(candidate);
          if (ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.initializer)
            && candidate.initializer.text === bound) uses.push(candidate.initializer);
          ts.forEachChild(candidate, scan);
        };
        scan(sf);
        return uses;
      }
      return [];
    }
    return [];
  };
  /** A write inside a CATCH ran because the TRY threw, so the try block is what it observed. */
  const guardedBy = (site) => {
    for (let node = site.parent; node !== undefined; node = node.parent) {
      if (ts.isCatchClause(node)) return node.parent.tryBlock;
      if (functionLike(node)) return undefined;
    }
    return undefined;
  };
  const record = (site, value) => {
    if (value !== undefined) found.push(value);
    for (const call of escapes(site)) found.push(call);
    const guard = guardedBy(site);
    if (guard !== undefined) found.push(guard);
  };
  const visit = (node) => {
    // An update (`n++`) or a compound assignment contributes no expression of its own: the value it
    // produces is a count of how many times the write ran, so only its escape carries information.
    if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && roots(node.operand)) record(node, undefined);
    if (ts.isBinaryExpression(node) && ts.isAssignmentExpression(node, false) && roots(node.left)) record(node, node.right);
    if (ts.isBinaryExpression(node) && ts.isAssignmentExpression(node, true)
      && !ts.isAssignmentExpression(node, false) && roots(node.left)) record(node, node.right);
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isPropertyAccessChain(node.expression))
      && roots(node.expression.expression)) {
      for (const arg of node.arguments) found.push(arg);
      record(node, undefined);
    }
    // Handed to a call: `Object.assign(bound, value)`. Passing an object is passing a reference, so
    // the callee may fill it, which makes the call a write site and its other arguments the source.
    if (ts.isCallExpression(node) && node.arguments.some((arg) => roots(arg))) {
      for (const arg of node.arguments) if (!roots(arg)) found.push(arg);
      record(node, undefined);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

/**
 * The observations a named cell's verdict rests on, as a list of `{ kind, node }`.
 *
 * An EMPTY list means every value the verdict reads was written in this suite's own text.
 *
 * Calls are followed with their arguments bound to the callee's parameters, because a suite that
 * reports through `rejects(name, code, source)` computes the verdict inside the helper; reading the
 * call site alone would call every such cell self-fed. The reporter's own bookkeeping is skipped:
 * `passed++` and its output line are not evidence about the code under test, and counting them made
 * every cell in every suite carry a witness, including the two entries this exists to refuse.
 */
export const cellWitnesses = (sf, site) => {
  const witnesses = [];
  const frames = [];
  const visiting = new Set();
  const seen = new Set();

  const frameFor = (decl) => {
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].has(decl)) return frames[i];
    return undefined;
  };

  const functionValue = (binding) => {
    if (binding?.kind === "function") return binding.node;
    if (binding?.kind === "variable" && binding.node.initializer !== undefined && functionLike(binding.node.initializer)) {
      return binding.node.initializer;
    }
    return undefined;
  };

  const enter = (fn, args, andThen) => {
    // A recursive or bodiless callee is not something this can read through, so it observes
    // something as far as this analysis is concerned.
    if (fn.body === undefined || visiting.has(fn)) { witnesses.push({ kind: "opaque", node: fn }); return; }
    visiting.add(fn);
    const frame = new Map();
    fn.parameters.forEach((param, i) => { if (ts.isIdentifier(param.name)) frame.set(param, args[i]); });
    frames.push(frame);
    andThen();
    frames.pop();
    visiting.delete(fn);
  };

  const walk = (node) => {
    if (node === undefined || seen.has(node)) return;
    seen.add(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // `await import("../src/x.js")` is the same observation a static import is, and it is how a
      // suite reaches a module it must load after some setup.
      const spec = node.arguments[0];
      witnesses.push({ kind: "import", spec: spec !== undefined && ts.isStringLiteral(spec) ? spec.text : "", node });
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (LAUNCHERS.has(name)) witnesses.push({ kind: "launch", node });
      else if (READERS.has(name)) witnesses.push({ kind: "read", node });
      for (const arg of node.arguments ?? []) walk(arg);
      if (ts.isIdentifier(node.expression)) {
        const fn = functionValue(bindingFor(node.expression, node.expression.text));
        if (fn !== undefined) { enter(fn, [...(node.arguments ?? [])], () => walk(fn.body)); return; }
      }
      walk(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      const binding = bindingFor(node, node.text);
      // An ambient global observes no file here, and a type-only import is erased before the
      // program runs, so neither can carry an edit to the mutated file into this verdict.
      if (binding === undefined) return;
      if (binding.kind === "type") return;
      if (binding.kind === "import") { witnesses.push({ kind: "import", spec: binding.spec, node }); return; }
      if (binding.kind === "unresolved") { witnesses.push({ kind: "opaque", node }); return; }
      if (binding.kind === "param") {
        const frame = frameFor(binding.node);
        // A parameter reached through a call this analysis followed stands for that call's
        // argument. One reached any other way carries a value from outside, and refusing on it
        // would be a claim this cannot back.
        if (frame === undefined) { witnesses.push({ kind: "opaque", node }); return; }
        walk(frame.get(binding.node));
        return;
      }
      if (binding.kind === "catch") { walk(binding.node.parent.tryBlock); return; }
      // A class is opaque: its methods run whenever anything holding an instance calls them, and in
      // a smoke suite that caller is usually the code under test.
      if (binding.kind === "class") { walk(binding.node); return; }
      const init = binding.node.initializer;
      if (init !== undefined && isConst(binding.node)
        && !ts.isArrayLiteralExpression(init) && !ts.isObjectLiteralExpression(init) && !ts.isNewExpression(init)) {
        walk(init);
        return;
      }
      // A `let`, or a mutable container: whoever fills it is elsewhere, so everything written into
      // that name in this file joins the closure.
      for (const write of writesInto(sf, node.text)) walk(write);
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) { walk(node.expression); return; }
    if (ts.isElementAccessExpression(node)) { walk(node.expression); walk(node.argumentExpression); return; }
    if (ts.isQualifiedName(node)) { walk(node.left); return; }
    if (ts.isAwaitExpression(node)) { walk(node.expression); return; }
    if (ts.isTypeNode(node) && !ts.isTypeQueryNode(node)) return;
    ts.forEachChild(node, walk);
  };

  const reporter = bindingFor(site.expression, calleeName(site.expression));
  const fn = functionValue(reporter);
  // The reporter may be imported, or a value this cannot resolve. Then the verdict is computed
  // somewhere unreadable and there is no standing to refuse.
  if (fn === undefined) { witnesses.push({ kind: "unresolved-reporter", node: site }); return witnesses; }

  const verdictParams = new Set(fn.parameters.filter((param, i) => i >= 1 && ts.isIdentifier(param.name)));
  for (const arg of site.arguments.slice(1)) walk(arg);
  enter(fn, [...site.arguments], () => {
    const consumes = (node) => {
      let hit = false;
      const scan = (candidate) => {
        if (hit) return;
        if (ts.isIdentifier(candidate)) {
          const binding = bindingFor(candidate, candidate.text);
          if (binding?.kind === "param" && verdictParams.has(binding.node)) hit = true;
          return;
        }
        ts.forEachChild(candidate, scan);
      };
      scan(node);
      return hit;
    };
    const scanBody = (node) => {
      if (ts.isExpression(node) && consumes(node)) { walk(node); return; }
      ts.forEachChild(node, scanBody);
    };
    scanBody(fn.body);
  });
  return witnesses;
};

/**
 * Every call in `sf` reporting the assertion named `cell`: first argument the literal cell text,
 * and at least one more argument carrying the verdict.
 *
 * The cell text must be a LITERAL. A composed label cannot be matched against a fixture's `cell`
 * string without evaluating the suite, and a partial match would let a prefix stand for the whole.
 */
export const cellSites = (sf, cell) => {
  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const first = node.arguments[0];
      if ((ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && first.text === cell) sites.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
};

/**
 * Grade one mutation's `cell` against the file that mutation edits.
 *
 * Returns one of:
 *   `{ verdict: "exempt" }`      the cell lives in the mutated file itself, so running it observes
 *                                the mutation by construction.
 *   `{ verdict: "unlocated" }`   no declared suite source reports that literal cell. Not refused:
 *                                a composed or externally reported label lands here too.
 *   `{ verdict: "observes" }`    the verdict rests on at least one launch, read, import, or value
 *                                this analysis could not read through.
 *   `{ verdict: "self-fed" }`    every value the verdict rests on was written in the suite's own
 *                                text, so no edit to the mutated file can change what it prints.
 */
export const gradeCellTarget = (mutationFile, sources) => {
  let located = false;
  for (const { path, sf, cell } of sources) {
    if (path === mutationFile) return { verdict: "exempt", path };
    for (const site of cellSites(sf, cell)) {
      located = true;
      const witnesses = cellWitnesses(sf, site);
      if (witnesses.length > 0) {
        return { verdict: "observes", path, kinds: [...new Set(witnesses.map((w) => w.kind))] };
      }
    }
  }
  return located ? { verdict: "self-fed" } : { verdict: "unlocated" };
};

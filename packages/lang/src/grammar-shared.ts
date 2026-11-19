/** The validator's shared node and scope helpers: the AST node and walker types, child iteration,
 *  pattern bindings, hoisting, the scope tree, and the captured-write and async-call-position checks
 *  that both validator walks in `grammar.ts` and `grammar-resolve.ts` use. */
import type { Node } from "acorn";
import { LangError, type LangErrorCode, type SourceSpan } from "./errors.js";
import {
  primitiveDoc,
} from "./primitives.js";
import { scopeTraits } from "./keys.js";
import { MUTATING_METHODS } from "./library.js";

const MUTATORS = new Set(MUTATING_METHODS);

/** Acorn nodes are loosely typed; this is the shape we actually read. */
export type AnyNode = Node & Record<string, unknown>;

export class Validator {
  readonly errors: LangError[] = [];
  readonly warnings: LangError[] = [];
  /**
   * Named functions, by name, for L2032's reach.
   *
   * A branch does not have to be written at the combinator call — `parallel({ a, b })` names two
   * functions declared elsewhere, and an inline branch can call a helper that writes the outer
   * binding on its behalf. Both are the same defect and neither is visible from the call site
   * alone, so the names are resolved here. A name bound to two different functions maps to `null`:
   * it cannot be resolved, and guessing which one a branch meant is worse than saying so.
   */
  readonly functions = new Map<string, AnyNode | null>();
  /**
   * The parent of every call, recorded by the shape walk for the resolution walk.
   *
   * L2013 is a rule about POSITION (awaited, returned, or a combinator's thunk) and, for a user
   * function, about the callee's declaration (async or not). The shape walk sees the position and
   * the resolution walk sees the declaration, so the position is carried across.
   */
  readonly parents = new WeakMap<AnyNode, AnyNode | null>();

  constructor(
    readonly source: string,
    readonly file: string,
  ) {}

  span(node: AnyNode): SourceSpan {
    const loc = node.loc as { start: { line: number; column: number } } | undefined;
    return {
      file: this.file,
      line: loc?.start.line ?? 1,
      column: (loc?.start.column ?? 0) + 1,
    };
  }

  fail(
    code: LangErrorCode,
    node: AnyNode,
    cause: string,
    fix: string,
    calleeName?: string,
  ): void {
    const callee = calleeName === undefined ? undefined : primitiveDoc(calleeName);
    this.errors.push(
      new LangError(callee === undefined
        ? { code, span: this.span(node), cause, fix }
        : { code, span: this.span(node), cause, fix, callee }),
    );
  }

  warn(code: LangErrorCode, node: AnyNode, cause: string, fix: string, calleeName?: string): void {
    const callee = calleeName === undefined ? undefined : primitiveDoc(calleeName);
    this.warnings.push(
      new LangError(callee === undefined
        ? { code, span: this.span(node), cause, fix }
        : { code, span: this.span(node), cause, fix, callee }),
    );
  }
}

/** Child keys to descend into, per node, without pulling in a walker dependency. */
export function children(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end" || key === "type") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const v of value) if (isNode(v)) out.push(v);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

export function isNode(v: unknown): v is AnyNode {
  return v !== null && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

/** The static name of a member access: `x.a` and `x["a"]` both name `a`; `x[k]` names nothing. */
function memberName(member: AnyNode): string | null {
  const property = member.property as AnyNode | undefined;
  if (property === undefined) return null;
  if (member.computed !== true) return property.type === "Identifier" ? (property.name as string) : null;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : null;
}

/** The name of a non-computed property key, or null when it is computed. */
export function propertyKeyName(node: AnyNode): string | null {
  if (node.computed === true) return null;
  const key = node.key as AnyNode | undefined;
  if (key === undefined) return null;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal") return String(key.value);
  return null;
}

// ---- walk 2: resolution and effect call shape --------------------------------------------

export class Scope {
  readonly names = new Map<string, "const" | "let" | "param">();
  /** The function node a name is bound to HERE, when it is bound to one at all. */
  private readonly fns = new Map<string, AnyNode>();
  /**
   * Names declared LATER in this scope than the point the walk has reached. A `let`/`const` binds
   * the WHOLE block it is in, so a reference above the declaration resolves to it — and, executed,
   * would find a binding that does not hold a value yet (JavaScript's temporal dead zone, a
   * guaranteed runtime ReferenceError in straight-line code). This language refuses it when the
   * program is read (L2004), the way it already refuses an unknown name (L2001) that JavaScript
   * would also only catch at runtime. A reference from inside a NESTED FUNCTION is exempt: the
   * function runs later, when the binding may well be initialized — that is the mutual-recursion
   * shape — so the walk only refuses what straight-line execution is certain to hit.
   */
  readonly pending = new Set<string>();
  /** True where this scope is a function body: references from inside it to a pending outer name are deferred, not certain. */
  fnBoundary = false;
  constructor(readonly parent: Scope | null) {}

  declare(name: string, kind: "const" | "let" | "param", fn?: AnyNode): void {
    this.names.set(name, kind);
    if (fn !== undefined) this.fns.set(name, fn);
    else this.fns.delete(name);
  }

  /**
   * Is a reference to `name` FROM this scope certain to land in a dead zone? True only when the
   * scope that owns the binding still has it pending and no function boundary lies between the
   * reference and the owner.
   */
  refersToPending(name: string): boolean {
    let crossedFn = false;
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      if (s.names.has(name)) return s.pending.has(name) && !crossedFn;
      if (s.fnBoundary) crossedFn = true;
    }
    return false;
  }

  lookup(name: string): "const" | "let" | "param" | undefined {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      const k = s.names.get(name);
      if (k !== undefined) return k;
    }
    return undefined;
  }

  /**
   * The function this name is bound to AT THIS POINT IN THE PROGRAM, or nothing.
   *
   * The nearest binding decides, and a binding that is not a function answers `undefined` rather
   * than deferring outward — that is the difference between resolving a name and resolving a
   * BINDING. A program-wide name map cannot tell `parallel({ branch })` inside
   * `function use(branch)` from the top-level `function branch()` of the same name, and blaming a
   * clean program for what an unrelated declaration elsewhere happens to write is worse than
   * leaving one branch unproven: an unproven branch is still refused at runtime by the depth check.
   */
  lookupFn(name: string): AnyNode | undefined {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      if (s.names.has(name)) return s.fns.get(name);
    }
    return undefined;
  }
}

/**
 * Collect the targets a pattern writes: identifiers, and in an assignment pattern also member
 * expressions (`[o.a] = …`). A non-pattern node is its own single target.
 */
export function patternTargets(node: AnyNode, out: AnyNode[]): void {
  switch (node.type) {
    case "ObjectPattern":
      for (const p of node.properties as AnyNode[]) {
        if (p.type === "RestElement") patternTargets(p.argument as AnyNode, out);
        else patternTargets(p.value as AnyNode, out);
      }
      break;
    case "ArrayPattern":
      for (const el of node.elements as (AnyNode | null)[]) if (el !== null) patternTargets(el, out);
      break;
    case "AssignmentPattern":
      patternTargets(node.left as AnyNode, out);
      break;
    case "RestElement":
      patternTargets(node.argument as AnyNode, out);
      break;
    default:
      out.push(node);
      break;
  }
}

/** Collect the identifiers a binding pattern introduces. */
export function patternNames(node: AnyNode, out: string[]): void {
  const targets: AnyNode[] = [];
  patternTargets(node, targets);
  for (const t of targets) if (t.type === "Identifier") out.push(t.name as string);
}

/**
 * Only two positions are legal for a call that starts an effect: awaited, or the concise body of
 * an arrow that a combinator owns as a thunk (a `return` is the braced spelling of the same thing).
 * Everything else, including a bare statement, starts work nothing waits for.
 */
export function asyncCallPositionOk(parent: AnyNode): boolean {
  return (
    parent.type === "AwaitExpression" ||
    parent.type === "ArrowFunctionExpression" ||
    parent.type === "ReturnStatement"
  );
}

export const unawaitedCause = (name: string): string =>
  `This \`${name}\` is not awaited, so it starts work whose result nothing waits for. Read literally the program says one thing and the runtime does another: calls outside a combinator run in sequence, not concurrently.`;

export const unawaitedFix = (name: string): string =>
  `Await it (\`await ${name}(...)\`), return it, or make it a branch of \`parallel\`, \`race\` or \`fanOut\`.`;

export function isFunctionNode(node: AnyNode): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/** The identifier a write lands on: `x` for `x`, `x.a`, `x[i].b` and `x?.a`. */
function rootIdentifier(node: AnyNode | undefined): AnyNode | undefined {
  if (node === undefined || !isNode(node)) return undefined;
  if (node.type === "Identifier") return node;
  if (node.type === "MemberExpression") return rootIdentifier(node.object as AnyNode);
  if (node.type === "ChainExpression") return rootIdentifier(node.expression as AnyNode);
  return undefined;
}

function capturedWrite(at: AnyNode, name: string, combinator: string, v: Validator): void {
  if (!scopeTraits(combinator)?.assembles) {
    v.fail(
      "L2032",
      at,
      `\`${name}\` is declared outside this \`${combinator}\` and written inside it. A settled \`${combinator}\` is replayed without entering its body, so the write happens on the live run and never on resume, and the resumed run reads the old value and takes a path it never recorded, with no divergence raised.`,
      `Return the value from the body and read it out of \`${combinator}\`'s result.`,
      combinator,
    );
    return;
  }
  v.fail(
    "L2032",
    at,
    `\`${name}\` is declared outside this branch and written inside it. Two branches racing to write one place is nondeterministic, and freezing does not cover it because nothing crosses an effect boundary. It is also silent: live, the branches write in completion order, but on resume the recorded effects return instantly and they write in launch order, so \`${name}\` holds a different value and the run takes a path it never recorded — with no divergence raised, because no effect's inputs changed.`,
    `Return the value from the branch and read it out of \`${combinator}\`'s result, or use \`race\`, which yields its winner.`,
    combinator,
  );
}

/** Report each binding declared outside the branch that any target of a write lands on. */
function checkWriteTarget(target: AnyNode, scope: Scope, combinator: string, v: Validator): void {
  const targets: AnyNode[] = [];
  patternTargets(target, targets);
  for (const t of targets) {
    const root = rootIdentifier(t);
    if (root !== undefined && scope.lookup(root.name as string) === undefined) {
      capturedWrite(root, root.name as string, combinator, v);
    }
  }
}

/** Walk one branch thunk with its OWN scope chain: anything it did not declare, it captured. */
export function checkCapturedWrites(fn: AnyNode, combinator: string, v: Validator, seen: Set<AnyNode>): void {
  if (seen.has(fn)) return;
  seen.add(fn);
  const local = new Scope(null);
  for (const p of (fn.params as AnyNode[]) ?? []) {
    const names: string[] = [];
    patternNames(p, names);
    for (const n of names) local.declare(n, "param");
  }
  if (isNode(fn.body)) walkCaptured(fn.body as AnyNode, local, combinator, v, seen);
}

function walkCaptured(node: AnyNode, scope: Scope, combinator: string, v: Validator, seen: Set<AnyNode>): void {
  switch (node.type) {
    case "VariableDeclaration": {
      const kind = node.kind === "const" ? "const" : "let";
      for (const d of (node.declarations as AnyNode[]) ?? []) {
        if (isNode(d.init)) walkCaptured(d.init as AnyNode, scope, combinator, v, seen);
        const names: string[] = [];
        patternNames(d.id as AnyNode, names);
        for (const n of names) scope.declare(n, kind);
      }
      return;
    }

    case "AssignmentExpression":
    case "UpdateExpression": {
      // `x = 1`, `x += 1`, `x++`, `x.a = 1` and `x[i] += 1` are the same defect: something declared
      // outside the branch is written inside it. A write through a member expression reaches the
      // VALUE the outer binding holds, which is no more ordered across branches than the binding
      // itself; the runtime half (values carry the depth they were born at) covers what a value
      // reached through an alias hides from this walk.
      const target = (node.type === "AssignmentExpression" ? node.left : node.argument) as AnyNode;
      checkWriteTarget(target, scope, combinator, v);
      for (const c of children(node)) walkCaptured(c, scope, combinator, v, seen);
      return;
    }

    case "CallExpression": {
      // FOLLOW THE CALL. A branch that writes nothing itself and calls a helper that writes the
      // outer binding is the same defect one level down, and it is invisible at the combinator call.
      // The helper is checked as a branch in its own right, with its own scope, so the blame lands
      // on the line that actually writes — and a helper that only touches its own locals is clean,
      // which is what keeps ordinary shared procedures usable.
      const callee = node.callee;
      if (isNode(callee) && (callee as AnyNode).type === "Identifier") {
        const nm = (callee as AnyNode).name as string;
        // A locally-declared name is a local binding, not the program-level function of that name.
        if (scope.lookup(nm) === undefined) {
          const target = v.functions.get(nm);
          if (target !== undefined && target !== null) checkCapturedWrites(target, combinator, v, seen);
        }
      }
      // `outer.push(x)` from a branch is `outer[len(outer)] = x` spelled as a method.
      if (isNode(callee) && (callee as AnyNode).type === "MemberExpression") {
        const member = callee as AnyNode;
        const method = memberName(member);
        const root = rootIdentifier(member.object as AnyNode);
        if (
          method !== null &&
          MUTATORS.has(method) &&
          root !== undefined &&
          scope.lookup(root.name as string) === undefined
        ) {
          capturedWrite(root, root.name as string, combinator, v);
        }
      }
      for (const c of children(node)) walkCaptured(c, scope, combinator, v, seen);
      return;
    }

    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      if (node.type === "FunctionDeclaration" && isNode(node.id)) {
        scope.declare((node.id as AnyNode).name as string, "const");
      }
      const inner = new Scope(scope);
      for (const p of (node.params as AnyNode[]) ?? []) {
        const names: string[] = [];
        patternNames(p, names);
        for (const n of names) inner.declare(n, "param");
      }
      if (isNode(node.body)) walkCaptured(node.body as AnyNode, inner, combinator, v, seen);
      return;
    }

    case "BlockStatement": {
      const inner = new Scope(scope);
      hoistFunctions(node, inner);
      for (const s of (node.body as AnyNode[]) ?? []) walkCaptured(s, inner, combinator, v, seen);
      return;
    }

    case "CatchClause": {
      const inner = new Scope(scope);
      if (isNode(node.param)) {
        const names: string[] = [];
        patternNames(node.param as AnyNode, names);
        for (const n of names) inner.declare(n, "const");
      }
      if (isNode(node.body)) walkCaptured(node.body as AnyNode, inner, combinator, v, seen);
      return;
    }

    case "ForStatement":
    case "ForOfStatement": {
      // `for (x of xs)` with no declaration assigns `x` on every iteration.
      if (node.type === "ForOfStatement" && (node.left as AnyNode).type !== "VariableDeclaration") {
        checkWriteTarget(node.left as AnyNode, scope, combinator, v);
      }
      const inner = new Scope(scope);
      for (const c of children(node)) walkCaptured(c, inner, combinator, v, seen);
      return;
    }

    default: {
      for (const c of children(node)) walkCaptured(c, scope, combinator, v, seen);
      return;
    }
  }
}

/** Function declarations are visible to the whole block, so bind them before walking it. */
export function hoistFunctions(block: AnyNode, scope: Scope): void {
  for (const s of (block.body as AnyNode[]) ?? []) {
    if (s.type === "FunctionDeclaration" && isNode(s.id)) {
      scope.declare((s.id as AnyNode).name as string, "const", s);
    }
  }
}

/**
 * `let`/`const` bind the whole block too — as PENDING, so a straight-line reference above the
 * declaration is L2004 rather than a resolution to whatever outer binding shares the name.
 */
export function hoistBindings(block: AnyNode, scope: Scope): void {
  for (const s of (block.body as AnyNode[]) ?? []) {
    if (s.type !== "VariableDeclaration") continue;
    const kind = s.kind === "const" ? "const" : "let";
    for (const d of (s.declarations as AnyNode[]) ?? []) {
      const names: string[] = [];
      patternNames(d.id as AnyNode, names);
      for (const n of names) {
        scope.declare(n, kind);
        scope.pending.add(n);
      }
    }
  }
}

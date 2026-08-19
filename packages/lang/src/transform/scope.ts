/**
 * The binding analysis the emitter runs first: which names resolve where, and which of them are
 * CELLS.
 *
 * A cell is L2032's binding half, and it exists because the walker's rule is a runtime one. `Env.set`
 * refuses a write whose binding was declared at a shallower concurrency depth than the frame doing
 * the writing, and the depth travels with the BINDING — which is what catches the shape the
 * validator provably cannot see (`scopes.smoke` §8: a record of thunks returned from a function, so
 * there is no function node at the combinator call to check). Native JavaScript bindings carry no
 * depth, so a transform that emits them verbatim loses that refusal.
 *
 * The fix needs no new seam member. A binding written from inside a DEEPER function than the one
 * that declared it becomes a one-field record built with `__ctx.born({v})`: birth depth is stamped
 * at the declaration, `__ctx.set` refuses the write from a deeper frame, and L2032's binding half
 * lands on the same door as its value half. Every other binding stays a native `const`/`let` —
 * which is sound rather than merely fast: a binding no nested function writes can only be written
 * at the depth it was declared at, so there is nothing for the check to refuse.
 */

import { RESERVED_NAMES } from "../primitives.js";

export type AnyNode = Record<string, unknown> & { type: string };

export interface Binding {
  readonly name: string;
  /** `const` can never be a cell BY THE WRITE RULE: the binding cannot be written at all (L2003, static). */
  readonly kind: "const" | "let" | "param" | "function";
  /** Which function scope declared it. A write from a different (deeper) one is what makes a cell. */
  readonly funcId: number;
  /**
   * The end of this binding's own declarator, for F7's textual clause. Null where the question
   * cannot arise: a parameter is bound at the call and a `function` declaration is hoisted, so
   * neither can be read before it holds a value.
   */
  readonly declEnd: number | null;
  /** A record rather than a native binding: L2032's binding half, or F7's dead zone. */
  cell: boolean;
  /**
   * A cell because it can be READ BEFORE ITS DECLARATION (F7), which the L2032 write rule cannot
   * see. It is kept apart from {@link cell} because only this class needs its record hoisted to the
   * top of the block: a binding that is a cell only for the write rule cannot be read early, so its
   * record is still built where it is declared, with its value already in it.
   */
  deadZone: boolean;
}

export interface Analysis {
  /** Every Identifier node in a reference or write position, resolved. An absent node is a free name. */
  readonly bindingOf: ReadonlyMap<AnyNode, Binding>;
  readonly bindings: readonly Binding[];
}

class Scope {
  readonly names = new Map<string, Binding>();
  constructor(
    readonly parent: Scope | null,
    readonly funcId: number,
  ) {}

  declare(b: Binding): void {
    this.names.set(b.name, b);
  }

  resolve(name: string): Binding | undefined {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      const b = s.names.get(name);
      if (b !== undefined) return b;
    }
    return undefined;
  }
}

/** One function between a read and the binding it reads, as F7's predicate needs to see it. */
interface Enclosing {
  readonly funcId: number;
  /** A hoisted `function` declaration: reachable before anything textually after it has run. */
  readonly hoisted: boolean;
  /** Where the STATEMENT holding this function literal starts. */
  readonly stmtStart: number;
}

class Walk {
  readonly bindingOf = new Map<AnyNode, Binding>();
  readonly bindings: Binding[] = [];
  private nextFunc = 0;
  /** The functions currently open, outermost first. F7 reads the path from a use out to its binding. */
  private readonly fns: Enclosing[] = [];
  /** The statement being walked. A function literal's "enclosing statement" is this one. */
  private stmtStart = 0;

  private declare(scope: Scope, name: string, kind: Binding["kind"], declEnd: number | null = null): Binding {
    const b: Binding = { name, kind, funcId: scope.funcId, declEnd, cell: false, deadZone: false };
    this.bindings.push(b);
    scope.declare(b);
    return b;
  }

  /** A reference: record where it resolved, so the emitter reads the answer rather than recomputing it. */
  private ref(node: AnyNode, scope: Scope): void {
    const b = scope.resolve(node.name as string);
    // A name the program never declared is a free name (a builtin, a primitive, `undefined`). The
    // validator refuses shadowing a reserved name, so resolution cannot disagree with that table.
    if (b !== undefined) {
      this.bindingOf.set(node, b);
      this.deadZone(b);
    }
  }

  /**
   * F7, ruled: which captured bindings can be READ BEFORE THEY HOLD A VALUE, and so must be cells.
   *
   * The walker refuses that read L2004 — a code a program can catch and read — while a native
   * JavaScript binding answers a host ReferenceError, which `caught` can only report as L4000/host.
   * So a binding a closure could read early becomes a record, `get` answers L2004 for it by name,
   * and the two engines agree. Same-block direct reads never reach here: the validator refuses them
   * (measured, `log(x); const x = 1;` is a validation error).
   *
   * The rule, as ruled, over the path from the read out to the binding's own scope:
   *   (i)  ANY hoisted `function` declaration on the path — at any depth, because an arrow inside a
   *        hoisted function called early is reachable just the same (measured: `const r = f()` with
   *        `function f() { const g = () => x; return g(); }` and `const x = 1` after is L2004); or
   *   (ii) the OUTERMOST function on the path is an expression whose enclosing statement is not
   *        textually after the end of the declarator — which deliberately includes an arrow inside
   *        the binding's own initializer, since `const x = (() => x)()` is L2004 (measured).
   * Every other captured binding stays native, and that class keeps its own evidence: `const x = 1`
   * followed by a closure reading it answers 1 on both engines.
   */
  private deadZone(b: Binding): void {
    if (b.declEnd === null) return;
    const at = this.fns.findIndex((f) => f.funcId === b.funcId);
    const path = this.fns.slice(at + 1);
    if (path.length === 0) return;
    if (path.some((f) => f.hoisted) || (path[0] as Enclosing).stmtStart < b.declEnd) {
      b.cell = true;
      b.deadZone = true;
    }
  }

  /** A write to a binding. The cell rule is here and nowhere else. */
  private write(node: AnyNode, scope: Scope, funcId: number): void {
    const b = scope.resolve(node.name as string);
    if (b === undefined) return;
    this.bindingOf.set(node, b);
    if (b.funcId !== funcId && b.kind !== "const") b.cell = true;
    // AND F7 OVER WRITES, ruled after the read half landed. A write reaches the dead zone by the
    // same path a read does — measured on the walker, `n = 2` inside a hoisted `function` called
    // before `let n = 1` is a CATCHABLE L2004 and `n` still reads 1 afterwards — so the same
    // predicate decides it, and the record has to be hoisted for the same reason: an unhoisted one
    // is still in its own temporal dead zone when the early write evaluates the argument, and the
    // native ReferenceError never reaches the seam.
    this.deadZone(b);
  }

  /**
   * The names a declaration or a parameter introduces, declared into `scope`.
   *
   * The declaring Identifier node is recorded in `bindingOf` too, not only its references: the
   * emitter asks the same question at a declaration as at a use (is this a cell?), and answering
   * "no" for every declaration because the node was not in the map is a cell that is emitted as a
   * plain binding — the L2032 refusal silently gone.
   */
  private declarePattern(node: AnyNode, scope: Scope, kind: Binding["kind"], declEnd: number | null = null): void {
    switch (node.type) {
      case "Identifier":
        this.bindingOf.set(node, this.declare(scope, node.name as string, kind, declEnd));
        return;
      case "AssignmentPattern":
        this.declarePattern(node.left as AnyNode, scope, kind, declEnd);
        return;
      case "RestElement":
        this.declarePattern(node.argument as AnyNode, scope, kind, declEnd);
        return;
      case "ObjectPattern":
        for (const p of (node.properties as AnyNode[]) ?? []) {
          this.declarePattern((p.type === "RestElement" ? p.argument : p.value) as AnyNode, scope, kind, declEnd);
        }
        return;
      case "ArrayPattern":
        for (const el of (node.elements as (AnyNode | null)[]) ?? []) {
          if (el !== null && el !== undefined) this.declarePattern(el, scope, kind, declEnd);
        }
        return;
      default:
        return;
    }
  }

  /** The expressions INSIDE a declaration pattern (a default value, a computed key). */
  private patternExprs(node: AnyNode, scope: Scope, funcId: number): void {
    switch (node.type) {
      case "AssignmentPattern":
        this.patternExprs(node.left as AnyNode, scope, funcId);
        this.expr(node.right as AnyNode, scope, funcId);
        return;
      case "RestElement":
        this.patternExprs(node.argument as AnyNode, scope, funcId);
        return;
      case "ObjectPattern":
        for (const p of (node.properties as AnyNode[]) ?? []) {
          if (p.type === "RestElement") {
            this.patternExprs(p.argument as AnyNode, scope, funcId);
            continue;
          }
          if (p.computed === true) this.expr(p.key as AnyNode, scope, funcId);
          this.patternExprs(p.value as AnyNode, scope, funcId);
        }
        return;
      case "ArrayPattern":
        for (const el of (node.elements as (AnyNode | null)[]) ?? []) {
          if (el !== null && el !== undefined) this.patternExprs(el, scope, funcId);
        }
        return;
      default:
        return;
    }
  }

  /** An ASSIGNMENT pattern: `[a, b] = [b, a]`. Its names are written, not declared. */
  private assignPattern(node: AnyNode, scope: Scope, funcId: number): void {
    switch (node.type) {
      case "Identifier":
        this.write(node, scope, funcId);
        return;
      case "MemberExpression":
        this.expr(node, scope, funcId);
        return;
      case "AssignmentPattern":
        this.assignPattern(node.left as AnyNode, scope, funcId);
        this.expr(node.right as AnyNode, scope, funcId);
        return;
      case "RestElement":
        this.assignPattern(node.argument as AnyNode, scope, funcId);
        return;
      case "ObjectPattern":
        for (const p of (node.properties as AnyNode[]) ?? []) {
          if (p.type === "RestElement") {
            this.assignPattern(p.argument as AnyNode, scope, funcId);
            continue;
          }
          if (p.computed === true) this.expr(p.key as AnyNode, scope, funcId);
          this.assignPattern(p.value as AnyNode, scope, funcId);
        }
        return;
      case "ArrayPattern":
        for (const el of (node.elements as (AnyNode | null)[]) ?? []) {
          if (el !== null && el !== undefined) this.assignPattern(el, scope, funcId);
        }
        return;
      default:
        return;
    }
  }

  /**
   * A function: its own scope, its own id. The id is what the cell rule compares — a write from a
   * different function id than the declaration's is a write from a frame the walker would have
   * charged a deeper depth.
   */
  private fn(node: AnyNode, outer: Scope): void {
    this.nextFunc += 1;
    const funcId = this.nextFunc;
    const scope = new Scope(outer, funcId);
    this.fns.push({ funcId, hoisted: node.type === "FunctionDeclaration", stmtStart: this.stmtStart });
    try {
      this.fnBody(node, scope, funcId);
    } finally {
      this.fns.pop();
    }
  }

  private fnBody(node: AnyNode, scope: Scope, funcId: number): void {
    // A named function expression sees its own name, exactly as the walker's `makeFunction` binds it.
    if (node.type === "FunctionExpression" && node.id !== null && node.id !== undefined) {
      this.declare(scope, (node.id as AnyNode).name as string, "function");
    }
    for (const p of (node.params as AnyNode[]) ?? []) this.declarePattern(p, scope, "param");
    for (const p of (node.params as AnyNode[]) ?? []) this.patternExprs(p, scope, funcId);
    const body = node.body as AnyNode;
    if (body.type === "BlockStatement") this.block(body, scope, funcId);
    else this.expr(body, scope, funcId);
  }

  /** A block: hoist its function declarations and its dead-zone names, then walk it. */
  block(node: AnyNode, outer: Scope, funcId: number): void {
    const scope = new Scope(outer, funcId);
    const body = (node.body as AnyNode[]) ?? [];
    for (const s of body) {
      if (s.type === "FunctionDeclaration") this.declare(scope, ((s.id as AnyNode).name as string), "function");
    }
    for (const s of body) {
      if (s.type !== "VariableDeclaration") continue;
      for (const d of (s.declarations as AnyNode[]) ?? []) {
        this.declarePattern(d.id as AnyNode, scope, s.kind === "let" ? "let" : "const", d.end as number);
      }
    }
    for (const s of body) this.stmt(s, scope, funcId);
  }

  stmt(node: AnyNode, scope: Scope, funcId: number): void {
    const outer = this.stmtStart;
    this.stmtStart = node.start as number;
    try {
      this.statement(node, scope, funcId);
    } finally {
      this.stmtStart = outer;
    }
  }

  private statement(node: AnyNode, scope: Scope, funcId: number): void {
    switch (node.type) {
      case "ExpressionStatement":
        this.expr(node.expression as AnyNode, scope, funcId);
        return;
      case "VariableDeclaration":
        for (const d of (node.declarations as AnyNode[]) ?? []) {
          this.patternExprs(d.id as AnyNode, scope, funcId);
          if (d.init !== null && d.init !== undefined) this.expr(d.init as AnyNode, scope, funcId);
        }
        return;
      case "FunctionDeclaration":
        this.fn(node, scope);
        return;
      case "BlockStatement":
        this.block(node, scope, funcId);
        return;
      case "IfStatement":
        this.expr(node.test as AnyNode, scope, funcId);
        this.stmt(node.consequent as AnyNode, scope, funcId);
        if (node.alternate !== null && node.alternate !== undefined) this.stmt(node.alternate as AnyNode, scope, funcId);
        return;
      case "WhileStatement":
        this.expr(node.test as AnyNode, scope, funcId);
        this.stmt(node.body as AnyNode, scope, funcId);
        return;
      case "ForStatement": {
        const head = new Scope(scope, funcId);
        const init = node.init as AnyNode | null;
        if (init !== null && init !== undefined) {
          if (init.type === "VariableDeclaration") {
            for (const d of (init.declarations as AnyNode[]) ?? []) {
              this.declarePattern(d.id as AnyNode, head, init.kind === "let" ? "let" : "const");
            }
            this.stmt(init, head, funcId);
          } else {
            this.expr(init, head, funcId);
          }
        }
        if (node.test !== null && node.test !== undefined) this.expr(node.test as AnyNode, head, funcId);
        if (node.update !== null && node.update !== undefined) this.expr(node.update as AnyNode, head, funcId);
        this.stmt(node.body as AnyNode, head, funcId);
        return;
      }
      case "ForOfStatement": {
        this.expr(node.right as AnyNode, scope, funcId);
        const head = new Scope(scope, funcId);
        const left = node.left as AnyNode;
        if (left.type === "VariableDeclaration") {
          const target = ((left.declarations as AnyNode[])[0] as AnyNode).id as AnyNode;
          this.declarePattern(target, head, left.kind === "let" ? "let" : "const");
          this.patternExprs(target, head, funcId);
        } else {
          this.assignPattern(left, head, funcId);
        }
        this.stmt(node.body as AnyNode, head, funcId);
        return;
      }
      case "ReturnStatement":
      case "ThrowStatement":
        if (node.argument !== null && node.argument !== undefined) this.expr(node.argument as AnyNode, scope, funcId);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "EmptyStatement":
        return;
      case "TryStatement": {
        this.block(node.block as AnyNode, scope, funcId);
        const handler = node.handler as AnyNode | null;
        if (handler !== null && handler !== undefined) {
          const catchScope = new Scope(scope, funcId);
          if (handler.param !== null && handler.param !== undefined) {
            this.declarePattern(handler.param as AnyNode, catchScope, "let");
            this.patternExprs(handler.param as AnyNode, catchScope, funcId);
          }
          this.block(handler.body as AnyNode, catchScope, funcId);
        }
        if (node.finalizer !== null && node.finalizer !== undefined) this.block(node.finalizer as AnyNode, scope, funcId);
        return;
      }
      case "SwitchStatement": {
        this.expr(node.discriminant as AnyNode, scope, funcId);
        // One scope for the whole switch, as the walker's `switchEnv` is: a `let` in one clause is
        // visible in the next, which is what falling through means.
        const switchScope = new Scope(scope, funcId);
        const cases = (node.cases as AnyNode[]) ?? [];
        for (const c of cases) {
          for (const s of (c.consequent as AnyNode[]) ?? []) {
            if (s.type === "FunctionDeclaration") this.declare(switchScope, ((s.id as AnyNode).name as string), "function");
          }
        }
        for (const c of cases) {
          for (const s of (c.consequent as AnyNode[]) ?? []) {
            if (s.type !== "VariableDeclaration") continue;
            for (const d of (s.declarations as AnyNode[]) ?? []) {
              this.declarePattern(d.id as AnyNode, switchScope, s.kind === "let" ? "let" : "const");
            }
          }
        }
        for (const c of cases) {
          if (c.test !== null && c.test !== undefined) this.expr(c.test as AnyNode, switchScope, funcId);
          for (const s of (c.consequent as AnyNode[]) ?? []) this.stmt(s, switchScope, funcId);
        }
        return;
      }
      default:
        return;
    }
  }

  expr(node: AnyNode, scope: Scope, funcId: number): void {
    switch (node.type) {
      case "Literal":
        return;
      case "Identifier":
        this.ref(node, scope);
        return;
      case "TemplateLiteral":
        for (const e of (node.expressions as AnyNode[]) ?? []) this.expr(e, scope, funcId);
        return;
      case "ArrayExpression":
        for (const el of (node.elements as (AnyNode | null)[]) ?? []) {
          if (el === null || el === undefined) continue;
          this.expr((el.type === "SpreadElement" ? el.argument : el) as AnyNode, scope, funcId);
        }
        return;
      case "ObjectExpression":
        for (const p of (node.properties as AnyNode[]) ?? []) {
          if (p.type === "SpreadElement") {
            this.expr(p.argument as AnyNode, scope, funcId);
            continue;
          }
          if (p.computed === true) this.expr(p.key as AnyNode, scope, funcId);
          this.expr(p.value as AnyNode, scope, funcId);
        }
        return;
      case "MemberExpression":
        this.expr(node.object as AnyNode, scope, funcId);
        if (node.computed === true) this.expr(node.property as AnyNode, scope, funcId);
        return;
      case "ChainExpression":
        this.expr(node.expression as AnyNode, scope, funcId);
        return;
      case "UnaryExpression":
        this.expr(node.argument as AnyNode, scope, funcId);
        return;
      case "UpdateExpression": {
        const arg = node.argument as AnyNode;
        if (arg.type === "Identifier") this.write(arg, scope, funcId);
        else this.expr(arg, scope, funcId);
        return;
      }
      case "BinaryExpression":
      case "LogicalExpression":
        this.expr(node.left as AnyNode, scope, funcId);
        this.expr(node.right as AnyNode, scope, funcId);
        return;
      case "ConditionalExpression":
        this.expr(node.test as AnyNode, scope, funcId);
        this.expr(node.consequent as AnyNode, scope, funcId);
        this.expr(node.alternate as AnyNode, scope, funcId);
        return;
      case "AssignmentExpression": {
        const left = node.left as AnyNode;
        if (left.type === "Identifier") this.write(left, scope, funcId);
        else if (left.type === "MemberExpression") this.expr(left, scope, funcId);
        else this.assignPattern(left, scope, funcId);
        this.expr(node.right as AnyNode, scope, funcId);
        return;
      }
      case "AwaitExpression":
        this.expr(node.argument as AnyNode, scope, funcId);
        return;
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        this.fn(node, scope);
        return;
      case "CallExpression":
        this.expr(node.callee as AnyNode, scope, funcId);
        for (const a of (node.arguments as AnyNode[]) ?? []) {
          this.expr((a.type === "SpreadElement" ? a.argument : a) as AnyNode, scope, funcId);
        }
        return;
      default:
        return;
    }
  }
}

/**
 * Resolve every name in a validated program and mark the cells.
 *
 * Reserved names are never declared by a program (the validator refuses shadowing one), so a name
 * that resolves to nothing here is a free name and the emitter routes it through the seam.
 */
export function analyze(program: AnyNode): Analysis {
  const w = new Walk();
  const root = new Scope(null, 0);
  w.block(program, root, 0);
  return { bindingOf: w.bindingOf, bindings: w.bindings };
}

/** The free names a program may reference without declaring. Read from the language's own table. */
export const FREE_NAMES: ReadonlySet<string> = RESERVED_NAMES;

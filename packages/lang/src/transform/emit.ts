/**
 * The emitter: one rule per admitted node type, and every rule that carries a law routes it through
 * the seam rather than restating it.
 *
 * The walk order here is the walker's walk order, deliberately and line by line: a journal's step
 * keys are occurrence counters allocated at the call, so two engines agree on a journal only if they
 * agree on the ORDER effects are reached in. Where this file departs from the shape of
 * `interpret.ts` it is because native JavaScript already has the meaning (block scoping, `switch`
 * selection, `try`/`finally` completions) and re-deriving it would be a second implementation to
 * keep in step.
 */

import { BUILTINS, EVENT_CONSTRUCTORS, PRIMITIVES, PURE_PRIMITIVES, VALUE_NAMES } from "../primitives.js";
import { analyze, type Analysis, type AnyNode, type Binding } from "./scope.js";
import { stripPositions } from "../interpret.js";
import { SeamPending, pickNames, type Names } from "./seam.js";

/** Free names that are VALUES as well as callees: the walker declares each as a binding (`installGlobals`). */
const FREE_VALUES: ReadonlySet<string> = new Set([
  ...BUILTINS,
  ...Object.keys(EVENT_CONSTRUCTORS),
  ...Object.keys(PURE_PRIMITIVES),
]);

export interface Emission {
  readonly module: string;
  /** How many times each seam member is reached. A check reports its count, not merely that it ran. */
  readonly sites: Readonly<Record<string, number>>;
  /** Which SURFACED-but-unruled members this emission needed. Empty is the landing condition. */
  readonly proposed: readonly string[];
  readonly names: Names;
}

const q = (s: string): string => JSON.stringify(s);

/** `undefined` is a GLOBAL binding; the emitted module has no unbound references, so it spells the value. */
const VOID = "void 0";

/** Every identifier the source spells, so the emitter's own names can be picked around them. */
function identifiers(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) identifiers(n, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n.type === "Identifier" && typeof n.name === "string") out.add(n.name);
  for (const [k, v] of Object.entries(n)) {
    if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
    identifiers(v, out);
  }
}

class Emitter {
  private readonly sites = new Map<string, number>();
  private readonly proposed = new Set<string>();
  private tempTop = 0;
  private tempMax = 0;
  private labels = 0;
  /** The innermost loop's break and continue labels, and the innermost switch's break label. */
  private breakTo: string | null = null;
  private continueTo: string | null = null;

  constructor(
    private readonly a: Analysis,
    private readonly n: Names,
  ) {}

  // ---- bookkeeping ------------------------------------------------------------------------------

  private seam(member: string, args: string): string {
    this.sites.set(member, (this.sites.get(member) ?? 0) + 1);
    return `${this.n.ctx}.${member}(${args})`;
  }

  /**
   * Reach a member that is SURFACED but not yet ruled. Empty at ruling 1c (`callee` was granted as
   * member 14), and kept because it is the only route into `TransformMeta.proposed`: a member added
   * here shows up as measured debt, where one added straight to {@link seam} is caught instead by
   * the suite's unruled-member check — loudly, but after the fact.
   */
  private propose(member: string, args: string): string {
    this.proposed.add(member);
    return this.seam(member, args);
  }

  private temp(): string {
    const name = `${this.n.temp}${this.tempTop}`;
    this.tempTop += 1;
    if (this.tempTop > this.tempMax) this.tempMax = this.tempTop;
    return name;
  }

  /** A temp's life is its own expression, so a sibling may reuse the slot; a parent's stays live. */
  private scoped<T>(fn: () => T): T {
    const save = this.tempTop;
    const r = fn();
    this.tempTop = save;
    return r;
  }

  private label(kind: "b" | "c"): string {
    this.labels += 1;
    return `${this.n.label}${kind}${this.labels}`;
  }

  // ---- names ------------------------------------------------------------------------------------

  private binding(node: AnyNode): Binding | undefined {
    return this.a.bindingOf.get(node);
  }

  /** Read a name: a native binding, a cell's field, or a free name. */
  private readName(node: AnyNode): string {
    const b = this.binding(node);
    const name = node.name as string;
    if (b !== undefined) return b.cell ? this.seam("get", `${name}, ${q("v")}`) : name;
    if (VALUE_NAMES.includes(name)) return VOID;
    // A builtin is a BINDING in this language, so it has to be readable as a value: `const f = trim`,
    // `map(xs, upper)`, and `json.stringify(x)` (whose callee's object is the free name `json`).
    // Ruling 1a pins the read form as `free(name)` with the arguments OMITTED - the host answers it
    // in the program's convention, so a native call on what comes back is correct.
    if (FREE_VALUES.has(name)) return this.seam("free", q(name));
    // An effect primitive is not a binding the walker ever declares: `const t = turn` is admitted by
    // the validator and answers L2001 at run time (measured at 9dc154f8). The host answers the same
    // way for a name that is not a free builtin, so the reference is emitted as the call that asks.
    if (PRIMITIVES[name] !== undefined) return `(await ${this.seam("free", `${q(name)}, []`)})`;
    throw new Error(`transform: ${name} resolves to nothing, which a validated program cannot contain`);
  }

  // ---- the module -------------------------------------------------------------------------------

  module(program: AnyNode): string {
    const body = this.block(program, true);
    const decls = this.tempMax === 0 ? "" : `let ${Array.from({ length: this.tempMax }, (_, i) => `${this.n.temp}${i}`).join(", ")};\n`;
    return `(${this.n.ctx}) => async () => {\n${decls}${this.fuel()}${body}}\n`;
  }

  private fuel(): string {
    return `await ${this.seam("fuel", "")};\n`;
  }

  // ---- statements -------------------------------------------------------------------------------

  /** A block's statements. `bare` emits them without braces (the program body, a function body). */
  private block(node: AnyNode, bare = false): string {
    const body = ((node.body as AnyNode[]) ?? []).map((s) => this.stmt(s)).join("");
    return bare ? body : `{\n${body}}\n`;
  }

  private stmt(node: AnyNode): string {
    return this.scoped(() => this.statement(node));
  }

  private statement(node: AnyNode): string {
    switch (node.type) {
      case "ExpressionStatement": {
        const e = node.expression as AnyNode;
        // A destructuring assignment as a STATEMENT needs no value, so it emits as statements rather
        // than as the async IIFE the expression form needs.
        if (e.type === "AssignmentExpression" && ((e.left as AnyNode).type === "ObjectPattern" || (e.left as AnyNode).type === "ArrayPattern")) {
          const t = this.temp();
          return `${t} = ${this.expr(e.right as AnyNode)};\n${this.bindPattern(e.left as AnyNode, t, "assign")}`;
        }
        return `${this.expr(e)};\n`;
      }
      case "VariableDeclaration": {
        const kind = node.kind === "let" ? "let" : "const";
        let out = "";
        for (const d of (node.declarations as AnyNode[]) ?? []) {
          const init = d.init === null || d.init === undefined ? VOID : this.expr(d.init as AnyNode);
          out += this.bindPattern(d.id as AnyNode, init, kind);
        }
        return out;
      }
      case "FunctionDeclaration":
        return `${this.fn(node, node.id !== null && node.id !== undefined ? ((node.id as AnyNode).name as string) : null)}\n`;
      case "BlockStatement":
        return this.block(node);
      case "IfStatement": {
        const alt = node.alternate === null || node.alternate === undefined ? "" : ` else ${this.wrap(node.alternate as AnyNode)}`;
        return `if (${this.expr(node.test as AnyNode)}) ${this.wrap(node.consequent as AnyNode)}${alt}\n`;
      }
      case "WhileStatement": {
        const b = this.label("b");
        const c = this.label("c");
        const test = this.expr(node.test as AnyNode);
        const body = this.loopBody(node.body as AnyNode, b, c);
        return `${b}: for (;;) {\n${this.fuel()}if (!(${test})) break ${b};\n${c}: {\n${body}}\n}\n`;
      }
      case "ForStatement":
        return this.forStatement(node);
      case "ForOfStatement":
        return this.forOfStatement(node);
      case "ReturnStatement":
        return `return ${node.argument === null || node.argument === undefined ? VOID : this.expr(node.argument as AnyNode)};\n`;
      case "BreakStatement":
        if (this.breakTo === null) throw new Error("transform: `break` outside a loop or switch");
        return `break ${this.breakTo};\n`;
      case "ContinueStatement":
        if (this.continueTo === null) throw new Error("transform: `continue` outside a loop");
        return `break ${this.continueTo};\n`;
      case "ThrowStatement":
        return `throw ${this.expr(node.argument as AnyNode)};\n`;
      case "TryStatement":
        return this.tryStatement(node);
      case "SwitchStatement":
        return this.switchStatement(node);
      case "EmptyStatement":
        return ";\n";
      default:
        throw new Error(`transform: no rule for statement ${node.type}`);
    }
  }

  /** A statement in a position that must hold exactly one: `if (x) y;` becomes `if (x) { y; }`. */
  private wrap(node: AnyNode): string {
    return node.type === "BlockStatement" ? this.block(node) : `{\n${this.stmt(node)}}`;
  }

  /** A loop body, with `break`/`continue` aimed at this loop's labels. */
  private loopBody(node: AnyNode, breakTo: string, continueTo: string): string {
    const b = this.breakTo;
    const c = this.continueTo;
    this.breakTo = breakTo;
    this.continueTo = continueTo;
    const out = node.type === "BlockStatement" ? this.block(node, true) : this.stmt(node);
    this.breakTo = b;
    this.continueTo = c;
    return out;
  }

  /**
   * `for`, in the shape the specification and the walker both give it.
   *
   * A `for (let ...)` head gives EACH ITERATION its own binding, and the copy happens after the body
   * and before the update — so a closure made in one iteration keeps that iteration's value, and the
   * update applies to the NEXT iteration's binding. Native `for (let ...)` does exactly this, but a
   * cell (see scope.ts) is a record, not a binding, and copying a reference per iteration would let
   * every closure watch the counter move. The carrier form below reproduces the walker's order for
   * both, so one shape covers cells and natives alike.
   */
  private forStatement(node: AnyNode): string {
    const b = this.label("b");
    const c = this.label("c");
    const init = node.init as AnyNode | null;
    const perIteration = init !== null && init !== undefined && init.type === "VariableDeclaration" && init.kind === "let";

    if (!perIteration) {
      let head = "";
      if (init !== null && init !== undefined) head = init.type === "VariableDeclaration" ? this.stmt(init) : `${this.expr(init)};\n`;
      const test = node.test === null || node.test === undefined ? "true" : this.expr(node.test as AnyNode);
      const body = this.loopBody(node.body as AnyNode, b, c);
      const update = node.update === null || node.update === undefined ? "" : `${this.expr(node.update as AnyNode)};\n`;
      return `{\n${head}${b}: for (;;) {\n${this.fuel()}if (!(${test})) break ${b};\n${c}: {\n${body}}\n${update}}\n}\n`;
    }

    // THE CARRIERS ARE ALLOCATED FIRST, before any expression inside the loop is emitted. They are
    // the one place a temporary outlives its own expression — they hold the binding's value ACROSS
    // an iteration — so an expression emitted before them would take their slots and the loop would
    // overwrite its own counter. Measured, before this order: `for (let i = 0; i < 3; i = i + 1)`
    // never terminated and the run died on the step budget.
    const first = this.temp();
    const decls = (init.declarations as AnyNode[]) ?? [];
    const carriers: { readonly carrier: string; readonly id: AnyNode }[] = [];
    for (const d of decls) {
      const id = d.id as AnyNode;
      if (id.type !== "Identifier") throw new Error("transform: a per-iteration `for (let ...)` head takes a name, not a pattern");
      carriers.push({ carrier: this.temp(), id });
    }

    let head = `${first} = true;\n`;
    for (let i = 0; i < decls.length; i += 1) {
      const d = decls[i] as AnyNode;
      head += `${(carriers[i] as { carrier: string }).carrier} = ${d.init === null || d.init === undefined ? VOID : this.expr(d.init as AnyNode)};\n`;
    }
    let open = "";
    let close = "";
    for (const { carrier, id } of carriers) {
      open += this.bindPattern(id, carrier, "let");
      close += `${carrier} = ${this.readName(id)};\n`;
    }
    // The update runs on the NEXT iteration's binding, which is where the specification and the
    // walker both put it: the per-iteration copy happens after the body and before the increment.
    const update = node.update === null || node.update === undefined ? "" : `${this.expr(node.update as AnyNode)};\n`;
    const test = node.test === null || node.test === undefined ? "true" : this.expr(node.test as AnyNode);
    const body = this.loopBody(node.body as AnyNode, b, c);
    return (
      `{\n${head}${b}: for (;;) {\n${open}` +
      `if (!${first}) {\n${update}}\n${first} = false;\n` +
      `${this.fuel()}if (!(${test})) break ${b};\n${c}: {\n${body}}\n${close}}\n}\n`
    );
  }

  private forOfStatement(node: AnyNode): string {
    const b = this.label("b");
    const c = this.label("c");
    const items = this.temp();
    const item = this.temp();
    const right = this.expr(node.right as AnyNode);
    const left = node.left as AnyNode;
    const target = left.type === "VariableDeclaration" ? (((left.declarations as AnyNode[])[0] as AnyNode).id as AnyNode) : left;
    const mode = left.type === "VariableDeclaration" ? (left.kind === "let" ? "let" : "const") : "assign";
    const bind = this.bindPattern(target, item, mode);
    const body = this.loopBody(node.body as AnyNode, b, c);
    return (
      `{\nconst ${items} = ${this.seam("iter", right)};\n${b}: for (const ${item} of ${items}) {\n` +
      `${this.fuel()}${bind}${c}: {\n${body}}\n}\n}\n`
    );
  }

  /**
   * `try`, with JavaScript's own completion semantics (`try { return 1 } finally { return 2 }` is 2)
   * and the catch parameter bound the way the walker binds it.
   *
   * `__ctx.caught` is required at the head of every catch clause and does both halves: it rethrows
   * the six classes no program may catch, and otherwise answers the frozen `{code, kind, message}`
   * record the walker hands a catch. A native binding of the raw host value diverges on the first
   * program that reads `e.code`.
   */
  private tryStatement(node: AnyNode): string {
    let out = `try ${this.block(node.block as AnyNode)}`;
    const handler = node.handler as AnyNode | null;
    if (handler !== null && handler !== undefined) {
      const raw = this.temp();
      const caught = this.seam("caught", raw);
      const param = handler.param as AnyNode | null;
      const bind = param === null || param === undefined ? `${caught};\n` : this.bindPattern(param, caught, "const");
      out += `catch (${raw}) {\n${bind}${this.block(handler.body as AnyNode, true)}}\n`;
    }
    if (node.finalizer !== null && node.finalizer !== undefined) out += `finally ${this.block(node.finalizer as AnyNode)}`;
    return out;
  }

  /**
   * `switch`, native.
   *
   * The walker reproduces JavaScript's selection by hand — tests in source order, `default` skipped
   * during matching and entered only when nothing matched, then fall-through from the selected
   * clause — because a walker has to. Emitting a native `switch` is that same meaning, not an
   * approximation of it, and a hand-rolled two-pass form here would be a second implementation of a
   * rule the engine already has.
   */
  private switchStatement(node: AnyNode): string {
    const b = this.label("b");
    const save = this.breakTo;
    this.breakTo = b;
    const disc = this.expr(node.discriminant as AnyNode);
    let out = `${b}: switch (${disc}) {\n`;
    for (const c of (node.cases as AnyNode[]) ?? []) {
      out += c.test === null || c.test === undefined ? "default:\n" : `case ${this.expr(c.test as AnyNode)}:\n`;
      for (const s of (c.consequent as AnyNode[]) ?? []) out += this.stmt(s);
    }
    this.breakTo = save;
    return `${out}}\n`;
  }

  // ---- bindings ---------------------------------------------------------------------------------

  /**
   * Bind a pattern, declaring (`const`/`let`) or assigning.
   *
   * Native destructuring is NOT used: `const { a } = o` reaches the prototype chain, and the
   * walker's `bindPattern` reads own fields only, through `memberOf`. So every field read goes
   * through `__ctx.get` and every list read through `__ctx.iter`, which is also what keeps L4014 and
   * L4015 where the walker put them.
   */
  private bindPattern(pattern: AnyNode, valueCode: string, mode: "const" | "let" | "assign"): string {
    switch (pattern.type) {
      case "Identifier": {
        const b = this.binding(pattern);
        const name = pattern.name as string;
        if (mode === "assign") {
          return b?.cell === true ? `${this.seam("set", `${name}, ${q("v")}, ${valueCode}`)};\n` : `${name} = ${valueCode};\n`;
        }
        if (b?.cell === true) return `const ${name} = ${this.seam("born", `{ v: ${valueCode} }`)};\n`;
        return `${mode === "let" ? "let" : "const"} ${name} = ${valueCode};\n`;
      }
      case "MemberExpression": {
        // Only in `assign` mode: `[o.a, o.b] = pair`.
        const obj = this.temp();
        const key = this.temp();
        return `${obj} = ${this.expr(pattern.object as AnyNode)};\n${key} = ${this.memberKey(pattern)};\n${this.seam("set", `${obj}, ${key}, ${valueCode}`)};\n`;
      }
      case "AssignmentPattern": {
        const t = this.temp();
        return `${t} = ${valueCode};\n` + this.bindPattern(pattern.left as AnyNode, `(${t} === ${VOID} ? ${this.expr(pattern.right as AnyNode)} : ${t})`, mode);
      }
      case "ObjectPattern": {
        const s = this.temp();
        // The walker refuses a null or undefined subject with L4010 before it reads a field, and an
        // EMPTY pattern refuses too, so the guard is not the first field read. `__ctx.get` raises
        // L4010 on exactly these two values; the text differs (a declared divergence, code parity is
        // the contract).
        let out = `${s} = ${valueCode};\nif (${s} === null || ${s} === ${VOID}) ${this.seam("get", `${s}, ${q("")}`)};\n`;
        const taken: string[] = [];
        for (const p of (pattern.properties as AnyNode[]) ?? []) {
          if (p.type === "RestElement") {
            const rest = this.temp();
            out += `${rest} = { ...${s} };\n`;
            for (const k of taken) out += `delete ${rest}[${k}];\n`;
            out += this.bindPattern(p.argument as AnyNode, this.seam("born", rest), mode);
            continue;
          }
          const key = this.propertyKey(p);
          taken.push(key);
          out += this.bindPattern(p.value as AnyNode, this.seam("get", `${s}, ${key}`), mode);
        }
        return out;
      }
      case "ArrayPattern": {
        const s = this.temp();
        let out = `${s} = ${valueCode};\nif (${s} === null || ${s} === ${VOID}) ${this.seam("get", `${s}, ${q("")}`)};\n`;
        const items = this.temp();
        out += `${items} = ${this.seam("iter", s)};\n`;
        const els = (pattern.elements as (AnyNode | null)[]) ?? [];
        for (let i = 0; i < els.length; i += 1) {
          const el = els[i];
          if (el === null || el === undefined) continue;
          if (el.type === "RestElement") {
            out += this.bindPattern(el.argument as AnyNode, this.seam("born", `${items}.slice(${i})`), mode);
            break;
          }
          out += this.bindPattern(el, `${items}[${i}]`, mode);
        }
        return out;
      }
      default:
        throw new Error(`transform: no rule for binding pattern ${pattern.type}`);
    }
  }

  /** A property key in a pattern or an object literal, as a string expression. */
  private propertyKey(p: AnyNode): string {
    const key = p.key as AnyNode;
    if (p.computed === true) return this.expr(key);
    return key.type === "Identifier" ? q(key.name as string) : q(String(key.value));
  }

  /** A member expression's key: the spelled name, or the computed value the host holds to L4018. */
  private memberKey(node: AnyNode): string {
    if (node.computed !== true) return q((node.property as AnyNode).name as string);
    return this.expr(node.property as AnyNode);
  }

  // ---- functions --------------------------------------------------------------------------------

  /**
   * A function.
   *
   * Parameters arrive as one rest array and are bound in the body, in order, exactly as the walker's
   * `makeFunction` binds them — which is what makes a default, a pattern and a rest parameter one
   * rule rather than three. Nothing observes a function's arity here: a function has no members.
   */
  private fn(node: AnyNode, name: string | null): string {
    const saveTop = this.tempTop;
    const saveMax = this.tempMax;
    const saveBreak = this.breakTo;
    const saveContinue = this.continueTo;
    this.tempTop = 0;
    this.tempMax = 0;
    this.breakTo = null;
    this.continueTo = null;

    const args = `${this.n.temp}a`;
    let binds = "";
    const params = (node.params as AnyNode[]) ?? [];
    for (let i = 0; i < params.length; i += 1) {
      const p = params[i] as AnyNode;
      if (p.type === "RestElement") {
        binds += this.bindPattern(p.argument as AnyNode, this.seam("born", `${args}.slice(${i})`), "let");
        break;
      }
      binds += this.bindPattern(p, `${args}[${i}]`, "let");
    }
    const body = node.body as AnyNode;
    const inner = body.type === "BlockStatement" ? this.block(body, true) : `return ${this.expr(body)};\n`;
    const decls = this.tempMax === 0 ? "" : `let ${Array.from({ length: this.tempMax }, (_, i) => `${this.n.temp}${i}`).join(", ")};\n`;
    const head = name === null ? `async (...${args}) => ` : `async function ${name}(...${args}) `;
    const out = `${head}{\n${decls}${this.fuel()}${binds}${inner}}`;

    this.tempTop = saveTop;
    this.tempMax = saveMax;
    this.breakTo = saveBreak;
    this.continueTo = saveContinue;
    return out;
  }

  // ---- expressions ------------------------------------------------------------------------------

  expr(node: AnyNode): string {
    return this.scoped(() => this.expression(node));
  }

  private expression(node: AnyNode): string {
    switch (node.type) {
      case "Literal":
        return this.literal(node);
      case "Identifier":
        return this.readName(node);
      case "TemplateLiteral": {
        const quasis = (node.quasis as AnyNode[]).map((qu) => q(((qu.value as { cooked: string }).cooked)));
        const exprs = (node.expressions as AnyNode[]).map((e) => this.expr(e));
        return this.seam("template", `[${quasis.join(", ")}], [${exprs.join(", ")}]`);
      }
      case "ArrayExpression": {
        const parts = ((node.elements as (AnyNode | null)[]) ?? []).map((el) => {
          if (el === null || el === undefined) throw new Error("transform: an array hole is not a value this language has");
          return el.type === "SpreadElement" ? `...${this.seam("iter", this.expr(el.argument as AnyNode))}` : this.expr(el);
        });
        return this.seam("born", `[${parts.join(", ")}]`);
      }
      case "ObjectExpression": {
        // Every key is emitted COMPUTED. A literal `__proto__:` key sets a prototype in JavaScript
        // and names an own field in this language; the validator refuses the literal spelling
        // (L1028, measured), and a computed key never reaches the prototype at all, so the emitted
        // form cannot express the hazard whatever the validator does later.
        const parts = ((node.properties as AnyNode[]) ?? []).map((p) =>
          p.type === "SpreadElement" ? `...${this.expr(p.argument as AnyNode)}` : `[${this.propertyKey(p)}]: ${this.expr(p.value as AnyNode)}`,
        );
        return this.seam("born", `{ ${parts.join(", ")} }`);
      }
      case "MemberExpression":
      case "ChainExpression":
      case "CallExpression":
        return this.chain(node);
      case "UnaryExpression": {
        const op = node.operator as string;
        const v = this.expr(node.argument as AnyNode);
        if (op === "!") return `(!${v})`;
        if (op === "typeof") return `(typeof ${v})`;
        const t = this.temp();
        return `((${t} = ${v}), typeof ${t} === "number" ? ${op}${t} : ${this.seam("unary", `${q(op)}, ${t}`)})`;
      }
      case "UpdateExpression":
        return this.update(node);
      case "BinaryExpression": {
        const op = node.operator as string;
        const l = this.expr(node.left as AnyNode);
        // `===`/`!==` are taken before the coercion refusal in the walker, so they are native here.
        if (op === "===" || op === "!==") return `(${l} ${op} ${this.expr(node.right as AnyNode)})`;
        // THE OPERAND TEMPORARIES ARE ALLOCATED BEFORE THE RIGHT SIDE IS EMITTED. A temporary's life
        // is its own expression, so a sibling may reuse the slot — but `a` outlives the right
        // operand's evaluation, and emitting the right side first let it reuse `a`'s slot and
        // overwrite the left value in place. Measured: `(5 + 1) + (3 + 4)` answered 10 for 13.
        const a = this.temp();
        const b = this.temp();
        const r = this.expr(node.right as AnyNode);
        // BOTH operands are assigned before the test. A `&&` between the assignments would
        // short-circuit past the right-hand one, so its effects would vanish and the host leg would
        // refuse a stale value (lane H caught this in the design sketch).
        const native = `${a} ${op} ${b}`;
        const fast = STRING_SAFE.has(op)
          ? `(typeof ${a} === "number" && typeof ${b} === "number") || (typeof ${a} === "string" && typeof ${b} === "string")`
          : `typeof ${a} === "number" && typeof ${b} === "number"`;
        return `((${a} = ${l}), (${b} = ${r}), (${fast}) ? (${native}) : ${this.seam("binary", `${q(op)}, ${a}, ${b}`)})`;
      }
      case "LogicalExpression":
        return `(${this.expr(node.left as AnyNode)} ${node.operator as string} ${this.expr(node.right as AnyNode)})`;
      case "ConditionalExpression":
        return `(${this.expr(node.test as AnyNode)} ? ${this.expr(node.consequent as AnyNode)} : ${this.expr(node.alternate as AnyNode)})`;
      case "AssignmentExpression":
        return this.assign(node);
      case "AwaitExpression":
        return `(await ${this.seam("fuel", "")}, await ${this.seam("await", this.expr(node.argument as AnyNode))})`;
      case "ArrowFunctionExpression":
        return this.fn(node, null);
      case "FunctionExpression": {
        // A named function expression sees its own name. Emitting the name on the expression is what
        // binds it, exactly as the walker declares it into the call's environment.
        const id = node.id as AnyNode | null;
        if (id === null || id === undefined) return this.fn(node, null);
        return `(${this.fnNamedExpression(node, id.name as string)})`;
      }
      default:
        throw new Error(`transform: no rule for expression ${node.type}`);
    }
  }

  private fnNamedExpression(node: AnyNode, name: string): string {
    const decl = this.fn(node, name);
    return decl.replace(/^async function /, "async function ");
  }

  private literal(node: AnyNode): string {
    if ((node as { bigint?: unknown }).bigint !== undefined) throw new Error("transform: a bigint literal is not in this language");
    if ((node as { regex?: unknown }).regex !== undefined) throw new Error("transform: a regular expression literal is not in this language");
    const v = node.value;
    if (typeof v === "string") return q(v);
    if (v === null) return "null";
    return String((node as { raw?: string }).raw ?? String(v));
  }

  /** `x++`, `--o.count`: JavaScript's meaning, with the read charged through `Number` as the walker charges it. */
  /**
   * `x++`'s operand, coerced under seam ruling 1c's `update` selector.
   *
   * The walker reads the old value with a bare `Number(...)` and NO refusal: `o.c++` on a record is
   * NaN there, while `-o.c` on the same record is L4018. Ruling 1c reproduced that and declined to
   * rebuild it — silent coercion is the class the language exists to refuse, so `update` refuses a
   * non-number operand and the walker's answer is a DECLARED divergence (issue 646) with its own
   * cells, not a fidelity target. A number never reaches the host: the fast path keeps every counter
   * native, which is what makes the numeric corpus identical on both arms.
   */
  private toNumber(code: string): string {
    const t = this.temp();
    return `((${t} = ${code}), typeof ${t} === "number" ? ${t} : ${this.seam("unary", `${q("update")}, ${t}`)})`;
  }

  private update(node: AnyNode): string {
    const delta = node.operator === "++" ? "+ 1" : "- 1";
    const prefix = node.prefix === true;
    const arg = node.argument as AnyNode;
    const old = this.temp();
    const next = this.temp();
    if (arg.type === "Identifier") {
      const read = this.readName(arg);
      const write = (value: string): string => {
        const b = this.binding(arg);
        return b?.cell === true ? this.seam("set", `${arg.name as string}, ${q("v")}, ${value}`) : `(${arg.name as string} = ${value})`;
      };
      return `((${old} = ${this.toNumber(read)}), (${next} = ${old} ${delta}), ${write(next)}, ${prefix ? next : old})`;
    }
    const obj = this.temp();
    const key = this.temp();
    return (
      `((${obj} = ${this.expr(arg.object as AnyNode)}), (${key} = ${this.memberKey(arg)}), ` +
      `(${old} = ${this.toNumber(this.seam("get", `${obj}, ${key}`))}), (${next} = ${old} ${delta}), ` +
      `${this.seam("set", `${obj}, ${key}, ${next}`)}, ${prefix ? next : old})`
    );
  }

  private assign(node: AnyNode): string {
    const op = node.operator as string;
    const left = node.left as AnyNode;

    if (left.type === "ObjectPattern" || left.type === "ArrayPattern") {
      // The value of a destructuring assignment is its right-hand side; as an expression it needs a
      // statement body, so it becomes one. As a STATEMENT it never reaches here.
      const t = this.temp();
      return `(await (async () => {\n${t} = ${this.expr(node.right as AnyNode)};\n${this.bindPattern(left, t, "assign")}return ${t};\n})())`;
    }

    if (left.type === "Identifier") {
      const b = this.binding(left);
      const name = left.name as string;
      const write = (value: string): string =>
        b?.cell === true ? this.seam("set", `${name}, ${q("v")}, ${value}`) : `(${name} = ${value})`;
      const t = this.temp();
      // The READ is taken only where the operator needs one. Taking it unconditionally emitted a
      // `get` a plain `=` never uses, and charged the site count for it.
      if (op === "=") return `((${t} = ${this.expr(node.right as AnyNode)}), ${write(t)}, ${t})`;
      if (op === "&&=" || op === "||=" || op === "??=") return this.logicalAssign(op, this.readName(left), write, node.right as AnyNode, t);
      const cur = this.temp();
      return `((${cur} = ${this.readName(left)}), (${t} = ${this.binaryOf(op.slice(0, -1), cur, () => this.expr(node.right as AnyNode))}), ${write(t)}, ${t})`;
    }



    const obj = this.temp();
    const key = this.temp();
    const head = `(${obj} = ${this.expr(left.object as AnyNode)}), (${key} = ${this.memberKey(left)})`;
    const write = (value: string): string => this.seam("set", `${obj}, ${key}, ${value}`);
    const t = this.temp();
    if (op === "=") return `(${head}, (${t} = ${this.expr(node.right as AnyNode)}), ${write(t)}, ${t})`;
    const read = (): string => this.seam("get", `${obj}, ${key}`);
    if (op === "&&=" || op === "||=" || op === "??=") return `(${head}, ${this.logicalAssign(op, read(), write, node.right as AnyNode, t)})`;
    const cur = this.temp();
    return `(${head}, (${cur} = ${read()}), (${t} = ${this.binaryOf(op.slice(0, -1), cur, () => this.expr(node.right as AnyNode))}), ${write(t)}, ${t})`;
  }

  /** `&&=`, `||=`, `??=`: the right side is evaluated, and the write happens, only when it proceeds. */
  private logicalAssign(op: string, read: string, write: (v: string) => string, right: AnyNode, t: string): string {
    const cur = this.temp();
    const guard = op === "&&=" ? `${cur}` : op === "||=" ? `!${cur}` : `${cur} === null || ${cur} === ${VOID}`;
    return `((${cur} = ${read}), (${guard}) ? ((${t} = ${this.expr(right)}), ${write(t)}, ${t}) : ${cur})`;
  }

  /**
   * A binary operation over an already-emitted left operand and a right one this emits.
   *
   * The right side is a thunk for the reason the `BinaryExpression` case gives: `a` has to be
   * allocated before the right operand is emitted, or the right operand reuses `a`'s slot and
   * overwrites the left value between the assignment and the test.
   */
  private binaryOf(op: string, leftCode: string, right: () => string): string {
    if (op === "===" || op === "!==") return `(${leftCode} ${op} ${right()})`;
    const a = this.temp();
    const b = this.temp();
    const rightCode = right();
    const fast = STRING_SAFE.has(op)
      ? `(typeof ${a} === "number" && typeof ${b} === "number") || (typeof ${a} === "string" && typeof ${b} === "string")`
      : `typeof ${a} === "number" && typeof ${b} === "number"`;
    return `((${a} = ${leftCode}), (${b} = ${rightCode}), (${fast}) ? (${a} ${op} ${b}) : ${this.seam("binary", `${q(op)}, ${a}, ${b}`)})`;
  }

  // ---- chains, calls ----------------------------------------------------------------------------

  /**
   * A member chain, with `?.` short-circuiting the WHOLE chain and nothing after it evaluated.
   *
   * Each optional link stores its object in a temp inside the guard, so the value is computed once:
   * the guards run in order, and the body reads the last temp rather than re-deriving the links.
   */
  private chain(node: AnyNode): string {
    const guards: string[] = [];
    const body = this.chainLink(node.type === "ChainExpression" ? (node.expression as AnyNode) : node, guards, true);
    if (guards.length === 0) return body;
    return `((${guards.join(") || (")}) ? ${VOID} : ${body})`;
  }

  /**
   * One link of an optional chain. `tail` is true for the OUTERMOST link, the one whose value is the
   * chain's value.
   *
   * It exists for the optional CALL. `o.m?.()` short-circuits on whether the member is nullish, and
   * the seam resolves a method name and calls it in one step — the one place a method name may be
   * resolved at all — so the transform cannot see the answer and the host makes it, through ruling
   * 1d's optional flag. What the host cannot then tell the transform is WHETHER it short-circuited,
   * and the chain needs that as soon as anything follows: measured on the walker, `o.z?.().x` on an
   * absent member is undefined while `o.m?.().x` on a member that returns undefined is L4010. A
   * guard on the returned value would answer undefined for both. So a tail optional call is emitted
   * and one with a continuation refuses, loudly and listed.
   */
  private chainLink(node: AnyNode, guards: string[], tail = false): string {
    if (node.type === "MemberExpression") {
      let obj = this.chainLink(node.object as AnyNode, guards);
      if (node.optional === true) obj = this.guard(obj, guards);
      return this.seam("get", `${obj}, ${this.memberKey(node)}`);
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as AnyNode;
      const args = this.args(node);

      if (callee.type === "Identifier" && this.binding(callee) === undefined) {
        const name = callee.name as string;
        // A primitive is dispatched by NAME, never by value: the validator forbids shadowing one, so
        // a call spelled `turn` is always the effect.
        if (PRIMITIVES[name] !== undefined) return `(await ${this.seam("effect", `${q(name)}, [${args}], ${this.site(name, node)}`)})`;
        if (FREE_VALUES.has(name)) return `(await ${this.seam("free", `${q(name)}, [${args}]`)})`;
      }

      if (callee.type === "MemberExpression") {
        let obj = this.chainLink(callee.object as AnyNode, guards);
        if (callee.optional === true) obj = this.guard(obj, guards);
        if (node.optional === true && !tail) {
          throw new SeamPending("an optional call with a chain after it (`o.m?.().x`)", "CallExpression");
        }
        // The one place a method NAME may be resolved: at the call. That is what lets `get` refuse
        // the same name everywhere else (L4020). Ruling 1d's fourth argument asks the host to
        // short-circuit to undefined when the member is nullish, calling nothing.
        const optional = node.optional === true ? ", true" : "";
        return `(await ${this.seam("call", `${obj}, ${this.memberKey(callee)}, [${args}]${optional}`)})`;
      }

      let fn = this.chainLink(callee, guards);
      if (node.optional === true) fn = this.guard(fn, guards);
      const f = this.temp();
      // L4011 at a non-function callee, behind a `typeof` so a call to a real function never leaves
      // the compartment. `const f = 1; f()` is admitted by the validator (measured).
      return `(await ((${f} = ${fn}), typeof ${f} === "function" ? ${f} : ${this.seam("callee", f)})(${args}))`;
    }
    return this.expr(node);
  }

  private guard(code: string, guards: string[]): string {
    const t = this.temp();
    guards.push(`(${t} = ${code}) === null || ${t} === ${VOID}`);
    return t;
  }

  private args(node: AnyNode): string {
    return ((node.arguments as AnyNode[]) ?? [])
      .map((a) => (a.type === "SpreadElement" ? `...${this.seam("iter", this.expr(a.argument as AnyNode))}` : this.expr(a)))
      .join(", ");
  }

  /**
   * The static per-call-site payload an effect carries.
   *
   * Only `race` needs one today: its journal entry holds a `branchDigest` over the LOSING arms'
   * source, which the walker computes from the AST at run time. The engine has no AST then, so
   * without this the two journals cannot be byte-identical for any race that settled.
   */
  /**
   * The static payload a call site carries, because the engine has no AST at run time.
   *
   * A settled `race` journals a `branchDigest` over the arms it will never walk into, and that
   * digest is a function of the SOURCE. The walker computes it from the object literal in hand;
   * the engine has to be handed the same material, so the branch bodies travel here with their
   * positions stripped by `interpret.ts`'s OWN function — imported, never copied, because a second
   * implementation of "what the code IS" is a second answer to whether a resumed run diverged.
   *
   * WHAT TRAVELS IS THE STRIPPED BODY, NOT A PER-BRANCH DIGEST. The walker hashes one array of
   * `[loserName, body]` pairs over the loser set, which is only known at run time; per-branch
   * digests would make the host hash a hash and produce a different byte string for a journal entry
   * that has to be identical. Only losers are ever digested, but which branches lose is the run's
   * answer, so every branch travels.
   */
  private site(name: string, node: AnyNode): string {
    if (name !== "race") return "{}";
    const branches = ((node.arguments as AnyNode[]) ?? [])[0];
    if (branches === undefined || branches.type !== "ObjectExpression") return "{}";
    const bodies: Record<string, unknown> = {};
    for (const p of (branches.properties as AnyNode[] | undefined) ?? []) {
      const key = p.key as AnyNode | undefined;
      const named = (key?.name as string | undefined) ?? (key?.value as string | undefined);
      if (named !== undefined) bodies[named] = stripPositions(p.value);
    }
    return `{ branchDigests: ${JSON.stringify(bodies)} }`;
  }

  result(): Pick<Emission, "sites" | "proposed"> {
    return { sites: Object.fromEntries([...this.sites].sort()), proposed: [...this.proposed].sort() };
  }
}

/** Operators whose native meaning is the walker's for two strings as well as two numbers. */
const STRING_SAFE: ReadonlySet<string> = new Set(["+", "<", "<=", ">", ">="]);

export function emit(program: AnyNode): Emission {
  const ids = new Set<string>();
  identifiers(program, ids);
  const names = pickNames(ids);
  const e = new Emitter(analyze(program), names);
  const module = e.module(program);
  return { module, names, ...e.result() };
}

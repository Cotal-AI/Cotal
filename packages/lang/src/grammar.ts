/**
 * The validator: one acorn parse followed by two AST walks, before anything executes.
 *
 * This file is where the design's central claim becomes mechanical rather than aspirational. A
 * program that could reach ambient IO, an ambient clock, host identity, or hidden concurrency
 * does not parse, so "determinism by convention" is not an option an author can take. Every rule
 * in section 3 of the design doc maps to a check here and to a stable error code.
 *
 * Walk 1 is SHAPE: reject forbidden node types. Walk 2 is RESOLUTION: build the scope tree, bind
 * every identifier, and check effect call shape. Both collect every error before reporting, so an
 * author sees the whole repair list at once instead of one item per round trip.
 */

import { parse, type Options } from "acorn";
import type { Node } from "acorn";
import { LangError, LangErrors, type LangErrorCode, type SourceSpan } from "./errors.js";
import {
  BUILTINS,
  FORBIDDEN_GLOBALS,
  HOST_GLOBAL_HINTS,
  NOTIFY_BOUND,
  PRIMITIVES,
  PROMISE_NAMES,
  RESERVED_NAMES,
  STEP_NAME_RE,
  primitiveDoc,
} from "./primitives.js";
import { KEY_RESERVED_RE } from "./keys.js";
import { ADMITTED_NODES, FORBIDDEN_NODES, STRUCTURAL_NODES } from "./syntax.js";
import { MUTATING_METHODS } from "./library.js";

/** Acorn nodes are loosely typed; this is the shape we actually read. */
type AnyNode = Node & Record<string, unknown>;

const ACORN_OPTIONS: Options = {
  ecmaVersion: 2023,
  sourceType: "module",
  locations: true,
  // A program's module body IS the workflow, so top-level `await` is the normal way to write
  // one. Only an await inside a non-async nested function is an error, and walk 1 catches that.
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: false,
};

export interface ValidateResult {
  readonly ast: AnyNode;
  readonly warnings: readonly LangError[];
}

class Validator {
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

// ---- walk 1: shape ------------------------------------------------------------------------

/** The two conditional refusals the table cannot carry: a LABELLED jump and an `await` outside async. */
const LABELLED_JUMP = Object.freeze({
  code: "L1017" as LangErrorCode,
  cause: "A labelled break or continue is an arbitrary jump.",
  fix: "Restructure with a helper function or a boolean flag.",
});
const AWAIT_OUTSIDE_ASYNC = Object.freeze({
  code: "L1023" as LangErrorCode,
  cause: "This `await` sits inside a function that is not `async`. Every effect is awaited, so a function that performs one is async.",
  fix: "Mark the enclosing function `async`: `async function name(...) { ... }`.",
});

/**
 * Automatic semicolon insertion is ALLOWED, against Jessie, and this is a declared deviation.
 *
 * Jessie bans ASI reliance because a newline hazard can silently change what a program means. Two
 * things break that argument here: the author is a language model writing the JavaScript it would
 * write anyway, which is frequently semicolon-free, and ASI is parse-deterministic, so
 * determinism by construction is untouched either way. Banning it also rejected constructs nobody
 * intended, including every `for` loop and the design's own examples.
 *
 * What survives is the part with a live rationale: the two constructs where a newline genuinely
 * changes meaning stay errors, so the hazard is caught without taxing the ordinary program.
 */
function checkAsiHazards(block: AnyNode, v: Validator): void {
  const body = (block.body as AnyNode[]) ?? [];
  for (let i = 0; i < body.length - 1; i += 1) {
    const here = body[i] as AnyNode;
    const next = body[i + 1] as AnyNode;
    if (here.type !== "ReturnStatement") continue;
    if (here.argument !== null && here.argument !== undefined) continue;
    if (next.type !== "ExpressionStatement") continue;
    v.fail(
      "L1008",
      next,
      "This value follows a bare `return`, so the statement already ended on the line above and this expression is unreachable. The newline decided that, not the code.",
      "Put the value on the same line as `return`, or terminate the return with `;` if it was meant to return nothing.",
    );
  }
}

/**
 * The continuation hazard, checked where it actually lives.
 *
 * A line beginning with `(` or `[` continues the statement above it rather than starting a new
 * one, and by the time there are two statements to compare the parser has already made that
 * choice: it produced ONE. So the check is on the call itself, looking for a newline between a
 * callee and the `(` that a semicolon would have separated.
 */
function checkContinuationHazard(node: AnyNode, v: Validator): void {
  const inner = node.type === "CallExpression" ? node.callee : node.object;
  if (!isNode(inner)) return;
  const gap = v.source.slice(inner.end as number, node.end as number);
  const openAt = gap.indexOf(node.type === "CallExpression" ? "(" : "[");
  if (openAt < 0) return;
  if (!gap.slice(0, openAt).includes("\n")) return;
  v.fail(
    "L1008",
    node,
    node.type === "CallExpression"
      ? "The `(` on this line continues the expression above it, so this is one call rather than two statements. A semicolon is what decides that, and there is not one."
      : "The `[` on this line indexes the expression above it, so this is one expression rather than two statements. A semicolon is what decides that, and there is not one.",
    "Terminate the previous statement with `;`.",
  );
}

/**
 * Acorn's own parse errors, re-coded. The default is "this is not valid JavaScript", which is
 * true but useless; these are the mistakes worth naming precisely, because every effect in this
 * language is awaited and so this is the mistake an author will actually make.
 */
const PARSE_ERROR_MAP: readonly {
  readonly test: RegExp;
  readonly code: LangErrorCode;
  readonly cause: string;
  readonly fix: string;
}[] = [
  {
    test: /'return' outside of function/i,
    code: "L1024",
    cause:
      "A program has no return value. Its outcome is what it did: the journal of its effects, and whatever it published onto the run record. There is nobody for a top-level `return` to return to.",
    fix: "Publish the result onto the run record, or use `log(...)` if you only wanted it in the trace.",
  },
  {
    // A program is a module, so it is strict, and acorn refuses `with` before any walk sees it.
    test: /'with' in strict mode/i,
    code: "L1013",
    cause: "`with` makes name resolution dynamic, and every name here resolves at parse time.",
    fix: "Reference the record's fields directly.",
  },
  {
    test: /keyword 'await' outside an async function|await is only valid in async/i,
    code: "L1023",
    cause:
      "This `await` sits inside a function that is not `async`. Every effect is awaited, so a function that performs one is async. A program's top level is already async and needs no marking.",
    fix: "Mark the enclosing function `async`: `async function name(...) { ... }`.",
  },
];

/** Child keys to descend into, per node, without pulling in a walker dependency. */
function children(node: AnyNode): AnyNode[] {
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

function isNode(v: unknown): v is AnyNode {
  return v !== null && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

/** True when a statement always leaves its `switch` case: a terminator, or a block/if made of them. */
function terminates(stmt: AnyNode): boolean {
  switch (stmt.type) {
    case "ReturnStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "ThrowStatement":
      return true;
    case "BlockStatement": {
      const body = (stmt.body as AnyNode[]) ?? [];
      const last = body[body.length - 1];
      return last !== undefined && terminates(last);
    }
    case "IfStatement":
      return (
        isNode(stmt.consequent) &&
        terminates(stmt.consequent as AnyNode) &&
        isNode(stmt.alternate) &&
        terminates(stmt.alternate as AnyNode)
      );
    default:
      return false;
  }
}

/** The static name of a member access: `x.a` and `x["a"]` both name `a`; `x[k]` names nothing. */
function memberName(member: AnyNode): string | null {
  const property = member.property as AnyNode | undefined;
  if (property === undefined) return null;
  if (member.computed !== true) return property.type === "Identifier" ? (property.name as string) : null;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : null;
}

/** The name of a non-computed property key, or null when it is computed. */
function propertyKeyName(node: AnyNode): string | null {
  if (node.computed === true) return null;
  const key = node.key as AnyNode | undefined;
  if (key === undefined) return null;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal") return String(key.value);
  return null;
}

function walkShape(
  node: AnyNode,
  v: Validator,
  inAsync: boolean,
  parent: AnyNode | null = null,
  /** An ancestor already carried a forbidden row, so this node's own presence needs no second error. */
  underForbidden = false,
): void {
  const type = node.type;

  // Labels and labelled jumps: a bare break/continue is fine, a labelled one is not.
  if ((type === "BreakStatement" || type === "ContinueStatement") && node.label !== null && node.label !== undefined) {
    v.fail(LABELLED_JUMP.code, node, LABELLED_JUMP.cause, LABELLED_JUMP.fix);
    return;
  }

  // `await` is legal only inside an async function.
  if (type === "AwaitExpression" && !inAsync) {
    v.fail(AWAIT_OUTSIDE_ASYNC.code, node, AWAIT_OUTSIDE_ASYNC.cause, AWAIT_OUTSIDE_ASYNC.fix);
  }

  // THE TABLE. A node is admitted, structural, on a forbidden row, or outside the language.
  const rule = FORBIDDEN_NODES[type];
  let forbidden = underForbidden;
  if (rule !== undefined) {
    v.fail(rule.code, node, rule.cause, rule.fix);
    forbidden = true;
  } else if (!ADMITTED_NODES.has(type) && !STRUCTURAL_NODES.has(type) && !underForbidden) {
    v.fail(
      "L1029",
      node,
      `\`${type}\` is valid JavaScript but is not in this language, which is a fixed subset of it.`,
      "Rewrite with the constructs the language has: functions, records, arrays, loops, conditionals, try/catch, and the effect primitives.",
    );
    forbidden = true;
  }

  if (type === "Program" || type === "BlockStatement") checkAsiHazards(node, v);
  if (type === "CallExpression" || (type === "MemberExpression" && node.computed === true)) {
    checkContinuationHazard(node, v);
  }
  if (type === "CallExpression") {
    v.parents.set(node, parent);
    checkAsyncCallPosition(node, parent, v);
  }

  switch (type) {
    case "VariableDeclaration":
      if (node.kind === "var") {
        v.fail(
          "L1003",
          node,
          "`var` is function-scoped and hoists, so a name can be read before the line that gives it a value.",
          "Use `const`, or `let` when the binding is reassigned.",
        );
      }
      break;

    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      if (node.generator === true) {
        v.fail(
          "L1005",
          node,
          "Generators suspend and resume outside the effect journal, so a resumed run could not reproduce them.",
          "Use a loop, and `await` the effects inside it.",
        );
      }
      break;

    case "Literal":
      if (node.regex !== undefined) {
        v.fail(
          "L1007",
          node,
          "There are no regular expressions, so a program cannot spend unbounded time in a match.",
          "Use `contains`, `startsWith`, `endsWith`, or `split`.",
        );
      }
      break;

    case "IfStatement": {
      for (const branch of ["consequent", "alternate"]) {
        const b = node[branch];
        if (isNode(b) && b.type !== "BlockStatement" && b.type !== "IfStatement") {
          v.fail(
            "L1009",
            b,
            "Every branch body is a block, so inserting a second statement can never silently fall outside the branch.",
            "Wrap the body in braces.",
          );
        }
      }
      break;
    }

    case "ForStatement":
    case "ForOfStatement":
    case "WhileStatement": {
      const body = node.body;
      if (isNode(body) && body.type !== "BlockStatement") {
        v.fail("L1009", body, "Every loop body is a block.", "Wrap the body in braces.");
      }
      break;
    }

    case "SwitchCase": {
      const consequent = node.consequent;
      if (Array.isArray(consequent) && consequent.length > 0) {
        const last = consequent[consequent.length - 1];
        // The check looks THROUGH a braced case body: the language asks for blocks everywhere
        // else, so `case 1: { ...; break; }` is the shape it invites, and refusing it read as a
        // rule against the block rather than against the fall-through.
        if (isNode(last) && !terminates(last)) {
          v.fail(
            "L1010",
            node,
            "A case that falls through to the next one is nearly always a missing `break`.",
            "End the case with `return`, `break`, `continue`, or `throw`.",
          );
        }
      }
      break;
    }

    case "Property":
      if (node.computed === true) {
        v.fail(
          "L1011",
          node,
          "A computed key means the record's shape is not visible in the source, so neither the validator nor the flowchart can read it.",
          "Use a literal key, or build the record with `merge`, or write it as `record[key] = value`.",
        );
      }
      if (parent?.type === "ObjectExpression" && propertyKeyName(node) === "__proto__") {
        v.fail(
          "L1028",
          node,
          "`__proto__` names an object's prototype, and there are no prototypes here: a record has exactly the fields written on it.",
          "Choose another field name.",
        );
      }
      if (node.kind === "get" || node.kind === "set") {
        v.fail(
          "L1015",
          node,
          "An accessor runs code when a property is read, which hides an effect behind what looks like data.",
          "Store the value, or call a function explicitly.",
        );
      }
      break;

    case "ArrayExpression":
      if (Array.isArray(node.elements) && node.elements.some((e) => e === null)) {
        v.fail(
          "L1012",
          node,
          "An elided slot is neither absent nor a value, and it does not survive canonicalization.",
          "Write the value explicitly, or use `null`.",
        );
      }
      break;

    case "BinaryExpression":
      if (node.operator === "==" || node.operator === "!=") {
        v.fail(
          "L1025",
          node,
          `\`${node.operator as string}\` coerces its operands before comparing them, so \`0 == ""\` and \`null == undefined\` are true and a comparison's answer depends on rules nobody wrote down here.`,
          `Use \`${node.operator === "==" ? "===" : "!=="}\`, and \`?? \` or \`=== null\` when the question is about a missing value.`,
        );
      }
      if (node.operator === "instanceof") {
        v.fail(
          "L1016",
          node,
          "There are no classes or prototypes, so `instanceof` can only probe host objects.",
          "Compare a field instead, for example `value.status === \"done\"`.",
        );
      }
      if (node.operator === "in") {
        v.fail(
          "L1004",
          node,
          "The `in` operator reaches inherited names.",
          "Use `has(record, key)`.",
        );
      }
      break;

    case "UnaryExpression":
      if (node.operator === "void") {
        v.fail(
          "L1027",
          node,
          "`void` evaluates an expression and discards it, which is only ever used to hide a value or to spell `undefined` obscurely.",
          "Write `undefined` when you mean it, or drop the expression.",
        );
      }
      if (node.operator === "delete") {
        v.fail(
          "L1021",
          node,
          "Records that cross an effect boundary are frozen, and deleting from a live one makes its shape depend on control flow.",
          "Build a new record with the fields you want.",
        );
      }
      break;

    default:
      break;
  }

  const nowAsync =
    type === "FunctionDeclaration" || type === "FunctionExpression" || type === "ArrowFunctionExpression"
      ? node.async === true
      : inAsync;

  for (const child of children(node)) walkShape(child, v, nowAsync, node, forbidden);
}

// ---- walk 2: resolution and effect call shape --------------------------------------------

class Scope {
  readonly names = new Map<string, "const" | "let" | "param">();
  /** The function node a name is bound to HERE, when it is bound to one at all. */
  private readonly fns = new Map<string, AnyNode>();
  constructor(readonly parent: Scope | null) {}

  declare(name: string, kind: "const" | "let" | "param", fn?: AnyNode): void {
    this.names.set(name, kind);
    if (fn !== undefined) this.fns.set(name, fn);
    else this.fns.delete(name);
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

/** Collect the identifiers a binding pattern introduces. */
function patternNames(node: AnyNode, out: string[]): void {
  switch (node.type) {
    case "Identifier":
      out.push(node.name as string);
      break;
    case "ObjectPattern":
      for (const p of node.properties as AnyNode[]) {
        if (p.type === "RestElement") patternNames(p.argument as AnyNode, out);
        else patternNames(p.value as AnyNode, out);
      }
      break;
    case "ArrayPattern":
      for (const el of node.elements as (AnyNode | null)[]) if (el !== null) patternNames(el, out);
      break;
    case "AssignmentPattern":
      patternNames(node.left as AnyNode, out);
      break;
    case "RestElement":
      patternNames(node.argument as AnyNode, out);
      break;
    default:
      break;
  }
}

/**
 * `notify`'s fact is a bounded decision record, not a message.
 *
 * This is the one place a program can push its own bytes toward another agent's context, so the
 * bound is what keeps "conversation is the data plane, the program is the control plane" true at
 * the one boundary where it is easiest to break. A literal fact is checked exactly; a computed
 * one is checked at the effect boundary by the same rules.
 */
/**
 * `to` addresses the escalated mint and nothing else, so accepting it elsewhere records an input
 * that decides nothing, which the hash table then has to classify for no reason.
 */
function checkEscalateTo(bag: AnyNode | undefined, v: Validator): void {
  if (bag === undefined || bag.type !== "ObjectExpression") return;
  const prop = (want: string): AnyNode | undefined =>
    ((bag.properties as AnyNode[]) ?? []).find((p) => {
      const k = p.key as AnyNode | undefined;
      return k !== undefined && (k.type === "Identifier" ? k.name === want : k.value === want);
    });
  const to = prop("to");
  if (to === undefined) return;
  const onExpiry = prop("onExpiry");
  const value = onExpiry?.value as AnyNode | undefined;
  if (value?.type === "Literal" && value.value === "escalate") return;
  v.fail(
    "L3044",
    to,
    "`to` only addresses an escalated checkpoint, and this one does not escalate.",
    'Set `onExpiry: "escalate"`, or drop `to`.',
    "checkpoint",
  );
}

function checkNotifyFact(fact: AnyNode | undefined, v: Validator): void {
  if (fact === undefined || fact.type !== "ObjectExpression") return; // computed: checked at run time

  const seen = new Map<string, AnyNode>();
  for (const p of (fact.properties as AnyNode[]) ?? []) {
    if (p.type !== "Property") continue;
    const key = p.key as AnyNode;
    const keyName =
      key.type === "Identifier"
        ? (key.name as string)
        : key.type === "Literal" && typeof key.value === "string"
          ? key.value
          : null;
    if (keyName !== null) seen.set(keyName, p);
  }

  for (const [key, prop] of seen) {
    if (key !== "decision" && key !== "outcome" && key !== "detail") {
      v.fail(
        "L3043",
        prop,
        `A notify fact carries \`decision\`, \`outcome\`, and an optional \`detail\`, and nothing else. \`${key}\` would be an unbounded channel from the program into another agent's context.`,
        "Move the information into `detail` as a short scalar, or leave it for the agent to read from the channel.",
        "notify",
      );
    }
  }

  for (const field of ["decision", "outcome"] as const) {
    const prop = seen.get(field);
    if (prop === undefined) {
      v.fail(
        "L3043",
        fact,
        `A notify fact needs a \`${field}\`.`,
        'Name the decision and its outcome as tokens: { decision: "build", outcome: "blocked" }',
        "notify",
      );
      continue;
    }
    const value = prop.value as AnyNode;
    if (value.type !== "Literal" || typeof value.value !== "string") continue; // computed
    if (!NOTIFY_BOUND.tokenRe.test(value.value)) {
      v.fail(
        "L3043",
        value,
        `\`${field}\` names a decision, so it is a token rather than prose. "${value.value}" is not one.`,
        'Use kebab-case, 1 to 64 characters: { decision: "approve-plan", outcome: "auto-proceeded" }',
        "notify",
      );
    }
  }

  const detail = seen.get("detail");
  if (detail === undefined) return;
  const value = detail.value as AnyNode;
  if (value.type !== "ObjectExpression") {
    v.fail(
      "L3043",
      value,
      "`detail` is a record of short scalars.",
      "Use `{ attempts: 3 }` rather than a value of another shape.",
      "notify",
    );
    return;
  }

  const props = (value.properties as AnyNode[]) ?? [];
  if (props.length > NOTIFY_BOUND.maxDetailKeys) {
    v.fail(
      "L3043",
      value,
      `\`detail\` carries at most ${NOTIFY_BOUND.maxDetailKeys} keys; this one has ${props.length}. The cap is what keeps a notice a decision rather than a message.`,
      "Keep the fields that name the decision and drop the rest.",
      "notify",
    );
  }

  for (const p of props) {
    if (p.type !== "Property") continue;
    const key = p.key as AnyNode;
    const keyName =
      key.type === "Identifier"
        ? (key.name as string)
        : key.type === "Literal" && typeof key.value === "string"
          ? key.value
          : null;
    if (keyName !== null && !NOTIFY_BOUND.detailKeyRe.test(keyName)) {
      v.fail(
        "L3043",
        key,
        `\`${keyName}\` is not a detail key; they are kebab-case tokens of at most 32 characters.`,
        "Rename it, for example `attempt-count`.",
        "notify",
      );
    }
    const dv = p.value as AnyNode;
    if (dv.type === "ObjectExpression" || dv.type === "ArrayExpression") {
      v.fail(
        "L3043",
        dv,
        "Detail values are scalars: a short string, a number, or a boolean. A nested structure is an unbounded pipe into another agent's context.",
        "Flatten it, or leave it for the agent to read from the channel.",
        "notify",
      );
    } else if (
      dv.type === "Literal" &&
      typeof dv.value === "string" &&
      dv.value.length > NOTIFY_BOUND.maxDetailStringLength
    ) {
      v.fail(
        "L3043",
        dv,
        `A detail string is at most ${NOTIFY_BOUND.maxDetailStringLength} characters; this one is ${dv.value.length}. Longer than that is prose, and prose belongs in the channel where the agent can answer it.`,
        "Shorten it to a label, or put the content on the run record.",
        "notify",
      );
    }
  }
}

/** True when every element of an array literal is a record literal with a string `id`. */
function arrayItemsCarryId(items: AnyNode): boolean {
  const els = (items.elements as (AnyNode | null)[]) ?? [];
  if (els.length === 0) return false;
  return els.every((el) => {
    if (el === null || el === undefined || el.type !== "ObjectExpression") return false;
    return ((el.properties as AnyNode[]) ?? []).some((p) => {
      if (p.type !== "Property") return false;
      const key = p.key as AnyNode;
      const name = key.type === "Identifier" ? (key.name as string) : key.value;
      const value = p.value as AnyNode;
      return name === "id" && value.type === "Literal" && typeof value.value === "string";
    });
  });
}

/**
 * L2013: an async call must be immediately awaited, immediately returned, or be the thunk a
 * combinator owns.
 *
 * Banning `Promise` is not enough, because calling an async function is itself a way to start
 * work. `const pa = work(a); const pb = work(b);` reads as two concurrent chains and never
 * mentions a combinator. The defect is not the race a reviewer predicted: executed, those calls
 * run strictly sequentially because the walker awaits every call site. It is the mirror image,
 * and for an author who is a language model it is worse. The program says "concurrently" and the
 * runtime silently runs them one after the other, and nothing says so.
 */
function checkAsyncCallPosition(node: AnyNode, parent: AnyNode | null, v: Validator): void {
  const callee = node.callee;
  if (!isNode(callee) || callee.type !== "Identifier") return;
  const name = callee.name as string;
  // Primitives are always effects and are checked here, where the position is known. A user
  // function is an effect only if it was declared async, which only the resolution walk can see:
  // {@link checkCall} applies the same rule to those, reading the position back from `v.parents`.
  if (PRIMITIVES[name] === undefined) return;
  if (parent === null || asyncCallPositionOk(parent)) return;
  v.fail("L2013", node, unawaitedCause(name), unawaitedFix(name), name);
}

/**
 * Only two positions are legal for a call that starts an effect: awaited, or the concise body of
 * an arrow that a combinator owns as a thunk (a `return` is the braced spelling of the same thing).
 * Everything else, including a bare statement, starts work nothing waits for.
 */
function asyncCallPositionOk(parent: AnyNode): boolean {
  return (
    parent.type === "AwaitExpression" ||
    parent.type === "ArrowFunctionExpression" ||
    parent.type === "ReturnStatement"
  );
}

const unawaitedCause = (name: string): string =>
  `This \`${name}\` is not awaited, so it starts work whose result nothing waits for. Read literally the program says one thing and the runtime does another: calls outside a combinator run in sequence, not concurrently.`;
const unawaitedFix = (name: string): string =>
  `Await it (\`await ${name}(...)\`), return it, or make it a branch of \`parallel\`, \`race\` or \`fanOut\`.`;

function checkCall(node: AnyNode, v: Validator, scope: Scope): void {
  const callee = node.callee;
  if (!isNode(callee) || callee.type !== "Identifier") return;
  const name = callee.name as string;
  const spec = PRIMITIVES[name];
  if (spec === undefined) {
    // L2013's other half: a USER function declared `async` (or a const bound to an async function
    // expression) is an effect the moment it is called, and holding its call in a binding is the
    // rule's own motivating example: `const pa = work(a); const pb = work(b);`.
    const fn = scope.lookupFn(name);
    const parent = v.parents.get(node) ?? null;
    if (fn !== undefined && fn.async === true && parent !== null && !asyncCallPositionOk(parent)) {
      v.fail("L2013", node, unawaitedCause(name), unawaitedFix(name));
    }
    return;
  }

  const args = (node.arguments as AnyNode[]) ?? [];

  // `checkpoint` takes its name positionally; every other primitive takes it in the option bag.
  if (name === "checkpoint") {
    const first = args[0];
    if (first === undefined || first.type !== "Literal" || typeof first.value !== "string") {
      v.fail(
        "L3013",
        first ?? node,
        "A checkpoint's name must be a string literal, because the flowchart, the linter, and the migration report all read it without running the program.",
        'Pass a literal: checkpoint("approve-plan", "Approve the plan?", { timeout: "10m" })',
        name,
      );
    } else if (!STEP_NAME_RE.test(first.value)) {
      v.fail(
        "L3014",
        first,
        `"${first.value}" is not a well-formed step name.`,
        "Use kebab-case, 1 to 64 characters: \"approve-plan\".",
        name,
      );
    }
  }

  // The option bag sits at a FIXED index per primitive. It is deliberately not "the last record
  // argument": `notify(agents, fact, opts)` and `checkpoint(name, prompt, opts)` both take a
  // record in an earlier position, and reading that as options would reject correct data.
  const bag = args[spec.optionsAt];
  const bagIsRecord = bag !== undefined && bag.type === "ObjectExpression";

  const given = new Map<string, AnyNode>();
  if (bagIsRecord) {
    for (const p of (bag.properties as AnyNode[]) ?? []) {
      if (p.type !== "Property") continue;
      const key = p.key as AnyNode;
      if (key.type === "Identifier") given.set(key.name as string, p);
      else if (key.type === "Literal" && typeof key.value === "string") given.set(key.value, p);
    }
  }

  // Closed bags: an unknown key answers with the full signature rather than being ignored.
  for (const [key, prop] of given) {
    if (!spec.options.includes(key)) {
      v.fail(
        "L3011",
        prop,
        `\`${name}\` has no option named \`${key}\`, and option bags are closed so a typo cannot be silently dropped.`,
        `Accepted keys: ${spec.options.join(", ")}.`,
        name,
      );
    }
  }

  // Step names: REQUIRED-ness and VALIDITY are separate questions and must not share one gate.
  //
  // Required-ness is a statement about the caller's obligation; validity is a statement about the
  // sink. `nameRequired` is false for 7 of the 13 primitives, so behind one gate a name supplied on
  // any of those reaches `stepKeyString` unchecked: the optional path, which is the one nobody
  // writes tests for, feeds the same durable journal key as the required one. A name containing the
  // characters the key grammar reserves forges structure: two different programs then print one
  // identical key, and with matching inputs the collision is entirely silent.
  if (name !== "checkpoint") {
    const prop = given.get("name");
    if (prop === undefined) {
      if (spec.nameRequired) {
        v.fail(
          "L3012",
          node,
          `Every \`${name}\` needs a name, because its journal entry is keyed by that name rather than by its position. Without one, a resumed run cannot tell this step from any other.`,
          `Add a kebab-case name literal: ${name}(..., { name: "..." })`,
          name,
        );
      }
    } else {
      const value = prop.value as AnyNode;
      const isLiteral = value.type === "Literal" && typeof value.value === "string";
      // L3013 stays gated on `nameRequired`. Widening it to every present name refused
      // `fanOut([...], async (lens) => sleep("1m", { name: lens }))` — naming a branch's step after
      // its item, which is idiomatic and is how a fan-out gets distinct keys at all. That is the
      // cost this restriction would have had, and it is too high for what it buys: the SHAPE check
      // below is what closes the forgery, and it does not need the name to be static.
      if (!isLiteral) {
        if (spec.nameRequired) {
          v.fail(
            "L3013",
            value,
            "A step name must be a string literal, because the flowchart, the linter, and the migration report all read it without running the program.",
            'Use a literal: { name: "build" }',
            name,
          );
        }
        // A COMPUTED name cannot be checked here at all, and it reaches the same journal key. The
        // refusal for that one lives at key construction, where the value exists — see keys.ts.
      } else if (!STEP_NAME_RE.test(value.value as string)) {
        v.fail(
          "L3014",
          value,
          `"${value.value}" is not a well-formed step name.`,
          'Use kebab-case, 1 to 64 characters: { name: "build" }',
          name,
        );
      }
    }
  }

  if (name === "notify") checkNotifyFact(args[1], v);
  if (name === "checkpoint") checkEscalateTo(bag, v);

  // fanOut needs a stable branch key, or items that carry one. Warn only when the source SHOWS
  // there are no ids: items carrying a string `id` supply the key by design, so warning on those
  // would flag correct code, and a computed list cannot be judged from here at all. The runtime
  // refuses the genuinely unkeyable case, which is where an unknown list gets decided.
  if (name === "fanOut" && !given.has("key")) {
    const items = args[0];
    if (items !== undefined && items.type === "ArrayExpression" && !arrayItemsCarryId(items)) {
      v.warn(
        "L3021",
        node,
        "These items carry no `id`, so this fan-out has no stable branch key, and a reordered or filtered list would silently reshuffle every journal key underneath it.",
        'Pass a key function: fanOut(items, fn, { name: "reviews", key: (i) => i.id })',
        name,
      );
    }
  }

  // Array-form concurrency branches are keyed by index (design doc 7.2). Legal, linted.
  if ((name === "parallel" || name === "race") && args.length > 0) {
    const branches = args[0];
    if (branches !== undefined && branches.type === "ArrayExpression") {
      v.warn(
        "L3023",
        branches,
        "Array branches are keyed by index, so inserting a branch shifts every later branch's journal namespace and re-runs its steps.",
        `Use the record form: ${name}({ lint: () => ..., tests: () => ... }, { name: "checks" })`,
        name,
      );
    }
  }

  // A record-form branch KEY becomes a path segment verbatim: `frameString` builds
  // `/kind:name#occ/b:${branch}` by concatenation and escapes nothing. So a key containing one of
  // the three characters the key grammar reserves forges structure — a single branch named
  // `a/parallel:inner#0/b:b` prints the identical key to a genuinely nested `a` → `inner` → `b`,
  // and the journal cannot tell the two locations apart. With different inputs that surfaces as a
  // spurious L5001 divergence for a program that never diverged; with matching inputs it is
  // SILENT, one durable row serving both, and a replay hands the second location the first's
  // recorded effect.
  //
  // Only the reserved characters are rejected, NOT the full step-name pattern: branch keys are
  // ordinary object keys and `{ runTests: ... }` is legitimate, so requiring kebab-case here would
  // refuse correct programs to fix a forgery that needs `/`, `#` or `:`. The restriction is the
  // narrowest one that closes it.
  if (name === "parallel" || name === "race" || name === "fanOut") {
    const branches = args[0];
    if (branches !== undefined && branches.type === "ObjectExpression") {
      for (const prop of (branches.properties as AnyNode[]) ?? []) {
        const key = prop.key as AnyNode | undefined;
        if (key === undefined) continue;
        const text =
          key.type === "Identifier" ? (key.name as string)
          : key.type === "Literal" && typeof key.value === "string" ? key.value
          : undefined;
        if (text === undefined || !KEY_RESERVED_RE.test(text)) continue;
        v.fail(
          "L3025",
          key,
          `The branch key "${text}" contains a character the step-key grammar reserves (\`/\`, \`#\` or \`:\`). Branch keys are written into the journal key verbatim, so this one can spell a path that a genuinely nested scope also produces — and two different locations that share a key share a durable row, silently when their inputs match.`,
          "Use a branch key without `/`, `#` or `:`.",
          name,
        );
      }
    }
  }

  // L2032: a branch that WRITES a binding declared outside it.
  //
  // Freeze-on-share does not see this one, because nothing crosses an effect boundary: the branches
  // set a scalar in the enclosing scope. And the damage is silent. Live, the branches write in
  // COMPLETION order; on resume the journalled effects return instantly, so they write in LAUNCH
  // order, the binding ends up holding a different value, and the resumed run takes a path it never
  // recorded — with no divergence raised, because no effect's inputs changed.
  //
  // `conclave` is deliberately not here. Its body is a single thunk with nothing to race, so a
  // write from inside it is as ordered as a write anywhere else in the program.
  if (name === "parallel" || name === "race" || name === "fanOut") {
    // One `seen` set per combinator call: two branches calling the same helper is one defect in
    // that helper, not two, and reporting it twice tells an author to fix one line twice.
    const seen = new Set<AnyNode>();
    const thunks = name === "fanOut" ? branchThunks(args[1], v, scope) : branchThunks(args[0], v, scope);
    for (const thunk of thunks) checkCapturedWrites(thunk, name, v, seen);
  }
}

function isFunctionNode(node: AnyNode): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/**
 * Index every function the program names, so L2032 can follow a branch that is not written at the
 * combinator call. Ambiguous names (two functions, one name) index as `null` and resolve to
 * nothing — an unproven branch is left to the interpreter's runtime check rather than guessed at.
 */
function indexFunctions(node: AnyNode, v: Validator): void {
  const put = (name: string, fn: AnyNode): void => {
    const prior = v.functions.get(name);
    v.functions.set(name, prior === undefined || prior === fn ? fn : null);
  };
  if (node.type === "FunctionDeclaration" && isNode(node.id)) {
    put((node.id as AnyNode).name as string, node);
  }
  if (node.type === "VariableDeclarator" && isNode(node.id) && (node.id as AnyNode).type === "Identifier") {
    const init = node.init;
    if (isNode(init) && isFunctionNode(init as AnyNode)) put((node.id as AnyNode).name as string, init as AnyNode);
  }
  for (const c of children(node)) indexFunctions(c, v);
}

/**
 * Resolve a branch to the function it names, or to nothing.
 *
 * A NAMED branch resolves through its lexical binding at the combinator call, never through the
 * program-wide name map: `async function use(branch) { await parallel({ branch }) }` passes its own
 * parameter, and resolving that name to a same-named top-level declaration made a clean program
 * unwriteable — L2032 blamed a write in a function the program never even called. A name bound to
 * something that is not a function is UNPROVEN, and unproven is the interpreter's depth check to
 * refuse at runtime, not the validator's to guess at.
 */
function resolveFunction(node: AnyNode, v: Validator, scope: Scope): AnyNode | undefined {
  if (isFunctionNode(node)) return node;
  if (node.type !== "Identifier") return undefined;
  const name = node.name as string;
  // Bound here: the binding answers, whatever it is bound to. Unbound: walk 2 has already raised
  // L2001 for it, so the module index is the fallback.
  if (scope.lookup(name) !== undefined) return scope.lookupFn(name);
  return v.functions.get(name) ?? undefined;
}

/**
 * The thunks a combinator owns, in every form the language accepts.
 *
 * `parallel({ a: () => …, b })` mixes an inline branch and a NAMED one, and a first version of this
 * dropped the named half — so a captured-write program written with two named
 * `async function`s instead of two arrows, was accepted. A branch is a branch however it is
 * spelled.
 */
function branchThunks(node: AnyNode | undefined, v: Validator, scope: Scope): AnyNode[] {
  if (node === undefined) return [];
  const one = resolveFunction(node, v, scope);
  if (one !== undefined) return [one];
  const out: AnyNode[] = [];
  if (node.type === "ObjectExpression") {
    for (const p of (node.properties as AnyNode[]) ?? []) {
      if (p.type !== "Property" || !isNode(p.value)) continue;
      const fn = resolveFunction(p.value as AnyNode, v, scope);
      if (fn !== undefined) out.push(fn);
    }
  }
  if (node.type === "ArrayExpression") {
    for (const el of (node.elements as (AnyNode | null)[]) ?? []) {
      if (el === null || !isNode(el)) continue;
      const fn = resolveFunction(el, v, scope);
      if (fn !== undefined) out.push(fn);
    }
  }
  return out;
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
  v.fail(
    "L2032",
    at,
    `\`${name}\` is declared outside this branch and written inside it. Two branches racing to write one place is nondeterministic, and freezing does not cover it because nothing crosses an effect boundary. It is also silent: live, the branches write in completion order, but on resume the recorded effects return instantly and they write in launch order, so \`${name}\` holds a different value and the run takes a path it never recorded — with no divergence raised, because no effect's inputs changed.`,
    `Return the value from the branch and read it out of \`${combinator}\`'s result, or use \`race\`, which yields its winner.`,
    combinator,
  );
}

/** Walk one branch thunk with its OWN scope chain: anything it did not declare, it captured. */
function checkCapturedWrites(fn: AnyNode, combinator: string, v: Validator, seen: Set<AnyNode>): void {
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
      const root = rootIdentifier(target);
      if (root !== undefined && scope.lookup(root.name as string) === undefined) {
        capturedWrite(root, root.name as string, combinator, v);
      }
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
          MUTATING_METHODS.has(method) &&
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

function walkResolve(node: AnyNode, v: Validator, scope: Scope): void {
  switch (node.type) {
    case "Identifier": {
      const name = node.name as string;
      if (scope.lookup(name) !== undefined) return;
      if (RESERVED_NAMES.has(name)) return;
      if (PROMISE_NAMES.has(name)) {
        v.fail(
          "L2011",
          node,
          "Promises are not in the language, so concurrency is always visible in the source and therefore in the journal and the flowchart.",
          "Use `parallel`, `race`, or `fanOut`.",
        );
        return;
      }
      if (FORBIDDEN_GLOBALS.has(name)) {
        v.fail(
          "L2012",
          node,
          `\`${name}\` is a host global. There is no ambient IO, clock, or randomness here: the interpreter has nothing nondeterministic to offer.`,
          HOST_GLOBAL_HINTS[name] ??
            "Use `now()` for time, `random()` for randomness, `sleep()` to wait, and `log()` for output.",
        );
        return;
      }
      v.fail(
        "L2001",
        node,
        `\`${name}\` is not defined anywhere in this program. Every name resolves when the program is read, so this is never a runtime surprise.`,
        `Define it, or check the spelling. The builtins are: ${BUILTINS.join(", ")}.`,
      );
      return;
    }

    case "VariableDeclaration": {
      const kind = node.kind === "const" ? "const" : "let";
      for (const d of (node.declarations as AnyNode[]) ?? []) {
        const init = d.init;
        if (isNode(init)) walkResolve(init, v, scope);
        const names: string[] = [];
        patternNames(d.id as AnyNode, names);
        // `const b = async () => {...}` binds a FUNCTION, and a branch named `b` must resolve to
        // it. Only the plain `id = function` form does: a destructured name holds whatever the
        // pattern pulled out, which is not statically a function.
        const bound =
          isNode(d.id) && (d.id as AnyNode).type === "Identifier" && isNode(init) && isFunctionNode(init as AnyNode)
            ? (init as AnyNode)
            : undefined;
        for (const n of names) {
          if (RESERVED_NAMES.has(n)) {
            v.fail(
              "L2002",
              d.id as AnyNode,
              `\`${n}\` is a builtin, so shadowing it would make a call to \`${n}\` mean two different things in one program.`,
              `Rename the binding, for example \`${n}Result\`.`,
            );
          }
          scope.declare(n, kind, bound);
        }
      }
      return;
    }

    case "AssignmentExpression": {
      const left = node.left as AnyNode;
      if (left.type === "Identifier" && scope.lookup(left.name as string) === "const") {
        v.fail(
          "L2003",
          left,
          `\`${left.name as string}\` is declared \`const\`.`,
          "Declare it with `let` if it is meant to be reassigned.",
        );
      }
      for (const c of children(node)) walkResolve(c, v, scope);
      return;
    }

    case "MemberExpression": {
      // Only the object side is a name; a non-computed property is a field, not a binding.
      const object = node.object;
      if (isNode(object)) walkResolve(object, v, scope);
      if (node.computed === true && isNode(node.property)) walkResolve(node.property as AnyNode, v, scope);
      return;
    }

    case "Property": {
      // Shorthand `{ x }` reads `x`; a non-computed key is a field name, not a binding.
      if (node.computed === true && isNode(node.key)) walkResolve(node.key as AnyNode, v, scope);
      if (isNode(node.value)) walkResolve(node.value as AnyNode, v, scope);
      return;
    }

    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      if (node.type === "FunctionDeclaration" && isNode(node.id)) {
        const fname = (node.id as AnyNode).name as string;
        if (RESERVED_NAMES.has(fname)) {
          v.fail(
            "L2002",
            node.id as AnyNode,
            `\`${fname}\` is a builtin, so a function of that name would shadow it.`,
            "Rename the function.",
          );
        }
        scope.declare(fname, "const", node);
      }
      const inner = new Scope(scope);
      for (const p of (node.params as AnyNode[]) ?? []) {
        const names: string[] = [];
        patternNames(p, names);
        for (const n of names) {
          if (RESERVED_NAMES.has(n)) {
            v.fail(
              "L2002",
              p,
              `\`${n}\` is a builtin, so a parameter of that name would shadow it inside this function.`,
              "Rename the parameter.",
            );
          }
          inner.declare(n, "param");
        }
        // Default values are evaluated in the inner scope.
        if (p.type === "AssignmentPattern" && isNode(p.right)) walkResolve(p.right as AnyNode, v, inner);
      }
      if (isNode(node.body)) walkResolve(node.body as AnyNode, v, inner);
      return;
    }

    case "BlockStatement": {
      const inner = new Scope(scope);
      hoistFunctions(node, inner);
      for (const s of (node.body as AnyNode[]) ?? []) walkResolve(s, v, inner);
      return;
    }

    case "CatchClause": {
      const inner = new Scope(scope);
      if (isNode(node.param)) {
        const names: string[] = [];
        patternNames(node.param as AnyNode, names);
        for (const n of names) inner.declare(n, "const");
      }
      if (isNode(node.body)) walkResolve(node.body as AnyNode, v, inner);
      return;
    }

    case "ForStatement":
    case "ForOfStatement": {
      const inner = new Scope(scope);
      for (const c of children(node)) walkResolve(c, v, inner);
      return;
    }

    case "CallExpression": {
      checkCall(node, v, scope);
      for (const c of children(node)) walkResolve(c, v, scope);
      return;
    }

    default: {
      for (const c of children(node)) walkResolve(c, v, scope);
      return;
    }
  }
}

/** Function declarations are visible to the whole block, so bind them before walking it. */
function hoistFunctions(block: AnyNode, scope: Scope): void {
  for (const s of (block.body as AnyNode[]) ?? []) {
    if (s.type === "FunctionDeclaration" && isNode(s.id)) {
      scope.declare((s.id as AnyNode).name as string, "const", s);
    }
  }
}

// ---- entry point ---------------------------------------------------------------------------

/**
 * Parse and validate a program. Throws {@link LangErrors} carrying every problem found, so an
 * author repairs the whole list in one pass. Returns the AST plus the lints that did not fail
 * the program.
 */
export function validate(source: string, file = "program.cotal.js"): ValidateResult {
  const v = new Validator(source, file);

  let ast: AnyNode;
  try {
    ast = parse(source, ACORN_OPTIONS) as unknown as AnyNode;
  } catch (e) {
    const err = e as { message?: string; loc?: { line: number; column: number } };
    const span: SourceSpan = {
      file,
      line: err.loc?.line ?? 1,
      column: (err.loc?.column ?? 0) + 1,
    };
    const message = err.message ?? "could not be parsed";
    const mapped = PARSE_ERROR_MAP.find((m) => m.test.test(message));
    throw new LangErrors(
      [
        new LangError(
          mapped !== undefined
            ? { code: mapped.code, span, cause: mapped.cause, fix: mapped.fix }
            : {
                code: "L1008",
                span,
                cause: `This program is not valid JavaScript, so none of the language rules could be checked: ${message}.`,
                fix: "Fix the syntax at the marked position. Statements terminate explicitly here; there is no automatic semicolon insertion.",
              },
        ),
      ],
      source,
    );
  }

  // The module body is an async context: a program's top level is where the workflow lives.
  walkShape(ast, v, true);

  indexFunctions(ast, v);

  const top = new Scope(null);
  hoistFunctions(ast, top);
  for (const s of (ast.body as AnyNode[]) ?? []) walkResolve(s, v, top);

  if (v.errors.length > 0) throw new LangErrors(v.errors, source);
  return { ast, warnings: v.warnings };
}

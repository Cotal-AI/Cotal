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
  NOTIFY_BOUND,
  PRIMITIVES,
  PROMISE_NAMES,
  RESERVED_NAMES,
  STEP_NAME_RE,
  primitiveDoc,
} from "./primitives.js";

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

/** Node types rejected outright, with the code and the repair to suggest. */
const FORBIDDEN_NODES: Readonly<
  Record<string, { code: LangErrorCode; cause: string; fix: string }>
> = Object.freeze({
  ClassDeclaration: {
    code: "L1001",
    cause: "There are no classes in this language. State lives in records and behaviour lives in functions.",
    fix: "Replace the class with a function that returns a record.",
  },
  ClassExpression: {
    code: "L1001",
    cause: "There are no classes in this language. State lives in records and behaviour lives in functions.",
    fix: "Replace the class with a function that returns a record.",
  },
  ThisExpression: {
    code: "L1002",
    cause: "`this` does not exist, so nothing can capture a calling context by accident.",
    fix: "Pass what the function needs as an argument.",
  },
  ForInStatement: {
    code: "L1004",
    cause: "`for...in` walks an unspecified order and reaches inherited names, so it cannot be deterministic.",
    fix: "Iterate explicitly: `for (const k of keys(record)) { ... }`.",
  },
  WithStatement: {
    code: "L1013",
    cause: "`with` makes name resolution dynamic, and every name here resolves at parse time.",
    fix: "Reference the record's fields directly.",
  },
  TaggedTemplateExpression: {
    code: "L1018",
    cause: "A tagged template runs user code during evaluation of a literal, which hides an effect inside what looks like data.",
    fix: "Use a plain template literal, or call the function explicitly.",
  },
  NewExpression: {
    code: "L1019",
    cause: "There are no constructors, so `new` has nothing to construct.",
    fix: "Build a record literal, or call a function that returns one.",
  },
  ImportDeclaration: {
    code: "L1020",
    cause: "A program is exactly one module, because a run pins to the content hash of its source.",
    fix: "Define the function in this file. Shared procedures are ordinary functions.",
  },
  ExportNamedDeclaration: {
    code: "L1020",
    cause: "A program is exactly one module and has nothing to export to.",
    fix: "Remove the `export`.",
  },
  ExportDefaultDeclaration: {
    code: "L1020",
    cause: "A program is exactly one module and has nothing to export to.",
    fix: "Remove the `export`.",
  },
  ExportAllDeclaration: {
    code: "L1020",
    cause: "A program is exactly one module and has nothing to export to.",
    fix: "Remove the `export`.",
  },
  DoWhileStatement: {
    code: "L1022",
    cause: "`do...while` is not in the language.",
    fix: "Use `while` with the condition checked first, or a `for` loop.",
  },
  LabeledStatement: {
    code: "L1017",
    cause: "Labels turn the derived flowchart's back-edges into arbitrary jumps.",
    fix: "Restructure with a helper function or a boolean flag.",
  },
  BreakStatement: {
    code: "L1017",
    cause: "A labelled break is an arbitrary jump.",
    fix: "Restructure with a helper function or a boolean flag.",
  },
  ContinueStatement: {
    code: "L1017",
    cause: "A labelled continue is an arbitrary jump.",
    fix: "Restructure with a helper function or a boolean flag.",
  },
  AwaitExpression: {
    code: "L1023",
    cause: "This `await` sits inside a function that is not `async`. Every effect is awaited, so a function that performs one is async.",
    fix: "Mark the enclosing function `async`: `async function name(...) { ... }`.",
  },
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

function walkShape(node: AnyNode, v: Validator, inAsync: boolean): void {
  const type = node.type;

  // Labels and labelled jumps: a bare break/continue is fine, a labelled one is not.
  if (type === "BreakStatement" || type === "ContinueStatement") {
    if (node.label !== null && node.label !== undefined) {
      const r = FORBIDDEN_NODES[type];
      if (r !== undefined) v.fail(r.code, node, r.cause, r.fix);
    }
    return;
  }

  // `await` is legal only inside an async function.
  if (type === "AwaitExpression" && !inAsync) {
    const r = FORBIDDEN_NODES.AwaitExpression;
    if (r !== undefined) v.fail(r.code, node, r.cause, r.fix);
  }

  const rule = type === "AwaitExpression" ? undefined : FORBIDDEN_NODES[type];
  if (rule !== undefined) {
    v.fail(rule.code, node, rule.cause, rule.fix);
  }

  if (type === "Program" || type === "BlockStatement") checkAsiHazards(node, v);
  if (type === "CallExpression" || (type === "MemberExpression" && node.computed === true)) {
    checkContinuationHazard(node, v);
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
        const terminators = ["ReturnStatement", "BreakStatement", "ContinueStatement", "ThrowStatement"];
        if (isNode(last) && !terminators.includes(last.type)) {
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
          "Use a literal key, or build the record with `merge`.",
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

  for (const child of children(node)) walkShape(child, v, nowAsync);
}

// ---- walk 2: resolution and effect call shape --------------------------------------------

class Scope {
  readonly names = new Map<string, "const" | "let" | "param">();
  constructor(readonly parent: Scope | null) {}

  declare(name: string, kind: "const" | "let" | "param"): void {
    this.names.set(name, kind);
  }

  lookup(name: string): "const" | "let" | "param" | undefined {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      const k = s.names.get(name);
      if (k !== undefined) return k;
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

function checkCall(node: AnyNode, v: Validator): void {
  const callee = node.callee;
  if (!isNode(callee) || callee.type !== "Identifier") return;
  const name = callee.name as string;
  const spec = PRIMITIVES[name];
  if (spec === undefined) return;

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

  // Required step names.
  if (spec.nameRequired && name !== "checkpoint") {
    const prop = given.get("name");
    if (prop === undefined) {
      v.fail(
        "L3012",
        node,
        `Every \`${name}\` needs a name, because its journal entry is keyed by that name rather than by its position. Without one, a resumed run cannot tell this step from any other.`,
        `Add a kebab-case name literal: ${name}(..., { name: "..." })`,
        name,
      );
    } else {
      const value = prop.value as AnyNode;
      if (value.type !== "Literal" || typeof value.value !== "string") {
        v.fail(
          "L3013",
          value,
          "A step name must be a string literal, because the flowchart, the linter, and the migration report all read it without running the program.",
          'Use a literal: { name: "build" }',
          name,
        );
      } else if (!STEP_NAME_RE.test(value.value)) {
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
        for (const n of names) {
          if (RESERVED_NAMES.has(n)) {
            v.fail(
              "L2002",
              d.id as AnyNode,
              `\`${n}\` is a builtin, so shadowing it would make a call to \`${n}\` mean two different things in one program.`,
              `Rename the binding, for example \`${n}Result\`.`,
            );
          }
          scope.declare(n, kind);
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
        scope.declare(fname, "const");
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
      checkCall(node, v);
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
      scope.declare((s.id as AnyNode).name as string, "const");
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

  const top = new Scope(null);
  hoistFunctions(ast, top);
  for (const s of (ast.body as AnyNode[]) ?? []) walkResolve(s, v, top);

  if (v.errors.length > 0) throw new LangErrors(v.errors, source);
  return { ast, warnings: v.warnings };
}

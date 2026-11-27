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
import { LangError, LangErrors, type LangErrorCode, type SourceSpan } from "./errors.js";
import {
  PRIMITIVES,
} from "./primitives.js";
import { ADMITTED_NODES, FORBIDDEN_NODES, STRUCTURAL_NODES } from "./syntax.js";
import {
  type AnyNode,
  asyncCallPositionOk,
  children,
  hoistBindings,
  hoistFunctions,
  isFunctionNode,
  isNode,
  propertyKeyName,
  Scope,
  unawaitedCause,
  unawaitedFix,
  Validator,
} from "./grammar-shared.js";
import {
  walkResolve,
} from "./grammar-resolve.js";

// The validator's own lookup sets. The package exports these tables as frozen arrays and never
// these sets, so code that imports the package cannot change what `validate` admits.
const ADMITTED = new Set(ADMITTED_NODES);
const STRUCTURAL = new Set(STRUCTURAL_NODES);
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
  } else if (!ADMITTED.has(type) && !STRUCTURAL.has(type) && !underForbidden) {
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
      if (node.bigint !== undefined || typeof node.value === "bigint") {
        v.fail(
          "L1030",
          node,
          "Numbers here are IEEE doubles with a canonical JSON form; a bigint has neither, so it could not be journalled or cross an effect boundary.",
          "Use a number, or a string for an identifier that exceeds 2^53.",
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
    const { loc } = err;
    const span: SourceSpan = {
      file,
      line: loc?.line ?? 1,
      column: (loc?.column ?? 0) + 1,
    };
    const message = err.message ?? "could not be parsed";
    const mapped = PARSE_ERROR_MAP.find((m) => m.test.test(message));
    // Acorn appends its zero-based column to the message. The span already gives the position.
    const suffix = loc === undefined ? undefined : ` (${loc.line}:${loc.column})`;
    const reason = suffix !== undefined && message.endsWith(suffix) ? message.slice(0, -suffix.length) : message;
    throw new LangErrors(
      [
        new LangError(
          mapped !== undefined
            ? { code: mapped.code, span, cause: mapped.cause, fix: mapped.fix }
            : {
                code: "L1008",
                span,
                cause: `This program is not valid JavaScript, so none of the language rules could be checked: ${reason}.`,
                fix: "Fix the syntax at the marked position.",
              },
        ),
      ],
      source,
    );
  }

  // Comments and whitespace parse as an empty body. That is not a program: a run of it completes
  // with no steps, which is the same outcome as an empty file. A lone `;` is an empty statement
  // and stays a statement.
  const body = (ast.body as AnyNode[]) ?? [];
  if (body.length === 0) {
    throw new LangErrors(
      [
        new LangError({
          code: "L1031",
          span: { file, line: 1, column: 1 },
          cause: "This program has no statements. Comments and whitespace do not start a run.",
          fix: "Write the program into this file.",
        }),
      ],
      source,
    );
  }

  // The module body is an async context: a program's top level is where the workflow lives.
  walkShape(ast, v, true);

  indexFunctions(ast, v);

  const top = new Scope(null);
  hoistFunctions(ast, top);
  hoistBindings(ast, top);
  for (const s of (ast.body as AnyNode[]) ?? []) walkResolve(s, v, top);

  if (v.errors.length > 0) throw new LangErrors(v.errors, source);
  return { ast, warnings: v.warnings };
}

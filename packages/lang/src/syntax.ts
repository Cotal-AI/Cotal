/**
 * The syntax table: every node type acorn can produce, sorted into the sets the language is made of.
 *
 * ONE TABLE, READ BY BOTH HALVES. The validator admits exactly {@link ADMITTED_NODES} and
 * {@link STRUCTURAL_NODES}, refuses each row of {@link FORBIDDEN_NODES} with its own code, and refuses
 * everything else with L1029. The interpreter executes exactly the admitted set. `surface.smoke`
 * holds the two halves to this file: every admitted node type is executed by a program, every
 * `case` label in the interpreter's node switches is on this table, and every node type acorn knows
 * lands in exactly one set. Before this table existed the two halves were two hand-kept lists, and
 * `x++`, `?.`, rest parameters and `**` were admitted by one and refused by the other.
 */

import type { LangErrorCode } from "./errors.js";

/** Node types the interpreter executes. A validated program is made of these and nothing else. */
export const ADMITTED_NODES: ReadonlySet<string> = new Set([
  // statements
  "Program",
  "ExpressionStatement",
  "VariableDeclaration",
  "FunctionDeclaration",
  "BlockStatement",
  "IfStatement",
  "WhileStatement",
  "ForStatement",
  "ForOfStatement",
  "ReturnStatement",
  "BreakStatement",
  "ContinueStatement",
  "ThrowStatement",
  "TryStatement",
  "SwitchStatement",
  "EmptyStatement",
  // expressions
  "Literal",
  "Identifier",
  "TemplateLiteral",
  "ArrayExpression",
  "ObjectExpression",
  "MemberExpression",
  "ChainExpression",
  "UnaryExpression",
  "UpdateExpression",
  "BinaryExpression",
  "LogicalExpression",
  "ConditionalExpression",
  "AssignmentExpression",
  "AwaitExpression",
  "ArrowFunctionExpression",
  "FunctionExpression",
  "CallExpression",
]);

/**
 * Node types that only occur INSIDE an admitted node and are executed as part of it: a `Property`
 * inside an object literal, a `SwitchCase` inside a `switch`, a pattern inside a declaration.
 */
export const STRUCTURAL_NODES: ReadonlySet<string> = new Set([
  "VariableDeclarator",
  "Property",
  "SpreadElement",
  "RestElement",
  "AssignmentPattern",
  "ObjectPattern",
  "ArrayPattern",
  "TemplateElement",
  "SwitchCase",
  "CatchClause",
]);

/** Node types rejected outright, with the code and the repair to suggest. */
export const FORBIDDEN_NODES: Readonly<
  Record<string, { readonly code: LangErrorCode; readonly cause: string; readonly fix: string }>
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
  YieldExpression: {
    code: "L1005",
    cause: "Generators suspend and resume outside the effect journal, so a resumed run could not reproduce them.",
    fix: "Use a loop, and `await` the effects inside it.",
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
  ImportExpression: {
    code: "L1020",
    cause: "A program is exactly one module, because a run pins to the content hash of its source; a dynamic `import()` would load code the hash does not cover.",
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
  SequenceExpression: {
    code: "L1026",
    cause: "The comma operator evaluates several expressions and keeps only the last, which hides work inside one expression.",
    fix: "Write one statement per expression.",
  },
  MetaProperty: {
    code: "L1020",
    cause: "`import.meta` and `new.target` describe a module system and constructors, and this language has neither.",
    fix: "Use `run()` for this run's own metadata.",
  },
  DebuggerStatement: {
    code: "L1029",
    cause: "`debugger` addresses a host debugger, and there is no host to address.",
    fix: "Use `log(...)` to trace a value.",
  },
});

/** Node types that occur only inside a forbidden node and are reported through their parent's row. */
export const FORBIDDEN_CHILDREN: readonly string[] = Object.freeze([
  "ClassBody",
  "MethodDefinition",
  "PropertyDefinition",
  "StaticBlock",
  "PrivateIdentifier",
  "Super",
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
  "ExportSpecifier",
]);

/**
 * Every node type acorn 8 emits for `ecmaVersion: 2023, sourceType: "module"`, whether or not it
 * is in the language. `surface.smoke` asserts each one lands in exactly one of the sets above, so a
 * node type acorn adds or one this file forgets is a red suite rather than a runtime surprise.
 */
export const KNOWN_NODES: readonly string[] = Object.freeze([
  ...ADMITTED_NODES,
  ...STRUCTURAL_NODES,
  ...Object.keys(FORBIDDEN_NODES),
  ...FORBIDDEN_CHILDREN,
]);

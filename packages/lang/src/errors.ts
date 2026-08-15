/**
 * The error catalog. Errors are the primary UI of this language: their audience is an LLM
 * repairing its own program, so every error whose cause is a call to a primitive carries that
 * primitive's full signature and one working example, and the blame frame is always in
 * user-program coordinates.
 *
 * Codes are stable and grouped: L1xxx grammar, L2xxx name resolution and static rules, L3xxx
 * effect call shape, L4xxx runtime semantics, L5xxx durability, L6xxx simulation.
 */

/** Every code in the catalog, with the one-line title that heads the rendered error. */
export const CATALOG = {
  // ---- L1xxx: grammar -----------------------------------------------------------------------
  L1001: "Forbidden syntax: `class`",
  L1002: "Forbidden syntax: `this`",
  L1003: "Forbidden syntax: `var`",
  L1004: "Forbidden syntax: `for...in`",
  L1005: "Forbidden syntax: generator",
  L1006: "Forbidden syntax: `eval` or `Function`",
  L1007: "Forbidden syntax: regular expression literal",
  // ASI itself is ALLOWED. The error is the two constructs where a newline changes what the code
  // MEANS: a value on the line after a bare `return`, and a line opening with `(` or `[` that
  // continues the statement above it. "Missing semicolon" named a rule this language does not have.
  L1008: "Newline hazard",
  L1009: "Unbraced branch",
  L1010: "`switch` case does not terminate",
  L1011: "Computed property name",
  L1012: "Array elision",
  L1013: "Forbidden syntax: `with`",
  L1014: "Forbidden syntax: symbol",
  L1015: "Forbidden syntax: accessor",
  L1016: "Forbidden syntax: `instanceof`",
  L1017: "Forbidden syntax: label",
  L1018: "Forbidden syntax: tagged template literal",
  L1019: "Forbidden syntax: `new`",
  L1020: "Forbidden syntax: `import` or `export`",
  L1021: "Forbidden syntax: `delete`",
  L1022: "Forbidden syntax: `do...while`",
  L1023: "Forbidden syntax: `await` outside an async function",
  L1024: "`return` outside a function",

  // ---- L2xxx: name resolution and static rules ----------------------------------------------
  L2001: "Unknown identifier",
  L2002: "Shadows a builtin or a primitive",
  L2003: "Assignment to a `const` binding",
  L2011: "The Promise API is not available",
  L2013: "An async call is not awaited",
  L2012: "Host global is not available",
  L2031: "Mutation of a frozen value",

  // ---- L3xxx: effect call shape --------------------------------------------------------------
  L3011: "Unknown option key",
  L3012: "Missing required step name",
  L3013: "Step name is not a literal",
  L3014: "Malformed step name",
  L3021: "`fanOut` has no stable key",
  L3022: "Two agents share a worktree concurrently",
  L3023: "Array-form `parallel` holds named effects",
  L3024: "`fanOut` branch keys are not unique",
  L3041: "Value cannot cross an effect boundary",
  L3042: "Function passed as effect data",
  L3043: "`notify` fact is not a bounded decision record",
  L3044: "`to` without `onExpiry: \"escalate\"`",

  // ---- L4xxx: runtime semantics ---------------------------------------------------------------
  L4001: "Permit exhausted",
  L4002: "Agent down",
  L4003: "Turn deadline elapsed",
  L4004: "Handoff across worktrees",
  L4005: "Handoff to an agent outside the run",
  L4006: "`ask` never produced a conforming record",
  L4007: "Checkpoint expired",
  L4008: "Concurrent worktree write",
  L4009: "Run effect ceiling reached",
  L4013: "Step budget exhausted",

  // ---- L5xxx: durability -----------------------------------------------------------------------
  L5001: "Run divergence",
  L5002: "Program hash not available",
  L5003: "Orphaned `spawn` on migrate",
  L5004: "Orphaned resolved checkpoint on migrate",
  L5005: "A pending effect cannot be recovered",
  L5006: "Effect result too large",
  L5007: "Lease lost",
  L5008: "Resume under a different language version",
  L5009: "Resume pin mismatch",

  // ---- L6xxx: simulation -------------------------------------------------------------------------
  L6001: "Unscripted effect in simulation",
  L6002: "Simulation script entry unused",
} as const;

export type LangErrorCode = keyof typeof CATALOG;

/** A primitive's documentation, attached to any error blamed on a call to it. */
export interface CalleeDoc {
  readonly signature: string;
  readonly doc: string;
  readonly example: string;
}

/** Where in the user's program the blame lands. Always user-program coordinates. */
export interface SourceSpan {
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
}

/** The machine-parseable form. This is what a repair loop consumes. */
export interface LangErrorJson {
  readonly code: LangErrorCode;
  readonly title: string;
  readonly where: SourceSpan & { readonly frame: string };
  readonly cause: string;
  readonly fix: string;
  readonly callee?: CalleeDoc;
}

export interface LangErrorInit {
  readonly code: LangErrorCode;
  readonly span: SourceSpan;
  /** Plain English: why this is wrong, in terms of what the program is trying to do. */
  readonly cause: string;
  /** The edit that fixes it, concretely enough to apply. */
  readonly fix: string;
  /** The primitive this call named, when the error is blamed on one. */
  readonly callee?: CalleeDoc;
}

/**
 * Build the code frame: the offending line with a caret under the column. Rendering it here,
 * from the source the parser saw, is what keeps the blame frame in user coordinates rather than
 * in interpreter internals.
 */
export function codeFrame(source: string, span: SourceSpan): string {
  const lines = source.split("\n");
  const idx = span.line - 1;
  if (idx < 0 || idx >= lines.length) return "";
  const gutter = String(span.line);
  const pad = " ".repeat(gutter.length);
  const text = lines[idx] ?? "";
  const caretPad = " ".repeat(Math.max(0, span.column - 1));
  return `${gutter} | ${text}\n${pad} | ${caretPad}^`;
}

/** One error. Carries its own rendering so no caller has to reinvent the format. */
export class LangError extends Error {
  readonly code: LangErrorCode;
  readonly title: string;
  readonly span: SourceSpan;
  readonly cause: string;
  readonly fix: string;
  readonly callee?: CalleeDoc;

  constructor(init: LangErrorInit) {
    super(`${init.code} ${CATALOG[init.code]}`);
    this.name = "LangError";
    this.code = init.code;
    this.title = CATALOG[init.code];
    this.span = init.span;
    this.cause = init.cause;
    this.fix = init.fix;
    if (init.callee !== undefined) this.callee = init.callee;
  }

  toJSON(source: string): LangErrorJson {
    const base = {
      code: this.code,
      title: this.title,
      where: { ...this.span, frame: codeFrame(source, this.span) },
      cause: this.cause,
      fix: this.fix,
    };
    return this.callee === undefined ? base : { ...base, callee: this.callee };
  }

  /** The human rendering: frame, cause, fix, then the callee's signature and example. */
  render(source: string): string {
    const parts = [
      `${this.code}  ${this.title}`,
      "",
      codeFrame(source, this.span),
      "",
      this.cause,
      "",
      `Fix: ${this.fix}`,
    ];
    if (this.callee !== undefined) {
      parts.push("", this.callee.signature, this.callee.doc, "", this.callee.example);
    }
    return parts.join("\n");
  }
}

/**
 * The validator collects every error before reporting, so an author sees the whole repair list
 * at once rather than fixing one thing per round trip.
 */
export class LangErrors extends Error {
  readonly errors: readonly LangError[];
  readonly source: string;

  constructor(errors: readonly LangError[], source: string) {
    super(`${errors.length} error${errors.length === 1 ? "" : "s"} in program`);
    this.name = "LangErrors";
    this.errors = errors;
    this.source = source;
  }

  toJSON(): readonly LangErrorJson[] {
    return this.errors.map((e) => e.toJSON(this.source));
  }

  render(): string {
    return this.errors.map((e) => e.render(this.source)).join("\n\n");
  }
}

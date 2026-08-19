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
  L1025: "Forbidden syntax: loose equality",
  L1026: "Forbidden syntax: comma operator",
  L1027: "Forbidden syntax: `void`",
  L1028: "Forbidden property name",
  // The catch-all behind the admitted-node table: syntax that is valid JavaScript, is on no
  // forbidden row of its own, and is not in the language either. Naming it here is what lets the
  // interpreter's own "unsupported" fault stay unreachable from a validated program.
  L1029: "Syntax outside the language",
  L1030: "Forbidden literal: bigint",

  // ---- L2xxx: name resolution and static rules ----------------------------------------------
  L2001: "Unknown identifier",
  L2002: "Shadows a builtin or a primitive",
  L2003: "Assignment to a `const` binding",
  L2004: "Use before declaration",
  L2011: "The Promise API is not available",
  L2013: "An async call is not awaited",
  L2012: "Host global is not available",
  L2031: "Mutation of a frozen value",
  L2032: "Write from a concurrent branch to something declared outside it",

  // ---- L3xxx: effect call shape --------------------------------------------------------------
  L3011: "Unknown option key",
  L3012: "Missing required step name",
  L3013: "Step name is not a literal",
  L3014: "Malformed step name",
  L3021: "`fanOut` has no stable key",
  L3022: "Two agents share a worktree concurrently",
  L3023: "Array-form `parallel` holds named effects",
  L3024: "`fanOut` branch keys are not unique",
  L3025: "Branch key contains a reserved step-key character",
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
  L4010: "Field access on `null` or `undefined`",
  L4011: "Call of a value that is not a function",
  L4012: "Assertion failed",
  L4013: "Step budget exhausted",
  L4014: "Unknown member",
  L4015: "Not iterable",
  L4016: "Builtin failed",
  L4017: "Invalid array length",
  L4018: "No implicit conversion",
  L4019: "Array write past the end",
  L4020: "A method is not a value",
  L4021: "A callable `then` is not a record member",

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
  // The log said no, which is not the world saying no. Recorded separately because a run that
  // cannot append has no result to report, and reporting one anyway is how a completed effect
  // comes to be replayed as a failure.
  L5010: "Journal append rejected",
  // A journal belongs to ONE run. The keys are structural, so another run's entry with the same
  // scope and name MATCHES: a mismatch is not a mislabelling, it is one run resuming from another
  // run's history and returning its results as its own.
  L5011: "Journal belongs to a different run",
  // The DRIVER stopped, and the program did not. A run whose host must stop before the next effect
  // — its work horizon reached, a pause requested — has not failed and has not finished: it is
  // exactly where its journal says it is, and someone else can pick it up there. Recorded as its
  // own code because settling the entry instead would write down a failure for work nobody
  // attempted.
  L5012: "Run released before the next effect",
  // The three refusals design 8.4's orphan table needs and does not number. Allocated here rather
  // than reused, because a code that means two things is worse than a code that means nothing: the
  // first three numbers this table wanted — L5005, L5006, L5007 — were already a pending effect, an
  // oversized result, and a lost lease, and a reader acting on one of those would act on the wrong
  // fact entirely.
  L5013: "Orphaned undelivered `notice` on migrate",
  L5014: "Orphaned open `conclave` on migrate",
  L5015: "No orphan policy for this entry kind on migrate",
  // A durable run reached an effect whose substrate has not landed on this host. Its own code
  // because the alternative — a generic handler fault — records "the handler broke" for a step
  // nothing ever attempted, and a reader of the journal cannot tell the two apart afterwards.
  L5016: "Effect not durable on this host",
  // The fork's three refusals, allocated from THIS FILE rather than from memory — the rule the
  // orphan table's L5005/L5006/L5007 collision bought. Note what is NOT here: a fork asked to pin a
  // new program hash reuses L5002, which already says exactly that and had no user. A synonym would
  // have been a second name for one fact, which is the same defect as a reused number, wearing a
  // nicer face.
  L5017: "Fork cut step is not in the journal",
  L5018: "Fork cut was never reached",
  L5020: "A fork cut lies inside a scope whose outcome was already decided",
  L5019: "Fork cannot honour `onFork` on this host",
  // Allocated from THIS FILE, same rule. A resume that is handed history but not the pins that
  // history was written under does not fail anywhere: it re-resolves them, takes this host's clock
  // as the run's epoch and this interpreter's default as the seed, and carries on. Nothing in the
  // journal disagrees, because pure draws are not journalled and the clock is not a recorded fact.
  L5021: "Resume over a journal without the run's pins",
  // The hole the "losers only" branch digest left open, and it did not fail quietly: the walk was
  // sent into a recorded winning arm the edited source had RENAMED away, entered nothing, and
  // awaited `Promise.race([])`, which never settles. Its own code and not L5001 because that one is
  // a hash comparison down to its field names, and this is a comparison of branch NAMES.
  L5022: "A recorded branch is not in the migrated source",

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

/**
 * A refusal raised while a program RUNS, carrying its `L` code as a field so a caller can branch on
 * it rather than parse prose.
 *
 * It lives here rather than in `interpret.ts` because `keys.ts` raises one too — a computed step
 * name is only knowable at key-construction time — and `keys.ts` cannot import the interpreter that
 * imports it. The error vocabulary is the one module in this package that depends on nothing.
 */
export class RuntimeFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code} ${message}`);
    this.name = "RuntimeFault";
  }
}

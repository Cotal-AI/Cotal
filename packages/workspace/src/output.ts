import type { FlagSpec, OutputMode } from "@cotal-ai/core";

/**
 * The structured output contract every command surface shares: one version 1 envelope per finite
 * command, the outcome that sets the exit code, the stable error vocabulary with the native cause
 * kept beside it, and the NDJSON records a follow command streams. Commands in any implementation
 * (cli, manager, auth, runtime, delivery, linear, web) build their output from these, so a script
 * reads every command the same way.
 */

/** How a finite command ended. `ok` and `no-op` succeed; the rest carry an {@link ErrorDetail}. */
export type Outcome = "ok" | "no-op" | "refused" | "failed" | "partial" | "unknown";

/** How much of the read scope the result covers. It says nothing about whether the work succeeded. */
export type Completeness = "complete" | "partial" | "not-checked";

/** Refusals of the declared input, before any effect: exit 1. */
export const USAGE_CODES = ["USAGE_INVALID", "SCHEMA_INVALID"] as const;

/** Refusals at a known boundary before any effect: exit 2. Denial, absence and outage stay distinct. */
export const BOUNDARY_CODES = [
  "PERMISSION_DENIED",
  "AUTH_REQUIRED",
  "TARGET_UNAVAILABLE",
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "DEPENDENCY_UNAVAILABLE",
  "UNSUPPORTED",
  "CONFLICT",
  "LIFECYCLE_BLOCKED",
] as const;

/** The codes a `refused` outcome carries: a usage refusal or a boundary refusal. */
export type RefusalCode = (typeof USAGE_CODES)[number] | (typeof BOUNDARY_CODES)[number];

export type ErrorCode =
  | RefusalCode
  | "OPERATION_UNKNOWN"
  | "OPERATION_PARTIAL"
  | "OPERATION_FAILED";

/** A native endpoint's own code, outcome and safe structured detail, kept under `error.cause`. */
export interface NativeCause {
  readonly code?: string;
  readonly outcome?: string;
  readonly detail?: unknown;
}

export interface ErrorDetail {
  readonly code: ErrorCode;
  readonly message: string;
  readonly remedy?: string;
  readonly cause?: NativeCause;
}

export interface OutputWarning {
  readonly code: string;
  readonly target: unknown;
  readonly message: string;
}

/** One document on stdout. `target` is null for a command that reads only local metadata. */
export interface Envelope<R = unknown> {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly target: unknown;
  readonly outcome: Outcome;
  readonly completeness: Completeness;
  readonly result: R | null;
  readonly warnings: readonly OutputWarning[];
  readonly error?: ErrorDetail;
  /** Resources the command changed, confirmed, even when it did not succeed. */
  readonly changed?: readonly unknown[];
}

/** The exit code of a finite outcome, or a throw when the code does not belong to the outcome. */
export function exitCode(outcome: Outcome, code?: ErrorCode): number {
  const problem = outcomeCodeProblem(outcome, code);
  if (problem) throw new Error(`internal error: ${problem}`);
  switch (outcome) {
    case "ok":
    case "no-op":
      return 0;
    case "refused":
      return (USAGE_CODES as readonly string[]).includes(code!) ? 1 : 2;
    case "unknown":
      return 3;
    case "partial":
      return 4;
    case "failed":
      return 5;
  }
}

function outcomeCodeProblem(outcome: Outcome, code: ErrorCode | undefined): string | undefined {
  if (outcome === "ok" || outcome === "no-op") return code === undefined ? undefined : `outcome ${outcome} carries error code ${code}`;
  const allowed: readonly string[] =
    outcome === "refused" ? [...USAGE_CODES, ...BOUNDARY_CODES]
    : outcome === "unknown" ? ["OPERATION_UNKNOWN"]
    : outcome === "partial" ? ["OPERATION_PARTIAL"]
    : ["OPERATION_FAILED"];
  if (code === undefined) return `outcome ${outcome} has no error code`;
  return allowed.includes(code) ? undefined : `outcome ${outcome} cannot carry error code ${code}`;
}

const FAILURE_BRAND = Symbol.for("cotal.CommandFailure");

/**
 * A command that did not succeed, classified. The kernel prints its message and remedy, writes its
 * envelope when one was asked for, and exits with {@link exitCode}. `native` is serialized as
 * `error.cause`; it is not named `cause` because `Error` already owns that field.
 */
export class CommandFailure extends Error {
  /** A brand that survives two copies of this module, where `instanceof` would not. */
  readonly [FAILURE_BRAND] = true;
  readonly outcome: Exclude<Outcome, "ok" | "no-op">;
  readonly code: ErrorCode;
  readonly remedy?: string;
  readonly native?: NativeCause;
  readonly target: unknown;
  readonly changed?: readonly unknown[];

  constructor(
    outcome: Exclude<Outcome, "ok" | "no-op">,
    code: ErrorCode,
    message: string,
    opts: { remedy?: string; native?: NativeCause; target?: unknown; changed?: readonly unknown[] } = {},
  ) {
    super(message);
    const problem = outcomeCodeProblem(outcome, code);
    if (problem) throw new Error(`internal error: ${problem}`);
    this.name = "CommandFailure";
    this.outcome = outcome;
    this.code = code;
    this.remedy = opts.remedy;
    this.native = opts.native;
    this.target = opts.target ?? null;
    this.changed = opts.changed;
  }

  /** The error detail an envelope carries. */
  detail(): ErrorDetail {
    return {
      code: this.code,
      message: this.message,
      ...(this.remedy === undefined ? {} : { remedy: this.remedy }),
      ...(this.native === undefined ? {} : { cause: this.native }),
    };
  }
}

export function isCommandFailure(e: unknown): e is CommandFailure {
  return typeof e === "object" && e !== null && (e as { [FAILURE_BRAND]?: unknown })[FAILURE_BRAND] === true;
}

/** The envelope for a command that did not succeed. */
export function failureEnvelope(command: string, failure: CommandFailure): Envelope<null> {
  return {
    schemaVersion: 1,
    command,
    target: failure.target,
    outcome: failure.outcome,
    completeness: "not-checked",
    result: null,
    warnings: [],
    error: failure.detail(),
    ...(failure.changed === undefined ? {} : { changed: failure.changed }),
  };
}

/** One envelope as the line stdout carries, or a throw when its outcome and error code disagree. */
export function envelopeLine(envelope: Envelope): string {
  const problem = outcomeCodeProblem(envelope.outcome, envelope.error?.code);
  if (problem) throw new Error(`internal error: ${problem}`);
  return `${JSON.stringify(envelope)}\n`;
}

/** Write one envelope as the whole of stdout. */
export function writeEnvelope(envelope: Envelope): void {
  process.stdout.write(envelopeLine(envelope));
}

/** The follow streams, by what they follow. `goal` is an action followed with `--wait`. */
export type StreamName = "watch" | "logs" | "history" | "membership" | "goal" | "endpoint";

export type RecordType = "snapshot" | "event" | "connection" | "gap" | "error" | "end";

/** One NDJSON line of a follow stream, parseable on its own. */
export interface StreamRecord<D = unknown> {
  readonly schemaVersion: 1;
  readonly stream: StreamName;
  readonly type: RecordType;
  readonly target: unknown;
  readonly receivedAt: string;
  readonly data: D;
}

export function streamRecord<D>(stream: StreamName, type: RecordType, target: unknown, data: D, receivedAt = new Date()): StreamRecord<D> {
  return { schemaVersion: 1, stream, type, target, receivedAt: receivedAt.toISOString(), data };
}

/** Write one record as one line of stdout. */
export function writeStreamRecord(record: StreamRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** `--json/-j`: the structured output a command declares, one document or, on a follow, NDJSON. */
export const jsonFlag = { name: "json", short: "j", type: "boolean", description: "structured output on stdout" } as const satisfies FlagSpec;

/** `--plain`: line-oriented presentation without ANSI or cursor movement. Not a parsing API. */
export const plainFlag = { name: "plain", type: "boolean", description: "plain line-oriented output" } as const satisfies FlagSpec;

/** The flags a command's declared outputs require. */
export function outputFlags(outputs: readonly OutputMode[]): FlagSpec[] {
  const flags: FlagSpec[] = [];
  if (outputs.includes("json") || outputs.includes("ndjson")) flags.push(jsonFlag);
  if (outputs.includes("plain")) flags.push(plainFlag);
  return flags;
}

/** Why a command's declared outputs and its flags disagree. A declared output is selected by its
 *  shared flag, so the command must declare that flag as the shared spec defines it. */
export function outputDeclarationProblems(cmd: { name: string; outputs?: readonly OutputMode[]; flags?: readonly FlagSpec[] }): string[] {
  const problems: string[] = [];
  for (const want of outputFlags(cmd.outputs ?? [])) {
    const flag = cmd.flags?.find((f) => f.name === want.name);
    if (!flag || flag.type !== want.type || flag.short !== want.short)
      problems.push(`command "${cmd.name}" declares a ${want.name} output but not the shared --${want.name}${want.short ? `/-${want.short}` : ""} flag`);
  }
  return problems;
}

/** Flags every command accepts, read by the kernel before dispatch. No command may declare one. */
export const GLOBAL_FLAGS = ["no-color", "no-input"] as const;

/** Why a command declares a global flag's name. The kernel takes the bare flag before the command
 *  parses, so a command could receive it only as `--<name>=<value>`, and never as declared. */
export function globalFlagDeclarationProblems(cmd: { name: string; flags?: readonly FlagSpec[] }): string[] {
  const globals: readonly string[] = GLOBAL_FLAGS;
  return (cmd.flags ?? []).filter((flag) => globals.includes(flag.name)).map((flag) => `command "${cmd.name}" declares --${flag.name}, which is a global flag`);
}

let inputDisabled = false;

/** `--no-input`: no prompt, picker, editor or browser for the rest of this process. */
export function disableInput(): void {
  inputDisabled = true;
}

/** Whether `--no-input` was given. A prompt site treats it as it treats a missing terminal. */
export function inputDisabledByFlag(): boolean {
  return inputDisabled;
}

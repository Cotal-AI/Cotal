import { readFileSync } from "node:fs";
import { dryRun, LangErrors, validate, type SimScript } from "@cotal-ai/lang";
import { CommandFailure, presentationOf, writeResult, type Report } from "@cotal-ai/workspace";

export interface OfflineValues {
  json?: boolean;
  plain?: boolean;
  handler?: string;
}

/** A workflow program's source, or the TARGET_NOT_FOUND refusal every run verb gives a file it cannot read. */
export function sourceOf(file: string): string {
  try { return readFileSync(file, "utf8"); }
  catch { throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the workflow source file could not be read", { target: { file } }); }
}

function scriptOf(file: string | undefined): SimScript {
  if (file === undefined) return {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the simulation handler must be a readable JSON results script", { target: { file } }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the simulation results script must be an object");
  const script = value as Record<string, unknown>;
  const fields = new Set(["turns", "asks", "checkpoints", "events", "clock", "faults"]);
  for (const [key, item] of Object.entries(script)) {
    if (!fields.has(key)) throw new CommandFailure("refused", "SCHEMA_INVALID", `unknown simulation script field '${key}'`);
    if (key === "faults" ? !Array.isArray(item) : !item || typeof item !== "object" || Array.isArray(item))
      throw new CommandFailure("refused", "SCHEMA_INVALID", `invalid simulation script field '${key}'`);
  }
  for (const [name, entry] of Object.entries((script.checkpoints ?? {}) as Record<string, unknown>)) {
    for (const result of Array.isArray(entry) ? entry : [entry]) {
      const problem = checkpointResultProblem(result);
      if (problem) throw new CommandFailure("refused", "SCHEMA_INVALID", `invalid scripted checkpoint '${name}': ${problem}`, { target: { file } });
    }
  }
  return script as SimScript;
}

/** Why a scripted checkpoint result is not one `checkpoint()` can return, or undefined. The
 *  simulator reads only an `expired` status and takes any other entry as an answer, so a malformed
 *  one is refused here rather than simulated as resolved. */
function checkpointResultProblem(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "a result must be an object";
  const fields = result as Record<string, unknown>;
  if (fields.status !== "resolved" && fields.status !== "expired") return "status must be \"resolved\" or \"expired\"";
  if ("at" in fields) return "at is stamped from virtual time and cannot be scripted";
  const known = new Set(["status", "value", "by", "artifact"]);
  const unknown = Object.keys(fields).find((key) => !known.has(key));
  if (unknown !== undefined) return `unknown field '${unknown}'`;
  if (fields.by !== undefined && typeof fields.by !== "string") return "by must be a string";
  if (fields.artifact !== undefined && typeof fields.artifact !== "string") return "artifact must be a string";
  return undefined;
}

/** A static call-site inventory. It makes no claim about branch choices, effect order or loop counts. */
function callSites(ast: unknown, source: string): { call: string; line: number }[] {
  const pending: unknown[] = [ast];
  const sites: { call: string; offset: number }[] = [];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const node = value as Record<string, unknown>;
    if (node.type === "CallExpression" && node.callee && typeof node.callee === "object") {
      const callee = node.callee as Record<string, unknown>;
      const simple = callee.type === "Identifier" ? callee.name : undefined;
      const object = callee.object as Record<string, unknown> | undefined;
      const property = callee.property as Record<string, unknown> | undefined;
      const call = typeof simple === "string" ? simple : object?.type === "Identifier" && typeof object.name === "string" && property?.type === "Identifier" && typeof property.name === "string" ? `${object.name}.${property.name}` : "derived call";
      const offset = typeof node.start === "number" ? node.start : 0;
      sites.push({ call, offset });
    }
    for (const item of Object.values(node)) if (item && typeof item === "object") pending.push(item);
  }
  let line = 1;
  let position = 0;
  return sites.sort((a, b) => a.offset - b.offset).map((site) => {
    while (position < site.offset) if (source[position++] === "\n") line++;
    return { call: site.call, line };
  });
}

/** Offline commands never resolve a mesh or execute a supplied JavaScript handler. */
export async function offlineWorkflow(mode: "validate" | "plan" | "simulate", file: string, values: OfflineValues): Promise<void> {
  const presentation = presentationOf(values);
  const source = sourceOf(file);
  let checked: ReturnType<typeof validate>;
  try { checked = validate(source, file); }
  catch (error) {
    if (!(error instanceof LangErrors)) throw error;
    // Every problem as the validator records it, so the fix is the same edit a hosted `run start`
    // refusal prints.
    const problems = error.errors.map((item) => ({ code: item.code, title: item.title, span: item.span, cause: item.cause, fix: item.fix }));
    const count = `${problems.length} problem${problems.length === 1 ? "" : "s"}`;
    const failure = new CommandFailure("refused", "SCHEMA_INVALID", `the workflow is not valid cotal-lang (${count})`, { target: { file }, native: { code: "LANG_INVALID", detail: error.errors.map((item) => ({ code: item.code, span: item.span })) } });
    writeResult(presentation, { command: "run", target: { file }, result: { kind: "workflow-validation", valid: false, problems }, failure }, (result): Report => ({ sections: [
      { title: "Workflow not valid", blocks: [
        { kind: "fields", rows: [["File", file], ["Problems", String(result.problems.length)]] },
        ...result.problems.map((problem) => ({ kind: "lines" as const, lines: [{ text: `${problem.code} ${problem.title} (${problem.span.file}:${problem.span.line}:${problem.span.column})`, tone: "failed" as const }, `  ${problem.cause}`, `  fix: ${problem.fix}`] })),
        { kind: "lines", lines: [{ text: "Language validation only. No mesh, authority, runtime or application was checked.", tone: "hint" }] },
      ] },
    ] }));
    return;
  }
  const warnings = checked.warnings.map((warning) => ({ code: warning.code, target: { file, span: warning.span }, message: "The language validator reported a warning at this source position." }));
  if (mode === "validate") {
    writeResult(presentation, { command: "run", target: { file }, result: { kind: "workflow-validation", valid: true, warnings: checked.warnings.map((item) => ({ code: item.code, span: item.span })) }, warnings }, () => ({ sections: [
      { title: "Workflow valid", blocks: [{ kind: "fields", rows: [["File", file], ["Warnings", String(warnings.length)]] }, { kind: "lines", lines: [{ text: "Language validation only. No mesh, authority, runtime or application was checked.", tone: "hint" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal r plan <file>", description: "See validated static call sites" }, { command: "cotal r simulate <file> --handler <results.json>", description: "Exercise the program with explicit scripted results, offline" }] }] },
    ] }));
    return;
  }
  if (mode === "plan") {
    const calls = callSites(checked.ast, source);
    writeResult(presentation, { command: "run", target: { file }, result: { kind: "workflow-plan", scope: "validated static call sites", calls }, warnings }, (result): Report => ({ sections: [
      { title: "Workflow plan", blocks: [{ kind: "fields", rows: [["File", file], ["Scope", result.scope]] }, result.calls.length ? { kind: "table", columns: [{ key: "line", label: "Line" }, { key: "call", label: "Call" }], rows: result.calls.map((item) => ({ line: String(item.line), call: { text: item.call, tone: "command" } })) } : { kind: "lines", lines: ["No call sites in this program."] }, { kind: "lines", lines: [{ text: "Source order, not an execution schedule. Branches, loop counts and runtime outcomes were not evaluated. No broker was contacted.", tone: "hint" }] }] },
    ] }));
    return;
  }
  const script = scriptOf(values.handler);
  let report: Awaited<ReturnType<typeof dryRun>>;
  try { report = await dryRun(source, script, { file }); }
  catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new CommandFailure("failed", "OPERATION_FAILED", "the offline simulation did not complete; unscripted effects are not invented", { target: { file }, ...(typeof code === "string" && /^L[0-9]+$/.test(code) ? { native: { code } } : {}) });
  }
  const result = { kind: "workflow-simulation", steps: report.steps, elapsedMs: report.elapsedMs, effects: report.effects, agents: report.agents, waits: report.waits, checkpoints: report.checkpoints, unusedScript: report.unusedScript };
  writeResult(presentation, { command: "run", target: { file }, result, warnings }, (r): Report => ({ sections: [
    { title: "Workflow simulated", blocks: [{ kind: "fields", rows: [["File", file], ["Steps", String(r.steps)], ["Virtual time", `${r.elapsedMs} ms`], ["Unused script entries", String(r.unusedScript.length)]] }, r.effects.length ? { kind: "table", columns: [{ key: "step", label: "Step" }, { key: "kind", label: "Effect" }, { key: "status", label: "Simulated result" }], rows: r.effects.map((effect) => ({ step: effect.step, kind: effect.kind, status: effect.status })) } : { kind: "lines", lines: ["No simulated effects."] }, { kind: "lines", lines: [{ text: "Scripted results only. No agents were launched and no broker was contacted. This does not establish live readiness.", tone: "hint" }] }] },
  ] }));
}

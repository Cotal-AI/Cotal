/** The workflow runs a controller stack's manager hosts, read through that manager just before
 *  `down` stops it. A later `reset store` lists them from the stack journal, because the store's
 *  only reader is the broker and it is stopped by then. */
import type { RunJournalRow, RunListRow, RunStatusView } from "@cotal-ai/core";
import { localRecordObject, oneLine, resolveControlTarget } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { cliControl } from "./control.js";

/** A run that had not finished, with the steps it was waiting on. `waiting` is null when its
 *  journal could not be read. */
export interface StackRunRow { runId: string; state: "running" | "released"; waiting: { step: string; asks: string }[] | null }
export type StackRuns =
  | { observedAt: string; read: true; runs: StackRunRow[]; omitted: number; finished: number }
  | { observedAt: string; read: false; reason: string };

/** Bounds that keep the record well inside the stack journal's size limit. */
export const STACK_RUNS_LIMIT = { runs: 20, waiting: 5, text: 160 } as const;

const clip = (text: string) => {
  const line = oneLine(text);
  return line.length > STACK_RUNS_LIMIT.text ? `${line.slice(0, STACK_RUNS_LIMIT.text - 1)}…` : line;
};

/** The steps a journal holds open for an answer. A step's rows run from pending to settled, so only
 *  its last row says whether it is still open. */
function waitingSteps(journal: readonly RunJournalRow[]): { step: string; asks: string }[] {
  const steps = new Map<string, Extract<RunJournalRow, { kind: "step" }>>();
  for (const row of journal) if (row.kind === "step") steps.set(row.step, row);
  return [...steps.values()].filter((row) => row.state === "pending" && row.asks !== undefined)
    .slice(0, STACK_RUNS_LIMIT.waiting).map((row) => ({ step: clip(row.step), asks: clip(row.asks!) }));
}

/** Read the space's runs from its live manager. Never throws: a stop is never blocked on this
 *  inventory, so a failed read is recorded with its reason instead. */
export async function readStackRuns(space: string): Promise<StackRuns> {
  const observedAt = new Date().toISOString();
  try {
    const t = await resolveControlTarget({ space }, "control-caller-privileged", undefined, { onRefusal: "throw" });
    const list = await askManager(cliControl, t.space, t.server, "runPs", undefined, t.auth, "owner", 10_000);
    if (!list.ok || !Array.isArray(list.data)) return { observedAt, read: false, reason: clip(list.error ?? "the manager returned no run list") };
    const rows = list.data as RunListRow[];
    const open = rows.filter((row): row is RunListRow & { state: "running" | "released" } => row.state === "running" || row.state === "released");
    const runs: StackRunRow[] = [];
    for (const row of open.slice(0, STACK_RUNS_LIMIT.runs)) {
      const status = await askManager(cliControl, t.space, t.server, "runStatus", { runId: row.runId }, t.auth, "owner", 10_000);
      const view = status.ok ? status.data as RunStatusView | undefined : undefined;
      runs.push({ runId: clip(row.runId), state: row.state, waiting: Array.isArray(view?.journal) ? waitingSteps(view.journal) : null });
    }
    return { observedAt, read: true, runs, omitted: open.length - runs.length, finished: rows.length - open.length };
  } catch (error) {
    return { observedAt, read: false, reason: clip(error instanceof Error ? error.message : String(error)) };
  }
}

/** A recorded inventory read back from the stack journal, or undefined when its shape is not one
 *  {@link readStackRuns} writes. */
export function stackRunsRecord(input: unknown): StackRuns | undefined {
  const text = (v: unknown, empty = false) => typeof v === "string" && (empty || v.length > 0) && v.length <= STACK_RUNS_LIMIT.text;
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  try {
    const value = localRecordObject(input, ["observedAt", "read", "runs", "omitted", "finished", "reason"]);
    if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) return undefined;
    if (value.read === false) return text(value.reason) && value.runs === undefined && value.omitted === undefined && value.finished === undefined ? value as unknown as StackRuns : undefined;
    if (value.read !== true || value.reason !== undefined || !count(value.omitted) || !count(value.finished) || !Array.isArray(value.runs) || value.runs.length > STACK_RUNS_LIMIT.runs) return undefined;
    for (const row of value.runs) {
      const run = localRecordObject(row, ["runId", "state", "waiting"]);
      if (!text(run.runId) || run.state !== "running" && run.state !== "released") return undefined;
      if (run.waiting === null) continue;
      if (!Array.isArray(run.waiting) || run.waiting.length > STACK_RUNS_LIMIT.waiting) return undefined;
      for (const entry of run.waiting) {
        const step = localRecordObject(entry, ["step", "asks"]);
        if (!text(step.step) || !text(step.asks, true)) return undefined;
      }
    }
    return value as unknown as StackRuns;
  } catch { return undefined; }
}

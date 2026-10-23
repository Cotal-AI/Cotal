import type { RunJournalRow, RunListRow, RunStatusView } from "@cotal-ai/core";
import { oneLine, presentationOf, writeResult, type Report, type Styled } from "@cotal-ai/workspace";

interface OutputValues { json?: boolean; plain?: boolean; on?: string }
const recordedState = (state: string | undefined): Styled => ({ text: state ?? "not recorded", tone: state === "completed" ? "ok" : state === "failed" ? "failed" : state === "released" || state === "held" ? "waiting" : "hint" });
const managerPin = (values: OutputValues) => values.on ? ` --on ${values.on}` : "";
const runToken = (value: string | undefined) => value && /^run-[0-9a-f]{32}$/.test(value) ? value : "<run-id>";

export function printRunList(space: string | undefined, items: readonly RunListRow[], values: OutputValues): void {
  const unread = items.filter((row) => row.revocationUnreadable !== undefined);
  writeResult(presentationOf(values), {
    command: "run", target: { space: space ?? null, requestedManagerInstance: values.on ?? null }, result: { kind: "runs", items },
    warnings: unread.map((row) => ({ code: "REVOCATION_NOT_CHECKED", target: { run: row.runId, endpoint: row.endpoint }, message: "The revocation marker could not be read; the recorded state does not establish that this run may continue." })),
    ...(unread.length ? { completeness: "partial" as const, partial: { message: "Some run revocation markers could not be read." } } : {}),
  }, (result): Report => ({ sections: [
    { title: "Workflow runs", blocks: [
      { kind: "fields", rows: [["Space", space ?? "not reported"], ...(values.on ? [["Requested manager", values.on]] as [string, string][] : [])] },
      result.items.length ? { kind: "table", columns: [{ key: "run", label: "Run" }, { key: "endpoint", label: "Endpoint" }, { key: "state", label: "Recorded state" }, { key: "journal", label: "Journal" }], rows: result.items.map((row) => ({ run: row.runId, endpoint: row.endpoint, state: row.revoked ? { text: "admission revoked", tone: "failed" } : row.revocationUnreadable !== undefined ? { text: "revocation not checked", tone: "waiting" } : recordedState(row.state), journal: row.journalHigh === undefined ? "not reported" : String(row.journalHigh) })) } : { kind: "lines", lines: ["No workflow runs in this authorized record view."] },
      { kind: "lines", lines: [{ text: "Recorded workflow state, not a live agent-progress report. Revoking admission is not task cancellation.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal r show <run-id>${managerPin(values)}`, description: "Read state, open requests and journal steps" }, { command: `cotal r start <file>${managerPin(values)}`, description: "Start a new workflow on the selected manager" }] }] },
  ] }));
}

type StepRow = Extract<RunJournalRow, { kind: "step" }>;
type AnswerFacts = { readonly value?: unknown; readonly by?: string; readonly artifact?: string; readonly at?: number; readonly answerId: string };

/** One answer or amendment line of a settled pause. */
function answerRow(step: string, record: string, answer: AnswerFacts, artifacts: boolean): Record<string, string> {
  return {
    step, record,
    value: Object.hasOwn(answer, "value") ? JSON.stringify(answer.value) : "no value",
    by: answer.by ?? "not recorded",
    ...(artifacts ? { artifact: answer.artifact ?? "" } : {}),
    at: answer.at === undefined ? "not recorded" : new Date(answer.at).toISOString(),
    id: answer.answerId,
  };
}

export function printRunDetail(space: string, view: RunStatusView, values: OutputValues): void {
  const shown = view.journal.slice(-20);
  // A step's rows run from pending to settled, so only its last row says whether it is still open
  // and which answer it settled with.
  const steps = new Map<string, StepRow>();
  for (const row of view.journal) if (row.kind === "step") steps.set(row.step, row);
  const needsAnswer = [...steps.values()].filter((row) => row.state === "pending" && row.asks !== undefined);
  const answered = [...steps.values()].filter((row) => row.answer !== undefined);
  const artifacts = answered.some((row) => row.answer?.artifact !== undefined || row.amendments?.some((m) => m.artifact !== undefined));
  const answers = answered.flatMap((row) => [answerRow(row.step, "answered", row.answer!, artifacts), ...(row.amendments ?? []).map((m) => answerRow(row.step, "amended", m, artifacts))]);
  // A recorded message is the handler's or the program's text, so each of its lines is escaped.
  const errored = [...steps.values()].filter((row) => row.errorMessage !== undefined);
  const unreadable = view.revocationUnreadable !== undefined;
  writeResult(presentationOf(values), {
    command: "run", target: { space, endpoint: view.endpoint, run: view.runId, requestedManagerInstance: values.on ?? null }, result: { kind: "run", view },
    warnings: unreadable ? [{ code: "REVOCATION_NOT_CHECKED", target: { run: view.runId, endpoint: view.endpoint }, message: "The revocation marker could not be read; the recorded state does not establish that this run may continue." }] : [],
    ...(unreadable ? { completeness: "partial" as const, partial: { message: "The run revocation marker could not be read." } } : {}),
  }, (): Report => ({ sections: [
    { title: "Workflow", blocks: [{ kind: "fields", rows: [["Run", view.runId], ["Space", space], ["Endpoint", view.endpoint], ...(values.on ? [["Requested manager", values.on]] as [string, string][] : []), ["Recorded state", recordedState(view.status?.state)],
      ...(view.revoked ? [["Admission", { text: "admission revoked", tone: "failed" }], ["Revoked by", view.revoked.by], ["Revocation reason", view.revoked.reason]] as [string, string | Styled][] : []),
      ...(unreadable ? [["Revocation", { text: "revocation not checked", tone: "waiting" }]] as [string, Styled][] : []),
      ["Journal rows", String(view.journal.length)]] }] },
    ...(needsAnswer.length ? [{ title: "Needs an answer", blocks: [{ kind: "table" as const, columns: [{ key: "step", label: "Step" }, { key: "asks", label: "Request" }], rows: needsAnswer.map((row) => ({ step: row.step, asks: row.asks ?? "" })) }] }] : []),
    ...(answers.length ? [{ title: "Answers", blocks: [{ kind: "table" as const, columns: [{ key: "step", label: "Step" }, { key: "record", label: "Record" }, { key: "value", label: "Value" }, { key: "by", label: "By" }, ...(artifacts ? [{ key: "artifact", label: "Artifact" }] : []), { key: "at", label: "At" }, { key: "id", label: "Answer id" }], rows: answers }, { kind: "lines" as const, lines: [{ text: "The run acted on the answered value. Each amended line records a later position, and the last one is current.", tone: "hint" as const }] }] }] : []),
    ...(errored.length ? [{ title: "Step errors", blocks: [{ kind: "lines" as const, lines: errored.flatMap((row) => [{ text: `${row.step}  ${row.outcome}`, tone: "failed" as const }, ...row.errorMessage!.split("\n").map((line) => `  ${oneLine(line)}`)]) }] }] : []),
    { title: `Journal · last ${shown.length} of ${view.journal.length}`, blocks: [shown.length ? { kind: "table", columns: [{ key: "number", label: "Entry" }, { key: "step", label: "Step" }, { key: "outcome", label: "Recorded outcome" }], rows: shown.map((row) => ({ number: String(row.n), step: row.kind === "activation" ? "holder activation" : row.step, outcome: row.kind === "activation" ? `epoch ${row.epoch}` : row.outcome })) } : { kind: "lines", lines: ["No journal entries in this view."] }, { kind: "lines", lines: [{ text: "Use --json for the full returned journal. A step outcome is not proof that every external task succeeded.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [...(needsAnswer.length ? [{ command: `cotal r answer ${runToken(view.runId)} '<step-key>' --value '<json>'${managerPin(values)}`, description: "Answer an open request under the native caller policy" }] : []), { command: `cotal r show ${runToken(view.runId)} --json${managerPin(values)}`, description: "Read the complete returned status and journal" }] }] },
  ] }));
}

/** `runId` is the run the caller named, for an answer or amendment whose result does not repeat it. */
export function runReceipt(action: string, space: string | undefined, result: unknown, values: OutputValues, runId = result && typeof result === "object" && "runId" in result && typeof result.runId === "string" ? result.runId : undefined): void {
  writeResult(presentationOf(values), { command: "run", target: { space: space ?? null, requestedManagerInstance: values.on ?? null, ...(runId ? { run: runId } : {}) }, result: { kind: "run-receipt", action, result } }, () => ({ sections: [
    { title: action === "start" ? "Workflow started" : action === "resume" ? "Workflow resumed" : action === "amend" ? "Amendment recorded" : "Answer accepted", blocks: [{ kind: "fields", rows: [["Space", space ?? "not reported"], ...(runId ? [["Run", runId]] as [string, string][] : []), ...(values.on ? [["Requested manager", values.on]] as [string, string][] : [])] }, { kind: "lines", lines: [{ text: "The native host accepted this operation. This receipt does not claim workflow completion.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal r show ${runToken(runId)}${managerPin(values)}`, description: "Read the recorded outcome and pending requests" }] }] },
  ] }));
}

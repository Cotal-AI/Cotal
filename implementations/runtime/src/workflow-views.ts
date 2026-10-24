import type { RunFailure, RunJournalRow, RunListRow, RunStatusView } from "@cotal-ai/core";
import { oneLine, presentationOf, writeResult, type Report, type Styled } from "@cotal-ai/workspace";

interface OutputValues { json?: boolean; plain?: boolean; on?: string; limit?: string; local?: boolean }
const recordedState = (state: string | undefined, failure?: RunFailure): Styled => ({ text: state === "failed" && failure?.code ? `failed (${failure.code})` : state ?? "not recorded", tone: state === "completed" ? "ok" : state === "failed" ? "failed" : state === "released" || state === "held" ? "waiting" : "hint" });
const managerPin = (values: OutputValues) => values.on ? ` --on ${values.on}` : "";
const runToken = (value: string | undefined) => value && /^run-[0-9a-f]{32}$/.test(value) ? value : "<run-id>";

/** `unmatched` is given when `--endpoint` matched no run: that endpoint, and the endpoints this view
 *  records runs under. */
export function printRunList(space: string | undefined, items: readonly RunListRow[], values: OutputValues, unmatched?: { endpoint: string; recordedUnder: readonly string[] }): void {
  const unread = items.filter((row) => row.revocationUnreadable !== undefined);
  const nowhere = unmatched && !items.length
    ? `no run record in this view lives under endpoint ${oneLine(unmatched.endpoint)}; ${unmatched.recordedUnder.length ? `runs are recorded under ${unmatched.recordedUnder.map(oneLine).join(", ")}` : "it holds no run record under any endpoint"}`
    : undefined;
  writeResult(presentationOf(values), {
    command: "run", target: { space: space ?? null, requestedManagerInstance: values.on ?? null }, result: { kind: "runs", items },
    warnings: [...unread.map((row) => ({ code: "REVOCATION_NOT_CHECKED", target: { run: row.runId, endpoint: row.endpoint }, message: "The revocation marker could not be read; the recorded state does not establish that this run may continue." })),
      ...(nowhere ? [{ code: "ENDPOINT_HAS_NO_RUNS", target: { endpoint: unmatched!.endpoint, recordedUnder: unmatched!.recordedUnder }, message: nowhere }] : [])],
    ...(unread.length ? { completeness: "partial" as const, partial: { message: "Some run revocation markers could not be read." } } : {}),
  }, (result): Report => ({ sections: [
    { title: "Workflow runs", blocks: [
      { kind: "fields", rows: [["Space", space ?? "not reported"], ...(values.on ? [["Requested manager", values.on]] as [string, string][] : [])] },
      result.items.length ? { kind: "table", columns: [{ key: "run", label: "Run" }, { key: "endpoint", label: "Endpoint" }, { key: "state", label: "Recorded state" }, { key: "journal", label: "Journal" }], rows: result.items.map((row) => ({ run: row.runId, endpoint: row.endpoint, state: row.revoked ? { text: "admission revoked", tone: "failed" } : row.revocationUnreadable !== undefined ? { text: "revocation not checked", tone: "waiting" } : recordedState(row.state, row.failure), journal: row.journalHigh === undefined ? "not reported" : String(row.journalHigh) })) } : { kind: "lines", lines: ["No workflow runs in this authorized record view."] },
      // The state column says a run is revoked; who revoked it and why go under the table.
      ...(result.items.some((row) => row.revoked) ? [{ kind: "lines" as const, lines: result.items.flatMap((row) => row.revoked ? [`${row.runId}: revoked by ${oneLine(row.revoked.by)} (${oneLine(row.revoked.reason)})`] : []) }] : []),
      { kind: "lines", lines: [{ text: "Recorded workflow state, not a live agent-progress report. Revoking admission is not task cancellation.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal r show <run-id>${managerPin(values)}`, description: "Read state, open requests and journal steps" }, { command: `cotal r start <file>${managerPin(values)}`, description: "Start a new workflow on the selected manager" }] }] },
  ] }));
}

type StepRow = Extract<RunJournalRow, { kind: "step" }>;
type AnswerFacts = { readonly value?: unknown; readonly by?: string; readonly artifact?: string; readonly at?: number; readonly answerId: string };

/** The characters of an answer's value the Answers table prints; `--json` carries the value whole. */
const ANSWER_VALUE_SHOWN = 120;
const shownValue = (value: unknown): string => {
  const text = [...JSON.stringify(value)];
  return text.length > ANSWER_VALUE_SHOWN ? `${text.slice(0, ANSWER_VALUE_SHOWN - 1).join("")}…` : text.join("");
};
const valueCut = (answer: AnswerFacts) => Object.hasOwn(answer, "value") && [...JSON.stringify(answer.value)].length > ANSWER_VALUE_SHOWN;

/** One answer or amendment line of a settled pause. */
function answerRow(step: string, record: string, answer: AnswerFacts, artifacts: boolean): Record<string, string> {
  return {
    step, record,
    value: Object.hasOwn(answer, "value") ? shownValue(answer.value) : "no value",
    by: answer.by ?? "not recorded",
    ...(artifacts ? { artifact: answer.artifact ?? "" } : {}),
    at: answer.at === undefined ? "not recorded" : new Date(answer.at).toISOString(),
    id: answer.answerId,
  };
}

/** Whom an open checkpoint escalates to, and once it has, until when its escalation stays open. A
 *  `to` comes only with `onExpiry: "escalate"`, and the escalation's attempt is armed with `proceed`
 *  so it never hops again, so the recorded `onExpiry` says which attempt is open. */
function escalation(row: StepRow): string {
  if (row.addressee === undefined) return "";
  if (row.onExpiry === "escalate") return `to ${row.addressee} if it expires`;
  if (row.onExpiry === undefined) return `to ${row.addressee}`;
  return `escalated to ${row.addressee}${row.deadlineAt === undefined ? "" : `, open until ${new Date(row.deadlineAt).toISOString()}`}`;
}

/** Each step's last journal row. A step's rows run from pending to settled, so only its last row says
 *  whether it is still open and which answer it settled with. */
function lastRows(view: RunStatusView): Map<string, StepRow> {
  const steps = new Map<string, StepRow>();
  for (const row of view.journal) if (row.kind === "step") steps.set(row.step, row);
  return steps;
}

/** The step keys of a run's open checkpoints and asks, which `run answer` takes. */
export function openRequestKeys(view: RunStatusView): string[] {
  return [...lastRows(view).values()].filter((row) => row.state === "pending" && row.asks !== undefined).map((row) => row.step);
}

export function printRunDetail(space: string, view: RunStatusView, values: OutputValues): void {
  const shown = view.journal.slice(-(values.limit === undefined ? 20 : Number(values.limit)));
  const steps = lastRows(view);
  const needsAnswer = [...steps.values()].filter((row) => row.state === "pending" && row.asks !== undefined);
  const answered = [...steps.values()].filter((row) => row.answer !== undefined);
  // The program read an accepted answer only when its step resolved in a branch that did not lose a race.
  const actedOn = (row: StepRow) => row.status === "ok" && row.lostRace === undefined;
  // A step a race cancelled names the branch that won it, which that race's own row records.
  const winners = new Map(view.journal.flatMap((row) => row.kind === "step" && row.winner !== undefined ? [[row.step, row.winner] as const] : []));
  const ignored = answered.some((row) => !actedOn(row));
  const artifacts = answered.some((row) => row.answer?.artifact !== undefined || row.amendments?.some((m) => m.artifact !== undefined));
  const answers = answered.flatMap((row) => [answerRow(row.step, actedOn(row) ? "answered" : "not acted on", row.answer!, artifacts), ...(row.amendments ?? []).map((m) => answerRow(row.step, "amended", m, artifacts))]);
  const cut = answered.some((row) => valueCut(row.answer!) || (row.amendments ?? []).some(valueCut));
  // A recorded message is the handler's or the program's text, so each of its lines is escaped.
  const errored = [...steps.values()].filter((row) => row.errorMessage !== undefined);
  const failure = view.status?.state === "failed" ? view.status.failure : undefined;
  const failedStep = failure && errored.find((row) => row.errorMessage === failure.message);
  // A failure raised outside any step is in no journal row; a hosted run's manager logged its cause.
  const unrecorded = view.status?.state === "failed" && !errored.length;
  const unreadable = view.revocationUnreadable !== undefined;
  writeResult(presentationOf(values), {
    command: "run", target: { space, endpoint: view.endpoint, run: view.runId, requestedManagerInstance: values.on ?? null }, result: { kind: "run", view },
    warnings: unreadable ? [{ code: "REVOCATION_NOT_CHECKED", target: { run: view.runId, endpoint: view.endpoint }, message: "The revocation marker could not be read; the recorded state does not establish that this run may continue." }] : [],
    ...(unreadable ? { completeness: "partial" as const, partial: { message: "The run revocation marker could not be read." } } : {}),
  }, (): Report => ({ sections: [
    { title: "Workflow", blocks: [{ kind: "fields", rows: [["Run", view.runId], ["Space", space], ["Endpoint", view.endpoint], ...(values.on ? [["Requested manager", values.on]] as [string, string][] : []), ["Recorded state", recordedState(view.status?.state, view.status?.failure)],
      ...(view.revoked ? [["Admission", { text: "admission revoked", tone: "failed" }], ["Revoked by", view.revoked.by], ["Revocation reason", view.revoked.reason]] as [string, string | Styled][] : []),
      ...(unreadable ? [["Revocation", { text: "revocation not checked", tone: "waiting" }]] as [string, Styled][] : []),
      ["Journal rows", String(view.journal.length)]] }] },
    // A revoked run's open requests stay listed, because the pauses are still open, but they take
    // no answer, so the view says that and offers no answer command.
    ...(needsAnswer.length ? [{ title: "Needs an answer", blocks: [{ kind: "table" as const, columns: [{ key: "step", label: "Step" }, { key: "asks", label: "Request" }, ...(needsAnswer.some((row) => row.addressee !== undefined) ? [{ key: "escalation", label: "Escalation" }] : [])], rows: needsAnswer.map((row) => ({ step: row.step, asks: row.asks ?? "", escalation: escalation(row) })) },
      ...(view.revoked ? [{ kind: "lines" as const, lines: [{ text: "The run's admission is revoked, so these requests take no answer.", tone: "failed" as const }] }] : [])] }] : []),
    ...(answers.length ? [{ title: "Answers", blocks: [{ kind: "table" as const, columns: [{ key: "step", label: "Step" }, { key: "record", label: "Record" }, { key: "value", label: "Value" }, { key: "by", label: "By" }, ...(artifacts ? [{ key: "artifact", label: "Artifact" }] : []), { key: "at", label: "At" }, { key: "id", label: "Answer id" }], rows: answers }, { kind: "lines" as const, lines: [{ text: ignored ? "The run acted on each answered line. It never read a line marked not acted on, because that step's branch lost a race or was cancelled. Each amended line records a later position, and the last one is current." : "The run acted on the answered value. Each amended line records a later position, and the last one is current.", tone: "hint" as const },
      ...(cut ? [{ text: `A value longer than ${ANSWER_VALUE_SHOWN} characters is cut here; --json carries it whole.`, tone: "hint" as const }] : [])] }] }] : []),
    // The run's failure, as its status records it. When a step's error is that failure, it is
    // printed once, under Step errors, and named here. A failure that neither the status nor a
    // journal row records is named as raised outside any step.
    ...(failure ? [{ title: "Failure", blocks: [{ kind: "lines" as const, lines: failedStep
      ? [{ text: `${failedStep.step} failed the run; its error is under Step errors.`, tone: "failed" as const }]
      : failure.message.split("\n").map((line) => ({ text: oneLine(line), tone: "failed" as const })) }] }]
      : unrecorded ? [{ title: "Failure", blocks: [{ kind: "lines" as const, lines: ["No journal row records why this run failed, so the program raised it outside any step. A hosted run's cause is in its manager's log."] }] }] : []),
    ...(errored.length ? [{ title: "Step errors", blocks: [{ kind: "lines" as const, lines: errored.flatMap((row) => [{ text: `${row.step}  ${row.outcome}`, tone: "failed" as const }, ...row.errorMessage!.split("\n").map((line) => `  ${oneLine(line)}`)]) }] }] : []),
    { title: `Journal · last ${shown.length} of ${view.journal.length}`, blocks: [shown.length ? { kind: "table", columns: [{ key: "number", label: "Entry" }, { key: "step", label: "Step" }, { key: "outcome", label: "Recorded outcome" }], rows: shown.map((row) => ({ number: String(row.n), step: row.kind === "activation" ? "holder activation" : row.step, outcome: row.kind === "activation" ? `epoch ${row.epoch}` : row.winner !== undefined ? `${row.outcome}, ${row.winner} won` : row.outcome === "cancelled" && row.lostRace !== undefined ? `cancelled, ${winners.get(row.lostRace) ?? "another branch"} won ${row.lostRace}` : row.outcome })) } : { kind: "lines", lines: ["No journal entries in this view."] }, { kind: "lines", lines: [{ text: "Use --limit <n> for up to 1000 rows, or --json for the full returned journal. A step outcome is not proof that every external task succeeded.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [...(needsAnswer.length && !view.revoked ? [{ command: `cotal r answer ${runToken(view.runId)} '<step-key>' --value '<json>'${managerPin(values)}`, description: "Answer an open request under the native caller policy" }] : []), { command: `cotal r show ${runToken(view.runId)} --json${managerPin(values)}`, description: "Read the complete returned status and journal" }, ...(unrecorded ? [{ command: `cotal service logs stack-manager --space ${space}`, description: "Read the stack manager's log, where a hosted run's failure outside any step is recorded" }] : [])] }] },
  ] }));
}

/** What an answer or amendment filed, as the caller sent it, which the host records under the
 *  answer id it returns. `value` is absent when none was given. */
export interface ReceiptAnswer { readonly step: string; readonly value?: unknown; readonly artifact?: string }

/** `runId` is the run the caller named, for an answer or amendment whose result does not repeat it. */
export function runReceipt(action: string, space: string | undefined, result: unknown, values: OutputValues, runId = result && typeof result === "object" && "runId" in result && typeof result.runId === "string" ? result.runId : undefined, answer?: ReceiptAnswer): void {
  const reply = result && typeof result === "object" ? result as { answerId?: unknown; supersedes?: unknown } : {};
  const valueGiven = answer !== undefined && Object.hasOwn(answer, "value");
  const answerRows: [string, string][] = answer === undefined ? [] : [
    ["Step", answer.step],
    ["Value", valueGiven ? JSON.stringify(answer.value) : "no value; --value was not given"],
    ...(answer.artifact !== undefined ? [["Artifact", answer.artifact]] as [string, string][] : []),
    ...(typeof reply.answerId === "string" ? [["Answer id", reply.answerId]] as [string, string][] : []),
    ...(typeof reply.supersedes === "string" ? [["Supersedes", reply.supersedes]] as [string, string][] : []),
  ];
  writeResult(presentationOf(values), { command: "run", target: { space: space ?? null, requestedManagerInstance: values.on ?? null, ...(runId ? { run: runId } : {}) }, result: { kind: "run-receipt", action, result, ...(answer ? { answer: { ...answer, valueGiven } } : {}) } }, () => ({ sections: [
    { title: action === "start" ? "Workflow started" : action === "resume" ? "Workflow resumed" : action === "amend" ? "Amendment recorded" : "Answer accepted", blocks: [{ kind: "fields", rows: [["Space", space ?? "not reported"], ...(runId ? [["Run", runId]] as [string, string][] : []), ...(values.on ? [["Requested manager", values.on]] as [string, string][] : []), ...answerRows] }, { kind: "lines", lines: [{ text: "The native host accepted this operation. This receipt does not claim workflow completion.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal r show ${runToken(runId)}${values.local ? " --local" : managerPin(values)}`, description: "Read the recorded outcome and pending requests" }] }] },
  ] }));
}

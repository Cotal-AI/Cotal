import type { RunListRow, RunStatusView } from "@cotal-ai/core";
import { presentationOf, writeResult, type Report, type Styled } from "@cotal-ai/workspace";

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

export function printRunDetail(space: string, view: RunStatusView, values: OutputValues): void {
  const shown = view.journal.slice(-20);
  const needsAnswer = view.journal.filter((row) => row.kind === "step" && row.state === "pending" && row.asks !== undefined);
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
    ...(needsAnswer.length ? [{ title: "Needs an answer", blocks: [{ kind: "table" as const, columns: [{ key: "step", label: "Step" }, { key: "asks", label: "Request" }], rows: needsAnswer.map((row) => row.kind === "step" ? { step: row.step, asks: row.asks ?? "" } : { step: "", asks: "" }) }] }] : []),
    { title: `Journal · last ${shown.length} of ${view.journal.length}`, blocks: [shown.length ? { kind: "table", columns: [{ key: "number", label: "Entry" }, { key: "step", label: "Step" }, { key: "outcome", label: "Recorded outcome" }], rows: shown.map((row) => ({ number: String(row.n), step: row.kind === "activation" ? "holder activation" : row.step, outcome: row.kind === "activation" ? `epoch ${row.epoch}` : row.outcome })) } : { kind: "lines", lines: ["No journal entries in this view."] }, { kind: "lines", lines: [{ text: "Use --json for the full returned journal. A step outcome is not proof that every external task succeeded.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal r answer ${runToken(view.runId)} '<step-key>' --value '<json>'${managerPin(values)}`, description: "Answer an open request under the native caller policy" }, { command: `cotal r show ${runToken(view.runId)} --json${managerPin(values)}`, description: "Read the complete returned status and journal" }] }] },
  ] }));
}

export function runReceipt(action: string, space: string | undefined, result: unknown, values: OutputValues): void {
  const runId = result && typeof result === "object" && "runId" in result && typeof result.runId === "string" ? result.runId : undefined;
  writeResult(presentationOf(values), { command: "run", target: { space: space ?? null, requestedManagerInstance: values.on ?? null, ...(runId ? { run: runId } : {}) }, result: { kind: "run-receipt", action, result } }, () => ({ sections: [
    { title: action === "start" ? "Workflow started" : action === "resume" ? "Workflow resumed" : action === "amend" ? "Amendment recorded" : "Answer accepted", blocks: [{ kind: "fields", rows: [["Space", space ?? "not reported"], ...(runId ? [["Run", runId]] as [string, string][] : []), ...(values.on ? [["Requested manager", values.on]] as [string, string][] : [])] }, { kind: "lines", lines: [{ text: "The native host accepted this operation. This receipt does not claim workflow completion.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal r show ${runToken(runId)}${managerPin(values)}`, description: "Read the recorded outcome and pending requests" }] }] },
  ] }));
}

/**
 * The cotal-lang {@link RunHost}: the runtime's answer to the core `run-host` contract, which a
 * hosting daemon resolves from the registry and drives runs through (SPEC 14.3).
 *
 * The composition is `cotal run --local`'s, over planes the host opened: the mesh handler bound to
 * the host's own holder, the driver's start or takeover, the resolver for answers, and the two
 * reads (`ps`, `journal`) rendered as rows rather than printed. Nothing here opens a connection or
 * chooses a credential; the host that does knows whose rows it minted.
 */
import {
  readRunRecord,
  replayRunJournal,
  runDriverCaller,
  walkKvEntries,
  RUN_HOST_KIND,
  COTAL_LANG_RUN_HOST,
  type RunHost,
  type RunHostDrive,
  type RunHostDriveRequest,
  type RunHostOutcome,
  type RunHostPlanes,
  type RunHostAnswerRequest,
  type RunHostLocateRequest,
  type RunHostOpenPause,
  type RunJournalRow,
  type RunListRow,
  type RunStatusView,
  type RunValidation,
} from "@cotal-ai/core";
import { validate, LangErrors, journalEntryKeyString, type JournalEntry } from "@cotal-ai/lang";
import { startRun, driveRun, PauseToken, type DriveOutcome } from "./run-driver.js";
import { createRunEffectHost } from "./run-effect-host.js";
import { createRunScopeAuthority } from "./run-scope-authority.js";
import { createRunRecordHost, runRecordView } from "./run-record-host.js";
import { locateOpenCheckpoint, answerOpenCheckpoint } from "./resolve-checkpoint.js";

function outcomeOf(out: DriveOutcome): RunHostOutcome {
  if (out.status === "completed")
    return { status: "completed", steps: out.result.steps, ...(out.result.value !== undefined ? { value: out.result.value } : {}) };
  return { status: "released", reason: { name: out.reason.name, message: out.reason.message } };
}

function failureOf(e: unknown): RunHostOutcome {
  const err = e as { name?: unknown; message?: unknown; code?: unknown };
  return {
    status: "failed",
    error: {
      name: typeof err?.name === "string" ? err.name : "Error",
      message: typeof err?.message === "string" ? err.message : String(e),
      ...(typeof err?.code === "string" ? { code: err.code } : {}),
    },
  };
}

/** The journal view `cotal run journal` prints, as rows. The step key is rendered by the export
 *  the journal itself keys with, so it is the key `answer` takes back. */
function journalRows(records: Awaited<ReturnType<typeof replayRunJournal>>["records"]): RunJournalRow[] {
  const rows: RunJournalRow[] = [];
  for (const { record } of records) {
    if (record.kind === "activation") {
      rows.push({ n: record.n, kind: "activation", holder: record.holder, epoch: record.epoch, replayedTo: record.replayedTo });
      continue;
    }
    const e = record.entry as JournalEntry;
    const outcome = e.state === "pending" ? "pending" : `${e.status}${e.error?.code ? ` (${e.error.code})` : ""}`;
    const external = e.state === "pending" ? (e.external as { asks?: unknown; addressee?: unknown } | undefined) : undefined;
    rows.push({
      n: record.n,
      kind: "step",
      step: journalEntryKeyString(e),
      state: e.state,
      outcome,
      ...(typeof external?.asks === "string" ? { asks: external.asks } : {}),
      ...(typeof external?.addressee === "string" ? { addressee: external.addressee } : {}),
    });
  }
  return rows;
}

export const cotalLangRunHost: RunHost = {
  kind: RUN_HOST_KIND,
  name: COTAL_LANG_RUN_HOST,

  validate(source: string, file?: string): RunValidation {
    try {
      validate(source, file);
      return { ok: true };
    } catch (e) {
      if (e instanceof LangErrors) return { ok: false, errors: e.toJSON() as unknown as Record<string, unknown>[] };
      throw e;
    }
  },

  drive(planes: RunHostPlanes, req: RunHostDriveRequest, mediator: RunHostPlanes): RunHostDrive {
    const pause = new PauseToken();
    if (mediator === undefined || mediator.nc === planes.nc || mediator.space !== planes.space)
      throw new Error("a hosted run requires a separate trusted mediator connection in the same space");
    const authority = createRunScopeAuthority(mediator, req.runId, req.lease);
    const handler = createRunEffectHost(mediator, {
      space: planes.space, endpoint: req.endpoint, runId: req.runId,
      caller: runDriverCaller(req.runId), instanceId: req.instanceId, epoch: req.epoch,
      holder: req.holder, defaultCheckpointTimeout: req.defaultCheckpointTimeout,
    }, authority);
    const records = createRunRecordHost(mediator, req.endpoint, req.runId);
    const driveReq = {
      space: planes.space,
      endpoint: req.endpoint,
      runId: req.runId,
      source: req.source,
      kv: runRecordView(planes.kv, records, planes.space),
      lease: req.lease,
      handler,
      pause,
      ...(req.file !== undefined ? { file: req.file } : {}),
      ...(req.resultBytes !== undefined ? { resultBytes: req.resultBytes } : {}),
    };
    // A program that FAILS is rethrown by the driver after its `failed` note; the host reads it as
    // an outcome, never as its own crash.
    const done = (req.mode === "new" ? startRun(planes.js, planes.jsm, driveReq) : driveRun(planes.js, planes.jsm, driveReq))
      .then(outcomeOf, failureOf);
    return { done, release: (reason: string) => pause.pause(reason) };
  },

  async locate(planes: RunHostPlanes, req: RunHostLocateRequest): Promise<RunHostOpenPause> {
    return await locateOpenCheckpoint(
      { kv: planes.kv, js: planes.js, jsm: planes.jsm, space: planes.space, endpoint: req.endpoint },
      { runId: req.runId, stepKey: req.stepKey, takeoverId: req.takeoverId },
    );
  },

  async answer(planes: RunHostPlanes, req: RunHostAnswerRequest): Promise<unknown> {
    return await answerOpenCheckpoint(
      { kv: planes.kv, js: planes.js, jsm: planes.jsm, space: planes.space, endpoint: req.endpoint },
      {
        open: req.open,
        by: req.by,
        ...(req.value !== undefined ? { value: req.value } : {}),
        ...(req.artifact !== undefined ? { artifact: req.artifact } : {}),
        now: req.now,
      },
    );
  },

  async status(planes: RunHostPlanes, req: { endpoint: string; runId: string; takeoverId: string }): Promise<RunStatusView | undefined> {
    const record = await readRunRecord(planes.kv, req.endpoint, req.runId);
    if (record === undefined) return undefined;
    // The replay durable is named by the caller's takeover id (its credential's row); the read
    // half of that row is what a status view rides.
    const replay = await replayRunJournal(planes.js, planes.jsm, planes.space, req.runId, req.takeoverId);
    return {
      runId: req.runId,
      endpoint: req.endpoint,
      spec: record.spec.value,
      ...(record.status !== undefined ? { status: record.status.value } : {}),
      journal: journalRows(replay.records),
    };
  },

  async list(planes: RunHostPlanes, req: { endpoint?: string }): Promise<RunListRow[]> {
    // Run record keys are `run.<endpoint>.<runId>.<spec|status>`; the scan is over the spec half,
    // which every run has exactly once. A consumer-free walk: the records bucket is an authority
    // stream whose consumer surface is an exact audited list (SPEC 13.9).
    const seen = new Set<string>();
    const rows: RunListRow[] = [];
    for (const e of await walkKvEntries(planes.kv, "run.*.*.spec")) {
      const parts = e.key.split(".");
      if (parts.length !== 4 || parts[3] !== "spec") continue;
      const endpoint = parts[1] as string;
      const runId = parts[2] as string;
      const dedupe = `${endpoint}/${runId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (req.endpoint !== undefined && endpoint !== req.endpoint) continue;
      const record = await readRunRecord(planes.kv, endpoint, runId);
      if (record === undefined) continue;
      const st = record.status?.value;
      const lineage = record.spec.value.forkedFrom;
      rows.push({
        runId,
        endpoint,
        ...(st !== undefined ? { state: st.state, holder: st.holder, epoch: st.epoch, journalHigh: st.journalHigh } : {}),
        ...(lineage !== undefined ? { forkedFrom: lineage } : {}),
      });
    }
    return rows;
  },
};

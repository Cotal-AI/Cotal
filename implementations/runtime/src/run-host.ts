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
  readRunProgram,
  readRunAdmission,
  listCheckpointAmendments,
  readCheckpointAnswer,
  readCheckpointStatus,
  readRunRevocation,
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
  type RunHostAcceptedAnswer,
  type RunHostAmendRequest,
  type RunJournalRow,
  type RunListRow,
  type RunStatusView,
  type RunValidation,
} from "@cotal-ai/core";
import { CATALOG, codeFrame, primitiveDoc, validate, LangErrors, journalEntryKeyString, programHashOf, stepPauseToken, type JournalEntry } from "@cotal-ai/lang";
import { startRun, driveRun, PauseToken, type DriveOutcome } from "./run-driver.js";
import { createRunEffectHost } from "./run-effect-host.js";
import { createRunScopeAuthority } from "./run-scope-authority.js";
import { createRunRecordHost, runRecordView } from "./run-record-host.js";
import { locateOpenCheckpoint, answerOpenCheckpoint, locateAcceptedAnswer, amendAcceptedAnswer } from "./resolve-checkpoint.js";
import type { KV } from "@nats-io/kv";

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

/** The disposition a journal row prints for one step: `pending` while the step is open, then the
 *  checkpoint outcome the settle named (`resolved` / `expired`) when the settled result is a
 *  checkpoint disposition, and otherwise the settled status with its error code when there is one.
 *  A settled checkpoint whose result a handler does not name reads exactly as it did before the
 *  distinction existed (#1439). Only a checkpoint settles with a disposition: any other step's
 *  result is its value, so an `ask` answered with a record that has an `outcome` field still prints
 *  its status. */
export function journalOutcomeOf(e: JournalEntry): string {
  if (e.state === "pending") return "pending";
  if (e.kind === "checkpoint" && e.result !== null && typeof e.result === "object") {
    const outcome = (e.result as { readonly outcome?: unknown }).outcome;
    if (outcome === "resolved" || outcome === "expired") return outcome;
  }
  return `${e.status}${e.error?.code ? ` (${e.error.code})` : ""}`;
}

type StepJournalRow = Extract<RunJournalRow, { readonly kind: "step" }>;

/** Build the one step-row view used by both hosted status reads and the local journal command. */
export function journalStepRow(n: number, e: JournalEntry): StepJournalRow {
  const outcome = journalOutcomeOf(e);
  // A held step's question is its hold's, which is what the hold's checkpoint bound.
  const external = e.state === "pending"
    ? ((e.hold ?? e.external) as { asks?: unknown; addressee?: unknown; deadlineAt?: unknown; onExpiry?: unknown } | undefined)
    : undefined;
  const result = e.state === "settled" && e.result !== null && typeof e.result === "object"
    ? e.result as { outcome?: unknown; value?: unknown; by?: unknown; artifact?: unknown; at?: unknown; answerId?: unknown }
    : undefined;
  // A checkpoint's settled result names its accepted answer. An `ask`'s is the answer's value, read
  // as data whatever fields it holds; `journalRows` reads its answer off the pause instead.
  const answeredPause = e.kind === "checkpoint"
    && result?.outcome === "resolved"
    && typeof result.answerId === "string"
    ? {
        answerId: result.answerId,
        ...(result.value !== undefined ? { value: result.value } : {}),
        ...(typeof result.by === "string" ? { by: result.by } : {}),
        ...(typeof result.artifact === "string" ? { artifact: result.artifact } : {}),
        ...(typeof result.at === "number" ? { at: result.at } : {}),
      }
    : undefined;
  return {
    n,
    kind: "step",
    step: journalEntryKeyString(e),
    effect: e.kind,
    name: e.name,
    state: e.state,
    outcome,
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.error?.code ? { errorCode: e.error.code } : {}),
    startedAt: e.startedAt,
    ...(e.endedAt !== undefined ? { endedAt: e.endedAt } : {}),
    ...(typeof external?.asks === "string" ? { asks: external.asks } : {}),
    ...(typeof external?.addressee === "string" ? { addressee: external.addressee } : {}),
    ...(typeof external?.deadlineAt === "number" ? { deadlineAt: external.deadlineAt } : {}),
    ...(typeof external?.onExpiry === "string" ? { onExpiry: external.onExpiry } : {}),
    ...(answeredPause !== undefined ? { answer: answeredPause } : {}),
  };
}

/** The answer a settled `ask` accepted, read off its pause's status and answer record. An ask's
 *  frozen result is the answer's value alone, so unlike a checkpoint's it names no answer to print. */
async function acceptedAskAnswer(kv: KV, endpoint: string, token: string): Promise<StepJournalRow["answer"]> {
  const status = await readCheckpointStatus(kv, { endpoint, token });
  const answerId = status?.value.state === "resumed" ? status.value.settledAnswerId : undefined;
  if (answerId === undefined) return undefined;
  const a = await readCheckpointAnswer(kv, endpoint, token, answerId);
  if (a === undefined)
    throw new Error(`checkpoint "${token}" settled naming the answer ${answerId}, which is not on record; reconcile the store`);
  return {
    answerId,
    ...(a.value !== undefined ? { value: a.value } : {}),
    by: a.by,
    ...(a.artifact !== undefined ? { artifact: a.artifact } : {}),
    at: a.at,
  };
}

/** The journal view `cotal run journal` prints, as rows. The step key is rendered by the export
 *  the journal itself keys with, so it is the key `answer` takes back. A settled checkpoint or
 *  `ask` also lists the amendments filed under the token it settled under (an ask's last attempt
 *  token rides its pending entries), read from the answer records on `kv`, and a settled ask the
 *  answer its last attempt accepted. */
export async function journalRows(
  kv: KV,
  endpoint: string,
  records: Awaited<ReturnType<typeof replayRunJournal>>["records"],
): Promise<RunJournalRow[]> {
  const rows: RunJournalRow[] = [];
  const steps = new Map<string, JournalEntry[]>();
  for (const { record } of records) {
    if (record.kind === "activation") {
      rows.push({ n: record.n, kind: "activation", holder: record.holder, epoch: record.epoch, replayedTo: record.replayedTo });
      continue;
    }
    const e = record.entry as JournalEntry;
    const row = journalStepRow(record.n, e);
    const step = steps.get(row.step) ?? [];
    step.push(e);
    steps.set(row.step, step);
    const token = e.state !== "settled" || (e.kind !== "checkpoint" && e.kind !== "ask") ? undefined : stepPauseToken(step);
    const amendments = token === undefined ? [] : await listCheckpointAmendments(kv, endpoint, token);
    const answer = token !== undefined && e.kind === "ask" ? await acceptedAskAnswer(kv, endpoint, token) : row.answer;
    rows.push({
      ...row,
      ...(answer !== undefined ? { answer } : {}),
      ...(amendments.length === 0 ? {} : { amendments: amendments.map((a) => ({
        answerId: a.answerId,
        supersedes: a.supersedes as string,
        ...(a.value !== undefined ? { value: a.value } : {}),
        by: a.by,
        ...(a.artifact !== undefined ? { artifact: a.artifact } : {}),
        at: a.at,
      })) }),
    });
  }
  return rows;
}

export const cotalLangRunHost: RunHost = {
  kind: RUN_HOST_KIND,
  name: COTAL_LANG_RUN_HOST,

  validate(source: string, file?: string): RunValidation {
    try {
      const { ast } = validate(source, file);
      const placements = new Map<string, { endpoint: string; instanceId: string }>();
      const problems: Record<string, unknown>[] = [];
      const problem = (node: Record<string, unknown>, cause: string): void => {
        const loc = node.loc as { start?: { line?: unknown; column?: unknown } } | undefined;
        const line = typeof loc?.start?.line === "number" ? loc.start.line : 1;
        const column = typeof loc?.start?.column === "number" ? loc.start.column + 1 : 1;
        problems.push({
          code: "L3048",
          title: CATALOG.L3048,
          where: { file: file ?? "program.cotal.js", line, column, frame: codeFrame(source, { file: file ?? "program.cotal.js", line, column }) },
          cause,
          fix: "write placement as { endpoint: \"manager\", instanceId: \"<literal instance id>\" }; a hosted run must know the exact target before it mints its credential",
          callee: primitiveDoc("spawn"),
        });
      };
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const child of value) visit(child);
          return;
        }
        if (value === null || typeof value !== "object") return;
        const node = value as Record<string, unknown>;
        if (node.type === "CallExpression") {
          const callee = node.callee as Record<string, unknown> | undefined;
          const args = node.arguments as unknown[] | undefined;
          if (callee?.type === "Identifier" && callee.name === "spawn" && Array.isArray(args)) {
            const options = args[1] as Record<string, unknown> | undefined;
            const properties = options?.type === "ObjectExpression" ? options.properties as unknown[] | undefined : undefined;
            const named = (list: unknown[] | undefined, name: string): Record<string, unknown> | undefined =>
              list?.find((item) => {
                const property = item as Record<string, unknown>;
                const key = property.key as Record<string, unknown> | undefined;
                return property.type === "Property"
                  && ((key?.type === "Identifier" && key.name === name) || (key?.type === "Literal" && key.value === name));
              }) as Record<string, unknown> | undefined;
            const placement = named(properties, "placement");
            const placementValue = placement?.value as Record<string, unknown> | undefined;
            const fields = placementValue?.type === "ObjectExpression" ? placementValue.properties as unknown[] | undefined : undefined;
            const literal = (name: string): string | undefined => {
              const valueNode = named(fields, name)?.value as Record<string, unknown> | undefined;
              return valueNode?.type === "Literal" && typeof valueNode.value === "string" ? valueNode.value : undefined;
            };
            const endpoint = literal("endpoint");
            const instanceId = literal("instanceId");
            const optionsSpread = properties?.find((item) => (item as Record<string, unknown>).type === "SpreadElement") as Record<string, unknown> | undefined;
            const placementSpread = fields?.find((item) => (item as Record<string, unknown>).type === "SpreadElement") as Record<string, unknown> | undefined;
            // A present option argument must be an object literal. The host cannot evaluate a
            // conditional, identifier, or call before minting the placement credential.
            if (options !== undefined && options.type !== "ObjectExpression")
              problem(options, "this hosted spawn computes its option bag, so placement authority may be hidden in a value the manager cannot inspect before credential minting");
            // Reject every option-bag spread instead of simulating property order. The spread's
            // value is not statically visible, so it can hide or replace the placement authority.
            else if (optionsSpread !== undefined)
              problem(optionsSpread, "this hosted spawn spreads its option bag, so placement authority may be hidden in a value the manager cannot inspect before credential minting");
            else if (placement !== undefined && (placementValue?.type !== "ObjectExpression" || endpoint === undefined || instanceId === undefined || endpoint.length === 0 || instanceId.length === 0 || placementSpread !== undefined))
              problem(placement, "this hosted spawn computes or spreads its placement target, but the manager must mint the exact instance rail before the program starts");
            else if (endpoint !== undefined && instanceId !== undefined)
              placements.set(`${endpoint}\u0000${instanceId}`, { endpoint, instanceId });
          }
        }
        for (const child of Object.values(node)) visit(child);
      };
      visit(ast);
      if (problems.length > 0) return { ok: false, errors: problems };
      return { ok: true, ...(placements.size > 0 ? { placements: [...placements.values()] } : {}) };
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
    // The admission the HOST loaded is pinned to this drive's coordinates; every channel effect
    // then re-reads it leader-served over the mediator (SPEC 14.8), so a revocation marker lands
    // within one effect and a store that cannot be read refuses rather than proceeding.
    const admitted = req.admission.admission;
    if (admitted.space !== planes.space || admitted.endpoint !== req.endpoint || admitted.runId !== req.runId)
      throw new Error(`run ${req.runId}: the admission handed to the drive names ${admitted.space}/${admitted.endpoint}/${admitted.runId}; refused (SPEC 14.8)`);
    const admission = () => readRunAdmission(mediator.jsm, planes.space, req.endpoint, req.runId);
    const handler = createRunEffectHost(mediator, {
      space: planes.space, endpoint: req.endpoint, runId: req.runId,
      caller: runDriverCaller(req.runId, admitted.caller.owner), instanceId: req.instanceId, epoch: req.epoch,
      holder: req.holder, defaultCheckpointTimeout: req.defaultCheckpointTimeout,
    }, authority, admission);
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

  async locateAccepted(planes: RunHostPlanes, req: RunHostLocateRequest): Promise<RunHostAcceptedAnswer> {
    return await locateAcceptedAnswer(
      { kv: planes.kv, js: planes.js, jsm: planes.jsm, space: planes.space, endpoint: req.endpoint },
      { runId: req.runId, stepKey: req.stepKey, takeoverId: req.takeoverId },
    );
  },

  async amend(planes: RunHostPlanes, req: RunHostAmendRequest): Promise<unknown> {
    return await amendAcceptedAnswer(
      { kv: planes.kv, js: planes.js, jsm: planes.jsm, space: planes.space, endpoint: req.endpoint },
      {
        accepted: req.accepted,
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
      journal: await journalRows(planes.kv, req.endpoint, replay.records),
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
      // The revocation marker beside the record, as `run ps --local` reads it. Only a driver writes
      // the record, so a run whose driver died keeps `running` there after a revoke. A marker read
      // that fails is carried as such: "no marker" and "could not look" are different answers.
      let revocation: Pick<RunListRow, "revoked" | "revocationUnreadable"> = {};
      try {
        const r = await readRunRevocation(planes.jsm, planes.space, endpoint, runId);
        if (r !== undefined) revocation = { revoked: { by: r.by, reason: r.reason } };
      } catch (err) {
        revocation = { revocationUnreadable: (err as Error).message };
      }
      // The run's identity as its program's `run()` reports it: the pinned epoch, and the language's
      // hash of the recorded source, which is what every resume runs (other source is a fork).
      const program = await readRunProgram(planes.kv, endpoint, runId);
      rows.push({
        runId,
        endpoint,
        ...(st !== undefined ? { state: st.state, holder: st.holder, epoch: st.epoch, journalHigh: st.journalHigh } : {}),
        ...(lineage !== undefined ? { forkedFrom: lineage } : {}),
        startedAt: record.spec.value.pins.startedAt,
        ...(program !== undefined ? { programHash: programHashOf(program.source) } : {}),
        ...revocation,
      });
    }
    return rows;
  },
};

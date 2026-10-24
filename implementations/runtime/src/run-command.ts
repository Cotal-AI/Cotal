/**
 * `cotal run` — the workflow-run operator surface.
 *
 * Five verbs: `start` drives a new run, `resume` takes an existing run over, `ps` lists the run
 * records of an endpoint, `journal` prints a run's durable step journal, and `answer` resolves an
 * open checkpoint, or an open `ask` attempt, through the run driver, which is the only door an
 * answer has (§14).
 *
 * By default every verb is a CLIENT of the mesh's manager (SPEC 14.3): the manager hosts the
 * driver on its own per-run credential, so `start` and `resume` return the run id at once and the
 * run keeps going after this terminal closes, survives a manager restart, and is answered from
 * anywhere. `--local` keeps the older composition, in this process: one raw connection, the mesh
 * handler bound to this process as holder, the drive held until it settles. It is for a bare broker
 * with no manager, for a program a manager cannot host (one recorded before programs were recorded),
 * and for the driver's own tests. Checkpoint EXPIRY rides the mediated timer writer, which the
 * delivery daemon pumps on a live mesh; a local `start` on a bare broker still runs and still
 * resolves, it just cannot expire a pause.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import {
  BASELINE_LIFECYCLE_ENDPOINT,
  chatStream,
  EpEnvelopeError,
  isStreamNotFound,
  hasDuplicateNames,
  assertIdToken,
  assertLifecycleToken,
  LANG_PROBLEM_DETAIL_KIND,
  dialerFor,
  freezeExpectedSet,
  invokeRepairingSplit,
  noLiveInstances,
  newTakeoverId,
  newIdentity,
  mintCreds,
  issuedUserCaller,
  openRecordsBucket,
  admissionBucket,
  createRunAdmission,
  readRunAdmission,
  revokeRunAdmission,
  chatSubject,
  DEV_OWNER,
  type RunAdmission,
  type RunAdmissionView,
  type IssuedSubjectAllow,
  readRunProgram,
  readRunRecord,
  renderLifecycleBlocked,
  replayRunJournal,
  resolveService,
  runDriverCaller,
  RUN_LAUNCH_DEADLINE_MS,
  standaloneConnectOpts,
  oneLine,
  unansweredRail,
  unansweredRequest,
  type EpError,
  type EpErrorDetail,
  type ParsedArgs,
  type RunJournalRow,
  type RunListRow,
  type RunStatusValue,
  type RunStatusView,
  type RunHostPlanes,
  type RunDriverGrantArgs,
} from "@cotal-ai/core";
import { LangErrors, RunHeld, type JournalEntry, type RunPins } from "@cotal-ai/lang";
import {
  CommandFailure,
  commandFailureReport,
  failureEnvelope,
  presentationOf,
  recordOperationSpace,
  renderReport,
  terminalWidth,
  writeEnvelope,
  connectOrExit,
  controlCaller,
  endpointAuth,
  resolveControlTarget,
  resolveSeatControlTarget,
  type ConnectOpts,
  type Connection,
  type ControlAuth,
  type ControlTarget,
  type RefusalCode,
  localStackRoot,
  spaceStreamsAbsent,
  spaceStreamsExpected,
  connectOrThrow,
  isConnectRefusal,
} from "@cotal-ai/workspace";
import { offlineWorkflow, sourceOf } from "./offline-command.js";
import { seatTurnCommand } from "./seat-turn-command.js";
import { openRequestKeys, printRunDetail, printRunList, runReceipt } from "./workflow-views.js";
import { startRun, driveRun, type DriveOutcome } from "./run-driver.js";
import { migrateRun, type MigrateReport } from "./migrate.js";
import { cotalLangRunHost as runHost, journalRows } from "./run-host.js";
import { createRunEffectHost } from "./run-effect-host.js";
import { createRunScopeAuthority } from "./run-scope-authority.js";
import { createRunRecordHost, runRecordView } from "./run-record-host.js";
import { logLineText } from "./log-line.js";
import { locateOpenCheckpoint, answerOpenCheckpoint, locateAcceptedAnswer, amendAcceptedAnswer, RunAnswerBlocked } from "./resolve-checkpoint.js";

const USAGE =
  'usage: cotal run <start --file <program> [--timeout <dur>] | resume <runId> [--local --file <program>] | ps [--endpoint <ep>] [--json] [--page [--limit <n>] [--cursor <cursor>]] | journal <runId> [--endpoint <ep>] [--limit <n>] [--json] | answer <runId> <stepKey> [--value <json>] [--artifact <ref>] [--endpoint <ep>] [--local --by <who>] | amend <runId> <stepKey> [--value <json>] [--artifact <ref>] [--endpoint <ep>] [--local --by <who>] | revoke <runId> --local --by <who> --reason <text> [--endpoint <ep>] | migrate <runId> --local --file <program> [--endpoint <ep>]> [--local [--admit-read <channels> --admit-publish <channels>]] [--on <instance>] [--space <s>] [--server <url>] [--creds <path>]';

interface RunValues {
  space?: string;
  server?: string;
  creds?: string;
  file?: string;
  endpoint?: string;
  on?: string;
  timeout?: string;
  by?: string;
  value?: string;
  artifact?: string;
  local?: boolean;
  /** `--local start` only: the channel ceiling the operator admits the run under (SPEC 14.8),
   *  comma-separated channel patterns; `none` is deny-all. Both are REQUIRED for a local start:
   *  a local run never defaults to the host's own scope. */
  "admit-read"?: string;
  "admit-publish"?: string;
  /** `revoke --local` only: why the run's admission is being revoked, recorded on the marker. */
  reason?: string;
  /** `migrate` only: commit-side overrides, parsed so the verb can REFUSE them by name rather than
   *  let the dispatcher reject them as unknown flags. Each decides what a commit does with an
   *  orphan; this verb only checks, so none is taken. */
  adopt?: string;
  release?: string;
  "discard-approvals"?: boolean;
  /** `ps` and `journal` only: one JSON object per row per line on stdout. */
  json?: boolean;
  page?: boolean;
  /** `ps --page`: the page's row limit. `journal`: how many of the last journal rows the text view prints. */
  limit?: string;
  cursor?: string;
  plain?: boolean;
  handler?: string;
  status?: string;
  to?: string;
  note?: string;
}

interface Planes {
  connection: Connection;
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  kv: KV;
  space: string;
  resultBytes?: number;
  close(): Promise<void>;
}

/** One raw connection to the resolved mesh under the verb's OWN profile, with the planes over it.
 *  A drive rides the run's `run-driver` credential (SPEC 14.6), minted for the one run and attempt
 *  it drives; a read or an answer rides a one-shot `run-operator` credential for that call. An
 *  open mesh connects bare either way. */
async function openPlanes(values: RunValues, role: "run-driver" | "run-operator", mint: NonNullable<ConnectOpts["mint"]>): Promise<Planes> {
  const conn = await connectOrThrow(values, role, { mint });
  const nc = await dialerFor(conn.server)({
    servers: conn.server,
    ...standaloneConnectOpts({ ...endpointAuth(conn), tls: conn.tls }),
  });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, conn.space);
  const max = nc.info?.max_payload;
  return {
    connection: conn,
    nc,
    js,
    jsm,
    kv,
    space: conn.space,
    // The broker's own max_payload, minus headroom for the record envelope around the entry. A
    // real measured bound, handed to the journal so an oversized result is refused AHEAD of the
    // settling append (L5006) instead of dying at the store.
    ...(typeof max === "number" && max > 4096 ? { resultBytes: max - 4096 } : {}),
    close: async () => {
      await nc.drain().catch(() => {});
    },
  };
}

/** A local drive mints its mediator and its admitter from the folder's signer; a lone `--creds`
 *  file can supply neither, and is refused by name before any other local check. */
function refuseSingleCredential(conn: Connection): void {
  if (conn.creds !== undefined && conn.auth === undefined)
    throw new CommandFailure("refused", "USAGE_INVALID", "run --local needs the space signer to mint a separate mediator; a single --creds file cannot supply both roles", {
      remedy: "From the project with the recorded static-auth mesh and signer, omit --creds and run cotal run start --local --space <space> --file <program>. If you only have caller credentials, ask the mesh operator to host the run.",
    });
}

/** Mint from the same resolved target as the driver, preserving its broker and TLS intent. */
async function openMediator(driver: Planes, pin: RunDriverGrantArgs): Promise<RunHostPlanes> {
  const conn = driver.connection;
  refuseSingleCredential(conn);
  const creds = conn.auth === undefined ? undefined : await mintCreds(conn.auth, newIdentity(), "run-mediator", { runMediator: pin });
  const nc = await dialerFor(conn.server)({ servers: conn.server, ...standaloneConnectOpts({ creds, tls: conn.tls }) });
  try {
    return { nc, js: jetstream(nc), jsm: await jetstreamManager(nc), kv: await openRecordsBucket(nc, conn.space), space: conn.space };
  } catch (error) {
    await nc.close();
    throw error;
  }
}

/**
 * This process, as the run record will name it. Fresh per invocation, ID INCLUDED: two concurrent
 * drives of one run derive the same fencing token and epoch from one record read, and the
 * activation barrier deliberately relaxes the exact (token, holder, epoch) tuple as a process
 * picking its own run back up — so a constant id would let a second concurrent drive co-activate
 * through that relaxation instead of being refused. The local admission also uses this id as
 * its actor, so it must use the owner-token alphabet.
 */
function cliHolder(): { id: string; lifecycleUid: string; instanceId: string } {
  const uid = randomUUID().replaceAll("-", "");
  return { id: `cli_run_${uid.slice(0, 8)}`, lifecycleUid: `u_${uid.slice(0, 20)}`, instanceId: uid.slice(0, 26) };
}

function readProgram(values: RunValues): string {
  if (values.file === undefined) {
    console.error(USAGE);
    console.error("run start: --file <program> is required");
    process.exit(1);
  }
  return sourceOf(values.file);
}

/**
 * The source a resume runs: the recorded program, or the file when one is given.
 *
 * A file that disagrees with the record is refused: a resume onto different source is a fork or a
 * migration, each of which files its own record, and driving the edited source under the old run id
 * would replay steps whose input hashes the new program does not produce (L5002).
 */
async function resumeSource(values: RunValues, planes: Planes, endpoint: string, runId: string): Promise<string> {
  const recorded = await readRunProgram(planes.kv, endpoint, runId);
  if (values.file === undefined) {
    if (recorded === undefined) {
      console.error(`run ${runId}: no program is recorded for it (it was started before programs were recorded); pass --file <program> with the source it was started from`);
      process.exit(1);
    }
    return recorded.source;
  }
  const source = sourceOf(values.file);
  if (recorded !== undefined && recorded.source !== source) {
    console.error(`run ${runId}: ${values.file} is not the program this run was started from; a resume takes the recorded source (omit --file), and an edited program is a migration or a fork`);
    process.exit(1);
  }
  return source;
}

function reportOutcome(runId: string, out: DriveOutcome): void {
  if (out.status === "completed") {
    const r = out.result;
    console.log(`run ${runId}: completed in ${r.steps} step(s)`);
    if (r.value !== undefined) console.log(JSON.stringify(r.value, null, 2));
    return;
  }
  const reason = out.reason;
  console.log(`run ${runId}: released — ${reason.name}: ${reason.message.split("\n")[0]}`);
  if (reason instanceof RunHeld) {
    console.log(
      reason.pending
        ? "the run is held: one at-most-once step's hold could not be opened and its entry stays `pending`, and a resume on a host that can open a checkpoint reopens the hold without dispatching the step again"
        : "the run is held: one step is settled `refused`, and a resume on a host that can perform it continues exactly there",
    );
  }
  process.exitCode = 2;
}

async function start(values: RunValues): Promise<void> {
  const source = readProgram(values);
  const endpoint = values.endpoint ?? "manager";
  // Minted here, never caller-supplied: the records table binds run-id minting to the driver.
  // 128 bits, the width the spec's other minted identifiers carry, so a colliding start is
  // outside any realistic horizon rather than a rare one-shot refusal.
  const runId = `run-${randomBytes(16).toString("hex")}`;
  const who = cliHolder();
  const takeoverId = newTakeoverId();
  const planes = await openPlanes(values, "run-driver", { runDriver: { endpoint, runId, takeoverId, instanceId: who.instanceId, epoch: 1 } });
  try {
    const admission = await admitLocal(values, planes, { endpoint, runId, who });
    await drive(values, planes, { endpoint, runId, source, who, epoch: 1, fencingToken: 1, takeoverId, mode: "new", admission });
  } finally {
    await planes.close();
  }
}

/** The explicit admission of a LOCAL run (SPEC 14.8): the operator names the channel ceiling on
 *  the command line, the record is written create-only under a one-shot `run-admitter` credential
 *  from the folder's trust material, and the provenance says who admitted it and why. A local
 *  start with no ceiling named is refused; the host's own scope is never the default. */
async function admitLocal(values: RunValues, planes: Planes, a: { endpoint: string; runId: string; who: ReturnType<typeof cliHolder> }): Promise<RunAdmissionView> {
  const conn = planes.connection;
  refuseSingleCredential(conn);
  const read = values["admit-read"];
  const publish = values["admit-publish"];
  if (read === undefined || publish === undefined) {
    console.error("run start --local: --admit-read <channels> and --admit-publish <channels> are required; a local run is admitted under the ceiling you name (comma-separated channel patterns, or `none`), never under this process's own scope");
    process.exit(1);
  }
  if (conn.auth === undefined) {
    console.error("run start --local: an open mesh keeps no admission store; a run there is not admitted and performs no channel effect. Run it on a static-auth mesh from its project folder.");
    process.exit(1);
  }
  const caller = { owner: DEV_OWNER, actor: a.who.id, uid: a.who.lifecycleUid };
  const allow = (spec: string, direction: "read" | "publish"): IssuedSubjectAllow => {
    const channels = spec.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (channels.length === 1 && channels[0] === "none") return { mode: "none" };
    if (channels.length === 0) throw new Error(`--admit-${direction}: name at least one channel, or \`none\``);
    return { mode: "patterns", patterns: channels.map((ch) => direction === "read" ? chatSubject(conn.space, "*", "*", ch) : chatSubject(conn.space, caller.owner, caller.actor, ch)) };
  };
  const admission: RunAdmission = {
    version: 1,
    space: conn.space,
    endpoint: a.endpoint,
    runId: a.runId,
    instanceId: a.who.instanceId,
    caller,
    ceiling: { publish: { allow: allow(publish, "publish"), deny: [] }, subscribe: { allow: allow(read, "read"), deny: [] } },
    provenance: { kind: "operator", by: a.who.id, reason: `cotal run start --local --admit-read ${read} --admit-publish ${publish}` },
    admittedAt: Date.now(),
  };
  const creds = await mintCreds(conn.auth, newIdentity(), "run-admitter", { runAdmitter: { endpoint: a.endpoint, runId: a.runId } });
  const nc = await dialerFor(conn.server)({ servers: conn.server, ...standaloneConnectOpts({ creds, tls: conn.tls }), maxReconnectAttempts: 0 });
  try {
    await createRunAdmission(await new Kvm(nc).open(admissionBucket(conn.space)), admission);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
  return { admission, revoked: undefined };
}

/** `revoke --local`: write the run's revocation marker (SPEC 14.8) under a one-shot `run-admitter`
 *  credential from the folder's trust material. The admission itself is never rewritten; the
 *  marker is create-only and idempotent, and every host reads it before its next channel effect,
 *  so an open wait refuses within one poll and no resume or takeback continues the run. */
async function revoke(values: RunValues, runId: string | undefined): Promise<void> {
  if (runId === undefined || values.by === undefined || values.reason === undefined) {
    console.error(USAGE);
    console.error("run revoke: <runId>, --by <who> and --reason <text> are required");
    process.exit(1);
  }
  const endpoint = values.endpoint ?? "manager";
  const conn = await connectOrThrow(values, "run-admitter", { mint: { runAdmitter: { endpoint, runId } } });
  refuseSingleCredential(conn);
  if (conn.auth === undefined) {
    console.error("run revoke: an open mesh keeps no admission store, so there is nothing to revoke there");
    process.exit(1);
  }
  const nc = await dialerFor(conn.server)({ servers: conn.server, ...standaloneConnectOpts({ ...endpointAuth(conn), tls: conn.tls }), maxReconnectAttempts: 0 });
  try {
    const kv = await new Kvm(nc).open(admissionBucket(conn.space));
    await revokeRunAdmission(kv, endpoint, { version: 1, runId, reason: values.reason, by: values.by, revokedAt: Date.now() });
    const view = await readRunAdmission(await jetstreamManager(nc), conn.space, endpoint, runId);
    console.log(`run ${runId} on ${endpoint}: revoked by ${view.revoked!.by} (${view.revoked!.reason}); its hosts refuse the next channel effect, and it is not resumed or taken back`);
    // What the operator will see NEXT, because the two surfaces disagreed for as long as one of
    // them never read the marker. Saying it here means the acknowledgement and the table cannot
    // drift apart without somebody noticing at the moment of the revoke.
    console.log(`run ps now lists ${runId} as revoked; the status record is left as its driver last wrote it`);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

async function resume(values: RunValues, runId: string | undefined): Promise<void> {
  if (runId === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  const endpoint = values.endpoint ?? "manager";
  // The record and the recorded program are READ under a one-shot operator credential, since the
  // driver's own credential is minted for an epoch the record decides.
  const reader = await openPlanes(values, "run-operator", { runOperator: { endpoint, runId, takeoverId: newTakeoverId() } });
  let source: string;
  let status: RunStatusValue | undefined;
  let admission: RunAdmissionView;
  try {
    const record = await readRunRecord(reader.kv, endpoint, runId);
    if (record === undefined) {
      console.error(`run ${runId}: no record on endpoint ${endpoint}; a run that was never started cannot be resumed`);
      process.exit(1);
    }
    source = await resumeSource(values, reader, endpoint, runId);
    status = record.status?.value;
    // The ORIGINAL admission (SPEC 14.8): a resume continues under it, never under a new one.
    admission = await readRunAdmission(reader.jsm, reader.space, endpoint, runId);
    if (admission.revoked !== undefined) {
      console.error(`run ${runId}: revoked by ${admission.revoked.by} (${admission.revoked.reason}); a revoked run is not resumed`);
      process.exit(1);
    }
  } finally {
    await reader.close();
  }
  const who = cliHolder();
  const epoch = (status?.epoch ?? 0) + 1;
  const takeoverId = newTakeoverId();
  const planes = await openPlanes(values, "run-driver", { runDriver: { endpoint, runId, takeoverId, instanceId: who.instanceId, epoch } });
  try {
    await drive(values, planes, { endpoint, runId, source, who, epoch, fencingToken: (status?.fencingToken ?? 0) + 1, takeoverId, mode: "existing", admission });
  } finally {
    await planes.close();
  }
}

/** One drive attempt in this process: the handler bound to this invocation as holder, the run
 *  held until it settles. */
async function drive(
  values: RunValues,
  planes: Planes,
  a: { endpoint: string; runId: string; source: string; who: ReturnType<typeof cliHolder>; epoch: number; fencingToken: number; takeoverId: string; mode: "new" | "existing"; admission: RunAdmissionView },
): Promise<void> {
  const { endpoint, runId, source, who, epoch, fencingToken, takeoverId } = a;
  const mediator = await openMediator(planes, { endpoint, runId, takeoverId, instanceId: who.instanceId, epoch });
  try {
    const authority = createRunScopeAuthority(mediator, runId, { holder: who.id, epoch, fencingToken, takeoverId });
    const admitted = a.admission.admission;
    if (admitted.space !== planes.space || admitted.endpoint !== endpoint || admitted.runId !== runId)
      throw new Error(`run ${runId}: the admission names ${admitted.space}/${admitted.endpoint}/${admitted.runId}; refused (SPEC 14.8)`);
    const handler = createRunEffectHost(mediator, {
      space: planes.space, endpoint, runId, caller: runDriverCaller(runId), instanceId: who.instanceId,
      epoch, holder: { id: who.id, lifecycleUid: who.lifecycleUid },
      defaultCheckpointTimeout: values.timeout ?? "1h",
    }, authority, () => readRunAdmission(mediator.jsm, planes.space, endpoint, runId));
    const req = {
      space: planes.space,
      endpoint,
      runId,
      source,
      kv: runRecordView(planes.kv, createRunRecordHost(mediator, endpoint, runId), planes.space),
      lease: { holder: who.id, epoch, fencingToken, takeoverId },
      handler,
      ...(values.file !== undefined ? { file: values.file } : {}),
      ...(planes.resultBytes !== undefined ? { resultBytes: planes.resultBytes } : {}),
      onLog: (line: { readonly scope: string; readonly values: readonly unknown[] }) => console.log(`run ${runId}: log ${logLineText(line)}`),
    };
    if (a.mode === "new") console.log(`starting run ${runId} on endpoint ${endpoint} in space ${planes.space}`);
    const out = a.mode === "new" ? await startRun(planes.js, planes.jsm, req) : await driveRun(planes.js, planes.jsm, req);
    reportOutcome(runId, out);
  } finally {
    await mediator.nc.drain().catch(() => mediator.nc.close());
  }
}

async function ps(values: RunValues, planes: Planes): Promise<void> {
  // The same rows the manager answers `run-ps` with, read under this call's operator credential:
  // the record's state beside its revocation marker (SPEC 14.8), so `--local` and hosted agree
  // row for row, `--json` included.
  const rows = await runHost.list(planes, values.endpoint !== undefined ? { endpoint: values.endpoint } : {});
  printRunList(planes.space, rows, values);
}

async function journal(values: RunValues, planes: Planes, endpoint: string, runId: string | undefined, takeoverId: string): Promise<void> {
  if (runId === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  // The replay durable is named by the takeover id this call's credential was minted for.
  const view = await runHost.status(planes, { endpoint, runId, takeoverId });
  if (!view) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no workflow record was returned for this run", { target: { space: planes.space, endpoint, run: runId } });
  printRunDetail(planes.space, view, values);
}

/** `answer --local`: the pause is found under the READ credential this call was opened on, then
 *  the answer rides a second, one-shot credential pinned to that pause's token. */
async function answer(values: RunValues, reader: Planes, runId: string | undefined, stepKey: string | undefined, takeoverId: string): Promise<void> {
  if (runId === undefined || stepKey === undefined || values.by === undefined) {
    console.error(USAGE);
    console.error("run answer: <runId> <stepKey> and --by <who> are required");
    process.exit(1);
  }
  const endpoint = values.endpoint ?? "manager";
  const parsedValue = parseAnswerValue(values);
  const open = await locateOpenCheckpoint(
    { kv: reader.kv, js: reader.js, jsm: reader.jsm, space: reader.space, endpoint },
    { runId, stepKey, takeoverId },
  );
  // Resume is holder-bound (SPEC 13.10) and the CLI is not the driver: the resolver presents as
  // the ARMING holder it read off the checkpoint's own record, so a fresh invocation answers
  // exactly as the minter would have. The answerer's name rides `by`, never the presenter.
  const writer = await openPlanes(values, "run-operator", { runOperator: { endpoint, takeoverId: newTakeoverId(), answers: { token: open.token } } });
  try {
    const result = await answerOpenCheckpoint(
      { kv: writer.kv, js: writer.js, jsm: writer.jsm, space: writer.space, endpoint },
      {
        open,
        by: values.by,
        ...(values.value !== undefined ? { value: parsedValue } : {}),
        ...(values.artifact !== undefined ? { artifact: values.artifact } : {}),
        now: Date.now(),
      },
    ).catch((e: unknown) => {
      if (e instanceof RunAnswerBlocked) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", e.message, { target: { space: writer.space, endpoint, run: runId }, native: { code: e.code } });
      throw e;
    });
    runReceipt("answer", reader.space, result, values, runId, { step: stepKey, ...(values.value !== undefined ? { value: parsedValue } : {}), ...(values.artifact !== undefined ? { artifact: values.artifact } : {}) });
  } finally {
    await writer.close();
  }
}

/** `amend --local`: the accepted answer is found under the READ credential this call was opened on,
 *  then the amendment rides a second, one-shot credential pinned to that pause's token. Nothing is
 *  presented: the step stays settled and the run keeps the answer it acted on. */
async function amend(values: RunValues, reader: Planes, runId: string | undefined, stepKey: string | undefined, takeoverId: string): Promise<void> {
  if (runId === undefined || stepKey === undefined || values.by === undefined) {
    console.error(USAGE);
    console.error("run amend: <runId> <stepKey> and --by <who> are required");
    process.exit(1);
  }
  const endpoint = values.endpoint ?? "manager";
  const parsedValue = parseAnswerValue(values);
  const accepted = await locateAcceptedAnswer(
    { kv: reader.kv, js: reader.js, jsm: reader.jsm, space: reader.space, endpoint },
    { runId, stepKey, takeoverId },
  );
  const writer = await openPlanes(values, "run-operator", { runOperator: { endpoint, takeoverId: newTakeoverId(), answers: { token: accepted.token } } });
  try {
    const result = await amendAcceptedAnswer(
      { kv: writer.kv, js: writer.js, jsm: writer.jsm, space: writer.space, endpoint },
      {
        accepted,
        by: values.by,
        ...(values.value !== undefined ? { value: parsedValue } : {}),
        ...(values.artifact !== undefined ? { artifact: values.artifact } : {}),
        now: Date.now(),
      },
    );
    runReceipt("amend", reader.space, result, values, runId, { step: stepKey, ...(values.value !== undefined ? { value: parsedValue } : {}), ...(values.artifact !== undefined ? { artifact: values.artifact } : {}) });
  } finally {
    await writer.close();
  }
}

/** Parse `--value` as JSON, with the one hint every first-time user needs. */
function parseAnswerValue(values: RunValues): unknown {
  if (values.value === undefined) return undefined;
  try {
    return JSON.parse(values.value);
  } catch {
    console.error(`run answer: --value is not valid JSON: ${values.value}`);
    console.error('a bare string needs its own quotes, e.g. --value \'"yes"\'');
    process.exit(1);
  }
}

/** `migrate`: the migrate check over an edited program, read-only. Everything it needs — the run
 *  record (for the pins, read back rather than re-derived), the journal (replayed as the barrier
 *  replays it), the edited source — is read under the same one-shot `run-operator` credential
 *  `journal` reads on. `commitMigration` is NOT wired here: the verb decides, it does not file. */
async function migrate(values: RunValues, planes: Planes, runId: string | undefined, takeoverId: string): Promise<void> {
  if (runId === undefined || values.file === undefined) {
    console.error(USAGE);
    console.error("run migrate: <runId> and --file <program> are required");
    process.exit(1);
  }
  // Commit-side overrides, refused by name: each one records a person's decision on a report the
  // commit would file, and a check that accepted one would be reporting a decision nobody filed.
  for (const [flag, what] of [
    ["adopt", "--adopt <handle>"],
    ["release", "--release <handle>"],
    ["discard-approvals", "--discard-approvals"],
  ] as const) {
    if (values[flag] !== undefined) {
      console.error(`run migrate: ${what} decides what a COMMIT does with an orphan, and this verb only checks; nothing was written`);
      process.exit(1);
    }
  }
  const endpoint = values.endpoint ?? "manager";
  const record = await readRunRecord(planes.kv, endpoint, runId);
  if (record === undefined) {
    console.error(`run ${runId}: no record on endpoint ${endpoint}; a run that was never started cannot be migrated`);
    process.exit(1);
  }
  const replay = await replayRunJournal(planes.js, planes.jsm, planes.space, runId, takeoverId);
  const source = sourceOf(values.file);
  let report: MigrateReport;
  try {
    report = await migrateRun({
      endpoint,
      runId,
      source,
      file: values.file,
      entries: replay.records.flatMap((r) => (r.record.kind === "step" ? [r.record.entry as JournalEntry] : [])),
      pins: record.spec.value.pins as RunPins,
      kv: planes.kv,
      actor: "cotal run migrate",
      now: () => Date.now(),
    });
  } catch (e) {
    if (!(e instanceof LangErrors)) throw e;
    // Every problem with its position, cause and fix, as `run validate` lists them.
    console.error(`run migrate: ${values.file} is not valid cotal-lang (${e.errors.length} problem${e.errors.length === 1 ? "" : "s"}), so it was not checked against the journal`);
    for (const item of e.errors) console.error(`  ${item.code} ${item.title} (${item.span.file}:${item.span.line}:${item.span.column})\n    ${item.cause}\n    fix: ${item.fix}`);
    process.exit(1);
  }
  printMigrateReport(report);
  if (!report.admissible) process.exitCode = 1;
}

/** The report an operator reads: admissible or not, how far the walk accounted for the journal,
 *  every orphan with its verdict (and its code, on a rejection), the divergence and the unwalkable
 *  step when there is one, and the one line that says what this verb did NOT do. */
function printMigrateReport(r: MigrateReport): void {
  console.log(`run ${r.run}: ${r.admissible ? "admissible" : "not admissible"} — the edited program accounts for ${r.consumedThrough} journal row(s); moves to ${r.toHash}`);
  for (const o of r.orphans) {
    console.log(`  orphan  ${o.step}  ${o.kind}  ${o.verdict}${o.code !== undefined ? ` (${o.code})` : ""}`);
    console.log(`          ${o.why}`);
  }
  if (r.divergence !== undefined) {
    console.log(`  divergence  ${r.divergence.step}: recorded input ${r.divergence.recordedHash}, edited program hashes ${r.divergence.programHash}`);
  }
  if (r.unwalkable !== undefined) {
    console.log(`  unwalkable  ${r.unwalkable.step}: ${r.unwalkable.why}`);
  }
  console.log("a commit would file this report as a migration record and mark it applied; this verb filed nothing (the commit is not reachable yet)");
}

// ── the manager-hosted path (SPEC 14.3) ─────────────────────────────────────────────────────

/**
 * What a hosted `run` verb prints when its manager describe drew no answer, SCOPED TO THE RAIL the
 * describe rode ({@link unansweredRail}, SPEC 13.15).
 *
 * On the LEGACY `ep` rail there is one rail and nothing answered on it, so "is a manager running?"
 * is the right question and `--local` is the right remedy.
 *
 * On the VERSIONED (issued) rail it is not. SPEC 13.15 keeps the two rails disjoint at the broker
 * and requires an endpoint to serve both, so a manager older than the versioned rail subscribes
 * `ep` alone: it is running, it is on the roster, and this caller cannot reach it. #1630 measured
 * both halves of the damage. The question ASSERTS one of two causes, and `--local` is the remedy
 * that follows from it: it drives the run from this process and NAMES THE CALLER as its answerer,
 * so an operator who takes the tool's advice on a mesh whose manager is merely old submits an
 * answer under the wrong identity.
 *
 * So the versioned wording names BOTH causes and asserts neither, because this side cannot tell
 * them apart: the service registry records no package version. Naming only the skew is the same
 * defect one step over, and it is reachable - `bin/smoke/control-transport-dial.smoke.ts` runs a
 * fixture with no manager at all, and an operator there would have been sent to check a version.
 */
export function unansweredManagerRefusal(e: EpEnvelopeError): string {
  const detail = `${e.code}: ${e.message}`;
  const rail = unansweredRail(e);
  if (rail === undefined || rail === "ep")
    return `the manager registered for this space did not answer on the endpoint rails (${detail}); is a manager running for this mesh? A run can still be driven from this terminal with --local`;
  return `the manager registered for this space did not answer on the ${rail} rail (${detail}). The ${rail} and legacy ep rails are disjoint at the broker (SPEC 13.15) and an endpoint must serve both, so this does not tell no manager running apart from one older than ${rail}, which serves ep only and cannot answer here. Check whether a manager is running, and if it is, restart it on a build that serves ${rail}`;
}

/** The manager's refusal codes that say it acted on nothing. */
const REFUSED_BEFORE_EFFECT: Readonly<Record<string, RefusalCode>> = {
  "permission-denied": "PERMISSION_DENIED", "not-found": "TARGET_NOT_FOUND", "failed-precondition": "LIFECYCLE_BLOCKED",
  "bad-request": "USAGE_INVALID", "unimplemented": "UNSUPPORTED", "conflict": "CONFLICT",
};

/** The local journal read a refused hosted read names. */
const localJournal = (args: Record<string, unknown> | undefined): string => `cotal run journal ${typeof args?.runId === "string" ? args.runId : "<run-id>"} --local`;

/** A manager refusal under the CLI's outcome table, with the manager's own sentence. Any other code
 *  leaves a read failed and a start, resume or answer unconfirmed, because the manager may have
 *  recorded it. `on` is the caller's explicit manager pin, which a suggested command keeps. */
export function managerRefusal(command: string, space: string, args: Record<string, unknown> | undefined, err: EpError | undefined, on?: string): CommandFailure {
  const message = renderLifecycleBlocked(err?.message ?? err?.code ?? "the manager refused", err);
  const options = { target: { space }, native: { code: err?.code ?? "unreported" } };
  // A manager at its launch limit refuses `resource-exhausted` before writing anything, and says
  // so with `not-executed`.
  const busy = err?.code === "resource-exhausted" && err.outcome === "not-executed";
  const code = err?.code === undefined ? undefined : busy ? "LIFECYCLE_BLOCKED" : REFUSED_BEFORE_EFFECT[err.code];
  // A resume refused as a precondition, such as of a completed or failed run, appended nothing, so
  // the run's recorded state is what to read next.
  const resumeBlocked = command === "run-resume" && err?.code === "failed-precondition" && typeof args?.runId === "string";
  const remedy = busy ? { remedy: `wait until one of them has activated, then run ${command === "run-resume" ? "the resume" : "the start"} again; cotal run ps lists a run once it has` }
    : resumeBlocked ? { remedy: `read the run's recorded state with cotal run show ${args.runId}${on ? ` --on ${on}` : ""}` }
    : err?.code !== "not-found" ? {} : { remedy: command === "run-answer" && typeof args?.runId === "string" ? `read the run's open requests with cotal run show ${args.runId}` : "list the recorded runs with cotal run ps" };
  if (code) return new CommandFailure("refused", err!.details?.some((d) => d.kind === LANG_PROBLEM_DETAIL_KIND) ? "SCHEMA_INVALID" : code, message, { ...options, ...remedy });
  // A reply too large for the broker changed nothing; the local read takes no reply.
  if (command === "run-status" && err?.code === "resource-exhausted")
    return new CommandFailure("refused", "UNSUPPORTED", message, { ...options, remedy: `read the run from its project folder with ${localJournal(args)}` });
  if (command === "run-status" || command === "run-ps") return new CommandFailure("failed", "OPERATION_FAILED", message, options);
  return new CommandFailure("unknown", "OPERATION_UNKNOWN", message, { ...options, remedy: "read the run with cotal run show or cotal run ps before trying again; it was not retried" });
}

/** nats.js refuses a frame over the broker's `max_payload` before writing any of it. */
function payloadRefused(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) if (e.name === "InvalidArgumentError" && e.message.includes("max_payload")) return true;
  return false;
}

/** While a hosted start's request may be with the manager, a SIGINT or SIGTERM reports that the run
 *  may already be recorded and exits as the signal would. The manager does not stop on the caller's
 *  signal, so the process used to die silently with the run started, and a retry started a second
 *  one. Returns the release. */
function reportInterruptedStart(values: RunValues, space: string): () => void {
  const exit = (signal: "SIGINT" | "SIGTERM"): void => {
    const failure = new CommandFailure("unknown", "OPERATION_UNKNOWN", "interrupted after the start request was sent, so the manager may already have recorded the run", {
      target: { space }, remedy: "list the recorded runs with cotal run ps before starting it again",
    });
    if (values.json) writeEnvelope(failureEnvelope("run", failure));
    process.stderr.write(`${renderReport(commandFailureReport(failure), values.plain ? "plain" : "rich", terminalWidth(process.stderr))}\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onInterrupt = () => exit("SIGINT");
  const onTerminate = () => exit("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); };
}

/** One command to the mesh's manager over the endpoint rails: a fresh resolve (describe, store
 *  fetch, digest-verified recompile), then the invoke, re-issued after a bind split
 *  ({@link invokeRepairingSplit}). The reply's data on success; a refusal throws as
 *  {@link managerRefusal} classifies it. */
async function askHost(values: RunValues, command: string, args: Record<string, unknown> | undefined, resolved?: (space: string) => void): Promise<unknown> {
  const { target: t, seat } = await resolveRunControlTarget(values);
  resolved?.(t.space);
  const who = controlCaller(t.auth);
  // A raw --creds file carries no endpoint-caller triple, and this route cannot mint one. Without
  // --creds the CLI mints the one-shot caller from the space's trust or the signed-in login.
  if ("refusal" in who)
    throw new CommandFailure("refused", "UNSUPPORTED", "a hosted run command cannot use a raw --creds file: it carries no endpoint-caller triple (owner, actor, lifecycle uid), and this route cannot mint one; nothing was sent", {
      target: { space: t.space },
      remedy: "run it again without --creds: in the mesh's project folder, or with --space naming its registry entry, the CLI mints the one-shot caller itself",
    });
  const auth: ControlAuth = t.auth;
  const connectOpts = standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: auth.tls === true } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds, tls: auth.tls === true } : { tls: auth.tls === true });
  const nc = await dialerFor(t.server)({ servers: t.server, ...connectOpts, maxReconnectAttempts: 0 });
  try {
    // Only the operator's own unpinned instrument holds the registry rows `ps` scatters on; a seat's
    // credential and a user's manager view hold none.
    if (!seat && auth.bearer === undefined && auth.managerInstanceId === undefined) await refuseWithoutLiveManager(nc, t.space);
    // A logged-in user's manager view is issued at the callout (SPEC 13.15): its generation is read
    // back from this connection's accepted row, and every request rides `ep.v1` under it.
    const caller = auth.bearer !== undefined && auth.managerInstanceId !== undefined
      ? await issuedUserCaller(nc, t.space, String(connectOpts.name), who.caller)
      : who.caller;
    const service = await resolveService(nc, t.space, BASELINE_LIFECYCLE_ENDPOINT, caller, {
      deadlineMs: 10_000,
      ...(auth.managerInstanceId !== undefined ? { instanceId: auth.managerInstanceId } : {}),
    });
    // A start or resume is answered only once the drive has activated, which the manager waits on
    // for a bounded time; the deadline here outlives that wait, so the manager's own "still
    // launching" refusal is what a slow activation reads as, never a manager that did not answer.
    const interrupt = command === "run-start" ? reportInterruptedStart(values, t.space) : undefined;
    let r: Awaited<ReturnType<typeof invokeRepairingSplit>>;
    try {
      r = await invokeRepairingSplit(nc, t.space, service, command, args, {
        deadlineMs: RUN_LAUNCH_DEADLINE_MS,
        ...(command === "run-answer" ? { target: { mode: "self" as const } } : {}),
      });
    } catch (e) {
      if (!payloadRefused(e)) throw e;
      const source = command === "run-start" && typeof args?.source === "string" ? args.source : undefined;
      const limit = `this broker's ${nc.info?.max_payload ?? "unreported"}-byte message limit`;
      throw new CommandFailure("refused", "UNSUPPORTED", source !== undefined
        ? `the program is ${Buffer.byteLength(source)} bytes, and the start request that carries it exceeds ${limit}; nothing was sent`
        : `the ${command} request exceeds ${limit}; nothing was sent`, { target: { space: t.space }, ...(source !== undefined ? { remedy: "shorten the program; a hosted start sends it to the manager in one message" } : {}) });
    } finally {
      interrupt?.();
    }
    if (r.reply.ok !== true) {
      const err = r.reply.error;
      // A validation refusal carries every problem as the language's own records; print them the
      // way the validator would, so the fix is the same edit either way.
      for (const d of err?.details ?? []) if (d.kind === LANG_PROBLEM_DETAIL_KIND) console.error(renderLangProblem(d));
      throw managerRefusal(command, t.space, args, err, values.on);
    }
    return r.reply.data;
  } catch (e) {
    // A space whose streams were removed has no registry or contract store to read, so name that
    // instead of the read that failed. `cotal status` says whether its stack still runs.
    if (!(e instanceof CommandFailure) && spaceStreamsExpected(t.space, t.mode) && await chatStreamGone(nc, t.space))
      throw spaceStreamsAbsent(t.space, localStackRoot(t.space));
    // The contract of a manager from release 0.99.3 or earlier takes no journal page, so the request
    // is refused here, against that contract, before it is sent.
    if (e instanceof EpEnvelopeError && command === "run-status" && e.code === "bad-request" && /additional properties: "journal"/.test(e.message))
      throw new CommandFailure("refused", "UNSUPPORTED", "this manager is from release 0.99.3 or earlier and reads no journal page, so this command cannot read the run through it", { target: { space: t.space }, remedy: `upgrade that manager, or read the run from its project folder with ${localJournal(args)}` });
    // No answer is an unavailable target, not a usage error. Only this machine's records can name a
    // manager that runs and does not answer, and `cotal status` reads them.
    if (e instanceof EpEnvelopeError && unansweredRequest(e))
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", unansweredManagerRefusal(e), { target: { space: t.space }, native: { code: e.code }, remedy: "cotal status shows whether this space's manager answers; a stack manager that runs but does not answer is named there with its pid and the way to end it" });
    if (e instanceof EpEnvelopeError) {
      console.error(`${e.code}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** Whether the chat stream of `space` is gone from the broker `nc` is connected to. Any other
 *  failure to read it answers no. */
async function chatStreamGone(nc: NatsConnection, space: string): Promise<boolean> {
  try {
    await (await jetstreamManager(nc, { checkAPI: false })).streams.info(chatStream(space));
    return false;
  } catch (e) {
    return isStreamNotFound(e);
  }
}

/** A hosted verb on a space whose registry lists no live manager is refused here, as `ps` refuses
 *  it, rather than after the describe has waited out its whole deadline for an answer no manager
 *  can send. Any other registry outcome, an unreadable registry included, leaves the describe to
 *  decide. */
async function refuseWithoutLiveManager(nc: NatsConnection, space: string): Promise<void> {
  try {
    await freezeExpectedSet(await jetstreamManager(nc, { checkAPI: false }), space, BASELINE_LIFECYCLE_ENDPOINT);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError) || !noLiveInstances(e)) return;
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "no manager is running for this space to host or read its workflow runs", {
      target: { space },
      native: { code: e.code, detail: `${e.code}: ${e.message}` },
      remedy: "start the stack's manager with bare cotal up; a stack started with --no-manager has none",
    });
  }
}

/** A spawned static seat that shells out to the rendered `cotal run answer …` command must answer as
 *  THAT seat ({@link resolveSeatControlTarget}). An open mesh keeps the operator caller here, which
 *  holds the run capability's full answer reach. Outside a managed seat, keep the ordinary operator
 *  target resolution unchanged. `--on` reaches the mint on every path and becomes the instance the
 *  call addresses; a user-mode view already carries the instance its issuer bound. `seat` says the
 *  target is the seat's own. */
async function resolveRunControlTarget(values: RunValues): Promise<{ target: ControlTarget; seat: boolean }> {
  const on = values.on;
  const seat = values.creds === undefined ? await resolveSeatControlTarget(values, on) : undefined;
  const target = seat?.mode === "auth" ? seat : await resolveControlTarget(values, "control-caller-privileged", on, { onRefusal: "throw" });
  recordOperationSpace(target.space);
  const resolved = { target, seat: target === seat };
  if (on === undefined) return resolved;
  if (target.auth.managerInstanceId !== undefined && target.auth.managerInstanceId !== on)
    throw new CommandFailure("refused", "CONFLICT", "the requested manager instance differs from this credential's instance authority; no other manager was selected");
  return { ...resolved, target: { ...target, auth: { ...target.auth, managerInstanceId: on } } };
}

/** A validation problem the manager returned, as `run validate` prints one. Each value can quote the
 *  program, such as a step name, so its control characters are escaped before the terminal sees them. */
export function renderLangProblem(d: EpErrorDetail): string {
  const where = d.where as { file?: string; line?: number; column?: number } | undefined;
  const at = where ? `${where.file ?? "<program>"}:${where.line ?? "?"}:${where.column ?? "?"}` : "<program>";
  const text = (value: unknown) => oneLine(String(value ?? ""));
  return `  ${text(d.code ?? "L????")} ${text(d.title)} (${text(at)})\n    ${text(d.cause)}\n    fix: ${text(d.fix)}`;
}

async function hosted(values: RunValues, verb: string, a: string | undefined, b: string | undefined): Promise<void> {
  let space: string | undefined;
  const ask = (command: string, args: Record<string, unknown> | undefined) => askHost(values, command, args, (resolved) => { space = resolved; });
  const endpoint = values.endpoint !== undefined ? { endpoint: values.endpoint } : {};
  // A hosted drive is recorded under the manager's own endpoint; a caller cannot choose another,
  // so an `--endpoint` here is refused rather than dropped.
  if ((verb === "start" || verb === "resume") && values.endpoint !== undefined) {
    console.error(`run ${verb}: --endpoint is not taken on the hosted path; the manager records the run under its own endpoint. \`--local\` drives under a chosen endpoint from this process`);
    process.exit(1);
  }
  if ((verb === "answer" || verb === "amend") && values.by !== undefined) {
    console.error(`run ${verb}: --by is not taken on the hosted path; the manager records you as the answerer from your credential. \`--local --by <who>\` names the answerer when driving from this process`);
    process.exit(1);
  }
  // The manager serves no `run-migrate` command, so there is nothing to route to: the check reads
  // the run's record, journal and program itself, which is what `--local` does.
  if (verb === "migrate") {
    console.error("run migrate: the manager serves no run-migrate command; the check reads the run from this terminal. Run `cotal run migrate <runId> --local --file <program>`");
    process.exit(1);
  }
  if (verb === "start") {
    const source = readProgram(values);
    const started = await ask("run-start", {
      source,
      file: values.file,
      ...(values.timeout !== undefined ? { timeout: values.timeout } : {}),
    }) as { runId: string };
    runReceipt("start", space, started, values);
    return;
  }
  if (verb === "resume") {
    if (a === undefined) { console.error(USAGE); process.exit(1); }
    if (values.file !== undefined) {
      console.error(`run resume: the manager resumes a run from its recorded program, so --file is not taken; a run with no recorded program is resumed with \`cotal run resume ${a} --local --file <program>\``);
      process.exit(1);
    }
    const resumed = await ask("run-resume", { runId: a, ...(values.timeout !== undefined ? { timeout: values.timeout } : {}) }) as { runId: string };
    runReceipt("resume", space, resumed, values);
    return;
  }
  if (verb === "ps") {
    if (values.page === true) {
      const page = await ask("run-ps", { ...endpoint, page: {
        ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
        ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
      } });
      if (page === null || typeof page !== "object" || Array.isArray(page) || !("semantics" in page) || page.semantics !== "diagnostic")
        throw new Error("the manager did not return a diagnostic inventory page");
      console.log(JSON.stringify(page));
      if (values.cursor !== undefined && "nextCursor" in page && page.nextCursor === values.cursor) {
        console.error("diagnostic inventory made no progress; retain the incomplete observation and do not retry in a loop");
        process.exitCode = 1;
      }
      return;
    }
    const rows = await ask("run-ps", Object.keys(endpoint).length ? endpoint : undefined) as RunListRow[];
    printRunList(space, rows, values);
    return;
  }
  if (verb === "journal") {
    if (a === undefined) { console.error(USAGE); process.exit(1); }
    // The journal is read in pages, each one reply, so one larger than the broker's payload limit
    // stays readable.
    const rows: RunJournalRow[] = [];
    let view: RunStatusView;
    do {
      view = await ask("run-status", { runId: a, ...endpoint, journal: { offset: rows.length } }) as RunStatusView;
      if (view.journalTotal === undefined) throw new CommandFailure("failed", "OPERATION_FAILED", "the manager answered the journal read without a page; the journal was not read", { target: { space: space ?? null, run: a } });
      if (view.journal.length === 0 && rows.length < view.journalTotal) throw new CommandFailure("failed", "OPERATION_FAILED", `the manager returned no journal rows at row ${rows.length} of ${view.journalTotal}; the journal was not read completely`, { target: { space: space ?? null, run: a } });
      rows.push(...view.journal);
    } while (rows.length < view.journalTotal);
    if (space === undefined) throw new Error("the native run target was not reported");
    const { journalTotal: _total, ...record } = view;
    printRunDetail(space, { ...record, journal: rows }, values);
    return;
  }
  // answer and amend: the manager records the caller as the answerer (SPEC 14.5), so no `--by`
  // rides. An amend is the same served command with `amend` set.
  if (a === undefined || b === undefined) {
    console.error(USAGE);
    console.error(`run ${verb}: <runId> <stepKey> are required`);
    process.exit(1);
  }
  const value = parseAnswerValue(values);
  const result = await ask("run-answer", {
    runId: a,
    stepKey: b,
    ...endpoint,
    ...(values.value !== undefined ? { value } : {}),
    ...(values.artifact !== undefined ? { artifact: values.artifact } : {}),
    ...(verb === "amend" ? { amend: true } : {}),
  }).catch(async (error: unknown) => {
    throw verb === "answer" ? await withMatchingKeys(error, a, b, values, () => ask("run-status", { runId: a, ...endpoint }) as Promise<RunStatusView>) : error;
  });
  runReceipt(verb, space, result, values, a, { step: b, ...(values.value !== undefined ? { value } : {}), ...(values.artifact !== undefined ? { artifact: values.artifact } : {}) });
}

/** A step key the run has no open request at, answered with the open keys whose step name it matches,
 *  as `frage` matches `/checkpoint:frage#0`. A run that cannot be read leaves the refusal as it was. */
export async function withMatchingKeys(error: unknown, runId: string, stepKey: string, values: RunValues, read: () => Promise<RunStatusView>): Promise<unknown> {
  if (!(error instanceof CommandFailure) || error.code !== "TARGET_NOT_FOUND") return error;
  let open: string[];
  try { open = openRequestKeys(await read()); } catch { return error; }
  const stepName = (key: string) => /:([^:/#]*)#\d+$/.exec(key)?.[1] ?? key;
  const word = stepName(stepKey);
  const matches = open.filter((key) => key !== stepKey && (stepName(key) === word || (word !== "" && (stepName(key).includes(word) || word.includes(stepName(key))))));
  if (!matches.length) return error;
  // A step name comes from the program, so it is escaped and quoted before the terminal shows it.
  const quoted = (key: string) => `'${oneLine(key).replaceAll("'", `'\\''`)}'`;
  const remedy = matches.length === 1
    ? `the open request ${quoted(matches[0]!)} matches; answer it with cotal run answer ${runId} ${quoted(matches[0]!)} --value '<json>'${values.on ? ` --on ${values.on}` : ""}`
    : `the open requests that match are ${matches.map(quoted).join(", ")}; pass one of them as the step`;
  return new CommandFailure(error.outcome, error.code, error.message, { remedy, target: error.target, ...(error.native ? { native: error.native } : {}) });
}

/** `cotal run <start|resume|ps|journal|answer|amend>` — dispatch. The manager hosts by default;
 *  `--local` drives in this process over one connection per invocation. */
export async function runWorkflow(args: ParsedArgs): Promise<void> {
  // A mesh the verb cannot resolve or connect to is refused under the refusal's own code, before
  // any request.
  try {
    await workflow(args);
  } catch (e) {
    throw isConnectRefusal(e) ? e.failure() : e;
  }
}

async function workflow(args: ParsedArgs): Promise<void> {
  const { values, verb, a, b } = workflowArguments(args);
  if (verb === "validate" || verb === "plan" || verb === "simulate") return offlineWorkflow(verb, a!, values);
  if (verb === "turns" || verb === "yield") return seatTurnCommand(verb, a, values);
  if (verb === "revoke") {
    // Revocation is an operator act on the admission store, never a served command: the marker is
    // written from the folder's trust material, so it is `--local` only.
    if (values.local !== true) {
      console.error("run revoke: a revocation is written from the mesh's project folder; run `cotal run revoke <runId> --local --by <who> --reason <text>`");
      process.exit(1);
    }
    return revoke(values, a);
  }
  if (values.local !== true) {
    await hosted(values, verb, a, b);
    return;
  }
  if (verb === "start") return start(values);
  if (verb === "resume") return resume(values, a);
  // The reads ride a one-shot operator READ credential for that call; a journal, an answer or an
  // amend names the run its replay durable is pinned to. An answer or an amend finds its pause on
  // this credential and then writes on a second one, minted for that pause alone (see `answer`).
  const endpoint = values.endpoint ?? "manager";
  const takeoverId = newTakeoverId();
  const planes = await openPlanes(values, "run-operator", {
    runOperator: { endpoint, takeoverId, ...(verb !== "ps" && a !== undefined ? { runId: a } : {}) },
  });
  try {
    if (verb === "ps") await ps(values, planes);
    else if (verb === "journal") await journal(values, planes, endpoint, a, takeoverId);
    else if (verb === "migrate") await migrate(values, planes, a, takeoverId);
    else if (verb === "amend") await amend(values, planes, a, b, takeoverId);
    else await answer(values, planes, a, b, takeoverId);
  } finally {
    await planes.close();
  }
}

/** How deep an answer value may nest. Serializing it recurses, and a host runs out of stack a few
 *  thousand levels down, at a depth that depends on the host, so the bound sits well below that. */
const ANSWER_VALUE_DEPTH = 1000;

/** `--value` as the answer record carries it, refused before anything is sent when the record
 *  would differ from what was typed: JSON keeps only the last of two equal names, writes a number
 *  past the double range as null, and cannot send a value nested past the serializer's stack. */
function checkAnswerValue(text: string, usage: (message: string) => never): void {
  let value: unknown;
  try { value = JSON.parse(text); } catch { usage("--value must be valid JSON"); }
  const refuse = (message: string): never => { throw new CommandFailure("refused", "SCHEMA_INVALID", `${message}; nothing was sent`); };
  const duplicate = hasDuplicateNames(text);
  if (duplicate.duplicate) refuse(`--value names "${duplicate.name}" twice in one object, and JSON keeps only the last`);
  // Iterative, because the value can nest deeper than the stack a recursive walk has.
  const pending: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 1 }];
  while (pending.length > 0) {
    const { v, depth } = pending.pop()!;
    if (typeof v === "number" && !Number.isFinite(v)) refuse("--value holds a number outside the range JSON carries, which would be recorded as null");
    if (v === null || typeof v !== "object") continue;
    if (depth > ANSWER_VALUE_DEPTH) refuse(`--value nests more than ${ANSWER_VALUE_DEPTH} levels deep, deeper than an answer can be sent`);
    for (const child of Object.values(v)) pending.push({ v: child, depth: depth + 1 });
  }
}

/** Public workflow grammar, before catalog preparation or native requests. */
export function workflowArguments(args: ParsedArgs): { values: RunValues; verb: string; a?: string; b?: string } {
  const values = { ...args.values } as RunValues;
  presentationOf(values);
  const [raw = "list", first, second, ...extra] = args.positionals;
  const verb = ({ list: "ps", show: "journal", check: "migrate" } as Record<string, string>)[raw] ?? raw;
  const usage = (message: string): never => { throw new CommandFailure("refused", "USAGE_INVALID", message); };
  if (extra.length || !["start", "resume", "ps", "journal", "answer", "amend", "revoke", "migrate", "validate", "plan", "simulate", "turns", "yield"].includes(verb)) usage("choose a declared run command; run it bare to list workflows");
  // A run id is an id token, so a malformed one is refused here, before any contact, rather than
  // by whichever plane reads it first.
  if (["journal", "resume", "revoke", "answer", "amend", "migrate"].includes(verb) && first !== undefined) {
    try { assertIdToken(first, "run id"); } catch { usage(`run ${raw}: ${JSON.stringify(first)} is not a run id, which is 1 to 64 letters, digits, "_" or "-"; cotal run ps lists them`); }
  }
  let a: string | undefined = first;
  let b: string | undefined = second;
  if (verb === "start") {
    if (second !== undefined || (first !== undefined && values.file !== undefined)) usage("run start takes one source file");
    values.file = first ?? values.file;
    if (!values.file?.trim()) usage("run start requires a workflow source file");
    a = undefined;
  } else if (verb === "migrate") {
    if (!first || (second !== undefined && values.file !== undefined)) usage("run check takes a run id and one edited source file");
    values.file = second ?? values.file;
    if (!values.file?.trim()) usage("run check requires the edited source file");
    values.local = true;
    b = undefined;
  } else if (["validate", "plan", "simulate"].includes(verb)) {
    if (!first || second !== undefined || values.file !== undefined) usage(`run ${verb} takes one positional source file`);
    if (values.space !== undefined || values.server !== undefined || values.creds !== undefined || values.endpoint !== undefined || values.local !== undefined) usage(`run ${verb} is offline and takes no mesh or caller selection`);
  } else if (verb === "ps" || verb === "turns") {
    if (first !== undefined) usage(`run ${raw} takes no positional argument`);
  } else if (verb === "answer" || verb === "amend") {
    if (!first || !second) usage(`run ${verb} requires a run id and step key`);
  } else if (!first || second !== undefined) usage(`run ${raw} takes one identifier`);
  const scopes: Record<string, readonly string[]> = {
    timeout: ["start", "resume"], by: ["answer", "amend", "revoke"], reason: ["revoke"], value: ["answer", "amend"], artifact: ["answer", "amend"],
    "admit-read": ["start"], "admit-publish": ["start"], adopt: ["migrate"], release: ["migrate"], "discard-approvals": ["migrate"],
  };
  for (const [flag, modes] of Object.entries(scopes)) if (args.values[flag] !== undefined && !modes.includes(verb)) usage(`--${flag} is not taken by this run command`);
  if (verb === "journal" && values.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(values.limit) || Number(values.limit) > 1000) usage(`run ${raw}: --limit must be between 1 and 1000`);
    if (values.json) usage(`run ${raw}: --limit bounds the text view, and --json returns the whole journal`);
  } else if (values.page !== undefined || values.limit !== undefined || values.cursor !== undefined) {
    if (verb !== "ps" || values.local === true || values.page !== true || values.on === undefined)
      usage("diagnostic paging requires run --page --on <instance> without --local");
    if (values.limit !== undefined && (!/^[1-9][0-9]*$/.test(values.limit) || Number(values.limit) > 16))
      usage("run --page: --limit must be between 1 and 16");
    if (values.cursor !== undefined && (values.cursor.length > 3072 || !/^[A-Za-z0-9_-]+$/.test(values.cursor)))
      usage("run --page: invalid cursor encoding");
    if (values.plain) usage("diagnostic pages produce bounded JSON and take no --plain");
  }
  if ((values["admit-read"] !== undefined || values["admit-publish"] !== undefined) && values.local !== true) usage("admission ceilings belong to the explicit local start");
  // Revoke is local only and needs --by, so its own requirement is named before the hosted --by refusal.
  if (verb === "revoke" && (values.local !== true || !values.by?.trim() || !values.reason?.trim())) usage("run revoke requires --local --by <actor> --reason <text> under the existing trust checks");
  if (values.by !== undefined && values.local !== true) usage("the hosted manager records the authenticated caller; --by is only for the local path");
  if ((verb === "start" || verb === "resume") && values.endpoint !== undefined && values.local !== true) usage("a hosted run uses the manager's endpoint; --endpoint is only for the local path");
  if (values.value !== undefined) checkAnswerValue(values.value, usage);
  if (values.handler !== undefined && verb !== "simulate") usage("--handler belongs to run simulate");
  if ((values.status !== undefined || values.to !== undefined || values.note !== undefined) && verb !== "yield") usage("--status, --to and --note belong to run yield");
  if (verb === "yield") {
    if (!["done", "blocked", "handoff"].includes(values.status ?? "")) usage("run yield requires --status done, blocked or handoff");
    if (values.status === "handoff" ? !values.to?.trim() : values.to !== undefined) usage("--to is required only for a handoff yield");
  }
  if (verb === "turns" || verb === "yield") {
    if (values.creds !== undefined || values.endpoint !== undefined || values.local !== undefined || values.by !== undefined) usage("run turns/yield use the managed seat's own identity, not an operator override");
  }
  if (values.file !== undefined && !["start", "resume", "migrate"].includes(verb)) usage("this run command takes no --file");
  if (values.on !== undefined) {
    if (values.local === true || ["validate", "plan", "simulate", "turns", "yield", "revoke"].includes(verb)) usage("--on pins a hosted run command; local and offline commands take no manager instance");
    try { assertLifecycleToken(values.on, "instanceId"); }
    catch { usage("--on requires the full manager instance id as cotal ps prints it"); }
  }
  if ((values.json || values.plain) && values.local && !["ps", "journal", "answer", "amend"].includes(verb)) usage("the local drive does not implement structured or plain receipts; use the hosted form");
  return { values, verb, ...(a === undefined ? {} : { a }), ...(b === undefined ? {} : { b }) };
}

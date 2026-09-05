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
import { readFileSync } from "node:fs";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  LANG_PROBLEM_DETAIL_KIND,
  dialerFor,
  invokeCommand,
  newTakeoverId,
  openRecordsBucket,
  readRunProgram,
  readRunRecord,
  renderLifecycleBlocked,
  replayRunJournal,
  resolveService,
  runDriverCaller,
  RUN_LAUNCH_DEADLINE_MS,
  standaloneConnectOpts,
  unansweredRequest,
  walkKvEntries,
  type EpErrorDetail,
  type ParsedArgs,
  type RunJournalRow,
  type RunListRow,
  type RunStatusValue,
  type RunStatusView,
} from "@cotal-ai/core";
import { journalEntryKeyString, type JournalEntry } from "@cotal-ai/lang";
import { connectOrExit, controlCaller, endpointAuth, resolveControlTarget, type ConnectOpts, type ControlAuth } from "@cotal-ai/workspace";
import { startRun, driveRun, type DriveOutcome } from "./run-driver.js";
import { MeshHandler, EpfSettleWatcher } from "./mesh-handler.js";
import { resolveCheckpoint } from "./resolve-checkpoint.js";

const USAGE =
  'usage: cotal run <start --file <program> [--timeout <dur>] | resume <runId> [--local --file <program>] | ps [--endpoint <ep>] | journal <runId> [--endpoint <ep>] | answer <runId> <stepKey> [--value <json>] [--artifact <ref>] [--endpoint <ep>] [--local --by <who>]> [--local] [--space <s>] [--server <url>] [--creds <path>]';

interface RunValues {
  space?: string;
  server?: string;
  creds?: string;
  file?: string;
  endpoint?: string;
  timeout?: string;
  by?: string;
  value?: string;
  artifact?: string;
  local?: boolean;
}

interface Planes {
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
  const conn = await connectOrExit(values, role, { mint });
  const nc = await connect({
    servers: conn.server,
    ...standaloneConnectOpts({ ...endpointAuth(conn), tls: conn.tls }),
  });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, conn.space);
  const max = nc.info?.max_payload;
  return {
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

/**
 * This process, as the run record will name it. Fresh per invocation, ID INCLUDED: two concurrent
 * drives of one run derive the same fencing token and epoch from one record read, and the
 * activation barrier deliberately relaxes the exact (token, holder, epoch) tuple as a process
 * picking its own run back up — so a constant id would let a second concurrent drive co-activate
 * through that relaxation instead of being refused.
 */
function cliHolder(): { id: string; lifecycleUid: string; instanceId: string } {
  const uid = randomUUID().replaceAll("-", "");
  return { id: `cli-run-${uid.slice(0, 8)}`, lifecycleUid: `u_${uid.slice(0, 20)}`, instanceId: uid.slice(0, 26) };
}

function readProgram(values: RunValues): string {
  if (values.file === undefined) {
    console.error(USAGE);
    console.error("run start: --file <program> is required");
    process.exit(1);
  }
  return readFileSync(values.file, "utf8");
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
  const source = readFileSync(values.file, "utf8");
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
  if (reason.name === "RunHeld") {
    console.log("the run is held: one step is settled `refused`, and a resume on a host that can perform it continues exactly there");
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
    await drive(values, planes, { endpoint, runId, source, who, epoch: 1, fencingToken: 1, takeoverId, mode: "new" });
  } finally {
    await planes.close();
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
  try {
    const record = await readRunRecord(reader.kv, endpoint, runId);
    if (record === undefined) {
      console.error(`run ${runId}: no record on endpoint ${endpoint}; a run that was never started cannot be resumed`);
      process.exit(1);
    }
    source = await resumeSource(values, reader, endpoint, runId);
    status = record.status?.value;
  } finally {
    await reader.close();
  }
  const who = cliHolder();
  const epoch = (status?.epoch ?? 0) + 1;
  const takeoverId = newTakeoverId();
  const planes = await openPlanes(values, "run-driver", { runDriver: { endpoint, runId, takeoverId, instanceId: who.instanceId, epoch } });
  try {
    await drive(values, planes, { endpoint, runId, source, who, epoch, fencingToken: (status?.fencingToken ?? 0) + 1, takeoverId, mode: "existing" });
  } finally {
    await planes.close();
  }
}

/** One drive attempt in this process: the handler bound to this invocation as holder, the run
 *  held until it settles. */
async function drive(
  values: RunValues,
  planes: Planes,
  a: { endpoint: string; runId: string; source: string; who: ReturnType<typeof cliHolder>; epoch: number; fencingToken: number; takeoverId: string; mode: "new" | "existing" },
): Promise<void> {
  const { endpoint, runId, source, who, epoch, fencingToken, takeoverId } = a;
  const handler = new MeshHandler(
    planes.nc,
    planes.kv,
    planes.js,
    planes.jsm,
    {
      space: planes.space,
      endpoint,
      runId,
      caller: runDriverCaller(runId),
      instanceId: who.instanceId,
      epoch,
      holder: { id: who.id, lifecycleUid: who.lifecycleUid },
      defaultCheckpointTimeout: values.timeout ?? "1h",
    },
    new EpfSettleWatcher(planes.jsm, planes.space),
    () => Date.now(),
  );
  const req = {
    space: planes.space,
    endpoint,
    runId,
    source,
    kv: planes.kv,
    lease: { holder: who.id, epoch, fencingToken, takeoverId },
    handler,
    ...(values.file !== undefined ? { file: values.file } : {}),
    ...(planes.resultBytes !== undefined ? { resultBytes: planes.resultBytes } : {}),
  };
  if (a.mode === "new") console.log(`starting run ${runId} on endpoint ${endpoint} in space ${planes.space}`);
  const out = a.mode === "new" ? await startRun(planes.js, planes.jsm, req) : await driveRun(planes.js, planes.jsm, req);
  reportOutcome(runId, out);
}

async function ps(values: RunValues, planes: Planes): Promise<void> {
  // Run record keys are `run.<endpoint>.<runId>.<spec|status>` in the records bucket; the scan is
  // over the spec half, which every run has exactly once. A consumer-free walk: the records bucket
  // is an authority stream whose consumer surface is an exact audited list (SPEC 13.9).
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const e of await walkKvEntries(planes.kv, "run.*.*.spec")) {
    const parts = e.key.split(".");
    if (parts.length !== 4 || parts[3] !== "spec") continue;
    const endpoint = parts[1] as string;
    const runId = parts[2] as string;
    const dedupe = `${endpoint}/${runId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (values.endpoint !== undefined && endpoint !== values.endpoint) continue;
    const record = await readRunRecord(planes.kv, endpoint, runId);
    if (record === undefined) continue;
    const st = record.status?.value;
    const lineage = record.spec.value.forkedFrom;
    rows.push([
      runId,
      endpoint,
      st?.state ?? "(no status)",
      st?.holder ?? "-",
      st === undefined ? "-" : String(st.journalHigh),
      lineage === undefined ? "-" : `${lineage.run}@${lineage.step}`,
    ]);
  }
  if (rows.length === 0) {
    console.log(`no workflow runs recorded in space ${planes.space}`);
    return;
  }
  const header = ["RUN", "ENDPOINT", "STATE", "HOLDER", "JOURNAL", "FORKED-FROM"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i] as number)).join("  ");
  console.log(line(header));
  for (const r of rows) console.log(line(r));
}

async function journal(planes: Planes, runId: string | undefined, takeoverId: string): Promise<void> {
  if (runId === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  // The replay durable is named by the takeover id this call's credential was minted for.
  const replay = await replayRunJournal(planes.js, planes.jsm, planes.space, runId, takeoverId);
  if (replay.records.length === 0) {
    console.log(`run ${runId}: no journal records (never started, or retired)`);
    return;
  }
  for (const { record } of replay.records) {
    if (record.kind === "activation") {
      console.log(`#${record.n}  activation  holder=${record.holder} epoch=${record.epoch} replayedTo=${record.replayedTo}`);
      continue;
    }
    const e = record.entry as JournalEntry;
    // The key the operator sees is the key `answer <stepKey>` takes back, so it is rendered by
    // the same export the journal itself keys with, never a second hand-rolled copy of the rule.
    const step = journalEntryKeyString(e);
    const outcome = e.state === "pending" ? "pending" : `${e.status}${e.error?.code ? ` (${e.error.code})` : ""}`;
    console.log(`#${record.n}  step        ${step}  ${outcome}`);
    // WHAT AN OPEN PAUSE ASKS, under the step an answer is addressed by. `answer <run> <stepKey>`
    // is the whole interface to a checkpoint, and without this the operator on the other end of it
    // had the address and not the question: everything durable held the input HASH, so learning
    // what "approve" meant took a trip back to the source. Only while it is open, because a
    // settled pause is answered and the render is a worklist rather than a transcript.
    const asks = e.state === "pending" ? (e.external as { asks?: unknown } | undefined)?.asks : undefined;
    if (typeof asks === "string") {
      const addressee = (e.external as { addressee?: unknown } | undefined)?.addressee;
      console.log(`            asks        ${asks}${typeof addressee === "string" ? `  (escalates to ${addressee})` : ""}`);
    }
  }
}

async function answer(values: RunValues, planes: Planes, runId: string | undefined, stepKey: string | undefined, takeoverId: string): Promise<void> {
  if (runId === undefined || stepKey === undefined || values.by === undefined) {
    console.error(USAGE);
    console.error("run answer: <runId> <stepKey> and --by <who> are required");
    process.exit(1);
  }
  const endpoint = values.endpoint ?? "manager";
  const parsedValue = parseAnswerValue(values);
  // Resume is holder-bound (SPEC 13.10) and the CLI is not the driver: the resolver presents as
  // the ARMING holder it reads off the checkpoint's own record, so a fresh invocation answers
  // exactly as the minter would have. The answerer's name rides `by`, never the presenter.
  const result = await resolveCheckpoint(
    { kv: planes.kv, js: planes.js, jsm: planes.jsm, space: planes.space, endpoint },
    {
      runId,
      stepKey,
      by: values.by,
      ...(values.value !== undefined ? { value: parsedValue } : {}),
      ...(values.artifact !== undefined ? { artifact: values.artifact } : {}),
      now: Date.now(),
      takeoverId,
    },
  );
  console.log(JSON.stringify(result, null, 2));
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

// ── the manager-hosted path (SPEC 14.3) ─────────────────────────────────────────────────────

/** One command to the mesh's manager over the endpoint rails: a fresh resolve (describe, store
 *  fetch, digest-verified recompile), then the invoke. The reply's data on success; on a refusal
 *  the manager's own sentence, printed, and a non-zero exit. */
async function askHost(values: RunValues, command: string, args: Record<string, unknown> | undefined): Promise<unknown> {
  const t = await resolveControlTarget(values, "control-caller-privileged");
  const who = controlCaller(t.auth);
  if ("refusal" in who) {
    console.error(who.refusal);
    process.exit(1);
  }
  const auth: ControlAuth = t.auth;
  const nc = await dialerFor(t.server)({
    servers: t.server,
    ...standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: auth.tls === true } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds, tls: auth.tls === true } : { tls: auth.tls === true }),
    maxReconnectAttempts: 0,
  });
  try {
    const service = await resolveService(nc, t.space, BASELINE_LIFECYCLE_ENDPOINT, who.caller, { deadlineMs: 10_000 });
    // A start or resume is answered only once the drive has activated, which the manager waits on
    // for a bounded time; the deadline here outlives that wait, so the manager's own "still
    // launching" refusal is what a slow activation reads as, never a manager that did not answer.
    const r = await invokeCommand(nc, t.space, service, command, args, { deadlineMs: RUN_LAUNCH_DEADLINE_MS });
    if (r.reply.ok !== true) {
      const err = r.reply.error;
      console.error(`run ${command.slice(4)}: ${renderLifecycleBlocked(err?.message ?? err?.code ?? "the manager refused", err)}`);
      // A validation refusal carries every problem as the language's own records; print them the
      // way the validator would, so the fix is the same edit either way.
      for (const d of err?.details ?? []) if (d.kind === LANG_PROBLEM_DETAIL_KIND) console.error(renderLangProblem(d));
      process.exit(1);
    }
    return r.reply.data;
  } catch (e) {
    if (e instanceof EpEnvelopeError) {
      console.error(unansweredRequest(e)
        ? `no manager answered on the endpoint rails (${e.code}: ${e.message}); is a manager running for this mesh? A run can still be driven from this terminal with --local`
        : `${e.code}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

function renderLangProblem(d: EpErrorDetail): string {
  const where = d.where as { file?: string; line?: number; column?: number } | undefined;
  const at = where ? `${where.file ?? "<program>"}:${where.line ?? "?"}:${where.column ?? "?"}` : "<program>";
  return `  ${String(d.code ?? "L????")} ${String(d.title ?? "")} (${at})\n    ${String(d.cause ?? "")}\n    fix: ${String(d.fix ?? "")}`;
}

function printJournal(runId: string, rows: readonly RunJournalRow[]): void {
  if (rows.length === 0) {
    console.log(`run ${runId}: no journal records (never started, or retired)`);
    return;
  }
  for (const r of rows) {
    if (r.kind === "activation") {
      console.log(`#${r.n}  activation  holder=${r.holder} epoch=${r.epoch} replayedTo=${r.replayedTo}`);
      continue;
    }
    console.log(`#${r.n}  step        ${r.step}  ${r.outcome}`);
    if (r.asks !== undefined) console.log(`            asks        ${r.asks}${r.addressee !== undefined ? `  (escalates to ${r.addressee})` : ""}`);
  }
}

function printRuns(space: string, rows: readonly RunListRow[]): void {
  if (rows.length === 0) {
    console.log(`no workflow runs recorded in space ${space}`);
    return;
  }
  const table = rows.map((r) => [
    r.runId,
    r.endpoint,
    r.state ?? "(no status)",
    r.holder ?? "-",
    r.journalHigh === undefined ? "-" : String(r.journalHigh),
    r.forkedFrom === undefined ? "-" : `${r.forkedFrom.run}@${r.forkedFrom.step}`,
  ]);
  const header = ["RUN", "ENDPOINT", "STATE", "HOLDER", "JOURNAL", "FORKED-FROM"];
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => (r[i] as string).length)));
  const line = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i] as number)).join("  ");
  console.log(line(header));
  for (const r of table) console.log(line(r));
}

async function hosted(values: RunValues, verb: string, a: string | undefined, b: string | undefined): Promise<void> {
  const endpoint = values.endpoint !== undefined ? { endpoint: values.endpoint } : {};
  // A hosted drive is recorded under the manager's own endpoint; a caller cannot choose another,
  // so an `--endpoint` here is refused rather than dropped.
  if ((verb === "start" || verb === "resume") && values.endpoint !== undefined) {
    console.error(`run ${verb}: --endpoint is not taken on the hosted path; the manager records the run under its own endpoint. \`--local\` drives under a chosen endpoint from this process`);
    process.exit(1);
  }
  if (verb === "answer" && values.by !== undefined) {
    console.error("run answer: --by is not taken on the hosted path; the manager records you as the answerer from your credential. `--local --by <who>` names the answerer when driving from this process");
    process.exit(1);
  }
  if (verb === "start") {
    const source = readProgram(values);
    const started = await askHost(values, "run-start", {
      source,
      file: values.file,
      ...(values.timeout !== undefined ? { timeout: values.timeout } : {}),
    }) as { runId: string };
    console.log(`started run ${started.runId} on the manager; it runs there until it completes or is held`);
    console.log(`  cotal run journal ${started.runId}    # follow its steps`);
    return;
  }
  if (verb === "resume") {
    if (a === undefined) { console.error(USAGE); process.exit(1); }
    if (values.file !== undefined) {
      console.error(`run resume: the manager resumes a run from its recorded program, so --file is not taken; a run with no recorded program is resumed with \`cotal run resume ${a} --local --file <program>\``);
      process.exit(1);
    }
    const resumed = await askHost(values, "run-resume", { runId: a, ...(values.timeout !== undefined ? { timeout: values.timeout } : {}) }) as { runId: string };
    console.log(`resumed run ${resumed.runId} on the manager`);
    return;
  }
  if (verb === "ps") {
    const rows = await askHost(values, "run-ps", Object.keys(endpoint).length ? endpoint : undefined) as RunListRow[];
    const t = values.space ?? "(the resolved mesh)";
    printRuns(t, rows);
    return;
  }
  if (verb === "journal") {
    if (a === undefined) { console.error(USAGE); process.exit(1); }
    const view = await askHost(values, "run-status", { runId: a, ...endpoint }) as RunStatusView;
    const st = view.status;
    console.log(`run ${view.runId} on ${view.endpoint}: ${st === undefined ? "(no status)" : `${st.state}, holder ${st.holder}, epoch ${st.epoch}`}`);
    printJournal(view.runId, view.journal);
    return;
  }
  // answer: the manager records the caller as the answerer (SPEC 14.5), so no `--by` rides.
  if (a === undefined || b === undefined) {
    console.error(USAGE);
    console.error("run answer: <runId> <stepKey> are required");
    process.exit(1);
  }
  const value = parseAnswerValue(values);
  const result = await askHost(values, "run-answer", {
    runId: a,
    stepKey: b,
    ...endpoint,
    ...(values.value !== undefined ? { value } : {}),
    ...(values.artifact !== undefined ? { artifact: values.artifact } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

/** `cotal run <start|resume|ps|journal|answer>` — dispatch. The manager hosts by default;
 *  `--local` drives in this process over one connection per invocation. */
export async function runWorkflow(args: ParsedArgs): Promise<void> {
  const values = args.values as RunValues;
  const [verb, a, b] = args.positionals;
  if (verb === undefined || !["start", "resume", "ps", "journal", "answer"].includes(verb)) {
    console.error(USAGE);
    process.exit(1);
  }
  if (values.local !== true) {
    await hosted(values, verb, a, b);
    return;
  }
  if (verb === "start") return start(values);
  if (verb === "resume") return resume(values, a);
  // The reads and the answer each ride a one-shot operator credential for that call; a journal or
  // an answer names the run its replay durable is pinned to, and only the answer holds the writes.
  const endpoint = values.endpoint ?? "manager";
  const takeoverId = newTakeoverId();
  const planes = await openPlanes(values, "run-operator", {
    runOperator: { endpoint, takeoverId, ...(verb !== "ps" && a !== undefined ? { runId: a } : {}), ...(verb === "answer" ? { answers: true as const } : {}) },
  });
  try {
    if (verb === "ps") await ps(values, planes);
    else if (verb === "journal") await journal(planes, a, takeoverId);
    else await answer(values, planes, a, b, takeoverId);
  } finally {
    await planes.close();
  }
}

/**
 * `cotal run` — the workflow-run operator surface.
 *
 * Five verbs over the exports this package already ships: `start` drives a new run on the mesh
 * handler, `resume` takes an existing run over and drives it to quiescence, `ps` lists the run
 * records of an endpoint, `journal` prints a run's durable step journal, and `answer` resolves an
 * open checkpoint, or an open `ask` attempt, through the run driver, which is the only door an
 * answer has (§14).
 *
 * The composition is the run-driver suite's, against a resolved mesh instead of a scratch broker:
 * one raw NATS connection, JetStream + the records bucket over it, the mesh handler bound to this
 * process as holder. Checkpoint EXPIRY rides the mediated timer writer, which the delivery daemon
 * pumps on a live mesh; `start` on a bare broker still runs and still resolves, it just cannot
 * expire a pause.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  newTakeoverId,
  openRecordsBucket,
  readRunProgram,
  readRunRecord,
  replayRunJournal,
  runDriverCaller,
  standaloneConnectOpts,
  walkKvEntries,
  type ParsedArgs,
} from "@cotal-ai/core";
import { journalEntryKeyString, type JournalEntry } from "@cotal-ai/lang";
import { connectOrExit, endpointAuth } from "@cotal-ai/workspace";
import { startRun, driveRun, type DriveOutcome } from "./run-driver.js";
import { MeshHandler, EpfSettleWatcher } from "./mesh-handler.js";
import { resolveCheckpoint } from "./resolve-checkpoint.js";

const USAGE =
  'usage: cotal run <start --file <program> [--timeout <dur>] | resume <runId> [--file <program>] | ps | journal <runId> | answer <runId> <stepKey> --by <who> [--value <json>] [--artifact <ref>]> [--endpoint <ep>] [--space <s>] [--server <url>] [--creds <path>]';

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

/** One raw connection to the resolved mesh, with the planes a driver needs over it. */
async function openPlanes(values: RunValues): Promise<Planes> {
  const conn = await connectOrExit(values, "admin");
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

async function start(values: RunValues, planes: Planes): Promise<void> {
  const source = readProgram(values);
  const endpoint = values.endpoint ?? "manager";
  // Minted here, never caller-supplied: the records table binds run-id minting to the driver.
  // 128 bits, the width the spec's other minted identifiers carry, so a colliding start is
  // outside any realistic horizon rather than a rare one-shot refusal.
  const runId = `run-${randomBytes(16).toString("hex")}`;
  const who = cliHolder();
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
      epoch: 1,
      holder: { id: who.id, lifecycleUid: who.lifecycleUid },
      defaultCheckpointTimeout: values.timeout ?? "1h",
    },
    new EpfSettleWatcher(planes.jsm, planes.space),
    () => Date.now(),
  );
  console.log(`starting run ${runId} on endpoint ${endpoint} in space ${planes.space}`);
  const out = await startRun(planes.js, planes.jsm, {
    space: planes.space,
    endpoint,
    runId,
    source,
    kv: planes.kv,
    lease: { holder: who.id, epoch: 1, fencingToken: 1, takeoverId: newTakeoverId() },
    handler,
    ...(values.file !== undefined ? { file: values.file } : {}),
    ...(planes.resultBytes !== undefined ? { resultBytes: planes.resultBytes } : {}),
  });
  reportOutcome(runId, out);
}

async function resume(values: RunValues, planes: Planes, runId: string | undefined): Promise<void> {
  if (runId === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  const endpoint = values.endpoint ?? "manager";
  const record = await readRunRecord(planes.kv, endpoint, runId);
  if (record === undefined) {
    console.error(`run ${runId}: no record on endpoint ${endpoint}; a run that was never started cannot be resumed`);
    process.exit(1);
  }
  const source = await resumeSource(values, planes, endpoint, runId);
  const status = record.status?.value;
  const who = cliHolder();
  const epoch = (status?.epoch ?? 0) + 1;
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
  const out = await driveRun(planes.js, planes.jsm, {
    space: planes.space,
    endpoint,
    runId,
    source,
    kv: planes.kv,
    lease: {
      holder: who.id,
      epoch,
      fencingToken: (status?.fencingToken ?? 0) + 1,
      takeoverId: newTakeoverId(),
    },
    handler,
    ...(values.file !== undefined ? { file: values.file } : {}),
    ...(planes.resultBytes !== undefined ? { resultBytes: planes.resultBytes } : {}),
  });
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

async function journal(planes: Planes, runId: string | undefined): Promise<void> {
  if (runId === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  const replay = await replayRunJournal(planes.js, planes.jsm, planes.space, runId, newTakeoverId());
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

async function answer(values: RunValues, planes: Planes, runId: string | undefined, stepKey: string | undefined): Promise<void> {
  if (runId === undefined || stepKey === undefined || values.by === undefined) {
    console.error(USAGE);
    console.error("run answer: <runId> <stepKey> and --by <who> are required");
    process.exit(1);
  }
  const endpoint = values.endpoint ?? "manager";
  let parsedValue: unknown;
  if (values.value !== undefined) {
    try {
      parsedValue = JSON.parse(values.value);
    } catch {
      console.error(`run answer: --value is not valid JSON: ${values.value}`);
      console.error('a bare string needs its own quotes, e.g. --value \'"yes"\'');
      process.exit(1);
    }
  }
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
    },
  );
  console.log(JSON.stringify(result, null, 2));
}

/** `cotal run <start|resume|ps|journal|answer>` — dispatch, one connection per invocation. */
export async function runWorkflow(args: ParsedArgs): Promise<void> {
  const values = args.values as RunValues;
  const [verb, a, b] = args.positionals;
  if (verb === undefined || !["start", "resume", "ps", "journal", "answer"].includes(verb)) {
    console.error(USAGE);
    process.exit(1);
  }
  const planes = await openPlanes(values);
  try {
    if (verb === "start") await start(values, planes);
    else if (verb === "resume") await resume(values, planes, a);
    else if (verb === "ps") await ps(values, planes);
    else if (verb === "journal") await journal(planes, a);
    else await answer(values, planes, a, b);
  } finally {
    await planes.close();
  }
}

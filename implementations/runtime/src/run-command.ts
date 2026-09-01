/**
 * `cotal run` — the workflow-run operator surface.
 *
 * Five verbs over the exports this package already ships: `start` drives a new run on the mesh
 * handler, `resume` takes an existing run over and drives it to quiescence, `ps` lists the run
 * records of an endpoint, `journal` prints a run's durable step journal, and `answer` resolves an
 * open checkpoint through the run driver, which is the only door an answer has (§14).
 *
 * The composition is the run-driver suite's, against a resolved mesh instead of a scratch broker:
 * one raw NATS connection, JetStream + the records bucket over it, the mesh handler bound to this
 * process as holder. Checkpoint EXPIRY rides the mediated timer writer, which the delivery daemon
 * pumps on a live mesh; `start` on a bare broker still runs and still resolves, it just cannot
 * expire a pause.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  newTakeoverId,
  openRecordsBucket,
  readCheckpointSpec,
  readRunRecord,
  replayRunJournal,
  standaloneConnectOpts,
  type ParsedArgs,
} from "@cotal-ai/core";
import type { JournalEntry } from "@cotal-ai/lang";
import { connectOrExit, endpointAuth } from "@cotal-ai/workspace";
import { startRun, driveRun, type DriveOutcome } from "./run-driver.js";
import { MeshHandler, EpfSettleWatcher } from "./mesh-handler.js";
import { openCheckpointToken, resolveCheckpoint } from "./resolve-checkpoint.js";

const USAGE =
  'usage: cotal run <start --file <program> [--run <id>] | resume <runId> --file <program> | ps | journal <runId> | answer <runId> <stepKey> --by <who> [--value <json>]> [--endpoint <ep>] [--space <s>] [--server <url>] [--creds <path>]';

interface RunValues {
  space?: string;
  server?: string;
  creds?: string;
  file?: string;
  run?: string;
  endpoint?: string;
  timeout?: string;
  by?: string;
  value?: string;
  artifact?: string;
}

interface Planes {
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

/** This process, as the run record will name it. Fresh per invocation: a CLI drive is one holder. */
function cliHolder(): { id: string; lifecycleUid: string; instanceId: string } {
  const uid = randomUUID().replaceAll("-", "");
  return { id: "cli-run", lifecycleUid: `u_${uid.slice(0, 20)}`, instanceId: uid.slice(0, 26) };
}

function readProgram(values: RunValues): string {
  if (values.file === undefined) {
    console.error(USAGE);
    console.error("run: --file <program> is required; the record stores no source, so the caller supplies it");
    process.exit(1);
  }
  return readFileSync(values.file, "utf8");
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
  const runId = values.run ?? `run-${Date.now().toString(36)}`;
  const who = cliHolder();
  const handler = new MeshHandler(
    planes.kv,
    planes.js,
    planes.jsm,
    {
      space: planes.space,
      endpoint,
      runId,
      instanceId: who.instanceId,
      epoch: 1,
      holder: { id: who.id, lifecycleUid: who.lifecycleUid },
      defaultCheckpointTimeout: values.timeout ?? "1h",
    },
    new EpfSettleWatcher(planes.js, planes.jsm, planes.space),
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
  const source = readProgram(values);
  const endpoint = values.endpoint ?? "manager";
  const record = await readRunRecord(planes.kv, endpoint, runId);
  if (record === undefined) {
    console.error(`run ${runId}: no record on endpoint ${endpoint}; a run that was never started cannot be resumed`);
    process.exit(1);
  }
  const status = record.status?.value;
  const who = cliHolder();
  const epoch = (status?.epoch ?? 0) + 1;
  const handler = new MeshHandler(
    planes.kv,
    planes.js,
    planes.jsm,
    {
      space: planes.space,
      endpoint,
      runId,
      instanceId: who.instanceId,
      epoch,
      holder: { id: who.id, lifecycleUid: who.lifecycleUid },
      defaultCheckpointTimeout: values.timeout ?? "1h",
    },
    new EpfSettleWatcher(planes.js, planes.jsm, planes.space),
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
  // over the spec half, which every run has exactly once.
  const seen = new Set<string>();
  const rows: string[][] = [];
  const iter = await planes.kv.keys("run.>");
  for await (const key of iter) {
    const parts = key.split(".");
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
    const e = record.entry as {
      scope?: string; kind?: string; name?: string; occurrence?: number;
      state?: string; status?: string; error?: { code?: string };
    };
    const step = `${e.scope ?? ""}/${e.name ? `${e.kind}:${e.name}` : e.kind}#${e.occurrence ?? 0}`;
    const outcome = e.state === "pending" ? "pending" : `${e.status}${e.error?.code ? ` (${e.error.code})` : ""}`;
    console.log(`#${record.n}  step        ${step}  ${outcome}`);
  }
}

async function answer(values: RunValues, planes: Planes, runId: string | undefined, stepKey: string | undefined): Promise<void> {
  if (runId === undefined || stepKey === undefined || values.by === undefined) {
    console.error(USAGE);
    console.error("run answer: <runId> <stepKey> and --by <who> are required");
    process.exit(1);
  }
  const endpoint = values.endpoint ?? "manager";
  // Resume is holder-bound (SPEC 13.10) and the CLI is not the driver, so the presenter is the
  // ARMING holder read back from the checkpoint's own record — the same principal the driver
  // presented as when it minted the pause. The answerer's name rides `by`, never the presenter.
  const replay = await replayRunJournal(planes.js, planes.jsm, planes.space, runId, newTakeoverId());
  const entries = replay.records
    .filter((r) => r.record.kind === "step")
    .map((r) => (r.record as { entry: unknown }).entry as JournalEntry);
  const token = openCheckpointToken(entries, runId, stepKey);
  const spec = await readCheckpointSpec(planes.kv, { endpoint, token });
  if (spec === undefined) {
    console.error(`checkpoint ${token} has a journal entry but no record on endpoint ${endpoint}; refusing to guess a presenter`);
    process.exit(1);
  }
  const result = await resolveCheckpoint(
    { kv: planes.kv, js: planes.js, jsm: planes.jsm, space: planes.space, endpoint, holder: spec.holder },
    {
      runId,
      stepKey,
      by: values.by,
      ...(values.value !== undefined ? { value: JSON.parse(values.value) as unknown } : {}),
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

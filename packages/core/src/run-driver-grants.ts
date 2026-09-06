/**
 * Per-run driver and trusted host credentials. The driver appends its journal and writes its
 * own records. Broker-wide read verbs and checkpoint/registry authority stay on the host,
 * which exposes run-bound operations and never hands this credential to the driver.
 */
import { createHash } from "node:crypto";
import { spacePrefix, chatStream, presenceBucket, channelBucket, membersBucket, assertInboxConnId, DEV_OWNER } from "./subjects.js";
import { endpointToken, assertIdToken, assertLifecycleToken, epCallerReplyFilter, type EpCaller } from "./endpoint-subjects.js";
import { recordsBucket } from "./endpoint-records.js";
import {
  runDriverJournalGrants,
  runJournalReplayGrants,
  recordsKvStreamName,
  epfStreamName,
  eptStreamName,
  epcStreamName,
} from "./endpoint-binding.js";
import { epRequestGrantRows, epDescribeAllGrantRow, BASELINE_LIFECYCLE_ENDPOINT } from "./endpoint-grants.js";

/**
 * The RUN-STABLE caller triple a run's durable actions ride, derived from the run id and nothing
 * else. Goal facts key on the submitting triple, so a resume on any host must re-derive the same
 * one or it polls terminals its own submissions never wrote. The grant rows and the mesh handler
 * both call this, so the credential's rails and the subjects the handler publishes on cannot
 * disagree. Grammar: the actor is `[A-Za-z0-9_]+` and the uid `[a-z0-9]{26,32}`, both satisfied
 * by hex slices of the digest.
 */
export function runDriverCaller(runId: string): EpCaller {
  const h = createHash("sha256").update(assertIdToken(runId, "runId"), "utf8").digest("hex");
  return { owner: DEV_OWNER, actor: `wf_${h.slice(0, 12)}`, uid: h.slice(12, 38) };
}

/** Coordinates for the driver/host pair: replay is takeover-pinned; host schedules also pin instance and epoch. */
export interface RunDriverGrantArgs {
  /** The endpoint hosting the driver: the manager daemon. Leads every record key. */
  endpoint: string;
  runId: string;
  /** The takeover attempt this credential is minted for; names the replay durable (SPEC 14.6). */
  takeoverId: string;
  /** The driving instance's id and epoch: the coordinates its timer schedules are addressed by. */
  instanceId: string;
  epoch: number;
}

export function runDriverGrants(space: string, args: RunDriverGrantArgs, connId: string): { publish: string[]; subscribe: string[] } {
  const endpoint = endpointToken(args.endpoint);
  const run = assertIdToken(args.runId, "runId");
  assertLifecycleToken(args.instanceId, "instanceId");
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 0) throw new Error(`epoch ${args.epoch} is not an unsigned integer`);
  const records = recordsBucket(space);
  return {
    publish: [
      ...runDriverJournalGrants(space, run, args.takeoverId),
      `$KV.${records}.run.${endpoint}.${run}.>`,
      `$KV.${records}.program.${endpoint}.${run}`,
      `$KV.${records}.notice.${endpoint}.${run}.>`,
      `$KV.${records}.migration.${endpoint}.${run}.>`,
      "$JS.API.INFO",
    ],
    subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`],
  };
}

/** Trusted, per-run host connection. The endpoint-wide checkpoint writes and body-selected
 *  records/fact/timer/chat reads are its residual authority. The runtime confines those verbs
 *  behind journal-checked operations; this profile must never be given to the run driver.
 *  It can replay this run's journal to authorize effects, but cannot append a journal entry. */
export function runMediatorGrants(space: string, args: RunDriverGrantArgs, connId: string): { publish: string[]; subscribe: string[] } {
  const e = endpointToken(args.endpoint);
  const run = assertIdToken(args.runId, "runId");
  const iid = assertLifecycleToken(args.instanceId, "instanceId");
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 0) throw new Error(`epoch ${args.epoch} is not an unsigned integer`);
  const p = spacePrefix(space);
  const records = recordsBucket(space);
  const caller = runDriverCaller(run);
  const CHAT = chatStream(space);
  const PKV = `KV_${presenceBucket(space)}`;
  const publish = [
    // Read this run's journal to authorize host operations.
    ...runJournalReplayGrants(space, run, args.takeoverId),
    // Run-owned state and the mediated checkpoint writer.
    `$KV.${records}.run.${e}.${run}.>`,
    `$KV.${records}.program.${e}.${run}`,
    `$KV.${records}.notice.${e}.${run}.>`,
    `$KV.${records}.migration.${e}.${run}.>`,
    `$KV.${records}.cp.${e}.>`,
    `$JS.API.STREAM.MSG.GET.${recordsKvStreamName(space)}`,
    // The checkpoint plane: settle facts (publish), the fact read, the schedule request pinned to
    // this attempt's coordinates, and the fire read.
    `${p}.epf.${e}.cp.>`,
    `$JS.API.STREAM.MSG.GET.${epfStreamName(space)}`,
    `${p}.ept.${e}.${iid}.${args.epoch}.*.schedule`,
    `$JS.API.STREAM.MSG.GET.${eptStreamName(space)}`,
    // Channels: the frontier read a conclave cursors on, the by-sequence re-read of a matched
    // message, and the per-step `wfw_` wait durable (create/bind/ack/delete).
    `$JS.API.STREAM.INFO.${CHAT}`,
    `$JS.API.STREAM.MSG.GET.${CHAT}`,
    `$JS.API.CONSUMER.CREATE.${CHAT}.>`,
    `$JS.API.CONSUMER.INFO.${CHAT}.>`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.>`,
    `$JS.API.CONSUMER.DELETE.${CHAT}.>`,
    `$JS.ACK.${CHAT}.>`,
    // Presence: the ordered-consumer read every agent holds (liveness for turn, down, conclave,
    // worktree claims).
    `$JS.API.STREAM.INFO.${PKV}`,
    `$JS.API.CONSUMER.CREATE.${PKV}.>`,
    `$JS.API.CONSUMER.INFO.${PKV}.>`,
    `$JS.API.CONSUMER.DELETE.${PKV}.>`,
    "$JS.FC.>",
    // Conclaves: the channel registry row and the membership rows a conclave writes and reads.
    `$KV.${channelBucket(space)}.>`,
    `$JS.API.STREAM.MSG.GET.KV_${channelBucket(space)}`,
    `$KV.${membersBucket(space)}.>`,
    `$JS.API.STREAM.MSG.GET.KV_${membersBucket(space)}`,
    // The manager's lifecycle commands, as the run's own caller: describe (the resolve), spawn
    // (untargeted creation), turn and despawn (owner mode, pinned to the caller's owner).
    epDescribeAllGrantRow(space, caller),
    ...epRequestGrantRows(space, { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "spawn" }, caller),
    ...epRequestGrantRows(space, { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "turn", target: { mode: "owner", tOwner: caller.owner } }, caller),
    ...epRequestGrantRows(space, { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "despawn", target: { mode: "owner", tOwner: caller.owner } }, caller),
    // The contract store fetch a resolve performs (the subject-scoped form every agent holds).
    `$JS.API.DIRECT.GET.${epcStreamName(space)}.${p}.epc.>`,
    "$JS.API.INFO",
  ];
  return { publish, subscribe: [epCallerReplyFilter(space, caller), `_INBOX_${assertInboxConnId(connId)}.>`] };
}

/** One served run-surface call's coordinates (SPEC 14.3). */
export interface RunOperatorGrantArgs {
  /** The endpoint hosting the runs: the manager daemon. Leads every record key. */
  endpoint: string;
  /** The ONE run this call replays. Absent for `run-ps`, which walks records and replays no
   *  journal, and for the answering form, which replays nothing (the pause was already found). A
   *  replay durable's name is one token, so no pattern spans runs: the run is pinned at mint or
   *  there is no journal row at all. */
  runId?: string;
  /** The takeover id this call's journal replay durable is named by, one per call. */
  takeoverId: string;
  /** Present for the SECOND half of `run-answer` and NOTHING else: the call files an answer record
   *  and settles ONE checkpoint, named by its token. The token is found first, under the read form,
   *  by replaying the run's journal; only then is this form minted, so the write rows are pinned to
   *  the one pause being answered and reach no other pause on the endpoint. */
  answers?: { token: string };
}

/**
 * The RUN OPERATOR's rows (SPEC 14.3): what the hosting manager needs to SERVE a run's reads and
 * answers without driving it. Minted per served call on its own connection so the serve rails
 * never carry a run's journal or records reach.
 *
 * `run-ps` walks the run records consumer-free; `run-status` also replays the named run's journal
 * through a per-call durable. Both are READS and hold no write row at all. `run-answer` is two
 * calls on two credentials: a READ that replays the journal to find the open pause's token, then
 * an ANSWERING form (`answers: { token }`) that files the answer record and settles that ONE
 * checkpoint. Its three writes are pinned to the token, so an answering credential reaches no
 * other pause of the endpoint, and it holds no replay row at all. The records and EPF reads are
 * stream-wide by the store's own design (a KV point read is `STREAM.MSG.GET` on the one backing
 * stream, and a fact read the same on EPF), the same as every commit-side profile's fencing read.
 * No publish on any journal subject, no run or program record write, no consumer verb on the
 * records store.
 */
export function runOperatorGrants(space: string, args: RunOperatorGrantArgs, connId: string): { publish: string[]; subscribe: string[] } {
  const e = endpointToken(args.endpoint);
  const records = recordsBucket(space);
  const token = args.answers === undefined ? undefined : assertIdToken(args.answers.token, "checkpoint token");
  const publish = [
    // The run and program records of the endpoint, read through the leader-served point read and
    // the consumer-free walk.
    `$JS.API.STREAM.MSG.GET.${recordsKvStreamName(space)}`,
    // The named run's journal replay, read-only, under this call's own takeover id.
    ...(args.runId === undefined ? [] : runJournalReplayGrants(space, args.runId, args.takeoverId)),
    // An ANSWER of one pause: its answer record (create-only), the checkpoint status a settle
    // moves, the one-use settle fact, and the fact read the settle's convergence performs.
    ...(token === undefined
      ? []
      : [`$KV.${records}.answer.${e}.${token}.>`, `$KV.${records}.cp.${e}.${token}.>`, `${spacePrefix(space)}.epf.${e}.cp.${token}`, `$JS.API.STREAM.MSG.GET.${epfStreamName(space)}`]),
    "$JS.API.INFO",
  ];
  return { publish, subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`] };
}

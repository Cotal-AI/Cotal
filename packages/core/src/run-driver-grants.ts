/**
 * The RUN DRIVER's grant rows (SPEC 14.6): minted per run and per takeover attempt.
 *
 * A run driver is the process that holds one workflow run: it appends the run's step journal,
 * writes the run's own records, arms and observes the run's pauses on the checkpoint plane, waits on
 * channels, joins seats into conclaves, and asks the manager to spawn, turn and despawn the seats
 * the program names. Until this builder existed the CLI drove runs as `admin`, which holds none of
 * the control-surface rows a driver needs, so on an enforcing broker `cotal run start` was refused
 * at its first record read. The rows here are exactly what the mesh handler and the run driver
 * perform, enumerated from their code paths, with every run-derivable token pinned.
 *
 * WHAT IS PINNED TO THE RUN: the journal subject and the per-takeover replay durable
 * ({@link runDriverJournalGrants}), the run's own `run`, `program`, `notice` and `migration`
 * records, the ep caller triple (derived from the run id by {@link runDriverCaller}, so the
 * request rails and reply filter name one caller per run), and the timer schedule row (the
 * instance and epoch of this attempt).
 *
 * WHAT CANNOT BE, and is a NAMED RESIDUAL of this trusted profile:
 *   1. Checkpoint records and settle facts (`cp.<e>.>`, `epf.<e>.cp.>`, `answer.<e>.>`) are keyed by
 *      TOKEN, and a token is a step's request id, not run-derivable at mint. A driver can therefore
 *      arm, heartbeat, claim or answer any pause of its endpoint, not only its own run's. Same class
 *      as the commit principal's own residual on the same rows.
 *   2. The body-selected `STREAM.MSG.GET` reads on the records KV, EPF, EPT and CHAT are stream-wide:
 *      a compromised driver reads other runs' records, other pauses' facts and timers, and any chat
 *      message by sequence. Same class as every commit-side profile's fencing reads. There is NO
 *      such read on WFJ: a driver reads its own journal through its filtered replay durable only,
 *      which is what keeps one run's effect results out of another run's reach (SPEC 14.6).
 *   3. A `wait` holds its position on a channel in a durable named `wfw_<requestId>`, per step, so
 *      the CHAT consumer rows are stream-scoped (`.>` in the name token): a driver can read any
 *      channel's history through a consumer it creates. Same rows the observer and admin profiles
 *      hold, minus the bare ephemeral-create form, which no profile may hold.
 *   4. The presence bucket is read through the ordered consumer every agent uses (the roster is
 *      world-readable); the channel registry and the members registry are written under `.>`
 *      because a conclave's channel may be program-named.
 *
 * NOT here, by construction: no consumer verb of any kind on the records authority stream (the
 * driver enumerates its own notices and migrations through a consumer-free `STREAM.MSG.GET` walk),
 * no goal fact publish (the manager commits goals), no `epj` submission, no chat publish, no
 * destructive stream verb, no read of the auth store.
 */
import { createHash } from "node:crypto";
import { spacePrefix, chatStream, presenceBucket, channelBucket, membersBucket, assertInboxConnId, DEV_OWNER } from "./subjects.js";
import { endpointToken, assertIdToken, assertLifecycleToken, epCallerReplyFilter, type EpCaller } from "./endpoint-subjects.js";
import { recordsBucket } from "./endpoint-records.js";
import {
  runDriverJournalGrants,
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

/** One drive attempt's coordinates, all of which the rows pin. */
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
    // The step journal: publish on the run's subject, and the per-takeover replay durable.
    ...runDriverJournalGrants(space, run, args.takeoverId),
    // The run's own records, run-pinned where the key allows it (see the header for `cp`/`answer`).
    `$KV.${records}.run.${e}.${run}.>`,
    `$KV.${records}.program.${e}.${run}`,
    `$KV.${records}.notice.${e}.${run}.>`,
    `$KV.${records}.migration.${e}.${run}.>`,
    `$KV.${records}.cp.${e}.>`,
    `$KV.${records}.answer.${e}.>`,
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

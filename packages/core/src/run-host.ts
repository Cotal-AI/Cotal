/**
 * The RUN HOST contract (SPEC 14.3): what a daemon that hosts workflow runs asks of the language
 * runtime, as an {@link Extension} of kind `"run-host"`.
 *
 * The manager hosts a run's driver, and `@cotal-ai/runtime` is the driver; `implementations/*`
 * never import each other, so the seam between them is this contract, registered by the runtime
 * on import and resolved by the manager by name, the same way a `RuntimeProvider` reaches the
 * manager. Everything here is expressed in core terms: planes over one broker connection, the
 * lease a takeover holds, the rows a listing and a journal view render. Nothing about the
 * language itself (its entries, its errors) crosses this boundary typed; a validation refusal is
 * carried as the runtime's own JSON, opaque to the host, and handed to the caller verbatim.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import type { Extension } from "./registry.js";
import type { RunSpecValue, RunStatusValue } from "./run-record.js";

/** The kind every run host registers under. */
export const RUN_HOST_KIND = "run-host";
/** The one language this tree ships a host for. */
export const COTAL_LANG_RUN_HOST = "cotal-lang";
/** The `error.details[].kind` a hosting daemon's validation refusal carries one language problem
 *  under (SPEC 13.3 extension detail): the record is the validator's own `LangErrorJson`. */
export const LANG_PROBLEM_DETAIL_KIND = "ai.cotal.lang.problem";
/** How long a hosting daemon waits for a launched drive's status record before answering a
 *  start or resume. A client's invoke deadline for those two commands MUST exceed this, or the
 *  daemon's "still launching" refusal can never reach the caller (it would time out first and
 *  read as no manager answering). */
export const RUN_ACTIVATION_WAIT_MS = 15_000;
/** The invoke deadline a `run-start` / `run-resume` client uses: the activation wait plus the
 *  round trips around it. */
export const RUN_LAUNCH_DEADLINE_MS = RUN_ACTIVATION_WAIT_MS + 10_000;

/** The planes a drive, an answer or a read rides: ONE broker connection and what hangs off it.
 *  The host that opens the connection knows whose credential it carries; the run host does not. */
export interface RunHostPlanes {
  readonly nc: NatsConnection;
  readonly js: JetStreamClient;
  readonly jsm: JetStreamManager;
  readonly kv: KV;
  readonly space: string;
}

/** What one drive attempt holds (SPEC 14.4). `takeoverId` names the replay durable the attempt's
 *  credential was minted for, which is why it arrives with the lease rather than being chosen by
 *  the driver. */
export interface RunHostLease {
  readonly holder: string;
  readonly epoch: number;
  readonly fencingToken: number;
  readonly takeoverId: string;
}

export interface RunHostDriveRequest {
  /** `new` starts a run that has never been driven; `existing` takes a recorded run over. */
  readonly mode: "new" | "existing";
  readonly endpoint: string;
  readonly runId: string;
  readonly source: string;
  readonly file?: string;
  readonly lease: RunHostLease;
  /** The process holding the run, as a checkpoint's holder-bound resume will name it. */
  readonly holder: { readonly id: string; readonly lifecycleUid: string };
  /** The driving instance and epoch: the coordinates its timer schedules are addressed by. */
  readonly instanceId: string;
  readonly epoch: number;
  readonly defaultCheckpointTimeout: string;
  /** The most bytes a settled result may take, from the connection's own `max_payload`. */
  readonly resultBytes?: number;
}

/** How a drive attempt ended. `released` is the driver saying the run is not its to continue (a
 *  takeover won, a step was refused on this host, the host asked it to stop, the run was never
 *  resumable); `failed` is the program's own failure. Both leave the journal where it is; a later
 *  attempt resumes from there. */
export type RunHostOutcome =
  | { readonly status: "completed"; readonly steps: number; readonly value?: unknown }
  | { readonly status: "released"; readonly reason: { readonly name: string; readonly message: string } }
  | { readonly status: "failed"; readonly error: { readonly name: string; readonly message: string; readonly code?: string } };

/** A drive in flight. `release` asks the driver to stop at its next effect boundary and record the
 *  run `released` for the host's reason, never the program's; a drive parked inside a long pause
 *  reaches no boundary until the pause settles, so a host that must stop sooner closes the
 *  connection under it and the journal is the recovery. */
export interface RunHostDrive {
  readonly done: Promise<RunHostOutcome>;
  release(reason: string): void;
}

export interface RunHostAnswerRequest {
  readonly endpoint: string;
  readonly runId: string;
  /** The takeover id the journal replay of this call is named by: the one the caller's credential
   *  was minted for, so the replay durable the resolver creates is the row the caller holds. */
  readonly takeoverId: string;
  /** The step's canonical key string, as `journal` renders it. */
  readonly stepKey: string;
  /** The answerer as the host's authorization knows them (SPEC 14.5): derived by the host from
   *  the caller's authenticated principal, never taken from the request body. */
  readonly by: string;
  readonly value?: unknown;
  readonly artifact?: string;
  readonly now: number;
}

/** One row of `cotal run ps`. Absent status means a spec with no status yet. */
export interface RunListRow {
  readonly runId: string;
  readonly endpoint: string;
  readonly state?: RunStatusValue["state"];
  readonly holder?: string;
  readonly epoch?: number;
  readonly journalHigh?: number;
  readonly forkedFrom?: { readonly run: string; readonly step: string };
}

/** One row of a run's journal view. */
export type RunJournalRow =
  | { readonly n: number; readonly kind: "activation"; readonly holder: string; readonly epoch: number; readonly replayedTo: number }
  | {
      readonly n: number;
      readonly kind: "step";
      readonly step: string;
      readonly state: "pending" | "settled";
      /** `pending`, or the settled status with its error code when there is one. */
      readonly outcome: string;
      /** What an open pause asks, present only while it is open. */
      readonly asks?: string;
      readonly addressee?: string;
    };

export interface RunStatusView {
  readonly runId: string;
  readonly endpoint: string;
  readonly spec: RunSpecValue;
  readonly status?: RunStatusValue;
  readonly journal: RunJournalRow[];
}

export type RunValidation =
  | { readonly ok: true }
  /** The runtime's own error records, one per problem, opaque here and handed on verbatim. */
  | { readonly ok: false; readonly errors: readonly Record<string, unknown>[] };

export interface RunHost extends Extension {
  readonly kind: typeof RUN_HOST_KIND;
  readonly name: string;
  /** Parse and validate a program with no broker. A refusal carries every problem found. */
  validate(source: string, file?: string): RunValidation;
  /** Drive a run over `planes`. Returns as soon as the drive is launched; `done` settles when the
   *  run completes, is released, or fails, and never rejects. */
  drive(planes: RunHostPlanes, req: RunHostDriveRequest): RunHostDrive;
  /** Answer an open checkpoint, or an open `ask` attempt, through the driver's own door. */
  answer(planes: RunHostPlanes, req: RunHostAnswerRequest): Promise<unknown>;
  /** The run's record plus its journal view, or undefined when no run record exists. The replay
   *  rides a durable named by `takeoverId`, the one the caller's credential row pins. */
  status(planes: RunHostPlanes, req: { readonly endpoint: string; readonly runId: string; readonly takeoverId: string }): Promise<RunStatusView | undefined>;
  /** Every run recorded on `endpoint`, or on every endpoint when none is named. */
  list(planes: RunHostPlanes, req: { readonly endpoint?: string }): Promise<RunListRow[]>;
}

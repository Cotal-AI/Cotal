/**
 * The manager as a WORKFLOW-RUN HOST (SPEC 14.3): where a run's driver lives when nobody's
 * terminal is holding it.
 *
 * The manager serves five commands: `run-start` and `run-resume` hand a program to a driver hosted
 * IN THIS PROCESS and answer with the run id once the attempt's status record is a fact in the
 * store (or with why it never became one); `run-answer` resolves an open checkpoint;
 * `run-status` and `run-ps` read. The manager knows nothing about the language: it resolves the
 * registered {@link RunHost} by name and drives through that contract, so `@cotal-ai/runtime` stays
 * an implementation the manager never imports.
 *
 * Every drive rides its OWN connection under its OWN credential, never the serve connection and
 * never the manager's supervisor identity. On an auth mesh that credential is the per-run,
 * per-takeover `run-driver` profile (SPEC 14.6), minted from the space signer with the attempt's
 * exact coordinates, and re-minted for the same nkey on the renewal loop so a run parked for days
 * outlives the credential's TTL. A served read or answer rides a one-shot `run-operator` credential
 * minted for that one call, so the serve handler's reach over the records store is exactly the
 * call's and expires with it; an answer is two such calls, the read that finds the pause and then
 * a write pinned to that pause's token. An open mesh has no credential system and connects bare.
 *
 * A USER-AUTH mesh hosts no runs, and the manager says so instead of standing this host up: a
 * hosted run's spawns, turns and despawns ride a caller derived from the run id under the static
 * owner, which is no user's, so on a user mesh they would be refused at the manager's own owner
 * check and the program would fail at its first seat. Until a run carries its starting user's
 * owner into that caller, the family is `unimplemented` there, named as such.
 *
 * A manager restart takes its runs back: at boot, every run recorded `running` under this
 * endpoint is resumed under a fresh takeover, epoch + 1, from its recorded program. A run whose
 * predecessor died mid-pause is picked up where its journal says it is; nothing about the crash is
 * recorded as the program's outcome. Until that reconcile has returned, `run-start` and
 * `run-resume` are refused `unavailable`: a resume served while the reconcile is still collecting
 * would launch a second attempt of a run the reconcile is about to take back.
 *
 * ONE ATTEMPT PER RUN, HELD SYNCHRONOUSLY. A run's slot in the live map is claimed before the
 * first await of a launch and released only by that attempt's own end: its drive's completion, or
 * any refusal on the way to one, the admission cap included. So two concurrent resumes, or a
 * resume racing the boot reconcile, cannot both reach the activation barrier, and a refused
 * attempt leaves nothing behind that a later one would read as held. Each attempt
 * also presents its OWN holder id (the manager's endpoint id plus the takeover id): the journal's
 * activation barrier admits an identical (token, holder, epoch) tuple as the same process picking
 * its run back up, so a constant holder id would let two attempts co-activate through that
 * relaxation instead of one being refused.
 */
import { randomBytes } from "node:crypto";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  COTAL_LANG_RUN_HOST,
  DEFAULT_SERVER,
  EpEnvelopeError,
  LANG_PROBLEM_DETAIL_KIND,
  RUN_ACTIVATION_WAIT_MS,
  RUN_HOST_KIND,
  inspectCredHealth,
  mintCreds,
  newIdentity,
  newTakeoverId,
  openRecordsBucket,
  readRunProgram,
  readRunRecord,
  registry,
  standaloneConnectOpts,
  walkKvEntries,
  type Identity,
  type RunHost,
  type RunHostDrive,
  type RunHostOpenPause,
  type RunHostOutcome,
  type RunHostPlanes,
  type RunListRow,
  type RunProgramValue,
  type RunStatusValue,
  type RunStatusView,
  type SpaceAuth,
} from "@cotal-ai/core";

/** What the host needs from the manager: its coordinates and its trust material. */
export interface RunHostingContext {
  readonly space: string;
  readonly servers: string | undefined;
  /** The endpoint hosting the runs: the manager's own service name. */
  readonly endpoint: string;
  /** The registration instance id, the coordinate a checkpoint's timer schedule is addressed by. */
  readonly instanceId: string;
  /** This manager process, as a checkpoint's holder-bound resume names it. Each attempt's holder
   *  id is derived from `id` and the takeover id (see the header). */
  readonly holder: { readonly id: string; readonly lifecycleUid: string };
  /** The space signer on an auth mesh; undefined on an open mesh (bare connections). */
  readonly auth: SpaceAuth | undefined;
  readonly log: (line: string) => void;
}

interface HostedRun {
  readonly runId: string;
  readonly takeoverId: string;
  readonly epoch: number;
  readonly identity: Identity;
  readonly mediatorIdentity: Identity;
  /** Set once the connection is up; a slot reserved before that holds neither. */
  nc?: NatsConnection;
  mediatorNc?: NatsConnection;
  drive?: RunHostDrive;
  /** The current credential, re-minted in place by the renewal loop; the authenticator reads it
   *  on every (re)connect. Undefined on an open mesh. */
  creds?: string;
  mediatorCreds?: string;
}

const DEFAULT_CHECKPOINT_TIMEOUT = "1h";
/** How many launches (start or resume) may be in their activation wait at once. Each holds a
 *  standing connection and a minted credential; past this a caller is refused `resource-exhausted`
 *  rather than letting a burst of starts pin unbounded connections for the wait's length. */
const MAX_LAUNCHING = 8;

export class RunHosting {
  private readonly runs = new Map<string, HostedRun>();
  private launching = 0;
  private reconciled = false;
  private stopping = false;

  constructor(private readonly ctx: RunHostingContext) {}

  /** The one registered run host. Absent means the composition root never imported the runtime,
   *  which is a configuration error named here rather than a silent no-op surface. */
  private host(): RunHost {
    return registry.resolve<RunHost>(RUN_HOST_KIND, COTAL_LANG_RUN_HOST);
  }

  /** The boot gate: no launch is served until the reconcile has taken back what a predecessor
   *  was driving (see the header). */
  private assertReconciled(): void {
    if (!this.reconciled)
      throw new EpEnvelopeError("unavailable", "the manager is still taking back the workflow runs a predecessor was driving; retry shortly (SPEC 14.3)");
  }

  /** `run-start`: validate, mint the id, launch the drive, answer. The drive continues off-handler. */
  async start(args: { source: string; file?: string; timeout?: string }): Promise<{ runId: string }> {
    this.assertReconciled();
    const host = this.host();
    const verdict = host.validate(args.source, args.file);
    if (!verdict.ok) {
      // The refusal carries every problem, as the runtime's own records, so a caller (a person at
      // the CLI, an agent at the tool) can fix the program without a second round-trip. The
      // rendered source frame stays out of it: the caller holds the source, and a refusal is not
      // the place to echo it back.
      throw new EpEnvelopeError(
        "bad-request",
        `the program does not validate (${verdict.errors.length} problem${verdict.errors.length === 1 ? "" : "s"})`,
        verdict.errors.map((e) => ({ kind: LANG_PROBLEM_DETAIL_KIND, ...withoutFrame(e) })),
      );
    }
    // Minted here, never caller-supplied: the records table binds run-id minting to the driver.
    // 128 bits, the width the spec's other minted identifiers carry.
    const runId = `run-${randomBytes(16).toString("hex")}`;
    await this.launch(host, {
      mode: "new",
      runId,
      source: args.source,
      ...(args.file !== undefined ? { file: args.file } : {}),
      epoch: 1,
      fencingToken: 1,
      timeout: args.timeout ?? DEFAULT_CHECKPOINT_TIMEOUT,
    });
    return { runId };
  }

  /** `run-resume`: take a recorded run over under a fresh takeover and continue it from its journal.
   *  The source is the recorded program; a run started before programs were recorded has no
   *  hosted resume, and says so. The slot is claimed before the record read, so a second resume
   *  arriving during it is a conflict rather than a second attempt. */
  async resume(args: { runId: string; timeout?: string }): Promise<{ runId: string }> {
    this.assertReconciled();
    const host = this.host();
    const slot = this.claim(args.runId);
    let found: { status: RunStatusValue | undefined; program: RunProgramValue | undefined } | undefined;
    try {
      found = await this.withOperator({ runId: args.runId }, async (_planes, kv) => {
        const record = await readRunRecord(kv, this.ctx.endpoint, args.runId);
        if (record === undefined) return undefined;
        const program = await readRunProgram(kv, this.ctx.endpoint, args.runId);
        return { status: record.status?.value, program };
      });
      if (found === undefined)
        throw new EpEnvelopeError("not-found", `run ${args.runId}: no record on endpoint ${this.ctx.endpoint}; a run that was never started cannot be resumed`);
      if (found.program === undefined)
        throw new EpEnvelopeError("failed-precondition", `run ${args.runId}: no program is recorded for it, so a hosted resume has no source to run; drive it from a terminal with \`cotal run resume ${args.runId} --local --file <program>\``);
    } catch (e) {
      // Nothing was launched: the slot is this call's to give back.
      this.free(slot);
      throw e;
    }
    // From here the slot is the launch's: every refusal there frees it, or the drive's own end does.
    await this.launch(host, {
      mode: "existing",
      runId: args.runId,
      source: found.program.source,
      ...(found.program.file !== undefined ? { file: found.program.file } : {}),
      epoch: (found.status?.epoch ?? 0) + 1,
      fencingToken: (found.status?.fencingToken ?? 0) + 1,
      timeout: args.timeout ?? DEFAULT_CHECKPOINT_TIMEOUT,
    }, slot);
    return { runId: args.runId };
  }

  /** `run-answer`: resolve an open checkpoint, or an open `ask` attempt, through the driver's door.
   *  Two credentials: a READ that replays the run's journal to the open pause, then an ANSWERING
   *  one minted for that pause's token alone, so the writes reach no other pause on the endpoint.
   *  `by` is the caller as the manager knows them, decided by the serve layer from the
   *  authenticated principal (SPEC 14.5), never read from the request. */
  async answer(args: { runId: string; endpoint?: string; stepKey: string; value?: unknown; artifact?: string }, by: string): Promise<unknown> {
    const host = this.host();
    const endpoint = args.endpoint ?? this.ctx.endpoint;
    let open: RunHostOpenPause;
    try {
      open = await this.withOperator({ endpoint, runId: args.runId }, (planes, _kv, takeoverId) =>
        host.locate(planes, { endpoint, runId: args.runId, takeoverId, stepKey: args.stepKey }));
    } catch (e) {
      // The resolver's own refusal is a fact about the run, worded for the caller: no open
      // checkpoint at that key is `not-found`; the plane's own envelope errors pass through.
      if (e instanceof EpEnvelopeError) throw e;
      if ((e as { name?: string }).name === "CheckpointNotOpen") throw new EpEnvelopeError("not-found", (e as Error).message);
      throw e;
    }
    return await this.withOperator({ endpoint, answers: { token: open.token } }, (planes) =>
      host.answer(planes, {
        endpoint,
        open,
        by,
        ...(args.value !== undefined ? { value: args.value } : {}),
        ...(args.artifact !== undefined ? { artifact: args.artifact } : {}),
        now: Date.now(),
      }));
  }

  /** `run-status`: the record plus the journal view. */
  async status(args: { runId: string; endpoint?: string }): Promise<RunStatusView> {
    const host = this.host();
    const endpoint = args.endpoint ?? this.ctx.endpoint;
    const view = await this.withOperator({ endpoint, runId: args.runId }, (planes, _kv, takeoverId) =>
      host.status(planes, { endpoint, runId: args.runId, takeoverId }));
    if (view === undefined) throw new EpEnvelopeError("not-found", `run ${args.runId}: no record on endpoint ${endpoint}`);
    return view;
  }

  /** `run-ps`: every run recorded on the endpoint (or every endpoint). */
  async list(args: { endpoint?: string }): Promise<RunListRow[]> {
    const host = this.host();
    return await this.withOperator({ ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}) }, (planes) =>
      host.list(planes, args.endpoint !== undefined ? { endpoint: args.endpoint } : {}));
  }

  /** Boot: take back every run this endpoint recorded `running`. A dead predecessor's drive left
   *  its status at `running`; a successor resumes each one under a fresh takeover. A run with no
   *  recorded program is left alone and named: nothing can be resumed without its source. Never
   *  fatal to the manager; a run that cannot be taken back is logged, not lost (its journal
   *  stands). Opens the boot gate on return, whichever way it went: a reconcile that could not
   *  read the store leaves the family serving, since a later resume by hand is the remedy. */
  async reconcile(): Promise<void> {
    try {
      await this.takeBack();
    } finally {
      this.reconciled = true;
    }
  }

  private async takeBack(): Promise<void> {
    let inherited: { runId: string; epoch: number; fencingToken: number; source: string; file?: string }[] = [];
    try {
      inherited = await this.withOperator({}, async (_planes, kv) => {
        const out: typeof inherited = [];
        for (const e of await walkKvEntries(kv, `run.${this.ctx.endpoint}.*.spec`)) {
          const runId = e.key.split(".")[2];
          if (runId === undefined) continue;
          const record = await readRunRecord(kv, this.ctx.endpoint, runId);
          const status = record?.status?.value;
          if (status === undefined || status.state !== "running") continue;
          const program = await readRunProgram(kv, this.ctx.endpoint, runId);
          if (program === undefined) {
            this.ctx.log(`! run ${runId} is recorded running with no recorded program; it cannot be taken back here - resume it from a terminal with \`cotal run resume ${runId} --local --file <program>\``);
            continue;
          }
          out.push({ runId, epoch: status.epoch + 1, fencingToken: status.fencingToken + 1, source: program.source, ...(program.file !== undefined ? { file: program.file } : {}) });
        }
        return out;
      });
    } catch (e) {
      this.ctx.log(`! workflow-run boot reconcile failed: ${(e as Error).message} - runs a predecessor was driving stay parked until the next restart or a \`cotal run resume <runId>\``);
      return;
    }
    if (inherited.length === 0) return;
    const host = this.host();
    for (const r of inherited) {
      try {
        await this.launch(host, { mode: "existing", runId: r.runId, source: r.source, ...(r.file !== undefined ? { file: r.file } : {}), epoch: r.epoch, fencingToken: r.fencingToken, timeout: DEFAULT_CHECKPOINT_TIMEOUT });
      } catch (e) {
        this.ctx.log(`! run ${r.runId} could not be taken back: ${(e as Error).message}`);
      }
    }
    this.ctx.log(`workflow-run boot reconcile: took back ${inherited.length} run(s) recorded running`);
  }

  /** Renewal: re-mint every live drive's `run-driver` credential for the SAME nkey and attempt
   *  coordinates when it is past its renewal point; the connection presents the fresh one on its
   *  next (re)connect. Open mesh: nothing to renew. */
  async renew(): Promise<void> {
    const auth = this.ctx.auth;
    if (!auth) return;
    for (const run of this.runs.values()) {
      const pin = { endpoint: this.ctx.endpoint, runId: run.runId, takeoverId: run.takeoverId, instanceId: this.ctx.instanceId, epoch: run.epoch };
      if (run.creds !== undefined && inspectCredHealth(run.creds).state !== "healthy") {
        try {
          run.creds = await mintCreds(auth, run.identity, "run-driver", { runDriver: pin });
        } catch (e) {
          this.ctx.log(`! run-driver renewal for ${run.runId}: ${(e as Error).message}`);
        }
      }
      if (run.mediatorCreds !== undefined && inspectCredHealth(run.mediatorCreds).state !== "healthy") {
        try {
          run.mediatorCreds = await mintCreds(auth, run.mediatorIdentity, "run-mediator", { runMediator: pin });
        } catch (e) {
          this.ctx.log(`! run-mediator renewal for ${run.runId}: ${(e as Error).message}`);
        }
      }
    }
  }

  /** Shutdown: ask every drive to stop at its next boundary and drain the connections of those
   *  that reach one. A drive parked in a pause reaches no boundary; its connection is closed under
   *  it, so nothing it writes on the way out can land and its record stays `running`, which is what
   *  the next incarnation's reconcile takes back. A slot still launching holds no drive yet; its
   *  launch sees `stopping` and closes its own connection. */
  async stop(): Promise<void> {
    this.stopping = true;
    const live = [...this.runs.values()].filter((r): r is HostedRun & { nc: NatsConnection; drive: RunHostDrive } => r.nc !== undefined && r.drive !== undefined);
    this.runs.clear();
    for (const run of live) run.drive.release("the hosting manager is stopping");
    await Promise.all(live.map(async (run) => {
      const reached = await Promise.race([run.drive.done.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 2_000))]);
      if (reached) await run.nc.drain().catch(() => run.nc.close());
      else await run.nc.close();
      await run.mediatorNc?.close();
    }));
  }

  /** How many drives this incarnation holds; the status surface reads it. */
  get liveCount(): number {
    return this.runs.size;
  }

  /** Claim a run's slot SYNCHRONOUSLY: the one place the occupancy rule is decided, with no await
   *  between the check and the set. A held slot is a conflict for every later claimant until the
   *  attempt that holds it ends. */
  private claim(runId: string): HostedRun {
    if (this.runs.has(runId)) throw new EpEnvelopeError("conflict", `run ${runId} is being driven by this manager already`);
    const takeoverId = newTakeoverId();
    const slot: HostedRun = { runId, takeoverId, epoch: 0, identity: newIdentity(), mediatorIdentity: newIdentity() };
    this.runs.set(runId, slot);
    return slot;
  }

  /** Release a slot, only if it is still this attempt's: a later attempt of the same run is a new
   *  entry and is never removed by an earlier one's end. */
  private free(slot: HostedRun): void {
    if (this.runs.get(slot.runId) === slot) this.runs.delete(slot.runId);
  }

  /** Launch one attempt on a slot. The slot is claimed here when the caller has not already
   *  (`start`), and is this launch's to give back from the first line: every refusal below,
   *  including the two before a drive is attempted, frees a slot whose drive never started. */
  private async launch(
    host: RunHost,
    req: { mode: "new" | "existing"; runId: string; source: string; file?: string; epoch: number; fencingToken: number; timeout: string },
    claimed?: HostedRun,
  ): Promise<void> {
    const slot = claimed ?? this.claim(req.runId);
    try {
      if (this.stopping) throw new EpEnvelopeError("unavailable", "the manager is stopping and hosts no new drives");
      if (this.launching >= MAX_LAUNCHING)
        throw new EpEnvelopeError("resource-exhausted", `${MAX_LAUNCHING} workflow runs are launching on this manager already; retry once one has activated`);
      this.launching += 1;
      try {
        await this.drive(host, req, slot);
      } finally {
        this.launching -= 1;
      }
    } catch (e) {
      // A slot whose drive never started is freed here; one whose drive exists is freed by that
      // drive's own end, so the run reads as held until its attempt has stopped.
      if (slot.drive === undefined) this.free(slot);
      throw e;
    }
  }

  private async drive(
    host: RunHost,
    req: { mode: "new" | "existing"; runId: string; source: string; file?: string; epoch: number; fencingToken: number; timeout: string },
    slot: HostedRun,
  ): Promise<void> {
    const { takeoverId, identity, mediatorIdentity } = slot;
    const auth = this.ctx.auth;
    const creds = auth
      ? await mintCreds(auth, identity, "run-driver", {
          runDriver: { endpoint: this.ctx.endpoint, runId: req.runId, takeoverId, instanceId: this.ctx.instanceId, epoch: req.epoch },
        })
      : undefined;
    const mediatorCreds = auth
      ? await mintCreds(auth, mediatorIdentity, "run-mediator", {
          runMediator: { endpoint: this.ctx.endpoint, runId: req.runId, takeoverId, instanceId: this.ctx.instanceId, epoch: req.epoch },
        })
      : undefined;
    // The attempt's coordinates on the slot before the connection: the renewal loop re-mints from
    // these, and the epoch is a per-attempt fact.
    const holder: HostedRun = Object.assign(slot, { epoch: req.epoch, ...(creds !== undefined ? { creds, mediatorCreds } : {}) });
    const enc = new TextEncoder();
    // A STANDING connection: the drive may park for hours inside a pause, so it reconnects without
    // bound and presents whatever credential the renewal loop last minted.
    const nc = await connect({
      servers: this.ctx.servers ?? DEFAULT_SERVER,
      ...(creds !== undefined
        ? { authenticator: (nonce?: string) => credsAuthenticator(enc.encode(holder.creds!))(nonce), inboxPrefix: `_INBOX_${identity.id}` }
        : {}),
      maxReconnectAttempts: -1,
    });
    let planes: RunHostPlanes;
    let mediator: RunHostPlanes;
    let mediatorNc: NatsConnection | undefined;
    try {
      planes = { nc, js: jetstream(nc), jsm: await jetstreamManager(nc), kv: await openRecordsBucket(nc, this.ctx.space), space: this.ctx.space };
      mediatorNc = await connect({
        servers: this.ctx.servers ?? DEFAULT_SERVER,
        ...(mediatorCreds !== undefined
          ? { authenticator: (nonce?: string) => credsAuthenticator(enc.encode(holder.mediatorCreds!))(nonce), inboxPrefix: `_INBOX_${mediatorIdentity.id}` }
          : {}),
        maxReconnectAttempts: -1,
      });
      mediator = { nc: mediatorNc, js: jetstream(mediatorNc), jsm: await jetstreamManager(mediatorNc), kv: await openRecordsBucket(mediatorNc, this.ctx.space), space: this.ctx.space };
      // Checked AFTER the last await before the drive starts: a stop that landed during the
      // connect has already cleared the live map, and a drive started now would be nobody's.
      if (this.stopping) throw new EpEnvelopeError("unavailable", "the manager is stopping and hosts no new drives");
    } catch (e) {
      await mediatorNc?.close();
      await nc.drain().catch(() => nc.close());
      throw e;
    }
    const max = nc.info?.max_payload;
    // The holder this attempt activates as: this process AND this attempt (see the header).
    const attemptHolder = { id: `${this.ctx.holder.id}.${takeoverId}`, lifecycleUid: this.ctx.holder.lifecycleUid };
    let drive: RunHostDrive;
    try {
      drive = host.drive(planes, {
        mode: req.mode,
        endpoint: this.ctx.endpoint,
        runId: req.runId,
        source: req.source,
        ...(req.file !== undefined ? { file: req.file } : {}),
        lease: { holder: attemptHolder.id, epoch: req.epoch, fencingToken: req.fencingToken, takeoverId },
        holder: attemptHolder,
        instanceId: this.ctx.instanceId,
        epoch: req.epoch,
        defaultCheckpointTimeout: req.timeout,
        // The broker's own max_payload, minus headroom for the record envelope around the entry.
        ...(typeof max === "number" && max > 4096 ? { resultBytes: max - 4096 } : {}),
      }, mediator);
    } catch (error) {
      await nc.close();
      await mediatorNc?.close();
      throw error;
    }
    holder.nc = nc;
    holder.mediatorNc = mediatorNc;
    holder.drive = drive;
    const activation = this.activated(mediator.kv, req, drive);
    void drive.done.then(async (out) => {
      this.ctx.log(`run ${req.runId}: ${describeOutcome(out)}`);
      this.free(holder);
      // The activation wait reads the record over this connection; it finishes before the drain.
      await activation.catch(() => undefined);
      await nc.drain().catch(() => nc.close());
      await mediatorNc?.drain().catch(() => mediatorNc?.close());
    });
    try {
      await activation;
    } catch (e) {
      // An attempt that never activated in time is not left holding a slot and a connection with
      // nobody's word on it: it is released, and a drive that reaches no boundary within a
      // moment has its connection closed under it, the same way a stop treats a parked drive.
      // Its own end then frees the slot.
      drive.release(`the hosting manager gave up waiting for its activation: ${(e as Error).message}`);
      const reached = await Promise.race([drive.done.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 2_000))]);
      if (!reached) {
        await nc.close();
        await mediatorNc?.close();
      }
      throw e;
    }
    this.ctx.log(`run ${req.runId}: ${req.mode === "new" ? "started" : "resumed"} on endpoint ${this.ctx.endpoint} (epoch ${req.epoch}, takeover ${takeoverId})`);
  }

  /** Answer only once this attempt's status is recorded, or the drive has said why it never was:
   *  a caller handed an id for a run whose activation then failed would find nothing under it. A
   *  run that completes inside the wait has its record and is answered like any other. */
  private async activated(kv: KV, req: { runId: string; epoch: number }, drive: RunHostDrive): Promise<void> {
    const recorded = async (): Promise<boolean> =>
      (await readRunRecord(kv, this.ctx.endpoint, req.runId))?.status?.value.epoch === req.epoch;
    const settled = drive.done.then((out) => ({ out }));
    const deadline = Date.now() + RUN_ACTIVATION_WAIT_MS;
    for (;;) {
      if (await recorded()) return;
      const early = await Promise.race([settled, new Promise<undefined>((r) => setTimeout(r, 50))]);
      if (early !== undefined) {
        if (await recorded()) return;
        throw new EpEnvelopeError(
          early.out.status === "failed" ? "internal" : "failed-precondition",
          `run ${req.runId} did not start: ${describeOutcome(early.out)}`,
        );
      }
      if (Date.now() > deadline)
        throw new EpEnvelopeError("unavailable", `run ${req.runId}: its drive has not activated after ${RUN_ACTIVATION_WAIT_MS / 1000}s and was released; \`cotal run ps\` shows what it recorded, and a \`cotal run resume ${req.runId}\` tries again`);
    }
  }

  /** One served read or answer over a one-shot `run-operator` connection (open mesh: bare). The
   *  takeover id the rows are minted for is handed to `fn`, so a journal replay inside names the
   *  durable the credential admits. Only an answering call holds the answer and settle writes,
   *  and those are pinned to the one pause it names. */
  private async withOperator<T>(
    scope: { endpoint?: string; runId?: string; answers?: { token: string } },
    fn: (planes: RunHostPlanes, kv: KV, takeoverId: string) => Promise<T>,
  ): Promise<T> {
    const takeoverId = newTakeoverId();
    const endpoint = scope.endpoint ?? this.ctx.endpoint;
    const auth = this.ctx.auth;
    const nc = await connect({
      servers: this.ctx.servers ?? DEFAULT_SERVER,
      ...(auth
        ? standaloneConnectOpts({
            creds: await mintCreds(auth, newIdentity(), "run-operator", {
              runOperator: { endpoint, takeoverId, ...(scope.runId !== undefined ? { runId: scope.runId } : {}), ...(scope.answers !== undefined ? { answers: scope.answers } : {}) },
            }),
            /* not yet wired to a recorded transport */ tls: false,
          })
        : {}),
      maxReconnectAttempts: 0,
    });
    try {
      const kv = await openRecordsBucket(nc, this.ctx.space);
      return await fn({ nc, js: jetstream(nc), jsm: await jetstreamManager(nc), kv, space: this.ctx.space }, kv, takeoverId);
    } finally {
      await nc.drain().catch(() => nc.close());
    }
  }
}

/** A validation problem without its rendered source frame (the caller holds the source). */
function withoutFrame(e: Record<string, unknown>): Record<string, unknown> {
  const where = e.where;
  if (where === null || typeof where !== "object") return e;
  const { frame: _frame, ...rest } = where as Record<string, unknown>;
  return { ...e, where: rest };
}

function describeOutcome(out: RunHostOutcome): string {
  if (out.status === "completed") return `completed in ${out.steps} step(s)`;
  if (out.status === "released") return `released - ${out.reason.name}: ${out.reason.message.split("\n")[0]}`;
  return `failed - ${out.error.code ? `${out.error.code} ` : ""}${out.error.name}: ${out.error.message.split("\n")[0]}`;
}

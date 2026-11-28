import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { agentFilePath, chatStream, checkEventStartup, controlReplyFromThrown, copyPersonaEndpoints, describeCleanupFailures, DEV_OWNER, discardLaunchArtifacts, EpEnvelopeError, eventChannelPrincipal, EventStateConflictError, grantOverreach, isPermissionDenied, lifecycleBlocked, loadCotalConfig, lowerPersonaEndpoints, managedRetirementOpId, mintAcceptedToken, mintGeneration, mintLifecycleUid, modelPolicyEnv, modelPolicyRefusal, newIdentity, parsePrincipalKey, principalKey, provisionAgent, rejectionText, renderLifecycleBlocked, resolveReadAcl, saveAgentFile, STANDING_RENEWABLE_TTL_SEC as MANAGED_STATIC_TTL_SEC, STATIC_GENERATION_HORIZON_SEC, type AgentDef, type CleanupFailure, type Connector, type ControlReply, type CotalConfig, type CotalEndpoint, type EpCaller, type EpCapability, type GoalRef, type IssuedStore, type LaunchChoice, type LaunchOpts, type LaunchSpec, type LifecycleStateTransport, type PersonaEndpoint, type UserAuthLaunch } from "@cotal-ai/core";
import { SharedLaunchHeld } from "@cotal-ai/seat";
import { agentLifecycleSecretFilePaths, agentSecretKeyForFile, isTrustedProject, materializeSecretToFile, mergeLaunchOptions, retainConnectorSeat } from "@cotal-ai/workspace";
import type { KV } from "@nats-io/kv";
import { CHAT_ALIAS_PREFIX } from "./chat-session.js";
import { readContinuityAssignment, writeInlineSnapshot } from "./launch.js";
import type { Manager } from "./manager.js";
import type { ManagerParts } from "./manager-parts.js";
import { withTimeout } from "./manager-timeout.js";
import { enrolledAcl } from "./remote-authority.js";
import { MAX_AGENTS, supervisePolicy } from "./resume.js";
import type { TeardownTarget } from "./retirement.js";
import type { AgentHandle, Runtime } from "./runtime/index.js";
import { watchConnectorHolder } from "./seat-custody.js";
import { optInLaunchFields } from "./harness-resolution.js";
import { foreignEventChannels, ownLists, ownPersona, userMeshEndpointsRefusal, type SeatLaunch, type SeatLaunchDeps } from "./seat-launch.js";
import type { ManagedAgent, SpawnHooks, StartAgentOpts } from "./seat-types.js";
import { activateStaticLifecycle, casStaticSlot, readStaticSlot } from "./static-lifecycle.js";
import type { TranscriptClaim } from "./transcript-receive.js";
import type { ProvisionedUserAgent } from "./user-provision.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";

class LegacyEventCountPermissionError extends Error {}

async function startupFailureDetail(a: ManagedAgent, outcome: "failed" | "exited"): Promise<string> {
  const failure = outcome === "failed" ? "startup confirmation failed" : "the seat exited before startup confirmation completed";
  try {
    // The startup watch can report failure before the runtime records the diagnostic on exit.
    if (a.handle.waitForExit)
      await withTimeout(a.handle.waitForExit(), 10_000, "seat exit was not confirmed within 10000ms");
    const diagnostic = a.handle.exitInfo?.()?.diagnostic?.replace(/\p{Cs}/gu, "\uFFFD");
    if (diagnostic) return `${a.name}: ${diagnostic}`;
  } catch (error) {
    return `${a.name}: ${failure}; ${rejectionText(error).replace(/\p{Cs}/gu, "\uFFFD")}. See the manager log.`;
  }
  return `${a.name}: ${failure}. See the manager log.`;
}

/** Why a runtime that starts seats outside this host (`delegatedBy`) cannot take `opts`: a choice
 *  only this host can honour. Undefined when there is none. */
function hostOnlyChoice(opts: StartAgentOpts, delegatedBy: string): string | undefined {
  if (opts.resume) return `${delegatedBy}, so it cannot resume a session held on this host (resume)`;
  if (opts.autoName) return `${delegatedBy}, so it cannot label the seat from its first message (autoName)`;
  if (opts.resolved?.continuity === "exact") return `${delegatedBy}, so it cannot reopen a session held on this host (continuity: exact)`;
  if (typeof opts.cwd === "string" && opts.cwd !== "")
    return `${delegatedBy}, so it cannot run in a directory on this host's filesystem (cwd); the seat runs in its runtime resource's own directory`;
  return undefined;
}

/** The {@link SeatLaunch} methods {@link SeatStart.startActive} calls. Each is read at call time. */
export interface SeatStartLaunch {
  checkSpawnCwd: (...args: Parameters<SeatLaunch["checkSpawnCwd"]>) => ReturnType<SeatLaunch["checkSpawnCwd"]>;
  harnessUnavailableError: (...args: Parameters<SeatLaunch["harnessUnavailableError"]>) => ReturnType<SeatLaunch["harnessUnavailableError"]>;
  onceRefusal: (...args: Parameters<SeatLaunch["onceRefusal"]>) => ReturnType<SeatLaunch["onceRefusal"]>;
  spawnerName: (...args: Parameters<SeatLaunch["spawnerName"]>) => ReturnType<SeatLaunch["spawnerName"]>;
  spawnPersona: (...args: Parameters<SeatLaunch["spawnPersona"]>) => ReturnType<SeatLaunch["spawnPersona"]>;
  spawnRun: (...args: Parameters<SeatLaunch["spawnRun"]>) => ReturnType<SeatLaunch["spawnRun"]>;
  staticSpawnBound: (...args: Parameters<SeatLaunch["staticSpawnBound"]>) => ReturnType<SeatLaunch["staticSpawnBound"]>;
  spawnBoundRefusal: (...args: Parameters<SeatLaunch["spawnBoundRefusal"]>) => ReturnType<SeatLaunch["spawnBoundRefusal"]>;
  managedStaticInstanceReads: (...args: Parameters<SeatLaunch["managedStaticInstanceReads"]>) => ReturnType<SeatLaunch["managedStaticInstanceReads"]>;
}

/** The agent-start path: admission, grant, launch, readiness and the rollback of a failed start. */
export class SeatStart {
  private readonly sharedLaunchHolds = new Map<string, () => void>();

  get sharedLaunchHoldCount(): number { return this.sharedLaunchHolds.size; }

  sharedLaunchHoldNames(): string[] { return [...this.sharedLaunchHolds.keys()]; }

  clearSharedLaunchHolds(): void {
    for (const [name, cleanup] of this.sharedLaunchHolds) {
      cleanup();
      this.sharedLaunchHolds.delete(name);
    }
  }

  private settleUnusedLaunch(name: string, seatHome: string | undefined, snapshotUid: string | undefined, provisioned: TeardownTarget | undefined): void {
    this.namesCapacity.release(name);
    if (seatHome) rmSync(seatHome, { recursive: true, force: true });
    const snapshotSettled = snapshotUid === undefined || this.dropInlineSnapshot(name, snapshotUid);
    if (!provisioned) return;
    const target: TeardownTarget = { ...provisioned, ...(snapshotSettled ? { snapshotSettled: true } : {}) };
    const principal = target.delegated ? parsePrincipalKey(target.id) : null;
    if (principal) this.retirement.hold(target.name, { opId: managedRetirementOpId(target.lifecycleUid), owner: principal.owner, actor: principal.actor, target, startedAt: Date.now() });
    this.trackDeprovision(target, "(orphaned spawn)");
  }
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: SeatLaunchDeps, private readonly parts: Pick<ManagerParts, "brokerTransport" | "connectorInventory" | "harnessResolution" | "namesCapacity" | "personaCatalog">, private readonly launch: SeatStartLaunch, private readonly state: ManagerStartState) {}

  // The Manager members startActive reads, under their Manager names. Each reads through its dep
  // at use, so a field the Manager assigns later is current and a method a test replaces on the
  // Manager is the one that runs.
  private get auth() { return this.state.auth; }
  private awaitReadiness(...args: Parameters<Manager["awaitReadiness"]>): ReturnType<Manager["awaitReadiness"]> { return this.deps.awaitReadiness(...args); }
  private awaitStartupOutcome(...args: Parameters<Manager["awaitStartupOutcome"]>): ReturnType<Manager["awaitStartupOutcome"]> { return this.deps.awaitStartupOutcome(...args); }
  private capabilityRefusal(...args: Parameters<Manager["capabilityRefusal"]>): ReturnType<Manager["capabilityRefusal"]> { return this.deps.capabilityRefusal(...args); }
  private get delegatedLaunched() { return this.deps.delegatedLaunched(); }
  private dropInlineSnapshot(...args: Parameters<Manager["dropInlineSnapshot"]>): ReturnType<Manager["dropInlineSnapshot"]> { return this.deps.dropInlineSnapshot(...args); }
  private endOnceBeforeServe(...args: Parameters<Manager["endOnceBeforeServe"]>): ReturnType<Manager["endOnceBeforeServe"]> { return this.deps.endOnceBeforeServe(...args); }
  private get ep() { return this.deps.ep(); }
  private eventsRefusal(...args: Parameters<Manager["eventsRefusal"]>): ReturnType<Manager["eventsRefusal"]> { return this.deps.eventsRefusal(...args); }
  private fileDigest(...args: Parameters<Manager["fileDigest"]>): ReturnType<Manager["fileDigest"]> { return this.deps.fileDigest(...args); }
  private hostLaunchFields(...args: Parameters<Manager["hostLaunchFields"]>): ReturnType<Manager["hostLaunchFields"]> { return this.deps.hostLaunchFields(...args); }
  private launchOwner(...args: Parameters<Manager["launchOwner"]>): ReturnType<Manager["launchOwner"]> { return this.deps.launchOwner(...args); }
  private get leaseStopping() { return this.deps.leaseStopping(); }
  private loadSeatRuntime(...args: Parameters<Manager["loadSeatRuntime"]>): ReturnType<Manager["loadSeatRuntime"]> { return this.deps.loadSeatRuntime(...args); }
  private get managerInstanceId() { return this.state.managerInstanceId!; }
  private get meshMode() { return this.deps.meshMode(); }
  private get namesCapacity() { return this.deps.namesCapacity(); }
  private openOnceDelivery(...args: Parameters<Manager["openOnceDelivery"]>): ReturnType<Manager["openOnceDelivery"]> { return this.deps.openOnceDelivery(...args); }
  private place(...args: Parameters<Manager["place"]>): ReturnType<Manager["place"]> { return this.deps.place(...args); }
  private provisionUserAgent(...args: Parameters<Manager["provisionUserAgent"]>): ReturnType<Manager["provisionUserAgent"]> { return this.deps.provisionUserAgent(...args); }
  private readerRemedy(...args: Parameters<Manager["readerRemedy"]>): ReturnType<Manager["readerRemedy"]> { return this.deps.readerRemedy(...args); }
  private get remoteAuthority() { return this.config.remoteAuthority; }
  private resolveConnector(...args: Parameters<Manager["resolveConnector"]>): ReturnType<Manager["resolveConnector"]> { return this.deps.resolveConnector(...args); }
  private get retirement() { return this.deps.retirement(); }
  private get runHosting() { return this.deps.runHosting(); }
  private runtimeFor(...args: Parameters<Manager["runtimeFor"]>): ReturnType<Manager["runtimeFor"]> { return this.deps.runtimeFor(...args); }
  private get seatCustody() { return this.deps.seatCustody(); }
  private get sessionRecovery() { return this.deps.sessionRecovery(); }
  private shredUserSecrets(...args: Parameters<Manager["shredUserSecrets"]>): ReturnType<Manager["shredUserSecrets"]> { return this.deps.shredUserSecrets(...args); }
  private get staticLifecycle() { return this.deps.staticLifecycle(); }
  private stopAndTrack(...args: Parameters<Manager["stopAndTrack"]>): ReturnType<Manager["stopAndTrack"]> { return this.deps.stopAndTrack(...args); }
  private trackDeprovision(...args: Parameters<Manager["trackDeprovision"]>): ReturnType<Manager["trackDeprovision"]> { return this.deps.trackDeprovision(...args); }
  private get transcripts() { return this.deps.transcripts(); }
  private get userMode() { return this.state.userMode; }
  private get userProvision() { return this.deps.userProvision(); }
  private watchExit(...args: Parameters<Manager["watchExit"]>): ReturnType<Manager["watchExit"]> { return this.deps.watchExit(...args); }
  private watchOnceExit(...args: Parameters<Manager["watchOnceExit"]>): ReturnType<Manager["watchOnceExit"]> { return this.deps.watchOnceExit(...args); }
  private withIssuer<T>(fn: (i: { store: IssuedStore; accepted: KV }) => Promise<T>): Promise<T> { return this.deps.withIssuer(fn); }
  private withLifecycleExecutor<T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (t: LifecycleStateTransport) => Promise<T>): Promise<T> { return this.deps.withLifecycleExecutor(pin, fn); }
  private withProvisioner<T>(fn: (prov: CotalEndpoint) => Promise<T>): Promise<T> { return this.deps.withProvisioner(fn); }

  // The SeatLaunch methods startActive calls, under their SeatLaunch names.
  private checkSpawnCwd(...args: Parameters<SeatLaunch["checkSpawnCwd"]>): ReturnType<SeatLaunch["checkSpawnCwd"]> { return this.launch.checkSpawnCwd(...args); }
  private harnessUnavailableError(...args: Parameters<SeatLaunch["harnessUnavailableError"]>): ReturnType<SeatLaunch["harnessUnavailableError"]> { return this.launch.harnessUnavailableError(...args); }
  private onceRefusal(...args: Parameters<SeatLaunch["onceRefusal"]>): ReturnType<SeatLaunch["onceRefusal"]> { return this.launch.onceRefusal(...args); }

  /** Why this manager cannot hand a seat a first command, or undefined when it can. The agent runs it
   *  on its `agent` endpoint, which it serves on every mesh mode, as its first turn. */
  private firstCommandRefusal(runtime: Runtime, launch: { prompt?: string; once: boolean }): string | undefined {
    if (runtime.spawnDelegated) return `runtime "${runtime.kind}" starts seats outside this host and carries no first command (firstCommand)`;
    if (launch.prompt !== undefined) return "a spawn's first turn is its prompt or its first command, not both (prompt, firstCommand)";
    if (launch.once) return "a once seat's first turn is its task, so it takes no first command (once, firstCommand)";
    return undefined;
  }
  /** Why this launch cannot run its variant or modes: a runtime that starts seats elsewhere carries no
   *  modes, and the connector's catalog, read with the harness files and spawn.env names the launch
   *  receives, must list both for the launched model. */
  private choiceRefusal(connector: Connector, runtime: Runtime, launch: Pick<LaunchOpts, "resolvedBinaries" | "envAllow">, choice: LaunchChoice): string | Promise<string | undefined> {
    if (choice.modes && runtime.spawnDelegated) return `runtime "${runtime.kind}" starts seats outside this host and carries no modes (modes)`;
    return this.parts.harnessResolution.catalogRefusal(connector, launch.resolvedBinaries, launch.envAllow, choice);
  }
  private spawnerName(...args: Parameters<SeatLaunch["spawnerName"]>): ReturnType<SeatLaunch["spawnerName"]> { return this.launch.spawnerName(...args); }
  private spawnPersona(...args: Parameters<SeatLaunch["spawnPersona"]>): ReturnType<SeatLaunch["spawnPersona"]> { return this.launch.spawnPersona(...args); }
  private spawnRun(...args: Parameters<SeatLaunch["spawnRun"]>): ReturnType<SeatLaunch["spawnRun"]> { return this.launch.spawnRun(...args); }
  private staticSpawnBound(...args: Parameters<SeatLaunch["staticSpawnBound"]>): ReturnType<SeatLaunch["staticSpawnBound"]> { return this.launch.staticSpawnBound(...args); }
  private spawnBoundRefusal(...args: Parameters<SeatLaunch["spawnBoundRefusal"]>): ReturnType<SeatLaunch["spawnBoundRefusal"]> { return this.launch.spawnBoundRefusal(...args); }
  private managedStaticInstanceReads(...args: Parameters<SeatLaunch["managedStaticInstanceReads"]>): ReturnType<SeatLaunch["managedStaticInstanceReads"]> { return this.launch.managedStaticInstanceReads(...args); }

  /** Why a delegated runtime cannot start this spawn, or undefined when it can. A delegated seat
   *  starts outside this host from values alone, so a choice only this host can honour is refused
   *  before enrollment, and named rather than dropped. */
  private delegatedRefusal(runtime: Runtime, opts: StartAgentOpts, hostFields: ReturnType<Manager["hostLaunchFields"]>): string | undefined {
    const delegatedBy = `runtime "${runtime.kind}" starts seats outside this host`;
    if (!this.remoteAuthority?.enrollManagedAgent)
      return `${delegatedBy}, which needs a host that enrolls managed agents (remoteAuthority.enrollManagedAgent); a delegated seat has no local grant path`;
    try {
      this.userProvision.delegatedMeshRecord();
    } catch (e) {
      return rejectionText(e);
    }
    const hostOnly = hostOnlyChoice(opts, delegatedBy);
    if (hostOnly) return hostOnly;
    if (opts.askPermissions || opts.reasoningEvents)
      return `${delegatedBy}, and its child launch takes neither askPermissions nor reasoningEvents`;
    const shared = Object.keys(hostFields.mcpServers!);
    if (shared.length)
      return `${delegatedBy}, so it cannot share MCP servers that run on this host (${shared.join(", ")}); pass --share-tools none`;
    return undefined;
  }

  async startActive(opts: StartAgentOpts, spawner?: string, hooks?: SpawnHooks, authenticatedCaller?: EpCaller): Promise<ControlReply> {
    // Before the first await, so the grant, the launch, the retained form and the restart slot all read
    // the lists and the restart policy as admitted.
    opts = ownLists(opts);
    if (opts.resolved) opts.resolved = ownLists(opts.resolved);
    if (opts.persona !== undefined) opts.persona = ownPersona(opts.persona);
    if (opts.supervise) {
      opts.supervise = { restarts: opts.supervise.restarts, windowMs: opts.supervise.windowMs };
      // The budget is checked here, where it is held, not only at the wire: an in-process caller of
      // this export is refused before anything launches, rather than getting a seat that joins and is
      // torn down when its seat record will not take the policy (#3298).
      const policy = supervisePolicy.safeParse(opts.supervise);
      if (!policy.success) return { ok: false, error: `supervise.${policy.error.issues[0]?.path.join(".")}: expected a positive integer` };
    }
    if (opts.once) opts.once = { deadlineMs: opts.once.deadlineMs };
    let runtime: Runtime;
    try {
      await this.loadSeatRuntime(opts.runtime);
      runtime = this.runtimeFor(opts.runtime);
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    if (opts.delegatedIntent) {
      if (!this.remoteAuthority?.executeDelegatedUserIntent)
        return { ok: false, error: `"${opts.name}" names a delegated user intent, and this manager has no host execution for one` };
      if (opts.supervise) return { ok: false, error: `"${opts.name}" names a delegated user intent, and a delegated agent is never restarted (SPEC 13.16)` };
      // A delegated launch's spawner is the user's principal, never the composition root's call.
      spawner = opts.delegatedIntent.parent;
    }
    const persona = await this.spawnPersona(opts, spawner, authenticatedCaller);
    if ("error" in persona) return { ok: false, error: persona.error, ...(persona.code ? { code: persona.code } : {}) };
    const { ref, def, agent, inline } = persona;
    // An inline persona's file is its snapshot, written once the lifecycle uid is final; until then
    // a refusal names the persona instead of a path.
    let configPath = persona.configPath;
    const where = configPath ?? `inline persona "${ref}"`;

    // Materialize the requested connector before the capacity/reserve span so its lazy import
    // cannot interleave that synchronous allocation. On the manifest binary this also honors a
    // live `cotal ext remove`: a removed connector is rejected here even if an earlier spawn already
    // imported it. A broken/missing connector fails loud here with a clear name + install hint.
    let connector: Connector;
    try {
      connector = await this.resolveConnector(agent);
    } catch (e) {
      const error = rejectionText(e);
      // An action refusal here precedes capacity, allocation and onAccepted. Preserve that proof
      // through serveSpawnGoal without changing the direct startAgent ControlReply contract.
      if (hooks?.onAccepted) throw new EpEnvelopeError("failed-precondition", error, undefined, "not-executed");
      return { ok: false, error };
    }
    const connectorLaunchRestriction = connector.launchUnavailable?.({ cwd: this.config.workspaceRoot, resume: opts.resume });
    if (connectorLaunchRestriction) {
      if (hooks?.onAccepted) throw new EpEnvelopeError("failed-precondition", connectorLaunchRestriction, undefined, "not-executed");
      return { ok: false, error: connectorLaunchRestriction };
    }
    // Read here, beside the connector, so the capacity check and the reserve below take no new await.
    const run = await this.spawnRun(authenticatedCaller, opts.runId);
    if (run !== undefined && "refused" in run) return { ok: false, error: `spawn: ${run.refused}` };
    const bound = await this.staticSpawnBound(authenticatedCaller, run);

    const readinessTimeoutMs = connector.readinessTimeoutMs ?? this.config.readinessTimeoutMs;
    if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0)
      return { ok: false, error: `connector ${connector.name} declares invalid readinessTimeoutMs ${JSON.stringify(connector.readinessTimeoutMs)}; expected a positive safe integer` };

    // Fail fast when full. If hosted Claude has to await wake setup, resample capacity after it.
    // The final capacity check and the reserve below stay in the same tick or two concurrent
    // spawns could overshoot the ceiling or pick the same name.
    let occupancy = this.namesCapacity.occupancy(); // prunes expired cooling stamps; counts each name once
    if (occupancy.used >= MAX_AGENTS) return { ok: false, error: this.namesCapacity.capacityRefusal(occupancy) };
    const recheck = this.parts.connectorInventory.refreshConnectors(connector.name, true);
    if (recheck) {
      await recheck;
      occupancy = this.namesCapacity.occupancy();
      if (occupancy.used >= MAX_AGENTS) return { ok: false, error: this.namesCapacity.capacityRefusal(occupancy) };
    }

    // Harness preflight before reserving a slot or minting — a missing `claude`/`opencode` binary
    // fails here with a clear name, not obscurely at process spawn. No fallback. All synchronous, so
    // the reserve gate stays atomic. (The connector itself was resolved up top, before the capacity gate.)
    const harness = this.parts.harnessResolution.launchHarness(connector);
    if ("refusal" in harness) return { ok: false, error: this.harnessUnavailableError(harness.refusal, opts.route ?? "inst") };
    // Resume is a connector capability: reject an unsupported resume HERE, before the reserve/mint, so
    // it can never provision creds + durables and then throw at buildLaunch (mint-then-orphan). Same
    // reject-before-side-effects window as the harness preflight above; buildLaunch stays the backstop.
    if (opts.resume && !connector.supportsResume)
      return { ok: false, error: `${agent} connector does not support resuming an existing session (resume)` };
    // A carried resume (#1499) is checked here too, before anything is minted. The claim is only
    // looked at: the connector may still refuse the launch, and a refused launch leaves it unspent.
    let carried: TranscriptClaim | undefined;
    if (opts.resumeClaim !== undefined) {
      if (opts.resume === undefined) return { ok: false, error: "resumeClaim: names carried bytes of a resume; the launch carries no resume" };
      if (!connector.resumeTranscript) return { ok: false, error: `${agent} connector does not take a carried transcript (resumeClaim)` };
      if (opts.resumeAgent !== agent)
        return { ok: false, error: `resumeClaim: the session was carried for agent "${opts.resumeAgent ?? "<none>"}", and this launch resolves agent "${agent}"` };
      if (!this.transcripts) return { ok: false, error: "resumeClaim: this manager does not receive carried transcripts" };
      try {
        carried = this.transcripts.peek(opts.resumeClaim, opts.resume);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    }
    // A restart policy this host cannot honour is refused at accept, never accepted and ignored.
    // External runtimes (tmux/cmux/orca/herdr) attach to a process they do not own and stream no
    // exit, so a name cannot be respawned in place. User-mode seats have no static slot that
    // keeps the incarnation owned across a process death, so the same refusal applies there.
    if (opts.supervise !== undefined) {
      if (runtime.kind !== "pty")
        return { ok: false, error: `supervise is a restart policy this host cannot enforce: runtime "${runtime.kind}" cannot respawn a name in place` };
      if (this.userMode)
        return { ok: false, error: "supervise is a restart policy this host cannot enforce: a user-mode seat has no static slot to keep the incarnation owned across a process death" };
      if (runtime.supportsWorkClosure !== true)
        return { ok: false, error: `supervise is a restart policy this host cannot enforce: runtime "${runtime.kind}" cannot prove prior local work ended` };
    }
    // One read of the cotal config per spawn: the delegated refusal, the model policy and the launch
    // fields below all take this value, so the awaits between the policy check and the launch cannot
    // admit the seat under one file and launch it with another's servers and env allowlist. Read per
    // spawn, so a policy edit reaches the next spawn without a restart. The launch fields are resolved
    // here too, before the spawn is accepted, so a sharing selection that names an undeclared server
    // is refused while there is nothing to roll back.
    let cotalConfig: CotalConfig;
    let hostFields: ReturnType<Manager["hostLaunchFields"]>;
    try {
      cotalConfig = loadCotalConfig(this.config.workspaceRoot, isTrustedProject);
      hostFields = this.hostLaunchFields(cotalConfig, agent, opts.shareTools, harness);
    } catch (e) {
      const error = rejectionText(e);
      // An input refusal here precedes allocation and onAccepted, like a connector refusal above:
      // a hosted run proves it not-executed instead of binding a goal to a spawn that never starts.
      if (hooks?.onAccepted) throw new EpEnvelopeError("failed-precondition", error, undefined, "not-executed");
      return { ok: false, error };
    }
    const delegatedRefused = runtime.spawnDelegated ? this.delegatedRefusal(runtime, opts, hostFields) : undefined;
    if (delegatedRefused) return { ok: false, error: delegatedRefused };

    // A placed spawn's cwd is checked on this host BEFORE anything is minted or reserved: an absolute
    // path this manager cannot realpath, or one that is not a directory, is refused here with the
    // asked path, the reason and this host, so a misplaced spawn in a multi-manager space is
    // diagnosable at the moment it happens (#385 item 2) instead of failing inside the pty launch.
    // The resolved realpath is threaded to the launch cwd below (`resolvedCwd`) so it is computed once.
    let resolvedCwd: string | undefined;
    if (typeof opts.cwd === "string" && opts.cwd !== "") {
      const asked = opts.cwd;
      const target = resolve(this.config.workspaceRoot, asked);
      const checked = this.checkSpawnCwd(target);
      if ("refusal" in checked)
        return { ok: false, error: `spawn: cwd does not resolve on this host (${hostname()}): ${JSON.stringify(asked)} (${checked.refusal}); the seat was not launched` };
      resolvedCwd = checked.cwd;
    }

    // Resolve the launch profile: IDENTITY (free-form `name:`) + role + read/post ACL + capabilities
    // + model/variant. Either from a fully-resolved manifest launch object (`opts.resolved`, whose `config`
    // is a materialized transient persona — the file is NOT the access authority), or from the
    // persona file. The number rides the IDENTITY (socrates → socrates_2), not the file ref — a
    // redelivered identical spawn yields a fresh numbered agent (MAX_AGENTS bounds the blast radius).
    let identityName: string;
    let role: string | undefined;
    let subscribe: string[] | undefined;
    let allowSubscribe: string[];
    let allowPublish: string[] | undefined;
    let capabilities: string[] | undefined;
    // The endpoint commands the persona hands on (SPEC 13.15), as the persona names them and as the
    // mint grants them. A manifest launch carries none: its schema has no slot for them.
    let personaEndpoints: PersonaEndpoint[] | undefined;
    let endpoints: EpCapability[] = [];
    let model = opts.model;
    let variant = opts.variant;
    let launchOptions = opts.launchOptions;
    let prompt = opts.prompt;
    // The read set the persona and the overrides name, before `join` adds to it: what a saved copy keeps.
    let ownSubscribe: string[] | undefined;
    if (opts.resolved) {
      // A manifest launch is the access + identity authority: imperative overrides arriving
      // alongside `resolved` are a caller contract error, not something to merge (no fallbacks).
      if (opts.subscribe || opts.allowSubscribe || opts.allowPublish || opts.join || opts.callerAcl || opts.prompt || opts.shareTools || opts.identity)
        return { ok: false, error: "a manifest launch (resolved) rejects imperative overrides (identity/subscribe/allow*/join/callerAcl/prompt/shareTools)" };
      const r = opts.resolved;
      identityName = r.name;
      role = opts.role ?? r.role;
      subscribe = r.subscribe;
      allowSubscribe = r.allowSubscribe;
      allowPublish = r.allowPublish;
      capabilities = r.capabilities;
      model = opts.model ?? r.model;
      variant = opts.variant ?? r.variant;
      launchOptions = mergeLaunchOptions(r.launchOptions, opts.launchOptions);
      prompt = r.prompt; // the guard above rejected an imperative prompt — one source

    } else {
      // `def` was loaded once above the connector resolution (#869 ordering); consume it here.
      // `resolved` is the only path that skips the load, and this is its opposite branch.
      if (!def) return { ok: false, error: "internal: persona definition missing at launch profile" };
      // Identity: the `--name` override wins over the file's `name:` — foreground parity (there,
      // `requested = values.name ?? def.name`). The override is minted into the creds and rides
      // COTAL_NAME below, so the presence identity and its credential can't diverge.
      identityName = opts.identity ?? def.name;
      role = opts.role ?? def.role;
      // Flags > persona file — the same precedence as foreground `cotal spawn`, so the two launch
      // paths of the merged grammar can't diverge. One source feeds BOTH the minted creds and the
      // connector env below.
      // A persona that names no channel field at all is scoped to its spawner's ACL (`callerAcl`,
      // when the door sent one). The spawner's own event channel is dropped from it: that plane is
      // foreign to the child, and the guard below refuses any spawn that asks for one. The joined
      // set is never copied from the spawner: a helper starts on what its persona lists plus what
      // the caller passes in `join`, and nothing else. The ACL is the caller's own report, so on a
      // static mesh it is clamped to what the caller's evidence shows it holds, and a caller with
      // no evidence gets no default at all.
      const personaNamesChannels = def.subscribe !== undefined || def.allowSubscribe !== undefined || def.allowPublish !== undefined;
      const heldChannels = (field: "allowSubscribe" | "allowPublish", channels: string[]) => {
        const own = channels.filter((ch) => eventChannelPrincipal(ch) === null);
        return bound.kind === "bounded" ? own.filter((ch) => grantOverreach(this.config.space, bound.caller, bound.ceiling, { [field]: [ch] }).length === 0) : own;
      };
      let scoped: { allowSubscribe: string[]; allowPublish: string[] } | undefined;
      try {
        scoped = !personaNamesChannels && opts.callerAcl && bound.kind !== "none" ? {
          allowSubscribe: heldChannels("allowSubscribe", opts.callerAcl.allowSubscribe),
          allowPublish: heldChannels("allowPublish", opts.callerAcl.allowPublish),
        } : undefined;
      } catch (e) {
        return { ok: false, error: `callerAcl: ${rejectionText(e)}` };
      }
      const base = opts.subscribe ?? def.subscribe;
      ownSubscribe = base;
      subscribe = opts.join?.length ? [...new Set([...(base ?? []), ...opts.join])] : base;
      allowSubscribe = opts.allowSubscribe ?? def.allowSubscribe ?? scoped?.allowSubscribe ?? [];
      allowPublish = opts.allowPublish ?? def.allowPublish ?? scoped?.allowPublish;
      capabilities = def.capabilities;
      personaEndpoints = copyPersonaEndpoints(def.endpoints);
      // A user-auth mesh grants endpoint access through the service owner's records, which a spawn
      // cannot write (SPEC 13.15), so a persona that names the field is refused there, `[]` included,
      // before any bound or exemption reads it.
      if (personaEndpoints !== undefined && this.meshMode === "user")
        return { ok: false, error: userMeshEndpointsRefusal("spawn") };
      endpoints = lowerPersonaEndpoints(personaEndpoints);
      // #651: fold the persona's model into the launch record, mirroring the variant line below
      // and the manifest branch above. Without this, a persona-file model (the common pin source)
      // never reaches `launch.model`, so the connector runs the seat on it while `ps --wide`/`--json`
      // reports the model ABSENT - a false "no model pinned" for a seat that has one.
      model = opts.model ?? def.model;
      variant = opts.variant ?? def.variant;
      launchOptions = mergeLaunchOptions(def.launchOptions, opts.launchOptions);
    }
    // Resolved once for both branches, because this one list is granted, minted, recorded on the
    // launch and forwarded to the session, and each of those must read the list the provisioner does.
    try {
      allowSubscribe = resolveReadAcl(subscribe ?? [], allowSubscribe);
    } catch (e) {
      return { ok: false, error: opts.resolved ? `launch agent: ${rejectionText(e)}` : `persona ${where}: ${rejectionText(e)}` };
    }
    // Default events on where the connector supports them, unless the launch explicitly opts out.
    const events = this.config.eventsRequired || opts.events === true || (opts.events !== false && !!connector.eventChannel);
    if (this.config.eventPayloadsWithheld && opts.eventPayloads === true)
      return { ok: false, error: "space policy withholds event payloads" };
    const eventPayloads = !this.config.eventPayloadsWithheld && (opts.eventPayloads ?? def?.eventPayloads) !== false;
    if (run === undefined) {
      const reads = this.managedStaticInstanceReads(capabilities);
      if (bound.kind === "exempt" || (bound.kind === "bounded" && !grantOverreach(this.config.space, bound.caller, bound.ceiling, { endpoints: reads }).length))
        endpoints.push(...reads);
    }
    // THE DELEGATION BOUND, on the grant as it will be minted: every channel and capability the
    // helper gets, from the persona, the raw overrides and the `callerAcl` default alike, and its own
    // event plane, so no door reaches the mint around it. Before any reserve or mint, so a refusal
    // leaves nothing.
    const boundRefusal = this.spawnBoundRefusal(bound, {
      allowSubscribe,
      ...(allowPublish !== undefined ? { allowPublish } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(endpoints.length ? { endpoints } : {}),
    }, events);
    if (boundRefusal) return { ok: false, error: boundRefusal };
    // A run saves for the caller it was admitted for, whose catalog reads then find the copy.
    const savedBy = authenticatedCaller === undefined ? undefined : this.runHosting?.admittedCaller(authenticatedCaller);
    // What a saved copy keeps: the grant just checked, without the helper's own event row, which each
    // later spawn derives for its own helper. The file names every channel field, so no later caller's
    // default fills one, and each later spawn of it is still bounded against that caller.
    const catalogCopy: AgentDef | undefined = inline?.save
      ? {
          name: ref,
          owner: savedBy !== undefined ? this.parts.personaCatalog.personaOwner(principalKey(savedBy.owner, savedBy.actor).key) : spawner === undefined ? undefined : this.parts.personaCatalog.personaOwner(spawner),
          role,
          model,
          variant,
          description: def?.description,
          persona: def?.persona,
          subscribe: [...(ownSubscribe ?? [])],
          allowSubscribe: [...allowSubscribe],
          allowPublish: [...(allowPublish ?? [])],
          capabilities: capabilities?.length ? [...capabilities] : undefined,
          endpoints: copyPersonaEndpoints(personaEndpoints?.length ? personaEndpoints : undefined),
        }
      : undefined;
    // Checked after every path has resolved its selectors: a direct `startAgent` call skips the
    // `start` op's checks, and no connector may receive a blank one (#2862).
    if (model !== undefined && !model.trim()) return { ok: false, error: "model: must not be empty" };
    if (variant !== undefined && !variant.trim()) return { ok: false, error: "variant: must not be empty" };
    const idErr = this.namesCapacity.nameError(identityName);
    if (idErr) return { ok: false, error: opts.resolved ? `launch agent: ${idErr}` : `persona ${where}: ${idErr}` };
    // #966: a seat labelled `manager` that cannot spawn is a worker wearing a label, and the label
    // is what other agents ROUTE on (role is the anycast address). The gap is silent today because
    // the mismatch is only discovered minutes in, when the seat first reaches for a worker. Refuse
    // at accept, before any reserve/mint, naming the remediation for each author: an operator edits
    // the file to add the grant, and the persona's owner may redefine it with the grant only if the
    // owner holds spawn, because define-persona bounds capabilities against the definer. The
    // check keys on the EFFECTIVE role (a spawn-time role: override wins
    // over the file, mirroring the resolution above), not the file's, so the label other agents
    // will actually see is the label that is held to account. `manager` is the label that MEANS
    // spawn-holding: naming it literally keeps this the narrow guard for the observed harm, not a
    // vocabulary any caller can trigger with a synonym (roles are free-form and mostly
    // non-manager: this workspace's own catalog carries worker/reviewer/orchestrator seats with no
    // spawn grant, all legitimate).
    if (role === "manager" && !capabilities?.includes("spawn") && inline)
      return {
        ok: false,
        error:
          `inline persona "${ref}" would join with role "manager" but no spawn capability: it presents as a manager ` +
          `while being unable to seat workers. Add \`capabilities: [spawn]\` to the inline persona (a spawner hands on only what it holds), or give it another role.`,
      };
    if (role === "manager" && !capabilities?.includes("spawn"))
      return {
        ok: false,
        error:
          `persona "${ref}" would join with role "manager" but no spawn capability: it presents as a manager ` +
          `while being unable to seat workers, and it would discover that only on first use. ` +
          `An operator adds \`capabilities: [spawn]\` to ${configPath}, or the persona's owner redefines it ` +
          `with \`capabilities: [spawn]\` (cotal_persona) if the owner holds spawn.`,
      };
    // #581: the operator's per-role model allowlist, judged on the EFFECTIVE role and model resolved
    // above, before any reserve or mint. This is where the launch is performed, so no caller can
    // skip it, and a definition pinned to a stale model (or to none) is refused here instead of
    // serving on it.
    const policyRefusal = modelPolicyRefusal(cotalConfig, {
      persona: opts.resolved ? `manifest agent "${ref}"` : configPath ? `persona "${ref}" (${configPath})` : where,
      role, model, variant,
      // A manifest launch carries its own declared model/variant in these options
      // (launchAgentToStartOpts), so there they are the definition's field, never a flag.
      modelFlag: !opts.resolved && opts.model !== undefined,
      variantFlag: !opts.resolved && opts.variant !== undefined,
      launchOptions,
    });
    if (policyRefusal) return { ok: false, error: policyRefusal };
    // The alias-reuse gate: a name whose previous agent is still retiring REFUSES
    // legibly (never a silent suffix), and the refusal re-drives the FULL durable teardown so
    // "retry the spawn" is also the nudge. It routes through `deprovision` (not `requestRetirement`
    // alone) so a retry re-drives the standing-authority revoke (INT-2) AND the broker cleanup before
    // any hold-clear (C): the alias must not free while the durable teardown or the revoke is still
    // outstanding. All the teardown ops are idempotent, and the rail request is single-flighted.
    if (this.staticLifecycle.isReconciling(identityName))
      return { ok: false, error: `the name "${identityName}" is still reconciling at manager startup; its prior lifecycle terminal owns this alias until it completes. Retry shortly.` };
    const held = this.retirement.held(identityName);
    if (held !== undefined) {
      hooks?.onEffect?.();
      void this.retirement.deprovision(held.target).catch(() => {});
      const err = lifecycleBlocked("failed-precondition",
        `the name "${identityName}" is reserved pending retirement: its previous agent's despawn started that lifecycle's teardown (footprint + standing-authority revoke + auth-side retirement), and the name frees only when all of it completes${held.lastError !== undefined ? ` (last attempt: ${held.lastError})` : ""}. NEXT: wait a moment and retry this spawn (retrying re-drives the whole teardown), or pick another name.`,
        { blockedOp: "retirement", opId: held.opId, remedy: "retry" });
      return { ok: false, error: renderLifecycleBlocked(err.message, err), details: err.details };
    }
    // A manifest `continuity: exact` agent reopens the session this manager last bound to its
    // declared name. Refused before any reserve or mint when the connector cannot reopen an exact
    // session or the recorded assignment does not match this declaration.
    const exact = opts.resolved?.continuity === "exact";
    const unsupported = this.capabilityRefusal(connector, { variant, modes: opts.modes, prompt, firstCommand: opts.firstCommand, exact, askPermissions: opts.askPermissions, reasoningEvents: opts.reasoningEvents, events })
      ?? (opts.firstCommand && this.firstCommandRefusal(runtime, { prompt, once: opts.once !== undefined }))
      ?? await this.choiceRefusal(connector, runtime, hostFields, { model, variant, modes: opts.modes });
    if (unsupported) return { ok: false, error: unsupported };
    const onceRefused = opts.once && this.onceRefusal(connector, runtime, { ...opts, launchOptions, prompt }, spawner, hooks);
    if (onceRefused) return { ok: false, error: onceRefused };
    let reopenSession: string | undefined;
    if (exact) {
      try {
        reopenSession = readContinuityAssignment(this.config.workspaceRoot, { space: this.config.space, name: identityName, connector: agent, cwd: resolvedCwd ?? this.config.workspaceRoot });
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    }
    // The child takes launch options as `--opt k=v`, so only string values can cross to it.
    const unportable = runtime.spawnDelegated ? Object.keys(launchOptions ?? {}).filter((k) => typeof launchOptions![k] !== "string") : [];
    if (unportable.length)
      return { ok: false, error: `runtime "${runtime.kind}" starts seats outside this host, so it cannot pass non-string launch options (${unportable.join(", ")})` };
    // An event plane the connector cannot emit is refused HERE, before anything is minted: a
    // connector that cannot emit must fail before provisioning rather than after, as an
    // unsupported `resume` does.
    // The GRANT itself cannot be derived yet. It is keyed on the agent's PRINCIPAL, and in user mode
    // the principal's owner is resolved further down, so deriving it from anything in scope here
    // would mean guessing at the identity the child will actually connect as. It is added at the
    // accept seam below, where the allocated triple exists.
    const eventsRefused = this.eventsRefusal(connector, opts.events);
    if (eventsRefused) return { ok: false, error: eventsRefused };

    // The roster the allocation consults must reflect the initial presence snapshot,
    // or a spawn immediately after manager boot races an already-live unmanaged peer and re-opens the
    // very collision black-hole this closes. Await the snapshot (bounded internally, fail-safe on an
    // empty mesh) before allocating; the broker/auth remain the authority downstream. Deliberately
    // unconditional: a half-wired endpoint without the seam must fail loud here, not silently
    // allocate off a pre-snapshot roster.
    await this.ep.waitForPresenceSnapshot();
    // Spawn-as-action: a HARD-PINNED name — an imperative `--name`/identity override
    // or a manifest-declared name (opts.resolved) — that collides with a LIVE/provisioning/reserved
    // incarnation REFUSES loud at accept, BEFORE any reserve/mint/bind, never a silent `_2`
    // suffix (so an address-by-triple caller's pinned name can't be re-pointed). A PERSONA-DERIVED
    // base name (no pin) keeps uniqueName's collision numbering, so multi-peer `spawn reviewer` twice
    // still yields reviewer + reviewer_2. The alias-reuse gate above is orthogonal and already fired.
    const hardPinned = opts.identity !== undefined || opts.resolved !== undefined;
    const owner = this.launchOwner(opts, spawner);
    const unavailable = new Set<string>();
    let name: string;
    for (;;) {
      if (hardPinned) {
        if (this.namesCapacity.nameInUse(identityName))
          return { ok: false, code: "already-exists", error: `the name "${identityName}" is hard-pinned (${opts.resolved ? "manifest-declared" : "--name/identity override"}) but is already held by a live incarnation (managed here, an unmanaged foreground/connector session, or another manager's agent); a pinned same-name collision refuses at accept - pick another name or despawn the existing one` };
        name = identityName;
      } else {
        try {
          name = this.namesCapacity.uniqueName(identityName, unavailable);
        } catch (e) {
          return { ok: false, error: rejectionText(e) };
        }
      }
      // In user mode the name is the principal's actor. A fresh nkey in static/open mode
      // cannot collide with an earlier transcript. Use the connector's own startup proof.
      const eventOwner = opts.owner ?? (spawner === undefined ? undefined : parsePrincipalKey(spawner)?.owner);
      if (events && this.userMode && !runtime.spawnDelegated && eventOwner?.startsWith("u_")) {
        try {
          await checkEventStartup({
            workspaceRoot: this.config.workspaceRoot,
            space: this.config.space,
            principal: { owner: eventOwner, actor: name },
            retainedMessages: async () => {
              try {
                return (await this.ep.chatRetention()).senders;
              } catch (e) {
                // Older hosts do not issue this metadata grant. Do not infer that the name is
                // free or renumber it: preserve the requested candidate and let the launched
                // agent's existing startup check decide. Every other read failure stays loud.
                if (!isPermissionDenied(e)) throw e;
                console.error(`! event startup name check: missing $JS.API.STREAM.INFO.${chatStream(this.config.space)} permission; launching "${name}" unchanged so the agent checks its transcript state`);
                throw new LegacyEventCountPermissionError();
              }
            },
          });
        } catch (e) {
          if (e instanceof EventStateConflictError && !hardPinned) {
            unavailable.add(name);
            continue;
          }
          if (!(e instanceof LegacyEventCountPermissionError))
            return { ok: false, code: "failed-precondition", error: `cannot check event startup for ${eventOwner}.${name}: ${rejectionText(e)}` };
        }
        // Another spawn may have reserved the candidate while the disk/broker proof awaited.
        // Recheck in the same synchronous window as the cap and reservation below.
        if (this.namesCapacity.nameInUse(name) || (!hardPinned && name !== identityName && this.namesCapacity.numberedIssued(name))) {
          if (!hardPinned) continue;
          return { ok: false, code: "already-exists", error: `the hard-pinned name "${name}" became occupied while checking event startup; pick another name` };
        }
      }
      break;
    }
    // The `chat_` prefix belongs to static chat sessions, whose aliases only `chat-session-open`
    // draws. Checked once the name is fixed by either branch above, so a persona name, a numbered
    // collision, a manifest name and a `--name` override all meet it, and before the reservation.
    if (name.startsWith(CHAT_ALIAS_PREFIX))
      return { ok: false, error: `the name "${name}" starts with "${CHAT_ALIAS_PREFIX}", which is reserved for chat sessions; pick another name` };
    // THE PER-OWNER CEILING, read in the same synchronous window as the reserve below rather than
    // beside the host capacity gate higher up: the count it takes must be the one the reservation
    // lands against, or a burst of concurrent launches for one owner each reads a count taken
    // before any of the others reserved, and they all pass. Nothing between here and the reserve
    // awaits. It refuses BEFORE `onEffect`, so the launch states `not-executed` and leaves no
    // name, no mint and no footprint behind.
    const overCap = this.parts.namesCapacity.seatCapRefusal(owner);
    if (overCap) return { ok: false, code: overCap.code, error: overCap.message, ...(overCap.details ? { details: overCap.details } : {}) };
    // Set once the agent's footprint (durables + creds, or the user-mode grant + secret files)
    // exists; cleared when a live slot takes ownership. If it survives to `finally`, the spawn threw
    // AFTER provisioning (buildLaunch / runtime.spawn) — the orphan-rollback tears it down. Carries
    // `userOwner` for a user-mode spawn so that rollback runs the revoke+shred branch, not just the
    // static durable teardown, which would leak the managed grant + files.
    // The RESERVED custody reference rides the rollback object: a spawn that launched the seat and
    // then threw (the activation CAS refuses a slot that is not this spawn's intent) reaches the
    // `finally` with the handle only in a local, so without this the terminal has nothing to reap
    // and retires over a live process. The slot row holds the same reference; this is the copy the
    // in-process rollback can actually read.
    let provisioned: TeardownTarget | undefined;
    // A carried resume's seat-private home, removed by the finally unless a live seat took it.
    let seatHome: string | undefined;
    // The lifecycle whose inline snapshot this spawn wrote: removed by the finally unless a live seat
    // took it. A write that failed sets nothing, so the finally never removes a file it did not make.
    let snapshotUid: string | undefined;
    let spec: LaunchSpec | undefined;
    // Taken right before the try so its finally is the only release; a refusal belongs above the
    // allocation, where there is no name to give back.
    hooks?.onEffect?.();
    if (!hardPinned && name !== identityName) this.namesCapacity.rememberNumbered(name);
    this.namesCapacity.reserve(name, owner);
    try {
      // A stable nkey identity assigned at spawn: the public key is the agent's card.id (threaded via
      // COTAL_ID); the seed is retained to mint matching creds later.
      const identity = newIdentity();
      // The incarnation's lifecycle UID (SPEC 13.1), minted ONCE per spawn: every lifecycle-keyed
      // broker resource (dm_/dlv_/chathist_ durables, ACL row, memberships) and the teardown
      // credential carry it, so a same-name successor's footprint is name-disjoint by construction.
      //
      // On the HOSTED enrollment arm (#1972) this value is PROVISIONAL. The host selects the
      // authoritative uid, because it alone reads the retirement tombstones that make a uid
      // permanently unusable, and the enrollment below rebinds this binding to what the host
      // returned before anything durable is keyed by it.
      let lifecycleUid = mintLifecycleUid();
      // Reserve the seat's custody reference NOW, before any durable row and long before the
      // launch. Minting it inside `runtime.spawn` (as it used to be) put the processes on disk
      // before anything recorded how to address them, so a crash in that window left a live seat
      // outside every manager and the successor retired the slot over it.
      const custody = this.seatCustody.reserveCustody(runtime);
      // ACCEPT SEAM (spawn-as-action): the incarnation identity is minted and NOTHING has
      // been provisioned yet — the action serve path binds the goal + replies the acceptance HERE. A
      // throw (bind conflict / duplicate goalId) aborts the spawn before provisioning: the catch below
      // returns the failure and the finally releases the reserve, so a refused accept leaves zero
      // footprint. The hosted enrollment arm is the exception, below. Blocking callers
      // (roster boot) pass no hooks and this is a no-op.
      // The ALLOCATED agent's addressing triple (the acceptance floor names what was actually
      // allocated, never the requested-but-unallocated name). Static/open key on DEV_OWNER + the
      // freshly-minted nkey; user mode keys on the derived owner (opts.owner, else a u_-owner spawner)
      // + the alias — derived HERE where the mode and owner source are in scope.
      const agentTriple = this.userMode
        ? { owner, actor: name, uid: lifecycleUid }
        : { owner, actor: identity.id, uid: lifecycleUid };
      // THE EVENT GRANT, derived from the principal that was actually ALLOCATED and never from the
      // display name. A display name is UI convenience: this mesh permits two live agents to carry
      // one, so a name-keyed channel fuses two principals onto one subject and, in auth mode,
      // authorizes both onto it from the same name-only value. `agentTriple` is the triple the child
      // will connect as in both modes, so the grant and the subject the session derives from its own
      // endpoint are the same derivation. Placed here rather than beside the refusal above
      // because this is the first point at which that triple exists, and still before every
      // provisioning call that consumes `allowPublish`.
      // THE OWN-CHANNEL RULE FOR THE EVENT PLANE, and it is the first thing this seam does.
      //
      // An event channel carries a session's tool inputs and outputs, which makes it the most
      // valuable read on the mesh, and `subscribe` / `allowSubscribe` / `allowPublish` are
      // caller-supplied on every spawn door. On a per-user-auth mesh the ledger's spawner envelope
      // already refuses a delegation wider than the spawner's own grant. On a STATIC mesh there is
      // no ledger, so nothing attenuates a caller-supplied ACL at all, and a caller that may spawn
      // may mint its child a read on any subject.
      //
      // What this rule asks is NOT who the caller is. That question has no answer on a static mesh:
      // an untargeted spawn carries no authorization mode, and the admin reach a static caller
      // holds is true by construction for everyone who can reach the handler. It asks whether the
      // event channel being minted BELONGS TO THE AGENT BEING CREATED, which the manager knows
      // because it has just allocated the principal.
      //
      // STATED LIMIT, because a fence whose gap is discovered later is worse than one whose gap is
      // written down. `eventChannelPrincipal` decodes a principal and refuses anything that is not exactly
      // two principal tokens, so a WILDCARD is not an event channel to it: `events.<owner>.>` and
      // `events.>` pass this rule untouched and are governed by ordinary ACL authority, which on a
      // user mesh is the envelope and on a static mesh is the spawn credential itself. So this
      // closes the concrete form and not the wildcard form. It is worth having anyway: it is the
      // form a caller writes when it knows which agent it wants to read, and the wildcard form is
      // the one an operator writes deliberately for an observer.
      const foreign = foreignEventChannels([...allowSubscribe, ...(allowPublish ?? [])], agentTriple.owner, agentTriple.actor);
      if (foreign.length) {
        // Throws rather than returning, because this seam is inside the accept body: the throw
        // unwinds before `onAccepted`, so no goal is bound and no identity is minted, and the
        // enclosing `finally` releases the reserved name. Returning here would be a value nobody
        // reads.
        throw new Error(
          `this spawn asks for another agent's event channel: ${foreign.join(", ")}. An ` +
            `agent may be granted its OWN event plane and no other, because that plane carries the ` +
            `session's tool inputs and outputs. Grant a reader out of band rather than through a ` +
            `spawn: ${this.readerRemedy(agentTriple.owner, foreign[0]!)}`,
        );
      }
      if (events) allowPublish = [...(allowPublish ?? []), connector.eventChannel!({ owner: agentTriple.owner, actor: agentTriple.actor })];
      await hooks?.onReadinessWindow?.(readinessTimeoutMs);
      // The hosted enrollment arm accepts only once the host has answered: the floor names the uid
      // the agent runs at, and before the host picks it there is no such uid to name.
      const hostedEnrollment = this.userMode && (opts.delegatedIntent !== undefined || this.remoteAuthority?.enrollManagedAgent !== undefined);
      // A once spawn's task is accepted with the spawn, before anything launches.
      let onceTask: { ref: GoalRef; deadlineAt?: number } | undefined;
      const acceptOnce = async (seat: { owner: string; actor: string; uid: string }): Promise<void> => {
        if (opts.once === undefined) return;
        onceTask = await hooks!.onOnce!({
          seat: { name, ...seat }, prompt: prompt!, spawner: this.spawnerName(spawner), deadlineMs: opts.once.deadlineMs, readinessDeadlineMs: readinessTimeoutMs,
          ...(connector.retireAfterExit ? { retire: connector.name } : {}),
        });
      };
      if (!hostedEnrollment) {
        await hooks?.onAccepted?.({ name, identity, lifecycleUid, agentTriple });
        await acceptOnce(agentTriple);
      }
      // In auth mode, mint the agent's creds from the space signing key and write them where the
      // spawned session reads them (COTAL_CREDS path). Open mesh → no creds. Scope = the resolved
      // subscribe/allowSubscribe (read) + allowPublish (post, default-deny).
      let credsPath: string | undefined;
      let issued: ManagedAgent["issued"];
      let userLaunch: UserAuthLaunch | undefined;
      let userOwner: string | undefined;
      let enrolled: ProvisionedUserAgent["enrolled"];
      if (this.userMode) {
        const prep = await this.provisionUserAgent(name, {
          eventPayloads,
          spawner,
          specOwner: opts.owner,
          subscribe,
          allowSubscribe,
          allowPublish,
          role,
          capabilities,
          label: ref,
          lifecycleUid,
          enrollmentCaller: authenticatedCaller ? { owner: authenticatedCaller.owner, actor: authenticatedCaller.actor } : undefined,
          delegatedIntent: opts.delegatedIntent,
          ...(opts.served !== undefined ? { spawnRequest: this.userProvision.servedSpawnRequest(opts.served, authenticatedCaller) } : {}),
          // Hold the name at the UID the host enrolled for the intent's user before any later local
          // step runs, so no later failure, its refusal included, releases a lifecycle that only that
          // user's retirement intent retires.
          onEnrolled: opts.delegatedIntent
            ? (enrolled) => {
                provisioned = { id: principalKey(enrolled.owner, name).key, name, lifecycleUid: enrolled.lifecycleUid, userOwner: enrolled.owner, delegated: true, secretPaths: enrolled.files };
              }
            : undefined,
        });
        if ("error" in prep) {
          if (prep.refused !== undefined) hooks?.onUndone?.(prep.refused);
          return { ok: false, error: prep.error, ...(prep.refused !== undefined ? { code: prep.refused } : {}), ...(prep.details ? { details: prep.details } : {}) };
        }
        // THE HOST'S UID WINS (#1972). On the local arm this is the value passed in, unchanged. On
        // the hosted enrollment arm the host selected it, and from here every lifecycle-keyed thing
        // this spawn records — the slot, the launch, the managed row, the teardown credential — must
        // carry that value and not the provisional one, or the manager would address a footprint the
        // host never created.
        lifecycleUid = prep.lifecycleUid;
        userLaunch = prep.launch;
        userOwner = prep.owner;
        enrolled = prep.enrolled;
        provisioned = { id: principalKey(prep.owner, name).key, name, lifecycleUid, userOwner: prep.owner, ...(opts.delegatedIntent ? { delegated: true as const } : {}), secretPaths: prep.files, ...(custody ? { runtime: custody } : {}) };
        if (hostedEnrollment) {
          try {
            await hooks?.onAccepted?.({ name, identity, lifecycleUid, agentTriple: { owner: prep.owner, actor: name, uid: lifecycleUid } });
            await acceptOnce({ owner: prep.owner, actor: name, uid: lifecycleUid });
          } catch (e) {
            // A refused accept rolls the enrollment back: the host's grant through `provisioned`, and
            // this participant's secret family here, before the refusal returns. The hosted retirement
            // removes it too, but only once the host's release completes.
            const unshredded: CleanupFailure[] = [];
            await this.shredUserSecrets(unshredded, prep.files);
            if (unshredded.length) throw new Error(`${rejectionText(e)}; cleanup failed: ${describeCleanupFailures(unshredded)}`, { cause: e });
            throw e;
          }
        }
      } else if (this.auth) {
        // §13.1: reserve + activate this incarnation's DURABLE identity BEFORE any
        // broker footprint — the outer spawn intent first (slot row, phase `provisioning`),
        // then the SHARED core activation saga (reserve uid -> gate frozen -> head CAS -> reopen
        // LAST) over the key-pinned executor. The wire AUTHORITY principal is the incarnation-
        // unique nkey; the alias is protected by the name-keyed slot + freeSlot hold.
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: identity.id, lifecycleUid, alias: name }, (t) =>
          activateStaticLifecycle(t, { owner: DEV_OWNER, alias: name, actor: identity.id, lifecycleUid, managerInstance: this.config.managerLifecycleUid, ownerInstanceId: this.managerInstanceId, runtime: custody }),
        );
        // From here the DURABLE registration exists: arm the rollback BEFORE minting, so a throw
        // between activation and provisioning still drives the exact-op static terminal (the
        // finally's deprovision tolerates absent files; the broker teardown is idempotent).
        provisioned = { id: identity.id, name, lifecycleUid, ...(custody ? { runtime: custody } : {}) };
        // Pre-create the agent's bind-only chat (+ DM + role TASK) durables and mint its scoped creds
        // — the shared onboarding step (provisionAgent). It runs on a short-lived PROVISIONER connection
        // (NOT the supervisor's long-lived endpoint), so the DM/DLV consumer-create surface exists only
        // for the provisioning window, never as a standing grant on the always-on daemon (residual 2).
        // The credential is BOUNDED (`expiresAt`) — the manager push-renews it ahead of expiry.
        const now = Math.floor(Date.now() / 1000);
        const exp = now + MANAGED_STATIC_TTL_SEC;
        // The credential is an ISSUANCE (SPEC 13.15): its caller rails carry a fresh generation
        // and its ceiling is recorded as evidence bound to this incarnation's ledger family. The
        // §13.1 ledger append (ledger BEFORE materialization) is the release's finalizer, so the
        // evidence activates only once the row exists, and the row exists only after the evidence
        // was staged. The agent learns the generation by reading the accepted row under its token.
        // The generation's horizon bounds every renewal of this incarnation's credential.
        issued = { generation: mintGeneration(now + STATIC_GENERATION_HORIZON_SEC), acceptedToken: mintAcceptedToken(), listing: true };
        const issuedAgent = { name, id: identity.id, lifecycleUid };
        const creds = await this.withIssuer((i) =>
          this.withProvisioner((prov) =>
            provisionAgent(prov, this.auth!, identity, {
              eventPayloads,
              subscribe,
              allowSubscribe,
              allowPublish,
              role,
              capabilities,
              ...(endpoints.length ? { endpointCapabilities: endpoints } : {}),
              lifecycleUid,
              expiresAt: exp,
              issued,
              issuance: this.parts.brokerTransport.issuanceSeam(i, "issue", issuedAgent, exp),
            }),
          ),
        );
        // Store first (the source of truth), then materialize: `buildLaunch` hands the CHILD this
        // file path, so the cred must exist as a file regardless of the store behind the seam. The
        // manager's ONE store (injected for hosted, workstation FS locally).
        const secrets = this.config.secrets;
        // LIFECYCLE-KEYED (SPEC 13.1 on the FS): the incarnation's cred file embeds its uid, so a
        // replayed/stale teardown can never address a same-name successor's credential.
        credsPath = agentLifecycleSecretFilePaths(this.config.workspaceRoot, this.config.space, name, lifecycleUid).creds;
        await secrets.put(agentSecretKeyForFile(credsPath, this.config.space), creds);
        await materializeSecretToFile(secrets, agentSecretKeyForFile(credsPath, this.config.space), credsPath);
        provisioned = { id: identity.id, name, lifecycleUid, secretPaths: { creds: credsPath }, ...(custody ? { runtime: custody } : {}) }; // footprint now exists — the finally rolls it back if the spawn throws
      }
      // Per-agent cwd overrides the manager's shared workspace root, so agents can be rooted at
      // arbitrary folders/repos. A relative path resolves against the workspace root; omitted → the
      // agent shares the workspace root (the prior, unchanged behavior).
      // The realpath the admission check above already resolved (#385 item 2) — never re-resolved here,
      // so the admission refusal and the launch cwd can never disagree on the same request.
      const cwd = resolvedCwd ?? this.config.workspaceRoot;
      // An inline persona's snapshot, and its catalog copy when saved, are written here: after the
      // grant (the static issuance, the user-auth ledger, a hosted enrollment that may replace the
      // uid) and before launch, so a refused grant leaves neither file and the snapshot carries the
      // final uid. A copy that loses a create race throws, and the finally rolls the grant back.
      if (inline) {
        configPath = writeInlineSnapshot(this.config.workspaceRoot, lifecycleUid, { name, role, model, variant, description: def.description, body: def.persona });
        snapshotUid = lifecycleUid;
        if (catalogCopy) saveAgentFile(agentFilePath(this.config.workspaceRoot, ref), catalogCopy, { createOnly: true });
      }
      if (configPath === undefined) throw new Error("internal: the persona file is missing at launch");
      const configSha256 = this.fileDigest(configPath);
      const manifestPath = opts.launchRef
        ? join(this.config.workspaceRoot, ".cotal", "run", `${opts.launchRef.runId}.json`)
        : undefined;
      const manifestSha256 = manifestPath ? this.fileDigest(manifestPath) : undefined;
      const launchOpts: LaunchOpts = {
        ...hostFields,
        name,
        role,
        // User mode: the principal IS the identity (the endpoint derives card.id from owner+actor);
        // no nkey id, no static creds.
        id: userLaunch ? undefined : identity.id,
        creds: credsPath,
        userAuth: userLaunch,
        // The incarnation's lifecycle UID: the agent endpoint binds its lifecycle-keyed dm/dlv/
        // chathist durables by this exact value (its creds pin the same names, so a mismatch fails
        // at the broker, never silently).
        lifecycleUid,
        acceptedToken: issued?.acceptedToken,
        configPath,
        model,
        variant, modes: opts.modes,
        launchOptions,
        // Fork an existing session into the mesh. Taken straight from `opts.resume` (the imperative
        // control arg), never from `opts.resolved` — so the manifest launch path carries no resume by
        // construction. An unsupported connector throws here before any process is spawned.
        resume: opts.resume,
        reopenSession,
        // Initial prompt: the `--prompt` flag, or the manifest entry's `prompt:` on a resolved launch.
        // A reopened session already had its kickoff turn, so it is not submitted again. A once
        // seat gets its prompt as its one relayed task instead.
        prompt: reopenSession === undefined && opts.once === undefined ? prompt : undefined,
        // Never recorded on the launch, so no restart or resume runs it again.
        firstCommand: opts.firstCommand,
        ...(opts.autoName === true ? { autoName: true } : {}),
        ...(opts.once !== undefined ? { once: true } : {}),
        // The SAME access set the creds were minted from (above) — forwarded so the session's
        // runtime read/post set matches its credentials. Without this a manifest-spawned agent
        // (materialized persona has no access frontmatter) has no channel set to read and joins
        // nothing, even though its creds authorize the manifest's channels.
        subscribe,
        allowSubscribe,
        allowPublish,
        capabilities,
        // Always the list the launch resolved, `[]` included, so the session never reads a persona
        // file that may have changed since.
        endpoints: copyPersonaEndpoints(personaEndpoints) ?? [],
        events,
        eventPayloads,
        ...optInLaunchFields(opts),
        cwd,
      };
      // A delegated seat gets no local launch at all: no launch-material file, control token or
      // manager path is produced for it, only the handoff its runtime writes into the child.
      let handle: AgentHandle;
      if (runtime.spawnDelegated) {
        const handoff = this.userProvision.composeManagedHandoff(enrolled!.material, enrolled!.actorToken);
        if (this.delegatedLaunched.has(lifecycleUid))
          throw new Error(`lifecycle ${lifecycleUid} was already handed to runtime "${runtime.kind}"; a lifecycle is handed off at most once`);
        this.delegatedLaunched.add(lifecycleUid);
        const holder = retainConnectorSeat(this.managerInstanceId, name);
        handle = runtime.spawnDelegated(
          { agent, persona: readFileSync(configPath, "utf8"), managerInstanceId: this.managerInstanceId, role, model, variant, prompt, launchOptions: launchOptions as Record<string, string> | undefined, events, eventPayloads },
          handoff,
        );
        watchConnectorHolder(handle, holder);
      } else {
        if (carried) {
          seatHome = join(this.config.workspaceRoot, ".cotal", "seat-homes", lifecycleUid);
          mkdirSync(seatHome, { recursive: true, mode: 0o700 });
          launchOpts.carried = { home: seatHome, transcript: carried.path, cwd };
        }
        spec = connector.buildLaunch(launchOpts);
        if (carried) this.transcripts!.consume(opts.resumeClaim!, opts.resume!);
        spec.env = { ...spec.env, COTAL_MANAGER_INSTANCE: this.managerInstanceId, ...modelPolicyEnv(cotalConfig, role) };
        handle = await this.seatCustody.spawnCustodied(runtime, name, spec, cwd, custody, this.userMode);
      }
      if (onceTask && !handle.waitForExit)
        throw new Error(`once: runtime "${handle.kind}" cannot prove the seat's exit, which is what ends its task when the seat goes first`);
      const launchedAt = Date.now();
      hooks?.onLaunched?.(); // The "launched" progress edge (process spawned, pre-presence)
      const managed: ManagedAgent = {
        name,
        role,
        agent,
        ...(seatHome ? { seatHome } : {}),
        id: userLaunch ? principalKey(userLaunch.owner, name).key : identity.id,
        lifecycleUid,
        // The lifecycle-keyed family this spawn just materialized (absent on an open mesh) — the
        // recorded truth teardown/preservation/health consume, never re-derived by name.
        secretPaths: provisioned?.secretPaths,
        ...(userLaunch ? { userOwner } : { seed: identity.seed }),
        ...(opts.delegatedIntent ? { delegated: true as const } : {}),
        ...(issued ? { issued } : {}),
        spawner: spawner ?? this.ep.ref().id,
        authorityParent: userLaunch && spawner && parsePrincipalKey(spawner) ? spawner : undefined,
        startedAt: Date.now(),
        handle,
        control: spec?.control,
        ...(spec ? {} : { handedOff: true as const }),
        launch: {
          runtime: runtime.kind,
          source: opts.resolved
            ? {
                kind: "manifest",
                runId: opts.launchRef?.runId,
                requested: opts.launchRef?.requested ?? opts.resolved.name,
                hash: opts.launchRef?.hash ?? opts.resolved.hash,
                configPath,
                configSha256,
                manifestSha256,
              }
            : inline
              ? { kind: "inline", ref, configPath, configSha256 }
              : { kind: "persona", ref: opts.config ? identityName : ref, configPath, configSha256 },
          cwd,
          model,
          // Claude omits the variant from its launch when a native effort option takes precedence.
          variant: connector.name === "claude" && spec ? spec.env?.COTAL_VARIANT : variant,
          modes: opts.modes,
          // The kickoff prompt is part of the launch form: a stale-restart re-submits it, so the
          // recorded launch must carry it for the restart gate (and preserve) to see it. A once
          // seat's prompt is its task, which no relaunch may submit again.
          prompt: onceTask ? undefined : prompt,
          subscribe,
          allowSubscribe,
          allowPublish,
          capabilities,
          ...(personaEndpoints?.length ? { endpoints: copyPersonaEndpoints(personaEndpoints) } : {}),
          events,
          eventPayloads,
          ...optInLaunchFields(opts),
          shareTools: opts.shareTools,
          forkSource: opts.resume,
          ...(opts.resume !== undefined && spec?.resumeRecordPath ? { resumeRecordPath: spec.resumeRecordPath } : {}),
          ...(carried ? { carried: { transcriptSha256: carried.sha256, host: carried.sourceHost, transferredAt: carried.stagedAt } } : {}),
          // Opaque values may contain secrets. Preserve only their keys and require the referenced
          // persona/manifest to resolve the values again; imperative overrides have no safe payload.
          unresolvedLaunchOptionKeys:
            opts.launchOptions && Object.keys(opts.launchOptions).length
              ? Object.keys(opts.launchOptions).sort()
              : undefined,
        },
        // A delegated agent is never restarted (SPEC 13.16), and a once seat never runs its task
        // twice, so neither slot arms recovery.
        ...(onceTask ? { once: { ref: onceTask.ref, ...(connector.retireAfterExit ? { retire: connector.name } : {}) } } : {}),
        ...(spec && (connector.supportsSessionContinuation || opts.supervise !== undefined) && !opts.delegatedIntent && !onceTask
          ? {
              restart: {
                opts: launchOpts,
                sessionStatePath: spec.sessionStatePath,
                crashes: [],
                recovering: false,
                armed: false,
                ...(opts.supervise !== undefined ? { policy: opts.supervise } : {}),
              },
            }
          : {}),
      };
      // The DURABLE slot takes the `active` phase before the in-memory row takes the
      // name — a crash between the two leaves an active-but-unadopted slot the boot sweep
      // terminalizes (never an untracked orphan). Static auth only; a failed CAS fails the spawn
      // (the finally's rollback then drives the exact-op terminal).
      if (this.auth && !this.userMode) {
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: managed.id, lifecycleUid, alias: name }, async (t) => {
          const slot = await readStaticSlot(t, DEV_OWNER, name);
          if (slot === undefined || slot.row.lifecycleUid !== lifecycleUid || slot.row.phase !== "provisioning")
            throw new Error(`the static slot for "${name}" is ${slot === undefined ? "absent" : `${slot.row.phase} at uid ${slot.row.lifecycleUid}`}, not this spawn's provisioning intent; refusing to take the slot`);
          // The custody reference rides the SAME CAS as activation: a crash after this write leaves
          // an active slot a successor can reap by reference, never a live seat nobody addresses.
          await casStaticSlot(t, { ...slot.row, phase: "active", ...(handle.reference ? { runtime: handle.reference } : {}) }, slot.revision);
        });
      }
      this.place(name, managed);
      if (managed.once) this.watchOnceExit(managed);
      // The live slot now owns teardown — freeSlot deprovisions this identity on exit — so the
      // orphan-rollback in `finally` no longer applies to it.
      provisioned = undefined;
      seatHome = undefined;
      snapshotUid = undefined;
      // #159 B1: reply on a REAL outcome, not a timer. Wait for the agent to actually join the mesh
      // (presence) → started, the child to exit → failed (with its last output; already reaped), or
      // neither in time → uncertain. `✓ started` therefore means "it joined", never just "a process
      // launched", except for a launch whose options make the harness wait for the operator first: that
      // one is ready once its process runs, and its reply names the screen it waits at.
      const operator = connector.waitsForOperator?.(launchOptions);
      const readiness = await this.awaitReadiness(managed, readinessTimeoutMs, operator === undefined ? {} : { operator });
      // Deliberately stopped mid-launch: reaped by onExit, and the despawn/stop path owns the
      // goal terminal. Return BEFORE the failed/uncertain arms so this emits no competing
      // outcome and does not re-arm an exit watcher on an agent already gone.
      if (!readiness.ok && readiness.deliberate) { hooks?.onTerminalDeferred?.(); return { ok: false, error: readiness.detail }; }
      if (!readiness.ok && !readiness.uncertain) { // failed → already reaped
        // A reopen fails before readiness when the host no longer has the recorded session, which
        // is refused rather than replaced by an empty one; name the record that pins it.
        const error = reopenSession === undefined ? readiness.detail
          : `${readiness.detail} (continuity: exact was reopening recorded session ${reopenSession}; if the harness no longer has it, ` +
            `remove ${join(this.config.workspaceRoot, ".cotal", "continuity", `${name}.json`)} to start a new session)`;
        if (managed.once) managed.once.stopReason ??= "launch-failed";
        await hooks?.onOutcome?.({ kind: "failed", data: { error } });
        return { ok: false, error };
      }
      // Started OR uncertain: the agent stays managed, so wire the ongoing exit reaper (it reaps a later
      // death — including one that follows an `uncertain` verdict, which deliberately does NOT deprovision).
      if (!readiness.ok) {
        this.watchExit(managed);
        if (managed.launch.carried) void this.sessionRecovery.refuseLateCarriedFork(managed, readinessTimeoutMs);
        // A once seat is never left running with nothing to do, and its stop does not wait on the
        // spawn's terminal, whose write can stall. The spawn keeps that terminal: the stop lets go
        // of the spawn goal first. Its task was never served and is cancelled with the verdict.
        if (managed.once) {
          this.endOnceBeforeServe(managed, "readiness-timeout");
        }
        await hooks?.onOutcome?.({ kind: "uncertain", data: { reason: readiness.detail, ...(readiness.running ? { running: true } : {}) } });
        return { ok: false, error: readiness.detail };
      }
      // A once seat whose connector needs a confirmed startup is served only on that outcome. Any
      // other ends it like a seat that never joined: stopped before the failed terminal, and its
      // task, never served, cancelled with the verdict.
      if (onceTask && connector.onceNeedsConfirmed !== undefined) {
        const startup = await this.awaitStartupOutcome(managed, launchedAt, readinessTimeoutMs);
        if (managed.terminalizing || this.leaseStopping) { hooks?.onTerminalDeferred?.(); return { ok: false, error: `${name} was stopped before its startup ended` }; }
        if (startup !== "confirmed") {
          const watch = { ready: "opened its input screen without the prompt", failed: "failed", exited: "saw the seat exit", pending: "had not ended" }[startup];
          const error = `${name} joined, but ${connector.onceNeedsConfirmed}: its startup watch ${watch}, so it cannot take a once task`;
          this.watchExit(managed);
          this.endOnceBeforeServe(managed, "launch-failed", "launch-failed");
          await hooks?.onOutcome?.({ kind: "failed", data: { error } });
          return { ok: false, error };
        }
      }
      // An input screen without the prompt allows a plain launch, but mesh traffic cannot wake it.
      if (!onceTask && connector.idleWakeNeedsConfirmed !== undefined && runtime.reportsStartupOutcome) {
        const startup = await this.awaitStartupOutcome(managed, launchedAt, readinessTimeoutMs);
        if (managed.terminalizing || this.leaseStopping) { hooks?.onTerminalDeferred?.(); return { ok: false, error: `${name} was stopped before its startup ended` }; }
        if (startup === "failed" || startup === "exited") {
          const error = await startupFailureDetail(managed, startup);
          if (managed.terminalizing || this.leaseStopping) { hooks?.onTerminalDeferred?.(); return { ok: false, error }; }
          this.watchExit(managed);
          await hooks?.onOutcome?.({ kind: "failed", data: { error } });
          return { ok: false, error };
        }
        if (startup === "ready") {
          managed.startupNotice = connector.idleWakeNeedsConfirmed;
          console.error(`! ${name}: ${connector.idleWakeNeedsConfirmed}`);
        }
      }
      if (managed.launch.carried) {
        const refused = await this.sessionRecovery.refuseCarriedFork(managed, readinessTimeoutMs);
        if (refused !== undefined && managed.terminalizing) { hooks?.onTerminalDeferred?.(); return { ok: false, error: refused }; }
        if (refused !== undefined) {
          this.stopAndTrack(managed, "carried-fork-refused");
          await hooks?.onOutcome?.({ kind: "failed", data: { error: refused } });
          return { ok: false, error: refused };
        }
      }
      if (managed.restart) {
        if (connector.supportsSessionContinuation) {
          try {
            await this.sessionRecovery.armSessionRecovery(managed);
            // The capability flags are only a claim. An exact seat is recorded once the connector
            // has proved its session over its authenticated control endpoint, never before.
            if (exact && !managed.restart.armed)
              throw new Error("continuity: exact needs the connector to prove its session over an authenticated control endpoint, and it supplied none");
            managed.launch.sessionId = this.sessionRecovery.readManagedSession(managed);
            if (reopenSession !== undefined && managed.launch.sessionId !== reopenSession)
              throw new Error(`continuity: exact asked for session ${reopenSession}, the connector bound ${managed.launch.sessionId}`);
            if (exact) {
              managed.continuity = { space: this.config.space, name, connector: agent, cwd };
              this.sessionRecovery.recordContinuity(managed, managed.launch.sessionId);
            }
          } catch (error) {
            const detail = `${managed.name} joined, but its exact host session could not be bound for supervised recovery: ${rejectionText(error)}`;
            this.stopAndTrack(managed, "session-bind-failed");
            await hooks?.onOutcome?.({ kind: "failed", data: { error: detail } });
            return { ok: false, error: detail };
          }
        } else {
          managed.restart.armed = true;
        }
        if (managed.restart.policy) {
          try {
            this.seatCustody.recordSeat(managed);
          } catch (error) {
            const detail = `${managed.name} joined, but supervise cannot cover a manager restart for it: ${rejectionText(error)}`;
            this.stopAndTrack(managed, "supervise-record-failed");
            await hooks?.onOutcome?.({ kind: "failed", data: { error: detail } });
            return { ok: false, error: detail };
          }
        }
      }
      // An unsupervised seat a successor could adopt keeps a record too; one that cannot be written
      // costs only that adoption, so the spawn stands and the line says so.
      if (!managed.restart?.policy) this.seatCustody.refreshSeatRecord(managed);
      this.watchExit(managed);
      // Reply with the id the slot actually carries (user-mode: the owner.actor principal —
      // presence, ps, and the manifest ownership ledger all key on it; the throwaway static nkey
      // would never match and down -f would treat the agent as foreign).
      // `lifecycleUid` rides the reply so callers that record this spawn (the manifest ledger) can
      // later address the incarnation's lifecycle-keyed artifacts without re-deriving by name.
      // OMIT an absent role: the goal terminal commits this data through the strict
      // canonicalJson (undefined never coerces to null, SPEC 13.6), so a role-less spawn would
      // otherwise fail its succeeded terminal. The CLI/connector already render an absent role as
      // "no role", so dropping the key preserves the reply (surfaced by readiness:live).
      // A host that granted other channels than this spawn asked for: the receipt carries both.
      const acl = enrolled ? enrolledAcl({ allowSubscribe, allowPublish }, enrolled.material) : undefined;
      const okData = { name, agent, id: managed.id, mode: handle.kind, streamsTerminal: runtime.streamsTerminal, lifecycleUid, ...(role !== undefined ? { role } : {}), ...(opts.eventsNotice !== undefined ? { eventsNotice: opts.eventsNotice } : {}), ...(managed.startupNotice !== undefined ? { startupNotice: managed.startupNotice } : {}), ...(acl ? { acl } : {}), ...(readiness.operator !== undefined ? { waitingFor: readiness.operator } : {}), ...(onceTask ? { once: { goalId: onceTask.ref.goalId, ...(onceTask.deadlineAt !== undefined ? { deadlineAt: onceTask.deadlineAt } : {}) } } : {}) };
      // The task is served once the succeeded terminal is written, so a served task always has it
      // and a successor reads it as the readiness verdict. Every failure arm above ran before it. A
      // terminal this call did not commit never served the task: the seat is stopped, which cancels it.
      const committed = await hooks?.onOutcome?.({ kind: "succeeded", data: okData });
      if (onceTask && committed === true) this.openOnceDelivery(onceTask.ref);
      else if (onceTask) {
        this.endOnceBeforeServe(managed, "launch-failed", "launch-failed");
      }
      return { ok: true, data: okData };
    } catch (e) {
      if (e instanceof SharedLaunchHeld) {
        this.sharedLaunchHolds.set(name, () => {
          e.releaseHolder?.();
          discardLaunchArtifacts(spec?.artifacts);
          this.settleUnusedLaunch(name, seatHome, snapshotUid, provisioned);
        });
        void hooks?.onOutcome?.({ kind: "uncertain", data: { reason: e.message }, atReadinessDeadline: true });
        return controlReplyFromThrown(new EpEnvelopeError("unavailable", e.message, undefined, "unknown"), e.message);
      }
      // Failure after reserve (provision / launch threw): the slot was never live, so no cold-start
      // was paid — the reserved rollback (finally) is enough, no cooling stamp.
      // Keep the envelope's code and lifecycle details on the ControlReply so the serve boundary
      // can carry the refusal's classification and barrier to the caller. An extension can throw
      // any value, and an envelope's `message` is only typed as a string, so the refusal text always
      // comes from rejectionText; telling an envelope apart is guarded because a thrown Proxy can
      // throw from `instanceof` or from its own fields.
      const error = rejectionText(e);
      try {
        if (e instanceof EpEnvelopeError)
          return controlReplyFromThrown(e, error);
      } catch { /* not a readable envelope */ }
      return { ok: false, error };
    } finally {
      if (!this.sharedLaunchHolds.has(name)) this.settleUnusedLaunch(name, seatHome, snapshotUid, provisioned);
    }
  }
}

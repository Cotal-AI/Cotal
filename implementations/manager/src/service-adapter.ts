import { lstatSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureDirNoSymlink, registry, unansweredRequest } from "@cotal-ai/core";
import {
  CommandFailure, MANAGER_PIDFILE, MANAGER_SHUTDOWN_INTENT, armManagerShutdownIntent,
  assertManagerName, assertRecordIdentity, canonicalLocalProcessPath, canonicalRoot, clearRefusedServiceStopRequest,
  colorEnabled, commandIsCotalSupervisor, controllerAttemptBinding, cutController, localProcessPath, maintenanceAdmitsStackWork, publishServiceStopRequest,
  readLocalRecordSource, readMaintenanceJournal, readPidfile, readProcessRecord, readServiceStopReceipts, removePidPair, readServiceStopRequest, releaseRetainedServiceStop, clearRetainedRefusedServiceStopRequest,
  clearAbandonedServiceStopRequest, connectUserControlOrThrow, credentialRefusalMessage, disarmManagerShutdownIntent, isCommandFailure, managerShutdownIntentArmedBy, protectedLocalDirectory,
  releaseExitedServiceStopReservation, requestLocalStop, reserveNativeServiceStop, resolveNativeServiceTarget, serviceAdapterAttempt, serviceMetadataDigest,
  stopReservationPath, userViewAuth, type LocalProcess, type NativeServiceStopRequest, type ProcessIdentityRecord, type ServiceAdapterAttempt, type ServiceAdapterContext,
  type ServiceAdapterStopAbandonment, type ServiceAdapterStopContext, type ServiceAdapterStopPlan, type ServiceAdapterStopRefusal, type ServiceAdapterStopResult,
  type ServicePreset,
} from "@cotal-ai/workspace";
import { managerServiceLaunchSpec, managerServicePreservedExitScope, managerServiceStopScope } from "./service-child.js";
import { managerServiceReadiness, observeManagerService } from "./service-observation.js";

export const managerPreset: ServicePreset = {
  kind: "service-preset", name: "manager", adapter: "manager-service", timeoutMs: 60000,
  summary: "the manager that starts and keeps your agents running in this space",
  defaults: { root: { space: "root" }, runtime: { value: "pty" } },
};

/** Journal states in which a controller attempt starts or relaunches its manager. */
const ATTEMPT_LAUNCH_STATES: readonly string[] = ["resume-intent", "commit-intent", "resume-committed", "manager-committed"];

/** Whether this root's maintenance journal, if any, admits this launch, as the broker adapter
 *  decides for its own. An attempt launch is admitted only for the journal's own attempt, in a
 *  state that starts or relaunches the manager, for the cut's manager instance whose newest start
 *  row the attempt journaled and has not settled. A launch without an attempt is decided by
 *  `maintenanceAdmitsStackWork`, which admits only a settled active controller restore of this
 *  root's own stack, as the broker and a service restart decide. Every other journal, legacy
 *  custody included, refuses. The journal is only read. */
export function maintenanceAdmits(root: string, server: string, context: ServiceAdapterContext, attempt: ServiceAdapterAttempt | undefined): boolean {
  if (!attempt) return maintenanceAdmitsStackWork(root, context.space, server, context.stack);
  const journal = readMaintenanceJournal(root);
  if (!journal) return true;
  const attemptId = "ordinaryResume" in journal ? journal.ordinaryResume.attemptId : "restore" in journal ? journal.restore.attemptId : undefined;
  const manager = cutController(journal.cut)?.members.find((member) => member.role === "manager");
  const row = [...controllerAttemptBinding(journal)?.started ?? []].reverse().find((entry) => entry.role === "manager");
  return ATTEMPT_LAUNCH_STATES.includes(journal.state) && attempt.attemptId === attemptId && manager?.instanceId === context.instanceId &&
    row?.instanceId === context.instanceId && row.outcome === undefined;
}

async function prepareStop(context: ServiceAdapterStopContext): Promise<ServiceAdapterStopPlan> {
  if (context.preserved && context.withAgents) throw new CommandFailure("refused", "USAGE_INVALID", "a preserved-exit stop retains agents; --with-agents cannot be combined with it");
  let observation: Awaited<ReturnType<typeof observeManagerService>>;
  try { observation = await observeManagerService(context, { stop: true }); }
  catch (error) {
    // A manager that does not answer cannot report its stop impact, so no stop is submitted. Its
    // process is the operator's to end, and a stop run after that finds it gone.
    if (!unansweredRequest(error)) throw error;
    const pid = context.process.pid;
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the manager process ${pid} is running but did not answer its endpoint (${(error as Error).message}); no stop was submitted`, { target: { space: context.space, instanceId: context.instanceId, pid }, remedy: `if it stays unresponsive, end that process with kill -KILL ${pid}; the same command then finds it gone and goes on` });
  }
  if (!observation) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the exact native manager has no complete attributed startup observation; no stop was submitted");
  const registration = observation.registration;
  // An attributed status names the binding the manager holds and must equal the request. An open
  // space's local receipt keeps its older shape, so the request is digested and the native child
  // recomputes the scope against its own binding at acceptance.
  const held = observation.stopImpact.preservation ?? context.preserved;
  let scopeSha256: string;
  try { scopeSha256 = context.preserved ? managerServicePreservedExitScope(observation, context.preserved, held) : managerServiceStopScope(observation, context.withAgents); }
  catch (error) { throw await withAdminRegrant(context, error); }
  return {
    scopeSha256, observedAt: new Date().toISOString(), withAgents: context.withAgents,
    native: { endpoint: registration.endpoint, instanceId: registration.instanceId, epoch: registration.epoch, owner: registration.principal.owner, actor: registration.principal.actor, lifecycleUid: registration.principal.uid },
    subjects: observation.stopImpact.agents.map((row) => ({ name: row.name, id: row.id, lifecycleUid: row.lifecycleUid, action: context.withAgents ? row.withAgentsAction : row.defaultAction })),
    ...(observation.evidence ? { evidence: observation.evidence } : {}),
    ...(context.preserved ? { preserved: { attemptId: context.preserved.attemptId, inventorySha256: context.preserved.inventorySha256 } } : {}),
  };
}

/** On a user-auth space the manager shows its whole impact only to a caller whose grant holds
 *  `admin`. When it answered with owner-filtered impact, this asks the auth plane for that scope; its
 *  refusal names the whole-row re-grant built from the current ledger row, which becomes the remedy.
 *  No other caller is tried, and when the grant already holds `admin` the refusal stays as it was. */
async function withAdminRegrant(context: ServiceAdapterStopContext, error: unknown): Promise<unknown> {
  const blockers = isCommandFailure(error) ? (error.native?.detail as { blockers?: unknown } | undefined)?.blockers : undefined;
  if (!isCommandFailure(error) || !Array.isArray(blockers) || !blockers.includes("owner-filtered-visibility")) return error;
  const selected = resolveNativeServiceTarget(String(context.options.root), context.space, context.options.server as string | undefined);
  if (selected.mode !== "user") return error;
  let regrant: string | undefined;
  try { await userViewAuth(await connectUserControlOrThrow({ space: selected.space, server: selected.server }), "admin"); }
  catch (refusal) { regrant = credentialRefusalMessage(refusal); }
  if (regrant === undefined) return error;
  return new CommandFailure(error.outcome, error.code, error.message, { target: error.target, native: error.native, remedy: `stopping the whole manager needs the admin scope on your grant; ${regrant}` });
}

/** The reservation is retained after any unconfirmed submission. Only a known refusal or both a
 *  native returned receipt and the exact process exit can release it. There is no force kill. */
async function stop(context: ServiceAdapterStopContext & { requestId: string; plan: ServiceAdapterStopPlan }): Promise<ServiceAdapterStopResult> {
  const root = String(context.options.root), pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space: context.space });
  // A reservation whose stopper exited before it published a request handed this launch nothing, so
  // it is released under the definition hold rather than refusing every later stop.
  let published: boolean;
  try { published = readServiceStopRequest(context) !== undefined; } catch { published = true; }
  if (!published) releaseExitedServiceStopReservation(stopReservationPath(pidPath));
  const reservation = reserveNativeServiceStop(stopReservationPath(pidPath));
  let submitted = false, releasable = true, clearWake: ((gone: boolean) => void) | undefined;
  try {
    const current = await prepareStop(context);
    if (current.scopeSha256 !== context.plan.scopeSha256 || current.withAgents !== context.withAgents || current.evidence !== context.plan.evidence || serviceMetadataDigest(current.native) !== serviceMetadataDigest(context.plan.native) || serviceMetadataDigest(current.preserved ?? null) !== serviceMetadataDigest(context.plan.preserved ?? null)) throw new CommandFailure("refused", "CONFLICT", "the manager impact or native incarnation changed after confirmation; no signal was sent");
    const legacyPid = readLocalRecordSource(pidPath, 128, true)?.toString("utf8").trim();
    if (legacyPid !== String(context.process.pid) || assertRecordIdentity(context.process).kind !== "match") throw new CommandFailure("refused", "CONFLICT", "the native manager PID custody changed; no signal was sent");
    const intent = canonicalLocalProcessPath(MANAGER_SHUTDOWN_INTENT, { root, space: context.space });
    if (readLocalRecordSource(intent, 8192, true) !== undefined) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier native shutdown intent is retained; it was not overwritten or adopted");
    const request: NativeServiceStopRequest = { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, requestId: context.requestId, target: { ...context.process }, stopper: reservation.stopper, withAgents: context.withAgents, scopeSha256: current.scopeSha256, ...(context.preserved ? { preserved: { attemptId: context.preserved.attemptId, inventorySha256: context.preserved.inventorySha256 } } : {}) };
    context.signal.throwIfAborted();
    // Publication can succeed before a durability error reaches us. Retain custody from here.
    releasable = false;
    publishServiceStopRequest(context, request);
    if (context.withAgents) armManagerShutdownIntent({ root, space: context.space }, { target: context.process, stopper: { pid: reservation.stopper.pid, marker: stopReservationPath(pidPath) } });
    context.signal.throwIfAborted();
    if (assertRecordIdentity(context.process).kind !== "match") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the manager process changed after its stop handoff; no successor was signalled");
    submitted = true;
    // Windows has no SIGTERM to deliver, so the manager is woken through its cooperative local stop
    // capability, under the reservation this stop holds.
    if (process.platform === "win32") clearWake = requestLocalStop(pidPath, { target: context.process, stopper: { pid: reservation.stopper.pid, marker: stopReservationPath(pidPath) } });
    else process.kill(context.process.pid, "SIGTERM");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      context.signal.throwIfAborted();
      const phases = readServiceStopReceipts(context, request);
      if (phases.some((row) => row.phase === "refused")) {
        clearRefusedServiceStopRequest(context, request);
        releasable = true;
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native manager refused the changed request or impact before stopping; inspect again before a new confirmation");
      }
      if (phases.some((row) => row.phase === "failed")) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native manager reported a failed stop; process and cleanup completion remain unconfirmed and the original request was retained");
      const completed = phases.find((row) => row.phase === "completed");
      const identity = assertRecordIdentity(context.process);
      if (completed && (identity.kind === "gone" || identity.kind === "mismatch")) {
        releasable = true;
        return { requestId: request.requestId, scopeSha256: request.scopeSha256, process: { ...request.target }, nativeStop: request.preserved ? "preserved-exit-returned" : "returned", cleanup: "not-checked", observedAt: completed.observedAt };
      }
      if (!completed && (identity.kind === "gone" || identity.kind === "mismatch")) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original manager process exited without its native returned receipt; disappearance was not treated as a completed stop or cleanup");
      await delay(100, undefined, { signal: context.signal });
    }
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original native manager stop did not confirm both return and process exit; its request/reservation were retained, without force kill or restart");
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure(submitted || !releasable ? "unknown" : "refused", submitted || !releasable ? "OPERATION_UNKNOWN" : "LIFECYCLE_BLOCKED", submitted || !releasable ? "the native manager stop submission or observation was not confirmed; its original request was retained and not retried" : "the native manager preflight did not establish its exact current scope; no stop was submitted");
  } finally {
    clearWake?.(assertRecordIdentity(context.process).kind !== "match");
    if (releasable) reservation.release();
  }
}

/** Settle an ordinary request that outlived its stop call from this launch's own evidence: its
 *  published request and either that request's `completed` receipt with the exact process exit, or
 *  a `refused` receipt as its only one, which a child writes when it started no stop. Only then is
 *  the reservation the request took released, and only once its stopper is gone; a refused request
 *  is also removed, as a refusal within the stop call removes it. Anything less retains the request
 *  and the reservation. A preserved-exit request is left to its maintenance attempt, which reads
 *  its own receipts. */
function settleStop(context: ServiceAdapterContext & { readonly process: ProcessIdentityRecord; readonly requestId: string }): ServiceAdapterStopResult | ServiceAdapterStopRefusal | undefined {
  const request = readServiceStopRequest(context);
  if (!request || request.preserved || request.requestId !== context.requestId || request.target.pid !== context.process.pid || request.target.token !== context.process.token) return undefined;
  const phases = readServiceStopReceipts(context, request);
  const marker = stopReservationPath(canonicalLocalProcessPath(MANAGER_PIDFILE, { root: String(context.options.root), space: context.space }));
  const refused = phases.length === 1 ? phases.find((row) => row.phase === "refused") : undefined;
  if (refused) {
    if (!releaseRetainedServiceStop(marker, request.stopper) || !clearRetainedRefusedServiceStopRequest(context, request)) return undefined;
    return { requestId: request.requestId, nativeStop: "refused", observedAt: refused.observedAt };
  }
  const completed = phases.find((row) => row.phase === "completed");
  const identity = assertRecordIdentity(request.target).kind;
  if (!completed || identity !== "gone" && identity !== "mismatch") return undefined;
  if (!releaseRetainedServiceStop(marker, request.stopper)) return undefined;
  return { requestId: request.requestId, scopeSha256: request.scopeSha256, process: { ...request.target }, nativeStop: "returned", cleanup: "not-checked", observedAt: completed.observedAt };
}

/** Abandon, on an operator's explicit request, an ordinary request no receipt settles: the child wrote
 *  neither `completed` nor `refused`, and its exact process and the stopper that published it have both
 *  exited. Everything is checked before anything is removed. Then the `--with-agents` intent that same
 *  stop armed, the reservation and the request are removed, in that order, so a retry after a partial
 *  removal finds the rest. The phase receipts stay. */
function abandonStop(context: ServiceAdapterContext & { readonly process: ProcessIdentityRecord; readonly requestId: string }): ServiceAdapterStopAbandonment {
  const refuse = (message: string): never => { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `${message}; nothing was abandoned`); };
  const request = readServiceStopRequest(context);
  if (!request || request.requestId !== context.requestId || request.target.pid !== context.process.pid || request.target.token !== context.process.token) return refuse("this launch holds no published stop request with that ID for its recorded process");
  if (request.preserved) return refuse("the request is a preserved-exit stop, which its own maintenance attempt decides");
  const phases = readServiceStopReceipts(context, request);
  if (phases.some((row) => row.phase === "completed" || row.phase === "refused")) return refuse("the manager wrote a terminal receipt for this request, so a bare `cotal up` or `cotal down` settles it");
  const live = (record: ProcessIdentityRecord) => !["gone", "mismatch"].includes(assertRecordIdentity(record).kind);
  if (live(request.target)) return refuse("the manager process this request names still runs, and it may still act on the request");
  if (live(request.stopper)) return refuse("the `cotal down` that published this request still runs");
  const root = String(context.options.root), local = { root, space: context.space };
  const marker = stopReservationPath(canonicalLocalProcessPath(MANAGER_PIDFILE, local));
  const reservation = readLocalRecordSource(marker, 128, true)?.toString("utf8");
  if (reservation !== undefined && reservation !== String(request.stopper.pid)) return refuse("the manager's stop reservation names another process");
  const intent = managerShutdownIntentArmedBy(local, request.target, request.stopper);
  if (intent === "other") return refuse("a manager shutdown intent that this request did not arm is retained");
  if (intent === "exact") disarmManagerShutdownIntent(local);
  if (!releaseRetainedServiceStop(marker, request.stopper) || !clearAbandonedServiceStopRequest(context, request))
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the request changed while it was abandoned; inspect it before retrying");
  return { requestId: request.requestId, nativeStop: "abandoned", receipts: phases.map((row) => row.phase as "accepted" | "failed"), withAgents: request.withAgents, cleanup: "not-checked" };
}

export const managerService: LocalProcess = {
  kind: "local-process", name: "manager-service", label: "manager service", order: 10, controllerOnly: true,
  pidFile: MANAGER_PIDFILE, isOwnCommand: commandIsCotalSupervisor,
  service: {
    abiVersion: 1, requiresCli: true, readiness: "endpoint", stop: "native",
    capabilities: { multiInstance: false, foreground: true, logs: true }, paths: { root: "directory", launch: "private-file", roster: "file" },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root", "runtime"], properties: {
      root: { type: "string", minLength: 1, maxLength: 4096, description: "registered mesh root holding this manager's native custody" },
      runtime: { type: "string", minLength: 1, maxLength: 200, description: "explicit installed runtime; no runtime is installed or selected implicitly" },
      server: { type: "string", minLength: 1, maxLength: 4096, description: "optional repeat of the registered broker URL; another broker refuses" },
      "console-port": { type: "integer", minimum: 0, maximum: 65535, description: "explicit console port; zero allocates a port" },
      "console-host": { type: "string", minLength: 1, maxLength: 253, description: "explicit console bind host; omitted keeps native loopback binding" },
      "ws-port": { type: "integer", minimum: 1, maximum: 65535, description: "explicit prepared broker websocket listener port" },
      "max-sessions": { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "explicit positive native live-session ceiling" },
      launch: { type: "string", minLength: 1, maxLength: 4096, description: "existing private resolved native launch spec for the selected space" },
      "launch-sha256": { type: "string", minLength: 64, maxLength: 64, description: "full SHA-256 of the exact resolved launch file; required with launch" },
      roster: { type: "string", minLength: 1, maxLength: 4096, description: "existing roster file whose agents the manager starts at each launch; a resumed manager takes none" },
      name: { type: "string", minLength: 1, maxLength: 128, description: "manager name for presence and --on; recorded for this root, so later launches keep it" },
    } },
  },
  buildServiceLaunch(context) {
    if (!context.cliInvocation?.length) throw new CommandFailure("refused", "UNSUPPORTED", "the manager service requires the verified cotal entry; no PATH binary was selected");
    if (context.credentialRef) throw new CommandFailure("refused", "UNSUPPORTED", "the native manager uses its selected root's supported service authority; a generic credential reference was not substituted");
    const root = String(context.options.root), target = resolveNativeServiceTarget(root, context.space, context.options.server as string | undefined);
    const path = localProcessPath(MANAGER_PIDFILE, { root: target.root, space: context.space });
    const raw = readPidfile(path), state = readProcessRecord(path, commandIsCotalSupervisor);
    if (raw === "" || !["absent", "dead"].includes(state.state)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a native manager record is live, foreign or unresolved; no legacy manager was adopted, stopped or replaced");
    if (typeof context.options["console-host"] === "string" && /[\u0000- \u007f]/u.test(context.options["console-host"])) throw new CommandFailure("refused", "USAGE_INVALID", "the declared console host contains whitespace or controls; no native child was launched");
    const extra: string[] = [];
    for (const name of ["console-port", "console-host", "ws-port", "max-sessions"] as const) if (context.options[name] !== undefined) extra.push(`--${name}`, String(context.options[name]));
    // A controller resume passes only its attempt and, when present, the protected token handoff
    // path and digest. Never the token, and never with a launch spec.
    const attempt = context.attempt === undefined ? undefined : serviceAdapterAttempt(context.attempt, ["resumeCommit"]);
    if (attempt && (context.options.launch !== undefined || context.options["launch-sha256"] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "a resumed manager takes no launch spec; no native child was launched");
    if (attempt && context.options.roster !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a resumed manager boots no roster; retained agents resume through the attempt. No native child was launched");
    if (!maintenanceAdmits(canonicalRoot(target.root), target.server, context, attempt)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance or recovery attempt; the manager service did not substitute an ordinary lifecycle");
    if (attempt) extra.push("--resume-attempt", attempt.attemptId, ...(attempt.resumeCommit ? ["--resume-commit-file", attempt.resumeCommit.path, "--resume-commit-sha256", attempt.resumeCommit.sha256] : []));
    if (context.options.launch !== undefined || context.options["launch-sha256"] !== undefined) {
      if (typeof context.options.launch !== "string" || typeof context.options["launch-sha256"] !== "string") throw new CommandFailure("refused", "USAGE_INVALID", "a manager launch requires both its private native spec and full SHA-256; neither was inferred");
      managerServiceLaunchSpec(context.options.launch, context.options["launch-sha256"], context.space);
      extra.push("--launch", context.options.launch, "--launch-sha256", context.options["launch-sha256"]);
    }
    if (context.options.roster !== undefined) extra.push("--roster", String(context.options.roster));
    if (context.options.name !== undefined) extra.push("--name", assertManagerName(String(context.options.name)));
    // A killed child leaves its custody record, and the next child claims the slot create-only and
    // never reclaims. A record whose pid is dead is retired here, under the controller's definition
    // lock, after every refusal above; a live, foreign or unreadable one refused there.
    if (state.state === "dead") removePidPair(path, String(state.pid));
    // A root that only `space add --root` registered has no `.cotal` until a command writes there,
    // and the child requires one. It is made here after every refusal above, in the root registered
    // for this space and only once that root is protected, as a 0700 directory through no link.
    if (!lstatSync(join(target.root, ".cotal"), { throwIfNoEntry: false })) {
      protectedLocalDirectory(target.root, "the manager root");
      ensureDirNoSymlink(target.root, ".cotal");
    }
    const [executable, ...self] = context.cliInvocation;
    return { executable: executable!, cwd: target.root, args: [...self, ...(colorEnabled() ? [] : ["--no-color"]), "__service-manager", "--root", target.root, "--space", context.space, "--server", target.server, "--runtime", String(context.options.runtime), "--service-instance", context.instanceId, "--launch-request", context.launchRequestId, "--state-directory", context.stateDirectory, ...extra] };
  },
  checkServiceReadiness: managerServiceReadiness,
  prepareServiceStop: prepareStop,
  stopService: stop,
  settleServiceStop: settleStop,
  abandonServiceStop: abandonStop,
};

registry.register(managerService, managerPreset);

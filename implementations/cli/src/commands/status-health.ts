import { lstatSync } from "node:fs";
import {
  drainAndClose,
  CotalEndpoint,
  dialerFor,
  EpEnvelopeError,
  isReachable,
  isStreamNotFound,
  mintCreds,
  mintLifecycleUid,
  resolveService,
  invokeRepairingSplit,
  standaloneConnectOpts,
  newIdentity,
  idFromCreds,
  principalKey,
  DEV_OWNER,
  unansweredRequest,
  resolveAuthProvider,
  type SpaceAuth,
} from "@cotal-ai/core";
import { join } from "node:path";
import {
  hasNonNatsExecutable,
  stoppedLoopbackListener,
  isCommandFailure,
  brokerAddressForDisplay,
  brokerUrlKey,
  CLI_USER_ACTOR,
  credentialFileExposure,
  CommandFailure,
  deliveryCredsKey,
  DELIVERY_PIDFILE,
  isMeshRegistryError,
  isWorkspaceTargetError,
  loadManagerInstanceIdentity,
  localProcessPath,
  MANAGER_PIDFILE,
  NATS_PIDFILE,
  oneLine,
  preflightTarget,
  principalFromBearer,
  verifyIdentityPin,
  probeWebReadiness,
  readPidfile,
  readRenewalRecord,
  userAuthStateDir,
  WEB_PIDFILE,
  workspaceSecretStore,
  displayWidth,
  terminalWidth,
  wrapWords,
  workspaceErrorParts,
  type ErrorCode,
  type LocalProcessContext,
  type MeshTarget,
  resolveControlTarget,
} from "@cotal-ai/workspace";
import { MANAGER_OMITTED } from "../lib/delivery-proc.js";
import { webBoundAddress, webInstalled, webSessionSource } from "../lib/status.js";
import { deliveryResponderFromLease, RESPONDER_UNBOUND_CONSEQUENCE } from "../lib/delivery-responder.js";
import { type StoreWriteObservation } from "../lib/broker-store-health.js";
import { pidfileState } from "./down.js";
import { displayRemedy } from "../lib/self-exec.js";
import { recordTelemetryFailure } from "../telemetry.js";
import { c } from "../ui.js";
import { cliControl } from "../lib/control.js";
import { instanceProjection, serviceInstances } from "../lib/service-instances.js";
import { readStackJournal, STACK_DEFINITION, stackRootGone, stackStartedWithoutManager, unusableStackJournal } from "../lib/stack-journal.js";
import { askManager } from "@cotal-ai/workspace/control";
import { managerStopImpactFacts } from "./status-stop-impact.js";
import { type Selected, type SelectedResult, type StatusResult, UnregisteredRoot } from "./status-model.js";

/** The lease `holder` the delivery daemon THIS WORKSPACE launched would write, or `undefined` when it
 *  cannot be known (#1576, and the reason is #837).
 *
 *  THE HOLDER IS A PRINCIPAL DOT-FORM, NOT THE RAW CREDS ID, and getting that wrong is a live-caught
 *  mistake rather than a hypothetical: the daemon builds its endpoint with
 *  `card.id = idFromCreds(creds)`, and the endpoint then REWRITES `card.id` to
 *  `principalKey(owner, actor).key` — `<owner>.<actor>` — which is what lands in the lease. Comparing
 *  against the bare id therefore mismatches EVERY healthy daemon, which would turn this check into
 *  the mirror of the bug it removes: a permanent false "stale" on a perfectly good mesh. A smoke cell
 *  reads the record a real holder wrote and pins the exact shape, so this cannot regress silently.
 *
 *  WHY IT MATTERS AT ALL. Without it, a `ready:true` record left by a daemon that has since died
 *  reads as health for the rest of the bucket TTL — measured against a real broker, not theorised —
 *  and a status command that exists to stop false green would print `responder bound` at a mesh that
 *  cannot spawn, retire or join. Core demands a named holder in `waitForDeliveryLease` for exactly
 *  this reason.
 *
 *  READ-ONLY AND BEST EFFORT. A workspace that never launched a daemon locally (an adopted or remote
 *  one) has no creds file, and that is not an error: the caller then does not check the holder, the
 *  same concession `waitForDeliveryLease` makes for an adopted daemon. An existing credential that
 *  cannot be read privately refuses the check rather than silently disabling holder attribution. */
export async function expectedDeliveryHolder(target: MeshTarget): Promise<string | undefined> {
  const key = deliveryCredsKey(target.space, { injected: false, root: target.root });
  const path = join(target.root, ".cotal", key);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  const exposure = stat?.isFile() ? credentialFileExposure(path, stat) : undefined;
  if (exposure) throw new CommandFailure("refused", "PERMISSION_DENIED", `${path}: ${exposure.reason}`, { remedy: exposure.remedy, target: { path, space: target.space } });
  const creds = await workspaceSecretStore(target.root).get(key);
  if (!creds) return undefined;
  // The daemon declares no owner/actor, so the endpoint falls back to DEV_OWNER for the owner and
  // to the connection id for the actor: `local.<idFromCreds>`. Built through `principalKey` rather
  // than string concatenation so this tracks the one definition of the dot-form.
  return principalKey(DEV_OWNER, idFromCreds(creds)).key;
}

/** The instance id this workspace root persisted for `space`. That is the id the manager's
 *  own status reports. Absent when this root has never registered a manager. A malformed
 *  record is not an id: status must not invent one. */
export function localManagerInstanceId(root: string, space: string): string | undefined {
  try {
    const id = loadManagerInstanceIdentity(root, space)?.instanceId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** User-mode manager status goes through the same control call `cotal spawn` uses. `instanceId`
 *  pins that call to this machine's manager. Without it, the exchange may select another live
 *  manager of the same owner. */
export async function userManagerStatus(target: MeshTarget, instanceId?: string): Promise<ManagerServiceStatus> {
  const control = await resolveControlTarget(
    { space: target.space, server: target.server },
    "control-caller-privileged",
    instanceId,
    { onRefusal: "throw" },
  );
  const reply = await askManager(
    cliControl,
    control.space,
    control.server,
    "managerStatus",
    undefined,
    control.auth,
    "owner",
    3_000,
  );
  if (reply.ok !== true) {
    const message = "error" in reply && typeof reply.error === "string" ? reply.error : "manager status refused";
    // `unavailable` stays a reachability failure, as the static probe does. Anything else, including
    // a manager that answered and refused, is a precondition. The reply's details stay on the error:
    // a real no-answer carries the unanswered marker, and dropping it would report silence as a refusal.
    const code = reply.code === "unavailable" ? "unavailable" : "failed-precondition";
    throw new EpEnvelopeError(code, message, reply.details);
  }
  if (reply.data === undefined) throw new EpEnvelopeError("unavailable", "the manager status reply carried no data");
  return reply.data as ManagerServiceStatus;
}

/** A no-responder service rail or an absent manager registry: the definitive no-service evidence
 *  that both the manager row and the manager health check grade on, kept in one place (#3046). */
export function managerNoService(e: unknown): boolean {
  return e instanceof EpEnvelopeError && (unansweredRequest(e) || isStreamNotFound(e.cause));
}

function section(name: string): void {
  console.log(`\n${c.bold(name)}`);
}

/** The distinct exit cases of the component-health pass.  A process record says that this machine
 * knows about a component; a component-owned control answer says it is actually serving.  Do not
 * flatten those questions — the manager incident was exactly a live lease holder that had not
 * reached its service rail. */
type ComponentVerdict = "serving" | "not-installed" | "not-started" | "absent" | "not-serving" | "refused";
type ComponentHealth = { name: string; verdict: ComponentVerdict; facts: string[] };

const COMPONENT_EXIT: Record<ComponentVerdict, number> = {
  serving: 0,
  // An optional component that was never installed is not a failed one.
  "not-installed": 0,
  "not-started": 0,
  absent: 1,
  "not-serving": 2,
  refused: 3,
};

/** Piped records keep one line per component. Terminal rows that do not fit put their facts below
 * the verdict, wrapping at word boundaries. Escape control characters before layout so a stored
 * reason cannot inject a new component record. */
function printComponent(component: ComponentHealth): void {
  const heading = `  ${component.name.padEnd(16)} ${component.verdict}`;
  const facts = component.facts.map(oneLine);
  const line = `${heading}${facts.length ? ` · ${facts.join(" · ")}` : ""}`;
  const width = terminalWidth(process.stdout);
  if (displayWidth(line) <= width) console.log(line);
  else {
    console.log(heading);
    for (const fact of facts)
      for (const part of wrapWords(fact, width - 4)) console.log(`    ${part}`);
  }
}

function printComponents(components: readonly ComponentHealth[], code: ErrorCode | null = null): void {
  for (const component of components) printComponent(component);
  const exit = Math.max(...components.map((component) => COMPONENT_EXIT[component.verdict]));
  if (exit !== 0) recordTelemetryFailure(exit === COMPONENT_EXIT.refused ? "refused" : "failed", code);
  process.exitCode = exit;
}

export function processRecord(template: string, context: LocalProcessContext): { kind: "absent" } | { kind: "unreadable"; error: string } | { kind: "dead"; pid: number } | { kind: "unattributable"; raw: string } | { kind: "live"; pid: number } | { kind: "unknown"; pid: number } {
  try {
    const path = localProcessPath(template, context);
    const state = pidfileState(path);
    if (state.pid === undefined) return state.liveness === "dead" ? { kind: "absent" } : { kind: "unattributable", raw: readPidfile(path) ?? "" };
    return { kind: state.liveness === "alive" ? "live" : state.liveness === "dead" ? "dead" : "unknown", pid: state.pid };
  } catch (e) {
    // An ambiguous record or any failed read refuses this component's row, never the whole pass.
    return { kind: "unreadable", error: (e as Error).message };
  }
}

function pidFacts(record: ReturnType<typeof processRecord>): string[] {
  if (record.kind === "live" || record.kind === "dead" || record.kind === "unknown") return [`pid ${record.pid}`];
  if (record.kind === "unreadable") return [`pidfile unreadable: ${record.error}`];
  return [];
}

function processVerdict(record: ReturnType<typeof processRecord>): ComponentVerdict | undefined {
  if (record.kind === "absent" || record.kind === "dead") return "absent";
  if (record.kind === "unattributable" || record.kind === "unknown" || record.kind === "unreadable") return "refused";
  return undefined;
}

/** A manager's only control claim is its service rail: a pid, a lease, or a registration is not a
 * serving answer.  The generic manager `status` command is the manager-owned health surface and is
 * deliberately called only after we establish that its local process record remains alive.
 *
 *  USER MODE (the #1832 fix): the flip forbids static-minting on a user-auth mesh, and a
 *  credential-less probe of an authenticated broker is the raw `Authorization Violation` this used
 *  to print. So a user-mode target connects as the machine's signed-in login. Delivery stays on
 *  that login. The broker row only checks that the registered address is reachable. It does not
 *  present the login. `manager.status` does not use the login either: it publishes with the
 *  manager-caller view `cotal spawn` exchanges, pinned to this machine's manager instance when a
 *  running service row names it. That view carries `status` when the actor holds `spawn`. When the
 *  login cannot be had (not signed in, service down, exchange refused), the components pass says so
 *  on the row instead of probing bare: a refused probe would be reporting the broker's answer to a
 *  question nobody asked. */
type ComponentCredential =
  | { kind: "static"; auth: SpaceAuth | undefined }
  | { kind: "user"; bearer: string; sentinelCreds: string; caller: { owner: string; actor: string; uid: string } }
  | { kind: "unavailable"; reason: string };

/** The probe credential for the components pass, per target mode. Static/open meshes keep the exact
 *  mint they had; a user-mode target gets the signed-in login's bearer, or the one-sentence reason
 *  it cannot be had. */
export async function componentCredential(target: MeshTarget): Promise<ComponentCredential> {
  if (target.mode !== "user") return { kind: "static", auth: target.auth };
  try {
    const { bearer, sentinelCreds } = await resolveAuthProvider().userCredentials({
      store: workspaceSecretStore(target.root),
      dir: userAuthStateDir(target.root, target.space),
      space: target.space,
      actor: CLI_USER_ACTOR,
    });
    const { owner, actor, lifecycleUid: uid } = principalFromBearer(bearer);
    return { kind: "user", bearer, sentinelCreds, caller: { owner, actor, uid } };
  } catch (e) {
    return { kind: "unavailable", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function componentEp(
  target: MeshTarget,
  credential: { kind: "static"; auth: SpaceAuth | undefined } | { kind: "user"; bearer: string; sentinelCreds: string },
): Promise<{ ep: CotalEndpoint; close(): Promise<void> }> {
  await requireGreeting(target);
  const id = newIdentity();
  const user = credential.kind === "user";
  // Static/open: ONE lifecycleUid minted and used both in the credential and as the endpoint's own
  // option, matching `staticServiceAuth`. Two different uids here (a fresh mint per site) is what
  // `permissionsFor: ... mint with opts.lifecycleUid` refuses: the lease read is bound to the uid
  // baked into the credential, not the one the endpoint separately declares (#2073).
  const staticUid = !user && credential.auth ? mintLifecycleUid() : undefined;
  const ep = new CotalEndpoint({
    space: target.space,
    servers: target.server,
    tls: target.tlsRequired,
    // User: the signed-in login's bearer + sentinel; no lifecycleUid mint exists on this path (the
    // bearer carries its own lifecycle claim).
    ...(user
      ? { bearer: credential.bearer, sentinelCreds: credential.sentinelCreds }
      : {
          creds: credential.auth && staticUid ? await mintCreds(credential.auth, id, "deployer", { lifecycleUid: staticUid }) : undefined,
          lifecycleUid: staticUid,
        }),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    // A bearer-source endpoint derives its id from the principal; only the minted path names one.
    card: user ? { name: "status-components", kind: "endpoint" } : { id: id.id, name: "status-components", kind: "endpoint" },
  });
  ep.on("error", () => {});
  // Same one-shot policy as renderSnapshot: the command grades the awaited service reply itself.
  const ignoreComponentWarning = () => {};
  ep.on("warning", ignoreComponentWarning);
  await ep.start();
  return { ep, close: () => ep.stop().catch(() => {}) };
}

/** Refuse before a probe dials a broker that does not greet on a socket this check owns. A broker
 *  that takes the connection and never greets, as a stopped one does, leaves the dial's socket open
 *  after its timeout, because the client library does not release a connection it never finished,
 *  and status could then never exit. */
async function requireGreeting(target: MeshTarget): Promise<void> {
  const stopped = stoppedLoopbackListener(target.server);
  if (stopped !== undefined) throw new Error(hasNonNatsExecutable(stopped) ? `stopped process ${stopped} holds the broker address and is not a NATS server` : `the broker at ${brokerAddressForDisplay(target.server) ?? "an invalid broker address"} is served by process ${stopped}, which is stopped`);
  if (!(await isReachable(target.server, { ...(target.tlsRequired ? { tls: true } : {}), timeoutMs: 3_000 })))
    throw new Error(`the broker at ${brokerAddressForDisplay(target.server) ?? "an invalid broker address"} is not answering`);
}

/** The static arm's one-shot service instrument, unchanged from before the user-mode fix: a fresh
 *  identity, its minted deployer credential, and the caller triple on the SAME identity — a
 *  mismatched random actor would turn an authorized manager into a false no-answer. */
export async function staticServiceAuth(auth: SpaceAuth | undefined): Promise<{ creds?: string; caller: { owner: string; actor: string; uid: string } }> {
  const serviceIdentity = newIdentity();
  const serviceUid = mintLifecycleUid();
  return {
    creds: auth ? await mintCreds(auth, serviceIdentity, "deployer", { lifecycleUid: serviceUid }) : undefined,
    caller: { owner: "local", actor: serviceIdentity.id, uid: serviceUid },
  };
}

/** The fields of a manager `status` answer that its component row reads. */
export type ManagerServiceStatus = {
  instanceId?: unknown;
  runtime?: unknown;
  stopImpact?: unknown;
  staticReconciliation?: {
    state?: unknown;
    lastSweep?: { error?: unknown };
    failures?: Array<{ alias?: unknown; phase?: unknown; disposition?: unknown; nextRetryAt?: unknown; remedy?: unknown }>;
  };
};

/** A service registration is the health target itself.  Calling its `status` command through a
 * generic endpoint does not work on this base because a passive status endpoint has no v0.4 caller
 * rail; a one-shot standalone caller does. */
export async function managerServiceHealth(
  target: MeshTarget,
  auth: ({ creds?: string } | { bearer: string; sentinelCreds: string }) & { caller: { owner: string; actor: string; uid: string } },
): Promise<ManagerServiceStatus> {
  await requireGreeting(target);
  const nc = await dialerFor(target.server)({
    servers: target.server,
    ...standaloneConnectOpts(
      "bearer" in auth
        ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds, tls: target.tlsRequired }
        : auth.creds
          ? { creds: auth.creds, tls: target.tlsRequired }
          : { tls: target.tlsRequired },
    ),
    maxReconnectAttempts: 0,
  });
  try {
    const service = await resolveService(nc, target.space, "manager", auth.caller, { deadlineMs: 3_000, commands: ["status"] });
    const response = await invokeRepairingSplit(nc, target.space, service, "status", undefined, { deadlineMs: 3_000 });
    if (response.reply.ok !== true)
      throw new EpEnvelopeError(response.reply.error.code === "unavailable" ? "unavailable" : "failed-precondition", response.reply.error.message);
    return response.reply.data as ManagerServiceStatus;
  } finally {
    await drainAndClose(nc);
  }
}

async function managerHealth(target: MeshTarget, context: LocalProcessContext, credential: ComponentCredential, broker: ComponentHealth): Promise<ComponentHealth> {
  const record = processRecord(MANAGER_PIDFILE, context);
  const facts = pidFacts(record);
  // A corrupt or kernel-unreadable LOCAL record is neither evidence that the manager is absent nor
  // permission to replace it with a network answer.  Name that failed local control surface first.
  if (processVerdict(record) === "refused") {
    if (record.kind === "unattributable") facts.push("unattributable pidfile");
    if (record.kind === "unknown") facts.push("pid liveness unestablishable");
    return { name: "manager", verdict: "refused", facts };
  }
  if (record.kind === "dead") facts.push("stale pidfile");

  let close: (() => Promise<void>) | undefined;
  try {
    if (credential.kind === "unavailable") {
      // USER MODE without a usable login credential: say what is missing instead of probing bare.
      // A bare probe of an authenticated broker reports an Authorization Violation that describes
      // our own missing credential, not the manager's health. `refused` (not absent): the pass
      // could not read this component's control surface, which is exactly what that verdict means.
      facts.push(`probe needs the signed-in login: ${credential.reason}`);
      return { name: "manager", verdict: "refused", facts };
    }
    const component = await componentEp(target, credential);
    close = component.close;
    // The lease sweep needs manager-bucket STREAM.INFO rows an interactive ledger bearer does not
    // hold (provision.ts grants those to the manager/supervisor credentials only; the agent-view
    // comment in core says exactly this). In user mode the SERVICE probe is the whole verdict, so
    // the row says the lease axis is not checkable rather than reporting a refusal the broker
    // makes about our own credential's shape.
    let lease: Awaited<ReturnType<CotalEndpoint["readManagerLease"]>> | undefined;
    if (credential.kind === "user") {
      facts.push("lease not checkable as the signed-in login (manager-bucket read is a host credential)");
    } else {
      lease = await component.ep.readManagerLease();
      if (lease) facts.push(`lease holder ${lease.holder}`, `lease pid ${lease.pid}`);
      else facts.push("lease absent");
    }
    // Static/open keeps the one-shot instrument on the same identity as its caller triple.
    // User mode calls manager status through the same control path `cotal spawn` uses.
    // The login bearer does not carry that command for a spawn holder.
    // Pin only while this machine's manager process is live. With no live process, an
    // unpinned answer is this row's own verdict and the facts below name its instance.
    const liveLocal = record.kind === "live";
    const localId = credential.kind === "user" && liveLocal ? localManagerInstanceId(context.root, target.space) : undefined;
    const served = credential.kind === "user"
      ? await userManagerStatus(target, liveLocal ? localId : undefined)
      : await managerServiceHealth(target, await staticServiceAuth(credential.auth));
    // A live local process is serving only when its persisted instance answered. An unknown
    // id, or a different one, cannot be attributed: refused, not not-serving, and the remote
    // runtime stays off this row. The facts name the instance that answered.
    if (credential.kind === "user" && liveLocal && (localId === undefined || served.instanceId !== localId)) {
      const answered = typeof served.instanceId === "string" && served.instanceId.length > 0 ? served.instanceId : undefined;
      facts.push(answered === undefined
        ? "the manager answer named no instance, so it is not this machine's manager"
        : localId === undefined
          ? `answered by manager instance ${answered}; this machine's manager instance is not known`
          : `answered by manager instance ${answered}, not this machine's manager ${localId}`);
      return { name: "manager", verdict: "refused", facts };
    }
    facts.push(`service instance ${served.instanceId ?? "unreported"}`);
    facts.push(`runtime ${served.runtime ?? "unreported"}`);
    facts.push(...managerStopImpactFacts(served.stopImpact));
    const reconcile = served.staticReconciliation;
    if (!reconcile) {
      facts.push("static reconciliation not reported by this manager build");
    } else {
      facts.push(`static reconciliation ${String(reconcile.state ?? "unreported")}`);
      if (typeof reconcile.lastSweep?.error === "string") facts.push(`static sweep error=${reconcile.lastSweep.error}`);
      for (const failure of reconcile.failures ?? []) {
        const next = typeof failure.nextRetryAt === "string" ? ` nextRetryAt=${failure.nextRetryAt}` : "";
        const remedy = typeof failure.remedy === "string" ? ` remedy=${failure.remedy}` : "";
        facts.push(`static alias=${String(failure.alias ?? "unreported")} phase=${String(failure.phase ?? "unreported")} disposition=${String(failure.disposition ?? "unreported")}${next}${remedy}`);
      }
    }
    facts.push("serve reachable");
    // A manager service without its own liveness lease is a contradicted component surface, not a
    // healthy one. It still reports reachability, but cannot claim the required lease holder. In
    // USER MODE neither local axis is checkable from a participant machine (no pidfile under a
    // discovered root, no manager-bucket read), so the manager's own typed service answer carries
    // the verdict alone — reaching this line means it answered, which is the same single answer
    // `ps` grades a user-mode manager by.
    return { name: "manager", verdict: lease || credential.kind === "user" ? "serving" : "not-serving", facts };
  } catch (e) {
    // A no-responder service rail or an absent manager registry is definitive no-service evidence.
    // A dead local PID is absent even while its lease awaits expiry. Without a PID record, the
    // lease still identifies an extant component; any other failed probe remains a refusal.
    const noService = managerNoService(e);
    facts.push(noService ? "serve no answer" : `serve probe refused: ${(e as Error).message}`);
    if (broker.verdict === "absent" && processVerdict(record) === "absent") return { name: "manager", verdict: "absent", facts };
    if (!noService) return { name: "manager", verdict: "refused", facts };
    const liveRecord = record.kind === "live";
    const hasLease = facts.some((fact) => fact.startsWith("lease holder "));
    if (!liveRecord && !hasLease) {
      try {
        const journal = readStackJournal(context.root)?.journal;
        const pin = verifyIdentityPin(localProcessPath(MANAGER_OMITTED, context));
        const brokerRecord = processRecord(NATS_PIDFILE, context);
        const omitted = journal?.space === context.space ? stackStartedWithoutManager(journal)
          : pin.kind === "match" && brokerRecord.kind === "live" && pin.record.pid === brokerRecord.pid;
        if (omitted) return { name: "manager", verdict: "not-started", facts: [...facts, "started with --no-manager"] };
      } catch (error) {
        return { name: "manager", verdict: "refused", facts: [...facts, `startup intent unreadable: ${(error as Error).message}`] };
      }
    }
    return { name: "manager", verdict: liveRecord || (record.kind !== "dead" && hasLease) ? "not-serving" : "absent", facts };
  } finally {
    await close?.();
  }
}

/** True when a delivery-lease read failed because the lease stream/bucket is absent (#3046). */
export function deliveryLeaseAbsent(e: unknown): boolean {
  return isStreamNotFound(e);
}

/** Delivery owns two answers: its ready lease is its liveness/control surface; its latest explicit
 * adoption report is the renewal record it writes through the manager-owned renewal pass.  The
 * latter is intentionally not inferred from credential mtime or process output. */
async function deliveryHealth(target: MeshTarget, context: LocalProcessContext, credential: ComponentCredential, brokerOffline: boolean): Promise<ComponentHealth> {
  const record = processRecord(DELIVERY_PIDFILE, context);
  const facts = pidFacts(record);
  const stopped = processVerdict(record);
  // The renewal record is PER-SPACE (#1850): read THIS space's record through the workspace seam
  // (`renewalRecordPath` — the same keyed spelling the pidfiles use), never a hand-composed
  // root-only path: a co-resident space's pass must not color this row.
  let renewal: { adoption?: { ok: boolean; error?: string } } | undefined;
  try {
    renewal = readRenewalRecord(context.root, context.space) as { adoption?: { ok: boolean; error?: string } } | undefined;
  } catch (e) {
    facts.push(`renewal record unreadable: ${(e as Error).message}`);
    return { name: "delivery", verdict: "refused", facts };
  }
  if (renewal?.adoption === undefined) facts.push("renewal adoption not reported");
  else facts.push(renewal.adoption.ok ? "renewal adoption accepted" : `renewal adoption refused${renewal.adoption.error ? `: ${renewal.adoption.error}` : ""}`);
  const renewalRefused = renewal?.adoption?.ok === false;
  if (target.mode === "open" && record.kind === "absent" && !renewalRefused) {
    if (brokerOffline) return { name: "delivery", verdict: "not-started", facts: ["not used on an open mesh"] };
    if (credential.kind === "unavailable") return { name: "delivery", verdict: "refused", facts: [credential.reason] };
    try {
      const component = await componentEp(target, credential);
      try {
        if (!await component.ep.readDeliveryLease(0)) return { name: "delivery", verdict: "not-started", facts: ["not used on an open mesh"] };
      } finally { await component.close(); }
    } catch (error) {
      if (deliveryLeaseAbsent(error)) return { name: "delivery", verdict: "not-started", facts: ["not used on an open mesh"] };
      return { name: "delivery", verdict: "refused", facts: [`lease probe refused: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }
  if (stopped) {
    if (record.kind === "dead") facts.push("stale pidfile");
    if (record.kind === "unattributable") facts.push("unattributable pidfile");
    if (record.kind === "unknown") facts.push("pid liveness unestablishable");
    return { name: "delivery", verdict: renewalRefused ? "refused" : stopped, facts };
  }

  let close: (() => Promise<void>) | undefined;
  try {
    if (credential.kind === "unavailable") {
      // Same user-mode discipline as the manager row: never probe an authenticated broker bare.
      facts.push("lease probe needs the signed-in login");
      facts.push(credential.reason);
      return { name: "delivery", verdict: "refused", facts };
    }
    const component = await componentEp(target, credential);
    close = component.close;
    const lease = await component.ep.readDeliveryLease(0);
    // ONE classifier for both surfaces (#1576). `--components` was already right here and bare
    // status was not, which is exactly how the two came to disagree about a mesh's health; routing
    // both through `deliveryResponderFromLease` means a future change cannot fix one and leave the
    // other green. The facts below stay as specific as they were.
    //
    // THE HOLDER IS PART OF THE QUESTION (#837). This surface already PRINTED `lease holder …` as a
    // fact while grading on `ready` alone, so it displayed the evidence that its own verdict was
    // wrong and did not read it. A ready record belonging to a daemon that is gone keeps this row
    // `serving` for the rest of the bucket TTL.
    const state = deliveryResponderFromLease(lease, await expectedDeliveryHolder(target));
    if (!lease) {
      facts.push("ready lease absent", `responder not bound - ${RESPONDER_UNBOUND_CONSEQUENCE}`);
      return { name: "delivery", verdict: renewalRefused ? "refused" : "not-serving", facts };
    }
    facts.push(`lease holder ${lease.holder}`);
    if (state === "stale") {
      // Name WHOSE record it is against whom we expected, because this is the one verdict an
      // operator cannot derive from the other facts on the line.
      facts.push("ready, but held by a DIFFERENT daemon than this workspace launched (a dead holder's record expires on its own)");
      facts.push(`responder not bound - ${RESPONDER_UNBOUND_CONSEQUENCE}`);
      return { name: "delivery", verdict: renewalRefused ? "refused" : "not-serving", facts };
    }
    facts.push(state === "bound" ? "ready" : "starting (lease not ready)");
    if (state !== "bound") facts.push(`responder not bound - ${RESPONDER_UNBOUND_CONSEQUENCE}`);
    return { name: "delivery", verdict: renewalRefused ? "refused" : state === "bound" ? "serving" : "not-serving", facts };
  } catch (e) {
    // A live recorded daemon with no delivery lease bucket cannot be serving this build's delivery
    // control surface.  A denied/timed-out read is different: it is a refusal and must never read
    // as a clean absence.
    const noLeaseSurface = deliveryLeaseAbsent(e);
    const msg = e instanceof Error ? e.message : String(e);
    facts.push(noLeaseSurface ? "ready lease absent" : `lease probe refused: ${msg}`);
    if (isCommandFailure(e) && e.remedy) facts.push(e.remedy);
    return { name: "delivery", verdict: renewalRefused || !noLeaseSurface ? "refused" : "not-serving", facts };
  } finally {
    await close?.();
  }
}

/** The web dashboard owns the HTTP listener and identifies itself through `/api/meta`, including
 * the serving PID.  A raw TCP success is insufficient: another program could own its port. */
async function webHealth(context: LocalProcessContext): Promise<ComponentHealth> {
  const record = processRecord(WEB_PIDFILE, context);
  const facts = pidFacts(record);
  const stopped = processVerdict(record);
  if (record.kind === "absent") {
    try {
      const unsettled = serviceInstances(context.space, "web").map(instanceProjection).find((row) => row.recordedState !== "stopped" && ["gone", "foreign-pid", "previous-boot"].includes(row.observedProcess));
      if (unsettled) return { name: "web", verdict: "absent", facts: [`service instance ${unsettled.instanceId}`, `recorded ${unsettled.recordedState}`, unsettled.observedProcess] };
    } catch (e) {
      return { name: "web", verdict: "refused", facts: [`service instance records unreadable: ${(e as Error).message}`] };
    }
    // An installation that cannot be read keeps the absent verdict rather than a clean zero.
    let installed: boolean | undefined;
    try { installed = webInstalled(); } catch { installed = undefined; }
    if (installed === false) return { name: "web", verdict: "not-installed", facts: ["optional"] };
    if (installed === true) return { name: "web", verdict: "not-started", facts: ["optional"] };
  }
  if (stopped) {
    if (record.kind === "dead") facts.push("stale pidfile");
    if (record.kind === "unattributable") facts.push("unattributable pidfile");
    if (record.kind === "unknown") facts.push("pid liveness unestablishable");
    return { name: "web", verdict: stopped, facts };
  }
  // Probe only the address the dashboard recorded once it was listening, never one guessed from its
  // command line or a default: no argv names the port `--port 0` bound. Without that record the
  // control surface cannot be located, which is a probe refusal rather than a not-serving answer.
  if (record.kind !== "live") throw new Error("web component record lost its live pid after classification");
  const pid = record.pid;
  let source: ReturnType<typeof webSessionSource>;
  try {
    source = webSessionSource(context, pid);
  } catch (e) {
    return { name: "web", verdict: "refused", facts: [...facts, `service instance records unreadable: ${(e as Error).message}`] };
  }
  if (source.instance !== undefined) facts.push(`service instance ${source.instance}`);
  let bound: ReturnType<typeof webBoundAddress>;
  try {
    bound = webBoundAddress(source.path);
  } catch (e) {
    return { name: "web", verdict: "refused", facts: [...facts, `${source.label} unreadable: ${(e as Error).message}`] };
  }
  if (!bound) return { name: "web", verdict: "refused", facts: [...facts, "probe refused (no bound address recorded)"] };
  try {
    // The dashboard refuses an anonymous `/api/meta`; the readiness nonce is the one credential its
    // gate accepts there, so without it a live dashboard could only ever answer 401.
    const { status, meta } = await probeWebReadiness(bound.url, bound.readiness);
    if (meta?.pid === pid) return { name: "web", verdict: "serving", facts: [...facts, `host ${bound.host}`, `port ${bound.port}`, "http reachable"] };
    return { name: "web", verdict: "not-serving", facts: [...facts, `host ${bound.host}`, `port ${bound.port}`, meta === undefined ? `HTTP ${status}` : "http identity mismatch"] };
  } catch {
    // If the recorded address cannot identify the recorded PID, this component is present but not
    // serving.
  }
  return { name: "web", verdict: "not-serving", facts: [...facts, `host ${bound.host}`, `port ${bound.port}`, "http not answered"] };
}

async function brokerHealth(target: MeshTarget, store: StoreWriteObservation | undefined): Promise<ComponentHealth> {
  const address = brokerAddressForDisplay(target.server);
  if (address === undefined)
    return { name: "broker", verdict: "refused", facts: ["registered address unavailable", "invalid broker address"] };
  try {
    const context = { root: target.root, space: target.space };
    const journal = readStackJournal(target.root)?.journal;
    const serverKey = brokerUrlKey(target.server);
    if (journal?.space === target.space && brokerUrlKey(journal.server) === serverKey) {
      const member = journal.members.find((row) => row.role === "broker");
      const instance = serviceInstances(target.space, STACK_DEFINITION.broker).find((row) => row.name === member?.instanceId);
      const observed = instance && instanceProjection(instance).observedProcess;
      if (!instance || observed && ["gone", "foreign-pid", "previous-boot"].includes(observed))
        return { name: "broker", verdict: "absent", facts: [`registered ${address}`, observed ?? "no local instance"] };
      if (observed !== "running") return { name: "broker", verdict: "refused", facts: [`registered ${address}`, `local process ${observed}`] };
    } else if (target.origin === "up" && target.mode !== "user" && (target.recordedServer === undefined || brokerUrlKey(target.recordedServer) === serverKey)) {
      const record = processRecord(NATS_PIDFILE, context);
      const verdict = processVerdict(record);
      if (verdict) return { name: "broker", verdict, facts: [`registered ${address}`, ...pidFacts(record), ...(record.kind === "dead" ? ["stale pidfile"] : [])] };
    }
    const storeFailure = store?.state === "write-failed" ? `store write failed: ${store.cause}`
      : store?.state === "full" ? `store full: ${store.used} bytes exceeds ${store.cap} bytes at ${store.path}` : undefined;
    if (target.mode !== "user") {
      const preflight = await preflightTarget(target);
      if (!preflight.ok) return { name: "broker", verdict: "not-serving", facts: [`registered ${address}`, workspaceErrorParts({ kind: "preflight", failure: preflight.kind, target, pruned: false, ...(preflight.pid === undefined ? {} : { pid: preflight.pid }) }).message] };
      return { name: "broker", verdict: storeFailure ? "not-serving" : "serving", facts: [`registered ${address}`, "reachable", ...(storeFailure ? [storeFailure] : [])] };
    }
    const reachable = await isReachable(target.server, target.tlsRequired ? { tls: true } : {});
    if (storeFailure)
      return { name: "broker", verdict: "not-serving", facts: [`registered ${address}`, reachable ? "reachable" : "unreachable", storeFailure] };
    return reachable
      ? { name: "broker", verdict: "serving", facts: [`registered ${address}`, "reachable"] }
      : { name: "broker", verdict: "not-serving", facts: [`registered ${address}`, "unreachable"] };
  } catch (e) {
    return { name: "broker", verdict: "refused", facts: [`registered ${address}`, `probe refused: ${(e as Error).message}`] };
  }
}

function movedStackComponent(name: string, facts: string[] = []): ComponentHealth {
  return { name, verdict: "refused", facts: [...facts, "stack health cannot be checked at the recorded project folder"] };
}

/** The listener can answer even when the original folder's health evidence is unavailable. */
function movedStackBrokerHealth(target: MeshTarget, meshes: StatusResult["meshes"]): ComponentHealth {
  const address = brokerAddressForDisplay(target.server);
  const reachable = meshes.items.some((mesh) => mesh.space === target.space && mesh.server === address && mesh.check === "reachable");
  return movedStackComponent("broker", [
    ...(address === undefined ? [] : [`registered ${address}`]), ...(reachable ? ["reachable"] : []),
  ]);
}

/** An implicit target can find the displaced records without resolving a mesh to probe. */
async function movedStackTargetHealth(report: SelectedResult, meshes: StatusResult["meshes"], server: string | undefined): Promise<ComponentHealth | undefined> {
  if (report.resolved || !report.space || !report.recordedRoot || !server) return undefined;
  const address = brokerAddressForDisplay(server);
  const registered = meshes.items.find((mesh) => mesh.space === report.space && mesh.root === report.recordedRoot
    && mesh.origin === "up" && (mesh.mode === "auth" || mesh.mode === "open") && mesh.server === address);
  if (!address || !registered || !stackRootGone(registered.space, registered.root)) return undefined;
  const reachable = registered.check === "reachable" || await isReachable(server, registered.tlsRequired ? { tls: true } : {});
  return movedStackComponent("target", [`registered ${address}`, ...(reachable ? ["reachable"] : [])]);
}

export async function printComponentHealth(selected: Selected, store: StoreWriteObservation | undefined, report: SelectedResult, meshes: StatusResult["meshes"], selectedHint: string | undefined, starting?: string, recoveryBroker?: number): Promise<void> {
  section("Component Health");
  if (recoveryBroker !== undefined && !report.resolved)
    return printComponents([{ name: "target", verdict: "refused", facts: ["service health cannot be checked", report.message, `pid ${recoveryBroker}`, ...(selectedHint === undefined ? [] : [selectedHint])] }]);
  if (!selected.ok) {
    const e = selected.error;
    const journal = isWorkspaceTargetError(e) && e.code === "not-started" && e.details.root !== undefined && !e.details.rootMissing
      ? unusableStackJournal(e.details.root) : undefined;
    const refusal = journal ?? (isCommandFailure(e) && (e.code === "SCHEMA_INVALID" || e.code === "PERMISSION_DENIED") ? e : undefined);
    if (refusal)
      return printComponents([{ name: "target", verdict: "refused", facts: [refusal.code, refusal.message, ...(refusal.remedy ? [refusal.remedy] : [])] }], refusal.code);
    if (isMeshRegistryError(e))
      return printComponents([{ name: "target", verdict: "refused", facts: ["SCHEMA_INVALID", e.message] }], "SCHEMA_INVALID");
    if (isWorkspaceTargetError(e)) {
      const moved = e.code === "not-started" ? await movedStackTargetHealth(report, meshes, e.details.server) : undefined;
      if (moved) {
        const { message, remedy } = workspaceErrorParts({ kind: "target", error: e });
        return printComponents([{ ...moved, facts: [...moved.facts, remedy === undefined ? message : `${message} - ${displayRemedy(remedy)}`] }]);
      }
      const verdict = e.code === "not-started" ? "absent" : "refused";
      const { message, remedy } = workspaceErrorParts({ kind: "target", error: e });
      const step = verdict === "absent" ? selectedHint : remedy === undefined ? undefined : displayRemedy(remedy);
      return printComponents([{ name: "target", verdict, facts: [e.code, starting ?? (report.channelSeedBlocksRestart || step === undefined || step === message ? message : `${message} - ${step}`)] }]);
    }
    if (e instanceof UnregisteredRoot)
      return printComponents([{ name: "target", verdict: "refused", facts: ["unregistered-root", `no space is registered or prepared here for ${e.root}`] }]);
    throw e;
  }
  const target = selected.target;
  const context: LocalProcessContext = { root: target.root, space: target.space, userAuth: target.mode === "user" };
  if (target.mode === "auth" && (report.resolved ? report.connection === "root-gone" : report.code === "moved-folder") && target.source !== "flag-space-override") {
    return printComponents([movedStackComponent("manager"), movedStackComponent("delivery"), await webHealth(context), movedStackBrokerHealth(target, meshes)]);
  }
  // ONE credential read for the whole pass (user mode resolves the signed-in login once; the
  // static shape is just the target's own auth material), shared by the manager and delivery
  // probes so the two rows cannot disagree about whose credential they probed with.
  const credential = await componentCredential(target);
  const broker = target.mode === "open" && report.resolved && report.connection === "root-gone"
    ? movedStackBrokerHealth(target, meshes) : await brokerHealth(target, store);
  const components = await Promise.all([
    managerHealth(target, context, credential, broker),
    deliveryHealth(target, context, credential, report.resolved && report.connection === "unreachable" && broker.verdict === "absent"),
    webHealth(context),
    broker,
  ]);
  printComponents(components);
}

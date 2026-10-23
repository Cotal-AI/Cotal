/** Controller-owned whole-stack startup: broker first, then native stream setup, the auth service
 *  for a user stack, the delivery credential and delivery, then the manager. An open stack has no
 *  delivery member and mints no credential: its broker serves the prepared open configuration and
 *  its manager reports through the child's own local receipt. A user stack's manager needs the
 *  invoking user's existing login and grant; without it the manager is not attempted and the result
 *  is a known `AUTH_REQUIRED` partial. Every member is a saved root-bound definition and an
 *  exact service-controller instance. Trust and the broker configuration are prepared explicitly
 *  here, outside any adapter plan. A failure after the first effect is reported as partial or
 *  unknown with the members it changed; nothing already started is rolled back. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { JetStreamApiError } from "@nats-io/jetstream";
import { awaitDeadDeliveryLease, deliveryLeaseHolderFor, isReachable, LEASE_TTL_MS, mintCreds, newIdentity, type BrokerTransport, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, accountInventory, authDir, canonicalRoot, deliveryCredsKey, findMesh, findPreparedSpace, getSpaceAuth, hasUserAuthState,
  homeCotalDir, isCommandFailure, localMeshesForRoot, presentationOf, readMaintenanceJournal, renderReport, resolveNativeServiceTarget, resolveOnPath,
  stackHomeRemedy, stackRunsUnderOtherHome, terminalWidth, workspaceSecretStore, writeResult, type MaintenanceLock, type OutputWarning, type Report, type ServiceDefinitionInput, type UserAuthInfo,
} from "@cotal-ai/workspace";
import { liveMeshProcesses } from "./clean.js";
import { brokerListenAddress } from "../lib/broker-service.js";
import { seedDefaultPersona } from "../lib/default-persona.js";
import { serviceDefinitionStore, validateServiceDefinition, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { instanceProjection, observeServiceProcess, serviceInstances } from "../lib/service-instances.js";
import { prepareProcessService, removeStoppedInstanceRecords, settleExitedInstances, startProcessService } from "../lib/service-process.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { foreignLocalProcesses, newStackOperation, readStackJournal, settleRetainedStackStops, settleStackOperation, stackMaintenanceFence, stackNeverStarted, stackOperationUnsettled, stackSettlementNotice, STACK_ADAPTER, STACK_DEFINITION, STACK_ROLES, stackRoleApplies, withSettledMembers, writeStackJournal, type StackJournal, type StackJournalSnapshot, type StackMember, type StackMode, type StackRole, type StackSettlement } from "../lib/stack-journal.js";
import { assertUserStackTransport, confirmUserAuthEndpoints, preflightUserStack, provisionalUserAuth, userLoginRequired, userLoginState, userRegistrationIncomplete, type StackUserPrepared } from "./stack-user-auth.js";

/** Callbacks into the native broker preparation that `up.ts` owns. They hold private authority
 *  material and are passed in, so this module never re-derives trust or a transport decision. */
export interface StackUpNative {
  /** `userAuth` asks the native `authSetup` user arm (`prepareServer`) and must return its private
   *  `user` material; any other mode must return none. */
  prepareBroker(opts: { transport: BrokerTransport; server: string; space: string; open: boolean; userAuth?: { idpUrl?: string }; host?: string; storeDir?: string; existingStore?: ExistingStorePin; maxFileStore?: number; channels?: string; seed?: unknown }): Promise<{ root: string; server: string; space: string; storeDir: string; transport: BrokerTransport; setup?: { creds: string; wsPort: number }; user?: StackUserPrepared; confPath: string; bin: string; seedFile?: unknown }>;
  initializeStreams(server: string, space: string, setup: { creds: string } | undefined, seedFile: unknown): Promise<void>;
  recordMesh(entry: { space: string; server: string; root: string; mode: StackMode; tlsRequired: boolean; storeDir: string; userAuth?: UserAuthInfo; maxSessions?: number; attachHost?: string; maxFileStore?: number }): void;
  commitTransport(root: string, transport: BrokerTransport): void;
}

/** The identity of an existing broker store that a start must reuse and never create. */
export interface ExistingStorePin { named: string; path: string; dev: string; ino: string; birthtimeNs: string }

/** Pin a named store that must already exist as a real directory, refusing a missing path, a
 *  non-directory and a symlink. The pin and its rechecks narrow the window in which another local
 *  process can replace the path. They cannot close it: neither Node nor nats-server opens a
 *  directory by identity, and the last recheck still precedes the broker's own open. */
export function pinExistingStore(named: string, target: Record<string, unknown>): ExistingStorePin {
  let pin: ExistingStorePin | undefined;
  try {
    const link = lstatSync(named, { bigint: true });
    if (link.isDirectory() && !link.isSymbolicLink()) {
      const path = realpathSync.native(named), stat = lstatSync(path, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === link.dev && stat.ino === link.ino)
        pin = { named, path, dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
    }
  } catch { pin = undefined; }
  if (!pin) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the named broker store is not an existing real directory; no store was created and nothing was prepared", { target: { ...target, storeDir: named } });
  return pin;
}

/** Check a pinned store again: the named path must still resolve to the pinned directory. A missing,
 *  replaced or relinked store refuses. */
export function recheckExistingStore(pin: ExistingStorePin, target: Record<string, unknown>): void {
  let stat;
  try {
    const link = lstatSync(pin.named, { bigint: true });
    stat = link.isDirectory() && !link.isSymbolicLink() && realpathSync.native(pin.named) === pin.path ? lstatSync(pin.path, { bigint: true }) : undefined;
  } catch { stat = undefined; }
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== pin.dev || stat.ino.toString() !== pin.ino || stat.birthtimeNs.toString() !== pin.birthtimeNs)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the named broker store disappeared, was replaced or became a link after it was checked; no store was created and the broker was not started", { target: { ...target, storeDir: pin.named } });
}

export interface StackUpRequest {
  /** The root maintenance lock the caller holds for this whole start. Holding it proves no other
   *  whole-stack operation is in flight, which is what lets an unsettled earlier one be settled. */
  maintenanceLock: MaintenanceLock;
  root: string;
  space: string;
  server: string;
  transport: BrokerTransport;
  runtime: string;
  noManager: boolean;
  /** An explicitly requested mode. Omitted keeps the journal's pinned mode, or static auth. */
  mode?: StackMode;
  /** The IdP a first user-auth enable pins (`--idp`); refused outside user mode. */
  idp?: string;
  host?: string;
  storeDir?: string;
  maxFileStore?: number;
  maxSessions?: number;
  channels?: string;
  foreground: boolean;
  presentation: ReturnType<typeof presentationOf>;
  /** A fresh team boot's frozen manifest inputs. `seed` replaces `channels` for the broker's native
   *  channel registry seed. `launchSpec` runs once, after broker (and user auth-service)
   *  preparation and immediately before the manager member is defined, and returns the private
   *  native launch spec the manager service pins by digest. It is never called for a reused manager. */
  manifest?: {
    /** The boot's own retained fresh intent, which is unsettled by design until its summary. Only
     *  this exact ID is exempt from the unsettled-attempt refusal; every other one still refuses. */
    deploymentId: string;
    seed: unknown;
    launchSpec(context: { root: string; space: string; server: string; mode: StackMode; user?: StackUserPrepared }): Promise<{ path: string; sha256: string }>;
  };
  /** Compare-and-swap binding for a team boot that resumes an exact stopped stack: the journal bytes
   *  read by its eligibility gate under the same maintenance lock. Any change before this call's
   *  own read refuses; nothing is re-planned from different records. */
  expectPriorDown?: { journalSha256: string; operationId: string };
}

/** The domain outcome of a successful whole-stack start, for a caller that renders its own receipt.
 *  Every refusal, partial or unknown outcome is still thrown as a classified failure. */
export interface StackUpResult {
  journal: StackJournal;
  changed: unknown[];
  allReused: boolean;
  /** The manager's pinned launch spec, when this call defined one. */
  launch?: { path: string; sha256: string };
  /** A settled active restore of this stack that its retained journal did not fence. */
  admittedRestore?: string;
  /** An earlier operation with no recorded outcome that this call settled before it started. */
  settled?: StackSettlement;
}

/** Inputs that name a legacy-only startup refuse on the controller route. They are not dropped. */
const CONTROLLER_UNSUPPORTED = ["file", "dry-run", "restore", "restore-only", "accept-missing-source", "accept-stale-checkpoint", "rotate-sys", "exchange-public-port", "exchange-public-url", "exchange-trusted-proxy", "advertised-server", "agent-provisioning-url", "tls-cert", "tls-key"] as const;

/** Any account record, readable or not, means the root carries static trust an open stack would bypass. */
function holdsBrokerAccount(root: string): boolean {
  const inventory = accountInventory(authDir(root));
  return inventory.spaces.length > 0 || inventory.corrupt.length > 0;
}

/** The mode an invocation explicitly asks for, or none for a bare `up`. */
export function requestedStackMode(values: ParsedArgs["values"]): StackMode | undefined {
  return values["user-auth"] === true ? "user" : values.open === true ? "open" : undefined;
}

/** A root takes the controller route when it already has a stack journal, or when it is a fresh,
 *  prepared root with nothing legacy, maintenance or team-owned retained under it and the
 *  invocation names only controller-supported inputs. A static-auth request needs an `up`
 *  registration in auth mode or none. An `--open` request needs an open registration or none, and
 *  a root that holds no broker account. A prepared user-auth root uses the same controller with
 *  its native auth service. Anything else keeps the retained path. */
export function controllerStackApplies(root: string, space: string, values: ParsedArgs["values"]): boolean {
  const canonical = canonicalRoot(root);
  const recorded = readStackJournal(canonical);
  const requested = requestedStackMode(values);
  const unsupportedNow = (name: string) => values[name] !== undefined && values[name] !== false && (CONTROLLER_UNSUPPORTED as readonly string[]).includes(name);
  if (recorded) {
    const unsupported = CONTROLLER_UNSUPPORTED.filter(unsupportedNow);
    if (unsupported.length) throw new CommandFailure("refused", "UNSUPPORTED", "this root's stack is owned by the service controller; the requested startup option has no controller-owned route and was not applied through the legacy launcher", { target: { root: canonical, options: unsupported } });
    if (requested !== undefined && requested !== recorded.journal.mode) throw new CommandFailure("refused", "CONFLICT", `this root's controller stack is pinned to ${recorded.journal.mode === "open" ? "open" : recorded.journal.mode === "user" ? "user auth" : "static auth"}; the requested mode does not convert it`, { target: { root: canonical, recorded: recorded.journal.mode, requested }, remedy: "run bare cotal up to keep the recorded mode" });
    if (values.idp !== undefined && recorded.journal.mode !== "user") throw new CommandFailure("refused", "USAGE_INVALID", "--idp belongs to a user-auth stack", { target: { root: canonical } });
    return true;
  }
  if (CONTROLLER_UNSUPPORTED.some(unsupportedNow)) return false;
  const wanted: StackMode = requested ?? "auth";
  if (canonical === canonicalRoot(homedir()) || wanted !== "user" && hasUserAuthState(canonical, space, { readOnly: true })) return false;
  if (wanted === "open" && holdsBrokerAccount(canonical)) return false;
  const registered = findMesh(space);
  if (registered && (registered.origin !== "up" || canonicalRoot(registered.root) !== canonical || registered.mode !== wanted)) return false;
  // Only a space prepared at this very root qualifies. An absent prepared record is not a root: an
  // empty path would canonicalize to the working directory and admit an unprepared legacy folder.
  const prepared = findPreparedSpace(space);
  if (!registered && (!prepared || canonicalRoot(prepared.root) !== canonical)) return false;
  if (readMaintenanceJournal(canonical)) return false;
  if (existsSync(join(canonical, ".cotal", "nats.pid")) || liveMeshProcesses(canonical, space).length) return false;
  return true;
}

/** Returns a settled active restore of the recorded stack that was admitted, for the result to name. */
function stackPreflight(root: string, space: string, recorded: StackJournal | undefined, ownAttempt?: string): string | undefined {
  // Its members' own pidfiles would read as legacy processes under a Cotal home with no record of them.
  if (recorded && stackRunsUnderOtherHome(root, recorded)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this root's controller stack runs under another Cotal home; this one holds no record of its members, so nothing was started, adopted or replaced", { target: { root, space, cotalHome: homeCotalDir() }, remedy: stackHomeRemedy() });
  const maintenance: { fenced: boolean; admittedRestore?: string } = recorded ? stackMaintenanceFence(root, recorded) : { fenced: readMaintenanceJournal(root) !== undefined };
  if (maintenance.fenced) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance or recovery attempt; the controller stack did not substitute an ordinary startup", { target: { root, space } });
  const legacy = foreignLocalProcesses(root, space);
  if (legacy.length || existsSync(join(root, ".cotal", "nats.pid"))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "legacy pidfile-owned processes or records remain under this root; the controller stack neither adopts nor replaces them", { target: { root, space, processes: legacy } });
  if (localMeshesForRoot(root).some((mesh) => mesh.space !== space)) throw new CommandFailure("refused", "CONFLICT", "another locally started space uses this root; a single-space controller stack cannot share its broker", { target: { root, space } });
  let ledgers, additive, boots, summaries;
  try { ledgers = listLedgerFiles(root, { requireReadable: true }); additive = listAdditiveTeamAttempts(root); boots = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "team records under this root could not be read; no empty team state was inferred", { target: { root, space } }); }
  const settled = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
  if (ledgers.valid.length || ledgers.refused.length || retainedAdditiveTeamAttempts(additive).length || additive.refused.length || boots.refused.length || summaries.refused.length || boots.valid.some((attempt) => attempt.deploymentId !== ownAttempt && !freshTeamAttemptSettled(attempt, settled.get(attempt.deploymentId))))
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "team deployments or unsettled boot records remain under this root; the controller stack did not adopt their resources", { target: { root, space } });
  return maintenance.admittedRestore;
}

/** The broker binary that preparation already selected, canonicalized to its file. A bare PATH name
 *  is resolved under the same environment; no second selection or fallback is made. */
function canonicalBinary(bin: string): string {
  const found = bin.includes("/") ? bin : resolveOnPath(bin);
  if (!found) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the selected nats-server could not be resolved to a file; no other binary was selected");
  return realpathSync.native(found);
}

/** Save a stack definition, or verify an existing one is this root's stack definition. A saved
 *  definition naming another adapter or root refuses. One whose volatile launch options differ (the
 *  broker's freshly allocated websocket port, a different selected binary) is redefined only when
 *  every recorded instance of it is stopped with its terminal receipt; those stopped records are
 *  removed with the definition under its writer lock, exactly as `service remove` requires. `replace`
 *  journals the replacement's IDs before that retirement and the new definition's revision after it,
 *  so an `up` cut off before the replacement's readiness is recorded leaves a resolvable transition. */
function ensureDefinition(space: string, role: StackRole, input: ServiceDefinitionInput, root: string, replace: (definitionRevision?: string) => void): ServiceDefinitionSnapshot {
  const store = serviceDefinitionStore(space), name = STACK_DEFINITION[role];
  const existing = store.read(name);
  const wanted = input.launch;
  if (existing) {
    const launch = existing.record.value.launch;
    if (launch.type !== "adapter" || wanted.type !== "adapter" || launch.adapter !== STACK_ADAPTER[role] || launch.options.root !== root)
      throw new CommandFailure("refused", "CONFLICT", "a saved definition under a stack name belongs to another adapter or root; it was not replaced", { target: { space, definition: name }, remedy: `inspect cotal service show ${name} --space ${space}` });
    if (JSON.stringify(launch.options) === JSON.stringify(wanted.options)) return existing;
    // A running member keeps the definition it was launched from; it is reused, never redefined.
    if (serviceInstances(space, name).some((row) => observeServiceProcess(row.record.value) === "running")) return existing;
    // A member that crashed is recorded as such first, so its record can go with the definition.
    settleExitedInstances(existing);
    replace();
    store.commit(name, existing, undefined, () => removeStoppedInstanceRecords(space, name));
  }
  store.commit(name, undefined, validateServiceDefinition(input, space));
  const saved = store.read(name)!;
  if (existing) replace(saved.record.revision);
  return saved;
}

function adapterDefinition(space: string, adapter: string, options: Record<string, unknown>, timeoutMs: number): ServiceDefinitionInput {
  return { schemaVersion: 1, space, launch: { type: "adapter", adapter, options }, readiness: { type: "adapter", timeoutMs } };
}

function membersView(journal: StackJournal, title: string): Report {
  // A role the stack's mode never plans (auth on a static or open stack, delivery on an open one)
  // is not a member of it; it stays in the journal and JSON only.
  const members = journal.members.filter((member) => stackRoleApplies(journal.mode, member.role));
  return { sections: [{ title, blocks: [
    { kind: "fields", rows: [["Space", journal.space], ["Root", journal.root], ["Broker", journal.server], ["Mode", journal.mode === "open" ? "open, no authentication" : journal.mode === "user" ? "user auth" : "static auth"], ["Operation", `${journal.operation.kind} ${journal.operation.phase}`], ...(journal.mode === "user" ? [["Registration", userRegistrationIncomplete(journal.space) ? "incomplete: no confirmed auth-service endpoint" : "auth-service endpoint confirmed by its provider"] as [string, string]] : [])] },
    { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Result" }], rows: members.map((member) => ({ role: member.role, definition: member.definition, instance: member.instanceId ?? "not allocated", state: { text: member.state.replaceAll("-", " "), tone: ["started", "reused", "stopped", "already-stopped"].includes(member.state) ? "ok" as const : ["refused", "failed"].includes(member.state) ? "failed" as const : "waiting" as const } })) },
    { kind: "lines", lines: [journal.mode === "open"
      ? "Open stack: no authentication, no delivery member and no delivery credential. Each member is one exact service-controller instance. Broker readiness means its own process reported its listener; manager readiness is the child's own local receipt, not an attributed endpoint response. This is not agent or task readiness, and a partial start is not rolled back."
      : journal.mode === "user"
        ? "User-auth stack: each member is one exact service-controller instance. Auth-service readiness is its startup receipt plus the provider's readiness for that exact process; delivery readiness is its startup receipt; manager readiness is its endpoint read as your signed-in, granted login. This is not agent or task readiness, and a partial start is not rolled back."
        : "Each member is one exact service-controller instance. Broker readiness means its own process reported its listener; delivery readiness is its process startup receipt; manager readiness is its attributed native endpoint. This is not agent or task readiness, and a partial start is not rolled back."] },
  ] }] };
}

/** `cotal up`'s controller route: start, seed the default persona into the root, then write its
 *  own receipt. The stack is up by then, so a persona that cannot be written is a warning. */
export async function stackUp(request: StackUpRequest, native: StackUpNative): Promise<void> {
  const { journal, changed, allReused, admittedRestore, settled } = await startControllerStack(request, native);
  const { root, space, server, mode } = journal;
  const managed = journal.members.some((row) => row.role === "manager" && (row.state === "started" || row.state === "reused"));
  const written: { what: string; path: string }[] = [];
  const warnings: OutputWarning[] = settled ? [{ code: "OPERATION_SETTLED", target: { root, space, operation: settled.operation.id }, message: stackSettlementNotice(settled) }] : [];
  try {
    const persona = seedDefaultPersona(root);
    if (persona) written.push(persona);
  } catch (error) {
    warnings.push({ code: "PERSONA_NOT_WRITTEN", target: { root, space }, message: `the default persona was not written in ${root}: ${(error as Error).message}` });
  }
  writeResult(request.presentation, { command: "up", target: { root, space, server }, result: { kind: "controller-stack-up", root, space, server, mode, operation: journal.operation, members: journal.members, changed, foreground: request.foreground, admittedRestore: admittedRestore ?? null, settledOperation: settled ?? null, written }, warnings, ...(allReused && written.length === 0 ? { noOp: true } : {}) }, (result) => {
    const members = membersView({ ...journal, members: result.members }, allReused ? "Controller stack already running" : "Controller stack started");
    const view: Report = result.written.length ? { ...members, sections: [...members.sections, { blocks: [{ kind: "fields", rows: result.written.map((w): [string, string] => ["wrote", `${w.what}: ${w.path}`]) }] }] } : members;
    const next: Report["sections"] = request.foreground ? [] : [{ title: "Next", blocks: [{ kind: "commands", items: [
      // A bare spawn targets the selected space, which this up does not change when one is set.
      managed ? { command: `cotal spawn --space ${space}`, description: "Launch your default agent" } : { command: "cotal up", description: "Add the manager to this stack" },
      { command: "cotal down", description: "Stop every recorded member" },
    ] }] }];
    return { ...view, sections: [...view.sections, ...(admittedRestore ? [{ title: "Retained restore journal", blocks: [{ kind: "lines" as const, lines: [`Active restore ${admittedRestore} stays in this root's maintenance journal. It was read and not changed.`] }] }] : []), ...next] };
  });
}

/** Start the recorded stack and return its domain result without writing any receipt. */
export async function startControllerStack(request: StackUpRequest, native: StackUpNative): Promise<StackUpResult> {
  const root = canonicalRoot(request.root), space = request.space;
  if (request.transport.kind !== "plaintext" && request.transport.kind !== "tls-required") throw new CommandFailure("refused", "UNSUPPORTED", "unknown broker transport");
  const recorded = readStackJournal(root);
  if (request.expectPriorDown && (!recorded || recorded.sha256 !== request.expectPriorDown.journalSha256 || recorded.journal.operation.id !== request.expectPriorDown.operationId))
    throw new CommandFailure("refused", "CONFLICT", "the stopped stack changed after the team boot checked it; nothing was started", { target: { root, space, expected: request.expectPriorDown.operationId } });
  // A stack none of whose members ever launched, such as one whose first up was refused at a busy
  // address, pins nothing: this up plans it as a first up from the request and only replaces its
  // journal file. Broker inputs an earlier attempt recorded stay the default for any it does not name.
  const unstarted = recorded !== undefined && stackNeverStarted(recorded.journal) ? recorded.journal : undefined;
  const previous = unstarted ? undefined : recorded;
  // A stopped stack's broker is prepared again from its own recorded inputs. An explicit request for
  // a different store, cap or bind host refuses; none is replaced by a default.
  const recordedBroker = previous?.journal.broker;
  if (recordedBroker && (request.storeDir !== undefined && resolve(request.storeDir) !== recordedBroker.storeDir || request.maxFileStore !== undefined && request.maxFileStore !== recordedBroker.maxFileStore || request.host !== undefined && request.host !== recordedBroker.host))
    throw new CommandFailure("refused", "CONFLICT", "the requested broker store, cap or bind host differs from this stack's recorded broker inputs; nothing was prepared", { target: { root, space, recorded: recordedBroker } });
  // A journal written before broker inputs were recorded cannot tell which store, cap or bind host
  // its stopped broker used: `cotal down` removed the registration that held them, and broker
  // preparation would otherwise fall back to the default `.cotal/nats` store with no cap. Such a
  // restart is refused before any effect unless the caller names the store explicitly; the cap and
  // host are then taken exactly as given and recorded, never inferred from a default.
  const brokerRows0 = previous && !recordedBroker ? serviceInstances(space, STACK_DEFINITION.broker) : [];
  const legacyStopped = previous !== undefined && !recordedBroker && !(brokerRows0.length === 1 && observeServiceProcess(brokerRows0[0]!.record.value) === "running");
  if (legacyStopped && request.storeDir === undefined)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this stopped stack was recorded before its broker store, cap and bind host were kept; the broker is not prepared from a default store", { target: { root, space, operation: previous!.journal.operation.id }, remedy: `name the stack's original store explicitly: cotal up --store-dir <original store dir> [--max-file-store <bytes>] [--host <host>] --space ${space}; omit --max-file-store and --host only if the original start set neither` });
  // The named store must already exist as a real directory: preparation would otherwise create
  // an empty store at a mistyped path and start the stack on it. Its identity is pinned here and
  // checked again by preparation, which never creates a pinned store, and just before the broker starts.
  const storePin = legacyStopped ? pinExistingStore(resolve(request.storeDir!), { root, space }) : undefined;
  const brokerStore = recordedBroker?.storeDir ?? request.storeDir ?? unstarted?.broker?.storeDir;
  const brokerCap = recordedBroker ? recordedBroker.maxFileStore : request.maxFileStore ?? unstarted?.broker?.maxFileStore;
  const brokerHost = recordedBroker ? recordedBroker.host : request.host ?? unstarted?.broker?.host;
  // The mode is pinned by the first whole-stack up. A conflicting explicit request refuses here,
  // before any preflight write, preparation or launch.
  if (previous && request.mode !== undefined && request.mode !== previous.journal.mode)
    throw new CommandFailure("refused", "CONFLICT", "this root's controller stack is pinned to another auth mode; a running or stopped stack is not converted", { target: { root, space, recorded: previous.journal.mode, requested: request.mode }, remedy: "run bare cotal up to keep the recorded mode" });
  const mode: StackMode = previous?.journal.mode ?? request.mode ?? "auth";
  if (mode === "open" && holdsBrokerAccount(root))
    throw new CommandFailure("refused", "CONFLICT", "this root holds a broker account; an open stack does not bypass its recorded authorization", { target: { root, space } });
  if (mode === "user") assertUserStackTransport(previous?.journal.server ?? request.server, request.transport.kind === "tls-required");
  else if (request.idp !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--idp belongs to a user-auth stack; nothing was prepared", { target: { root, space } });
  const admittedRestore = stackPreflight(root, space, previous?.journal, request.manifest?.deploymentId);
  if (previous && (previous.journal.space !== space || previous.journal.server !== request.server))
    throw new CommandFailure("refused", "CONFLICT", "this root's stack journal names another space or broker address; it was not rebound", { target: { root, space, recorded: { space: previous.journal.space, server: previous.journal.server } } });
  // The broker service's own address rules run before anything is written, so an address it would
  // refuse never becomes this root's recorded broker address.
  brokerListenAddress(request.server);
  // The broker service launches only for a space registered or prepared at this root. That is
  // checked here, before trust, configuration, definitions, instances or the journal are written,
  // so the refusal leaves the folder as it was.
  const registration = findMesh(space), preparedSpace = findPreparedSpace(space);
  if (registration && (registration.origin !== "up" || canonicalRoot(registration.root) !== root || registration.server !== (previous?.journal.server ?? request.server)))
    throw new CommandFailure("refused", "CONFLICT", "the space is registered to another root, broker address or external origin; nothing was prepared or started", { target: { root, space }, remedy: `inspect it with cotal space show ${space}` });
  if (!registration && (!preparedSpace || canonicalRoot(preparedSpace.root) !== root))
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the space has no prepared or locally started registration at this root; nothing was prepared or started", { target: { root, space }, remedy: `prepare it with cotal space create ${space} --root ${root}, then run cotal up` });
  // An earlier up or down that never recorded its outcome is settled from its members' process
  // evidence under the held maintenance lock. Only a preserve or resume can remain unsettled here.
  // A member stop an earlier down could not confirm in time is settled from its own receipt first.
  if (previous) await settleRetainedStackStops(previous.journal);
  const { snapshot: current, settled } = previous ? settleStackOperation(request.maintenanceLock, previous) : { snapshot: undefined, settled: undefined };
  if (current && stackOperationUnsettled(current.journal))
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier preserve or resume on this root has no settled outcome; it is decided by its own maintenance attempt and no member was started", { target: { root, space, operation: current.journal.operation }, remedy: `inspect the root's maintenance attempt and the stack's members with cotal service --space ${space} before another whole-stack operation` });
  const server = previous?.journal.server ?? request.server;
  if (request.noManager) {
    const running = serviceInstances(space, STACK_DEFINITION.manager).filter((row) => observeServiceProcess(row.record.value) === "running");
    if (running.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "--no-manager cannot keep an already-running controller manager; no member was started or stopped", { target: { root, space, instances: running.map((row) => row.name) }, remedy: `stop the recorded manager with cotal service stop ${STACK_DEFINITION.manager} --space ${space} --yes before requesting --no-manager` });
  }
  // Check provider inputs before preparation or a journal write. A supplied IdP is always checked,
  // including a live refresh; only an unpinned first enable probes JWKS. Preparation checks again.
  if (mode === "user") {
    const brokerRows = serviceInstances(space, STACK_DEFINITION.broker);
    if (request.idp !== undefined || !(brokerRows.length === 1 && observeServiceProcess(brokerRows[0]!.record.value) === "running")) await preflightUserStack(root, space, request.idp);
  }
  const roles = STACK_ROLES.filter((role) => stackRoleApplies(mode, role) && !(role === "manager" && request.noManager));
  // A replacement an earlier `up` journaled is resolved from its own record before it is carried over.
  const recordedMembers = current ? withSettledMembers(current.journal, undefined).members : [];
  const members: StackMember[] = STACK_ROLES.map((role) => ({ role, definition: STACK_DEFINITION[role], instanceId: recordedMembers.find((row) => row.role === role)?.instanceId ?? null, state: roles.includes(role) ? "planned" : "not-attempted" }));
  let journal: StackJournal = { schemaVersion: 1, kind: "cotal-stack-controller", root, space, server, mode, ...(recordedBroker ? { broker: recordedBroker } : {}), members, operation: newStackOperation("up"), updatedAt: new Date().toISOString() };
  // The whole scoped plan is durable before the first effect. A crash after this reads as unsettled
  // until the next whole-stack operation settles it from its members' evidence.
  let snapshot: StackJournalSnapshot = writeStackJournal(root, current ?? recorded, journal);
  const changed: unknown[] = [];
  const settle = (phase: StackJournal["operation"]["phase"]) => {
    journal = { ...journal, operation: { ...journal.operation, phase }, updatedAt: new Date().toISOString() };
    snapshot = writeStackJournal(root, snapshot, journal);
  };
  const mark = (role: StackRole, change: Partial<StackMember>) => {
    journal = { ...journal, members: journal.members.map((row) => row.role === role ? { ...row, ...change } : row), updatedAt: new Date().toISOString() };
    snapshot = writeStackJournal(root, snapshot, journal);
  };
  // A redefinition retires the member's recorded instance with its old definition. The replacement's
  // IDs are journaled before that retirement and the new definition's revision before its launch.
  const replace = (role: StackRole) => (definitionRevision?: string) => {
    const row = journal.members.find((member) => member.role === role)!;
    mark(role, { replacement: definitionRevision === undefined ? { operation: journal.operation.id, instanceId: randomUUID(), launchRequestId: randomUUID() } : { ...row.replacement!, definitionRevision } });
  };
  const start = async (role: StackRole, definition: ServiceDefinitionSnapshot) => {
    prepareProcessService(definition);
    const current = serviceInstances(space, definition.name);
    if (current.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "a stack definition has several instance records; no instance was chosen", { target: { space, definition: definition.name, candidates: current.map((row) => row.name) } });
    const { instanceId: recorded, replacement } = journal.members.find((row) => row.role === role)!;
    if (current[0] && recorded && current[0].name !== recorded) throw new CommandFailure("refused", "CONFLICT", "the stack journal and the definition's instance record name different instances; neither was adopted", { target: { space, definition: definition.name } });
    // A readiness wait can take many seconds, so a text run says what it waits for instead of going silent.
    if (request.presentation !== "json" && !(current[0] && observeServiceProcess(current[0].record.value) === "running"))
      process.stderr.write(`Starting ${definition.name}; waiting up to ${Math.round(definition.record.value.readiness.timeoutMs / 1000)}s for its readiness check\n`);
    // A redefined member starts its replacement under the IDs the journal already names.
    const started = await startProcessService(definition, replacement ? { replacement: { instanceId: replacement.instanceId, launchRequestId: replacement.launchRequestId } } : current[0] ? { instance: current[0].name } : {});
    mark(role, { instanceId: started.instance.name, state: started.noOp ? "reused" : "started", replacement: undefined });
    if (!started.noOp) changed.push(instanceProjection(started.instance));
    return started.instance;
  };
  settle("applying");
  // Set only when a user stack's manager is withheld for want of an existing login and grant. That
  // is a known pre-effect refusal of one member, never a launch and never an unknown outcome.
  let loginBlock: CommandFailure | undefined;
  // A failure in a step that belongs to an already-started member is attributed to that member,
  // never to the next planned one.
  let failedRole: StackRole | undefined;
  let failedStage: "broker-streams" | "broker-registration" | undefined;
  let launch: { path: string; sha256: string } | undefined;
  try {
    // Broker. Trust and configuration are prepared only when this broker is not already serving
    // under its own recorded instance, never as an adapter planning step.
    const brokerRows = serviceInstances(space, STACK_DEFINITION.broker);
    const brokerRunning = brokerRows.length === 1 && observeServiceProcess(brokerRows[0]!.record.value) === "running";
    if (!brokerRunning && await isReachable(server, { timeoutMs: 1500 })) throw new CommandFailure("refused", "CONFLICT", "something already answers at the stack's broker address without this stack's broker instance; it was not adopted or stopped", { target: { root, space, server } });
    let prepared: Awaited<ReturnType<StackUpNative["prepareBroker"]>> | undefined;
    if (!brokerRunning) {
      prepared = await native.prepareBroker({ transport: request.transport, server, space, open: mode === "open", ...(mode === "user" ? { userAuth: request.idp !== undefined ? { idpUrl: request.idp } : {} } : {}), ...(brokerHost ? { host: brokerHost } : {}), ...(brokerStore ? { storeDir: brokerStore } : {}), ...(storePin ? { existingStore: storePin } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}), ...(request.manifest ? { seed: request.manifest.seed } : request.channels ? { channels: request.channels } : {}) });
      if (canonicalRoot(prepared.root) !== root || prepared.space !== space || prepared.server !== server || (prepared.setup === undefined) !== (mode === "open") || (prepared.user === undefined) !== (mode !== "user")) throw new CommandFailure("refused", "CONFLICT", "the prepared broker configuration names another root, space, address or auth mode; the stack did not continue");
      if (mode === "user") assertUserStackTransport(server, prepared.transport.kind === "tls-required");
      // The validated transport decision is recorded before the broker child starts, so its
      // listener-report check compares against the transport this configuration actually serves.
      native.commitTransport(root, prepared.transport);
      journal = { ...journal, broker: { storeDir: resolve(prepared.storeDir), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}), ...(brokerHost ? { host: brokerHost } : {}) }, updatedAt: new Date().toISOString() };
      snapshot = writeStackJournal(root, snapshot, journal);
    }
    // A running stack broker keeps its saved definition; a fresh one is defined from this preparation.
    const savedBroker = serviceDefinitionStore(space).read(STACK_DEFINITION.broker);
    const savedOptions = savedBroker?.record.value.launch.type === "adapter" ? savedBroker.record.value.launch.options : undefined;
    if (!prepared && !savedOptions) throw new CommandFailure("refused", "CONFLICT", "a broker instance runs without its saved stack definition; it was not adopted", { target: { space, definition: STACK_DEFINITION.broker } });
    const brokerOptions = prepared ? { root, config: prepared.confPath, binary: canonicalBinary(prepared.bin), server } : { ...savedOptions! };
    const broker = ensureDefinition(space, "broker", adapterDefinition(space, STACK_ADAPTER.broker, brokerOptions, 30000), root, replace("broker"));
    if (storePin) recheckExistingStore(storePin, { root, space });
    await start("broker", broker);
    if (prepared) {
      // The broker's own stream and registry setup, on the native space path, after it serves.
      failedRole = "broker";
      failedStage = "broker-streams";
      await native.initializeStreams(server, space, prepared.setup, prepared.seedFile);
      failedStage = "broker-registration";
      // A user registration is recorded here, before its auth service exists, because the native
      // auth-service child resolves a registered user target. It carries only the prepared trust
      // pins and stays incomplete until that child's own readiness is confirmed below.
      native.recordMesh({ space, server, root, mode, tlsRequired: prepared.transport.kind === "tls-required", storeDir: prepared.storeDir, ...(prepared.user ? { userAuth: provisionalUserAuth(prepared.user) } : {}), ...(request.maxSessions !== undefined ? { maxSessions: request.maxSessions } : {}), ...(brokerHost ? { attachHost: brokerHost } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}) });
      failedStage = undefined;
      failedRole = undefined;
    }
    // Auth service, user stacks only. Its native preparation came from this broker preparation, so
    // a stopped auth service under an already-running broker is not started from guessed material.
    if (mode === "user") {
      const authRows = serviceInstances(space, STACK_DEFINITION.auth);
      const authRunning = authRows.length === 1 && observeServiceProcess(authRows[0]!.record.value) === "running";
      if (!prepared?.user && !authRunning) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the user stack's auth service is stopped while its broker still runs; its native preparation runs only with a broker start, so it was not started from other material", { target: { root, space }, remedy: "stop the stack with bare cotal down, then run bare cotal up" });
      const authService = ensureDefinition(space, "auth", adapterDefinition(space, STACK_ADAPTER.auth, { root, server }, 60000), root, replace("auth"));
      const instance = await start("auth", authService);
      if (prepared?.user) {
        failedRole = "auth";
        const confirmed = await confirmUserAuthEndpoints(prepared.user, space, instance);
        native.recordMesh({ space, server, root, mode, tlsRequired: prepared.transport.kind === "tls-required", storeDir: prepared.storeDir, userAuth: confirmed, ...(request.maxSessions !== undefined ? { maxSessions: request.maxSessions } : {}), ...(brokerHost ? { attachHost: brokerHost } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}) });
        failedRole = undefined;
      }
    }
    // Delivery. Its scoped native credential is minted into the root's own store key, the same
    // material the native daemon reads; the adapter is handed only that protected path. A user
    // stack uses the same hosting-root space signer as native `ensureDelivery` does on a user root.
    // An open stack has no delivery member, so no trust is read and no credential is minted.
    if (mode !== "open") {
      const store = workspaceSecretStore(root), auth = await getSpaceAuth(store, space);
      if (!auth) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the static space trust is missing; no delivery credential was minted from another signer", { target: { root, space } });
      const credsKey = deliveryCredsKey(space, { injected: false, root });
      const credsPath = join(root, ".cotal", credsKey);
      const deliveryRows = serviceInstances(space, STACK_DEFINITION.delivery);
      if (!(deliveryRows.length === 1 && observeServiceProcess(deliveryRows[0]!.record.value) === "running")) {
        const creds = await mintCreds(auth, newIdentity(), "delivery");
        // A daemon that was killed, or that exited when its broker went away, cannot release shard 0,
        // and a replacement started inside the row's TTL loses the create and refuses to bind. No
        // daemon runs here, so a row held by the credential this folder gave the previous one is that
        // dead daemon's: wait for the bucket TTL to remove it. A row written again meanwhile has a
        // live holder, and that is refused.
        const previous = await store.get(credsKey);
        if (previous !== undefined) {
          const waited = await awaitDeadDeliveryLease({
            servers: server, space, creds, tls: resolveNativeServiceTarget(root, space, server).tlsRequired,
            deadHolder: deliveryLeaseHolderFor(previous), ttlMs: LEASE_TTL_MS,
            onWait: (ms) => { if (request.presentation !== "json") process.stderr.write(`${STACK_DEFINITION.delivery}: shard 0 is still leased to this folder's previous delivery daemon, which is not running; waiting ${Math.ceil(ms / 1000)}s for the lease to expire\n`); },
          });
          if (waited === "rewritten") throw new CommandFailure("refused", "CONFLICT", "shard 0 of the delivery lease names this folder's previous delivery daemon and was written again while up waited for it to expire, so a live daemon holds it; no second daemon was started", { target: { root, space }, remedy: `find the process running delivery for space ${space} and stop it or keep it; cotal down does not reach a daemon this folder has no record of` });
        }
        await store.put(credsKey, creds);
      }
      const delivery = ensureDefinition(space, "delivery", adapterDefinition(space, STACK_ADAPTER.delivery, { root, creds: credsPath, server }, 40000), root, replace("delivery"));
      await start("delivery", delivery);
    }
    // A user stack's manager is read and stopped as the invoking user's existing login. Without a
    // signed-in, granted login it is not attempted; nothing is launched for it.
    if (!request.noManager && mode === "user") {
      const login = await userLoginState(root, space);
      if (login.state !== "ready") loginBlock = userLoginRequired(space, login);
    }
    if (!request.noManager && !loginBlock) {
      const options: Record<string, unknown> = { root, runtime: request.runtime, server };
      if (prepared?.setup?.wsPort !== undefined) options["ws-port"] = prepared.setup.wsPort;
      if (request.maxSessions !== undefined) options["max-sessions"] = request.maxSessions;
      if (brokerHost) options["console-host"] = brokerHost;
      if (request.manifest) {
        // The manager carries the manifest launch only when this call starts it. A running manager
        // keeps the launch it was started with; nothing is re-launched or re-pinned under it.
        const managerRows = serviceInstances(space, STACK_DEFINITION.manager);
        if (managerRows.some((row) => observeServiceProcess(row.record.value) === "running")) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a controller manager already runs for this space; a fresh manifest launch was not attached to it", { target: { root, space, instances: managerRows.map((row) => row.name) } });
        failedRole = "manager";
        launch = await request.manifest.launchSpec({ root, space, server, mode, ...(prepared?.user ? { user: prepared.user } : {}) });
        failedRole = undefined;
        options.launch = launch.path;
        options["launch-sha256"] = launch.sha256;
      }
      const manager = ensureDefinition(space, "manager", adapterDefinition(space, STACK_ADAPTER.manager, options, 60000), root, replace("manager"));
      await start("manager", manager);
    }
    if (!loginBlock) settle("completed");
  } catch (error) {
    const failure = isCommandFailure(error) ? error : undefined;
    const uncertain = failure === undefined || failure.outcome === "unknown";
    const pending = failedRole ? journal.members.find((row) => row.role === failedRole) : journal.members.find((row) => row.state === "planned");
    if (pending) mark(pending.role, { state: uncertain ? "unknown" : failure?.outcome === "refused" ? "refused" : "failed", code: failure?.code ?? "OPERATION_UNKNOWN" });
    for (const row of journal.members.filter((member) => member.state === "planned")) mark(row.role, { state: "not-attempted" });
    settle(uncertain ? "unknown" : changed.length ? "partial" : failure?.outcome === "failed" ? "failed" : "refused");
    const outcome = uncertain ? "unknown" : changed.length ? "partial" : failure!.outcome;
    // Keep typed broker codes, never the server's arbitrary description or the raw error object.
    const nativeCause = failure ? { code: failure.code, outcome: failure.outcome, detail: failure.message }
      : error instanceof JetStreamApiError && Number.isSafeInteger(error.code) && error.code >= 10000 && error.code < 20000
        ? { code: String(error.code), ...(Number.isSafeInteger(error.status) && error.status >= 400 && error.status < 600 ? { detail: { status: error.status } } : {}) }
        : undefined;
    // The member's own sentence and remedy are what a reader can act on, such as a busy broker port.
    const cause = pending && failure ? ` (${pending.role}: ${failure.message})` : "";
    throw new CommandFailure(outcome, uncertain ? "OPERATION_UNKNOWN" : changed.length ? "OPERATION_PARTIAL" : failure!.code, `the controller stack did not start every planned member${cause}; started members were kept and nothing was retried`, { target: { root, space, operation: journal.operation.id, members: journal.members, ...(failedStage ? { stage: failedStage } : {}) }, changed, ...(nativeCause ? { native: nativeCause } : {}), remedy: !uncertain && failure?.remedy ? failure.remedy : `inspect the stack's members with cotal service --space ${space} before another cotal up; a later bare cotal down stops only the recorded members` });
  }
  if (loginBlock) {
    mark("manager", { state: "not-attempted", code: "AUTH_REQUIRED" });
    // Other members that this call started or found already running under their own recorded
    // instances are known live state, so the outcome is partial even when nothing new launched.
    // `changed` stays exactly what this call launched; reused members are not reported as launches.
    const live = journal.members.filter((row) => row.role !== "manager" && (row.state === "started" || row.state === "reused"));
    settle(live.length ? "partial" : "refused");
    const detail = { root, space, operation: journal.operation.id, members: journal.members, registration: userRegistrationIncomplete(space) ? "incomplete" : "confirmed" };
    if (!live.length) throw new CommandFailure("refused", "AUTH_REQUIRED", loginBlock.message, { target: detail, ...(loginBlock.remedy ? { remedy: loginBlock.remedy } : {}) });
    throw new CommandFailure("partial", "OPERATION_PARTIAL", changed.length
      ? "the user stack started its other members; the manager was not attempted because no signed-in, granted login exists. This is not whole-stack readiness"
      : "the user stack's other members were already running and were reused; the manager was not attempted because no signed-in, granted login exists. This is not whole-stack readiness", { target: detail, changed, native: { code: "AUTH_REQUIRED", outcome: "refused", detail: loginBlock.message }, ...(loginBlock.remedy ? { remedy: loginBlock.remedy } : {}) });
  }
  const allReused = journal.members.every((row) => row.state === "reused" || row.state === "not-attempted");
  return { journal, changed, allReused, ...(launch ? { launch } : {}), ...(admittedRestore ? { admittedRestore } : {}), ...(settled ? { settled } : {}) };
}

/** The member table and evidence text a caller embeds in its own receipt. */
export function stackMembersView(journal: StackJournal, title: string): Report {
  return membersView(journal, title);
}

export function stackUpForegroundNotice(presentation: ReturnType<typeof presentationOf>, space: string): void {
  if (presentation === "json") return;
  console.log(renderReport({ space, sections: [{ title: "Foreground stack lifetime", blocks: [{ kind: "lines", lines: ["This terminal holds the stack's lifetime. Ctrl-C or SIGTERM runs the same guarded whole-stack stop as bare cotal down, including its manager impact review. Terminal loss or an external kill is not a confirmed stop."] }] }] }, presentation, terminalWidth(process.stdout)));
}

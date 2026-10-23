import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  dialerFor,
  EpEnvelopeError,
  formatAge,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  resolveService,
  realDirNoSymlink,
  invokeRepairingSplit,
  standaloneConnectOpts,
  newIdentity,
  idFromCreds,
  principalKey,
  DEV_OWNER,
  unansweredRequest,
  resolveAuthProvider,
  personaDir,
  presenceText,
  type FlagValues,
  type ParsedArgs,
  type SpaceAuth,
  type UserAuthStatus,
} from "@cotal-ai/core";
import { accountInventory, assessMaintenanceClaim, authDir, isCommandFailure, readMaintenanceJournal, brokerAddressForDisplay, canonicalRoot, CLI_USER_ACTOR, CommandFailure, deliveryCredsKey, DELIVERY_PIDFILE, extensionsDir, findCotalRoot, findPreparedSpace, hasUserAuthState, homeCotalDir, cachedPreferences, resolvePreference, isMeshRegistryError, isWorkspaceTargetError, jsonFlag, loadSoleSpaceAuth, localProcessPath, localProcessVisible, MANAGER_PIDFILE, oneLine, PREFERENCE_KEYS, parsePid, plainFlag, preflightTarget, presentationOf, probeLiveness, probeWebReadiness, readCurrent, readMeshRegistry, readRenewalRecord, renderWorkspaceError, resolveMeshTarget, serverFlag, spaceFlag, userAuthStateDir, WEB_PIDFILE, WEB_READINESS_HEADER, workspaceSecretStore, writeResult, type Cell, type LocalProcess, type LocalProcessContext, type MeshEntry, type MaintenanceClaim, type MeshTarget, type OutputWarning, type Report, type Section, type Tone } from "@cotal-ai/workspace";
import { localProcessSurface } from "../ext-loader.js";
import { cliVersion, cliProvenance, readExtensionVersions, type CliProvenance } from "../lib/version.js";
import { agentSkillsSkew } from "../lib/agent-skills.js";
import { managerHasDeliveryMarker } from "../lib/manager-proc.js";
import { signedInSpace } from "../lib/conversation-identity.js";
import { connectorHarnesses, connectorStatusRows, machineStatus, recordedWebUrl, resolveRuntimeSpace, webBoundAddress, webInstalled, webSessionSource, type HarnessStatus, type MachineStatus } from "../lib/status.js";
import { deliveryResponderFromLease, deliveryResponderState, deliveryRowSuffix, RESPONDER_UNBOUND_CONSEQUENCE, type DeliveryResponderState } from "../lib/delivery-responder.js";
import { pidfileState, type PidfileState } from "./down.js";
import { displayCmd } from "../lib/self-exec.js";
import { readPersonas, type PersonaEntry } from "../lib/personas.js";
import { defaultPersonaFix } from "../lib/default-persona.js";
import { c } from "../ui.js";
import { preparedCatalogDiagnostics } from "./sync.js";
import { agentStatus } from "./agents.js";
import { invalidEnvironmentValues } from "./config.js";
import { onInstance } from "../lib/control.js";
import { serviceDefinitionProjection, serviceDefinitionStore } from "../lib/service-definitions.js";
import { instanceProjection, serviceInstances } from "../lib/service-instances.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { additiveTeamRecordedState, listAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { restoreNextStep } from "../lib/restore.js";
import { attemptProcessesGone } from "../lib/isolated-broker.js";
import { readStackJournal } from "../lib/stack-journal.js";

/** `--components` is the fail-loud health pass with a machine-readable EXIT DISPOSITION. Bare
 * `status` is a broad, recovery-oriented report: it exits 0, or 4 when it could not read part of what
 * it reports; this explicit mode is for an operator or monitor that needs a component state per
 * component and an exit code to branch on.
 *
 * THAT DIVISION IS ABOUT EXIT CODES AND COMPLETENESS, NOT ABOUT TRUTHFULNESS, and #1576 is where the
 * difference bit. Bare status printed `delivery  running (pid N)` over a daemon whose responder had
 * never bound — not a broad answer but a specific and wrong one, identical to the line it prints
 * when delivery is fully healthy, for 22 hours, while spawn/retirement/join all failed. A broad
 * diagnostic may omit an axis; it may not claim one it never checked. So bare status stays broad,
 * and the delivery row names the responder state it actually read (or says plainly that it did not
 * read it, and points here). */
export const statusFlags = [
  spaceFlag,
  serverFlag,
  { name: "on", type: "string", value: "<manager-instance>", description: "named agent: inspect one manager instance" },
  { name: "creds", type: "string", value: "<file>", description: "named agent: use an explicit connection credential" },
  { name: "all", type: "boolean", description: "check every recorded mesh, not only the selected one" },
  { name: "verbose", short: "v", type: "boolean", description: "include installation paths, local records and detailed diagnostics" },
  { name: "components", type: "boolean", description: "probe manager, delivery, web, and registered broker component health (exit: 0 serving, or the optional dashboard not installed; 1 absent; 2 present but not serving; 3 probe refused)" },
  jsonFlag,
  plainFlag,
] as const;

type Proc = PidfileState;

/** The mesh `spawn` would load personas from, resolved ONCE for the whole run.
 *
 *  Two sections need this answer — "This Folder" (to say whether its catalog is the one that
 *  launches) and "Selected Mesh" — and resolution is NOT side-effect-free: `resolveMeshTarget`
 *  prunes a stale registry entry as it fails. Resolving twice would let the first call prune what
 *  the second then reports as simply absent, so the two sections would describe different worlds.
 *  Resolve once, share the outcome, including the failure. */
type Selected = { ok: true; target: MeshTarget } | { ok: false; error: unknown };

/** A project root with no registration or prepared space here, such as one whose space was
 *  forgotten. The resolver gives it the default broker address, which any broker may hold, so
 *  status selects no space for it and dials nothing. */
class UnregisteredRoot {
  constructor(readonly root: string) {}
}

function resolveSelected(cwd: string, values: FlagValues<typeof statusFlags>): Selected {
  try {
    const target = resolveMeshTarget(cwd, { server: values.server, space: values.space });
    return target.source === "local-space" ? { ok: false, error: new UnregisteredRoot(target.root) } : { ok: true, target };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** What a persona catalog holds: whether its `default` passes the loader spawn uses, and how many of
 *  the demo team's personas do. A catalog directory that exists and cannot be read is `unreadable`,
 *  with no demo count and the error. */
interface PersonaCatalog {
  root: string;
  default: "valid" | "invalid" | "missing" | "unreadable";
  demo: number | null;
  error: string | null;
}

/** One local process row: the state word, the pid it recorded, and what else the row knows. */
interface ProcessRow {
  name: string;
  state: "running" | "stopped" | "not-serving" | "unknown" | "unreadable";
  pid: number | null;
  detail: string | null;
}

interface OwnedServiceStatus {
  space: string | null;
  state: "read" | "partial" | "not-checked";
  observedAt: string;
  atomicSnapshot: false;
  definitions: ReturnType<typeof serviceDefinitionProjection>[] | null;
  instances: ReturnType<typeof instanceProjection>[] | null;
  scope: "selected-space local owned records; no remote registration or fresh endpoint probe";
}

/** Everything bare `status` reports, in the order it prints. The JSON envelope carries it as
 *  `result`, and the report is built from it, so the two cannot disagree. A part that could not be
 *  read is null or carries its error, and is named in the warnings. */
export interface StatusResult {
  kind: "infrastructure";
  machine: {
    version: string;
    node: string;
    platform: string;
    install: CliProvenance;
    nats: MachineStatus["nats"];
    integrations: { name: string; state: "ok" | "warn" | "error" | "off"; text: string }[];
    connectors: { name: string; requires: string[]; missing: string[] }[] | null;
    defaults: { harness: string | null; persona: string | null } | null;
    skills: { state: "current" | "not-installed" | "behind" | "unreadable"; total: number; behind: number; retired: number; error: string | null };
    web: { installed: boolean | null; installedError: string | null; url: string | null; urlError: string | null };
  };
  extensions: { root: string; items: { package: string; label: string; version: string }[] | null };
  folder: {
    root: string;
    auth: { state: "space" | "spaces" | "none" | "unreadable"; spaces: string[]; userAuth: boolean; error: string | null };
    personas: PersonaCatalog;
    launches: boolean | null;
    processes: ProcessRow[] | null;
    processSpace: string | null;
    storedState: boolean;
    /** Whether this root records a controller stack for the process space. Its members are service
     *  instances, so the legacy pidfile rows say nothing about them. */
    controllerStack: boolean;
  };
  meshes: {
    current: string | null;
    currentRecorded: boolean;
    /** Whether the selection names a space `cotal space create` prepared and no `cotal up` started. */
    currentPrepared: boolean;
    unreadable: { file: string; error: string }[];
    items: {
      space: string;
      server: string | null;
      mode: MeshEntry["mode"];
      root: string;
      origin: MeshEntry["origin"] | null;
      tlsRequired: boolean;
      eventsRequired: boolean;
      current: boolean;
      check: "reachable" | "unreachable" | "not-checked";
      catalog: { name: string | null; fetchedAt: string | null; error: string | null } | null;
    }[];
    catalogs: { idp: string; state: string; error: string | null }[];
  };
  selected: SelectedResult;
  /** Older serialized/read-view inputs may omit this observation; absence is never an empty inventory. */
  services?: OwnedServiceStatus;
  /** Selected folder's local boot intents, not a live broker or ownership census. */
  bootAttempts?: { root: string; state: "read" | "partial" | "not-checked"; observedAt: string; unsettled: { deploymentId: string; space: string; server: string; createdAt: string }[]; additive: { deploymentId: string; space: string; server: string; createdAt: string; recordedState: ReturnType<typeof additiveTeamRecordedState> }[]; unreadable: string[] };
  /** This folder's maintenance journal: a preserved cut, a restore or a resume, with the full attempt
   *  a recovery command names. Null when the root holds none; older inputs may omit it. */
  maintenance?: { root: string; space: string | null; state: string; attemptId: string | null; next: string | null } | null;
  hints: string[];
}

type SelectedResult =
  | { resolved: false; code: string; message: string }
  | {
      resolved: true;
      space: string;
      server: string | null;
      mode: MeshTarget["mode"];
      source: string;
      root: string;
      tlsRequired: boolean;
      eventsRequired: boolean;
      idp: string | null;
      personas: PersonaCatalog;
      connection: string;
      staleRecord: boolean;
      login: { idp: string; subject: string | null; expiresAt: string | null; actor: "granted" | "not-granted" | "not-checkable" | null; grant: { label: string | null; read: string[]; post: string[]; scope: string[] } | null } | null;
      deliveryResponder: DeliveryResponderState | null;
      snapshot: { state: "read" | "unavailable" | "skipped"; reason: string | null };
      channels: { channel: string; messages: number }[] | null;
      membershipFeed: { entries: number; asOf: string | null } | null;
    };

/** Collects what each reader could not read, so the report names it on its row and the run is
 *  reported partial rather than complete. */
class Gaps {
  readonly warnings: OutputWarning[] = [];
  /** Two readers that hit the same part, such as one catalog read as the folder's and the selected
   *  mesh's, name it once. */
  add(code: string, message: string, target: unknown = null): void {
    if (this.warnings.some((w) => w.code === code && w.message === message)) return;
    this.warnings.push({ code, target, message });
  }
}

/** Keep unsafe stored addresses explicit without exposing their original text. */
function displayStatusBroker(server: string, space: string, gaps: Gaps): string | null {
  const display = brokerAddressForDisplay(server);
  if (display !== undefined) return display;
  gaps.add("BROKER_ADDRESS_INVALID", `broker address for '${space}' cannot be displayed`, { space });
  return null;
}

/** Named-agent and infrastructure inputs choose different reads. */
export function validateStatusArguments(args: ParsedArgs): void {
  if (args.positionals.length > 1 || args.positionals.length && !args.positionals[0]?.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "status takes at most one agent name");
  if (args.positionals.length && (args.values.all || args.values.components))
    throw new CommandFailure("refused", "USAGE_INVALID", "a named agent status takes no --all or --components");
  if (typeof args.values.on === "string") onInstance(args.values.on, "cotal status");
  if (!args.positionals.length && (args.values.on !== undefined || args.values.creds !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "--on and --creds select a named agent read, not infrastructure status");
}

/** `cotal status` — detailed, read-only diagnostics for the local machine + selected mesh. */
export async function status(args: ParsedArgs): Promise<void> {
  validateStatusArguments(args);
  if (args.positionals.length) return agentStatus(args);
  const values = args.values as FlagValues<typeof statusFlags>;
  const presentation = presentationOf(values);
  if (values.components && (presentation !== "rich" || values.all))
    throw new CommandFailure("refused", "USAGE_INVALID", "--components checks the selected mesh and writes its own records - it takes no --json, --plain or --all", {
      remedy: `run \`${displayCmd()} status --components\` on its own`,
    });
  const cwd = process.cwd();
  const root = findCotalRoot(cwd);
  const selected = resolveSelected(cwd, values);
  const gaps = new Gaps();
  const hints: string[] = [];
  const machine = await readMachine(selected, gaps);
  const extensions = readExtensions(gaps);
  // THE RESPONDER AXIS (#1576), read ONCE and threaded into the rows that would otherwise claim
  // health they never checked. It is read before the folder section because that section renders
  // the delivery process row, and a live pid means nothing without it.
  const responder = await readResponderAxis(selected);
  const folder = await readFolder(root, selected, values, responder.state, gaps, hints);
  const meshes = await readMeshes(selected, Boolean(values.all), gaps);
  const target = await readSelected(selected, responder, gaps, hints);
  const services = readOwnedServices(selected, gaps);
  const bootAttempts = readBootAttempts(root, gaps);
  const maintenance = readMaintenance(root, gaps);
  const result: StatusResult = { kind: "infrastructure", machine, extensions, folder, meshes, selected: target, services, bootAttempts, maintenance, hints };
  const parts = gaps.warnings.length;
  // A preference variable `config set` would refuse is named, but it was read, so the run stays complete.
  const context = { preferences: cachedPreferences(), space: selected.ok ? selected.target.space : undefined };
  const invalidValues = invalidEnvironmentValues(PREFERENCE_KEYS.map((key) => resolvePreference(key, context)));
  writeResult(
    presentation,
    {
      command: "status",
      target: { space: selected.ok ? selected.target.space : null, scope: values.all ? "all" : "selected" },
      result,
      completeness: parts ? "partial" : "complete",
      warnings: [...gaps.warnings, ...invalidValues],
      ...(parts ? { partial: { message: `status could not read ${parts === 1 ? "one part" : `${parts} parts`} of what it reports; the warnings name ${parts === 1 ? "it" : "each"}` } } : {}),
    },
    (result) => statusView(result, Boolean(values.verbose)),
  );
  if (values.components) await printComponentHealth(cwd, values);
}

/** The folder's maintenance journal, read only. An unreadable one is reported, never taken for none. */
function readMaintenance(root: string, gaps: Gaps): NonNullable<StatusResult["maintenance"]> | null {
  try {
    const journal = readMaintenanceJournal(root);
    if (!journal) return null;
    const attemptId = "restore" in journal ? journal.restore.attemptId : journal.state === "claimed" ? journal.claim.attemptId : journal.cut.attemptId;
    const next = "restore" in journal ? restoreNextStep(journal.state, attemptId)
      : journal.state === "ready" ? `create a backup with ${displayCmd()} backup create <dir>, or resume with bare ${displayCmd()} up`
      : journal.state === "claimed" ? claimedNextStep(root, journal.claim) : null;
    return { root, space: journal.space, state: journal.state, attemptId, next };
  } catch {
    gaps.add("MAINTENANCE_JOURNAL_UNREADABLE", "this folder's maintenance journal could not be read; no absent or settled state was inferred", { root });
    return { root, space: null, state: "unreadable", attemptId: null, next: null };
  }
}

/** The next step for a cut a backup create still claims: wait while it runs, or release it once it
 *  stopped before it finished. */
function claimedNextStep(root: string, claim: MaintenanceClaim): string {
  const recover = `${displayCmd()} backup recover ${claim.attemptId} --yes`;
  if (assessMaintenanceClaim(claim, { unrecordedOwnersDead: attemptProcessesGone(root) }) === "stale")
    return `backup attempt ${claim.attemptId} stopped before it finished: release it with ${recover}`;
  return `backup attempt ${claim.attemptId} holds this root until ${claim.deadline} (process ${claim.coordinator.pid}); if it was stopped, run ${recover} once it has exited`;
}

/** Local boot and additive intents are recovery coordinates, not evidence of native state. */
function readBootAttempts(root: string, gaps: Gaps): NonNullable<StatusResult["bootAttempts"]> {
  // A refusal with its own cause, such as a root other local accounts can write, is named.
  const because = (error: unknown) => isCommandFailure(error) ? ` (${error.message})` : "";
  const result: NonNullable<StatusResult["bootAttempts"]> = { root, state: "not-checked", observedAt: new Date().toISOString(), unsettled: [], additive: [], unreadable: [] };
  try {
    if (!realDirNoSymlink(root, ".cotal")) return result;
    const attempts = listFreshTeamAttempts(root), summaries = listFreshTeamSummaries(root);
    const byId = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
    result.unsettled = attempts.valid.filter((attempt) => !freshTeamAttemptSettled(attempt, byId.get(attempt.deploymentId)))
      .map(({ deploymentId, space, server, createdAt }) => ({ deploymentId, space, server: brokerAddressForDisplay(server) ?? "not displayable", createdAt }));
    const unreadable = [...attempts.refused, ...summaries.refused].map(({ path }) => path);
    result.unreadable.push(...unreadable);
    if (unreadable.length) gaps.add("FRESH_BOOT_RECORD_UNREADABLE", "one or more fresh boot attempts or returned summaries are unreadable; their outcomes were not treated as absent", { root, paths: unreadable });
  } catch (error) {
    result.state = "partial";
    gaps.add("FRESH_BOOT_RECORD_UNAVAILABLE", `this folder's fresh boot attempt inventory could not be read${because(error)}; no empty inventory was inferred`, { root });
  }
  try {
    const additive = listAdditiveTeamAttempts(root);
    result.additive = additive.valid.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: additiveTeamRecordedState(attempt, additive) }));
    const unreadable = additive.refused.map(({ path }) => path);
    result.unreadable.push(...unreadable);
    if (unreadable.length) gaps.add("ADDITIVE_ATTEMPT_UNREADABLE", "one or more additive attempts are unreadable; their effects were not treated as absent", { root, paths: unreadable });
  } catch (error) {
    result.state = "partial";
    gaps.add("ADDITIVE_ATTEMPT_UNAVAILABLE", `this folder's additive attempt inventory could not be read${because(error)}; no empty inventory was inferred`, { root });
  }
  if (result.state !== "partial") result.state = result.unreadable.length ? "partial" : "read";
  result.observedAt = new Date().toISOString();
  return result;
}

/** Separate the new owned-controller records from legacy pidfiles and remote registrations.
 *  An unreadable family is null and makes the report partial, never a complete empty list. */
function readOwnedServices(selected: Selected, gaps: Gaps): OwnedServiceStatus {
  const result: OwnedServiceStatus = { space: selected.ok ? selected.target.space : null, state: "not-checked", observedAt: new Date().toISOString(), atomicSnapshot: false, definitions: null, instances: null, scope: "selected-space local owned records; no remote registration or fresh endpoint probe" };
  if (!selected.ok) return result;
  const space = selected.target.space;
  try { result.definitions = serviceDefinitionStore(space).list().map(serviceDefinitionProjection); }
  catch (error) {
    const causeCode = isCommandFailure(error) ? error.code : "TARGET_UNAVAILABLE";
    gaps.add("SERVICE_DEFINITIONS_UNAVAILABLE", `the selected space's owned service definitions could not be read (${causeCode}); no empty inventory or repair was inferred`, { space, causeCode });
  }
  try { result.instances = serviceInstances(space).map(instanceProjection); }
  catch (error) {
    const causeCode = isCommandFailure(error) ? error.code : "TARGET_UNAVAILABLE";
    gaps.add("SERVICE_INSTANCES_UNAVAILABLE", `the selected space's owned service instance observations could not be established (${causeCode}); no stopped, empty or serving state was inferred`, { space, causeCode });
  }
  result.state = result.definitions === null || result.instances === null ? "partial" : "read";
  result.observedAt = new Date().toISOString();
  return result;
}

async function readMachine(selected: Selected, gaps: Gaps): Promise<StatusResult["machine"]> {
  const m = await machineStatus();
  let defaults: StatusResult["machine"]["defaults"] = null;
  try {
    const context = { preferences: cachedPreferences(), space: selected.ok ? selected.target.space : undefined };
    defaults = { harness: resolvePreference("harness", context).value, persona: resolvePreference("persona", context).value };
  } catch {
    gaps.add("PREFERENCES_UNREADABLE", "the saved agent defaults could not be read");
  }
  let connectors: HarnessStatus[] | null = null;
  const integrations: StatusResult["machine"]["integrations"] = [];
  try {
    connectors = connectorHarnesses();
  } catch (e) {
    gaps.add("CONNECTORS_UNREADABLE", `the installed connectors could not be listed: ${(e as Error).message}`);
  }
  if (connectors) {
    const signedIn = selected.ok && selected.target.mode === "user" ? await signedInSpace(selected.target) : undefined;
    for (const r of await connectorStatusRows(connectors, signedIn)) integrations.push({ name: r.label, state: r.state, text: r.text });
  }
  let installed: boolean | null = null;
  let installedError: string | null = null;
  try {
    installed = webInstalled();
  } catch (e) {
    installedError = (e as Error).message;
    gaps.add("WEB_UNREADABLE", `the web extension's record could not be read: ${installedError}`);
  }
  let url: string | null = null;
  let urlError: string | null = null;
  try {
    url = (selected.ok ? recordedWebUrl({ root: selected.target.root, space: selected.target.space }) : undefined) ?? null;
  } catch (e) {
    // An unreadable `web.pid` or session record is named on the row, like the folder's process rows,
    // so the rest of status still prints.
    urlError = (e as Error).message;
    gaps.add("WEB_UNREADABLE", `the dashboard's records could not be read: ${urlError}`);
  }
  return {
    version: cliVersion(),
    node: process.version,
    platform: `${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : process.platform} ${process.arch}`,
    install: cliProvenance(),
    nats: m.nats,
    integrations,
    defaults,
    connectors: connectors?.map((h) => ({ name: h.name, requires: [...h.requires], missing: h.missing })) ?? null,
    skills: readSkills(gaps),
    web: { installed, installedError, url, urlError },
  };
}

/** Cotal's authored skills reach non-Claude harnesses through the cross-vendor `~/.agents/skills`
 *  directory (Codex, Cursor, OpenCode, Gemini CLI, Windsurf). Those harnesses have no remote update, so
 *  surface a stale/missing/retired drop here and point at the skills-only write (`cotal setup --skills`).
 *  A corrupt skills bundle throws (fail-loud); we report that as an integrity error rather than "none shipped". */
function readSkills(gaps: Gaps): StatusResult["machine"]["skills"] {
  let skew;
  try {
    skew = agentSkillsSkew();
  } catch (e) {
    gaps.add("SKILLS_UNREADABLE", `the skills bundle could not be read: ${(e as Error).message}`);
    return { state: "unreadable", total: 0, behind: 0, retired: 0, error: (e as Error).message };
  }
  const behind = skew.filter((s) => s.state !== "current");
  const retired = behind.filter((s) => s.state === "retired").length;
  const state = !behind.length ? "current" : behind.every((s) => s.state === "missing") ? "not-installed" : "behind";
  return { state, total: skew.length, behind: behind.length, retired, error: null };
}

/** The installed extensions (seeded built-in connectors + operator `ext add`s) with their pinned
 *  versions. The root plus an explicit empty state answers "where do these live / is anything
 *  installed", which is ambiguous on a fresh binary before its first seed. Versions are the manifest
 *  pin (add-time), not a live on-disk/host-compat check. */
function readExtensions(gaps: Gaps): StatusResult["extensions"] {
  const { versions, unreadable } = readExtensionVersions();
  if (unreadable !== undefined) gaps.add("EXTENSIONS_UNREADABLE", `the extensions manifest could not be read: ${unreadable}`);
  return { root: extensionsDir(), items: unreadable === undefined ? versions.map((e) => ({ package: e.pkg, label: e.label, version: e.version })) : null };
}

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
 *  same concession `waitForDeliveryLease` makes for an adopted daemon. Any failure yields `undefined`
 *  rather than a wrong id, because a WRONG expected holder is worse than an unchecked one. */
async function expectedDeliveryHolder(target: MeshTarget): Promise<string | undefined> {
  try {
    const creds = await workspaceSecretStore(target.root).get(
      deliveryCredsKey(target.space, { injected: false, root: target.root }),
    );
    if (!creds) return undefined;
    // The daemon declares no owner/actor, so the endpoint falls back to DEV_OWNER for the owner and
    // to the connection id for the actor: `local.<idFromCreds>`. Built through `principalKey` rather
    // than string concatenation so this tracks the one definition of the dot-form.
    return principalKey(DEV_OWNER, idFromCreds(creds)).key;
  } catch {
    return undefined;
  }
}

/** Read the delivery responder axis for the bare-status rows (#1576).
 *
 *  ONE SHORT-LIVED READ-ONLY CONNECTION, and it must never turn status into a command that fails.
 *  Everything that can go wrong here — no resolvable target, an unreachable broker, a user-auth mesh
 *  where status is forbidden to mint, a cred minted before the read grant existed — yields `unknown`,
 *  which the renderer states as "unchecked" rather than implying either health. The one thing it may
 *  not do is return `bound` on a failed read; that is the false green this whole change removes.
 *
 *  USER MODE IS DELIBERATELY `unknown` RATHER THAN CONNECTED. The flip forbids status from
 *  static-minting on a user-auth mesh, and borrowing the operator's bearer for a health probe is a
 *  bigger decision than this fix should make silently. Those operators get the axis from
 *  `--components`, and the row says so instead of guessing.
 *
 *  `leased` says whether the read found a delivery lease record. An open mesh runs no delivery
 *  daemon, so there a missing lease is the normal state rather than an unbound responder. */
async function readResponderAxis(selected: Selected): Promise<{ state: DeliveryResponderState; leased: boolean }> {
  let leased = false;
  if (!selected.ok) return { state: "unknown", leased };
  const target = selected.target;
  if (target.mode === "user") return { state: "unknown", leased };
  try {
    const preflight = await preflightTarget(target);
    if (!preflight.ok) return { state: "unknown", leased };
    const id = newIdentity();
    const creds = target.auth ? await mintCreds(target.auth, id, "observer") : undefined;
    const ep = new CotalEndpoint({
      space: target.space,
      servers: target.server,
      tls: target.tlsRequired,
      creds,
      channels: [],
      consume: false,
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      card: { id: id.id, name: "status-responder", kind: "endpoint" },
    });
    ep.on("error", () => {});
    // NAMED, not anonymous, because the warning census requires every registration in this tree to
    // declare its disposition and be findable by name (`bin/smoke/endpoint-warning-consumers`). An
    // anonymous handler is an unnamed consumer, which is the thing that census exists to refuse.
    // This probe is a one-shot lease read whose own result is the verdict: a recoverable side-channel
    // warning would add noise to a row that already says `unchecked` when the read does not land.
    const ignoreResponderWarning = () => {};
    ep.on("warning", ignoreResponderWarning);
    await ep.start();
    try {
      // The holder is resolved BEFORE the read so a dead daemon's surviving `ready:true` cannot be
      // mistaken for the live one's (#837): `ready` alone says some daemon bound recently enough that
      // its record has not expired, which is not the question this row asks.
      //
      // This surface reduces a FAILED read to `unchecked`, which is exactly what
      // `deliveryResponderState` encapsulates, so it is called here rather than hand-rolled. The
      // `--components` surface deliberately does NOT use it: that surface must tell a missing lease
      // stream apart from a refused read, and flattening both to `unknown` would erase a
      // distinction it reports.
      const holder = await expectedDeliveryHolder(target);
      const state = await deliveryResponderState(
        async () => { const lease = await ep.readDeliveryLease(0); leased = lease !== undefined; return lease; },
        holder,
      );
      // A daemon killed before it could release shard 0 leaves its ready row, which names this
      // folder's credential, until the bucket TTL removes it. When this folder's delivery pidfile
      // names a process that is gone, that row is the dead daemon's, the same rule `up` waits on.
      return { state: state === "bound" && holder !== undefined && processRecord(DELIVERY_PIDFILE, { root: target.root, space: target.space }).kind === "dead" ? "stale" : state, leased };
    } finally {
      await ep.stop().catch(() => {});
    }
  } catch {
    return { state: "unknown", leased };
  }
}

async function readFolder(root: string, selected: Selected, values: FlagValues<typeof statusFlags>, responder: DeliveryResponderState, gaps: Gaps, hints: string[]): Promise<StatusResult["folder"]> {
  const cmd = displayCmd();
  const folder = (auth: StatusResult["folder"]["auth"], processes: ProcessRow[] | null = null, storedState = false, processSpace: string | null = null, controllerStack = false): StatusResult["folder"] => ({
    root,
    auth,
    ...folderPersonas(root, selected, values, gaps, hints),
    processes,
    processSpace,
    storedState,
    controllerStack,
  });
  const unreadable = (error: string, hint: string): StatusResult["folder"] => {
    gaps.add("AUTH_UNREADABLE", `this folder's trust material could not be read: ${error}`, { root });
    hints.push(hint);
    return folder({ state: "unreadable", spaces: [], userAuth: false, error });
  };
  // The inventory READ itself can throw (an EACCES/ELOOP on `.cotal/auth`, not just a bad record):
  // `accountInventory` lets that propagate so the broker-wide guards fail CLOSED, but status is the
  // recovery command and must report any trust material it cannot read. Frame the unreadable auth
  // dir and stop.
  let spaces: string[];
  let corrupt: string[];
  try {
    ({ spaces, corrupt } = accountInventory(authDir(root)));
  } catch (e) {
    return unreadable(`auth dir unreadable · ${(e as Error).message}`, `check permissions on ${authDir(root)} - broker-wide commands refuse while the tenant list cannot be read`);
  }
  // Status is the command the broker-wide refusals send the operator to, so it must DESCRIBE every
  // state those refusals can name - crashing on one is a dead end in the exact recovery flow. An
  // unreadable record means the tenant list is uncertain: report it (the space-blind sole-load
  // below would throw on it).
  if (corrupt.length > 0)
    return unreadable(
      `${corrupt.length} unreadable account record(s) · ${corrupt.join(", ")}`,
      `repair or remove ${corrupt.map((f) => join(authDir(root), f)).join(", ")} - broker-wide commands refuse while the tenant list is uncertain`,
    );
  // A root holding several accounts has no single "this folder's space", and the process rows below
  // are keyed by one. Report the tenant list instead of letting the space-blind read throw.
  if (spaces.length > 1) return folder({ state: "spaces", spaces, userAuth: false, error: null });
  // The inventory shape-check is necessary but not sufficient: a record can carry non-empty
  // account fields yet fail COMPOSITION (a malformed account JWT, or one signed by a foreign
  // operator - `composeSpaceAuth` throws on both). Status is the recovery command the broker-wide
  // refusals point at, so it must report any record it cannot load with guidance, not crash on
  // the ones the cheap shape gate lets through. Frame the load failure the same as an unreadable
  // record and stop.
  let auth: ReturnType<typeof loadSoleSpaceAuth>;
  try {
    auth = loadSoleSpaceAuth(authDir(root));
  } catch (e) {
    return unreadable(`unreadable trust material · ${(e as Error).message.split(" - ")[0]}`, (e as Error).message);
  }
  const userDisk = Boolean(auth && hasUserAuthState(root, auth.space));
  // An open mesh has no account record to name its space, so the folder's space is read off its
  // runtime records - and a root whose records show two spaces RUNNING has no single answer, the
  // same shape as the multi-account case above. The process rows below are keyed by one space, so
  // report that state and stop rather than crashing in the recovery command that names it.
  let space: string;
  try {
    space = auth?.space ?? resolveRuntimeSpace(root);
  } catch (e) {
    hints.push((e as Error).message);
    return folder({ state: "none", spaces: [], userAuth: false, error: null });
  }
  const context: LocalProcessContext = { root, space, userAuth: userDisk };
  const processes: ProcessRow[] = [];
  let nats: Proc | undefined;
  for (const component of localProcessSurface().filter((component) => localProcessVisible(component, context)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
    let state: Proc;
    try {
      state = pidfileState(localProcessPath(component.pidFile, context));
    } catch (e) {
      // `localProcessPath` throws on an ambiguous record and `pidfileState` on one it cannot read, so
      // `clean` and `down` refuse to act on either. Status is the recovery command: name the failed
      // read on this row and report the rest.
      gaps.add("PIDFILE_UNREADABLE", `the ${component.name} pidfile could not be read: ${(e as Error).message}`, { root, space, process: component.name });
      processes.push({ name: component.name, state: "unreadable", pid: null, detail: `pidfile unreadable · ${(e as Error).message}` });
      continue;
    }
    if (component.name === "nats") nats = state;
    // #2073: a live manager pid used to print green `running` on the pidfile alone, which is how
    // a manager whose service rail had died read as healthy for hours. One probe of the service
    // endpoint now decides the row; see `managerProcess`.
    if (component.name === "manager") processes.push(await managerProcess(selected.ok ? selected.target : undefined, state, context.space, gaps));
    // THE #1576 ROW. A live delivery PID is not the fact an operator needs; the responder is.
    // A live pid alone read as `delivery running (pid N)` identically over a bound responder and one
    // that never bound. The detail names which it is, and when unbound it names the CONSEQUENCE
    // rather than a reconcile that has not happened yet.
    else processes.push(processRow(component.name, state, component.name === "delivery" ? deliveryDetail(state.liveness === "alive", responder) : null));
  }
  // A stopped mesh with a persisted store: name the reset verb. Stale state (e.g. durables from
  // an older Cotal generation) is otherwise invisible until a spawn fails on it. The restart is
  // deliberately "your usual flags", never a bare `up` (mode/name/store-dir aren't recorded).
  // A controller stack's broker has no legacy pidfile, so that heuristic says nothing about it.
  let controllerStack = false;
  try { controllerStack = readStackJournal(root)?.journal.space === space; } catch { controllerStack = false; }
  const storedState = !controllerStack && nats?.liveness !== "alive" && existsSync(join(root, ".cotal", "nats"));
  // While a maintenance journal holds the store, clean store refuses, so it is not offered.
  let maintained = false;
  try { maintained = readMaintenanceJournal(root) !== undefined; } catch { maintained = true; }
  if (storedState && !maintained) hints.push(`if the stored JetStream state is stale: ${cmd} clean store --force, then \`up\` with your usual flags (\`clean all\` also resets identity)`);
  return folder({ state: auth ? "space" : "none", spaces: auth ? [auth.space] : [], userAuth: userDisk, error: null }, processes, storedState, space, controllerStack);
}

/** The folder's persona catalog, which must never let a catalog imply a `spawn` the operator does
 *  not have.
 *
 *  The row used to read `personas  default` in green under "This Folder" while `cotal spawn` in the
 *  same second refused with "no default persona yet". Both were right about their OWN root and
 *  neither NAMED it: the folder's catalog is `<cwd-root>/.cotal/agents`, and spawn loads the
 *  RESOLVED mesh's `target.personaRoot`, which is a different directory whenever `cotal use`, a
 *  `--space`, or the registry's sole entry points elsewhere. The listed names and the launchable
 *  names were disjoint sets.
 *
 *  So: always name the root each summary describes, and say whether the folder's catalog is the one
 *  a bare spawn launches from (`launches`): true when the two roots are one directory, false when the
 *  selected mesh's root differs, null when no mesh resolves and nothing is launchable here. */
function folderPersonas(root: string, selected: Selected, values: FlagValues<typeof statusFlags>, gaps: Gaps, hints: string[]): Pick<StatusResult["folder"], "personas" | "launches"> {
  const personas = personaCatalog(root, gaps);
  if (!selected.ok) return { personas, launches: null };
  if (sameDir(personaDir(root), selected.target.personaRoot)) return { personas, launches: true };
  hints.push(
    `a bare \`${displayCmd()} spawn\` uses the selected mesh, NOT this folder - personas in ${personaDir(root)} will not launch until you run it from that mesh's root or select it (\`${displayCmd()} use <space>\`${values.space ? "" : ", or pass `--space`"})`,
  );
  return { personas, launches: false };
}

/** Summarize the catalog through the shipped loader. A file is launchable only when
 *  {@link readPersonas} parsed it with the same {@code loadAgentFile} path spawn uses. Only an absent
 *  directory is an empty catalog: one that cannot be read is a gap, not `missing`. */
function personaCatalog(root: string, gaps: Gaps): PersonaCatalog {
  let personas: PersonaEntry[];
  try {
    personas = readPersonas(root);
  } catch (e) {
    const error = (e as Error).message;
    gaps.add("PERSONAS_UNREADABLE", `the persona catalog ${personaDir(root)} could not be read: ${error}`, { root: personaDir(root) });
    return { root: personaDir(root), default: "unreadable", demo: null, error };
  }
  const byName = new Map(personas.map((persona) => [persona.name, persona]));
  const def = byName.get("default");
  return {
    root: personaDir(root),
    default: def?.def ? "valid" : def?.error ? "invalid" : "missing",
    demo: ["david", "sven", "me"].filter((name) => byName.get(name)?.def !== undefined).length,
    error: null,
  };
}

/** Do two catalog paths denote the SAME directory? `canonicalRoot` (realpath, `resolve` fallback
 *  for a path not on disk) is the repo's one spelling for this: a raw `===` reads a symlinked or
 *  8.3-short-name spelling of one directory as two, which here would fabricate a divergence and
 *  send the operator chasing a split that does not exist. */
function sameDir(a: string, b: string): boolean {
  return canonicalRoot(a) === canonicalRoot(b);
}

function processRow(name: string, p: Proc, detail: string | null): ProcessRow {
  if (p.liveness === "alive") return { name, state: "running", pid: p.pid ?? null, detail };
  return { name, state: p.liveness === "unknown" ? "unknown" : "stopped", pid: p.pid ?? null, detail: p.note ?? null };
}

/** Bare status's manager row, #2073: a live pid alone is not proof the manager serves — that was
 *  exactly the incident (a lease holder whose service rail had died stayed `running` for hours).
 *  So a live manager pid gets ONE probe of its own service endpoint before the row is reported. This
 *  adds one request to every bare `status` call for a live manager pid.
 *
 *  Three outcomes:
 *  - answered: `running` with the delivery-aware detail.
 *  - a DEFINITIVE no-answer — the same predicate `managerHealth`'s not-serving branch uses
 *    (`unansweredRequest`, or the service-registry-missing text): `not-serving` with
 *    `service endpoint not answering`, plus the marker error when the marker could not be read.
 *  - any other failure (a refused probe, an `unavailable` user-mode credential): `running` with
 *    `service unchecked`, so a failed probe never reads as a dead rail.
 *
 *  A dead/stopped pid never reaches the probe at all (the early return below), so a stopped manager
 *  still reads as stopped, not `not-serving` — a dead pid is not a live pid that will not answer. */
async function managerProcess(target: MeshTarget | undefined, state: Proc, space: string, gaps: Gaps): Promise<ProcessRow> {
  if (state.liveness !== "alive") return processRow("manager", state, null);
  const details: string[] = [];
  let deliveryAware = false;
  try {
    deliveryAware = managerHasDeliveryMarker(state.pid!, space);
    details.push(deliveryAware ? "delivery-aware" : "old/unknown build");
  } catch (e) {
    // The marker reader throws so `up` and the delivery preflight refuse to act on a marker they
    // cannot read. Status is the recovery command: name the failed read on this row and report the rest.
    details.push(`delivery-aware marker unreadable: ${(e as Error).message}`);
    gaps.add("MARKER_UNREADABLE", `the manager's delivery-aware marker could not be read: ${(e as Error).message}`, { space, process: "manager" });
  }
  const running = (extra?: string): ProcessRow => ({ name: "manager", state: "running", pid: state.pid ?? null, detail: [...details, ...(extra ? [extra] : [])].join(" · ") });
  if (!target) return running();
  try {
    let auth: ({ creds?: string } | { bearer: string; sentinelCreds: string }) & { caller: { owner: string; actor: string; uid: string } };
    if (target.mode === "user") {
      const credential = await componentCredential(target);
      if (credential.kind !== "user") return running("service unchecked");
      auth = { bearer: credential.bearer, sentinelCreds: credential.sentinelCreds, caller: credential.caller };
    } else {
      auth = await staticServiceAuth(target.auth);
    }
    await managerServiceHealth(target, auth);
    return running();
  } catch (e) {
    const noService = e instanceof EpEnvelopeError && (unansweredRequest(e) || /service registry.*stream not found/i.test((e as Error).message));
    if (noService)
      return { name: "manager", state: "not-serving", pid: state.pid ?? null, detail: ["service endpoint not answering", ...details.filter((d) => d.startsWith("delivery-aware marker unreadable"))].join(" · ") };
    return running("service unchecked");
  }
}

/** The delivery row's responder detail (#1576). An unbound responder is not a footnote about a
 *  component: while it holds, the mesh cannot spawn, retire or accept a join, and the whole reported
 *  incident is that this read as ordinary. `unknown` names `--components`, because an unchecked axis
 *  must not look like a diagnosis in either direction. */
function deliveryDetail(live: boolean, responder: DeliveryResponderState): string | null {
  return deliveryRowSuffix(live, responder, `${displayCmd()} status --components`).replace(/^ · /, "") || null;
}

/** The recorded meshes. Only the selected one is checked unless `--all` asks for every one; each
 *  check dials that record's own address with its own recorded TLS requirement. A bare TCP/INFO
 *  probe would green-light a plaintext broker that has substituted for a TLS-required mesh — the
 *  FAIL1 attack — so a list that only asks "is anything listening" cannot report on the one property
 *  the record claims. */
async function readMeshes(selected: Selected, all: boolean, gaps: Gaps): Promise<StatusResult["meshes"]> {
  // A registry file that cannot be read is named, and the readable records are still listed and
  // checked. Only an absent directory or pointer is an empty registry or no current mesh.
  const unreadable: StatusResult["meshes"]["unreadable"] = [];
  const unread = (file: string, error: string) => {
    unreadable.push({ file, error });
    gaps.add("MESH_REGISTRY_UNREADABLE", error, { file });
  };
  let entries: MeshEntry[] = [];
  try {
    const registry = readMeshRegistry();
    entries = registry.entries;
    for (const e of registry.unusable) unread(e.file, e.message);
  } catch (e) {
    if (!isMeshRegistryError(e)) throw e;
    unread(e.file, e.message);
  }
  let current: string | null = null;
  try {
    current = readCurrent() ?? null;
  } catch (e) {
    if (!isMeshRegistryError(e)) throw e;
    unread(e.file, e.message);
  }
  const chosen = selected.ok ? selected.target.space : undefined;
  const items = await Promise.all(
    entries.map(async (m) => ({
      space: m.space,
      server: displayStatusBroker(m.server, m.space, gaps),
      mode: m.mode,
      root: m.root,
      origin: m.origin ?? null,
      tlsRequired: Boolean(m.tlsRequired),
      eventsRequired: m.policy?.events === "required",
      current: m.space === current,
      check: all || m.space === chosen ? ((await isReachable(m.server, m.tlsRequired ? { tls: true } : {})) ? "reachable" as const : "unreachable" as const) : "not-checked" as const,
      catalog: m.origin === "catalog" ? { name: m.catalogName && m.catalogName !== m.space ? m.catalogName : null, fetchedAt: m.catalogFetchedAt ?? null, error: m.catalogError ?? null } : null,
    })),
  );
  return {
    current,
    currentRecorded: current === null || entries.some((m) => m.space === current),
    currentPrepared: current !== null && !entries.some((m) => m.space === current) && findPreparedSpace(current) !== undefined,
    unreadable,
    items,
    catalogs: preparedCatalogDiagnostics().map((r) => ({ idp: r.account.idpUrl, state: r.state, error: r.state === "failed" ? (r.error ?? "refresh failed") : null })),
  };
}

async function readSelected(selected: Selected, responder: { state: DeliveryResponderState; leased: boolean }, gaps: Gaps, hints: string[]): Promise<SelectedResult> {
  const cmd = displayCmd();
  if (!selected.ok) {
    const e = selected.error;
    // Resolution reads the whole registry and refuses a directory or record it cannot use. The meshes
    // reader has already named it, so this is the same gap, and the selection is unresolved.
    if (isMeshRegistryError(e)) {
      gaps.add("MESH_REGISTRY_UNREADABLE", e.message, { file: e.file });
      hints.push(e.message);
      return { resolved: false, code: "registry-unreadable", message: e.message };
    }
    if (e instanceof UnregisteredRoot) {
      const message = `no space is registered or prepared here for ${e.root}`;
      hints.push(`${message} - run \`${cmd} up\` there to start one, or select a space with \`${cmd} use <name>\``);
      return { resolved: false, code: "unregistered-root", message };
    }
    if (!isWorkspaceTargetError(e)) throw e;
    // The canonical renderer names the ACTUAL repair per code (`cotal meshes rm`, `--space
    // <name>`, `cotal up --user-auth`, …). A fixed `up --detach` hint would be right for at most one
    // of the codes and point the others at a command that does not fix them.
    const message = renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, "");
    hints.push(message);
    return { resolved: false, code: e.code, message };
  }
  const target = selected.target;
  const base = {
    resolved: true as const,
    space: target.space,
    server: displayStatusBroker(target.server, target.space, gaps),
    mode: target.mode,
    source: target.source,
    root: target.root,
    tlsRequired: Boolean(target.tlsRequired),
    eventsRequired: target.policy?.events === "required",
    idp: target.userAuth?.idp.url ?? null,
    personas: personaCatalog(target.root, gaps),
    staleRecord: false,
    login: null,
    deliveryResponder: null,
    channels: null,
    membershipFeed: null,
  };
  if (target.mode === "user") {
    // Status never static-mints on a user-auth mesh (the flip). Everything here is offline
    // introspection — the login cache + the locally-readable ledger — plus, only when this
    // machine holds a signed-in AND granted login, a real user-mode connect for the snapshot.
    // Same transport discipline as the open/auth path below: a recorded TLS requirement must
    // not collapse to a bare reachability probe (that green-lights a plaintext substitute).
    const live = await isReachable(target.server, target.tlsRequired ? { tls: true } : {});
    const stateDir = userAuthStateDir(target.root, target.space);
    let st: UserAuthStatus | undefined;
    try {
      st = await resolveAuthProvider().userStatus({ store: workspaceSecretStore(target.root), dir: stateDir, space: target.space, actor: CLI_USER_ACTOR });
    } catch (e) {
      gaps.add("LOGIN_UNREADABLE", `the login for ${target.space} could not be read: ${(e as Error).message}`, { space: target.space });
    }
    const login: Extract<SelectedResult, { resolved: true }>["login"] = st
      ? {
          idp: st.idpUrl,
          subject: st.login?.sub ?? null,
          expiresAt: st.login ? new Date(st.login.expiresAt * 1000).toISOString() : null,
          actor: !st.login ? null : st.grant === "not-granted" ? "not-granted" : st.grant ? "granted" : "not-checkable",
          grant: st.login && st.grant && st.grant !== "not-granted" ? { label: st.grant.label ?? null, read: [...st.grant.allowSubscribe], post: [...st.grant.allowPublish], scope: [...st.grant.scope] } : null,
        }
      : null;
    const granted = Boolean(st?.login && st.grant && st.grant !== "not-granted");
    const result = { ...base, connection: live ? "reachable" : "unreachable", login };
    if (!live) return { ...result, snapshot: { state: "skipped", reason: "broker unreachable" } };
    if (!granted) return { ...result, snapshot: { state: "skipped", reason: "needs a signed-in, granted login" } };
    return { ...result, ...(await readSnapshot(() => userSnapshotEndpoint(target, stateDir), target.space, gaps)) };
  }
  const preflight = await preflightTarget(target);
  if (!preflight.ok) return { ...base, connection: preflight.kind, staleRecord: preflight.prune, snapshot: { state: "skipped", reason: "broker not connected" } };
  // The mesh-level statement of the same axis (#1576). The folder section says what this machine's
  // delivery PROCESS is doing; this says whether the SPACE currently has a bound responder, which is
  // the question "can I spawn into this mesh right now" actually reduces to. An operator reading a
  // reachable broker and a running daemon had, before this, no row that said otherwise.
  return { ...base, connection: "ok", deliveryResponder: target.mode === "open" && !responder.leased ? null : responder.state, ...(await readSnapshot(() => snapshotEndpoint(target), target.space, gaps)) };
}

async function snapshotEndpoint(target: MeshTarget): Promise<CotalEndpoint> {
  const id = newIdentity();
  const creds = target.auth ? await mintCreds(target.auth, id, "observer") : undefined;
  return new CotalEndpoint({
    space: target.space,
    servers: target.server,
    // The recorded requirement, for the same reason as the preflight probe: a monitoring command
    // that connects to whatever answers on the address cannot report on the one property this
    // feature provides, and reporting "ok" against a substituted plaintext broker is worse than
    // reporting nothing.
    tls: target.tlsRequired,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    // In open mode the endpoint lazily creates KV buckets for watches. Keep status read-only.
    watchPresence: false,
    watchChannels: Boolean(target.auth),
    card: { id: id.id, name: "status", kind: "endpoint" },
  });
}

/** The user-auth snapshot endpoint, connected as THIS machine's signed-in, ledger-granted login
 *  (bearer + sentinel — the flip forbids a status mint). */
async function userSnapshotEndpoint(target: MeshTarget, stateDir: string): Promise<CotalEndpoint> {
  const { bearer, sentinelCreds } = await resolveAuthProvider().userCredentials({
    store: workspaceSecretStore(target.root),
    dir: stateDir,
    space: target.space,
    actor: CLI_USER_ACTOR,
  });
  return new CotalEndpoint({
    space: target.space,
    servers: target.server,
    // Same reason as the static path: the recorded requirement is the primary fence against a
    // forged INFO, and a monitoring snapshot that auto-upgrades cannot report on it.
    tls: target.tlsRequired,
    bearer,
    sentinelCreds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: true,
    card: { name: "status", kind: "endpoint" }, // card.id derives from the bearer principal
  });
}

/** The selected space's channels and membership feed, read over one short-lived connection. The
 *  roster is not part of status: who is present is a separate read. */
async function readSnapshot(
  endpoint: () => Promise<CotalEndpoint>,
  space: string,
  gaps: Gaps,
): Promise<Pick<Extract<SelectedResult, { resolved: true }>, "snapshot" | "channels" | "membershipFeed">> {
  let ep: CotalEndpoint;
  try {
    ep = await endpoint();
    ep.on("error", () => {});
    // This endpoint is a one-shot read. Awaited reads and their per-row unavailable results own the
    // verdict, so a recoverable side channel is deliberately quiet rather than duplicated.
    const ignoreSnapshotWarning = () => {};
    ep.on("warning", ignoreSnapshotWarning);
    await ep.start();
  } catch (e) {
    gaps.add("SNAPSHOT_UNAVAILABLE", `the channels of ${space} could not be read: ${(e as Error).message}`, { space });
    return { snapshot: { state: "unavailable", reason: (e as Error).message }, channels: null, membershipFeed: null };
  }
  try {
    const channels = await ep.listChannels();
    const feed = await ep.readMembership().catch(() => undefined);
    return {
      snapshot: { state: "read", reason: null },
      channels: channels.map((ch) => ({ channel: ch.channel, messages: ch.messages })),
      membershipFeed: feed ? { entries: feed.members.length, asOf: feed.asOf ? new Date(feed.asOf).toISOString() : null } : null,
    };
  } catch (e) {
    gaps.add("SNAPSHOT_UNAVAILABLE", `the channels of ${space} could not be read: ${(e as Error).message}`, { space });
    return { snapshot: { state: "unavailable", reason: (e as Error).message }, channels: null, membershipFeed: null };
  } finally {
    await ep.stop().catch(() => {});
  }
}

// ---- the report ------------------------------------------------------------------------------

const cell = (text: string, tone?: Tone): Cell => (tone ? { text, tone } : text);

function personaText(p: PersonaCatalog): string {
  if (p.default === "unreadable") return `unreadable: ${p.error}`;
  const parts = [p.default === "valid" ? "default" : p.default === "invalid" ? "invalid default" : "no default"];
  if (p.demo) parts.push(`demo team ${p.demo}/3`);
  return parts.join(" · ");
}

function personaTone(p: PersonaCatalog): Tone {
  return p.default === "valid" ? "ok" : p.default === "invalid" || p.default === "unreadable" ? "failed" : "hint";
}

/** A catalog's summary and root. Green only for a `default` that loads, and never for a catalog
 *  `dim` marks as not the one spawn launches from. */
function personaCell(p: PersonaCatalog, dim = false): Cell {
  const tone: Tone = dim ? "hint" : personaTone(p);
  return cell(`${personaText(p)} · ${p.root}`, tone);
}

function processCell(p: ProcessRow): Cell {
  const detail = p.detail ? ` · ${p.detail}` : "";
  if (p.state === "unreadable") return cell(p.detail ?? "pidfile unreadable", "failed");
  if (p.state === "not-serving") return cell(`not serving (pid ${p.pid})${detail}`, "failed");
  if (p.state === "running") return cell(`running (pid ${p.pid})${detail}`, /NOT BOUND|unreadable/.test(detail) ? "failed" : "ok");
  return cell(p.pid ? `${p.detail ?? "stopped"} (${p.pid})` : (p.detail ?? "down"), "hint");
}

function skillsCell(s: StatusResult["machine"]["skills"]): Cell {
  const remedy = `${displayCmd()} setup --skills`;
  if (s.state === "unreadable") return cell(`bundle error: ${s.error}`, "failed");
  if (s.state === "current") return cell(`current (${s.total})`, "ok");
  if (s.state === "not-installed") return cell(`not installed · ${remedy}`, "hint");
  return cell(`${s.retired ? `${s.behind} to reconcile (${s.retired} retired)` : `${s.behind}/${s.total} out of date`} · ${remedy}`, "waiting");
}

function machineSection(m: StatusResult["machine"]): Section {
  const tone = { ok: "ok", warn: "waiting", error: "failed", off: "hint" } as const;
  const rows: [string, Cell][] = [
    ["cotal-ai", cell(`v${m.version} (${m.install.kind === "source" ? "source checkout" : m.install.kind}: ${m.install.root})`, "ok")],
    ["NATS", m.nats === "missing" ? cell("missing", "failed") : cell(m.nats === "path" ? "nats-server on PATH" : "bundled nats-server", "ok")],
    ...m.integrations.map((r): [string, Cell] => [r.name, cell(r.text, tone[r.state])]),
  ];
  if (m.connectors === null) rows.push(["Connectors", cell("unreadable - see the warning below", "failed")]);
  else if (!m.connectors.length) rows.push(["Connectors", cell(`none installed · ${displayCmd()} setup`, "hint")]);
  for (const h of m.connectors ?? [])
    rows.push([h.name, h.missing.length ? cell(`${h.missing.join(", ")} not on PATH`, "hint") : cell(h.requires.length ? `${h.requires.join(", ")} on PATH` : "in-process", "ok")]);
  rows.push(["Skills (.agents)", skillsCell(m.skills)]);
  rows.push(["Web extension", m.web.installed === null ? cell(m.web.installedError ?? "unreadable", "failed") : m.web.installed ? cell("installed", "ok") : cell("not installed", "hint")]);
  // An install state that could not be read reads `down`, since only a known absence is `not installed`.
  rows.push(["Web process", m.web.url ? cell(m.web.url, "ok") : m.web.urlError ? cell(m.web.urlError, "failed") : cell(m.web.installed === false ? "not installed" : "down", "hint")]);
  return { title: "Machine", blocks: [{ kind: "fields", rows }] };
}

function extensionsSection(e: StatusResult["extensions"]): Section {
  const rows: [string, Cell][] = [["root", e.root]];
  if (e.items === null) rows.push(["installed", cell("manifest unreadable - see the warning below", "failed")]);
  else if (!e.items.length) rows.push(["installed", cell("none", "hint")]);
  for (const x of e.items ?? []) rows.push([x.label, cell(`v${x.version}${x.package === x.label ? "" : ` · ${x.package}`}`, "ok")]);
  return { title: "Extensions", blocks: [{ kind: "fields", rows }] };
}

function folderSection(f: StatusResult["folder"], selected: SelectedResult): Section {
  const rows: [string, Cell][] = [["root", f.root]];
  const cwd = canonicalRoot(process.cwd());
  if (cwd !== canonicalRoot(f.root) && (canonicalRoot(f.root) === canonicalRoot(homedir()) || canonicalRoot(join(f.root, ".cotal")) === canonicalRoot(homeCotalDir())))
    rows.push(["root selection", cell("inherited the machine's home .cotal; unqualified up refuses before starting there. Prepare this folder with space create <space> --root . before starting it", "waiting")]);
  const auth = f.auth;
  if (auth.state === "unreadable") rows.push(["auth", cell(auth.error ?? "unreadable", "failed")]);
  else if (auth.state === "spaces") rows.push(["auth", cell(`${auth.spaces.length} spaces · ${auth.spaces.join(", ")}`, "ok")]);
  else if (auth.state === "space") rows.push(["auth", cell(`space ${auth.spaces[0]}${auth.userAuth ? " · user-auth" : ""}`, "ok")]);
  else rows.push(["auth", cell("none (open/local only)", "hint")]);
  if (f.launches === null) {
    rows.push(["personas", personaCell(f.personas)]);
    rows.push(["spawn root", cell("unresolved - see Selected Mesh below; until it resolves, no persona here is launchable", "waiting")]);
  } else if (f.launches) rows.push(["personas", personaCell(f.personas)]);
  else {
    // The divergence. The folder's catalog is real and worth reporting, but it is NOT the spawn
    // catalog, so its `default` must not be green: green here is the false capability claim.
    rows.push(["personas", personaCell(f.personas, true)]);
    if (selected.resolved) {
      rows.push(["spawn root", cell(`differs · ${selected.personas.root}`, "waiting")]);
      rows.push(["→ launches", cell(`${personaText(selected.personas)} · space ${selected.space} · via ${selected.source}`, personaTone(selected.personas))]);
    }
  }
  if (auth.state === "spaces") rows.push(["processes", cell("not reported per space on a multi-space root", "hint")]);
  for (const p of f.processes ?? []) rows.push([p.name, processCell(p)]);
  if (f.storedState) rows.push(["stored state", cell("JetStream store persists across down/up", "hint")]);
  return { title: "This Folder", blocks: [{ kind: "fields", rows }] };
}

function meshesSections(m: StatusResult["meshes"]): Section[] {
  const check = { reachable: cell("reachable", "ok"), unreachable: cell("down", "failed"), "not-checked": cell("not checked", "hint") } as const;
  const blocks: Section["blocks"][number][] = [];
  if (!m.items.length && !m.unreadable.length) blocks.push({ kind: "lines", lines: [cell("none", "hint")] });
  else
    blocks.push({
      kind: "table",
      columns: [
        { key: "space", label: "SPACE" },
        { key: "check", label: "CHECK" },
        { key: "mode", label: "MODE" },
        { key: "server", label: "SERVER" },
        { key: "root", label: "ROOT" },
        { key: "note", label: "NOTE" },
      ],
      rows: m.items.map((x) => ({
        space: x.current ? cell(`* ${x.space}`, "selected") : `  ${x.space}`,
        check: check[x.check],
        mode: x.mode,
        server: x.server ?? cell("unavailable", "failed"),
        root: x.root,
        // A `down` record means two different things, and the repair differs: a mesh this machine
        // started can be re-`up`ed here, one registered by hand runs somewhere this machine doesn't
        // control (and, unlike the others, its record is never swept away for it).
        note: [
          x.origin === "manual" ? "registered" : x.origin === "catalog" ? "discovered" : "",
          x.tlsRequired ? "tls-required" : "",
          x.eventsRequired ? "events: required" : "",
          x.catalog ? `${x.catalog.name ? `${x.catalog.name}  ` : ""}catalog ${x.catalog.error ? `stale since ${x.catalog.fetchedAt ?? "unknown"}: ${x.catalog.error}` : `snapshot ${x.catalog.fetchedAt ?? "unknown"}`}` : "",
        ].filter(Boolean).join("  "),
      })),
    });
  if (!m.currentRecorded) blocks.push({ kind: "lines", lines: [cell(`note: current mesh "${m.current}" is ${m.currentPrepared ? "prepared, not started" : "not recorded"}`, "hint")] });
  if (m.unreadable.length) blocks.push({ kind: "lines", lines: m.unreadable.map((u) => cell(`unreadable: ${u.error}`, "failed")) });
  const sections: Section[] = [{ title: "Recorded Meshes", blocks }];
  if (m.catalogs.length)
    sections.push({ title: "Space Catalog Accounts", blocks: [{ kind: "lines", lines: m.catalogs.map((r) => `${r.idp}  ${r.state}${r.error ? `: ${r.error}` : ""}`) }] });
  return sections;
}

/** The selected space's delivery responder (#1576). Bare status and the verbose mesh section both
 *  state it, so an operator on a manager host away from the broker's folder still sees it. An open
 *  mesh runs no delivery daemon, so with no lease recorded its row says the responder is not used
 *  rather than unbound. */
function responderText(state: DeliveryResponderState | null, mode: MeshTarget["mode"]): { text: string; tone: Tone } | undefined {
  if (state === null && mode === "open") return { text: "not used - an open mesh runs no delivery daemon", tone: "hint" };
  if (state === "unbound")
    return { text: `NOT BOUND - ${RESPONDER_UNBOUND_CONSEQUENCE} · start it with \`${displayCmd()} up\` (or \`${displayCmd()} deliver --space <space>\`)`, tone: "failed" };
  // A stale record is NOT BOUND with a different next move: the slot is occupied by a corpse, so
  // starting a daemon now loses the single-flight CAS. Say that, rather than sending the operator
  // into a refusal they will read as a second failure.
  if (state === "stale")
    return { text: `NOT BOUND - a DEAD daemon's ready record still holds the lease - ${RESPONDER_UNBOUND_CONSEQUENCE} · it expires on its own; a replacement can then take the shard`, tone: "failed" };
  if (state === "bound") return { text: "bound", tone: "ok" };
  return undefined;
}

function selectedSection(s: SelectedResult): Section {
  if (!s.resolved) return { title: "Selected Mesh", blocks: [{ kind: "fields", rows: [["target", cell(s.code, "failed")]] }] };
  const rows: [string, Cell][] = [
    ["space", s.space],
    ["server", s.server ?? cell("unavailable", "failed")],
    ["mode", s.mode],
  ];
  if (s.eventsRequired) rows.push(["events", "required"]);
  if (s.tlsRequired) rows.push(["transport", "tls-required"]);
  if (s.idp) rows.push(["idp", s.idp]);
  rows.push(["source", s.source], ["root", s.root], ["personas", personaCell(s.personas)]);
  if (s.mode === "user") {
    rows.push(["connection", s.connection === "reachable" ? cell("reachable", "ok") : cell("unreachable", "failed")]);
    const l = s.login;
    if (!l) rows.push(["login", cell("unreadable - see the warning below", "failed")]);
    if (l && !l.subject) rows.push(["login", cell(`not signed in - ${displayCmd()} login --idp ${l.idp}`, "waiting")]);
    if (l?.subject) {
      rows.push(["login", cell(`${l.subject} · session until ${l.expiresAt}`, "ok")]);
      if (l.actor === "not-granted") rows.push(["actor", cell(`"${CLI_USER_ACTOR}" not granted - ${displayCmd()} actor grant ${CLI_USER_ACTOR} --sub ${l.subject} --full`, "waiting")]);
      else if (l.actor === "granted" && l.grant)
        rows.push([
          "actor",
          cell(`"${CLI_USER_ACTOR}" granted${l.grant.label ? ` (${l.grant.label})` : ""} - read [${l.grant.read.join(", ")}], post [${l.grant.post.join(", ")}]${l.grant.scope.length ? `, scope [${l.grant.scope.join(", ")}]` : ""}`, "ok"),
        ]);
      else rows.push(["actor", cell("grant not checkable on this machine (no local ledger)", "hint")]);
    }
  } else {
    rows.push(["connection", s.connection === "ok" ? cell("ok", "ok") : cell(`${s.connection}${s.staleRecord ? " (stale registry entry)" : ""}`, "failed")]);
    const responder = responderText(s.deliveryResponder, s.mode);
    if (responder) rows.push(["delivery responder", cell(responder.text, responder.tone)]);
  }
  if (s.snapshot.state === "unavailable" || (s.mode === "user" && s.snapshot.state === "skipped")) rows.push(["live snapshot", cell(`${s.snapshot.state === "unavailable" ? "unavailable" : "not read"} (${s.snapshot.reason})`, s.snapshot.state === "unavailable" ? "failed" : "hint")]);
  if (s.channels) rows.push(["channels", s.channels.length ? s.channels.map((ch) => `${ch.channel}(${ch.messages})`).join(", ") : "none"]);
  if (s.membershipFeed)
    rows.push(["membership feed", s.membershipFeed.asOf ? cell(`${s.membershipFeed.entries} entries · updated ${formatAge(Math.max(0, Date.now() - Date.parse(s.membershipFeed.asOf)))} ago`, "ok") : cell("no heartbeat", "hint")]);
  return { title: "Selected Mesh", blocks: [{ kind: "fields", rows }] };
}

function stateCell(text: string, tone: Tone): Cell {
  return { text, tone, mark: tone === "hint" ? "○" : "●" };
}

function machineOverview(r: StatusResult): Section {
  const m = r.machine;
  const tones = { ok: "ok", warn: "waiting", error: "failed", off: "hint" } as const;
  const rows: [string, Cell][] = m.integrations.map((item) => [item.name, stateCell(item.text, tones[item.state])]);
  if (m.connectors === null) rows.push(["Agent applications", stateCell("could not be read", "failed")]);
  else if (!m.connectors.length) rows.push(["Agent applications", stateCell("not set up", "hint")]);
  for (const connector of m.connectors ?? []) {
    if (m.integrations.some((item) => item.name.toLowerCase().includes(connector.name.toLowerCase()))) continue;
    rows.push([connector.name, stateCell(connector.missing.length ? `${connector.missing.join(", ")} not on PATH` : connector.requires.length ? "available on PATH" : "in-process", connector.missing.length ? "waiting" : "ok")]);
  }
  rows.push(["Broker executable", stateCell(m.nats === "missing" ? "not installed" : m.nats === "path" ? "available on PATH" : "bundled", m.nats === "missing" ? "waiting" : "ok")]);
  rows.push(["Agent skills", skillsCell(m.skills)]);
  rows.push(["Dashboard", stateCell(m.web.installed === null ? "installation could not be read" : m.web.installed ? "installed" : "not installed · optional", m.web.installed === null ? "failed" : m.web.installed ? "ok" : "hint")]);
  if (r.extensions.items === null) rows.push(["Extensions", stateCell("manifest could not be read", "failed")]);
  else if (r.extensions.items.length) rows.push(["Extensions", r.extensions.items.map((item) => `${item.label} v${item.version}`).join(" · ")]);
  return {
    title: "This machine",
    blocks: [
      { kind: "lines", lines: [`cotal ${m.version}  ·  Node ${m.node}  ·  ${m.platform}`] },
      { kind: "fields", rows },
    ],
  };
}

function connectionCell(s: Extract<SelectedResult, { resolved: true }>): Cell {
  if (s.connection === "ok" || s.connection === "reachable") return stateCell("reachable", "ok");
  const states: Readonly<Record<string, string>> = {
    unreachable: "unreachable",
    "slow-link": "connection timed out",
    "tls-trust": "TLS could not be verified",
    "stale-auth": "credentials need renewal",
    "auth-required": "authentication required",
    "open-wants-auth": "authentication required",
    "registry-open-now-auth": "authentication required",
    "creds-rejected": "credentials rejected",
    "registry-creds-rejected": "credentials rejected",
  };
  return stateCell(`${states[s.connection] ?? s.connection.replaceAll("-", " ")}${s.staleRecord ? " · saved registration needs attention" : ""}`, "failed");
}

function brokerOverview(r: StatusResult): Section {
  const blocks: Section["blocks"][number][] = [];
  const groups = new Map<string, StatusResult["meshes"]["items"]>();
  for (const entry of r.meshes.items) {
    const key = entry.server ?? `unavailable:${entry.space}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  if (!groups.size && !r.meshes.unreadable.length) blocks.push({ kind: "lines", lines: [cell("No spaces registered", "hint")] });
  for (const entries of groups.values()) {
    blocks.push({ kind: "lines", lines: [cell(entries[0]!.server ?? "Broker address unavailable", "title")] });
    blocks.push({
      kind: "table",
      header: false,
      columns: [{ key: "space", label: "Space" }, { key: "state", label: "Connection" }, { key: "detail", label: "Details" }],
      rows: entries.map((entry) => {
        const selected = r.selected.resolved && entry.space === r.selected.space;
        const detail = [entry.mode === "user" ? "user sign-in" : entry.mode === "auth" ? "static auth" : "open", entry.origin === "catalog" ? "saved catalog entry" : entry.origin === "manual" ? "registered endpoint" : "local registration", entry.tlsRequired ? "TLS required" : "", entry.catalog?.error ? "catalog refresh failed" : ""].filter(Boolean).join(" · ");
        return {
          space: selected ? cell(`→ ${entry.space}`, "selected") : entry.space,
          state: selected && r.selected.resolved ? connectionCell(r.selected) : entry.check === "not-checked" ? stateCell("not checked", "hint") : stateCell(entry.check === "reachable" ? "reachable" : "unreachable", entry.check === "reachable" ? "ok" : "failed"),
          detail: cell(detail, "hint"),
        };
      }),
    });
  }
  for (const unreadable of r.meshes.unreadable) blocks.push({ kind: "lines", lines: [stateCell(`Registration could not be read: ${unreadable.error}`, "failed")] });
  for (const account of r.meshes.catalogs) if (account.error) blocks.push({ kind: "lines", lines: [stateCell(`Space catalog for ${account.idp}: ${account.error}`, "failed")] });
  if (!r.meshes.currentRecorded) blocks.push({ kind: "lines", lines: [cell(`Selected space '${r.meshes.current}' is ${r.meshes.currentPrepared ? "prepared, not started" : "not recorded"}`, "waiting")] });
  return { title: "Brokers", blocks };
}

function selectedOverview(r: StatusResult): Section | undefined {
  const s = r.selected;
  if (!s.resolved) return { title: "Selected space", blocks: [{ kind: "lines", lines: [stateCell(s.message, "failed")] }] };
  // A broker named with `--server` is reported even when nothing on this machine is registered.
  if (s.source !== "flag-server" && !r.meshes.items.length && !r.meshes.currentPrepared && r.folder.auth.state === "none" && !r.folder.processes?.some((item) => item.pid !== null)) return undefined;
  const responder = responderText(s.deliveryResponder, s.mode);
  const rows: [string, Cell][] = [
    ["Broker", s.server ?? stateCell("address unavailable", "failed")],
    ["Connection", connectionCell(s)],
    ...(responder ? [["Delivery responder", stateCell(responder.text, responder.tone)] as [string, Cell]] : []),
    ["Access", s.mode === "user" ? "user sign-in" : s.mode === "auth" ? "static auth" : "open"],
    ["Project", s.root],
    ["Default agent", r.machine.defaults ? `${r.machine.defaults.harness ?? "application not set"} · persona ${r.machine.defaults.persona ?? "not set"}` : stateCell("saved defaults could not be read", "failed")],
    ["Persona catalog", s.personas.default === "valid" ? "default available" : stateCell(s.personas.default === "invalid" ? "default is invalid" : s.personas.default === "unreadable" ? "could not be read" : "no default persona", s.personas.default === "invalid" || s.personas.default === "unreadable" ? "failed" : "hint")],
  ];
  if (s.tlsRequired) rows.push(["Transport", "TLS required"]);
  if (s.eventsRequired) rows.push(["Events", "required"]);
  if (s.mode === "user") {
    if (!s.login) rows.push(["Account", stateCell("could not be read", "failed")]);
    else if (!s.login.subject) rows.push(["Account", stateCell("not signed in", "waiting")]);
    else {
      rows.push(["Account", `${s.login.subject} · session until ${s.login.expiresAt}`]);
      rows.push(["Grant", stateCell(s.login.actor === "granted" ? "granted" : s.login.actor === "not-granted" ? "not granted" : "not checkable on this machine", s.login.actor === "granted" ? "ok" : s.login.actor === "not-granted" ? "waiting" : "hint")]);
    }
  }
  if (s.snapshot.state === "unavailable") rows.push(["Live details", stateCell(`unavailable · ${s.snapshot.reason}`, "waiting")]);
  const blocks: Section["blocks"][number][] = [{ kind: "fields", rows }];
  if (r.folder.root === s.root && r.folder.processSpace === s.space && r.folder.controllerStack) {
    blocks.push({ kind: "lines", lines: [cell("Controller stack · its members are the stack-* rows under Owned services", "hint")] });
  } else if (r.folder.root === s.root && r.folder.processSpace === s.space && r.folder.processes) {
    blocks.push({ kind: "lines", lines: [cell("Legacy local process records", "label")] });
    blocks.push({
      kind: "table", header: false,
      columns: [{ key: "name", label: "Service" }, { key: "state", label: "State" }],
      rows: r.folder.processes.map((item) => ({
        name: item.name === "nats" ? "Broker" : item.name === "manager" ? "Manager" : item.name === "delivery" ? "Delivery" : item.name === "web" ? "Web" : item.name,
        state: item.state === "running" || item.state === "not-serving" || item.state === "unreadable" ? processCell(item) : stateCell(item.pid === null ? "not started" : item.detail ?? "stopped", "hint"),
      })),
    });
  } else blocks.push({ kind: "lines", lines: [cell("Legacy process records not checked here · the selected space has a different or unresolved local process scope", "hint")] });
  if (r.folder.launches === false) blocks.push({ kind: "lines", lines: [cell(`This folder's personas are not used by the selected space. Spawn uses ${s.personas.root}.`, "waiting")] });
  return { title: `Selected space  → ${s.space}`, blocks };
}

function nextActions(r: StatusResult): Section {
  const cmd = displayCmd();
  const items: { command: string; description: string }[] = [];
  const noApplication = !r.machine.connectors?.length;
  if (r.selected.resolved) {
    const s = r.selected;
    // A space that already resolves needs only the application to spawn into it.
    if (noApplication) items.push({ command: `${cmd} setup`, description: "Set up an agent application" });
    // Name what fixes the default persona alone; setup does far more than that.
    else if (s.personas.default === "missing") {
      const fix = defaultPersonaFix({ space: s.space, root: s.root, origin: r.meshes.items.find((m) => m.space === s.space)?.origin }, cmd);
      items.push({ command: fix.command, description: fix.cwd ? `Write the default persona; run it in ${fix.cwd}` : "Create the default persona" });
    } else if (s.personas.default !== "valid") items.push({ command: `${cmd} persona show default --space ${s.space}`, description: "See what is wrong with the default persona" });
    else items.push({ command: `${cmd} spawn`, description: "Open your default agent" });
    items.push({ command: `${cmd} ps`, description: "See the agent roster" });
  } else if (noApplication) items.push({ command: `${cmd} setup`, description: r.selected.code === "not-started" ? "Set up an agent application" : "Set up an agent application and a space" });
  if (r.selected.resolved || !noApplication) {
    items.push({ command: `${cmd} use`, description: "Choose another space" });
    if (r.meshes.items.length > 1) items.push({ command: `${cmd} status --all`, description: "Check every registered space" });
  }
  // A local controller stack that does not answer restarts its stopped members from its own records.
  if (r.selected.resolved && r.selected.connection !== "ok" && r.selected.connection !== "reachable" && r.folder.controllerStack && r.folder.root === r.selected.root && r.folder.processSpace === r.selected.space)
    items.unshift({ command: `${cmd} up --root ${r.selected.root}`, description: "Restart this stack's stopped members from its recorded inputs" });
  if (r.selected.resolved && r.selected.mode === "user" && r.selected.login && !r.selected.login.subject) items.unshift({ command: `${cmd} login --idp ${r.selected.login.idp}`, description: "Sign in to the selected space" });
  return { title: "Next", blocks: [{ kind: "commands", items }, ...r.hints.map((hint) => ({ kind: "lines" as const, lines: [cell(hint, "hint")] }))] };
}

function ownedServicesOverview(services: OwnedServiceStatus | undefined): Section | undefined {
  if (!services || services.state === "not-checked") return undefined;
  const blocks: Section["blocks"][number][] = [];
  if (services.definitions === null) blocks.push({ kind: "lines", lines: [stateCell("Saved service definitions unavailable", "waiting")] });
  if (services.instances === null) blocks.push({ kind: "lines", lines: [stateCell("Owned service instances unavailable; no stopped state inferred", "waiting")] });
  if (services.instances?.length) blocks.push({ kind: "table", columns: [{ key: "service", label: "Service" }, { key: "instance", label: "Full instance" }, { key: "host", label: "Execution host" }, { key: "process", label: "Process observation" }, { key: "readiness", label: "Recorded readiness" }, { key: "supervisor", label: "Supervisor record" }], rows: services.instances.slice(0, 100).map((row) => ({
    service: row.definition, instance: row.instanceId, host: row.executionHost,
    process: stateCell(row.observedProcess.replaceAll("-", " "), row.observedProcess === "running" ? "ok" : row.observedProcess === "unreadable" || row.observedProcess === "unresolved-launch" || row.observedProcess === "foreign-host" ? "waiting" : "hint"),
    readiness: cell(`${row.readinessObservation.replaceAll("-", " ")} · ${row.readinessAsOf}`, "hint"),
    supervisor: row.supervisorRecord.mechanism === "none-recorded" ? "not assigned here" : `${row.supervisorRecord.mechanism} · ${row.supervisorRecord.fileObservation}; OS state not checked`,
  })) });
  if (services.instances && services.instances.length > 100) blocks.push({ kind: "lines", lines: [cell(`${services.instances.length - 100} instance rows omitted; --json retains the complete readable inventory.`, "hint")] });
  const instantiated = new Set(services.instances?.map((row) => row.definition));
  const saved = services.instances === null ? [] : services.definitions?.filter((row) => !instantiated.has(row.name)) ?? [];
  if (saved.length) blocks.push({ kind: "table", columns: [{ key: "service", label: "Saved service" }, { key: "type", label: "Launch type" }, { key: "observation", label: "Instance records" }], rows: saved.slice(0, 100).map((row) => ({ service: row.name, type: row.launch.type === "adapter" ? row.launch.adapter : "process", observation: "no owned instance recorded" })) });
  if (saved.length > 100) blocks.push({ kind: "lines", lines: [cell(`${saved.length - 100} saved definitions omitted; --json retains the complete readable inventory.`, "hint")] });
  if (services.definitions?.length === 0 && services.instances?.length === 0) blocks.push({ kind: "lines", lines: [cell("No saved definitions or owned instance records in this selected space.", "hint")] });
  blocks.push({ kind: "lines", lines: [cell(`Local records and process observations as of ${services.observedAt}; non-atomic. Recorded readiness is historical, not a fresh endpoint response. No OS unit query, service control, adoption or remote process ownership is implied.`, "hint")] });
  // The space is known here, and a sole instance names its service and full ID as well.
  const sole = services.instances?.length === 1 ? services.instances[0] : undefined;
  const inspect = sole ? `${displayCmd()} svc status ${sole.definition} --instance ${sole.instanceId} --space ${services.space}` : `${displayCmd()} svc status <service> --instance <full-id> --space ${services.space}`;
  if (services.instances?.length || services.definitions?.length) blocks.push({ kind: "commands", items: [{ command: inspect, description: "Inspect one exact owned instance and its recorded supervisor" }, { command: `${displayCmd()} svc`, description: "Read the full saved-service inventory" }] });
  return { title: `Owned services  → ${services.space}`, blocks };
}

function bootAttemptOverview(snapshot: StatusResult["bootAttempts"]): Section | undefined {
  if (!snapshot || !snapshot.unsettled.length && !snapshot.additive.length && !snapshot.unreadable.length) return undefined;
  return { title: "Deployment attempts", blocks: [
    { kind: "fields", rows: [["Folder root", snapshot.root], ["Local read", snapshot.state], ["Unsettled fresh", String(snapshot.unsettled.length)], ["Additive attempts", String(snapshot.additive.length)], ["Unreadable records", String(snapshot.unreadable.length)]] },
    snapshot.unsettled.length ? { kind: "table", columns: [{ key: "id", label: "Fresh boot" }, { key: "space", label: "Space" }, { key: "broker", label: "Recorded broker" }], rows: snapshot.unsettled.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, broker: row.server })) } : { kind: "lines", lines: ["No readable unsettled fresh attempt in this folder."] },
    snapshot.additive.length ? { kind: "table", columns: [{ key: "id", label: "Additive intent" }, { key: "space", label: "Space" }, { key: "state", label: "Recorded state" }], rows: snapshot.additive.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, state: row.recordedState })) } : { kind: "lines", lines: ["No readable additive attempt in this folder."] },
    { kind: "lines", lines: [...snapshot.unreadable.slice(0, 100).map((path) => `Unreadable record: ${path}`), ...(snapshot.unsettled.length > 100 || snapshot.additive.length > 100 || snapshot.unreadable.length > 100 ? ["Additional records are in JSON."] : []), "A fresh intent may have started a broker; an additive intent may have changed its resources. No retry or stop authority follows from this read."] },
    { kind: "commands", items: [{ command: `${displayCmd()} team show <deployment-id>`, description: "Inspect the original attempt from its recorded root" }] },
  ] };
}

function maintenanceOverview(maintenance: StatusResult["maintenance"]): Section | undefined {
  if (!maintenance) return undefined;
  return { title: "Maintenance", blocks: [
    { kind: "fields", rows: [["Folder root", maintenance.root], ["Space", maintenance.space ?? "not read"], ["State", maintenance.state], ["Attempt", maintenance.attemptId ?? "not read"]] },
    ...(maintenance.next ? [{ kind: "lines" as const, lines: [maintenance.next] }] : []),
  ] };
}

/** The approved screen hierarchy; record-level diagnostics are opt-in. */
export function statusView(r: StatusResult, verbose = false): Report {
  const selected = selectedOverview(r);
  const owned = ownedServicesOverview(r.services);
  const attempts = bootAttemptOverview(r.bootAttempts);
  const maintenance = maintenanceOverview(r.maintenance);
  const sections = [machineOverview(r), brokerOverview(r), ...(selected ? [selected] : []), ...(maintenance ? [maintenance] : []), ...(attempts ? [attempts] : []), ...(owned ? [owned] : [])];
  if (verbose) sections.push(machineSection(r.machine), extensionsSection(r.extensions), folderSection(r.folder, r.selected), ...meshesSections(r.meshes), selectedSection(r.selected));
  sections.push(nextActions(r));
  return { sections };
}

function section(name: string): void {
  console.log(`\n${c.bold(name)}`);
}

/** The distinct exit cases of the component-health pass.  A process record says that this machine
 * knows about a component; a component-owned control answer says it is actually serving.  Do not
 * flatten those questions — the manager incident was exactly a live lease holder that had not
 * reached its service rail. */
type ComponentVerdict = "serving" | "not-installed" | "absent" | "not-serving" | "refused";
type ComponentHealth = { name: string; verdict: ComponentVerdict; facts: string[] };

const COMPONENT_EXIT: Record<ComponentVerdict, number> = {
  serving: 0,
  // An optional component that was never installed is not a failed one.
  "not-installed": 0,
  absent: 1,
  "not-serving": 2,
  refused: 3,
};

/** Machine-readable, uncoloured component records — one line per component.  Human text follows
 * after the state token, but the token/exit contract deliberately stays simple for cron.  A fact can
 * quote a reason another process or a stored row wrote; a newline in it would split the record. */
function printComponent(component: ComponentHealth): void {
  console.log(`  ${component.name.padEnd(16)} ${component.verdict}${component.facts.length ? ` · ${component.facts.map(oneLine).join(" · ")}` : ""}`);
}

function componentExit(components: readonly ComponentHealth[]): number {
  // Refusal outranks every state: an unreadable control surface is not a clean zero even if some
  // other component answered.  A process that exists but lacks its serving answer is next, then
  // genuine absence.  The order is intentionally one place so a new component cannot accidentally
  // collapse these states by choosing its own exit code.
  return Math.max(...components.map((component) => COMPONENT_EXIT[component.verdict]));
}

function processRecord(template: string, context: LocalProcessContext): { kind: "absent" } | { kind: "unreadable"; error: string } | { kind: "dead"; pid: number } | { kind: "unattributable"; raw: string } | { kind: "live"; pid: number } | { kind: "unknown"; pid: number } {
  let raw: string;
  try {
    raw = readFileSync(localProcessPath(template, context), "utf8").trim();
  } catch (e) {
    // A component removes its own record on exit, so the file can be gone by the time it is read:
    // that is absence. An ambiguous record or any other failed read refuses this component's row,
    // never the whole pass.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", error: (e as Error).message };
  }
  if (!raw) return { kind: "absent" };
  const pid = parsePid(raw);
  if (pid === undefined) return { kind: "unattributable", raw };
  const liveness = probeLiveness(pid);
  return liveness === "alive" ? { kind: "live", pid } : liveness === "dead" ? { kind: "dead", pid } : { kind: "unknown", pid };
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
 *  to print. So a user-mode target connects as the machine's signed-in login — the SAME credential
 *  `ps` and the bare-status live snapshot use (`userCredentials`, which also serves discovered
 *  spaces through the registry entry). When that credential cannot be had (not signed in, service
 *  down, exchange refused), the components pass says so on the row instead of probing bare: a
 *  refused probe would be reporting the broker's answer to a question nobody asked. */
type ComponentCredential =
  | { kind: "static"; auth: SpaceAuth | undefined }
  | { kind: "user"; bearer: string; sentinelCreds: string; caller: { owner: string; actor: string; uid: string } }
  | { kind: "unavailable"; reason: string };

/** The `(owner, actor, lifecycleUid)` a user bearer is bound to, read client side the same way the
 *  workspace connect layer reads it (the JWT payload without verification; the broker verifies).
 *  The service caller triple is part of the manager's authenticated control surface, so the probe's
 *  triple must be the bearer's own — a random actor would turn an authorized manager into a false
 *  no-answer, the same trap the static arm's mint comment below names. */
function principalFromBearer(bearer: string): { owner: string; actor: string; uid: string } {
  const mid = bearer.split(".")[1];
  if (!mid) throw new Error("not a compact JWS");
  const payload = JSON.parse(Buffer.from(mid, "base64url").toString("utf8")) as {
    sub?: string;
    act?: { actor?: string; lifecycleUid?: string };
  };
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.act?.actor !== "string" || !payload.act.actor)
    throw new Error("missing sub/act.actor");
  if (typeof payload.act.lifecycleUid !== "string" || !payload.act.lifecycleUid)
    throw new Error("missing act.lifecycleUid (lifecycle-bound bearers are the v0.4 hard cut)");
  return { owner: payload.sub, actor: payload.act.actor, uid: payload.act.lifecycleUid };
}

/** The probe credential for the components pass, per target mode. Static/open meshes keep the exact
 *  mint they had; a user-mode target gets the signed-in login's bearer, or the one-sentence reason
 *  it cannot be had. */
async function componentCredential(target: MeshTarget): Promise<ComponentCredential> {
  if (target.mode !== "user") return { kind: "static", auth: target.auth };
  try {
    const { bearer, sentinelCreds } = await resolveAuthProvider().userCredentials({
      store: workspaceSecretStore(target.root),
      dir: userAuthStateDir(target.root, target.space),
      space: target.space,
      actor: CLI_USER_ACTOR,
    });
    return { kind: "user", bearer, sentinelCreds, caller: principalFromBearer(bearer) };
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
  if (!(await isReachable(target.server, { ...(target.tlsRequired ? { tls: true } : {}), timeoutMs: 3_000 })))
    throw new Error(`the broker at ${brokerAddressForDisplay(target.server) ?? "an invalid broker address"} is not answering`);
}

/** The static arm's one-shot service instrument, unchanged from before the user-mode fix: a fresh
 *  identity, its minted deployer credential, and the caller triple on the SAME identity — a
 *  mismatched random actor would turn an authorized manager into a false no-answer. */
async function staticServiceAuth(auth: SpaceAuth | undefined): Promise<{ creds?: string; caller: { owner: string; actor: string; uid: string } }> {
  const serviceIdentity = newIdentity();
  const serviceUid = mintLifecycleUid();
  return {
    creds: auth ? await mintCreds(auth, serviceIdentity, "deployer", { lifecycleUid: serviceUid }) : undefined,
    caller: { owner: "local", actor: serviceIdentity.id, uid: serviceUid },
  };
}

/** The fields of a manager `status` answer that its component row reads. */
type ManagerServiceStatus = {
  instanceId?: unknown;
  runtime?: unknown;
  stopImpact?: unknown;
  staticReconciliation?: {
    state?: unknown;
    lastSweep?: { error?: unknown };
    failures?: Array<{ alias?: unknown; phase?: unknown; disposition?: unknown; nextRetryAt?: unknown; remedy?: unknown }>;
  };
};

/** Display only. A status observation never authorizes process control or proves cleanup. */
function managerStopImpactFacts(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["stop impact not reported by this manager build"];
  const impact = input as Record<string, unknown>;
  if (!["manager", "owner-filtered"].includes(String(impact.agentScope)) || typeof impact.observedAt !== "string" || impact.observedAt.length > 100 || !Number.isFinite(Date.parse(impact.observedAt)) || !Array.isArray(impact.agents)) return ["stop impact could not be interpreted; no safe stop inferred"];
  const facts = [`stop impact ${impact.agentScope === "manager" ? "manager-owned rows" : "owner-filtered; full scope unknown"} as of ${new Date(impact.observedAt).toISOString()}`];
  const actions = { stop: 0, release: 0, retained: 0, unknown: 0 };
  for (const row of impact.agents) {
    const action = row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>).defaultAction : undefined;
    if (action === "stop") actions.stop++;
    else if (action === "release-custody") actions.release++;
    else if (action === "stop-retaining-state") actions.retained++;
    else actions.unknown++;
  }
  facts.push(`default stop policy: stop ${actions.stop}, release custody ${actions.release}, stop retaining state ${actions.retained}, unknown ${actions.unknown} visible seats`);
  for (const [key, label] of [["lifecycleInFlight", "lifecycle work"], ["reservedLaunches", "reserved launches"], ["retirementsPending", "pending retirements"], ["deprovisioningInFlight", "cleanup in flight"], ["staticReconciliationInFlight", "reconciliation in flight"]] as const) {
    const count = impact[key];
    if (!Number.isSafeInteger(count) || Number(count) < 0) facts.push(`${label} unknown`);
    else if (Number(count) > 0) facts.push(`${label} ${count}`);
  }
  if (impact.stopping === true) facts.push("native manager stop already in progress");
  facts.push("stop not reserved; seat exit and cleanup not checked");
  return facts;
}

/** A service registration is the health target itself.  Calling its `status` command through a
 * generic endpoint does not work on this base because a passive status endpoint has no v0.4 caller
 * rail; a one-shot standalone caller does. */
async function managerServiceHealth(
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
    const service = await resolveService(nc, target.space, "manager", auth.caller, { deadlineMs: 3_000 });
    const response = await invokeRepairingSplit(nc, target.space, service, "status", undefined, { deadlineMs: 3_000 });
    if (response.reply.ok !== true)
      throw new EpEnvelopeError(response.reply.error?.code === "unavailable" ? "unavailable" : "failed-precondition", response.reply.error?.message ?? "manager status refused");
    return response.reply.data as ManagerServiceStatus;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

async function managerHealth(target: MeshTarget, context: LocalProcessContext, credential: ComponentCredential): Promise<ComponentHealth> {
  const record = processRecord(MANAGER_PIDFILE, context);
  const facts = pidFacts(record);
  // A corrupt or kernel-unreadable LOCAL record is neither evidence that the manager is absent nor
  // permission to replace it with a network answer.  Name that failed local control surface first.
  if (processVerdict(record) === "refused") {
    if (record.kind === "unattributable") facts.push("unattributable pidfile");
    if (record.kind === "unknown") facts.push("pid liveness unestablishable");
    facts.push("static reconciliation not reported by this manager build");
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
      facts.push("static reconciliation not reported by this manager build");
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
    // The service caller triple is part of the manager's own authenticated control surface.  Keep
    // the minted credential and the subject caller on the SAME identity; a mismatched random actor
    // would turn an authorized manager into a false no-answer on static meshes.
    // User mode: the SAME bearer the probe connected with answers the service rail, and the caller
    // triple is the bearer's own principal (the comment above the triple read). Static/open: a
    // fresh one-shot instrument, exactly as before.
    const serviceAuth =
      credential.kind === "user"
        ? { bearer: credential.bearer, sentinelCreds: credential.sentinelCreds, caller: credential.caller }
        : await staticServiceAuth(credential.auth);
    const served = await managerServiceHealth(target, serviceAuth);
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
    facts.push("static reconciliation not reported by this manager build");
    // A no-responder service rail or an absent manager registry is definitive no-service evidence.
    // The lease and PID answer whether that missing service belongs to an extant component (not
    // serving) or an absent one; any other failed probe remains a refusal.
    const noService = e instanceof EpEnvelopeError && (unansweredRequest(e) || /service registry.*stream not found/i.test(e.message));
    facts.push(noService ? "serve no answer" : `serve probe refused: ${(e as Error).message}`);
    if (!noService) return { name: "manager", verdict: "refused", facts };
    const liveRecord = record.kind === "live";
    const hasLease = facts.some((fact) => fact.startsWith("lease holder "));
    return { name: "manager", verdict: liveRecord || hasLease ? "not-serving" : "absent", facts };
  } finally {
    await close?.();
  }
}

/** Delivery owns two answers: its ready lease is its liveness/control surface; its latest explicit
 * adoption report is the renewal record it writes through the manager-owned renewal pass.  The
 * latter is intentionally not inferred from credential mtime or process output. */
async function deliveryHealth(target: MeshTarget, context: LocalProcessContext, credential: ComponentCredential): Promise<ComponentHealth> {
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
  if (stopped) {
    if (record.kind === "dead") facts.push("stale pidfile");
    if (record.kind === "unattributable") facts.push("unattributable pidfile");
    if (record.kind === "unknown") facts.push("pid liveness unestablishable");
    return { name: "delivery", verdict: stopped, facts };
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
      return { name: "delivery", verdict: "not-serving", facts };
    }
    facts.push(`lease holder ${lease.holder}`);
    if (state === "stale") {
      // Name WHOSE record it is against whom we expected, because this is the one verdict an
      // operator cannot derive from the other facts on the line.
      facts.push("ready, but held by a DIFFERENT daemon than this workspace launched (a dead holder's record expires on its own)");
      facts.push(`responder not bound - ${RESPONDER_UNBOUND_CONSEQUENCE}`);
      return { name: "delivery", verdict: "not-serving", facts };
    }
    facts.push(state === "bound" ? "ready" : "starting (lease not ready)");
    if (state !== "bound") facts.push(`responder not bound - ${RESPONDER_UNBOUND_CONSEQUENCE}`);
    return { name: "delivery", verdict: state === "bound" ? "serving" : "not-serving", facts };
  } catch (e) {
    // A live recorded daemon with no delivery lease bucket cannot be serving this build's delivery
    // control surface.  A denied/timed-out read is different: it is a refusal and must never read
    // as a clean absence.
    const noLeaseSurface = /stream not found/i.test((e as Error).message);
    facts.push(noLeaseSurface ? "ready lease absent" : `lease probe refused: ${(e as Error).message}`);
    return { name: "delivery", verdict: noLeaseSurface ? "not-serving" : "refused", facts };
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
    // An installation that cannot be read keeps the absent verdict rather than a clean zero.
    let installed: boolean | undefined;
    try { installed = webInstalled(); } catch { installed = undefined; }
    if (installed === false) return { name: "web", verdict: "not-installed", facts: ["optional"] };
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

async function brokerHealth(target: MeshTarget): Promise<ComponentHealth> {
  const address = brokerAddressForDisplay(target.server);
  if (address === undefined)
    return { name: "broker", verdict: "refused", facts: ["registered address unavailable", "invalid broker address"] };
  try {
    const reachable = await isReachable(target.server, target.tlsRequired ? { tls: true } : {});
    return reachable
      ? { name: "broker", verdict: "serving", facts: [`registered ${address}`, "reachable"] }
      : { name: "broker", verdict: "not-serving", facts: [`registered ${address}`, "unreachable"] };
  } catch (e) {
    return { name: "broker", verdict: "refused", facts: [`registered ${address}`, `probe refused: ${(e as Error).message}`] };
  }
}

async function printComponentHealth(cwd: string, values: FlagValues<typeof statusFlags>): Promise<void> {
  section("Component Health");
  let target: MeshTarget;
  try {
    target = resolveMeshTarget(cwd, { server: values.server, space: values.space });
  } catch (e) {
    if (isWorkspaceTargetError(e)) {
      printComponent({ name: "target", verdict: "refused", facts: [e.code, renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, "")] });
      process.exitCode = COMPONENT_EXIT.refused;
      return;
    }
    throw e;
  }
  // The report's own rule: an unregistered project root is given no broker to probe.
  if (target.source === "local-space") {
    printComponent({ name: "target", verdict: "refused", facts: ["unregistered-root", `no space is registered or prepared here for ${target.root}`] });
    process.exitCode = COMPONENT_EXIT.refused;
    return;
  }
  const context: LocalProcessContext = { root: target.root, space: target.space, userAuth: target.mode === "user" };
  // ONE credential read for the whole pass (user mode resolves the signed-in login once; the
  // static shape is just the target's own auth material), shared by the manager and delivery
  // probes so the two rows cannot disagree about whose credential they probed with.
  const credential = await componentCredential(target);
  const components = await Promise.all([
    managerHealth(target, context, credential),
    deliveryHealth(target, context, credential),
    webHealth(context),
    brokerHealth(target),
  ]);
  for (const component of components) printComponent(component);
  process.exitCode = componentExit(components);
}

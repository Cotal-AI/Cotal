import { join } from "node:path";
import { CotalEndpoint, isReachable, mintCreds, newIdentity, resolveAuthProvider, personaDir, type FlagValues, type UserAuthStatus } from "@cotal-ai/core";
import {
  isCommandFailure,
  recordsElsewhereText,
  targetErrorSpace,
  brokerCheck,
  brokerUrlKey,
  CLI_USER_ACTOR,
  codeSpan,
  CommandFailure,
  folderSpaceOverSelection,
  isGenuineSpace,
  stoppedStack,
  unsettledStackOperation,
  isMeshRegistryError,
  isWorkspaceTargetError,
  preparedNeverStarted,
  preflightTarget,
  readCurrent,
  readMeshRegistry,
  preparedRecordSkipped,
  readPreparedSpaces,
  userAuthStateDir,
  workspaceSecretStore,
  workspaceErrorParts,
  cotalDirLink,
  type BrokerCheck,
  type MeshEntry,
  type MeshTarget,
  movedProject,
  operationWarnings,
  spaceStreamsExpected,
  shellPath,
  unsearchableFolder,
  withdrawOperationNote,
} from "@cotal-ai/workspace";
import { type DeliveryResponderState } from "../lib/delivery-responder.js";
import { chatStreamGone, stackState } from "../lib/space-streams.js";
import { stackStartAddressProblem } from "./stack-up.js";
import { legacyRestartAddressProblem } from "../lib/broker-service.js";
import { displayCmd, displayRemedy } from "../lib/self-exec.js";
import { readPersonas, type PersonaEntry } from "../lib/personas.js";
import { preparedCatalogDiagnostics } from "./sync.js";
import { serviceInstances } from "../lib/service-instances.js";
import { legacyBrokerPidfileBlock, readStackJournal, stackRootGone, stackUpInProgress, unusableStackJournal } from "../lib/stack-journal.js";
import { linkedCotalRemedy, preparedRootWriteProblem } from "../lib/paths.js";
import { channelSeedRestartBlock } from "../lib/channel-seed.js";
import { rootStoreProblem } from "../lib/store-dir.js";
import { stackStoreWarnings } from "../lib/store-identity.js";
import { statusFlags, type Selected, type SelectedPreflight, UnregisteredRoot, type PersonaCatalog, type StatusResult, type SelectedResult, Gaps, displayStatusBroker } from "./status-model.js";
import { servedStack } from "./status-render.js";

export async function readStatusPreflight(selected: Selected, gaps: Gaps, hints: string[]): Promise<{ preflight: SelectedPreflight; pidfileUnreadable: boolean }> {
  if (!selected.ok || selected.target.mode === "user") return { preflight: undefined, pidfileUnreadable: false };
  const { root, space } = selected.target;
  let pidfileUnreadable = false;
  const preflight = await preflightTarget(selected.target, undefined, (path, error) => {
    pidfileUnreadable = true;
    gaps.add("PIDFILE_UNREADABLE", `the nats pidfile could not be read: ${error.message}`, { root, space, process: "nats" });
    const folder = unsearchableFolder(path);
    hints.push(`make it readable by you, for example with chmod ${folder === undefined ? "u+r" : "u+rx"} ${shellPath(folder ?? path)}`);
  });
  return { preflight, pidfileUnreadable };
}

/** Replace the current folder's restart banner when its directory or broker store blocks startup. */
export function reportHeldRestartProblem(root: string, hints: string[]): boolean {
  const held = operationWarnings().find((warning) => warning.code === "FOLDER_SPACE_NOT_RUNNING")?.target as { space: string; root: string; state: string } | undefined;
  if (held?.root !== root) return false;
  const writeProblem = held.state === "stopped" ? preparedRootWriteProblem(root) : undefined;
  const store = rootStoreProblem(root);
  if (!writeProblem && !store) return false;
  withdrawOperationNote("FOLDER_SPACE_NOT_RUNNING", held.space);
  if (writeProblem) hints.push(`Restart blocked: ${writeProblem.message}. ${writeProblem.remedy}`);
  else if (store) hints.push(`${store.message}; ${store.remedy}`);
  return true;
}

/** Outside a project, only the all-broker report has liveness evidence for the registry fallback. */
export async function registryFallbackChecks(root: string, values: FlagValues<typeof statusFlags>) {
  if (!values.all || values.space !== undefined || values.server !== undefined || isGenuineSpace(root)) return undefined;
  let entries: MeshEntry[];
  try {
    if (readCurrent() !== undefined) return undefined;
    entries = readMeshRegistry().entries;
  } catch { return undefined; } // The reporting pass names unreadable records.
  return new Map(await Promise.all(entries.map(async entry => [entry.space, { entry, check: await brokerCheck(entry.server, entry.tlsRequired) }] as const)));
}

/** Summarize the catalog through the shipped loader. A file is launchable only when
 *  {@link readPersonas} parsed it with the same {@code loadAgentFile} path spawn uses. Only an absent
 *  directory is an empty catalog: one that cannot be read is a gap, not `missing`. */
export function personaCatalog(root: string, gaps: Gaps): PersonaCatalog {
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

/** The recorded meshes. Only the selected one is checked, and only when the command dials its
 *  recorded address, unless `--all` asks for every one; each check dials that record's own address
 *  with its own recorded TLS requirement. A bare TCP/INFO probe would green-light a plaintext broker
 *  that has substituted for a TLS-required mesh — the FAIL1 attack — so a list that only asks "is
 *  anything listening" cannot report on the one property the record claims. */
export async function readMeshes(cwd: string, selected: Selected, all: boolean, gaps: Gaps, offline: readonly string[], preflight: SelectedPreflight, checks: Awaited<ReturnType<typeof registryFallbackChecks>>): Promise<{ meshes: StatusResult["meshes"]; currentJournalUnreadable: boolean }> {
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
  // A record this needs that cannot be read is already named above.
  let folder: string | null = null;
  // A folder space whose broker did not answer is not the target, so it is not this folder's here.
  try { folder = folderSpaceOverSelection(cwd, current, offline) ?? null; } catch (e) { if (!isMeshRegistryError(e)) throw e; }
  const chosen = selected.ok ? selected.target : undefined;
  const chosenServer = chosen && brokerUrlKey(chosen.server);
  // A `--server` that names another address is the only broker dialed for the selected space.
  const check = async (m: MeshEntry): Promise<BrokerCheck | "not-checked"> => {
    const selectedAddress = m.space === chosen?.space && brokerUrlKey(m.server) === chosenServer;
    if (!all && !selectedAddress) return "not-checked";
    if (preflight && selectedAddress) {
      if (preflight.ok) return "reachable";
      if (preflight.kind === "slow-link" || preflight.kind === "broker-stopped" || preflight.kind === "unreachable") return preflight.kind;
      return preflight.kind === "tls-trust" || preflight.kind === "tls-unsupported" || preflight.kind === "auth-unsupported" || preflight.kind === "jetstream-unsupported" || preflight.kind === "non-nats-listener" ? "unreachable" : "reachable";
    }
    const prior = checks?.get(m.space);
    if (prior?.entry.server === m.server && prior.entry.tlsRequired === m.tlsRequired) return prior.check;
    return brokerCheck(m.server, m.tlsRequired);
  };
  const items = await Promise.all(
    entries.map(async (m) => ({
      space: m.space,
      server: displayStatusBroker(m.server, m.space, gaps),
      mode: m.mode,
      root: m.root,
      origin: m.origin ?? null,
      tlsRequired: Boolean(m.tlsRequired),
      eventsRequired: m.policy?.events === "required",
      modeChecked: m.unchecked !== true,
      current: m.space === current,
      check: await check(m),
      catalog: m.origin === "catalog" ? { name: m.catalogName && m.catalogName !== m.space ? m.catalogName : null, fetchedAt: m.catalogFetchedAt ?? null, error: m.catalogError ?? null } : null,
    })),
  );
  // The prepared spaces folder, or a record in it, that cannot be read is named the same way.
  let currentPrepared = false, currentStopped = false, hasPrepared = false, currentJournalUnreadable = false;
  try {
    const prepared = readPreparedSpaces();
    hasPrepared = prepared.spaces.length > 0;
    // Named with the warning a command that skips it gives, so a run that also skipped it says it once.
    for (const e of prepared.unusable) {
      const skipped = preparedRecordSkipped(e);
      unreadable.push({ file: e.file, error: e.message });
      gaps.add(skipped.code, skipped.message, skipped.target);
    }
    const saved = current !== null && !entries.some((m) => m.space === current) ? prepared.spaces.find((p) => p.space === current) : undefined;
    if (saved) {
      currentJournalUnreadable = journalLifecycleUnknown(unusableStackJournal(saved.root));
      currentPrepared = !currentJournalUnreadable;
      currentStopped = currentPrepared && stoppedStack(saved.root, saved.space) !== undefined && unsettledStackOperation(saved.root, saved.space) === undefined;
    }
  } catch (e) {
    if (!isMeshRegistryError(e)) throw e;
    unread(e.file, e.message);
  }
  const meshes: StatusResult["meshes"] = {
    current,
    currentRecorded: current === null || entries.some((m) => m.space === current),
    currentPrepared,
    hasPrepared,
    currentStopped,
    folder,
    unreadable,
    items,
    catalogs: preparedCatalogDiagnostics().map((r) => ({ idp: r.account.idpUrl, account: r.account.sub, state: r.state, error: r.state === "failed" ? (r.error ?? "refresh failed") : null })),
  };
  return { meshes, currentJournalUnreadable };
}

function journalLifecycleUnknown(journal: CommandFailure | undefined): boolean {
  return journal?.code === "SCHEMA_INVALID" || journal?.code === "PERMISSION_DENIED";
}

function reportSelectedJournal(result: Extract<SelectedResult, { resolved: false }>, journal: CommandFailure, hints: string[]): SelectedResult {
  if (journalLifecycleUnknown(journal)) {
    result.code = journal.code;
    result.message = result.space === undefined ? "The stack lifecycle is unknown because the journal could not be read"
      : `The stack lifecycle for "${result.space}" is unknown because the journal could not be read`;
  }
  const step = journal.remedy === undefined ? journal.message : journal.code === "TARGET_UNAVAILABLE" ? `${journal.message}. ${journal.remedy}` : journal.remedy;
  if (!hints.includes(step)) hints.push(step);
  return result;
}

/** Diagnose the current folder's store and a selected local stack independently of folder trust. */
export function readStackStoreWarnings(root: string, gaps: Gaps, hints: string[], space?: string): void {
  try {
    const journal = readStackJournal(root)?.journal;
    if (journal && (space === undefined || journal.space === space))
      for (const warning of stackStoreWarnings(journal)) gaps.add(warning.code, warning.message, warning.target);
  } catch (error) {
    if (isCommandFailure(error) && (error.code === "SCHEMA_INVALID" || error.code === "PERMISSION_DENIED")) {
      gaps.add(error.code === "PERMISSION_DENIED" ? "STACK_JOURNAL_UNREADABLE" : "STACK_JOURNAL_INVALID", error.remedy ? `${error.message}; ${error.remedy}` : error.message, { root });
      if (error.remedy) hints.push(error.remedy);
    } else if (!isCommandFailure(error) || error.code !== "CONFLICT") throw error;
    // A copied or moved journal is diagnosed by the folder and selection readers.
  }
}

/** The refusal of `space`'s service instance records when one is a record no command can use, as
 *  `up` and `down` refuse it. Undefined when they read. */
function unusableServiceInstances(space: string): CommandFailure | undefined {
  try { serviceInstances(space); return undefined; }
  catch (error) { return isCommandFailure(error) && error.code === "SCHEMA_INVALID" ? error : undefined; }
}

/** A prepared selection can have a live startup writer at a different project root. */
export function selectedStackStarting(selected: Selected, folder: StatusResult["folder"], stackStarting: boolean): boolean {
  if (selected.ok || !isWorkspaceTargetError(selected.error) || selected.error.code !== "not-started") return false;
  const { root, space, rootMissing, unsettled } = selected.error.details;
  if (root === undefined || space === undefined || rootMissing || cotalDirLink(root) !== undefined) return false;
  if (root === folder.root) return stackStarting && Boolean(servedStack(folder, { root, space }));
  if (unsettled !== "up") return false;
  try {
    const journal = readStackJournal(root)?.journal;
    return journal?.space === space && stackUpInProgress(journal);
  } catch { return false; } // The selection report names an unusable journal.
}

/** Report the local recovery observation without treating it as a resolved connection. */
export function selectedRecovery(hints: string[], members: readonly { role: string; pid: number }[] = []): SelectedResult {
  const cmd = displayCmd();
  const pinned = members.length === 1 && members[0]?.role === "broker" ? "pinned broker" : "pinned members";
  hints.push(`run ${codeSpan(`${cmd} down --dry-run`)} in this project to inspect the ${pinned}, then ${codeSpan(`${cmd} down --yes`)} to stop ${members.length === 1 ? "it" : "them"}`);
  const roles = members.map((row) => row.role);
  const running = roles.length === 0 ? "processes are"
    : roles.length === 1 ? `${roles[0]} process is`
    : `${roles.slice(0, -1).join(", ")} and ${roles[roles.length - 1]} processes are`;
  return { resolved: false, code: "not-started", message: `the stack's ${running} running, but its member records are missing from this Cotal home` };
}

export async function readSelected(selected: Selected, responder: { state: DeliveryResponderState; leased: boolean }, folder: StatusResult["folder"], gaps: Gaps, hints: string[], { preflight, pidfileUnreadable }: Awaited<ReturnType<typeof readStatusPreflight>>, all: boolean, selectedStarting: boolean): Promise<SelectedResult> {
  const cmd = displayCmd();
  if (!selected.ok) {
    const e = selected.error;
    if (isCommandFailure(e) && e.code === "SCHEMA_INVALID") {
      gaps.add(e.code, e.message, e.target);
      if (e.remedy) hints.push(e.remedy);
      return { resolved: false, code: e.code, message: e.message };
    }
    // Resolution reads the whole registry and refuses a directory or record it cannot use. The meshes
    // reader has already named it, so this is the same gap, and the selection is unresolved.
    if (isMeshRegistryError(e)) {
      gaps.add("MESH_REGISTRY_UNREADABLE", e.message, { file: e.file });
      hints.push(e.message);
      return { resolved: false, code: "registry-unreadable", message: e.message };
    }
    // `up` and `down` refuse a root whose `.cotal` is a link, so the step that would start it there is
    // the one their refusal names.
    const unstarted = e instanceof UnregisteredRoot ? e.root : isWorkspaceTargetError(e) && (e.code === "not-started" || e.code === "no-meshes") ? e.details.root : undefined;
    const link = unstarted === undefined ? undefined : cotalDirLink(unstarted);
    if (unstarted !== undefined && link !== undefined) {
      hints.push(linkedCotalRemedy(unstarted, link));
      return { resolved: false, code: e instanceof UnregisteredRoot ? "unregistered-root" : "not-started", message: `${join(unstarted, ".cotal")} is a link to ${link}, and a stack runs only from a folder whose .cotal is its own directory, so \`${cmd} up\` and \`${cmd} down\` refuse it there` };
    }
    if (e instanceof UnregisteredRoot) {
      const message = `no space is registered or prepared here for ${e.root}`;
      hints.push(`run \`${cmd} up\` in ${e.root} to start one, or select a space with \`${cmd} use <name>\``);
      return { resolved: false, code: "unregistered-root", message };
    }
    if (!isWorkspaceTargetError(e)) throw e;
    if (!all && e.code === "ambiguous-target" && e.details.server === undefined && e.details.spaces && !isGenuineSpace(folder.root)) {
      hints.push(`check the registered spaces with \`${cmd} status --all\``);
      return { resolved: false, code: e.code, message: `multiple spaces are registered but unchecked: ${(e.details.available ?? []).join(", ")}` };
    }
    // The section states the selection, and Next gives the repair for the specific refusal.
    const { message, remedy, restartRoot } = workspaceErrorParts({ kind: "target", error: e });
    const d = e.details;
    // A copy or a moved folder is reported under the space its records name, as the commands run here
    // refuse under it, and says what the folder holds; Next gives the step they name.
    const elsewhere = e.code === "not-started" ? recordsElsewhereText(d) : undefined;
    const held = e.code === "not-started" && !d.rootMissing && !d.unsettled && d.root && d.space
      ? (d.stopped ? legacyBrokerPidfileBlock(d.root) : undefined) ?? await stackStartAddressProblem(d.root, d.space) : undefined;
    const result: SelectedResult = {
      resolved: false, code: e.code, message: elsewhere ?? (held ? `${message}; ${held.message}` : message),
      ...(e.code === "not-started" && d.space !== undefined && d.root !== undefined && !d.rootMissing ? { space: d.space, root: d.root } : {}),
      ...(elsewhere !== undefined ? { space: targetErrorSpace(d)!, recordedRoot: d.recordedRoot! } : {}),
    };
    if (selectedStarting) {
      result.message = `"${result.space}" is prepared and its stack is starting`;
      return result;
    }
    // An unwritable store blocks a restart from this root.
    const store = e.code === "not-started" && d.root !== undefined && !d.rootMissing ? rootStoreProblem(d.root) : undefined;
    const writeProblem = e.code === "not-started" && restartRoot !== undefined && (d.stopped || preparedNeverStarted(d)) ? preparedRootWriteProblem(restartRoot) : undefined;
    const journal = e.code === "not-started" && d.root !== undefined && !d.rootMissing ? unusableStackJournal(d.root) : undefined;
    // So does a service instance record of its space that no command can read, which is also a warning.
    const instances = e.code === "not-started" && !journal && d.space !== undefined ? unusableServiceInstances(d.space) : undefined;
    if (instances) gaps.add("SERVICE_INSTANCES_UNAVAILABLE", instances.remedy ? `${instances.message}; ${instances.remedy}` : instances.message, { space: d.space, ...(instances.target as object | null) });
    // This folder's stack cut off with no recorded outcome is named under the selected space, and
    // Next names the step that finishes or settles it. One that neither blocks nor stays part way
    // settles from its members' processes when it starts.
    if (journal) return reportSelectedJournal(result, journal, hints);
    if (instances) hints.push(instances.remedy ?? instances.message);
    else if (writeProblem) hints.push(`${d.stopped ? "Restart" : "First start"} blocked: ${writeProblem.message}. ${writeProblem.remedy}`);
    else if (store) hints.push(`${store.message}; ${store.remedy}`);
    else if (restartRoot !== undefined) {
      const block = channelSeedRestartBlock(restartRoot);
      if (block) {
        Object.assign(result, { channelSeedBlocksRestart: true, root: restartRoot });
        hints.push(`${d.space && !d.stopped ? "First start" : "Restart"} blocked: ${block.message}. ${block.remedy}`);
      } else {
        const legacy = d.lastRun ? await legacyRestartAddressProblem(d.server, `${cmd} up`) : undefined;
        if (legacy) result.message += `; ${legacy.message}`;
        hints.push(legacy?.remedy ?? held?.remedy ?? (remedy === undefined ? message : displayRemedy(remedy, cmd)));
      }
    } else if (!d.unsettled || !servedStack(folder, result)) {
      hints.push(held?.remedy ?? (remedy === undefined ? message : displayRemedy(remedy, cmd)));
    } else if (!folder.stackBlock && !folder.stackUnfinished) hints.push(`start it with ${codeSpan(`${cmd} up`)} in ${d.root}`);
    return result;
  }
  const target = selected.target;
  const base = {
    resolved: true as const,
    space: target.space,
    server: displayStatusBroker(target.server, target.space, gaps),
    mode: target.mode,
    source: target.source,
    root: target.root,
    rootGone: stackRootGone(target.space, target.root),
    tlsRequired: Boolean(target.tlsRequired),
    eventsRequired: target.policy?.events === "required",
    idp: target.userAuth?.idp.url ?? null,
    personas: personaCatalog(target.root, gaps),
    staleRecord: false,
    login: null,
    deliveryResponder: null,
    channels: null,
    membershipFeed: null,
    spaceStreams: { state: "not-checked" as const, root: null, stack: null },
    storedBytes: null,
  };
  // A moved project keeps its trust under its new path. Prefer that specific diagnosis when
  // this folder holds the records, otherwise report the missing stack root before any auth probe.
  const moved = target.mode === "auth" && !target.auth ? movedProject(target.space, target.root) : undefined;
  if (moved) {
    hints.push(moved.remedy);
    return { resolved: false, code: "moved-folder", message: moved.message };
  }
  const overridden = (target.source === "flag-server" || target.source === "flag-space-override") &&
    (target.recordedServer === undefined || brokerUrlKey(target.recordedServer) !== brokerUrlKey(target.server));
  if (base.rootGone && !overridden) return { ...base, connection: "root-gone", snapshot: { state: "skipped", reason: "the stack's project folder was moved or deleted" } };
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
    return { ...result, ...(await readSnapshot(() => userSnapshotEndpoint(target, stateDir), target.space, true, gaps)) };
  }
  if (preflight === undefined) throw new Error("status: selected non-user target has no preflight observation");
  if (!preflight.ok) {
    // A `--server` address that is not the one recorded for the space says nothing about whether its
    // stack runs, so Next names that address as the refusal of other commands does. A stopped stack
    // this machine started keeps its registration, as a connect keeps it, so Next names the `up` that
    // starts it again rather than a registration to repair.
    const offline = preflight.kind === "unreachable" && !overridden && target.origin === "up";
    const store = offline && !pidfileUnreadable ? rootStoreProblem(target.root) : undefined;
    let seedBlock: CommandFailure | undefined;
    // A blocked stack refuses that `up`, and Next names the step that clears the block instead.
    if (preflight.kind === "unreachable" && (overridden || offline && !pidfileUnreadable || target.origin === "manual") && !(servedStack(folder, base) && folder.stackBlock)) {
      const { message, remedy, restartRoot } = workspaceErrorParts({ kind: "preflight", failure: "unreachable", target, pruned: !offline && preflight.prune });
      seedBlock = store || restartRoot === undefined ? undefined : channelSeedRestartBlock(restartRoot);
      if (store) hints.push(`${store.message}; ${store.remedy}`);
      else if (seedBlock) hints.push(`${message}. Restart blocked: ${seedBlock.message}. ${seedBlock.remedy}`);
      else hints.push(remedy === undefined ? message : `${message}; ${displayRemedy(remedy, cmd)}`);
    }
    if (preflight.kind === "non-nats-listener" || preflight.kind === "auth-unsupported" || preflight.kind === "jetstream-unsupported") {
      const { message, remedy } = workspaceErrorParts({ kind: "preflight", failure: preflight.kind, target, pruned: false, pid: preflight.pid });
      hints.push(remedy === undefined ? message : `${message}; ${displayRemedy(remedy, cmd)}`);
    }
    return { ...base, connection: preflight.kind, ...(seedBlock ? { channelSeedBlocksRestart: true as const } : {}), ...(preflight.kind === "broker-stopped" ? { brokerPid: preflight.pid } : {}), staleRecord: preflight.prune && !offline, snapshot: { state: "skipped", reason: "broker not connected" } };
  }
  // The mesh-level statement of the same axis (#1576). The folder section says what this machine's
  // delivery PROCESS is doing; this says whether the SPACE currently has a bound responder, which is
  // the question "can I spawn into this mesh right now" actually reduces to. An operator reading a
  // reachable broker and a running daemon had, before this, no row that said otherwise.
  return { ...base, connection: "ok", deliveryResponder: target.mode === "open" && !responder.leased ? null : responder.state, ...(await readSnapshot(() => snapshotEndpoint(target), target.space, spaceStreamsExpected(target.space, target.mode), gaps)) };
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

/** The absent streams of `space`, with this machine's stack of it. */
function absentStreams(space: string): Extract<SelectedResult, { resolved: true }>["spaceStreams"] {
  const local = stackState(space);
  return { state: "absent", root: local?.root ?? null, stack: local?.stack ?? null };
}

/** The selected space's channels and membership feed, read over one short-lived connection, and
 *  where `streams` says `cotal up` created them, whether its streams are still on the broker. The
 *  roster is not part of status: who is present is a separate read. */
async function readSnapshot(
  endpoint: () => Promise<CotalEndpoint>,
  space: string,
  streams: boolean,
  gaps: Gaps,
): Promise<Pick<Extract<SelectedResult, { resolved: true }>, "snapshot" | "channels" | "membershipFeed" | "spaceStreams" | "storedBytes">> {
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
    return { snapshot: { state: "unavailable", reason: (e as Error).message }, channels: null, membershipFeed: null, spaceStreams: { state: "not-checked", root: null, stack: null }, storedBytes: null };
  }
  try {
    const channels = await ep.listChannels();
    const feed = await ep.readMembership().catch(() => undefined);
    const gone = streams && await chatStreamGone(ep);
    const storedBytes = await ep.storedBytes().catch(() => null);
    return {
      snapshot: { state: "read", reason: null },
      channels: channels.map((ch) => ({ channel: ch.channel, messages: ch.messages })),
      membershipFeed: feed ? { entries: feed.members.length, asOf: feed.asOf ? new Date(feed.asOf).toISOString() : null } : null,
      spaceStreams: !streams ? { state: "not-checked", root: null, stack: null } : gone ? absentStreams(space) : { state: "present", root: null, stack: null },
      storedBytes,
    };
  } catch (e) {
    gaps.add("SNAPSHOT_UNAVAILABLE", `the channels of ${space} could not be read: ${(e as Error).message}`, { space });
    return { snapshot: { state: "unavailable", reason: (e as Error).message }, channels: null, membershipFeed: null, spaceStreams: { state: "not-checked", root: null, stack: null }, storedBytes: null };
  } finally {
    await ep.stop().catch(() => {});
  }
}

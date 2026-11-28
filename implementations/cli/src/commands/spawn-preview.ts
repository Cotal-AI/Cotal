import { localDiagnostic } from "../telemetry.js";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { connectorServers, loadCotalConfig, parseAgentFileSource, parseShareSelection, ProjectConfigTrustError, spawnEnvAllow, token, type AgentDef, type Connector, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, findMesh, isCommandFailure, recordOperationSpace, brokerAddressForDisplay, cachedPreferences, isWorkspaceTargetError, previewPersonaReader, projectTrustForPreview, personaDir, PersonaSourceError, presentationOf, pruneStaleMeshes, resolveAgentType, resolveMeshTarget, resolvePreference, resolveReadsLiveness, targetErrorCode, workspaceErrorParts, writeResult, type MeshTarget, type OutputWarning, type Report } from "@cotal-ai/workspace";
import { mergeLaunchOptions, parseLaunchModes, parseLaunchOptions } from "@cotal-ai/workspace";
import { extensionNames, materializeExtension, preflightRuntime } from "../ext-loader.js";
import { brokenPersonaLink, callerHarness, checkSpawnExpiryTarget, directPersonaPath, directSpawnCwd, missingConnector, missingPersonaFailure, nonDirectoryPersonaPath, spawnPersona, spawnUsesManager, type PersonaSite } from "../lib/spawn-defaults.js";
import { spawnReadAcl } from "../lib/channel-flags.js";
import { managerPin } from "../lib/manager-choice.js";
import { unreadablePersona } from "../lib/persona-files.js";
import { refuseDirectSpawnName, spawnRerun, unsupportedVariantRemedy } from "./spawn-flags.js";
import { checkHarness, invalidEnvironmentValues } from "./config.js";
import { DEFAULT_AGENT } from "../lib/default-persona.js";
import { refuseUnmintableName } from "./spawn-managed-launch.js";
import type { spawnFlags, validateSpawnArguments } from "./spawn.js";

type Channels = ReturnType<typeof validateSpawnArguments>;

function readPreviewConfig(root: string, target: { space: string; path: string }, trusted: ReturnType<typeof projectTrustForPreview>) {
  try { return loadCotalConfig(root, trusted); }
  catch (error) {
    if (!(error instanceof ProjectConfigTrustError)) throw error;
    throw new CommandFailure("refused", "PERMISSION_DENIED", error.message, { target });
  }
}

type Values = FlagValues<typeof spawnFlags>;

/** Where the persona came from, in words. */
const sourceText = (source: string): string =>
  source === "file" ? "a persona file (--file)" : source === "argument" ? "named on the command line" : source === "default" ? "the default persona" : source;

/** A managed preview cannot check the execution host's connectors. Warn about an unknown local
 *  harness, naming an environment choice as `config` and `status` do. */
function unknownHarness(harness: string | undefined, explicit: boolean, space: string): OutputWarning[] {
  if (harness === undefined) return [];
  try { checkHarness(harness); return []; }
  catch (error) {
    if (!isCommandFailure(error)) throw error;
    const fromEnv = explicit ? [] : invalidEnvironmentValues([resolvePreference("harness", { space, preferences: cachedPreferences() })]);
    return fromEnv.length ? fromEnv : [{ code: "HARNESS_UNKNOWN", target: { harness }, message: `${error.message}; the launch is refused unless the selected manager has that connector` }];
  }
}

/** An offline preview never signs in to a broker or allocates an agent. It
 *  reads whether the recorded brokers answer only where the launch reads it to pick its space, so the
 *  two name the same one. */
export async function spawnLaunchPreview(args: Pick<ParsedArgs, "positionals"> & { values: Values }, channels: Channels): Promise<void> {
  const values = args.values;
  let root: string;
  let space: string;
  let broker: string | null = null;
  let targetMode: string | null = null;
  let selected: MeshTarget | undefined;
  // Where a missing persona was looked for. A space that is not started is a local root `up` starts.
  let site: PersonaSite;
  try {
    // A space this folder registered is the target only while it runs, which the launch reads from
    // the recorded brokers before it resolves. The preview reads the same, without signing in.
    const flags = { space: values.space, server: values.server };
    const sweep = resolveReadsLiveness(process.cwd(), flags) ? await pruneStaleMeshes(values.server, "targets") : {};
    selected = resolveMeshTarget(process.cwd(), { ...flags, ...sweep, readOnly: true });
    root = selected.root; space = selected.space; broker = brokerAddressForDisplay(selected.server) ?? null; targetMode = selected.mode; site = selected;
  } catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    const { root: localRoot, space: preparedSpace, stackSpace, lastRun, recordedRoot } = error.details;
    const offlineSpace = preparedSpace ?? (lastRun && recordedRoot === undefined ? stackSpace : undefined);
    if (error.code === "not-started" && localRoot && offlineSpace) { root = localRoot; space = offlineSpace; site = { root, space, personaRoot: personaDir(root), origin: "up" }; }
    else if (error.code === "unknown-space" && values["enrollment-file"] && values.file && values.space && token(values.space) === values.space) { root = process.cwd(); space = values.space; site = { root, space, personaRoot: personaDir(root) }; }
    // Every other resolution failure keeps the sentence and next step the reads print for it, so a
    // preview in a copied, moved or taken-over folder names that folder rather than reporting only
    // that a target could not be resolved. The preview's own assurance is appended to it.
    else {
      const resolved = workspaceErrorParts({ kind: "target", error });
      throw new CommandFailure("refused", targetErrorCode(error.code), `${resolved.message}; the preview resolved no target and selected no different space`, resolved.remedy === undefined ? {} : { remedy: resolved.remedy });
    }
  }
  recordOperationSpace(space);
  if (selected) checkSpawnExpiryTarget(values, selected);
  const { ref, from } = spawnPersona(values.config, args.positionals, { space, preferences: cachedPreferences() });
  const requested = { persona: ref, source: values.file ? "file" : values.config !== undefined || args.positionals.length ? "argument" : from ?? "default", harness: values.agent ?? null, name: values.name ?? null, model: values.model ?? null, cwd: values.cwd ?? null, instanceId: values.on ?? null, runtime: values.runtime?.trim() ?? null, restarts: values.restarts === undefined ? null : Number(values.restarts), restartWindowMs: values["restart-window"] === undefined ? null : Number(values["restart-window"]) };
  // A folder whose records name no space is refused above, so a preview never names an assumed space.
  const target = { space, broker, authMode: targetMode };
  if (spawnUsesManager(values)) {
    // A `--on` value that cannot be an instance id is refused here on an open or static mesh,
    // as the launch refuses it: the shape check needs no manager lookup. A user-auth mesh keeps
    // names and hosts as valid pins, and resolving one reads presence, so it is left alone.
    const mode = targetMode ?? findMesh(space)?.mode;
    if (mode !== "user") await managerPin(values, spawnRerun(values, args.positionals));
    if (values.name !== undefined) refuseUnmintableName(values.name, targetMode === "user");
    // The manager resolves the persona, harness and working directory on its own host at launch, so
    // the preview shows the request and says what it did not read.
    const warnings = unknownHarness(values.agent ?? callerHarness(space), values.agent !== undefined, space);
    // A named runtime is checked with the lookup `up --runtime` uses, on this host only: the launch
    // refuses it here when it goes to this root's own manager, and a manager elsewhere checks its own.
    let runtimeCheck: { host: string; available: boolean; error: string | null } | null = null;
    let runtimeText = "the serving manager's own; not checked";
    if (requested.runtime !== null) {
      let error: string | null = null;
      try { await preflightRuntime(requested.runtime); } catch (e) { error = e instanceof Error ? e.message : String(e); }
      runtimeCheck = { host: hostname(), available: error === null, error };
      runtimeText = `${requested.runtime} · ${error === null ? "available" : "not available"} on ${runtimeCheck.host}; a manager on another host checks its own`;
      if (error !== null) warnings.push({ code: "RUNTIME_UNAVAILABLE", target: { runtime: requested.runtime, host: runtimeCheck.host }, message: `${error}; a launch through this root's own manager is refused, and a manager on another host checks its own` });
    }
    writeResult(presentationOf(values), { command: "spawn", target, result: { kind: "managed-launch-preview", dryRun: true, requested, executionHost: "manager-selected-at-launch", personaValidation: "not-checked-on-execution-host", effectiveHarness: null, effectiveCwd: null, runtimeCheck, enrollment: "not-read-or-redeemed", allocated: false, launched: false }, completeness: "not-checked", warnings }, (result): Report => ({ sections: [
      { title: "Managed launch preview", blocks: [{ kind: "fields", rows: [["Space", space], ["Broker", broker ?? "not checked"], ["Persona request", result.requested.persona], ["Persona source", sourceText(result.requested.source)], ["Manager pin", result.requested.instanceId ?? "not selected"], ["Harness request", result.requested.harness ?? "manager/persona precedence; not checked"], ["Working-directory request", result.requested.cwd ?? "manager default; not read"], ["Runtime", runtimeText], ["View", values.detach ? "return after readiness" : "attach after readiness"], ["Execution-host validation", { text: "not performed", tone: "waiting" }]] }, { kind: "lines", lines: ["The selected manager reads its own persona, harness and working directory at launch and validates them there; your local files are not used.", "No broker request, connector import, file upload, enrollment redemption, provisioning, identity allocation or launch occurred."] }] },
    ] }));
    return;
  }
  const path = values.file !== undefined || (values["enrollment-file"] && values.config) ? resolve(ref) : directPersonaPath(root, ref, values.config === undefined);
  let definition: AgentDef;
  let personaRefusal: string | undefined;
  // A missing product default is what the launch writes from the shipped template, so the preview
  // reads that template and writes nothing.
  let personaWrite: "none" | "shipped-default" = "none";
  let blockedDefault: CommandFailure | undefined;
  const useShippedDefault = ref === "default" && from === undefined && values.config === undefined && values["enrollment-file"] === undefined;
  const trusted = projectTrustForPreview();
  try { ({ def: definition, refusal: personaRefusal } = previewPersonaReader("launch", trusted)(path)); }
  catch (error) {
    // A missing persona is refused as the launch refuses it, naming where it was looked for.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && useShippedDefault) {
      blockedDefault = brokenPersonaLink(path, { ...target, path }, true);
      definition = parseAgentFileSource(DEFAULT_AGENT, path);
      if (!blockedDefault) personaWrite = "shipped-default";
    } else if (code === "ENOENT") {
      throw missingPersonaFailure(site, ref, from, path, { ...target, path }, presentationOf(values));
    } else if (error instanceof PersonaSourceError) {
      throw localDiagnostic(new CommandFailure("refused", "SCHEMA_INVALID", error.message, { target: { ...target, path }, ...(error.remedy ? { remedy: error.remedy } : {}) }));
    } else if (code === "ELOOP") {
      throw new CommandFailure("refused", "SCHEMA_INVALID", `the persona path contains a symbolic-link loop: ${path}`, {
        target: { ...target, path }, remedy: "correct the link's target, or move the link aside and put a regular persona file in its place",
      });
    } else {
      throw unreadablePersona(path, code, { ...target, path }) ?? previewPersonaReadFailure(path, code, { ...target, path });
    }
  }
  if (personaRefusal) throw new CommandFailure("refused", "PERMISSION_DENIED", personaRefusal, { target: { ...target, path } });
  spawnReadAcl(channels.subscribe ?? definition.subscribe ?? [], channels["allow-subscribe"] ?? definition.allowSubscribe);
  const config = readPreviewConfig(root, { ...target, path }, trusted);
  const cwd = directSpawnCwd(values.cwd ?? ".", space);
  const harness = resolveAgentType({ flag: values.agent, pin: definition.agent, callerDefault: callerHarness(space) });
  try { checkHarness(harness); }
  catch (error) {
    if (!isCommandFailure(error)) throw error;
    throw missingConnector(harness, { ...target, path });
  }
  const requestedName = values.name ?? definition.name;
  refuseDirectSpawnName(requestedName, targetMode === "user", path, values, args.positionals, { ...target, path });
  const variant = values.variant ?? definition.variant;
  let connectorArgumentsChecked = false;
  if (extensionNames("connector").includes(harness)) {
    let connector: Connector;
    try { connector = await materializeExtension<Connector>({ kind: "connector", name: harness }); }
    catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", error instanceof Error ? error.message : String(error), { target: { ...target, path } }); }
    const unavailable = connector.launchUnavailable?.({ resume: values.resume });
    if (unavailable) throw new CommandFailure("refused", "UNSUPPORTED", unavailable, { target: { ...target, path } });
    if (connector.supportsLaunchValidation) {
      try {
        const shareTools = parseShareSelection(values["share-tools"]);
        connector.buildLaunch({
          validateOnly: true, space, name: requestedName, role: values.role ?? definition.role,
          configPath: personaWrite === "none" && !blockedDefault ? path : undefined,
          model: values.model ?? definition.model, variant, modes: parseLaunchModes(values.mode),
          launchOptions: mergeLaunchOptions(definition.launchOptions, parseLaunchOptions(values.opt)),
          prompt: values.prompt, resume: values.resume, events: values.events || (!values["no-events"] && !!connector.eventChannel),
          mcpServers: connectorServers(config, harness, shareTools), mcpServersExclusive: shareTools !== undefined,
          envAllow: spawnEnvAllow(config), workspaceRoot: root,
        });
        connectorArgumentsChecked = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const remedy = variant && !connector.supportsModelVariant && /(?:does not support model variants \(variant\)|model variants are not supported|model variants \(variant\) are not implemented)$/.test(message)
          ? unsupportedVariantRemedy(values.variant, definition.variant, path) : undefined;
        throw new CommandFailure("refused", "USAGE_INVALID", message, { target: { ...target, path }, remedy });
      }
    }
  }
  const result = { kind: "direct-launch-preview", dryRun: true, space, executionHost: hostname(), persona: { path, source: requested.source, write: personaWrite as "none" | "shipped-default" }, requestedName, harness, cwd, role: values.role ?? definition.role ?? null, model: values.model ?? definition.model ?? null, variant: variant ?? null, promptProvided: values.prompt !== undefined, enrollment: "not-read-or-redeemed", connectorAvailability: "not-checked", connectorArgumentValidation: connectorArgumentsChecked ? "checked" : "not-checked", authorization: "not-checked", allocated: false, launched: false };
  const warnings = blockedDefault ? [{ code: blockedDefault.code, target: blockedDefault.target, message: `${blockedDefault.message}. To launch, ${blockedDefault.remedy}.` }] : [];
  writeResult(presentationOf(values), { command: "spawn", target, result, warnings }, (data): Report => ({ sections: [
    { title: "Direct launch preview", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Execution host", data.executionHost], ["Persona file", data.persona.write === "shipped-default" ? `${data.persona.path} (the launch writes the shipped default persona here; the preview wrote nothing)` : data.persona.path], ["Source", sourceText(data.persona.source)], ["Requested name", data.requestedName], ["Harness", data.harness], ["Working directory", data.cwd], ["Role", data.role ?? "not declared"], ["Model", data.model ?? "application default; not checked"], ["Variant", data.variant ?? "not declared"], ["Connector arguments", connectorArgumentsChecked ? "checked" : "not checked"], ["Enrollment", "not read or redeemed"], ["Binary/login/authority checks", "not performed"]] }, { kind: "lines", lines: ["No broker connection, provisioning, identity allocation or launch occurred. Native foreground execution is not a detachable Cotal view."] }] },
  ] }));
}

function previewPersonaReadFailure(path: string, code: string | undefined, target: object): CommandFailure {
  if (code === "ENOTDIR") return nonDirectoryPersonaPath(path, target);
  return new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona: ${path}`, { target });
}

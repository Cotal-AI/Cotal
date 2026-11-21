import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { connectorServers, loadCotalConfig, parseAgentFileSource, parseShareSelection, spawnEnvAllow, spawnNameError, token, type AgentDef, type Connector, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, instanceIdShaped, isCommandFailure, isConnectRefusal, recordOperationSpace, brokerAddressForDisplay, cachedPreferences, isWorkspaceTargetError, loadLaunchPersonaFile, personaDir, PersonaSourceError, presentationOf, pruneStaleMeshes, resolveAgentType, resolveMeshTarget, resolvePreference, resolveRawOpenTarget, resolveReadsLiveness, targetErrorCode, workspaceErrorParts, writeResult, type MeshTarget, type OutputWarning, type Report } from "@cotal-ai/workspace";
import { mergeLaunchOptions, parseLaunchOptions } from "@cotal-ai/workspace";
import { extensionNames, materializeExtension, preflightRuntime } from "../ext-loader.js";
import { callerHarness, checkSpawnExpiryTarget, directPersonaPath, managedSpawnCaller, missingConnector, missingPersona, refuseUnmintableName, spawnPersona, spawnUsesManager, type PersonaSite } from "../lib/spawn-defaults.js";
import { checkHarness, invalidEnvironmentValues } from "./config.js";
import { DEFAULT_AGENT } from "../lib/default-persona.js";
import { validateManagerSelector } from "../lib/manager-choice.js";
import { spawnRerun, type spawnFlags } from "./spawn-flags.js";

type Values = FlagValues<typeof spawnFlags>;
type PreviewArgs = Pick<ParsedArgs, "positionals"> & { values: Values };
type PreviewTarget = { space: string; broker: string | null; mode: MeshTarget["mode"] | null };

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
export async function spawnLaunchPreview(args: PreviewArgs): Promise<void> {
  const values = args.values;
  const managed = spawnUsesManager(values);
  let root: string;
  let space: string;
  let broker: string | null = null;
  let targetMode: PreviewTarget["mode"] = null;
  let selected: MeshTarget | undefined;
  // Where a missing persona was looked for. A space that is not started is a local root `up` starts.
  let site: PersonaSite;
  try {
    // A space this folder registered is the target only while it runs, which the launch reads from
    // the recorded brokers before it resolves. The preview reads the same, without signing in.
    const caller = managed ? managedSpawnCaller(values.space) : undefined;
    const flags = { space: caller?.space ?? values.space, server: values.server };
    if (managed && !caller?.seatIntent) {
      const raw = resolveRawOpenTarget(process.cwd(), { ...flags, creds: values.creds, readOnly: true });
      if (raw) return managedPreview(args, { space: raw.space, broker: brokerAddressForDisplay(raw.server) ?? null, mode: "open" });
    }
    const sweep = resolveReadsLiveness(process.cwd(), flags) ? await pruneStaleMeshes(values.server, "targets") : {};
    selected = resolveMeshTarget(process.cwd(), { ...flags, ...sweep, readOnly: true });
    root = selected.root; space = selected.space; broker = brokerAddressForDisplay(selected.server) ?? null; targetMode = selected.mode; site = selected;
  } catch (error) {
    if (isConnectRefusal(error)) throw error.failure();
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "not-started" && error.details.root && error.details.space) { root = error.details.root; space = error.details.space; site = { root, space, personaRoot: personaDir(root), origin: "up" }; }
    else if (error.code === "unknown-space" && values["enrollment-file"] && values.file && values.space && token(values.space) === values.space) { root = process.cwd(); space = values.space; site = { root, space, personaRoot: personaDir(root) }; }
    // Every other resolution failure keeps the sentence and next step the reads print for it, so a
    // preview in a copied, moved or taken-over folder names that folder rather than reporting only
    // that a target could not be resolved. The preview's own assurance is appended to it.
    else {
      const resolved = workspaceErrorParts({ kind: "target", error });
      throw new CommandFailure("refused", targetErrorCode(error.code), `${resolved.message}; the preview resolved no target and selected no different space`, resolved.remedy === undefined ? {} : { remedy: resolved.remedy });
    }
  }
  if (managed) return managedPreview(args, { space, broker, mode: targetMode });
  recordOperationSpace(space);
  if (selected) checkSpawnExpiryTarget(values, selected);
  const { ref, from } = spawnPersona(values.config, args.positionals, { space, preferences: cachedPreferences() });
  const source = personaSource(args, from);
  // A folder whose records name no space is refused above, so a preview never names an assumed space.
  const target = { space, broker, authMode: targetMode };
  const path = values.file !== undefined || (values["enrollment-file"] && values.config) ? resolve(ref) : directPersonaPath(root, ref, values.config === undefined && args.positionals.length > 0);
  let definition: AgentDef;
  // A missing product default is what the launch writes from the shipped template, so the preview
  // reads that template and writes nothing.
  let personaWrite: "none" | "shipped-default" = "none";
  const useShippedDefault = ref === "default" && from === undefined && values.config === undefined && values["enrollment-file"] === undefined;
  try { definition = loadLaunchPersonaFile(path); }
  catch (error) {
    // A missing persona is refused as the launch refuses it, naming where it was looked for.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && useShippedDefault) {
      definition = parseAgentFileSource(DEFAULT_AGENT, path);
      personaWrite = "shipped-default";
    } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const missing = missingPersona(site, ref, from, path);
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", missing.message, { target: { ...target, path }, ...(missing.remedy ? { remedy: missing.remedy } : {}) });
    } else if (error instanceof PersonaSourceError) {
      throw new CommandFailure("refused", "SCHEMA_INVALID", error.message, { target: { ...target, path }, ...(error.remedy ? { remedy: error.remedy } : {}) });
    } else {
      throw new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona: ${path}`, { target: { ...target, path } });
    }
  }
  let cwd: string;
  try { cwd = realpathSync(values.cwd ? resolve(values.cwd) : process.cwd()); if (!statSync(cwd).isDirectory()) throw new Error(); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the direct launch's local working directory is unavailable; no directory was created"); }
  const harness = resolveAgentType({ flag: values.agent, pin: definition.agent, callerDefault: callerHarness(space) });
  try { checkHarness(harness); }
  catch (error) {
    if (!isCommandFailure(error)) throw error;
    throw missingConnector(harness, { ...target, path });
  }
  const requestedName = values.name ?? definition.name;
  const nameError = spawnNameError(requestedName, { userMode: targetMode === "user" });
  if (nameError) throw new CommandFailure("refused", "USAGE_INVALID", nameError, { target: { ...target, path } });
  let connectorArgumentsChecked = false;
  if (extensionNames("connector").includes(harness)) {
    let connector: Connector;
    try { connector = await materializeExtension<Connector>({ kind: "connector", name: harness }); }
    catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", error instanceof Error ? error.message : String(error), { target: { ...target, path } }); }
    if (connector.supportsLaunchValidation) {
      const config = loadCotalConfig(root);
      try {
        const shareTools = parseShareSelection(values["share-tools"]);
        connector.buildLaunch({
          validateOnly: true, space, name: requestedName, role: values.role ?? definition.role,
          configPath: personaWrite === "none" ? path : undefined,
          model: values.model ?? definition.model, variant: values.variant ?? definition.variant,
          launchOptions: mergeLaunchOptions(definition.launchOptions, parseLaunchOptions(values.opt)),
          prompt: values.prompt, resume: values.resume, events: values.events || (!values["no-events"] && !!connector.eventChannel),
          mcpServers: connectorServers(config, harness, shareTools), mcpServersExclusive: shareTools !== undefined,
          envAllow: spawnEnvAllow(config), workspaceRoot: root,
        });
        connectorArgumentsChecked = true;
      } catch (error) {
        throw new CommandFailure("refused", "USAGE_INVALID", error instanceof Error ? error.message : String(error), { target: { ...target, path } });
      }
    }
  }
  const result = { kind: "direct-launch-preview", dryRun: true, space, executionHost: hostname(), persona: { path, source, write: personaWrite as "none" | "shipped-default" }, requestedName, harness, cwd, role: values.role ?? definition.role ?? null, model: values.model ?? definition.model ?? null, variant: values.variant ?? definition.variant ?? null, promptProvided: values.prompt !== undefined, enrollment: "not-read-or-redeemed", connectorAvailability: "not-checked", connectorArgumentValidation: connectorArgumentsChecked ? "checked" : "not-checked", authorization: "not-checked", allocated: false, launched: false };
  writeResult(presentationOf(values), { command: "spawn", target, result }, (data): Report => ({ sections: [
    { title: "Direct launch preview", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Execution host", data.executionHost], ["Persona file", data.persona.write === "shipped-default" ? `${data.persona.path} (the launch writes the shipped default persona here; the preview wrote nothing)` : data.persona.path], ["Source", sourceText(data.persona.source)], ["Requested name", data.requestedName], ["Harness", data.harness], ["Working directory", data.cwd], ["Role", data.role ?? "not declared"], ["Model", data.model ?? "application default; not checked"], ["Variant", data.variant ?? "not declared"], ["Connector arguments", connectorArgumentsChecked ? "checked" : "not checked"], ["Enrollment", "not read or redeemed"], ["Binary/login/authority checks", "not performed"]] }, { kind: "lines", lines: ["No broker connection, provisioning, identity allocation or launch occurred. Native foreground execution is not a detachable Cotal view."] }] },
  ] }));
}

function personaSource({ values, positionals }: PreviewArgs, from: string | undefined): string {
  if (values.file) return "file";
  return values.config !== undefined || positionals.length ? "argument" : from ?? "default";
}

async function managedPreview(args: PreviewArgs, mesh: PreviewTarget): Promise<void> {
  const { values, positionals } = args;
  const { space, broker } = mesh;
  recordOperationSpace(space);
  validateManagerSelector(values.on, spawnRerun(values, positionals), mesh.mode ?? undefined);
  if (values.name !== undefined) refuseUnmintableName(values.name, mesh.mode === "user");
  const { ref, from } = spawnPersona(values.config, positionals, { space, preferences: cachedPreferences() });
  const instanceId = values.on !== undefined && instanceIdShaped(values.on) ? values.on : null;
  const managerSelector = values.on !== undefined && instanceId === null ? values.on : undefined;
  const requested = { persona: ref, source: personaSource(args, from), harness: values.agent ?? null, name: values.name ?? null, model: values.model ?? null, cwd: values.cwd ?? null, instanceId, ...(managerSelector !== undefined ? { managerSelector } : {}), runtime: values.runtime?.trim() ?? null, restarts: values.restarts === undefined ? null : Number(values.restarts), restartWindowMs: values["restart-window"] === undefined ? null : Number(values["restart-window"]) };
  const warnings = unknownHarness(values.agent ?? callerHarness(space), values.agent !== undefined, space);
  // The launch checks a named runtime here only when it goes to this root's own manager.
  let runtimeCheck: { host: string; available: boolean; error: string | null } | null = null;
  let runtimeText = "the serving manager's own; not checked";
  if (requested.runtime !== null) {
    let error: string | null = null;
    try { await preflightRuntime(requested.runtime); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    runtimeCheck = { host: hostname(), available: error === null, error };
    runtimeText = `${requested.runtime} · ${error === null ? "available" : "not available"} on ${runtimeCheck.host}; a manager on another host checks its own`;
    if (error !== null) warnings.push({ code: "RUNTIME_UNAVAILABLE", target: { runtime: requested.runtime, host: runtimeCheck.host }, message: `${error}; a launch through this root's own manager is refused, and a manager on another host checks its own` });
  }
  const managerText = managerSelector === undefined ? instanceId ?? "not selected" : `${managerSelector} (resolved at launch)`;
  writeResult(presentationOf(values), { command: "spawn", target: { space, broker, authMode: mesh.mode }, result: { kind: "managed-launch-preview", dryRun: true, requested, executionHost: "manager-selected-at-launch", personaValidation: "not-checked-on-execution-host", effectiveHarness: null, effectiveCwd: null, runtimeCheck, enrollment: "not-read-or-redeemed", allocated: false, launched: false }, completeness: "not-checked", warnings }, (result): Report => ({ sections: [
    { title: "Managed launch preview", blocks: [{ kind: "fields", rows: [["Space", space], ["Broker", broker ?? "not checked"], ["Persona request", result.requested.persona], ["Persona source", sourceText(result.requested.source)], ["Manager pin", managerText], ["Harness request", result.requested.harness ?? "manager/persona precedence; not checked"], ["Working-directory request", result.requested.cwd ?? "manager default; not read"], ["Runtime", runtimeText], ["View", values.detach ? "return after readiness" : "attach after readiness"], ["Execution-host validation", { text: "not performed", tone: "waiting" }]] }, { kind: "lines", lines: ["The selected manager reads its own persona, harness and working directory at launch and validates them there; your local files are not used.", "No broker request, connector import, file upload, enrollment redemption, provisioning, identity allocation or launch occurred."] }] },
  ] }));
}

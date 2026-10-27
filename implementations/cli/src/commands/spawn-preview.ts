import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { agentFilePath, token, type AgentDef, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, recordOperationSpace, brokerAddressForDisplay, cachedPreferences, isWorkspaceTargetError, loadLaunchPersonaFile, personaDir, presentationOf, pruneStaleMeshes, resolveAgentType, resolveMeshTarget, resolvePreference, resolveReadsLiveness, targetErrorCode, workspaceErrorParts, writeResult, type OutputWarning, type Report } from "@cotal-ai/workspace";
import { preflightRuntime } from "../ext-loader.js";
import { callerHarness, missingPersona, spawnPersona, spawnUsesManager, type PersonaSite } from "../lib/spawn-defaults.js";
import { checkHarness, invalidEnvironmentValues } from "./config.js";
import type { spawnFlags } from "./spawn.js";

type Values = FlagValues<typeof spawnFlags>;

/** Where the persona came from, in words. */
const sourceText = (source: string): string =>
  source === "file" ? "a persona file (--file)" : source === "argument" ? "named on the command line" : source === "default" ? "the default persona" : source;

/** A harness this workstation has no connector for, as a warning: the refusal `config set` gives
 *  it. One that only the environment chose is named the way `config` and `status` name it. */
function unknownHarness(harness: string | undefined, explicit: boolean, space: string, refusal: string): OutputWarning[] {
  if (harness === undefined) return [];
  try { checkHarness(harness); return []; }
  catch (error) {
    if (!isCommandFailure(error)) throw error;
    const fromEnv = explicit ? [] : invalidEnvironmentValues([resolvePreference("harness", { space, preferences: cachedPreferences() })]);
    return fromEnv.length ? fromEnv : [{ code: "HARNESS_UNKNOWN", target: { harness }, message: `${error.message}; ${refusal}` }];
  }
}

/** An offline preview never signs in to a broker, materializes a connector or allocates an agent. It
 *  reads whether the recorded brokers answer only where the launch reads it to pick its space, so the
 *  two name the same one. */
export async function spawnLaunchPreview(args: Pick<ParsedArgs, "positionals"> & { values: Values }): Promise<void> {
  const values = args.values;
  let root: string;
  let space: string;
  let broker: string | null = null;
  let targetMode: string | null = null;
  let assumed = false;
  // Where a missing persona was looked for. A space that is not started is a local root `up` starts.
  let site: PersonaSite;
  try {
    // A space this folder registered is the target only while it runs, which the launch reads from
    // the recorded brokers before it resolves. The preview reads the same, without signing in.
    const flags = { space: values.space, server: values.server };
    const offline = resolveReadsLiveness(process.cwd(), flags) ? (await pruneStaleMeshes(values.server)).offline : [];
    const selected = resolveMeshTarget(process.cwd(), { ...flags, offline, readOnly: true });
    root = selected.root; space = selected.space; broker = brokerAddressForDisplay(selected.server) ?? null; targetMode = selected.mode; assumed = selected.namesNoSpace === true; site = selected;
  } catch (error) {
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
  recordOperationSpace(space);
  const { ref, from } = spawnPersona(values.config, args.positionals, { space, preferences: cachedPreferences() });
  const requested = { persona: ref, source: values.file ? "file" : values.config !== undefined || args.positionals.length ? "argument" : from ?? "default", harness: values.agent ?? null, name: values.name ?? null, model: values.model ?? null, cwd: values.cwd ?? null, instanceId: values.on ?? null, runtime: values.runtime?.trim() ?? null, restarts: values.restarts === undefined ? null : Number(values.restarts), restartWindowMs: values["restart-window"] === undefined ? null : Number(values["restart-window"]) };
  // A folder whose records name no space was given the held default only to preview it, so the
  // target names the folder and the space it assumed, and the report says so under that heading.
  const target = assumed ? { root, assumed: space, broker, authMode: targetMode } : { space, broker, authMode: targetMode };
  const heading = (report: Report): Report => assumed ? { ...report, space, sections: [{ blocks: [{ kind: "lines", lines: [{ text: `this folder names no space; the held default ${space} was assumed`, tone: "hint" }] }] }, ...report.sections] } : report;
  if (spawnUsesManager(values)) {
    // The manager resolves the persona, harness and working directory on its own host at launch, so
    // the preview shows the request and says what it did not read.
    const warnings = unknownHarness(values.agent ?? callerHarness(space), values.agent !== undefined, space, "the launch is refused unless the selected manager has that connector");
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
    writeResult(presentationOf(values), { command: "spawn", target, result: { kind: "managed-launch-preview", dryRun: true, requested, executionHost: "manager-selected-at-launch", personaValidation: "not-checked-on-execution-host", effectiveHarness: null, effectiveCwd: null, runtimeCheck, enrollment: "not-read-or-redeemed", allocated: false, launched: false }, completeness: "not-checked", warnings }, (result): Report => heading({ sections: [
      { title: "Managed launch preview", blocks: [{ kind: "fields", rows: [["Space", space], ["Broker", broker ?? "not checked"], ["Persona request", result.requested.persona], ["Persona source", sourceText(result.requested.source)], ["Manager pin", result.requested.instanceId ?? "not selected"], ["Harness request", result.requested.harness ?? "manager/persona precedence; not checked"], ["Working-directory request", result.requested.cwd ?? "manager default; not read"], ["Runtime", runtimeText], ["View", values.detach ? "return after readiness" : "attach after readiness"], ["Execution-host validation", { text: "not performed", tone: "waiting" }]] }, { kind: "lines", lines: ["The selected manager reads its own persona, harness and working directory at launch and validates them there; your local files are not used.", "No broker request, connector import, file upload, enrollment redemption, provisioning, identity allocation or launch occurred."] }] },
    ] }));
    return;
  }
  const path = values["enrollment-file"] && values.config ? resolve(values.config) : agentFilePath(root, ref);
  let definition: AgentDef;
  try { definition = loadLaunchPersonaFile(path); }
  catch (error) {
    // A missing persona is refused as the launch refuses it, naming where it was looked for.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const missing = missingPersona(site, ref, from, path);
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", missing.message, { target: { ...target, path }, ...(missing.remedy ? { remedy: missing.remedy } : {}) });
    }
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the local launch persona could not be read and validated; no contents were echoed and nothing was allocated", { target: { ...target, path }, remedy: "use a native persona file; a Mesh manifest belongs to cotal team deploy <file>" });
  }
  let cwd: string;
  try { cwd = realpathSync(values.cwd ? resolve(values.cwd) : process.cwd()); if (!statSync(cwd).isDirectory()) throw new Error(); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the direct launch's local working directory is unavailable; no directory was created"); }
  const harness = resolveAgentType({ flag: values.agent, pin: definition.agent, callerDefault: callerHarness(space) });
  const result = { kind: "direct-launch-preview", dryRun: true, space, executionHost: hostname(), persona: { path, source: requested.source }, requestedName: values.name ?? definition.name, harness, cwd, role: values.role ?? definition.role ?? null, model: values.model ?? definition.model ?? null, variant: values.variant ?? definition.variant ?? null, promptProvided: values.prompt !== undefined, enrollment: "not-read-or-redeemed", connectorAvailability: "not-checked", authorization: "not-checked", allocated: false, launched: false };
  const warnings = unknownHarness(harness, values.agent !== undefined || definition.agent !== undefined, space, "the launch refuses it");
  writeResult(presentationOf(values), { command: "spawn", target, result, warnings }, (data): Report => heading({ sections: [
    { title: "Direct launch preview", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Execution host", data.executionHost], ["Persona file", data.persona.path], ["Source", sourceText(data.persona.source)], ["Requested name", data.requestedName], ["Harness", data.harness], ["Working directory", data.cwd], ["Role", data.role ?? "not declared"], ["Model", data.model ?? "application default; not checked"], ["Variant", data.variant ?? "not declared"], ["Enrollment", "not read or redeemed"], ["Binary/login/authority checks", "not performed"]] }, { kind: "lines", lines: ["Local selection and file validation only. No broker connection, connector import, provisioning, identity allocation or launch occurred. Native foreground execution is not a detachable Cotal view."] }] },
  ] }));
}

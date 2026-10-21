import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { agentFilePath, token, type AgentDef, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, brokerAddressForDisplay, cachedPreferences, isWorkspaceTargetError, loadLaunchPersonaFile, presentationOf, resolveAgentType, resolveMeshTarget, targetErrorCode, writeResult, type Report } from "@cotal-ai/workspace";
import { callerHarness, spawnPersona } from "../lib/spawn-defaults.js";
import type { spawnFlags } from "./spawn.js";

type Values = FlagValues<typeof spawnFlags>;

/** An offline preview never probes a broker, materializes a connector or allocates an agent. */
export async function spawnLaunchPreview(args: Pick<ParsedArgs, "positionals"> & { values: Values }): Promise<void> {
  const values = args.values;
  let root: string;
  let space: string;
  let broker: string | null = null;
  let targetMode: string | null = null;
  try {
    const selected = resolveMeshTarget(process.cwd(), { space: values.space, server: values.server, readOnly: true });
    root = selected.root; space = selected.space; broker = brokerAddressForDisplay(selected.server) ?? null; targetMode = selected.mode;
  } catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "not-started" && error.details.root && error.details.space) { root = error.details.root; space = error.details.space; }
    else if (error.code === "unknown-space" && values["enrollment-file"] && values.file && values.space && token(values.space) === values.space) { root = process.cwd(); space = values.space; }
    else throw new CommandFailure("refused", targetErrorCode(error.code), "the preview target could not be resolved without changing the catalog; no different space was selected");
  }
  const { ref, from } = spawnPersona(values.config, args.positionals, { space, preferences: cachedPreferences() });
  const requested = { persona: ref, source: values.file ? "file" : from ?? "explicit-or-product-default", harness: values.agent ?? null, name: values.name ?? null, model: values.model ?? null, cwd: values.cwd ?? null, instanceId: values.on ?? null, restarts: values.restarts === undefined ? null : Number(values.restarts), restartWindowMs: values["restart-window"] === undefined ? null : Number(values["restart-window"]) };
  const target = { space, broker, authMode: targetMode };
  if (!values.foreground) {
    writeResult(presentationOf(values), { command: "spawn", target, result: { kind: "managed-launch-preview", dryRun: true, requested, executionHost: "manager-selected-at-launch", personaValidation: "not-checked-on-execution-host", effectiveHarness: null, effectiveCwd: null, enrollment: "not-read-or-redeemed", allocated: false, launched: false }, completeness: "partial", partial: { message: "Offline managed preview retains the requested selectors only. The selected manager's persona, effective harness and working directory were not read, so this is not a fully resolved launch plan.", remedy: "do not treat the caller's local files as the manager's files; execution-host validation still applies at launch" } }, (result): Report => ({ sections: [
      { title: "Managed launch preview", blocks: [{ kind: "fields", rows: [["Space", space], ["Broker", broker ?? "not checked"], ["Persona request", result.requested.persona], ["Persona source", result.requested.source], ["Manager pin", result.requested.instanceId ?? "not selected"], ["Harness request", result.requested.harness ?? "manager/persona precedence; not checked"], ["Working-directory request", result.requested.cwd ?? "manager default; not read"], ["View", values.detach ? "return after readiness" : "attach after readiness"], ["Execution-host validation", { text: "not performed", tone: "waiting" }]] }, { kind: "lines", lines: ["No broker request, connector import, file upload, enrollment redemption, provisioning, identity allocation or launch occurred. No local file was substituted for an unreadable remote persona."] }] },
    ] }));
    return;
  }
  const path = values["enrollment-file"] && values.config ? resolve(values.config) : agentFilePath(root, ref);
  let definition: AgentDef;
  try { definition = loadLaunchPersonaFile(path); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the local launch persona could not be read and validated; no contents were echoed and nothing was allocated", { target: { ...target, path }, remedy: "use a native persona file; a Mesh manifest belongs to cotal team deploy <file>" }); }
  let cwd: string;
  try { cwd = realpathSync(values.cwd ? resolve(values.cwd) : process.cwd()); if (!statSync(cwd).isDirectory()) throw new Error(); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the direct launch's local working directory is unavailable; no directory was created"); }
  const harness = resolveAgentType({ flag: values.agent, pin: definition.agent, callerDefault: callerHarness(space) });
  const result = { kind: "direct-launch-preview", dryRun: true, space, executionHost: hostname(), persona: { path, source: requested.source }, requestedName: values.name ?? definition.name, harness, cwd, role: values.role ?? definition.role ?? null, model: values.model ?? definition.model ?? null, variant: values.variant ?? definition.variant ?? null, promptProvided: values.prompt !== undefined, enrollment: "not-read-or-redeemed", connectorAvailability: "not-checked", authorization: "not-checked", allocated: false, launched: false };
  writeResult(presentationOf(values), { command: "spawn", target, result }, (data): Report => ({ sections: [
    { title: "Direct launch preview", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Execution host", data.executionHost], ["Persona file", data.persona.path], ["Source", data.persona.source], ["Requested name", data.requestedName], ["Harness", data.harness], ["Working directory", data.cwd], ["Role", data.role ?? "not declared"], ["Model", data.model ?? "application default; not checked"], ["Variant", data.variant ?? "not declared"], ["Enrollment", "not read or redeemed"], ["Binary/login/authority checks", "not performed"]] }, { kind: "lines", lines: ["Local selection and file validation only. No broker connection, connector import, provisioning, identity allocation or launch occurred. Native foreground execution is not a detachable Cotal view."] }] },
  ] }));
}

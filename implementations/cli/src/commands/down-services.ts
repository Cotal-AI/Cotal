/** Bare `down` and `down --preserve-state` on a legacy root stop the broker this space's local
 *  service instances depend on, so each refuses before its first stop while one still runs or
 *  cannot be verified. A stopped instance does not block. Neither stops a service: each has its own
 *  controller and stop policy, as on a controller stack, whose `down` stops only its members. */
import { CommandFailure, isCommandFailure, type Report } from "@cotal-ai/workspace";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { observeServiceProcess, serviceInstances, type ServiceProcessState } from "../lib/service-instances.js";
import { assertNoServiceUnitAttempts } from "../lib/service-process.js";
import { processGone } from "../lib/stack-journal.js";

export interface BareDownService {
  definition: string;
  instanceId: string;
  host: string;
  process: ServiceProcessState | "not-observed";
  recordedState: string;
  /** `stop-first` still runs, or keeps a supervisor, so down refuses and names its stop;
   *  `already-stopped` is skipped; `blocked` could not be verified, so down refuses and names how to
   *  inspect it. */
  action: "stop-first" | "already-stopped" | "blocked";
  reason: string | null;
  remedy: string | null;
}

const statusCommand = (space: string, definition: string, instanceId: string) => `cotal service status ${definition} --instance ${instanceId} --space ${space}`;

/** Whether each saved instance in `space` blocks bare down. Reads local records and observes this
 *  host's processes; nothing is reserved, signalled or written. */
export function planBareDownServices(space: string): BareDownService[] {
  let census: ReturnType<typeof readLocalServiceCensus>, instances: ReturnType<typeof serviceInstances>;
  try { census = readLocalServiceCensus(space); instances = serviceInstances(space); }
  catch (error) {
    const known = isCommandFailure(error) ? error : undefined;
    throw new CommandFailure("refused", known?.outcome === "refused" ? known.code : "TARGET_UNAVAILABLE", "this space's service records could not be read completely; bare down stopped no service and not the broker", {
      target: { space }, remedy: `inspect them with \`cotal service list --space ${space}\``,
      ...(known ? { native: { code: known.code, outcome: known.outcome, detail: known.message } } : {}),
    });
  }
  const definitions = new Set(census.serviceDefinitions.map((row) => row.name));
  const recorded = new Set(instances.map((row) => row.name));
  const receipts = new Set(census.supervisors.map((row) => row.instanceId));
  const rows: BareDownService[] = [];
  for (const row of instances) {
    const value = row.record.value;
    const base = { definition: value.definition, instanceId: row.name, host: value.host.name, recordedState: value.state };
    const blocked = (observed: BareDownService["process"], reason: string, remedy = `inspect it with \`${statusCommand(space, value.definition, row.name)}\``) =>
      rows.push({ ...base, process: observed, action: "blocked", reason, remedy });
    let observed: ServiceProcessState;
    try { observed = observeServiceProcess(value); }
    catch { blocked("not-observed", "this host's machine and boot identity could not be established, so its process was not observed"); continue; }
    if (observed === "foreign-host") { blocked(observed, `it is recorded on host ${value.host.name}, which this down does not control`, `on ${value.host.name}, run \`cotal service stop ${value.definition} --instance ${row.name} --space ${space} --yes\``); continue; }
    if (!definitions.has(value.definition)) {
      if (processGone(observed) && !receipts.has(row.name)) rows.push({ ...base, process: observed, action: "already-stopped", reason: null, remedy: null });
      else blocked(observed, "its saved definition is missing, so the service controller cannot stop it", `inspect the space's services with \`cotal service list --space ${space}\``);
      continue;
    }
    try { assertNoServiceUnitAttempts(space, value.definition); }
    catch (error) { blocked(observed, isCommandFailure(error) ? error.message : "its retained native attempts could not be read"); continue; }
    if (["starting", "stopping", "unknown"].includes(value.state)) { blocked(observed, "it retains an unsettled start or stop request"); continue; }
    if (observed === "unreadable" || observed === "unresolved-launch") { blocked(observed, "its recorded process could not be verified"); continue; }
    // A native supervisor can restart a gone process, so its unit always has to be stopped first.
    rows.push({ ...base, process: observed, action: observed === "running" || receipts.has(row.name) ? "stop-first" : "already-stopped", reason: null, remedy: null });
  }
  for (const attempt of census.nativeAttempts) if (!recorded.has(attempt.instanceId))
    rows.push({ definition: attempt.definition, instanceId: attempt.instanceId, host: "not recorded", process: "not-observed", recordedState: "no instance record", action: "blocked", reason: `a retained native ${attempt.kind} attempt names an instance with no record`, remedy: `inspect it with \`cotal service show ${attempt.definition} --space ${space}\`` });
  for (const receipt of census.supervisors) if (!recorded.has(receipt.instanceId))
    rows.push({ definition: receipt.definition, instanceId: receipt.instanceId, host: "not recorded", process: "not-observed", recordedState: "no instance record", action: "blocked", reason: "a supervisor receipt names an instance with no record", remedy: `inspect it with \`cotal service show ${receipt.definition} --space ${space}\`` });
  return rows.sort((a, b) => a.definition.localeCompare(b.definition) || a.instanceId.localeCompare(b.instanceId));
}

/** The refusal of a `down` that would stop the broker under a saved service that still runs or
 *  could not be verified, naming each with the command that stops or inspects it. Undefined when
 *  every instance is stopped. */
export function liveServicesRefusal(space: string, rows: readonly BareDownService[], command: "down" | "down --preserve-state"): CommandFailure | undefined {
  const live = rows.filter((row) => row.action !== "already-stopped");
  if (!live.length) return undefined;
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `saved services in this space still run or could not be verified and depend on its broker (${live.map((row) => `${row.definition} instance ${row.instanceId}: ${row.action === "stop-first" ? row.process : row.reason}`).join("; ")}); ${command === "down" ? "bare down" : command} stopped nothing`, {
    target: { space, services: live.map((row) => ({ definition: row.definition, instanceId: row.instanceId, process: row.process, reason: row.reason })) },
    remedy: `${live.map((row) => row.action === "stop-first" ? `stop ${row.definition} with \`cotal service stop ${row.definition} --instance ${row.instanceId} --space ${space} --yes\`` : row.remedy).join("; ")}, then run \`cotal ${command}\` again`,
  });
}

/** Refuse before any effect while a saved service in `space` still runs or could not be verified. */
export function assertNoLiveServices(space: string, command: "down" | "down --preserve-state"): void {
  const refusal = liveServicesRefusal(space, planBareDownServices(space), command);
  if (refusal) throw refusal;
}

export function bareDownServicesView(space: string, rows: readonly BareDownService[]): Report {
  const plan = (row: BareDownService) => row.action === "stop-first" ? "refuses until it is stopped" : row.action === "already-stopped" ? "already stopped, skipped" : `refuses: ${row.reason}`;
  return { space, sections: [{ title: "Services bare down checks first", blocks: [
    { kind: "table", columns: [{ key: "definition", label: "Service" }, { key: "instance", label: "Full instance" }, { key: "host", label: "Execution host" }, { key: "process", label: "Process" }, { key: "plan", label: "Bare down" }],
      rows: rows.map((row) => ({ definition: row.definition, instance: row.instanceId, host: row.host, process: row.process, plan: { text: plan(row), tone: row.action === "already-stopped" ? "ok" as const : "failed" as const } })) },
    { kind: "lines", lines: ["Bare down refuses while any instance here still runs or could not be verified, because each depends on the broker it stops. It stops no service itself: stop each one with `cotal service stop <name> --instance <id> --space <space> --yes`, then run `cotal down`. A stopped instance does not block, and saved definitions are kept."] },
  ] }] };
}

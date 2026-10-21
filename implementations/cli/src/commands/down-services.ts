/** Bare `down` on a legacy root stops this space's local service instances through the service
 *  controller before its pidfile sweep. Every instance is classified before the first stop, and
 *  anything that cannot be verified refuses then, so no service and not the broker is stopped. */
import { CommandFailure, isCommandFailure, renderReport, terminalWidth, type Report, type Style } from "@cotal-ai/workspace";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { observeServiceProcess, serviceInstances, type ServiceProcessState } from "../lib/service-instances.js";
import { assertNoServiceUnitAttempts } from "../lib/service-process.js";
import { processGone } from "../lib/stack-journal.js";
import { serviceAction } from "./service-actions.js";

export interface BareDownService {
  definition: string;
  instanceId: string;
  host: string;
  process: ServiceProcessState | "not-observed";
  recordedState: string;
  /** `stop` hands the instance to the controller; `already-stopped` is skipped; `blocked` refuses. */
  action: "stop" | "already-stopped" | "blocked";
  reason: string | null;
  remedy: string | null;
}

const statusCommand = (space: string, definition: string, instanceId: string) => `cotal service status ${definition} --instance ${instanceId} --space ${space}`;

/** What bare down would do with each saved instance in `space`. Reads local records and observes
 *  this host's processes; nothing is reserved, signalled or written. */
export function planBareDownServices(space: string): BareDownService[] {
  let census: ReturnType<typeof readLocalServiceCensus>, instances: ReturnType<typeof serviceInstances>;
  try { census = readLocalServiceCensus(space); instances = serviceInstances(space); }
  catch (error) {
    const known = isCommandFailure(error) ? error : undefined;
    throw new CommandFailure("refused", known?.outcome === "refused" ? known.code : "TARGET_UNAVAILABLE", "this space's service records could not be read completely; bare down stopped no service and not the broker", {
      target: { space }, remedy: `inspect them with cotal service list --space ${space}`,
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
    const blocked = (observed: BareDownService["process"], reason: string, remedy = `inspect it with ${statusCommand(space, value.definition, row.name)}`) =>
      rows.push({ ...base, process: observed, action: "blocked", reason, remedy });
    let observed: ServiceProcessState;
    try { observed = observeServiceProcess(value); }
    catch { blocked("not-observed", "this host's machine and boot identity could not be established, so its process was not observed"); continue; }
    if (observed === "foreign-host") { blocked(observed, `it is recorded on host ${value.host.name}, which this down does not control`, `on ${value.host.name}, run cotal service stop ${value.definition} --instance ${row.name} --space ${space} --yes`); continue; }
    if (!definitions.has(value.definition)) {
      if (processGone(observed) && !receipts.has(row.name)) rows.push({ ...base, process: observed, action: "already-stopped", reason: null, remedy: null });
      else blocked(observed, "its saved definition is missing, so the service controller cannot stop it", `inspect the space's services with cotal service list --space ${space}`);
      continue;
    }
    try { assertNoServiceUnitAttempts(space, value.definition); }
    catch (error) { blocked(observed, isCommandFailure(error) ? error.message : "its retained native attempts could not be read"); continue; }
    if (["starting", "stopping", "unknown"].includes(value.state)) { blocked(observed, "it retains an unsettled start or stop request"); continue; }
    if (observed === "unreadable" || observed === "unresolved-launch") { blocked(observed, "its recorded process could not be verified"); continue; }
    // A native supervisor can restart a gone process, so its unit is always handed to the controller.
    rows.push({ ...base, process: observed, action: observed === "running" || receipts.has(row.name) ? "stop" : "already-stopped", reason: null, remedy: null });
  }
  for (const attempt of census.nativeAttempts) if (!recorded.has(attempt.instanceId))
    rows.push({ definition: attempt.definition, instanceId: attempt.instanceId, host: "not recorded", process: "not-observed", recordedState: "no instance record", action: "blocked", reason: `a retained native ${attempt.kind} attempt names an instance with no record`, remedy: `inspect it with cotal service show ${attempt.definition} --space ${space}` });
  for (const receipt of census.supervisors) if (!recorded.has(receipt.instanceId))
    rows.push({ definition: receipt.definition, instanceId: receipt.instanceId, host: "not recorded", process: "not-observed", recordedState: "no instance record", action: "blocked", reason: "a supervisor receipt names an instance with no record", remedy: `inspect it with cotal service show ${receipt.definition} --space ${space}` });
  return rows.sort((a, b) => a.definition.localeCompare(b.definition) || a.instanceId.localeCompare(b.instanceId));
}

/** Refuse before any effect when one instance cannot be verified. The remedy names the first. */
export function assertBareDownServicesVerified(space: string, rows: readonly BareDownService[]): void {
  const blocked = rows.filter((row) => row.action === "blocked");
  const first = blocked[0];
  if (!first) return;
  throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `service ${first.definition} instance ${first.instanceId} could not be verified: ${first.reason}; bare down stopped no service and not the broker`, {
    target: { space, blocked: blocked.map((row) => ({ definition: row.definition, instanceId: row.instanceId, process: row.process, reason: row.reason })) },
    remedy: first.remedy ?? undefined,
  });
}

export function bareDownServicesView(space: string, rows: readonly BareDownService[]): Report {
  const plan = (row: BareDownService) => row.action === "stop" ? "stop" : row.action === "already-stopped" ? "already stopped, skipped" : `blocked: ${row.reason}`;
  return { space, sections: [{ title: "Services bare down stops first", blocks: [
    { kind: "table", columns: [{ key: "definition", label: "Service" }, { key: "instance", label: "Full instance" }, { key: "host", label: "Execution host" }, { key: "process", label: "Process" }, { key: "plan", label: "Bare down" }],
      rows: rows.map((row) => ({ definition: row.definition, instance: row.instanceId, host: row.host, process: row.process, plan: { text: plan(row), tone: row.action === "blocked" ? "failed" as const : row.action === "stop" ? "waiting" as const : "ok" as const } })) },
    { kind: "lines", lines: ["Each one marked stop goes through the service controller as cotal service stop <name> --instance <id> --yes does, in this order, before the stack. Saved definitions are kept. A service recorded on another host is not touched, and any blocked row refuses the whole stop."] },
  ] }] };
}

/** Stop every `stop` row through `service stop --yes`, in order. A failure stops the sequence with
 *  the stack still running; completed stops are not rolled back. */
export async function stopBareDownServices(space: string, rows: readonly BareDownService[], options: { style: Style; withAgents: boolean }): Promise<void> {
  if (!rows.length) return;
  const stops = rows.filter((row) => row.action === "stop");
  // The legacy reap applies to the root's own manager. A service's agents are its own native policy.
  if (options.withAgents && stops[0]) throw new CommandFailure("refused", "UNSUPPORTED", "--with-agents reaps the legacy manager's agents and is not applied to this space's services; bare down stopped nothing", {
    target: { space, services: stops.map((row) => ({ definition: row.definition, instanceId: row.instanceId })) },
    remedy: `stop the services first, starting with cotal service stop ${stops[0].definition} --instance ${stops[0].instanceId} --space ${space} --yes, then run cotal down --with-agents`,
  });
  console.log(renderReport(bareDownServicesView(space, rows), options.style, terminalWidth(process.stdout)));
  const stopped: BareDownService[] = [];
  for (const row of stops) {
    try {
      await serviceAction({ values: { yes: true, instance: row.instanceId }, positionals: ["stop", row.definition], raw: [] }, space, "down");
    } catch (error) {
      const known = isCommandFailure(error) ? error : undefined;
      const uncertain = known === undefined || known.outcome === "unknown";
      throw new CommandFailure(uncertain ? "unknown" : stopped.length ? "partial" : known!.outcome, uncertain ? "OPERATION_UNKNOWN" : stopped.length ? "OPERATION_PARTIAL" : known!.code, `service ${row.definition} instance ${row.instanceId} did not confirm its stop; later services and the stack were not stopped`, {
        target: { space, definition: row.definition, instanceId: row.instanceId },
        changed: stopped.map((done) => ({ definition: done.definition, instanceId: done.instanceId, stopped: true })),
        native: { code: known?.code ?? "OPERATION_UNKNOWN", outcome: known?.outcome ?? "unknown", detail: error instanceof Error ? error.message : String(error) },
        remedy: `inspect it with ${statusCommand(space, row.definition, row.instanceId)}, then run cotal down again`,
      });
    }
    stopped.push(row);
  }
}

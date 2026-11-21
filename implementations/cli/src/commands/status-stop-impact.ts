/** Display only. A status observation never authorizes process control or proves cleanup. */
export function managerStopImpactFacts(input: unknown): string[] {
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

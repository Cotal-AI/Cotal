import { registry, sessionContinuityClass, type Connector, type SessionContinuityClass } from "@cotal-ai/core";
import { materializeFromManifest } from "@cotal-ai/workspace";

export interface RunningManagerSeat {
  name: string;
  agent: string;
}

export interface LegacyManagerReport {
  custody: "legacy";
  seats: Array<RunningManagerSeat & { continuity: SessionContinuityClass }>;
}

/**
 * A missing custody generation is legacy by definition. This stays a report-only boundary: it
 * observes the running manager and resolves the connector's public declarations, but never sends
 * a lifecycle command or creates a replacement process.
 */
export async function legacyManagerReport(
  status: { custody?: unknown },
  seats: readonly RunningManagerSeat[],
  resolveConnector: (agent: string) => Promise<Pick<Connector, "supportsResume" | "supportsSessionContinuation" | "supportsFreshStart"> | undefined> = connectorForReport,
): Promise<LegacyManagerReport | undefined> {
  if (status.custody !== undefined && status.custody !== "legacy") return undefined;
  return {
    custody: "legacy",
    seats: await Promise.all(seats.map(async (seat) => ({
      ...seat,
      continuity: sessionContinuityClass((await resolveConnector(seat.agent)) ?? {}),
    }))),
  };
}

async function connectorForReport(agent: string): Promise<Pick<Connector, "supportsResume" | "supportsSessionContinuation" | "supportsFreshStart"> | undefined> {
  const registered = registry.all<Connector>("connector").find((connector) => connector.name === agent);
  if (registered) return registered;
  try {
    return await materializeFromManifest<Connector>({ kind: "connector", name: agent });
  } catch {
    // Unknown connector capabilities are default-deny and therefore drain-only. Do not infer a
    // continuation promise from a package name, an implementation probe, or a host-local heuristic.
    return undefined;
  }
}

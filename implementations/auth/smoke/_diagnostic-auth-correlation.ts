import type { DiagnosticAuthSnapshot } from "@cotal-ai/core";
import type { DiagnosticCalloutSnapshot } from "../src/diagnostic-callout-journal.js";

/** Export only this closed projection. Inputs stay in the trusted fixture's private memory. */
export function diagnosticAuthCorrelation(client: DiagnosticAuthSnapshot, server: DiagnosticCalloutSnapshot, apiError: unknown) {
  const objectKnown = apiError !== null && (typeof apiError === "object" || typeof apiError === "function");
  const owned = objectKnown ? client.flights.filter(flight => flight.outcome === "rejected" && flight.value === apiError) : [];
  const matching = owned.flatMap(flight => server.requests.filter(request =>
    request.challenge !== null && flight.challenges.includes(request.challenge)
      && request.instance !== null && flight.instance !== null && request.instance === flight.instance)
    .map(request => ({ flight, request })));
  const saturated = client.saturated || server.saturated;
  const qualified = client.armed && server.armed && !saturated && !client.unsupported && !server.unsupported && !client.sharedRebuild;
  const unique = owned.length === 1 && matching.length === 1;
  const candidate = unique ? matching[0] : undefined;
  const challengeUnique = candidate !== undefined && candidate.flight.challengeCount === 1
    && candidate.flight.challenges.length === 1 && !candidate.request.repeatedStage;
  const correlation = !objectKnown || !client.armed || !server.armed || owned.length === 0 || matching.length === 0
    ? "unavailable" : !qualified || !unique ? "ambiguous" : !challengeUnique ? "correlated-set" : "exact";
  return {
    clientFlightCount: client.flightCount, serverRequestCount: server.requestCount, saturated, sharedRebuild: client.sharedRebuild,
    completeness: qualified ? "qualified" : "unqualified",
    errorOwnedFlightCount: Math.min(owned.length, 8), matchingRequestCount: Math.min(matching.length, 8),
    matchingCountSaturated: matching.length > 8,
    correlation,
    observations: matching.slice(0, 8).map(({ flight, request }) => ({
      flightOrdinal: flight.ordinal, requestOrdinal: request.ordinal,
      instanceEqual: true, challengeEqual: true, originalErrorEqual: true,
      challengeCount: flight.challengeCount, repeatedStage: request.repeatedStage,
      stages: { ...request.stages },
    })),
  };
}

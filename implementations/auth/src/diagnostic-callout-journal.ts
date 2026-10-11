/** Temporary local diagnostic stages. These labels describe boundaries, not denial policy. */
export const diagnosticCalloutStages = [
  "provenance-unsealed-drop", "provenance-decode-drop", "provenance-shape-drop",
  "provenance-issuer-drop", "provenance-server-drop", "provenance-xkey-drop",
  "bearer-validation", "actor-authorization", "inbox-validation", "permissions-build",
  "bound-expiry", "user-mint", "mint-audit-hook", "response-encode", "response-seal", "response-invoke",
] as const;
export type DiagnosticCalloutStage = typeof diagnosticCalloutStages[number];
export type DiagnosticCalloutOutcome = "entered" | "returned" | "threw";

type Request = {
  ordinal: number; challenge: string | null; instance: string | null; server: string | null;
  clientId: number | null; requestKey: string | null; unsupported: boolean; repeatedStage: boolean;
  stages: Partial<Record<DiagnosticCalloutStage, DiagnosticCalloutOutcome>>;
};

/** Private trusted-host correlation data. Never serialize or forward this snapshot. */
export interface DiagnosticCalloutSnapshot {
  readonly armed: boolean;
  readonly requestCount: number;
  readonly saturated: boolean;
  readonly unsupported: boolean;
  readonly drops: Readonly<Partial<Record<DiagnosticCalloutStage, number>>>;
  readonly requests: readonly Readonly<Request>[];
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
}

/** Storage belongs to the callout, not its caller. Recording never invokes observer code. */
export class DiagnosticCalloutJournal {
  #requests: Request[] = [];
  #drops: Partial<Record<DiagnosticCalloutStage, number>> = {};
  #count = 0;
  #saturated = false;
  #unsupported = false;

  taint(): void { this.#unsupported = true; }

  drop(stage: DiagnosticCalloutStage): void {
    const count = this.#drops[stage] ?? 0;
    if (count === 8) { this.#saturated = true; return; }
    this.#drops[stage] = count + 1;
  }

  begin(fields: { challenge: unknown; instance: unknown; server: unknown; clientId: unknown; requestKey: unknown }): Request | undefined {
    if (this.#count === 8) { this.#saturated = true; return undefined; }
    const challenge = boundedString(fields.challenge), instance = boundedString(fields.instance);
    const server = boundedString(fields.server), requestKey = boundedString(fields.requestKey);
    const clientId = typeof fields.clientId === "number" && Number.isSafeInteger(fields.clientId) && fields.clientId > 0 ? fields.clientId : null;
    const unsupported = challenge === null || instance === null || server === null || clientId === null || requestKey === null;
    this.#unsupported ||= unsupported;
    const request: Request = { ordinal: ++this.#count, challenge, instance, server, clientId, requestKey, unsupported, repeatedStage: false, stages: {} };
    this.#requests.push(request);
    return request;
  }

  stage(request: Request | undefined, stage: DiagnosticCalloutStage, outcome: DiagnosticCalloutOutcome): void {
    if (!request) return;
    const previous = request.stages[stage];
    if (outcome === "entered" && previous !== undefined) request.repeatedStage = true;
    // A second deny-response attempt must not erase an earlier response-path throw.
    if (previous !== "threw") request.stages[stage] = outcome;
  }

  read(): DiagnosticCalloutSnapshot {
    return { armed: true, requestCount: this.#count, saturated: this.#saturated, unsupported: this.#unsupported,
      drops: { ...this.#drops }, requests: this.#requests.map(request => ({ ...request, stages: { ...request.stages } })) };
  }
}

export function unarmedDiagnosticCalloutSnapshot(): DiagnosticCalloutSnapshot {
  return { armed: false, requestCount: 0, saturated: false, unsupported: false, drops: {}, requests: [] };
}

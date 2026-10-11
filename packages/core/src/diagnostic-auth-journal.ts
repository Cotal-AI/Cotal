import type { Authenticator } from "@nats-io/nats-core";

/** Private diagnostic data. A trusted local composition may compare references and strings,
 * but must never serialize this snapshot. This temporary probe is not a wire surface. */
export interface DiagnosticAuthFlight {
  readonly ordinal: number;
  readonly instance: string | null;
  readonly challenges: readonly string[];
  readonly challengeCount: number;
  readonly saturated: boolean;
  readonly unsupported: boolean;
  readonly outcome: "pending" | "fulfilled" | "rejected";
  readonly value: object | null;
}

/** One non-resettable observation epoch. Counts and storage have separate fixed bounds. */
export interface DiagnosticAuthSnapshot {
  readonly armed: boolean;
  readonly flightCount: number;
  readonly saturated: boolean;
  readonly unsupported: boolean;
  readonly sharedRebuild: boolean;
  readonly flights: readonly DiagnosticAuthFlight[];
}

type Flight = {
  ordinal: number; instance: string | null; challenges: string[]; challengeCount: number;
  saturated: boolean; unsupported: boolean; outcome: DiagnosticAuthFlight["outcome"];
  value: object | null;
};

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
}

/** Source-owned storage used by the Endpoint dial path. No caller code is invoked by recording. */
export class DiagnosticAuthJournal {
  #flights: Flight[] = [];
  #count = 0;
  #saturated = false;
  #unsupported = false;
  #sharedRebuild = false;

  begin(instance: unknown): Flight | undefined {
    if (this.#count === 8) { this.#saturated = true; return undefined; }
    const name = boundedString(instance);
    const flight: Flight = { ordinal: ++this.#count, instance: name, challenges: [], challengeCount: 0,
      saturated: false, unsupported: name === null, outcome: "pending", value: null };
    this.#unsupported ||= name === null;
    this.#flights.push(flight);
    return flight;
  }

  /** Wrap only the first stock authenticator. The remaining stock authenticators stay unchanged.
   * Reflect.apply preserves the receiver, input, return value and original thrown object. */
  authentication(flight: Flight | undefined, stock: Authenticator): Authenticator {
    const journal = this;
    return function(this: unknown, ...args: Parameters<Authenticator>) {
      if (flight) journal.challenge(flight, args[0]);
      return Reflect.apply(stock, this, args);
    };
  }

  private challenge(flight: Flight, nonce: unknown): void {
    if (flight.challengeCount === 8) { flight.saturated = true; this.#saturated = true; return; }
    flight.challengeCount++;
    const challenge = boundedString(nonce);
    if (challenge === null) { flight.unsupported = true; this.#unsupported = true; return; }
    flight.challenges.push(challenge);
  }

  settle(flight: Flight | undefined, outcome: "fulfilled" | "rejected", value: unknown): void {
    if (!flight) return;
    flight.outcome = outcome;
    // Retain only the original reference, never inspect an Error or a connection's properties.
    if (value !== null && (typeof value === "object" || typeof value === "function")) flight.value = value;
    else { flight.unsupported = true; this.#unsupported = true; }
  }

  sharedRebuild(): void { this.#sharedRebuild = true; }

  read(): DiagnosticAuthSnapshot {
    return { armed: true, flightCount: this.#count, saturated: this.#saturated, unsupported: this.#unsupported, sharedRebuild: this.#sharedRebuild,
      flights: this.#flights.map(flight => ({ ...flight, challenges: [...flight.challenges] })) };
  }
}

/** An unarmed endpoint allocates no journal and returns only this empty private snapshot. */
export function unarmedDiagnosticAuthSnapshot(): DiagnosticAuthSnapshot {
  return { armed: false, flightCount: 0, saturated: false, unsupported: false, sharedRebuild: false, flights: [] };
}

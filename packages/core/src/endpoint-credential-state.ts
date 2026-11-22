// The credential a CotalEndpoint presents and the renewal around it, in one object the endpoint's
// internal parts read by reference. Not re-exported by the index.

/** Created by the `CotalEndpoint` before its parts. The credentials part writes it; the connection part
 *  also clears the expiry fence timer. Every other part takes it as `Readonly` and reads a field when it
 *  uses it, never a copy. */
export interface CredentialState {
  /** The freshest creds — what every (re)connect attempt presents. Static callers set it once. */
  currentCreds?: string;
  /** The freshest bearer — what every (re)connect attempt presents. */
  currentBearer?: string;
  /** The expiry, in seconds, of the credential the latest connect attempt presented. The issuer
   *  keys a listing generation on it (SPEC 13.15), so a listing reads the row bound to the
   *  credential the broker admitted, never one adopted since. */
  presentedExp?: number;
  /** Cancels the armed bearer renewal or retry. */
  cancelBearerRenewal?: () => void;
  /** Consecutive failed bearer renewals: the retry's step, and whether this run of failures has
   *  already been surfaced. */
  bearerRenewalFailures: number;
  /** When the held bearer was adopted: its lifetime's start when it carries no `iat`. */
  bearerAdoptedAtMs: number;
  /** Arms against the credential authenticated on the current wire. nats-core 3.4.0 discards the
   *  promise returned by its async transport-close continuation; if that continuation enters the
   *  reconnect dial loop with an expired JWT, its terminal auth error becomes an unhandled rejection.
   *  Cotal knows the JWT expiry, so it disables the library reconnect before the broker closes the
   *  transport. The endpoint's observed `closed()` supervisor remains responsible for rebuilding. */
  authExpiryReconnectTimer?: NodeJS.Timeout;
  /** Credential transactions running now. Each one opens a disposable connection for its proof. */
  credsTxnsRunning: number;
  /** The resident swap a reload scheduled, until its connection is back or the gate's bound ends. */
  residentSwap?: Promise<void>;
}

/** The state before any credential or registry is read. */
export function newCredentialState(): CredentialState {
  return {
    bearerRenewalFailures: 0,
    bearerAdoptedAtMs: 0,
    credsTxnsRunning: 0,
  };
}

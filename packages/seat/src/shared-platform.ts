import type { Socket } from "node:net";
import type { SeatExit } from "./protocol.js";
import type { SeatRecord } from "./record.js";
import type { SharedLaunchPayload } from "./shared-control-protocol.js";
import type { PreparedSeat } from "./shared-prepared-seat.js";

export interface ExactIdentity { pid: number; start: string }
export type ProcessObservation = "live" | "gone" | "unknown";

/** Only exact native death, absence or a different birth can prove gone. */
export interface IdentityProof<I extends ExactIdentity> {
  current(): I | undefined;
  same(a: I, b: I): boolean;
  observe(identity: I): ProcessObservation;
}

export interface VerifiedHost<I extends ExactIdentity, Authority> {
  identity: I;
  authority: Authority;
  protocol: number;
  token: string;
}

export type HostBootstrap<H> = { state: "ready"; host: H } | { state: "ineligible" } | { state: "unknown" };

export interface HostListener {
  closed: Promise<void>;
  close(): void;
}

export interface HostTransport<Address, Host, Peer> {
  listen(address: Address, accept: (socket: Socket, peer: Peer) => void, ready: () => void): HostListener;
  /** Authenticate the connected native peer against the verified host and authority before returning. */
  dial(address: Address, host: Host, timeoutMs: number): Promise<Socket>;
}

export interface SeatReservation {
  directory: string;
  recordPath: string;
  publish(record: SeatRecord): void;
  refuse(): void;
  publishExit?(exit: SeatExit): void;
  appendLog?(line: string): void;
}

export interface HostRecords<Claim, Reservation extends SeatReservation = SeatReservation> {
  readClaim(): Claim | undefined;
  acceptsLaunch(claim: Claim | undefined, generation: string): claim is Claim;
  /** A reservation is installed synchronously before any launch can await. */
  reserve(id: string): Reservation | "not-admitted" | "unknown";
  launchState(id: string): "absent" | "unknown";
  publishHost(): void;
  removeHost(): void;
}

export interface SeatIsolation<I extends ExactIdentity> {
  prepare(payload: SharedLaunchPayload): Promise<PreparedSeat<I>>;
  /** A failed native preparation can leave an unconfirmed child before returning its handle. */
  prepareFailure(error: unknown): "not-admitted" | "unknown";
  /** Release only this isolation unit after proving its descendants are gone. */
  drain(): Promise<void>;
}

import type { Socket } from "node:net";

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

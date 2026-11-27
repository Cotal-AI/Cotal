import type { IPty } from "@lydell/node-pty";
import type { ExactIdentity } from "./shared-platform.js";

export type SeatTerminal = Pick<IPty, "pid" | "onData" | "onExit" | "write" | "resize" | "kill">;
export type SeatStopMode = "graceful" | "hard";

/** Internal shared-seat preparation contract. I is the complete native root identity, not a PID. */
export interface PreparedSeat<I extends ExactIdentity> {
  readonly proc: SeatTerminal;
  readonly ready: Promise<I>;
  /** True once dispatch is attempted, even if its outcome is uncertain. */
  readonly commitAttempted: boolean;
  /** After readiness checks, run the callback synchronously and attempt dispatch without an
   * intervening await. If the callback throws, do not attempt dispatch. */
  commit(beforeDispatch: () => void): Promise<void>;
  /** Close the preparation gate. Not a substitute for stopping or draining native lifetime. */
  abort(): void;

  // Optional native lifetime hooks, independent of PTY onExit and output delivery.
  /** Dispatch a stop request for the owned native lifetime. */
  stop?(mode: SeatStopMode): Promise<void>;
  /** Wait for the owned native lifetime to drain, not for terminal output. */
  drain?(): Promise<void>;
}

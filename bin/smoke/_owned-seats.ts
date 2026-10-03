/**
 * Seat processes a smoke's own managers spawned, judged by the shipped process-identity rule
 * (`@cotal-ai/workspace` `assertRecordIdentity`, the same start-token check every teardown uses).
 *
 * A seat is recorded with its pid AND the start token read when it was recorded. Only a live pid
 * whose current start token matches that record is still this suite's seat, and only that seat may
 * be signalled. Everything else is decided without a signal:
 *
 *   - `exited`: the pid is gone, or it now carries a different start token (the pid was reused,
 *     so the recorded seat is gone and the live process is a stranger).
 *   - `unverifiable`: no start token was recorded, or the live pid's token cannot be read. That is
 *     neither "ours" nor "gone". It is reported as a failure and never signalled.
 *
 * Every platform the identity reader supports is supported here through that reader. A pid-only
 * fallback is deliberately absent.
 */
import { assertRecordIdentity, defaultStartToken, probeLiveness, type ProcessStartTokenReader } from "@cotal-ai/workspace";

export interface OwnedSeat {
  readonly name: string;
  readonly pid: number;
  /** The start token read when the seat was recorded. `undefined` means none could be read. */
  readonly token: string | undefined;
}

export type SeatVerdict =
  | { kind: "running" }
  | { kind: "exited"; why: string }
  | { kind: "unverifiable"; why: string };

export function recordOwnedSeat(name: string, pid: number, tokenAt: ProcessStartTokenReader = defaultStartToken): OwnedSeat {
  return { name, pid, token: tokenAt(pid) };
}

export function seatVerdict(seat: OwnedSeat, tokenAt: ProcessStartTokenReader = defaultStartToken): SeatVerdict {
  if (seat.token === undefined) {
    return probeLiveness(seat.pid) === "dead"
      ? { kind: "exited", why: "pid is gone" }
      : { kind: "unverifiable", why: "no start identity was recorded for this seat" };
  }
  const v = assertRecordIdentity({ pid: seat.pid, token: seat.token }, tokenAt);
  switch (v.kind) {
    case "match": return { kind: "running" };
    case "gone": return { kind: "exited", why: "pid is gone" };
    case "mismatch": return { kind: "exited", why: "pid now carries a different start identity (reused)" };
    case "unpinned": return { kind: "unverifiable", why: "the live pid's start identity cannot be read" };
  }
}

export interface SeatCensus {
  running: string[];
  unverifiable: Array<{ name: string; why: string }>;
}

export function seatCensus(seats: readonly OwnedSeat[], tokenAt: ProcessStartTokenReader = defaultStartToken): SeatCensus {
  const out: SeatCensus = { running: [], unverifiable: [] };
  for (const s of seats) {
    const v = seatVerdict(s, tokenAt);
    if (v.kind === "running") out.running.push(s.name);
    else if (v.kind === "unverifiable") out.unverifiable.push({ name: s.name, why: v.why });
  }
  return out;
}

/** Poll until no recorded seat is verifiably running, or `ms` passes. Unverifiable seats do not end
 *  the wait early and are always returned, so a caller cannot read them as exited. */
export async function awaitSeatsExited(seats: readonly OwnedSeat[], ms: number, tokenAt: ProcessStartTokenReader = defaultStartToken): Promise<SeatCensus> {
  const deadline = Date.now() + ms;
  for (;;) {
    const census = seatCensus(seats, tokenAt);
    if ((census.running.length === 0 && census.unverifiable.length === 0) || Date.now() > deadline) return census;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** SIGKILL each recorded seat whose identity verifies as running, and nothing else. Returns what was
 *  signalled and what was refused, so a caller can report a refusal rather than hide it. */
export function killVerifiedSeats(
  seats: readonly OwnedSeat[],
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => { process.kill(pid, signal); },
  tokenAt: ProcessStartTokenReader = defaultStartToken,
): { signalled: string[]; refused: Array<{ name: string; why: string }> } {
  const signalled: string[] = [];
  const refused: Array<{ name: string; why: string }> = [];
  for (const s of seats) {
    const v = seatVerdict(s, tokenAt);
    if (v.kind === "running") {
      try { kill(s.pid, "SIGKILL"); signalled.push(s.name); } catch { /* exited between verify and signal */ }
    } else if (v.kind === "unverifiable") refused.push({ name: s.name, why: v.why });
  }
  return { signalled, refused };
}

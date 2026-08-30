import { processStartToken } from "./advisory-lock.js";
import { probeLiveness, type LivenessProbe } from "./pid.js";

export type ProcessIdentityState = "matching" | "gone" | "reused" | "unknown";
export type ProcessStartTokenReader = (pid: number) => string | undefined;
export type ProcessSignaler = (pid: number, signal: NodeJS.Signals | number) => void;
export interface PosixProcessIdentity {
  readonly pid: number;
  readonly startToken: string;
  readonly killScope: "process" | "process-group";
}

/** Compare a durable locator with the process currently occupying its PID. */
export function inspectProcessIdentity(
  locator: PosixProcessIdentity,
  deps: { liveness?: LivenessProbe; startToken?: ProcessStartTokenReader } = {},
): ProcessIdentityState {
  const live = (deps.liveness ?? probeLiveness)(locator.pid);
  if (live === "dead") return "gone";
  if (live === "unknown") return "unknown";
  const token = (deps.startToken ?? processStartToken)(locator.pid);
  if (token === undefined) return "unknown";
  return token === locator.startToken ? "matching" : "reused";
}

export interface ReapProcessOptions {
  readonly signal?: NodeJS.Signals | number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly liveness?: LivenessProbe;
  readonly startToken?: ProcessStartTokenReader;
  readonly signaler?: ProcessSignaler;
}

/** Signal only the process incarnation named by `locator`, then require proof that it is gone. */
export async function reapProcess(locator: PosixProcessIdentity, opts: ReapProcessOptions = {}): Promise<void> {
  const deps = { liveness: opts.liveness, startToken: opts.startToken };
  const before = inspectProcessIdentity(locator, deps);
  if (before === "gone" || before === "reused") return;
  if (before === "unknown") throw new Error(`cannot safely reap pid ${locator.pid}: process identity is unknown`);

  const target = locator.killScope === "process-group" ? -locator.pid : locator.pid;
  (opts.signaler ?? ((pid, signal) => process.kill(pid, signal)))(target, opts.signal ?? "SIGKILL");

  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const after = inspectProcessIdentity(locator, deps);
    if (after === "gone" || after === "reused") return;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`process ${locator.pid} was not verified gone after ${timeoutMs}ms`);
}

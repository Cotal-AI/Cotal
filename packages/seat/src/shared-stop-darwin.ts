import { setTimeout as delay } from "node:timers/promises";
import { GRACE_MS } from "./protocol.js";
import { darwinSharedIdentity, type DarwinSharedIdentity } from "./shared-identity-darwin.js";
import type { SeatStopMode, SeatTerminal } from "./shared-prepared-seat.js";
import { captureDarwinPtySession, observeDarwinDetachedChildren } from "./shared-session-darwin.js";

/** Match today's explicit PTY-root stop. An acknowledgement is not a descendant-drain verdict. */
export async function stopDarwinPtyRoot(
  proc: Pick<SeatTerminal, "pid" | "kill">,
  root: Readonly<DarwinSharedIdentity>,
  mode: SeatStopMode,
): Promise<{ readonly observedDetachedSurvivors: number | undefined }> {
  if (proc.pid !== root.pid) throw new Error("unverified Darwin PTY stop target");
  const initial = darwinSharedIdentity.observe(root);
  if (initial === "gone") return { observedDetachedSurvivors: undefined };
  if (initial !== "live") throw new Error("unverified Darwin PTY stop target");
  const detached = observeDarwinDetachedChildren(root);
  const signal = (name: "SIGTERM" | "SIGKILL"): void => {
    if (darwinSharedIdentity.observe(root) === "gone") return;
    const actual = captureDarwinPtySession(proc.pid);
    if (!actual || !darwinSharedIdentity.same(actual, root)) throw new Error("unverified Darwin PTY stop target");
    proc.kill(name);
  };
  signal(mode === "hard" ? "SIGKILL" : "SIGTERM");
  const escalateAt = performance.now() + GRACE_MS;
  const deadline = escalateAt + 6_000;
  let escalated = mode === "hard";
  while (performance.now() < deadline) {
    if (darwinSharedIdentity.observe(root) === "gone") {
      return { observedDetachedSurvivors: detached?.filter(child => darwinSharedIdentity.observe(child) === "live").length };
    }
    if (!escalated && performance.now() >= escalateAt) {
      signal("SIGKILL");
      escalated = true;
    }
    await delay(50);
  }
  throw new Error("Darwin PTY root stop was not confirmed");
}

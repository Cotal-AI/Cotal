import type { ChildProcess } from "node:child_process";
import { processBirth } from "./lifetime.js";

type Identity = Readonly<{ pid: number; start: string; bootId: string; uid: number }>;
export type DarwinRemovalTarget = Readonly<{ scope: string; id: string; host: Identity; root: Identity }>;
export type DarwinManagerRemovalPhase = "prepare" | "stop" | "abort";
const kind = "machine-hosted-pty-remove";

export function pinDarwinRemovalManager(child: ChildProcess) {
  const pid = child.pid;
  const birth = pid && processBirth(pid);
  const recheck = () => Boolean(pid && birth && child.pid === pid && child.connected && child.exitCode === null &&
    child.signalCode === null && processBirth(pid) === birth);
  if (!recheck()) throw new Error(`${kind} requires the exact incumbent Manager`);
  return { pid: pid!, birth: birth!, recheck, request: (attemptId: string, phase: DarwinManagerRemovalPhase, targets: readonly DarwinRemovalTarget[]) =>
    send(child, recheck, attemptId, phase, targets) };
}

function send(child: ChildProcess, authorized: () => boolean, attemptId: string, phase: DarwinManagerRemovalPhase, targets: readonly DarwinRemovalTarget[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (count?: number, detail = "the incumbent Manager did not confirm the operation") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", unavailable);
      child.off("disconnect", unavailable);
      if (count === undefined) reject(new Error(`${kind}: ${detail}`));
      else resolve(count);
    };
    const unavailable = () => finish(undefined, "the incumbent Manager channel is unavailable");
    const receive = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const result = raw as { kind?: unknown; attemptId?: unknown; phase?: unknown; ok?: unknown; count?: unknown };
      if (result.kind !== `${kind}-result` || result.attemptId !== attemptId) return;
      if (!authorized() || result.phase !== phase || result.ok !== true || result.count !== targets.length) finish(undefined, "the incumbent Manager refused or did not verify the exact targets");
      else finish(targets.length);
    };
    const timer = setTimeout(() => finish(undefined, "the incumbent Manager did not acknowledge support"), phase === "stop" ? 65_000 : 3000);
    child.on("message", receive);
    child.once("exit", unavailable);
    child.once("disconnect", unavailable);
    if (!authorized()) { unavailable(); return; }
    try { child.send({ kind, attemptId, phase, targets }, error => { if (error) unavailable(); }); }
    catch { unavailable(); }
  });
}

import type { ChildProcess } from "node:child_process";
import { processBirth } from "./lifetime.js";
import type { Live } from "./manager.js";

type Identity = Readonly<{ pid: number; start: string; bootId: string; uid: number }>;
export type DarwinRemovalTarget = Readonly<{ scope: string; id: string; host: Identity; root: Identity }>;
export type DarwinManagerRemovalPhase = "prepare" | "stop" | "abort";
const kind = "machine-hosted-pty-remove";

export function holdDarwinRemovalManagers(live: ReadonlyMap<string, Live>, blocked: () => boolean, set: (held: boolean) => void) {
  if (blocked() || [...live.values()].some(row => row.starting || row.refreshing || row.stopping || row.stopTask || row.healthTask))
    throw new Error(`${kind}: hosted Manager custody is still settling`);
  set(true);
  let active = true;
  const release = () => { if (active) { active = false; set(false); } };
  return { pin(space: string) {
    const row = live.get(space), child = row?.child;
    if (!active || !row || !child || !row.view.instanceId || row.view.state !== "answering")
      throw new Error(`${kind}: the incumbent Manager is unavailable`);
    const pinned = pinDarwinRemovalManager(child);
    const recheck = () => active && live.get(space) === row && row.child === child && !row.stopping && pinned.recheck();
    return { ...pinned, recheck, request: (...args: Parameters<typeof pinned.request>) => {
      if (!recheck()) throw new Error(`${kind}: the incumbent Manager changed`);
      return pinned.request(...args);
    } };
  }, release };
}

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

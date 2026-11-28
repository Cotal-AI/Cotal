/** Child control for the daemon's hosted Managers: the parent-IPC generation call, probe-session
 *  close, bounded child retirement, and the per-space record scan. createHostedManagers builds them
 *  once over its closure. */
import { randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drainAndClose } from "@cotal-ai/core";
import { isConnectRefusal, spaceFromSegment } from "@cotal-ai/workspace";
import { managerCleanupFile } from "./manager-cleanup.js";
import type { Live, ProbeSession } from "./manager.js";

export const safeDiagnostic = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>");

// Each pipe has its own line boundary. Discard oversized lines in full so a split credential cannot be reconstructed.
export function managerLogLines(accept: (line: string) => void) {
  let pending = "", dropping = false;
  return (text: string, end = false) => {
    for (const part of text.split(/(?<=\n)/)) {
      if (!dropping) {
        if (pending.length + part.length > 16_384) { pending = ""; dropping = true; }
        else pending += part;
      }
      if (part.endsWith("\n")) {
        accept(dropping ? "<oversized Manager log line omitted>\n" : safeDiagnostic(pending));
        pending = ""; dropping = false;
      }
    }
    if (end && (pending || dropping)) {
      accept(dropping ? "<oversized Manager log line omitted>\n" : safeDiagnostic(pending));
      pending = ""; dropping = false;
    }
  };
}

/** What the child-control helpers read from createHostedManagers. Both are bound once before the
 *  helpers are built and never reassigned. */
export interface HostedManagerChildrenDeps {
  home: string;
  notify: () => void;
}

export interface HostedManagerChildren {
  generationCall: (child: ChildProcess, attemptId: string, op: "inspect" | "prepare" | "abort") => Promise<number | undefined>;
  isRateLimited: (error: unknown) => boolean;
  closeProbeSession: (l: Live, expected?: ProbeSession) => void;
  stopChild: (l: Live) => Promise<void>;
  spaces: (refusals?: boolean) => string[];
}

/** The child-control helpers over one daemon's hosted Managers. Bodies read their deps by the closure's names. */
export function hostedManagerChildren(deps: HostedManagerChildrenDeps): HostedManagerChildren {
  const { home, notify } = deps;
  const generationCall = (child: ChildProcess, attemptId: string, op: "inspect" | "prepare" | "abort") => new Promise<number | undefined>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(undefined); return; }
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", receive);
      error ? reject(error) : resolve(seats);
    };
    const receive = (raw: unknown) => {
      const frame = raw as { kind?: unknown; attemptId?: unknown; op?: unknown; ok?: unknown; seats?: unknown } | null;
      if (frame?.kind === "machine-generation-result" && frame.attemptId === attemptId && frame.op === op) {
        if (op === "inspect" && (!Number.isSafeInteger(frame.seats) || Number(frame.seats) < 0)) { finish(new Error("hosted Manager did not confirm its seat count")); return; }
        seats = op === "inspect" ? Number(frame.seats) : undefined;
        finish(frame.ok === true ? undefined : new Error("hosted Manager still holds seats or cannot confirm an idle preservation fence"));
      }
    };
    let seats: number | undefined;
    const timer = setTimeout(() => finish(new Error("hosted Manager did not confirm the generation request; retrying without stopping it")), 10_000);
    child.on("message", receive);
    child.send({ kind: "machine-generation", attemptId, op }, (error) => { if (error) finish(new Error("hosted Manager parent channel is unavailable")); });
  });
  const isRateLimited = (error: unknown): boolean =>
    (isConnectRefusal(error) && error.native?.code === "RATE_LIMITED")
    || (error instanceof Error && ((error as { code?: unknown }).code === "rate-limited" || /RATE_LIMITED|over its limit of \d+ connects a minute/.test(error.message)));
  const closeProbeSession = (l: Live, expected?: ProbeSession) => {
    const current = l.probeSession;
    if (!current || (expected && current !== expected)) return;
    l.probeSession = undefined;
    void drainAndClose(current.nc, 2000).catch(() => {});
  };
  function stopChild(l: Live): Promise<void> {
    return l.stopTask ??= stopChildOnce(l).finally(() => { l.stopTask = undefined; });
  }
  async function stopChildOnce(l: Live): Promise<void> {
    closeProbeSession(l);
    const child = l.child;
    if (!child) return;
    // Entering retirement is not a new Manager observation.
    l.view = { ...l.view, state: "stopping" };
    // Retirement and deregistration need broker round trips even with no seats. Observe over
    // parent IPC before disconnecting, then allow five seconds per seat, capped at one minute.
    let seats: number | undefined;
    if (child.connected) {
      try { seats = await generationCall(child, randomUUID(), "inspect"); }
      catch { /* Unknown inventory receives the ceiling, never an assumed empty inventory. */ }
    }
    const graceMs = seats === undefined ? 60_000 : Math.min(60_000, 15_000 + seats * 5000);
    if (child.connected) child.disconnect();
    // Signal only this retained ChildProcess. Never rediscover a child from a recorded pid.
    const ended = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([l.exited!.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    if (await ended(graceMs)) l.view = { ...l.view, lastStop: "graceful" };
    else {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (await ended(2000)) l.view = { ...l.view, lastStop: "terminated" };
      else {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (!(await ended(2000))) throw new Error("the daemon's owned Manager child did not confirm exit after SIGKILL");
        l.view = { ...l.view, lastStop: "killed" };
      }
    }
    l.child = undefined;
    l.agents = undefined;
    notify();
  }
  const spaces = (refusals = false): string[] => {
    let entries: string[];
    try { entries = readdirSync(join(home, "daemon")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return entries.flatMap((entry) => {
      const space = spaceFromSegment(entry);
      if (space === undefined || !lstatSync(join(home, "daemon", entry)).isDirectory()) return [];
      const intent = join(home, "daemon", entry, "manager-host.json");
      const cleanup = managerCleanupFile(home, space);
      const path = existsSync(intent) ? intent : refusals && existsSync(cleanup) ? cleanup : refusals ? join(home, "daemon", entry, "manager-refusal.json") : intent;
      if (!existsSync(path)) return [];
      return [space];
    });
  };
  return { generationCall, isRateLimited, closeProbeSession, stopChild, spaces };
}

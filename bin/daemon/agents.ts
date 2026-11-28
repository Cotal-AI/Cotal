/** Read-only questions over a retained Manager child channel: its public seats and its connection. */
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { HostedAgent } from "./protocol.js";

export function parseHostedAgents(value: unknown): HostedAgent[] {
  if (!Array.isArray(value) || value.length > 50 || Buffer.byteLength(JSON.stringify(value)) > 24 * 1024) throw new Error("invalid agent inventory");
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid agent row");
    const a = raw as Record<string, unknown>;
    if (!text(a.name, 128) || !text(a.application, 128) || !text(a.cwd, 4096) ||
      (a.model !== undefined && !text(a.model, 256)) || !text(a.startedAt, 32) ||
      !Number.isFinite(Date.parse(a.startedAt)) || !["running", "exited"].includes(String(a.state))) throw new Error("invalid agent row");
    if ((a.id !== undefined || a.lifecycleUid !== undefined) && (!text(a.id, 256) || !text(a.lifecycleUid, 128))) throw new Error("invalid agent identity");
    return { name: a.name, ...(typeof a.id === "string" && typeof a.lifecycleUid === "string" ? { id: a.id, lifecycleUid: a.lifecycleUid } : {}), application: a.application, cwd: a.cwd, startedAt: a.startedAt,
      state: a.state as HostedAgent["state"], ...(a.model !== undefined ? { model: a.model as string } : {}) };
  });
}

/** One read-only question over a retained Manager child channel. Any failure, timeout or
 *  malformed answer rejects; the caller decides what an unanswered question means. */
function askChild<T>(child: ChildProcess, kind: string, parse: (frame: Record<string, unknown>) => T, failure: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const attemptId = randomUUID();
    let settled = false;
    const finish = (answer?: { value: T }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", unavailable);
      child.off("disconnect", unavailable);
      answer ? resolve(answer.value) : reject(new Error(failure));
    };
    const unavailable = () => finish();
    const receive = (raw: unknown) => {
      const frame = raw as Record<string, unknown> | null;
      if (frame?.kind !== `${kind}-result` || frame.attemptId !== attemptId) return;
      try { finish(frame.ok === true ? { value: parse(frame) } : undefined); } catch { finish(); }
    };
    const timer = setTimeout(unavailable, 1500);
    child.on("message", receive);
    child.once("exit", unavailable);
    child.once("disconnect", unavailable);
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) { finish(); return; }
    child.send({ kind, attemptId }, error => { if (error) finish(); });
  });
}

export function readHostedAgents(child: ChildProcess): Promise<HostedAgent[]> {
  return askChild(child, "machine-agents", frame => parseHostedAgents(frame.agents), "could not read local agents");
}

/** Whether the Manager's rails are served on a connected transport: its own liveness grade. */
export function readServeBound(child: ChildProcess): Promise<boolean> {
  return askChild(child, "machine-connection", (frame) => {
    if (typeof frame.bound !== "boolean") throw new Error("invalid connection answer");
    return frame.bound;
  }, "could not read the Manager's connection");
}

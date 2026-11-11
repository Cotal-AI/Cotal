/** Read-only public seat projection over a retained Manager child channel. */
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
    return { name: a.name, application: a.application, cwd: a.cwd, startedAt: a.startedAt,
      state: a.state as HostedAgent["state"], ...(a.model !== undefined ? { model: a.model as string } : {}) };
  });
}

export function readHostedAgents(child: ChildProcess): Promise<HostedAgent[]> {
  return new Promise((resolve, reject) => {
    const attemptId = randomUUID();
    let settled = false;
    const finish = (agents?: HostedAgent[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", unavailable);
      child.off("disconnect", unavailable);
      agents ? resolve(agents) : reject(new Error("could not read local agents"));
    };
    const unavailable = () => finish();
    const receive = (raw: unknown) => {
      const frame = raw as { kind?: unknown; attemptId?: unknown; ok?: unknown; agents?: unknown } | null;
      if (frame?.kind !== "machine-agents-result" || frame.attemptId !== attemptId) return;
      try { finish(frame.ok === true ? parseHostedAgents(frame.agents) : undefined); } catch { finish(); }
    };
    const timer = setTimeout(unavailable, 1500);
    child.on("message", receive);
    child.once("exit", unavailable);
    child.once("disconnect", unavailable);
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) { finish(); return; }
    child.send({ kind: "machine-agents", attemptId }, error => { if (error) finish(); });
  });
}

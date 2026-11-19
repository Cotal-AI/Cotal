import { createConnection } from "node:net";

export type StatusControlObservation = (event: {
  phase: "control-start" | "control-send" | "control-reply" | "control-eof" | "control-error" | "control-deadline" | "control-cancelled" | "control-invalid-reply";
  id: string;
  bytes?: number;
  ok?: boolean;
  code?: string;
}) => void;

/** One stock read-only status request on another connection. Never returns an acceptance result. */
export function startMacStatusControl(path: string, id: string, timeoutMs: number, observe: StatusControlObservation): () => void {
  const socket = createConnection(path);
  const limit = 256 * 1024;
  let response = Buffer.alloc(0);
  let done = false;
  const report = (event: Parameters<StatusControlObservation>[0]) => {
    try { observe(event); } catch { /* Evidence must not affect either socket outcome. */ }
  };
  const finish = (event: Parameters<StatusControlObservation>[0]) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.destroy();
    report(event);
  };
  const timer = setTimeout(() => finish({ phase: "control-deadline", id, bytes: response.length }), timeoutMs);
  socket.once("connect", () => {
    report({ phase: "control-send", id });
    socket.write(`${JSON.stringify({ v: 1, id, op: "status" })}\n`);
  });
  socket.on("data", (chunk: Buffer) => {
    if (response.length + chunk.length > limit) return finish({ phase: "control-invalid-reply", id, bytes: response.length + chunk.length });
    response = Buffer.concat([response, chunk]);
    const newline = response.indexOf(10);
    if (newline < 0) return;
    try {
      const reply = JSON.parse(response.subarray(0, newline).toString("utf8"));
      if (reply.v === 1 && reply.id === id && typeof reply.ok === "boolean") {
        return finish({ phase: "control-reply", id, bytes: response.length, ok: reply.ok });
      }
    } catch { /* A malformed reply is only diagnostic evidence. */ }
    finish({ phase: "control-invalid-reply", id, bytes: response.length });
  });
  socket.once("end", () => finish({ phase: "control-eof", id, bytes: response.length }));
  socket.once("close", () => finish({ phase: "control-eof", id, bytes: response.length }));
  socket.once("error", (error: NodeJS.ErrnoException) => finish({ phase: "control-error", id, bytes: response.length, code: error.code }));
  report({ phase: "control-start", id });
  return () => finish({ phase: "control-cancelled", id, bytes: response.length });
}

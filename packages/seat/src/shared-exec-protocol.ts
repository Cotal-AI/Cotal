import type { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

export const SHARED_EXEC_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const noncePattern = /^[0-9a-f]{64}$/;

export interface SharedExecGateOptions {
  socket: string;
  leaf: string;
  uid: number;
  pid: number;
  start: string;
  boot: string;
  nonce: string;
}

export interface SharedExecReady { type: "READY"; nonce: string }
export interface SharedExecPayload { command: string; args: string[]; env: Record<string, string>; cwd: string }
export interface SharedExecCommit extends SharedExecPayload { type: "COMMIT"; nonce: string }

type Frame = SharedExecReady | SharedExecCommit;
const text = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");
const absolute = (value: unknown): value is string => text(value) && isAbsolute(value);

/** Bootstrap only. No connector command, arguments, environment or cwd belong here. */
export function sharedExecGateArgs(options: SharedExecGateOptions): string[] {
  const { socket, leaf, uid, pid, start, boot, nonce } = options;
  return [socket, leaf, String(uid), String(pid), start, boot, nonce];
}

export function parseSharedExecGateArgs(args: string[]): SharedExecGateOptions {
  const [socket, leaf, rawUid, rawPid, start, boot, nonce] = args;
  const uid = Number(rawUid), pid = Number(rawPid);
  if (args.length !== 7 || !absolute(socket) || !absolute(leaf) || !/^\d+$/.test(rawUid) ||
      !/^\d+$/.test(rawPid) || !Number.isSafeInteger(uid) || !Number.isSafeInteger(pid) || pid <= 1 ||
      !/^\d+$/.test(start) || !/^[0-9a-f-]{36}$/.test(boot) || !noncePattern.test(nonce)) {
    throw new Error("invalid shared exec bootstrap");
  }
  return { socket, leaf, uid, pid, start, boot, nonce };
}

function isFrame<T extends Frame["type"]>(value: unknown, expected: T): value is Extract<Frame, { type: T }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  if (f.type !== expected || typeof f.nonce !== "string" || !noncePattern.test(f.nonce)) return false;
  if (expected === "READY") return Object.keys(f).length === 2;
  return Object.keys(f).length === 6 && text(f.command) && f.command.length > 0 && absolute(f.cwd) &&
    Array.isArray(f.args) && f.args.every(text) && !!f.env && typeof f.env === "object" && !Array.isArray(f.env) &&
    Object.entries(f.env).every(([key, val]) => key.length > 0 && !key.includes("=") && text(key) && text(val));
}

export function encodeSharedExecFrame(frame: Frame): Buffer {
  if ((frame.type !== "READY" && frame.type !== "COMMIT") || !isFrame(frame, frame.type)) {
    throw new Error("invalid shared exec frame");
  }
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
  if (bytes.length > MAX_FRAME_BYTES) throw new Error("shared exec frame exceeds limit");
  return bytes;
}

/** Read one newline-terminated message, with a fixed time and byte budget, never logging payload. */
export function readSharedExecFrame<T extends Frame["type"]>(
  socket: Socket, expected: T,
): Promise<Extract<Frame, { type: T }>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(fail, SHARED_EXEC_TIMEOUT_MS);
    function cleanup(): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", fail);
      socket.off("close", fail);
      socket.off("error", fail);
    }
    function fail(): void {
      cleanup();
      reject(new Error(`invalid, incomplete or timed-out shared exec ${expected}`));
    }
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) return fail();
      const end = chunk.indexOf(10);
      if (end >= 0 && end !== chunk.length - 1) return fail();
      chunks.push(chunk);
      if (end < 0) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
        if (!isFrame(value, expected)) return fail();
        cleanup();
        resolve(value);
      } catch { fail(); }
    }
    socket.on("error", fail);
    socket.once("close", fail);
    socket.once("end", fail);
    socket.on("data", onData);
    if (socket.destroyed || socket.readableEnded) fail();
  });
}

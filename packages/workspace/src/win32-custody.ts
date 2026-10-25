import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { connect, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessIdentityRecord } from "./pid.js";
import { nativeWin32CreationToken, windowsCommandLine, windowsEnvironmentBlock, type Win32JobLaunch } from "./win32-process.js";

/**
 * Windows process custody. A detached custodian process per service instance holds the only handle
 * to a kill-on-close job that its program was created in. The custodian's death ends every member,
 * so a lost custodian never leaves an unowned process. A caller reaches the custodian over a named
 * pipe and proves, on every connection, that it holds the instance's 32-byte capability; the
 * custodian proves the same back before the caller trusts any answer. Fresh nonces on both sides
 * bind each answer to its connection.
 */
export const CUSTODY_PROTOCOL = 1;
const FRAME_LIMIT = 64 * 1024;
const AUTH_DEADLINE_MS = 5_000;
/** A nonce or a proof: the base64 of 32 bytes, ASCII only. */
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;
const PIPE = /^\\\\\.\\pipe\\cotal-custody-[0-9a-f]{32}$/;

export type CustodyRequest = { op: "status" } | { op: "terminate"; code: number };
/** What a custodian reports: itself, its program's pin and exit code, the job's members and the
 *  program and arguments it launched. Windows has no exec, so that launch is the program's role. */
export interface CustodyStatus {
  custodian: ProcessIdentityRecord;
  root: ProcessIdentityRecord & { exit: number | null };
  members: number[];
  program: string;
  args: string[];
}
/** The record of one custodied launch: the custodian's pin and its pipe. The capability itself is
 *  kept apart from it, in the caller's protected secret file. */
export interface Win32Custody { custodian: ProcessIdentityRecord; pipe: string }

const proof = (key: Buffer, instanceId: string, label: string, ...parts: string[]) =>
  createHmac("sha256", key).update(["cotal-win32-custody", String(CUSTODY_PROTOCOL), instanceId, label, ...parts].join("\n")).digest("base64");
// Only a well-formed proof is compared, so both sides are 32 bytes and the comparison cannot throw.
const sameProof = (value: unknown, expected: string) =>
  typeof value === "string" && BASE64_32.test(value) && timingSafeEqual(Buffer.from(value, "base64"), Buffer.from(expected, "base64"));

/** Deliver each newline-ended JSON object `socket` sends; anything longer or malformed calls `bad`,
 *  as does a frame its handler throws on, so a peer's input ends only its own connection. */
function frames(socket: Socket, frame: (value: Record<string, unknown>) => void, bad: () => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { return bad(); }
      if (value === null || typeof value !== "object" || Array.isArray(value)) return bad();
      try { frame(value as Record<string, unknown>); } catch { return bad(); }
    }
    if (buffer.length > FRAME_LIMIT) bad();
  });
}

function parseRequest(text: string): CustodyRequest {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value?.op === "status" && Object.keys(value).length === 1) return { op: "status" };
  if (value?.op === "terminate" && Object.keys(value).length === 2 && Number.isInteger(value.code) && Number(value.code) >= 0 && Number(value.code) <= 0xffffffff) return { op: "terminate", code: Number(value.code) };
  throw new Error("unknown custody request");
}

/** Answer authenticated requests on `server`. A connection that does not prove the capability
 *  within the deadline, or sends an oversized or malformed frame, is dropped before `handle` runs. */
export function serveCustody(server: Server, key: Buffer, instanceId: string, handle: (request: CustodyRequest) => Promise<unknown>): void {
  server.on("connection", (socket) => {
    let step = 0, client = "", nonce = "";
    const deadline = setTimeout(() => socket.destroy(), AUTH_DEADLINE_MS);
    const drop = () => { clearTimeout(deadline); socket.destroy(); };
    socket.on("error", drop);
    socket.on("close", () => clearTimeout(deadline));
    frames(socket, (frame) => {
      if (step === 0) {
        if (frame.protocol !== CUSTODY_PROTOCOL || typeof frame.nonce !== "string" || !BASE64_32.test(frame.nonce)) return drop();
        client = frame.nonce;
        nonce = randomBytes(32).toString("base64");
        step = 1;
        socket.write(JSON.stringify({ nonce, proof: proof(key, instanceId, "server", client, nonce) }) + "\n");
        return;
      }
      if (step !== 1) return;
      if (typeof frame.request !== "string" || !sameProof(frame.proof, proof(key, instanceId, "request", client, nonce, frame.request))) return drop();
      step = 2;
      clearTimeout(deadline);
      let request: CustodyRequest;
      try { request = parseRequest(frame.request); } catch { return drop(); }
      const reply = (result: string) => socket.end(JSON.stringify({ result, proof: proof(key, instanceId, "reply", client, nonce, result) }) + "\n");
      handle(request).then((value) => reply(JSON.stringify({ ok: true, value })), (error: unknown) => reply(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })));
    }, drop);
  });
}

/** Send one request to the custodian at `pipe` and return its authenticated answer. */
export function custodyRequest(pipe: string, key: Buffer, instanceId: string, request: CustodyRequest, timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32).toString("base64");
    const text = JSON.stringify(request);
    let step = 0, server = "", settled = false;
    const socket = connect(pipe);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("the process custodian did not answer in time")), timeoutMs);
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("the process custodian closed the connection without an answer")));
    socket.on("connect", () => socket.write(JSON.stringify({ protocol: CUSTODY_PROTOCOL, nonce }) + "\n"));
    frames(socket, (frame) => {
      if (step === 0) {
        if (typeof frame.nonce !== "string" || !BASE64_32.test(frame.nonce) || !sameProof(frame.proof, proof(key, instanceId, "server", nonce, frame.nonce)))
          return finish(new Error("the process custodian did not prove the instance capability"));
        server = frame.nonce;
        step = 1;
        socket.write(JSON.stringify({ request: text, proof: proof(key, instanceId, "request", nonce, server, text) }) + "\n");
        return;
      }
      if (typeof frame.result !== "string" || !sameProof(frame.proof, proof(key, instanceId, "reply", nonce, server, frame.result)))
        return finish(new Error("the process custodian's answer was not authentic"));
      const result = JSON.parse(frame.result) as { ok?: unknown; value?: unknown; error?: unknown };
      if (result.ok === true) finish(undefined, result.value);
      else finish(new Error(`the process custodian refused the request: ${String(result.error)}`));
    }, () => finish(new Error("the process custodian sent a malformed frame")));
  });
}

const pin = (value: unknown): value is ProcessIdentityRecord => {
  const record = value as ProcessIdentityRecord | undefined;
  return typeof record?.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.token === "string" && /^\d{1,20}$/.test(record.token);
};

/** A custodian's status answer, checked against the custodian the caller recorded. */
export function custodyStatus(value: unknown, custodian: ProcessIdentityRecord): CustodyStatus {
  const status = value as CustodyStatus | undefined;
  if (!status || !pin(status.custodian) || status.custodian.pid !== custodian.pid || status.custodian.token !== custodian.token || !pin(status.root) ||
      !(status.root.exit === null || (Number.isInteger(status.root.exit) && status.root.exit >= 0)) || !Array.isArray(status.members) ||
      !status.members.every((pid) => Number.isSafeInteger(pid) && pid > 0) || typeof status.program !== "string" || !Array.isArray(status.args) || !status.args.every((arg) => typeof arg === "string"))
    throw new Error("the process custodian answered for another custody");
  return status;
}

/** The custodian's compiled entry, beside this module in `dist`. */
function custodianEntry(): string {
  const path = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "win32-custodian.js");
  if (!existsSync(path)) throw new Error(`the process custodian entry is missing at ${path}; reinstall this version`);
  return path;
}

/** Start a detached custodian that launches `program` in its job. The launch and the capability
 *  reach it on stdin, never in its arguments or environment. It answers on stdout once the program
 *  runs, and the custodian's own pin is read here before the answer is accepted. `spawned` receives
 *  the custodian's pin and pipe as soon as it runs, before its program does. */
export async function startWin32Custodian(input: { program: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; log: string; instanceId: string }, key: Buffer, spawned?: (custodian: ProcessIdentityRecord, pipe: string) => void): Promise<Win32Custody & { process: ProcessIdentityRecord }> {
  if (process.platform !== "win32") throw new Error("Windows process custody runs only on Windows");
  if (key.length !== 32) throw new Error("a custody capability is 32 bytes");
  const pipe = `\\\\.\\pipe\\cotal-custody-${randomBytes(16).toString("hex")}`;
  const launch: Win32JobLaunch = { application: input.program, commandLine: windowsCommandLine(input.program, input.args), cwd: input.cwd, environment: windowsEnvironmentBlock(input.env), log: input.log };
  const child = spawn(process.execPath, [custodianEntry()], { detached: true, env: {}, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  child.once("spawn", () => {
    const token = nativeWin32CreationToken(child.pid!);
    if (token !== undefined) spawned?.({ pid: child.pid!, token }, pipe);
  });
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("the process custodian did not report its launch in time")), 15_000);
      const done = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(text.slice(0, text.indexOf("\n"))); };
      child.once("error", done);
      child.once("exit", () => done(text.includes("\n") ? undefined : new Error("the process custodian exited before it reported a launch")));
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => { text += chunk; if (text.includes("\n")) done(); else if (text.length > FRAME_LIMIT) done(new Error("the process custodian's report is oversized")); });
      child.stdin!.on("error", () => {});
      child.stdin!.end(JSON.stringify({ protocol: CUSTODY_PROTOCOL, capability: key.toString("base64"), instanceId: input.instanceId, program: input.program, args: input.args, pipe, launch }) + "\n");
    });
    const report = JSON.parse(answer) as { error?: unknown; custodian?: unknown; process?: unknown };
    if (typeof report.error === "string") throw new Error(`the process custodian could not launch the service: ${report.error}`);
    if (!pin(report.custodian) || !pin(report.process) || report.custodian.pid !== child.pid || nativeWin32CreationToken(child.pid!) !== report.custodian.token)
      throw new Error("the process custodian's report does not name itself");
    return { custodian: report.custodian, pipe, process: report.process };
  } catch (error) {
    // A custodian that did not report a launch holds no running program worth keeping; ending it ends its job.
    if (child.exitCode === null) child.kill();
    throw error;
  } finally {
    child.stdout?.destroy();
    child.unref();
  }
}

export function isCustodyPipe(value: unknown): value is string {
  return typeof value === "string" && PIPE.test(value);
}

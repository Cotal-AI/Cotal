import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { readLocalRecordSource } from "@cotal-ai/workspace";
import type { UnitReceipt } from "./install.js";
import type { Socket } from "node:net";
import { MAX_LINE_BYTES } from "./endpoint.js";

/** One pinned repair connection. A late timed-out reply never acknowledges a later request. */
export function repairReplies(socket: Socket): { read(id: string, timeoutMs: number): Promise<string>; close(): void } {
  let buffer = "";
  let failure: Error | undefined;
  let pending: { id: string; resolve(line: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const expired = new Set<string>();
  const fail = (error: Error) => {
    failure = error;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
  };
  const data = (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) { fail(new Error("daemon repair reply exceeds the line limit")); return; }
      let id: unknown;
      try { id = (JSON.parse(line) as { id?: unknown }).id; }
      catch { fail(new Error("daemon repair returned malformed JSON")); return; }
      if (typeof id !== "string") { fail(new Error("daemon repair reply has no request id")); return; }
      if (expired.delete(id)) continue;
      if (!pending || id !== pending.id) { fail(new Error("daemon repair returned an unknown request id")); return; }
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(line);
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) fail(new Error("daemon repair reply exceeds the line limit"));
  };
  const end = () => fail(new Error("daemon closed the repair connection without a reply"));
  socket.setEncoding("utf8"); socket.on("data", data); socket.on("end", end); socket.on("error", fail);
  return {
    read(id, timeoutMs) {
      if (failure) return Promise.reject(failure);
      if (pending || expired.has(id)) return Promise.reject(new Error("daemon repair request overlaps another request"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending = undefined; expired.add(id); reject(new Error("timed out waiting for the daemon repair reply")); }, timeoutMs);
        pending = { id, resolve, reject, timer };
      });
    },
    close() { socket.off("data", data); socket.off("end", end); socket.off("error", fail); fail(new Error("daemon repair reader closed")); },
  };
}

export interface ServiceRepairIntent {
  readonly v: 1;
  readonly receipt: UnitReceipt;
  readonly previousSource: string;
  readonly nextSource: string;
  readonly enabled: boolean;
  readonly argv: readonly string[];
  readonly version: string;
  readonly hostedSpaces: readonly string[];
  readonly phase: "prepared" | "published";
}

export const serviceRepairFile = (state: string): string => join(state, "service-repair.json");
export const sourceDigest = (source: string): string => createHash("sha256").update(source).digest("hex");

/** A protected intent binds both permitted file states. Unknown content never becomes repair authority. */
export function readServiceRepair(state: string): ServiceRepairIntent | undefined {
  const bytes = readLocalRecordSource(serviceRepairFile(state), 256 * 1024, true);
  if (!bytes) return undefined;
  const value = JSON.parse(bytes.toString("utf8")) as ServiceRepairIntent;
  if (value.v !== 1 || typeof value.enabled !== "boolean" || typeof value.previousSource !== "string" || typeof value.nextSource !== "string"
    || !Array.isArray(value.argv) || !value.argv.every(item => typeof item === "string") || typeof value.version !== "string"
    || !Array.isArray(value.hostedSpaces) || !value.hostedSpaces.every(item => typeof item === "string") || !["prepared", "published"].includes(value.phase)
    || value.receipt?.v !== 1 || value.receipt.mechanism !== "launchd-agent" || typeof value.receipt.unitSha256 !== "string"
    || typeof value.receipt.unit !== "string" || typeof value.receipt.unitPath !== "string" || typeof value.receipt.installedAt !== "string"
    || !isAbsolute(value.receipt.unitPath) || !/^[a-f0-9]{64}$/.test(value.receipt.unitSha256)
    || sourceDigest(value.previousSource) !== value.receipt.unitSha256) throw new Error("the daemon service repair intent is invalid; nothing was changed");
  return value;
}

/** A crash may leave either old or new source and receipt. Only those recorded pairs may resume. */
export function assertServiceRepairPair(intent: ServiceRepairIntent, receipt: UnitReceipt, source: string): void {
  const next = { ...intent.receipt, unitSha256: sourceDigest(intent.nextSource) };
  if (JSON.stringify(receipt) !== JSON.stringify(intent.receipt) && JSON.stringify(receipt) !== JSON.stringify(next)) throw new Error("the daemon service receipt changed outside repair; nothing was changed");
  if (source !== intent.previousSource && source !== intent.nextSource) throw new Error("the daemon service source changed outside repair; nothing was changed");
}

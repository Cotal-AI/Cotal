import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeCotalDir } from "@cotal-ai/workspace";
import { probeLiveness } from "@cotal-ai/workspace/liveness";
import { processStartToken } from "@cotal-ai/core";
import type { DaemonStatus } from "./protocol.js";

export interface PreservationObservation {
  readonly owner: "gone" | "transaction" | "live" | "unknown";
  readonly age: string;
  readonly seats: number | "unknown";
}

/** Inspect existing records only. Missing or unreadable ownership never proves death. */
export function preinstallPreservationObservation(status: DaemonStatus): PreservationObservation {
  if (!Array.isArray(status.managers)) return { owner: "unknown", age: "unknown", seats: "unknown" };
  const active = status.managers.filter(row => row.pid !== undefined);
  const evidence = status.update?.restartEvidence;
  const complete = evidence?.prepared === true && evidence.managers.length === active.length
    && new Set(evidence.managers.map(row => row.space)).size === active.length
    && active.every(manager => evidence.managers.some(row => row.space === manager.space && row.fenced === true && Number.isSafeInteger(row.seats) && row.seats >= 0));
  const seats = complete ? evidence.managers.reduce((sum, row) => sum + row.seats, 0) : "unknown";
  let owner: PreservationObservation["owner"] = "unknown", age = "unknown";
  let fd: number | undefined;
  try {
    fd = openSync(join(homeCotalDir(), ".update-closure.lock"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > 65536 || (st.mode & 0o022) !== 0 || (process.getuid && st.uid !== process.getuid())) return { owner, age, seats };
    const record = JSON.parse(readFileSync(fd, "utf8")) as { pid?: unknown; start?: unknown; nonce?: unknown; ts?: unknown };
    if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 || typeof record.start !== "string" || !record.start || typeof record.nonce !== "string" || !record.nonce) return { owner, age, seats };
    if (typeof record.ts === "number" && Number.isFinite(record.ts) && record.ts <= Date.now()) age = `${Math.floor((Date.now() - record.ts) / 1000)} s since the recorded update closure`;
    const pid = Number(record.pid), birth = processStartToken(pid);
    if (birth !== undefined && birth !== record.start || birth === undefined && probeLiveness(pid) === "dead") owner = "gone";
    else if (birth === record.start) {
      const env = process.env;
      const delegated = env.COTAL_UPDATE_CLOSURE_OWNER === String(pid) && env.COTAL_UPDATE_CLOSURE_START === record.start && env.COTAL_UPDATE_CLOSURE_NONCE === record.nonce;
      owner = pid === process.pid || delegated ? "transaction" : "live";
    }
  } catch { /* Unknown custody is a refusal, not recovery authority. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return { owner, age, seats };
}

export function preservingPreinstallRefusal(observation: PreservationObservation): Error {
  return new Error(`manager is in preserving mode; hold age ${observation.age}; seats ${observation.seats}; update owner ${observation.owner}. Wait for a running update to finish, then run \`cotal update --self\` again. No hold was released by this check.`);
}

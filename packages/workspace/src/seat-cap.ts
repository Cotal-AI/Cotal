import { writeSecretFileAtomic } from "@cotal-ai/core";
import { canonicalLocalProcessPath, type LocalProcessContext } from "./local-process.js";
import { CommandFailure } from "./output.js";
import { localRecordObject, readLocalRecordSource } from "./protected-records.js";

/**
 * The per-owner seat ceiling a manager enforces: how many live seats it supervises for one owner
 * at a time. It is a tenancy decision, not a resource fact, so it belongs to the operator who
 * started the manager and is recorded for that root, the way the manager name is.
 *
 * A number is the ceiling; `unlimited` is the shipped default, under which the manager's own
 * `MAX_AGENTS` ceiling stays the only bound. A single-owner mesh therefore keeps every slot it
 * had, and an operator hosting several owners on one manager sets a number so that one owner
 * cannot take the whole host.
 */
export type SeatCap = number | typeof SEAT_CAP_UNLIMITED;

/** The flag value, and the recorded value, that means "no per-owner ceiling". */
export const SEAT_CAP_UNLIMITED = "unlimited";

/** What a manager started without the flag, and with nothing recorded, enforces. */
export const DEFAULT_SEAT_CAP: SeatCap = SEAT_CAP_UNLIMITED;

/** Where a root keeps the seat cap of its manager for one space. The cap belongs to the logical
 *  instance, which persists in the root across restarts, so a restart or a repair keeps it. */
export const MANAGER_SEAT_CAP_RECORD = "manager.{space}.seat-cap.json";

/** Parse a `--seat-cap` value: a positive integer, or `unlimited`. Absent stays undefined, so the
 *  caller falls back to what the root recorded and then to {@link DEFAULT_SEAT_CAP}. A typo fails
 *  loud as a usage refusal rather than silently becoming a ceiling nobody asked for. */
export function parseSeatCapFlag(flag: string, raw: string | undefined): SeatCap | undefined {
  if (raw === undefined) return undefined;
  if (raw === SEAT_CAP_UNLIMITED) return SEAT_CAP_UNLIMITED;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new CommandFailure("refused", "USAGE_INVALID", `${flag} must be a positive integer or "${SEAT_CAP_UNLIMITED}" (got ${JSON.stringify(raw)})`);
  return n;
}

/** How a cap reads in a sentence an operator or an agent sees. */
export function seatCapText(cap: SeatCap): string {
  return cap === SEAT_CAP_UNLIMITED ? SEAT_CAP_UNLIMITED : String(cap);
}

/** The cap recorded for this root's manager, or undefined when none was given. */
export function readManagerSeatCap(context: LocalProcessContext): SeatCap | undefined {
  const path = canonicalLocalProcessPath(MANAGER_SEAT_CAP_RECORD, context);
  const bytes = readLocalRecordSource(path, 4096, true);
  if (bytes === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the manager seat-cap record is not valid JSON", { target: { path } }); }
  const record = localRecordObject(value, ["version", "seatCap"]);
  if (record.version !== 1) throw new CommandFailure("refused", "SCHEMA_INVALID", "the manager seat-cap record has an unsupported version", { target: { path } });
  const cap = record.seatCap;
  if (cap === SEAT_CAP_UNLIMITED) return SEAT_CAP_UNLIMITED;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1)
    throw new CommandFailure("refused", "SCHEMA_INVALID", `the manager seat-cap record holds neither a positive integer nor "${SEAT_CAP_UNLIMITED}"`, { target: { path } });
  return cap;
}

/** Record `cap` as this root's manager seat cap for the space. */
export function recordManagerSeatCap(context: LocalProcessContext, cap: SeatCap): void {
  writeSecretFileAtomic(canonicalLocalProcessPath(MANAGER_SEAT_CAP_RECORD, context), JSON.stringify({ version: 1, seatCap: cap }));
}

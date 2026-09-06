/**
 * The RUN PROGRAM record: the source a run was started from, beside its spec.
 *
 * A run used to store no source, so every `resume` and every takeover had to be handed the same
 * file again, and a daemon that hosts drivers had nowhere to read it from after a restart. The
 * source is written here by the driver that pins the run, create-only, and read back by whoever
 * drives the run next. A resume handed DIFFERENT source is a fork (SPEC 14.5); the recorded source
 * is what that comparison is made against, and the hash the language pins each step to is derived
 * from the same bytes.
 *
 * Atomic and create-only: what a run was started from is one fact, decided once. It carries no hash
 * of its own on purpose: the language owns `programHashOf`, core does not depend on the language,
 * and a second hash function here would be a different answer wearing the same name.
 */
import type { KV } from "@nats-io/kv";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { RECORD_KINDS, createRecordEntry, readAtomicRecord, recordAtomicKey } from "./endpoint-records.js";

export interface RunProgramValue {
  readonly v: 1;
  readonly run: string;
  /** The program, verbatim. */
  readonly source: string;
  /** The file name the source came from, when it came from one. Diagnostic only. */
  readonly file?: string;
  readonly at: number;
}

function parseProgram(raw: unknown, key: string): RunProgramValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `run program ${key} is not an object; garbled state never authorizes`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!["v", "run", "source", "file", "at"].includes(k))
      throw new EpEnvelopeError("internal", `run program ${key} carries the unknown field "${k}"; record schemas are closed`);
  if (o.v !== 1 || typeof o.run !== "string" || typeof o.source !== "string"
    || typeof o.at !== "number" || !Number.isSafeInteger(o.at) || o.at < 0
    || (o.file !== undefined && typeof o.file !== "string"))
    throw new EpEnvelopeError("internal", `run program ${key} is malformed; garbled state never authorizes`);
  return {
    v: 1,
    run: o.run,
    source: o.source,
    ...(o.file !== undefined ? { file: o.file as string } : {}),
    at: o.at,
  };
}

/**
 * Record a run's source, create-only.
 *
 * A retry with the SAME source is this driver's own earlier attempt and succeeds. A different source
 * under a run that already has one is refused: a run is started from one program, and moving it onto
 * another is a migration, which files its own record.
 */
export async function recordRunProgram(
  kv: KV,
  endpoint: string,
  value: RunProgramValue,
): Promise<{ key: string; created: boolean }> {
  const key = recordAtomicKey(RECORD_KINDS.program, [endpoint, value.run]);
  try {
    await createRecordEntry(kv, key, value);
    return { key, created: true };
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const existing = await readRunProgram(kv, endpoint, value.run);
    if (existing === undefined)
      throw new EpEnvelopeError("internal", `run program ${key} lost its create CAS but is not readable; reconcile the store`);
    if (existing.source !== value.source)
      throw new EpEnvelopeError("conflict", `run ${value.run} already records a different program; a run is started from one source, and moving it onto another is a migration`);
    return { key, created: false };
  }
}

/** The source a run was started from. `undefined` = none recorded (a run started before this
 *  record existed, or one whose start crashed between the activation and the pin). */
export async function readRunProgram(kv: KV, endpoint: string, runId: string): Promise<RunProgramValue | undefined> {
  const key = recordAtomicKey(RECORD_KINDS.program, [endpoint, runId]);
  const read = await readAtomicRecord(kv, RECORD_KINDS.program, [endpoint, runId]);
  return read === undefined ? undefined : parseProgram(read.value, key);
}

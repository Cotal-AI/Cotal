import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { CommandFailure, oneLine, streamRecord, type Presentation, type RecordType } from "@cotal-ai/workspace";
import { processServiceHost, type ServiceInstanceSnapshot } from "./service-instances.js";
import { ownStdoutErrors } from "./stdout-owner.js";
import type { serviceSupervisorProjection } from "./service-supervision.js";

type RecordedSupervisor = ReturnType<typeof serviceSupervisorProjection>;
const outputLimit = 1_048_576, recordLimit = 262_144;
const fields = ["__CURSOR", "__REALTIME_TIMESTAMP", "__MONOTONIC_TIMESTAMP", "_BOOT_ID", "_UID", "_PID", "_SYSTEMD_USER_UNIT", "_SYSTEMD_INVOCATION_ID", "MESSAGE"];

/** Freeze the original recorded invocation. Never infer a unit from a name, adopt the native
 *  manager's current invocation, or follow a replacement when this selected process exits. */
function selection(selected: ServiceInstanceSnapshot, recorded: RecordedSupervisor, tail: number) {
  const value = selected.record.value, host = processServiceHost();
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > 1000) throw new CommandFailure("refused", "USAGE_INVALID", "journal tail needs an integer from 1 to 1000");
  if (value.host.machine !== host.machine || value.host.uid !== host.uid || recorded.fileObservation === "foreign-host") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the recorded journal belongs to another execution host or OS user; no local journal was substituted");
  if (recorded.mechanism !== "systemd-user" || !recorded.unit || !value.supervisorInvocationId) throw new CommandFailure("refused", "UNSUPPORTED", "native journal access requires a recorded systemd user unit and its original invocation ID; no current unit or old direct-child log was substituted");
  const boot = value.host.boot.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(boot)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the original journal boot identity is invalid");
  const target = { space: value.space, name: value.definition, instanceId: value.instanceId };
  const binding = { unit: recorded.unit, invocationId: value.supervisorInvocationId, boot, uid: String(host.uid), launchRequestId: value.launchRequestId };
  const argv = ["--user", "--no-pager", "--output=json", `--output-fields=${fields.join(",")}`, "--all", `--lines=${tail}`, `_SYSTEMD_USER_UNIT=${binding.unit}`, `_SYSTEMD_INVOCATION_ID=${binding.invocationId}`, `_BOOT_ID=${binding.boot}`, `_UID=${binding.uid}`];
  return { target, binding, argv };
}

type Selection = ReturnType<typeof selection>;
function entry(line: string, selected: Selection) {
  if (Buffer.byteLength(line) > recordLimit) throw new Error();
  const row: unknown = JSON.parse(line);
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
  const value = row as Record<string, unknown>;
  const text = (key: string, limit: number) => {
    const part = value[key];
    if (typeof part !== "string" || !part || part.length > limit || /[\u0000-\u001f\u007f]/u.test(part)) throw new Error();
    return part;
  };
  if (Object.keys(value).some((name) => !fields.includes(name)) || text("_SYSTEMD_USER_UNIT", 240) !== selected.binding.unit || text("_SYSTEMD_INVOCATION_ID", 32) !== selected.binding.invocationId || text("_BOOT_ID", 32) !== selected.binding.boot || text("_UID", 20) !== selected.binding.uid) throw new Error();
  const realtimeUs = text("__REALTIME_TIMESTAMP", 30), monotonicUs = text("__MONOTONIC_TIMESTAMP", 30), pid = value._PID === undefined ? null : text("_PID", 20);
  if (!/^[0-9]+$/.test(realtimeUs) || !/^[0-9]+$/.test(monotonicUs) || pid !== null && !/^[1-9][0-9]*$/.test(pid)) throw new Error();
  const nativeValue = (part: unknown, depth = 0): boolean => part === null || typeof part === "string" || depth < 2 && Array.isArray(part) && part.every((item) => typeof item === "number" ? Number.isInteger(item) && item >= 0 && item <= 255 : nativeValue(item, depth + 1));
  const message = value.MESSAGE ?? null;
  if (!nativeValue(message)) throw new Error();
  return { cursor: text("__CURSOR", 4096), realtimeUs, monotonicUs, boot: selected.binding.boot, unit: selected.binding.unit, invocationId: selected.binding.invocationId, pid, message, encoding: typeof message === "string" ? "utf8" as const : "native-json" as const };
}

/** Retained readable journal records only. Success never establishes that journald retained all
 *  messages, that the unit is serving, or that a zero-row query means no work happened. */
export function readServiceJournal(selected: ServiceInstanceSnapshot, recorded: RecordedSupervisor, tail: number) {
  const chosen = selection(selected, recorded, tail);
  const result = spawnSync("journalctl", chosen.argv, { timeout: 3000, maxBuffer: outputLimit, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the native journal reader is unavailable; no direct-child file or remote log service was substituted", { target: chosen.target });
  const entries: ReturnType<typeof entry>[] = [];
  let rejectedRecords = 0;
  let output: string;
  try { output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout ?? new Uint8Array()); }
  catch { throw new CommandFailure("failed", "OPERATION_FAILED", "the bounded native journal output did not retain valid UTF-8 JSON; no corrupted text or native diagnostics were forwarded", { target: chosen.target }); }
  const lines = output.split("\n"), trailing = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    try { entries.push(entry(line, chosen)); } catch { rejectedRecords++; }
  }
  const queryIncomplete = Boolean(result.error || result.signal || result.status !== 0);
  if (queryIncomplete && !entries.length) throw new CommandFailure("failed", "OPERATION_FAILED", "the bounded original-invocation journal query did not return usable records; native diagnostics were withheld and no query was retried", { target: chosen.target });
  const diagnosticsWithheld = Boolean(result.stderr?.length);
  return { kind: "service-journal" as const, ...chosen.binding, requestedTail: tail, entries, rejectedRecords, incompleteTrailingRecord: Boolean(trailing), nativeQueryIncomplete: queryIncomplete, diagnosticsWithheld, partial: queryIncomplete || diagnosticsWithheld || rejectedRecords > 0 || Boolean(trailing), scope: "retained readable records of the original unit invocation" as const, maximumReadBytes: outputLimit, maximumRecordBytes: recordLimit, serviceControl: "none" as const };
}

export async function followServiceJournal(selected: ServiceInstanceSnapshot, recorded: RecordedSupervisor, presentation: Presentation, tail: number): Promise<void> {
  const chosen = selection(selected, recorded, tail), stopped = new AbortController();
  let reason = "reader-ended", brokenOutput = false, diagnosticsWithheld = false, rejectedRecords = 0, count = 0;
  const child = spawn("journalctl", [...chosen.argv, "--follow"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let ended = false, nativeCode: number | null = null, nativeSignal: NodeJS.Signals | null = null;
  const closed = new Promise<void>((resolve) => child.once("close", (code, signal) => { ended = true; nativeCode = code; nativeSignal = signal; resolve(); }));
  let spawnError = false;
  const spawned = new Promise<void>((resolve) => { child.once("spawn", resolve); child.once("error", () => { spawnError = true; resolve(); }); });
  child.stderr.on("data", (bytes: Buffer) => { if (bytes.length) diagnosticsWithheld = true; });
  const closeReader = () => { child.stdout.destroy(); if (!ended) child.kill("SIGTERM"); };
  const waitClosed = async (timeoutMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([closed.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const stop = (signal: "SIGINT" | "SIGTERM") => { reason = signal; process.exitCode = signal === "SIGINT" ? 130 : 143; stopped.abort(); closeReader(); };
  const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
  const outputError = () => { brokenOutput = true; reason = "output-closed"; stopped.abort(); closeReader(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  // This reader owns stdout's errors, so a closed output stops journalctl before the process exits.
  const releaseOutput = ownStdoutErrors(outputError);
  const write = async (text: string) => { if (!brokenOutput && !process.stdout.write(text)) await once(process.stdout, "drain", { signal: stopped.signal }); };
  const record = async (type: RecordType, data: unknown) => {
    if (presentation === "json") await write(`${JSON.stringify(streamRecord("logs", type, chosen.target, data))}\n`);
    else if (type === "event") {
      const value = data as ReturnType<typeof entry>;
      const message = typeof value.message === "string" ? value.message : JSON.stringify(value.message);
      await write(`${oneLine(value.realtimeUs)}  ${oneLine(value.cursor)}  ${message.split("\n").map(oneLine).join("\n")}\n`);
    } else await write(`${type}: ${oneLine(JSON.stringify(data))}\n`);
  };
  try {
    await record("snapshot", { ...chosen.binding, requestedTail: tail, scope: "original recorded invocation only; no successor adoption", maximumRecordBytes: recordLimit, journalRetention: "not-established", serviceControl: "none" });
    await spawned;
    if (spawnError) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the native journal reader did not start; no file reader or other invocation was substituted");
    await record("connection", { state: "native-reader-started", servingReadiness: "not-checked" });
    let pending = "", discarding = false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of child.stdout) {
      if (stopped.signal.aborted) break;
      const parts = decoder.decode(chunk as Uint8Array, { stream: true }).split("\n");
      for (let index = 0; index < parts.length; index++) {
        if (stopped.signal.aborted) break;
        const last = index === parts.length - 1;
        if (!discarding) {
          pending += parts[index]!;
          if (Buffer.byteLength(pending) > recordLimit) { pending = ""; discarding = true; rejectedRecords++; await record("gap", { reason: "native-record-exceeded-byte-limit", maximumRecordBytes: recordLimit }); }
        }
        if (last) continue;
        if (!discarding && pending) {
          let value: ReturnType<typeof entry> | undefined;
          try { value = entry(pending, chosen); } catch { rejectedRecords++; await record("gap", { reason: "native-record-unattributed-or-unsupported" }); }
          if (value) { await record("event", value); count++; }
        }
        pending = ""; discarding = false;
      }
    }
    if (!stopped.signal.aborted && (pending || discarding || decoder.decode())) { if (!discarding) rejectedRecords++; await record("gap", { reason: "native-reader-ended-with-incomplete-record", alreadyCounted: discarding }); }
    if (!stopped.signal.aborted && !await waitClosed(1500)) throw new CommandFailure("failed", "OPERATION_FAILED", "the native journal reader closed its output without confirming its own exit");
    if (!stopped.signal.aborted && (nativeCode !== 0 || nativeSignal)) throw new CommandFailure("failed", "OPERATION_FAILED", "the native journal reader ended without a successful completion; only previously delivered records are established");
  } catch (error) {
    if (!stopped.signal.aborted && !brokenOutput) {
      reason = "read-failed"; process.exitCode = spawnError ? 2 : 5;
      await record("error", { code: spawnError ? "DEPENDENCY_UNAVAILABLE" : "OPERATION_FAILED", message: error instanceof CommandFailure ? error.message : "the original-invocation journal stream failed; native diagnostic bodies were withheld" });
    }
  } finally {
    const interrupted = stopped.signal.aborted;
    stopped.abort();
    if (!ended) {
      closeReader();
      if (!await waitClosed(1500) && !ended) child.kill("SIGKILL");
    }
    if (!interrupted && (rejectedRecords || diagnosticsWithheld) && !process.exitCode) process.exitCode = 4;
    if (!brokenOutput) {
      try {
        if (diagnosticsWithheld) await record("gap", { reason: "native-journal-diagnostics-withheld", accessibleJournalCompleteness: "not-established" });
        await record("end", { reason, ...chosen.binding, deliveredRecords: count, rejectedRecords, diagnosticsWithheld, readerExitObserved: ended, journalRetention: "not-established", serviceUnchangedByView: true });
      } catch { /* A closed output has no guaranteed terminal record. */ }
    }
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); releaseOutput();
  }
}

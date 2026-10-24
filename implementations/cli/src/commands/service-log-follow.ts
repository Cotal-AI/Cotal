import { once } from "node:events";
import { CommandFailure, isCommandFailure, oneLine, streamRecord, type Presentation, type RecordType } from "@cotal-ai/workspace";
import { observeServiceProcess, serviceInstanceStore, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { serviceLogSlice } from "../lib/service-process.js";
import { ownStdoutErrors } from "../lib/stdout-owner.js";

/** A read-only file view. Interrupts close the view without signalling a service process. */
export async function followServiceLog(selected: ServiceInstanceSnapshot, presentation: Presentation, tail: number): Promise<void> {
  const original = selected.record.value;
  if (original.foreground) throw new CommandFailure("refused", "UNSUPPORTED", "this foreground instance did not capture its output in a service log; no fictitious follow stream was opened");
  const target = { space: original.space, name: original.definition, instanceId: original.instanceId };
  const stopped = new AbortController();
  let reason = "view-closed", brokenOutput = false;
  const interrupt = () => { reason = "SIGINT"; process.exitCode = 130; stopped.abort(); };
  const terminate = () => { reason = "SIGTERM"; process.exitCode = 143; stopped.abort(); };
  const outputError = () => { brokenOutput = true; reason = "output-closed"; stopped.abort(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const releaseOutput = ownStdoutErrors(outputError);
  let position: { offset: number; dev: number; ino: number } | undefined;
  let decoder = new TextDecoder("utf-8", { fatal: false });
  let launchRequestId = original.launchRequestId;
  let availability: "missing" | "available" | undefined;
  const write = async (text: string) => { if (!brokenOutput && !process.stdout.write(text)) await once(process.stdout, "drain", { signal: stopped.signal }); };
  const record = async (type: RecordType, data: unknown) => {
    if (presentation === "json") await write(`${JSON.stringify(streamRecord("logs", type, target, data))}\n`);
    else if (type === "event") {
      const item = data as { text?: string; fromOffset?: number; toOffset?: number };
      await write(`${oneLine(String(item.fromOffset ?? ""))}-${oneLine(String(item.toOffset ?? ""))}  ${(item.text ?? "").split("\n").map(oneLine).join("\n")}\n`);
    } else await write(`${type}: ${oneLine(JSON.stringify(data))}\n`);
  };
  try {
    await record("snapshot", { launchRequestId, scope: "owned private file; direct instance only", tail, maximumReadBytes: 1_048_576, maximumChunkBytes: 16_384, encoding: "utf8-with-replacement", serviceControl: "none" });
    while (!stopped.signal.aborted) {
      const current = serviceInstanceStore(original.space).read(original.instanceId);
      if (!current) { reason = "instance-record-removed"; break; }
      if (current.record.value.definition !== original.definition || current.record.value.space !== original.space) throw new CommandFailure("refused", "CONFLICT", "the log instance binding changed; no successor target was substituted");
      if (current.record.value.launchRequestId !== launchRequestId) {
        await record("connection", { state: "instance-generation-changed", previousLaunchRequestId: launchRequestId, launchRequestId: current.record.value.launchRequestId });
        launchRequestId = current.record.value.launchRequestId;
      }
      const slice = serviceLogSlice(original.space, original.instanceId, position, tail);
      if (!slice) {
        if (availability !== "missing") await record("connection", { state: "log-unavailable", processState: observeServiceProcess(current.record.value) });
        availability = "missing";
      } else {
        if (availability !== "available") await record("connection", { state: "log-file-readable", file: slice.file });
        availability = "available";
        if (slice.replaced || slice.truncated || slice.omittedBytes) {
          await record("gap", { reason: slice.replaced ? "log-file-replaced" : slice.truncated ? "log-file-truncated" : position ? "reader-fell-behind" : "bounded-initial-tail", omittedBytes: slice.omittedBytes, previousOffset: position?.offset ?? null, nextOffset: slice.fromOffset });
          const pending = decoder.decode();
          if (pending) await record("event", { launchRequestId, fromOffset: position?.offset ?? null, toOffset: position?.offset ?? null, text: pending, encoding: "utf8-with-replacement", decoderFinalization: true });
          decoder = new TextDecoder("utf-8", { fatal: false });
        }
        position = { ...slice.file, offset: slice.toOffset };
        if (slice.bytes.length) await record("event", { file: slice.file, launchRequestId, fromOffset: slice.fromOffset, toOffset: slice.toOffset, text: decoder.decode(slice.bytes, { stream: true }), encoding: "utf8-with-replacement" });
        if (slice.toOffset < slice.sizeAtRead) continue;
      }
      const state = observeServiceProcess(current.record.value);
      if (["gone", "previous-boot", "foreign-pid"].includes(state)) { reason = "original-process-no-longer-present"; break; }
      if (state === "foreign-host" || state === "unreadable") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the selected instance's execution scope is no longer readable; no other host or file was followed");
      await new Promise<void>((resolve) => { const timer = setTimeout(done, 250); function done() { clearTimeout(timer); stopped.signal.removeEventListener("abort", done); resolve(); } stopped.signal.addEventListener("abort", done, { once: true }); });
    }
    const final = decoder.decode();
    if (final && !brokenOutput) await record("event", { launchRequestId, fromOffset: position?.offset ?? null, toOffset: position?.offset ?? null, text: final, encoding: "utf8-with-replacement", decoderFinalization: true });
  } catch (error) {
    if (!stopped.signal.aborted && !brokenOutput) {
      reason = "read-failed";
      const failure = isCommandFailure(error) ? error : new CommandFailure("failed", "OPERATION_FAILED", "the bounded private log read failed; service state was not changed");
      process.exitCode = failure.outcome === "refused" ? 2 : 5;
      await record("error", { code: failure.code, message: failure.message });
    }
  } finally {
    if (!brokenOutput) {
      try { await record("end", { reason, launchRequestId, byteOffset: position?.offset ?? null, serviceUnchangedByView: true }); } catch { /* The output pipe may close during final delivery. */ }
    }
    stopped.abort(); process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); releaseOutput();
  }
}

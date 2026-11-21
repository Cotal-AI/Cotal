import assert from "node:assert/strict";

// Evidence only: never substitute the sanitized copy for the protocol reply.
const safe = (text, max) => new TextDecoder().decode(Buffer.from(text
  .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"<>\\]+/gi, "[redacted-url]")
  .replace(/((?:["']?(?:[\w-]*(?:token|secret|password|credential|authorization|api[_-]?key)[\w-]*)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,}]+)/gi, '$1"[redacted]"')
  .replace(/\bBearer\s+[^\s",}]+/gi, "Bearer [redacted]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-token]")).subarray(0, max), { stream: true });

export async function readStopReply({ read, fixture, id, commit, version, maxBytes, persist, allowUnknownPreparation = false }) {
  const observation = { requestId: id, commit, phase: fixture.phase, startedAt: new Date().toISOString() };
  (fixture.stopReplies ??= []).push(observation);
  let raw;
  try {
    raw = await read();
    observation.receivedAt = new Date().toISOString();
    observation.rawLine = safe(raw, maxBytes);
    observation.redacted = observation.rawLine !== raw;
    observation.truncated = Buffer.byteLength(raw, "utf8") > maxBytes;
    persist(); // Keep the line even if parsing fails.
    const reply = JSON.parse(raw);
    // Parse the safe wire copy, so nested fields cannot bypass redaction.
    try { observation.reply = JSON.parse(observation.rawLine); }
    catch { observation.safeObservation = "sanitized reply is not JSON"; }
    observation.parsedAt = new Date().toISOString();
    persist(); // The strict acknowledgement failure must not lose a refusal envelope.
    const envelope = reply && typeof reply === "object" && reply.v === version && reply.id === id && !("event" in reply);
    const unknown = envelope && allowUnknownPreparation && !commit && fixture.phase === "stop-prepare"
      && reply.ok === false && reply.error?.code === "DEPENDENCY_UNAVAILABLE"
      && reply.error.message === "the daemon native launch provenance is still unknown; it was not stopped";
    assert.ok(envelope && (reply.ok === true || unknown), "pinned daemon acknowledges stop");
    observation.disposition = unknown ? "native-provenance-unknown" : "acknowledged";
    persist();
    return reply;
  } catch (error) {
    observation.failedAt = new Date().toISOString();
    observation.error = {
      name: safe(String(error.name), maxBytes),
      ...(error.code === undefined ? {} : { code: safe(String(error.code), maxBytes) }),
      // JSON parse errors can quote arbitrary input. The safe raw line is already retained.
      message: error instanceof SyntaxError ? "daemon stop reply is not valid JSON" : safe(String(error.message), maxBytes),
    };
    observation.safeObservation ??= raw === undefined ? "read failed before a complete line was available" : "complete line retained above";
    persist();
    throw error;
  }
}

/** Bounded plain text for a tool payload, including the emitter's whole-body omission marker. */
export function payloadText(value: string): string {
  try {
    const marker: unknown = JSON.parse(value);
    if (typeof marker === "object" && marker !== null && "cotalPayloadCut" in marker && marker.cotalPayloadCut === true) {
      const m = marker as Record<string, unknown>;
      if (typeof m.originalBytes === "number" && Number.isSafeInteger(m.originalBytes) && m.originalBytes >= 0 && typeof m.sha256 === "string" && /^[a-f0-9]{64}$/.test(m.sha256))
        return `Omitted: ${m.originalBytes} bytes, SHA-256 ${m.sha256}`;
    }
  } catch { /* Not JSON: display the original text. */ }
  if (value.length > 32768) return `${value.slice(0, 32768)}\n[Display cut: showing 32768 of ${value.length} characters]`;
  return value === "" ? "(empty)" : value;
}

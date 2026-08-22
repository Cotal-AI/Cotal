import type { AguiEvent, RecordMapper } from "@cotal-ai/connector-core";

/** One persisted Pi session entry, read by JsonlFileSource. */
export interface PiSessionRecord {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

export interface PiEventRecord {
  version: 1;
  runId: string;
  events: AguiEvent[];
}

export interface PiMapper {
  map: RecordMapper<PiSessionRecord>;
  forgetOpenRun(runId: string): void;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Pi persists an extension-owned record for every settled session observation. The record is its
 * durable source of truth: lifecycle hooks append it; this mapper only replays it into the shared
 * emitter, so a restart continues from the source cursor rather than reopening a live event stream.
 */
export function createPiMapper(): PiMapper {
  let open: string | undefined;

  return {
    map(record: PiSessionRecord) {
      if (record.type !== "custom" || record.customType !== "cotal-agui") return null;
      const data = asRecord(record.data);
      if (data?.version !== 1 || typeof data.runId !== "string" || data.runId.length === 0 || !Array.isArray(data.events))
        throw new Error("pi AG-UI record is malformed");
      const events = data.events as AguiEvent[];
      if (events.length === 0) throw new Error("pi AG-UI record carries no events");
      const types = events.map((event) => (event as { type?: unknown }).type);
      if (types.includes("RUN_STARTED")) open = data.runId;
      if (types.includes("RUN_FINISHED") || types.includes("RUN_ERROR")) {
        if (open === data.runId) open = undefined;
      }
      return { runId: data.runId, events };
    },
    forgetOpenRun(runId: string): void {
      if (open === runId) open = undefined;
    },
  };
}

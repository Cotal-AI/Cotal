import type { CotalEndpoint, Presence } from "@cotal-ai/core";
import { oneLine, renderReport, streamRecord, terminalWidth, writeStreamRecord } from "@cotal-ai/workspace";
import { feedLine, isFeedView, matchesWatchFilter, observedText, watchReport, type WatchFilter } from "./watch-data.js";
import { MeshView, type FeedEntry, type MeshSnapshot } from "./view/mesh-view.js";
import { ownStdoutErrors } from "./lib/stdout-owner.js";

const WINDOW = 300;

/** Snapshot metadata and attributed coalesced rows, never an invented complete event history. */
export async function runWatchStream(ep: CotalEndpoint, space: string, tapSubject: string | undefined, filter: WatchFilter, presentation: "json" | "plain" = "json"): Promise<void> {
  const view = new MeshView(ep, { tapSubject, window: WINDOW });
  const target = { space };
  const seen = new Map<string, string>();
  let metadata = "";
  let lastReport = "";
  let currentSnapshot: MeshSnapshot | undefined;
  let lastConnected: boolean | undefined;
  let stopped = false;
  let closed = false;
  let reason = "interrupted";
  let end: () => void = () => {};
  const ended = new Promise<void>((resolve) => { end = resolve; });
  const stop = () => { stopped = true; end(); };
  const interrupt = () => { process.exitCode = 130; stop(); };
  const terminate = () => { process.exitCode = 143; stop(); };
  const outputClosed = () => { closed = true; reason = "output-closed"; stop(); };
  const emit = (type: "snapshot" | "event" | "connection" | "gap" | "error" | "end", data: unknown) => {
    if (closed) return;
    try {
      if (presentation === "json") writeStreamRecord(streamRecord("watch", type, target, data));
      else if (type === "snapshot" && currentSnapshot && !isFeedView(filter)) {
        const report = renderReport({ ...watchReport(currentSnapshot, filter), space }, "plain", terminalWidth(process.stdout));
        if (report !== lastReport) { lastReport = report; console.log(report); }
      } else if (type === "event" && data && typeof data === "object" && "row" in data) console.log(oneLine(`[${space}] ${feedLine(data.row as FeedEntry)}`));
      else if (type === "gap" || type === "error") {
        const message = data && typeof data === "object" && ("reason" in data || "message" in data) ? String("reason" in data ? data.reason : "message" in data ? data.message : "") : "observation incomplete";
        console.error(oneLine(`[${space}] Observer ${type}: ${message}`));
      } else if (type === "end") console.error(oneLine(`[${space}] Observer ended. No agent stop request was sent.`));
    } catch { outputClosed(); }
  };
  const presence = (rows: readonly Presence[]) => rows.map((row) => ({ id: row.card.id, name: row.card.name, role: row.card.role ?? null, kind: row.card.kind, reportedStatus: row.status, activity: row.activity ?? null, heartbeatAt: row.ts }));
  const changed = (snapshot: MeshSnapshot) => {
    if (stopped) return;
    currentSnapshot = snapshot;
    const connected = snapshot.status.connected && !snapshot.status.error;
    if (connected !== lastConnected) {
      emit("connection", { connected, errorReported: Boolean(snapshot.status.error) });
      if (lastConnected !== undefined) emit("gap", { reason: "Observer connection changed; complete history across the transition is not established." });
      lastConnected = connected;
    }
    const data = {
      kind: "observation-metadata", filter,
      scope: { feedWindow: WINDOW, prefill: "bounded per-channel history plus live observations", dms: snapshot.status.dmVisible ? "visible in this observer scope" : "not observed" },
      ...(filter === "waiting" ? { waiting: presence(snapshot.signals.waiting) } : {}),
      agents: presence(snapshot.agents), endpoints: presence(snapshot.endpoints), channels: snapshot.channels, rates: snapshot.rates,
      membership: { snapshot: snapshot.membership.snapshot ?? null, readFailureReported: snapshot.membership.unreadable !== undefined },
      connection: { connected, errorReported: Boolean(snapshot.status.error), warningReported: Boolean(snapshot.status.warning) },
    };
    const currentMetadata = JSON.stringify(data);
    if (currentMetadata !== metadata) { metadata = currentMetadata; emit("snapshot", data); }
    const current = new Set(snapshot.feed.map((entry) => entry.id));
    let removed = 0;
    for (const id of seen.keys()) if (!current.has(id)) { seen.delete(id); removed++; }
    if (removed) emit("gap", { reason: "Entries left the bounded observer window. This is not confirmation of message deletion.", entriesNoLongerInWindow: removed });
    for (const entry of snapshot.feed) {
      if (!matchesWatchFilter(entry, filter)) continue;
      const { text, omittedCodeUnits } = observedText(entry.text);
      const row = { ...entry, from: { id: entry.from.id, name: entry.from.name, role: entry.from.role ?? null }, text, ...(omittedCodeUnits ? { textTruncated: true, omittedCodeUnits } : {}) };
      const serialized = JSON.stringify(row);
      if (seen.get(entry.id) === serialized) continue;
      seen.set(entry.id, serialized);
      if (omittedCodeUnits) emit("gap", { reason: "Observed text exceeds the stream's per-row text bound.", messageId: entry.id, omittedCodeUnits });
      emit("event", { kind: "observed-feed-row", row, coalesced: true });
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const releaseOutput = ownStdoutErrors(outputClosed);
  view.on("change", changed);
  try {
    if (presentation === "plain" && isFeedView(filter)) console.log(renderReport({ space, sections: [] }, "plain", terminalWidth(process.stdout)));
    await view.start();
    emit("gap", { reason: "This view has bounded prefill and retention; it is not a complete event-history export." });
    changed(view.snapshot());
    await ended;
  } catch {
    reason = "observer-failed";
    process.exitCode = 4;
    emit("error", { code: "OPERATION_PARTIAL", message: "Observer setup or observation failed. No complete snapshot or history is implied." });
  } finally {
    stopped = true;
    view.off("change", changed);
    try { await view.stop(); }
    catch { reason = "cleanup-not-confirmed"; process.exitCode = 4; emit("error", { code: "OPERATION_PARTIAL", message: "Observer cleanup was not confirmed." }); }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    emit("end", { reason });
    releaseOutput();
  }
}

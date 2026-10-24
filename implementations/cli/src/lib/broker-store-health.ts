import { join } from "node:path";
import { localProcessPath } from "@cotal-ai/workspace";
import { pidfileState } from "../commands/down.js";
import { readOwnedLogTail, readServiceLog } from "./service-process.js";
import { serviceInstances, instanceProjection } from "./service-instances.js";
import { readStackJournal, STACK_DEFINITION } from "./stack-journal.js";

/** What the running local broker's own log says about writing its JetStream store. nats-server
 *  reports a stream's write error natively only through `healthz`, which needs a system-account
 *  user, so this reads the log the broker writes on this machine: a bounded tail, and only lines
 *  tagged with the running broker's process id since its last start. A broker whose log is not on
 *  this machine is not checked. */
export type StoreWriteObservation =
  | { state: "write-failed"; pid: number; log: string; at: string; cause: string; path: string | null }
  | { state: "none-recorded"; pid: number; log: string }
  | { state: "not-checked"; reason: string };

/** The newest `Critical write error` the running broker logged since it started. */
export function brokerStoreWrite(root: string, space: string): StoreWriteObservation {
  let broker: { pid: number; read: () => { lines: string[]; path: string | null } } | undefined;
  try {
    if (readStackJournal(root)?.journal.space === space) {
      const row = serviceInstances(space).map(instanceProjection).find((item) => item.definition === STACK_DEFINITION.broker && item.observedProcess === "running");
      if (row?.pid) broker = { pid: row.pid, read: () => readServiceLog(space, row.instanceId, 20_000) };
    } else {
      const record = pidfileState(localProcessPath("nats.pid", { root, space }));
      if (record.liveness === "alive" && record.pid) broker = { pid: record.pid, read: () => readOwnedLogTail(join(root, ".cotal", "nats.log"), 20_000) };
    }
  } catch {
    return { state: "not-checked", reason: "the local broker records could not be read" };
  }
  if (!broker) return { state: "not-checked", reason: "no running broker of this space is recorded on this machine" };
  let tail: { lines: string[]; path: string | null };
  try { tail = broker.read(); }
  catch { return { state: "not-checked", reason: "the broker's log could not be read" }; }
  if (!tail.path) return { state: "not-checked", reason: "the broker's log is not recorded on this machine" };
  const tag = `[${broker.pid}] `;
  const own = tail.lines.filter((line) => line.startsWith(tag));
  const started = own.findLastIndex((line) => line.includes("[INF] Starting nats-server"));
  for (const line of own.slice(started + 1).reverse()) {
    const failed = /^\[\d+\] (\S+ \S+) \[ERR\] .*?ritical write error: (.+)$/.exec(line);
    if (!failed) continue;
    // Go reports a failed file operation as `<op> <path>: <cause>`.
    const parts = /^\S+ (\/.+): ([^:]+)$/.exec(failed[2]!);
    return { state: "write-failed", pid: broker.pid, log: tail.path, at: failed[1]!.replace(/\.\d+$/, ""), cause: parts ? parts[2]! : failed[2]!, path: parts ? parts[1]! : null };
  }
  return { state: "none-recorded", pid: broker.pid, log: tail.path };
}

import { join } from "node:path";
import { JetStreamApiError } from "@nats-io/jetstream";
import { CotalEndpoint, mintCreds, newIdentity } from "@cotal-ai/core";
import { CommandFailure, loadMeshes, localProcessPath, type MeshTarget } from "@cotal-ai/workspace";
import { pidfileState } from "../commands/down.js";
import { readOwnedLogTail, readServiceLog } from "./service-process.js";
import { serviceInstances, instanceProjection } from "./service-instances.js";
import { readStackJournal, STACK_DEFINITION } from "./stack-journal.js";

/** What the running local broker's own log says about writing its JetStream store. nats-server
 *  reports a stream's write error natively only through `healthz`, which needs a system-account
 *  user, so this reads the log the broker writes on this machine: a bounded tail, and only lines
 *  tagged with the running broker's process id since its last start. A broker whose log is not on
 *  this machine is not checked. `full` is {@link storeFull}'s reading instead. */
export type StoreWriteObservation =
  | { state: "write-failed"; pid: number; log: string; at: string; cause: string; path: string | null }
  | { state: "full"; used: number; cap: number; path: string }
  | { state: "none-recorded"; pid: number; log: string }
  | { state: "not-checked"; reason: string };

/** The store a space's broker started from `root` runs on, and its `--max-file-store` cap, as this
 *  machine records them: the stack journal's broker inputs, else the space's registration, else the
 *  default `.cotal/nats` with no cap. */
export function recordedStore(root: string, space: string): { path: string; cap?: number } {
  const stack = readStackJournal(root)?.journal;
  const recorded = stack?.space === space && stack.broker ? stack.broker : loadMeshes().find((mesh) => mesh.space === space && mesh.root === root);
  return { path: recorded?.storeDir ?? join(root, ".cotal", "nats"), ...(recorded?.maxFileStore !== undefined ? { cap: recorded.maxFileStore } : {}) };
}

/** Whether `error`, or an error that caused it, is JetStream's 10023, insufficient resources, which
 *  the broker answers to every file-store write while its store holds more than its cap. */
export function storeRefusedWrite(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) if (e instanceof JetStreamApiError && e.code === 10023) return true;
  return false;
}

/** The refusal of a manager stop on a full store. Its native stop rides a control credential whose
 *  issuance record must be stored before the credential is released (SPEC 13.15), and a store over
 *  its cap refuses that write as every other, so the stop refuses before any signal. */
export function fullStoreStopRefusal(stopping: string, store: { path: string; cap?: number } | undefined, outcome: string, target: Record<string, unknown>, remedy: string): CommandFailure {
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the broker's JetStream store${store ? ` ${store.path}` : ""} is full${store?.cap !== undefined ? ` at its --max-file-store cap of ${store.cap} bytes` : ""}, and stopping ${stopping} needs a credential whose issuance record the full store cannot take; ${outcome}`, {
    target: { ...target, ...(store ? { store: store.path, ...(store.cap !== undefined ? { cap: store.cap } : {}) } : {}) },
    native: { code: "10023" },
    remedy,
  });
}

/** One read of the bytes `target`'s space holds in its broker's file store, over an observer
 *  credential, which writes nothing. Undefined for a user-auth space, for which this machine mints
 *  no observer, and when the read fails. */
export async function readStoredBytes(target: MeshTarget, name: string): Promise<number | undefined> {
  if (target.mode === "user") return undefined;
  const id = newIdentity();
  let ep: CotalEndpoint | undefined;
  try {
    ep = new CotalEndpoint({ space: target.space, servers: target.server, tls: target.tlsRequired, creds: target.auth ? await mintCreds(target.auth, id, "observer") : undefined, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { id: id.id, name, kind: "endpoint" } });
    ep.on("error", () => {});
    ep.on("warning", () => {});
    await ep.start();
    return await ep.storedBytes();
  } catch {
    return undefined;
  } finally {
    await ep?.stop().catch(() => {});
  }
}

/** A space holding more JetStream file storage than its broker's recorded cap. nats-server refuses
 *  every write once its stored bytes exceed `max_file_store`, so nothing more is stored until room is
 *  made. Undefined when no cap is recorded, as nats-server then sizes the store from the free disk at
 *  start, or while the space is under its cap. */
export function storeFull(root: string, space: string, used: number): Extract<StoreWriteObservation, { state: "full" }> | undefined {
  let store: ReturnType<typeof recordedStore>;
  try { store = recordedStore(root, space); } catch { return undefined; }
  return store.cap !== undefined && used > store.cap ? { state: "full", used, cap: store.cap, path: store.path } : undefined;
}

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

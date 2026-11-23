import { join } from "node:path";
import { jetstreamManager, type MsgRequest } from "@nats-io/jetstream";
import {
  admissionBucket, isStreamNotFound, parseRunJournalRecord, spacePrefix, validateBackupStreamState,
  validateCanonicalBackupStreamConfig, validateSpaceBackupInventory, wfjStreamName, type SpaceAuth,
} from "@cotal-ai/core";
import type { AttemptOwnedPath, MaintenanceAuthMode, ProcessOwner, RolledBackRun } from "@cotal-ai/workspace";
import { connectIsolatedBroker, createAttemptClone, ensurePrivateAttemptsDir, startIsolatedBroker, type IsolatedBroker } from "./isolated-broker.js";

/** The most runs a restore's launch lists; it counts the rest. */
const MAX_LISTED_RUNS = 50;
/** The most reopened steps it lists for one run. */
const MAX_LISTED_STEPS = 20;

/** One run's step journal as a store holds it: its row count and the last state of each step. */
export interface RunJournalView {
  readonly rows: number;
  readonly steps: ReadonlyMap<string, string>;
}

/** Every run's step journal on an isolated broker, read through the read-only WFJ journal login. A
 *  store with no WFJ stream holds no run. */
export async function readRunJournals(broker: IsolatedBroker, space: string): Promise<Map<string, RunJournalView>> {
  const login = await broker.addLogin({ profile: "restore", scope: { operation: "journal" } });
  const nc = await connectIsolatedBroker(broker, login);
  const runs = new Map<string, RunJournalView>();
  try {
    const jsm = await jetstreamManager(nc, { checkAPI: false });
    const stream = wfjStreamName(space), prefix = `${spacePrefix(space)}.wfj.`;
    let subjects: Record<string, number>;
    try { subjects = (await jsm.streams.info(stream, { subjects_filter: `${prefix}*` })).state.subjects ?? {}; }
    catch (error) { if (isStreamNotFound(error)) return runs; throw error; }
    for (const subject of Object.keys(subjects)) {
      const steps = new Map<string, string>();
      let rows = 0;
      // Leader reads in sequence order: WFJ serves no direct get, and this broker is a private one.
      for (let seq = 1; ;) {
        const message = await jsm.streams.getMessage(stream, { seq, next_by_subj: subject } as unknown as MsgRequest);
        if (!message) break;
        const record = parseRunJournalRecord(message.json(), subject);
        rows += 1;
        if (record.kind === "step") {
          const entry = record.entry as { scope?: unknown; kind?: unknown; name?: unknown; occurrence?: unknown; state?: unknown };
          if (typeof entry.scope === "string" && typeof entry.kind === "string" && typeof entry.name === "string" && typeof entry.occurrence === "number" && typeof entry.state === "string")
            steps.set(`${entry.scope}/${entry.name === "" ? entry.kind : `${entry.kind}:${entry.name}`}#${entry.occurrence}`, entry.state);
        }
        seq = message.seq + 1;
      }
      runs.set(subject.slice(prefix.length), { rows, steps });
    }
  } finally {
    await nc.close();
  }
  return runs;
}

/** The runs a restore rolled back: each one the previous store's journal holds further than the
 *  restored one, with the steps settled there that are open again. A run the restored store does not
 *  hold started after the artifact. */
export function rolledBackRuns(previous: ReadonlyMap<string, RunJournalView>, restored: ReadonlyMap<string, RunJournalView>): { runs: RolledBackRun[]; more: number } {
  const all: RolledBackRun[] = [];
  for (const [run, before] of previous) {
    const after = restored.get(run);
    if (after && after.rows >= before.rows) continue;
    const reopened = after ? [...before.steps].filter(([key, state]) => state === "settled" && after.steps.get(key) === "pending").map(([key]) => key) : [];
    all.push({ run, reopened: reopened.slice(0, MAX_LISTED_STEPS), ...(after ? {} : { missing: true as const }) });
  }
  return { runs: all.slice(0, MAX_LISTED_RUNS), more: Math.max(0, all.length - MAX_LISTED_RUNS) };
}

async function previousHistoryIsEmpty(broker: IsolatedBroker, space: string): Promise<boolean> {
  try {
    const nc = await connectIsolatedBroker(broker, broker.initialLogin);
    try {
      const jsm = await jetstreamManager(nc, { checkAPI: false });
      const names: string[] = [];
      for await (const name of jsm.streams.names()) names.push(name);
      const { backedUp } = validateSpaceBackupInventory(space, names, { atRest: true });
      // The records KV also holds control records. Run evidence is in the journal and admission streams.
      const journal = wfjStreamName(space), admissions = `KV_${admissionBucket(space)}`;
      const history = backedUp.filter((stream) => stream.class === "messages" || stream.name === journal || stream.name === admissions);
      for (const { name } of history) {
        const { config, state } = await jsm.streams.info(name);
        validateCanonicalBackupStreamConfig(space, name, config as unknown as Readonly<Record<string, unknown>>);
        const stored = validateBackupStreamState(state as unknown as Readonly<Record<string, unknown>>);
        // A clone can expire messages at startup. Zero messages is only proof if no sequence was assigned.
        if (stored.messages !== 0 || stored.bytes !== 0 || stored.last_seq !== 0 || stored.lost) return false;
      }
      return true;
    } finally {
      await nc.close();
    }
  } catch {
    // An incomplete read does not authorize deleting the original store without consent.
    return false;
  }
}

/** Inspect the store a restore set aside from a private clone, never the original. Record the clone
 *  and its broker so an interrupted restore leaves them to recovery. */
export async function inspectPreviousHistory(options: {
  root: string;
  previousStore: string;
  attemptId: string;
  space: string;
  mode: MaintenanceAuthMode;
  auth?: SpaceAuth;
  deadline: Date;
  record: (input: { owners?: readonly ProcessOwner[]; ownedPaths?: readonly AttemptOwnedPath[] }) => void;
}): Promise<{ empty: true } | { empty: false; runs: Map<string, RunJournalView> }> {
  options.record({ ownedPaths: [{ label: "clone", path: join(ensurePrivateAttemptsDir(options.root).path, `${options.attemptId}-clone`) }] });
  const clone = createAttemptClone(options.root, options.previousStore, options.attemptId);
  options.record({ ownedPaths: [{ label: "clone", path: clone.path, dev: clone.identity.dev.toString(), ino: clone.identity.ino.toString() }] });
  let broker: IsolatedBroker | undefined;
  try {
    broker = await startIsolatedBroker({
      root: options.root,
      storeDir: clone.path,
      space: options.space,
      mode: options.mode,
      ...(options.auth ? { auth: options.auth } : {}),
      deadline: options.deadline,
      label: "previous",
      initialScope: { profile: "backup", scope: { operation: "inspect", selection: "full" } },
      attemptId: options.attemptId,
    });
    options.record({ owners: [broker.brokerOwner, broker.watchdogOwner], ownedPaths: broker.runFiles.map((file) => ({ label: "config" as const, ...file })) });
    if (await previousHistoryIsEmpty(broker, options.space)) return { empty: true };
    return { empty: false, runs: await readRunJournals(broker, options.space) };
  } finally {
    if (broker) await broker.stop();
    clone.cleanup();
  }
}

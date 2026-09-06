import { createHash } from "node:crypto";
import { Journal, digest, journalEntryKeyString, stepKeyString, type EffectContext, type JournalEntry } from "@cotal-ai/lang";
import { replayRunJournal, type RunHostPlanes, type RunHostLease, type RunJournalActivation } from "@cotal-ai/core";

interface RunScopeSnapshot {
  readonly entries: readonly JournalEntry[];
  readonly activation: RunJournalActivation | undefined;
}

/** The reader and its replay durable are host-bound. No request selects another run. */
export function createRunScopeAuthority(
  broker: RunHostPlanes,
  runId: string,
  lease: RunHostLease,
): RunScopeAuthority {
  const pinned = structuredClone(lease);
  return new RunScopeAuthority(runId, async () => {
    const replay = await replayRunJournal(broker.js, broker.jsm, broker.space, runId, pinned.takeoverId);
    const last = replay.records.findLast(({ record }) => record.kind === "activation")?.record;
    return {
      entries: replay.records.flatMap(({ record }) => record.kind === "step" ? [record.entry as JournalEntry] : []),
      activation: last?.kind === "activation" ? last : undefined,
    };
  }, pinned);
}

export type PauseOperation = "read" | "mint" | "attach" | "rearm" | "heartbeat" | "claim" | "fire";
export type WaitOperation = "open" | "fetch" | "ack" | "close";

export class RunScopeDenied extends Error {
  constructor(runId: string, resource: string, operation: string) {
    super(`run ${runId} has no current journal authority to ${operation} ${resource}`);
    this.name = "RunScopeDenied";
  }
}

/** The caller supplies a reader already bound to one run's broker journal. Requests cannot
 *  replace that reader or provide their own entries. Each decision uses a fresh folded snapshot. */
export class RunScopeAuthority {
  private reading: Promise<void> = Promise.resolve();

  constructor(
    private readonly runId: string,
    private readonly readJournal: () => Promise<RunScopeSnapshot>,
    private readonly attempt: Pick<RunHostLease, "holder" | "epoch" | "fencingToken">,
  ) {}

  private async entries(): Promise<readonly JournalEntry[]> {
    const reading = this.reading.then(() => this.readJournal());
    this.reading = reading.then(() => undefined, () => undefined);
    const snapshot = await reading;
    const active = snapshot.activation;
    if (active === undefined || active.run !== this.runId || active.holder !== this.attempt.holder
      || active.epoch !== this.attempt.epoch || active.fencingToken !== this.attempt.fencingToken)
      throw new RunScopeDenied(this.runId, "drive attempt", "use superseded host");
    const entries = new Journal({ run: this.runId, entries: snapshot.entries }).entries();
    for (const entry of entries) {
      if (entry.requestId === undefined) continue;
      const attempt = entry.attempt ?? 0;
      if (!Number.isSafeInteger(attempt) || attempt < 0) throw new RunScopeDenied(this.runId, journalEntryKeyString(entry), "load");
      // Independently check the recorded id against the language's canonical digest. A driver
      // can append to its own journal; copying another run's token there must confer no authority.
      const hash = digest([this.runId, journalEntryKeyString(entry), entry.inputHash, attempt]);
      const expected = Buffer.from(hash.slice("sha256:".length), "hex").toString("base64url");
      if (entry.requestId !== expected) throw new RunScopeDenied(this.runId, entry.requestId, "load");
    }
    return entries;
  }

  async journal(): Promise<readonly JournalEntry[]> {
    return this.entries();
  }

  async effect(kind: string, ctx: Pick<EffectContext, "key" | "requestId" | "attempt">): Promise<JournalEntry> {
    const entries = await this.entries();
    const entry = entries.find((candidate) => journalEntryKeyString(candidate) === stepKeyString(ctx.key));
    if (entry === undefined || entry.kind !== kind || entry.requestId !== ctx.requestId
      || (entry.attempt ?? 0) !== ctx.attempt || entry.state !== "pending"
      || this.cleanup(entries).has(journalEntryKeyString(entry)))
      throw new RunScopeDenied(this.runId, ctx.requestId, `perform ${kind}`);
    return entry;
  }

  private cleanup(entries: readonly JournalEntry[]): Set<string> {
    const owed = new Set<string>();
    for (const parent of entries) {
      if (parent.state !== "settled" || parent.cancel === undefined || parent.cancel.issued) continue;
      const prefixes = parent.cancel.losers.map((branch) => `${journalEntryKeyString(parent)}/b:${branch}/`);
      for (const entry of entries) {
        const key = journalEntryKeyString(entry);
        if (prefixes.some((prefix) => key.startsWith(prefix))) owed.add(key);
      }
    }
    return owed;
  }

  /** Cleanup authority comes from the settled parent scope. A settled child alone carries none. */
  async cleanupEntries(): Promise<readonly JournalEntry[]> {
    const entries = await this.entries();
    const owed = this.cleanup(entries);
    return entries.filter((entry) => owed.has(journalEntryKeyString(entry)));
  }

  async pause(token: string, operation: PauseOperation): Promise<JournalEntry> {
    const entries = await this.entries();
    const entry = entries.find((candidate) => pauseTokens(candidate).includes(token));
    if (entry !== undefined) {
      if (entry.kind === "wait" && (operation === "mint" || operation === "heartbeat")) {
        const timers = entry.external?.waitTimers;
        if (!Array.isArray(timers) || !timers.includes(token))
          throw new RunScopeDenied(this.runId, token, `${operation} unrecorded wait timer`);
      }
      if (operation === "read") return entry;
      const cleaning = this.cleanup(entries).has(journalEntryKeyString(entry));
      if (operation === "claim" && cleaning) return entry;
      if (entry.state === "pending" && !cleaning) return entry;
    }
    throw new RunScopeDenied(this.runId, token, operation);
  }

  async wait(requestId: string, operation: WaitOperation): Promise<JournalEntry> {
    const entries = await this.entries();
    const entry = entries.find((candidate) => candidate.kind === "wait" && candidate.requestId === requestId);
    if (entry !== undefined) {
      const cleaning = this.cleanup(entries).has(journalEntryKeyString(entry));
      if (operation === "close" && cleaning) return entry;
      if (entry.state === "pending" && !cleaning) return entry;
    }
    throw new RunScopeDenied(this.runId, requestId, operation);
  }

  async matchedMessage(requestId: string, sequence: number): Promise<JournalEntry> {
    const entry = (await this.entries()).find((candidate) => candidate.kind === "wait" && candidate.requestId === requestId);
    if (!Number.isSafeInteger(sequence) || sequence <= 0 || entry?.external?.chatSeq !== sequence)
      throw new RunScopeDenied(this.runId, `${requestId}/${sequence}`, "read message");
    return entry;
  }

  /** The driver cannot add tokens to the adoption sweep. Plane status still decides whether
   *  a derived wait timer exists and needs rearming. This list never authorizes its first mint. */
  async rearmTokens(): Promise<readonly string[]> {
    const entries = await this.entries();
    const owed = this.cleanup(entries);
    return entries.filter((entry) => entry.state === "pending" && !owed.has(journalEntryKeyString(entry))).flatMap(pauseTokens);
  }
}

/** Identities a step can own. An ask's old attempt drops out as soon as the next bind lands. */
function pauseTokens(entry: JournalEntry): string[] {
  const id = entry.requestId;
  if (id === undefined) return [];
  if (entry.kind === "sleep" || entry.kind === "checkpoint" || entry.kind === "turn") return [id];
  if (entry.kind === "wait") return [id, derive(id, "wait-timeout")];
  if (entry.kind !== "ask") return [];
  const attempt = entry.external?.attempt ?? 1;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) return [];
  const expected = attempt === 1 ? id : derive(id, `ask-attempt-${attempt}`);
  if (entry.external?.askToken !== undefined && entry.external.askToken !== expected) return [];
  return [expected];
}

function derive(requestId: string, purpose: string): string {
  return createHash("sha256").update(`${requestId}:${purpose}`, "utf8").digest("base64url");
}

/** A receipt's identity is held in a WeakMap. Serializing, copying or inventing a receipt
 *  does not copy the delivery it authorizes. The host never exposes its ACK subject. */
export interface WaitReceipt { readonly _brand: "WaitReceipt" }

export class WaitReceipts {
  private readonly deliveries = new WeakMap<WaitReceipt, { requestId: string; ack: () => void | Promise<void> }>();
  private readonly byWait = new Map<string, Set<WaitReceipt>>();

  issue(requestId: string, ack: () => void | Promise<void>): WaitReceipt {
    const receipt: WaitReceipt = Object.freeze({ _brand: "WaitReceipt" });
    this.deliveries.set(receipt, { requestId, ack });
    const held = this.byWait.get(requestId) ?? new Set<WaitReceipt>();
    held.add(receipt);
    this.byWait.set(requestId, held);
    return receipt;
  }

  async ack(requestId: string, receipt: WaitReceipt): Promise<void> {
    const delivery = this.deliveries.get(receipt);
    if (delivery === undefined || delivery.requestId !== requestId)
      throw new Error(`wait ${requestId} has no live delivery for this receipt`);
    this.deliveries.delete(receipt);
    const held = this.byWait.get(requestId)!;
    held.delete(receipt);
    if (held.size === 0) this.byWait.delete(requestId);
    await delivery.ack();
  }

  close(requestId: string): void {
    const held = this.byWait.get(requestId);
    if (held === undefined) return;
    for (const receipt of held) this.deliveries.delete(receipt);
    this.byWait.delete(requestId);
  }
}

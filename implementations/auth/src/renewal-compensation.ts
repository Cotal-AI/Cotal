import type { KV } from "@nats-io/kv";
import {
  EpEnvelopeError,
  assertLifecycleToken,
  epcredRowKey,
  parseLedgerRow,
  type EpIssuanceGate,
  type EpServeLedgerRow,
} from "@cotal-ai/core";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ROLES = ["serve", "goalWriter", "sessionLedger"] as const;
export type RenewalLedgerRole = typeof ROLES[number];

type AtomicEpIssuanceGate = EpIssuanceGate & {
  stageOwned: (row: EpServeLedgerRow) => Promise<"created" | "reused"> | "created" | "reused";
};

interface RenewalCleanupParticipant {
  role: RenewalLedgerRole;
  ownership: "unresolved" | "created" | "reused";
  state: "prepared" | "finalized";
  row: EpServeLedgerRow;
}

interface RenewalCleanupIntent {
  v: 1;
  kind: "manager-renewal-cleanup";
  requestId: string;
  state: "pending" | "complete";
  participants: RenewalCleanupParticipant[];
}

interface LoadedIntent {
  revision: number;
  intent: RenewalCleanupIntent;
}

export type RenewalCleanupFault = (point: "after-serve-finalize" | "after-goal-finalize" | "after-session-finalize" | "before-response" | "revoke", role?: RenewalLedgerRole) => void | Promise<void>;

function intentKey(instanceId: string): string {
  return `renewclean.manager.${instanceId}`;
}

function parseIntent(raw: Uint8Array, key: string): RenewalCleanupIntent {
  const instanceId = key.slice("renewclean.manager.".length);
  if (!instanceId || key !== intentKey(instanceId))
    throw new EpEnvelopeError("internal", "manager renewal cleanup intent is stored under a malformed key");
  let value: unknown;
  try { value = JSON.parse(dec.decode(raw)); }
  catch { throw new EpEnvelopeError("internal", "manager renewal cleanup intent is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EpEnvelopeError("internal", "manager renewal cleanup intent is not an object");
  const o = value as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "kind,participants,requestId,state,v" || o.v !== 1 || o.kind !== "manager-renewal-cleanup" ||
      typeof o.requestId !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(o.requestId) ||
      (o.state !== "pending" && o.state !== "complete") || !Array.isArray(o.participants))
    throw new EpEnvelopeError("internal", "manager renewal cleanup intent does not validate");
  const seen = new Set<string>();
  const participants = o.participants.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new EpEnvelopeError("internal", "manager renewal cleanup intent carries an invalid participant");
    const p = value as Record<string, unknown>;
    if (Object.keys(p).sort().join(",") !== "ownership,role,row,state" || !ROLES.includes(p.role as RenewalLedgerRole) ||
        (p.ownership !== "unresolved" && p.ownership !== "created" && p.ownership !== "reused") ||
        (p.ownership === "unresolved" && p.state !== "prepared") ||
        (p.state !== "prepared" && p.state !== "finalized") || !p.row || typeof p.row !== "object" || Array.isArray(p.row))
      throw new EpEnvelopeError("internal", "manager renewal cleanup intent carries an invalid participant");
    const role = p.role as RenewalLedgerRole;
    if (seen.has(role)) throw new EpEnvelopeError("internal", `manager renewal cleanup intent repeats role ${role}`);
    seen.add(role);
    const row = p.row as EpServeLedgerRow;
    const expectedFields = ["credentialId", "credentialKey", "endpoint", "generation", "holderPrincipal", "lifecycleUid", "nameAuthorityRevision", "processEpoch", "registrationRevision", "sourceChain", "state", ...(Object.hasOwn(row, "exp") ? ["exp"] : [])].sort().join(",");
    if (Object.keys(row as object).sort().join(",") !== expectedFields || typeof row.credentialId !== "string" || row.credentialId.length === 0 ||
        typeof row.credentialKey !== "string" || row.credentialKey.length === 0 || typeof row.holderPrincipal !== "string" || row.holderPrincipal.length === 0 ||
        row.endpoint !== "manager" || row.lifecycleUid !== instanceId || row.state !== "active" || !Array.isArray(row.sourceChain) || row.sourceChain.length === 0 ||
        ![row.generation, row.processEpoch, row.registrationRevision, row.nameAuthorityRevision].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        (row.exp !== undefined && (!Number.isSafeInteger(row.exp) || row.exp < 0)))
      throw new EpEnvelopeError("internal", `manager renewal cleanup intent carries an invalid ${role} row`);
    return { role, ownership: p.ownership as "unresolved" | "created" | "reused", state: p.state as "prepared" | "finalized", row };
  });
  return { v: 1, kind: "manager-renewal-cleanup", requestId: o.requestId, state: o.state, participants };
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

function primaryWithCleanupDebt(primary: unknown, failedRoles: RenewalLedgerRole[]): EpEnvelopeError {
  const roles = [...new Set(failedRoles)].sort();
  const suffix = `ALSO renewal compensation revoke failed for ${roles.length} role${roles.length === 1 ? "" : "s"} (${roles.join(", ")}); the rows need barrier reconciliation`;
  if (primary instanceof EpEnvelopeError)
    return new EpEnvelopeError(primary.code, `${primary.message}; ${suffix}`, primary.details, primary.outcome);
  return new EpEnvelopeError("unavailable", `${errorMessage(primary)}; ${suffix}`);
}

/** Durable, per-instance compensation for the three endpoint-family rows finalized by one renewal.
 * The intent records whether this request atomically created each row or reused an identical prior
 * row. An interrupted ownership checkpoint remains unresolved and cleanup conserves that row for
 * explicit reconciliation. It never contains JWTs, seeds, or credential files. */
export class ManagerRenewalCompensation {
  private readonly key: string;
  private readonly volatileOwnership = new Map<RenewalLedgerRole, "created" | "reused">();
  private current?: LoadedIntent;

  constructor(
    private readonly kv: KV,
    private readonly gate: AtomicEpIssuanceGate,
    instanceId: string,
    private readonly requestId: string,
    private readonly fault?: RenewalCleanupFault,
  ) {
    this.key = intentKey(assertLifecycleToken(instanceId, "manager renewal cleanup instanceId"));
  }

  private async load(): Promise<LoadedIntent | undefined> {
    const entry = await this.kv.get(this.key);
    if (!entry) return undefined;
    if (entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `manager renewal cleanup intent ${this.key} carries a ${entry.operation} marker; cleanup intents are never deleted`);
    return { revision: entry.revision, intent: parseIntent(entry.value, this.key) };
  }

  private async write(intent: RenewalCleanupIntent, revision: number | undefined): Promise<LoadedIntent> {
    const bytes = enc.encode(JSON.stringify(intent));
    const next = revision === undefined ? await this.kv.create(this.key, bytes) : await this.kv.update(this.key, bytes, revision);
    return { revision: next, intent };
  }

  private async cleanup(loaded: LoadedIntent): Promise<RenewalLedgerRole[]> {
    const observed = await this.gate.observe();
    if (!observed || observed.endpoint !== "manager" || intentKey(observed.lifecycleUid) !== this.key)
      throw new EpEnvelopeError("failed-precondition", "manager renewal cleanup intent is not bound to the current manager instance gate");
    const participants = [...loaded.intent.participants].filter((participant) =>
      (participant.ownership === "unresolved" ? this.volatileOwnership.get(participant.role) : participant.ownership) !== "reused",
    ).reverse();
    if (participants.some(({ row }) => row.generation !== observed.generation || row.processEpoch !== observed.processEpoch ||
        row.registrationRevision !== observed.registrationRevision || row.nameAuthorityRevision !== observed.nameAuthorityRevision))
      throw new EpEnvelopeError("failed-precondition", "manager renewal cleanup intent names a superseded gate generation; cleanup requires barrier reconciliation");
    const settled = await Promise.allSettled(participants.map(async ({ role, ownership: durableOwnership, row }) => {
      const ownership = durableOwnership === "unresolved" ? this.volatileOwnership.get(role) : durableOwnership;
      if (ownership === undefined)
        throw new EpEnvelopeError("failed-precondition", `manager renewal ${role} cleanup ownership is unresolved; reconciliation must conserve the ledger row`);
      const key = epcredRowKey(row.endpoint, row.lifecycleUid, row.credentialId);
      const ledger = await this.kv.get(key);
      if (!ledger)
        throw new EpEnvelopeError("failed-precondition", `manager renewal ${role} cleanup found no atomically created ledger row; reconciliation remains required`);
      if (ledger.operation !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `manager renewal ${role} cleanup found a ${ledger.operation} ledger marker; rows are never deleted`);
      const stored = parseLedgerRow(ledger.value, key);
      if (stored.credentialId !== row.credentialId || stored.holderPrincipal !== row.holderPrincipal || stored.lifecycleUid !== row.lifecycleUid ||
          stored.endpoint !== row.endpoint || stored.exp !== row.exp || JSON.stringify(stored.sourceChain) !== JSON.stringify(row.sourceChain))
        throw new EpEnvelopeError("failed-precondition", `manager renewal ${role} cleanup row does not match its durable ledger entry; reconciliation remains required`);
      await this.fault?.("revoke", role);
      await this.gate.revoke(row);
    }));
    return settled.flatMap((result, index) => result.status === "rejected" ? [participants[index]!.role] : []);
  }

  async begin(): Promise<void> {
    let loaded = await this.load();
    if (loaded?.intent.state === "pending") {
      const failed = await this.cleanup(loaded);
      if (failed.length > 0)
        throw primaryWithCleanupDebt(new EpEnvelopeError("failed-precondition", "a prior manager renewal has unresolved cleanup debt; refusing to mint another generation"), failed);
      loaded = await this.write({ ...loaded.intent, state: "complete" }, loaded.revision);
      this.volatileOwnership.clear();
    }
    const intent: RenewalCleanupIntent = { v: 1, kind: "manager-renewal-cleanup", requestId: this.requestId, state: "pending", participants: [] };
    try {
      this.current = await this.write(intent, loaded?.revision);
    } catch (error) {
      throw new EpEnvelopeError("unavailable", `persisting manager renewal cleanup intent failed before any endpoint credential was finalized: ${errorMessage(error)}`);
    }
  }

  wrap(role: RenewalLedgerRole): EpIssuanceGate {
    let staged: EpServeLedgerRow | undefined;
    let stagedOwnership: RenewalCleanupParticipant["ownership"] | undefined;
    return {
      observe: () => this.gate.observe(),
      stage: async (row) => {
        const current = this.current;
        if (!current || current.intent.state !== "pending" || current.intent.requestId !== this.requestId)
          throw new EpEnvelopeError("failed-precondition", "manager renewal cleanup intent is not pending for this request");
        const existing = current.intent.participants.find((participant) => participant.role === role);
        if (existing && existing.row.credentialId !== row.credentialId)
          throw new EpEnvelopeError("conflict", `manager renewal cleanup intent already binds role ${role} to another row`);
        if (!existing) {
          try {
            this.current = await this.write({ ...current.intent, participants: [...current.intent.participants, { role, ownership: "unresolved", state: "prepared", row }] }, current.revision);
          } catch (error) {
            throw new EpEnvelopeError("unavailable", `persisting manager renewal ${role} cleanup metadata failed before the row was staged: ${errorMessage(error)}`);
          }
        }
        let ownership: "created" | "reused";
        try {
          ownership = await this.gate.stageOwned(row);
        } catch (error) {
          // Production stage errors other than `unavailable` are definitive pre-create refusals or
          // byte conflicts. Remove their unresolved marker. An unavailable create is ambiguous and
          // must keep the marker so recovery conserves a row that may have landed.
          if (error instanceof EpEnvelopeError && error.code !== "unavailable") {
            const unresolved = this.current;
            if (!unresolved) throw error;
            try {
              this.current = await this.write({
                ...unresolved.intent,
                participants: unresolved.intent.participants.filter((participant) => participant.role !== role),
              }, unresolved.revision);
            } catch (cleanupError) {
              throw new EpEnvelopeError("unavailable", `${errorMessage(error)}; ALSO clearing the un-staged manager renewal ${role} marker failed, so reconciliation must conserve the row: ${errorMessage(cleanupError)}`);
            }
          }
          throw error;
        }
        if (existing?.ownership === "created") ownership = "created";
        if (existing?.ownership === "reused") ownership = "reused";
        if (existing?.ownership === "unresolved") ownership = this.volatileOwnership.get(role) ?? ownership;
        this.volatileOwnership.set(role, ownership);
        staged = row;
        stagedOwnership = ownership;
        const prepared = this.current;
        if (!prepared) throw new EpEnvelopeError("failed-precondition", "manager renewal cleanup intent vanished during row staging");
        try {
          this.current = await this.write({
            ...prepared.intent,
            participants: prepared.intent.participants.map((participant) => participant.role === role ? { ...participant, ownership } : participant),
          }, prepared.revision);
        } catch (error) {
          throw new EpEnvelopeError("unavailable", `manager renewal ${role} row was staged but its atomic ownership checkpoint could not be persisted; reconciliation must conserve the row: ${errorMessage(error)}`);
        }
      },
      commit: async (revision) => {
        const won = await this.gate.commit(revision);
        if (won && staged) {
          const current = this.current;
          if (!current) throw new EpEnvelopeError("failed-precondition", "manager renewal cleanup intent vanished during finalization");
          try {
            this.current = await this.write({
              ...current.intent,
              participants: current.intent.participants.map((participant) => participant.role === role ? { ...participant, state: "finalized" as const } : participant),
            }, current.revision);
          } catch (error) {
            throw new EpEnvelopeError("unavailable", `manager renewal ${role} finalized but its cleanup checkpoint could not be persisted; renewal stops loud for reconciliation: ${errorMessage(error)}`);
          }
        }
        return won;
      },
      // The core finalizers call this on a lost gate CAS before outer compensation runs. A byte-
      // identical reused row still belongs to the prior issuance and must remain untouched here too.
      revoke: (row) => stagedOwnership === "created" ? this.gate.revoke(row) : undefined,
    };
  }

  async checkpoint(point: "after-serve-finalize" | "after-goal-finalize" | "after-session-finalize"): Promise<void> {
    await this.fault?.(point);
  }

  async beforeResponse(): Promise<void> {
    await this.fault?.("before-response");
  }

  async complete(): Promise<void> {
    const current = await this.load();
    if (!current || current.intent.requestId !== this.requestId || current.intent.state !== "pending")
      throw new EpEnvelopeError("failed-precondition", "manager renewal cleanup intent cannot complete because this request no longer owns it");
    if (current.intent.participants.length !== ROLES.length || current.intent.participants.some((participant) => participant.state !== "finalized" || participant.ownership === "unresolved"))
      throw new EpEnvelopeError("failed-precondition", "manager renewal cleanup intent cannot complete before serve, goalWriter, and sessionLedger are finalized");
    this.current = await this.write({ ...current.intent, state: "complete" }, current.revision);
  }

  async compensate(primary: unknown): Promise<never> {
    const current = await this.load();
    if (!current || current.intent.requestId !== this.requestId || current.intent.state !== "pending") throw primary;
    const failed = await this.cleanup(current);
    if (failed.length > 0) throw primaryWithCleanupDebt(primary, failed);
    const latest = await this.load();
    if (!latest || latest.intent.requestId !== this.requestId || latest.intent.state !== "pending") throw primary;
    try {
      this.current = await this.write({ ...latest.intent, state: "complete" }, latest.revision);
      this.volatileOwnership.clear();
    } catch (error) {
      const suffix = `ALSO renewal compensation revoked every finalized role but clearing its durable cleanup intent failed; the request stays blocked for reconciliation: ${errorMessage(error)}`;
      if (primary instanceof EpEnvelopeError)
        throw new EpEnvelopeError(primary.code, `${primary.message}; ${suffix}`, primary.details, primary.outcome);
      throw new EpEnvelopeError("unavailable", `${errorMessage(primary)}; ${suffix}`);
    }
    throw primary;
  }
}

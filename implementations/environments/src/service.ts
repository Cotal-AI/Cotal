import { createHash } from "node:crypto";
import {
  contractDigest, EpEnvelopeError,
  type EpCaller, type EnvironmentObservation, type EnvironmentProvisionDriver,
  type EnvironmentProvisionProfile, type HostedEnvironmentReference,
} from "@cotal-ai/core";

export interface EnvironmentRecord {
  v: 1;
  id: string;
  caller: EpCaller;
  profile: string;
  profileDigest: string;
  provider: string;
  createdAt: number;
  expiresAt: number;
  environment?: HostedEnvironmentReference;
  destroyRequested: boolean;
  /** Durable host receipt: results retained and workload authority retired before provider close. */
  retirementReceipt?: string;
  terminatedAt?: number;
}

export interface EnvironmentStore {
  get(id: string): Promise<{ record: EnvironmentRecord; revision: number } | undefined>;
  /** Expected revision zero is a first-wins reservation; never resurrect a deleted row. */
  put(record: EnvironmentRecord, expectedRevision: number): Promise<boolean>;
  records(): AsyncIterable<EnvironmentRecord>;
}

export interface EnvironmentView {
  record: EnvironmentRecord;
  observation?: EnvironmentObservation;
  problem?: "create-unconfirmed" | "observation-unavailable";
}

export interface EnvironmentHost {
  /** Checked for each new request. The caller comes from the authenticated request subject. */
  authorize(caller: EpCaller, profile: EnvironmentProvisionProfile): Promise<boolean>;
  /** Idempotent by record.id, including after crashes. Retain results and revoke/retire workload
   * authority before returning an opaque, non-secret durable receipt. Failure blocks destruction. */
  retainAndRetire(record: Readonly<EnvironmentRecord>): Promise<string>;
}

const digestId = (value: unknown): string => createHash("sha256").update(contractDigest(value)).digest("hex");
const sameCaller = (a: EpCaller, b: EpCaller): boolean => a.owner === b.owner && a.actor === b.actor && a.uid === b.uid;
function refuse(code: "bad-request" | "not-found" | "conflict" | "permission-denied", message: string): never {
  throw new EpEnvelopeError(code, message, undefined, "not-executed");
}

/** Infrastructure lifecycle service. It never launches harnesses, issues credentials or reports
 * agent readiness. A reservation with no provider ID is held across restarts, never re-created. */
export class EnvironmentService {
  readonly #profiles = new Map<string, EnvironmentProvisionProfile>();
  readonly #drivers = new Map<string, EnvironmentProvisionDriver>();
  constructor(
    private readonly store: EnvironmentStore,
    profiles: readonly EnvironmentProvisionProfile[],
    drivers: readonly EnvironmentProvisionDriver[],
    private readonly host: EnvironmentHost,
  ) {
    for (const driver of drivers) {
      if (this.#drivers.has(driver.name)) throw new Error("duplicate environment provider");
      this.#drivers.set(driver.name, driver);
    }
    for (const value of profiles) {
      const profile = structuredClone(value);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile.name) || this.#profiles.has(profile.name)) throw new Error("invalid or duplicate environment profile");
      if (!Number.isSafeInteger(profile.maxDurationMs) || profile.maxDurationMs <= 0 || profile.maxDurationMs > 86_400_000)
        throw new Error("environment duration must be positive and at most one day");
      const driver = this.#drivers.get(profile.provider);
      if (!driver) throw new Error("environment profile provider is not installed");
      driver.validate(profile);
      contractDigest(profile);
      this.#profiles.set(profile.name, profile);
    }
  }

  async create(caller: EpCaller, args: { operationId: string; profile: string; profileDigest: string }): Promise<EnvironmentView> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(args.operationId)) refuse("bad-request", "operationId must be a stable 16-64 character identifier");
    const profile = this.#profiles.get(args.profile);
    if (!profile || !await this.host.authorize(structuredClone(caller), structuredClone(profile))) refuse("permission-denied", "environment profile is not authorized");
    const pin = contractDigest(profile);
    if (pin !== args.profileDigest) refuse("conflict", "environment profile digest changed");
    const id = digestId({ caller, operationId: args.operationId });
    const existing = await this.store.get(id);
    if (existing) return this.#repeat(existing.record, caller, profile.name, pin);
    const now = Date.now();
    const record: EnvironmentRecord = {
      v: 1, id, caller: structuredClone(caller), profile: profile.name, profileDigest: pin,
      provider: profile.provider, createdAt: now, expiresAt: now + profile.maxDurationMs, destroyRequested: false,
    };
    // Commit the attempt before touching the provider. Even a crash before create keeps this held.
    if (!await this.store.put(record, 0)) {
      const winner = await this.store.get(id);
      if (!winner) throw new Error("environment reservation disappeared");
      return this.#repeat(winner.record, caller, profile.name, pin);
    }
    let environment: HostedEnvironmentReference;
    try { environment = await this.#driver(record).create(structuredClone(profile), id); }
    catch { return { record, problem: "create-unconfirmed" }; }
    if (environment.kind !== record.provider || typeof environment.id !== "string" || !environment.id || environment.id.length > 256)
      throw new Error("provider returned an invalid environment reference; create outcome is unknown");
    try {
      const bound = await this.#change(id, (r) => {
        if (r.environment && contractDigest(r.environment) !== contractDigest(environment)) throw new Error("environment binding conflict");
        return { ...r, environment };
      });
      return this.#view(bound);
    } catch {
      // The returned ID is safe operator recovery evidence. Never hide it, list-adopt, or re-create.
      throw new EpEnvelopeError("unavailable", "provider created an environment but its binding could not be persisted; recovery is required",
        [{ kind: "ai.cotal.environment.binding-unconfirmed", id, environment }], "unknown");
    }
  }

  async inspect(caller: EpCaller, id: string): Promise<EnvironmentView> {
    return this.#view(await this.#owned(caller, id));
  }

  async destroy(caller: EpCaller, id: string): Promise<EnvironmentView> {
    await this.#owned(caller, id);
    await this.#change(id, (r) => ({ ...r, destroyRequested: true }));
    return this.#destroy(id);
  }

  /** Called by a supervised host even when no callers are connected. A failed row does not prevent
   * the remaining rows from being cleaned; every failure reaches the required reporter. */
  async reconcile(report: (id: string, problem: string) => void): Promise<void> {
    for await (const record of this.store.records()) {
      if (record.terminatedAt !== undefined) continue;
      if (!record.environment) { report(record.id, "create-unconfirmed"); continue; }
      if (!record.destroyRequested && record.expiresAt > Date.now()) continue;
      try {
        await this.#change(record.id, (r) => ({ ...r, destroyRequested: true }));
        const view = await this.#destroy(record.id);
        if (view.problem) report(record.id, view.problem);
      } catch { report(record.id, "cleanup-unconfirmed"); }
    }
  }

  #driver(record: EnvironmentRecord): EnvironmentProvisionDriver {
    const driver = this.#drivers.get(record.provider);
    if (!driver) throw new Error("recorded environment provider is not installed");
    return driver;
  }

  #repeat(record: EnvironmentRecord, caller: EpCaller, profile: string, pin: string): Promise<EnvironmentView> {
    if (!sameCaller(record.caller, caller) || record.profile !== profile || record.profileDigest !== pin)
      refuse("conflict", "operationId is already bound to different environment input");
    return this.#view(record);
  }

  async #owned(caller: EpCaller, id: string): Promise<EnvironmentRecord> {
    if (!/^[a-f0-9]{64}$/.test(id)) refuse("bad-request", "invalid environment id");
    const entry = await this.store.get(id);
    if (!entry || !sameCaller(entry.record.caller, caller)) refuse("not-found", "environment not found for this caller lifecycle");
    return entry.record;
  }

  async #view(record: EnvironmentRecord): Promise<EnvironmentView> {
    if (!record.environment) return { record, problem: "create-unconfirmed" };
    if (record.terminatedAt !== undefined) return {
      record, observation: { environment: record.environment, state: "terminated", observedAt: record.terminatedAt },
    };
    try {
      const observation = await this.#driver(record).inspect(record.environment);
      if (contractDigest(observation.environment) !== contractDigest(record.environment)) throw new Error("provider observation reference mismatch");
      return { record, observation };
    } catch { return { record, problem: "observation-unavailable" }; }
  }

  async #change(id: string, apply: (r: EnvironmentRecord) => EnvironmentRecord): Promise<EnvironmentRecord> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.store.get(id);
      if (!entry) throw new Error("environment record missing");
      const next = apply(entry.record);
      if (await this.store.put(next, entry.revision)) return next;
    }
    throw new Error("environment record contention");
  }

  async #destroy(id: string): Promise<EnvironmentView> {
    let record = (await this.store.get(id))?.record;
    if (!record) throw new Error("environment record missing");
    if (!record.environment || record.terminatedAt !== undefined) return this.#view(record);
    if (!record.retirementReceipt) {
      const receipt = await this.host.retainAndRetire(structuredClone(record));
      if (typeof receipt !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(receipt)) throw new Error("invalid retention/retirement receipt");
      record = await this.#change(id, (r) => ({ ...r, retirementReceipt: r.retirementReceipt ?? receipt }));
    }
    await this.#driver(record).destroy(record.environment!);
    const view = await this.#view(record);
    if (view.observation?.state === "terminated") {
      const observedAt = view.observation.observedAt;
      view.record = await this.#change(id, (r) => ({ ...r, terminatedAt: r.terminatedAt ?? observedAt }));
    }
    return view;
  }
}

/** No overlapping passes. The caller must supervise this task and restart it on failure. */
export async function runEnvironmentCleanup(service: EnvironmentService, options: {
  signal: AbortSignal; intervalMs: number; report: (id: string, problem: string) => void;
}): Promise<void> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100 || options.intervalMs > 60_000) throw new Error("invalid cleanup interval");
  while (!options.signal.aborted) {
    await service.reconcile(options.report);
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); options.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, options.intervalMs);
      options.signal.addEventListener("abort", done, { once: true });
      if (options.signal.aborted) done();
    });
  }
}

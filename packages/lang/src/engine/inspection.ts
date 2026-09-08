import { RunDivergence, ScopeBranchMissing, UnwalkableScope } from "../errors.js";
import { Journal, type JournalEntry, type LookupVerdict } from "../journal.js";
import { stepKeyString, type StepKey } from "../keys.js";

export type InspectionExit =
  | { readonly kind: "cut" | "frontier"; readonly step: string }
  | { readonly kind: "divergence"; readonly step: string; readonly recordedHash: string; readonly programHash: string }
  | { readonly kind: "unwalkable"; readonly step: string; readonly why: string }
  | { readonly kind: "missing-branch"; readonly step: string; readonly scope: string; readonly missing: readonly string[]; readonly recorded: readonly string[]; readonly source: readonly string[] }
  | { readonly kind: "error"; readonly name: string; readonly message: string; readonly code?: string };

export interface InspectionSnapshot {
  readonly orphans: readonly JournalEntry[];
  readonly exit?: InspectionExit;
}

export class InspectionStopped extends Error {
  constructor(readonly kind: "cut" | "frontier", readonly step: string) {
    super(`inspection reached ${kind} at ${step}`);
    this.name = "InspectionStopped";
  }
}

/** Stops before consuming a cut or dispatching a step that needs a live effect. */
export class InspectionJournal extends Journal {
  private stoppedAt?: InspectionStopped;

  get stop(): InspectionStopped | undefined { return this.stoppedAt; }

  private halt(kind: "cut" | "frontier", step: string): never {
    this.stoppedAt = new InspectionStopped(kind, step);
    throw this.stoppedAt;
  }

  constructor(run: string, entries: readonly JournalEntry[], private readonly cutAt?: string) {
    super({ run, entries, readOnly: true });
  }

  override lookup(key: StepKey, inputHash: string): LookupVerdict {
    if (this.stoppedAt !== undefined) throw this.stoppedAt;
    const step = stepKeyString(key);
    if (step === this.cutAt) this.halt("cut", step);
    const verdict = super.lookup(key, inputHash);
    if (verdict.verdict === "miss" || verdict.verdict === "pending" || verdict.verdict === "refused")
      this.halt("frontier", step);
    return verdict;
  }
}

/** Serialize the planner's typed failures before they cross the worker boundary. */
export function inspectionExit(error: unknown): InspectionExit {
  let e = error;
  for (let i = 0; i < 8; i++) {
    const reason = (e as { reason?: unknown } | null)?.reason;
    if (reason === undefined || reason === e) break;
    e = reason;
  }
  if (e instanceof InspectionStopped) return { kind: e.kind, step: e.step };
  if (e instanceof RunDivergence)
    return { kind: "divergence", step: e.stepKey, recordedHash: e.recordedHash, programHash: e.programHash };
  if (e instanceof UnwalkableScope) return { kind: "unwalkable", step: e.scopeKey, why: e.why };
  if (e instanceof ScopeBranchMissing)
    return { kind: "missing-branch", step: e.scopeKey, scope: e.scope, missing: e.missing, recorded: e.recorded, source: e.source };
  const value = e as { name?: unknown; message?: unknown; code?: unknown } | null;
  return {
    kind: "error",
    name: typeof value?.name === "string" ? value.name : "Error",
    message: typeof value?.message === "string" ? value.message : String(e),
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
  };
}

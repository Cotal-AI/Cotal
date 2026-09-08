import {
  ENGINE_LANGUAGE_VERSION,
  WALKER_LANGUAGE_VERSION,
  RunDivergence,
  ScopeBranchMissing,
  UnwalkableScope,
  RuntimeFault,
  runInWorker,
  transform,
  type JournalEntry,
  type RunPins,
} from "@cotal-ai/lang";
import { resolveWorkerEntry } from "./engine-host.js";

export function assertPlanningVersion(pins: RunPins): void {
  if (pins.languageVersion !== WALKER_LANGUAGE_VERSION && pins.languageVersion !== ENGINE_LANGUAGE_VERSION)
    throw new RuntimeFault("L5023", `planning does not support recorded language version ${pins.languageVersion}`);
}

/** The worker receives recorded data only, with no effect handler or durable store. */
export async function inspectCompiled(req: {
  readonly source: string;
  readonly runId: string;
  readonly pins: RunPins;
  readonly entries: readonly JournalEntry[];
  readonly cutAt?: string;
  readonly file?: string;
}): Promise<{ orphans: readonly JournalEntry[]; reachedCut: boolean; error?: Error }> {
  const { module } = transform(req.source, req.file !== undefined ? { file: req.file } : {});
  const result = await runInWorker({ ...req, module, handler: "inspection" }, { entry: resolveWorkerEntry() }).done;
  const snapshot = result.inspection;
  if (snapshot === undefined) throw new Error("compiled inspection returned no journal snapshot");
  const exit = snapshot.exit;
  const base = { orphans: snapshot.orphans, reachedCut: exit?.kind === "cut" };
  if (exit === undefined || exit.kind === "cut" || exit.kind === "frontier") return base;
  let error: Error;
  switch (exit.kind) {
    case "divergence": error = new RunDivergence(exit.step, exit.recordedHash, exit.programHash); break;
    case "unwalkable": error = new UnwalkableScope(exit.step, exit.why); break;
    case "missing-branch": error = new ScopeBranchMissing(exit.step, exit.scope, exit.missing, exit.recorded, exit.source); break;
    case "error": {
      error = new Error(exit.message);
      error.name = exit.name;
      if (exit.code !== undefined) Object.assign(error, { code: exit.code });
      break;
    }
  }
  return { ...base, error };
}

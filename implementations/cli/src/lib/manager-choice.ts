import { remoteManagerActors, type Presence } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";
import { displayCmd } from "./self-exec.js";
import { openTransient } from "./transient.js";

/** The exchange's refusal of an unpinned manager-caller selection while several of the caller's own
 *  managers are live: their count, the owner and the instance ids. */
const SEVERAL_LIVE = /(\d+) live remote manager candidates for owner (\S+) \(([^)]*)\)/;

/** One live manager a refused selection could have chosen, with what presence says about it. */
export interface ManagerCandidate {
  readonly instanceId: string;
  readonly host: string | null;
  readonly activity: string | null;
  readonly since: string | null;
}

/** The roster of the space `values` resolve to, read once. */
export async function rosterOf(values: { space?: string; server?: string }): Promise<Presence[]> {
  const { ep } = await openTransient(values, "manager-candidates", { throwOnRefusal: true, report: () => {} });
  try { return ep.getRoster(); } finally { await ep.stop().catch(() => {}); }
}

/** `failure` restated as the choice it is, when it is the refusal of an unpinned manager selection
 *  among several live managers: each one's instance id, with the host, activity and process start
 *  its presence reports, and a Next that reruns `argv` with `--on` for each. The outcome and code
 *  are kept. The roster is read only for that refusal, and one that cannot be read leaves the
 *  instance ids. Undefined for any other failure. */
export async function managerChoiceFailure(
  failure: CommandFailure,
  readRoster: () => Promise<readonly Presence[]>,
  argv: readonly string[],
): Promise<CommandFailure | undefined> {
  const found = failure.code === "PERMISSION_DENIED" ? SEVERAL_LIVE.exec(failure.message) : null;
  if (!found) return undefined;
  const owner = found[2]!;
  const ids = found[3]!.split(",").map((id) => id.trim()).filter(Boolean);
  let roster: readonly Presence[] = [];
  try { roster = await readRoster(); } catch { /* the instance ids still name the choice */ }
  const managers = ids.map((instanceId): ManagerCandidate => {
    const row = roster.find((p) => p.card.id === `${owner}.${remoteManagerActors(instanceId).supervisor}` && p.status !== "offline");
    const host = row?.card.meta?.host;
    return {
      instanceId,
      host: typeof host === "string" && host ? host : null,
      activity: row?.activity ?? null,
      since: row?.runtime ? new Date(row.runtime.startedAt).toISOString() : null,
    };
  });
  // `--on` goes before a `--` that ends the flags, so it is still read as a flag.
  const end = argv.indexOf("--");
  const words = end === -1 ? [...argv] : argv.slice(0, end);
  const rest = end === -1 ? [] : argv.slice(end);
  const rerun = (id: string) => [displayCmd(), ...[...words, "--on", id, ...rest].map(shellWord)].join(" ");
  return new CommandFailure(failure.outcome, failure.code, `${ids.length} of your managers are live, and this command needs exactly one of them`, {
    target: failure.target,
    native: { detail: { managers } },
    remedy: `rerun it on one: ${ids.map(rerun).join(" or ")}`,
    cause: failure,
  });
}

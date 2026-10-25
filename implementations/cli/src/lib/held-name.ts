import { setTimeout as sleep } from "node:timers/promises";
import { AGENT_LIFECYCLE_HELD, agentLifecycleHeld, type AgentLifecycleHeld, type AgentLifecycleRelease } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { shellWord } from "./endpoint-errors.js";
import { displayCmd } from "./self-exec.js";
import { nameOnline, whereAgentRuns, type RunningOn } from "./manager-choice.js";

/** The words a mesh answers with while a released name's retirement finishes. It has no typed
 *  answer for that yet, so this is the one place they are matched. */
const STILL_RETIRING = "that agent name is still retiring";

/** How long a spawn waits for a released name to finish retiring, and how often it asks again. */
const RETIREMENT_WAIT_MS = 120_000;
const RETIREMENT_POLL_MS = 5_000;

/** The agent a spawn asked for already runs: on `manager` when it is a live manager of yours. */
export class AgentAlreadyRunning extends Error {
  constructor(readonly agent: string, readonly manager: RunningOn | null) {
    super(`agent "${agent}" is already running`);
    this.name = "AgentAlreadyRunning";
  }
}

/** What one attempt answered about the agent name it asked for: held by a lifecycle, or still
 *  retiring. `live` marks a manager's own refusal of a name it holds, which may also be a name a
 *  launch has reserved or a retirement still holds, so it is not proof the agent runs. */
export type HeldAnswer =
  | { kind: "held"; agent: string; held?: AgentLifecycleHeld; live: boolean; reason: string }
  | { kind: "retiring"; agent: string; reason: string };

/** The held answer a refusal carries: a `conflict` or `already-exists` code, with the host's typed
 *  held answer when its details carry one, or words that say the name is still retiring. The agent
 *  is the actor the host answered about, else `agent`; with neither, the answer is not read. */
export function heldAnswer(refusal: { code?: unknown; details?: unknown; message: string }, agent: string | undefined): HeldAnswer | undefined {
  const entry = Array.isArray(refusal.details) ? refusal.details.find((d) => (d as { kind?: unknown } | null)?.kind === AGENT_LIFECYCLE_HELD) as { actor?: unknown } | undefined : undefined;
  const name = typeof entry?.actor === "string" ? entry.actor : agent;
  if (name === undefined) return undefined;
  if (refusal.code === "conflict" || refusal.code === "already-exists")
    return { kind: "held", agent: name, held: agentLifecycleHeld(refusal.details), live: refusal.code === "already-exists", reason: refusal.message };
  return refusal.message.includes(STILL_RETIRING) ? { kind: "retiring", agent: name, reason: refusal.message } : undefined;
}

/**
 * Run `attempt` until the name it asks for is not held by a lifecycle that is not running. A held name
 * that a live manager of yours runs, or that presence or the host reports online, throws
 * {@link AgentAlreadyRunning}. A refusal that names no lifecycle otherwise stands as it came, and a
 * lifecycle a live manager of yours holds without reporting it is refused. Any other lifecycle the
 * host names in its typed answer is released once through
 * `release`, by its exact UID, and the attempt is made again; while the host still holds that
 * lifecycle or says the name is retiring, the attempt is repeated every few seconds for up to two
 * minutes. Nothing is adopted: a released lifecycle is retired, and the attempt asks for a new one.
 */
export async function settleHeldName<T>(
  flags: { space?: unknown; server?: unknown },
  attempt: () => Promise<T>,
  classify: (outcome: { value: T } | { error: unknown }) => HeldAnswer | undefined,
  release: ((lifecycleUid: string, agent: string) => Promise<AgentLifecycleRelease>) | undefined,
): Promise<T> {
  let released: string | undefined;
  let deadline: number | undefined;
  for (;;) {
    let outcome: { value: T } | { error: unknown };
    try { outcome = { value: await attempt() }; } catch (error) { outcome = { error }; }
    const answer = classify(outcome);
    if (answer === undefined) {
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    }
    const agent = answer.agent;
    if (answer.kind === "held" && (answer.held === undefined || answer.held.lifecycleUid !== released)) {
      const held = answer.held;
      const { runsOn, custodian } = await whereAgentRuns(flags, agent, held?.custody.managerInstanceId).catch(() => ({ runsOn: null, custodian: null }));
      const online = runsOn === null && (held?.presence === "online" || (answer.live && await nameOnline(flags, agent).catch(() => false)));
      if (runsOn !== null || online) throw new AgentAlreadyRunning(agent, runsOn);
      // A live manager of yours holds it but does not report it: it may still be starting there.
      if (held !== undefined && custodian !== null)
        throw new CommandFailure("refused", "CONFLICT", `"${agent}" is held by lifecycle ${held.lifecycleUid} on ${custodian.selector}, which does not report it running; it may still be starting`, {
          target: { agent, lifecycleUid: held.lifecycleUid, managerInstanceId: custodian.instanceId },
          native: { detail: { held } },
          remedy: `nothing was launched; run the spawn again in a moment, or stop it there with ${displayCmd()} stop ${shellWord(agent)} --on ${shellWord(custodian.selector)}`,
        });
      // Without the host's typed answer nothing says which lifecycle holds the name, or that a
      // name holds it at all: a stale serve epoch is a conflict too. The refusal stands as it came.
      if (held === undefined) {
        if ("error" in outcome) throw outcome.error;
        return outcome.value;
      }
      if (release === undefined || released !== undefined)
        throw new CommandFailure("refused", "CONFLICT", answer.reason, {
          target: { agent, lifecycleUid: held.lifecycleUid },
          native: { detail: { held } },
          remedy: release === undefined
            ? `"${agent}" is held by lifecycle ${held.lifecycleUid}, and this mesh offers no release for it; nothing was launched, so pick another name with --name <other>`
            : `nothing was launched; the mesh named lifecycle ${held.lifecycleUid} after this spawn released ${released}, so run the spawn again in a moment, or pick another name with --name <other>`,
        });
      let answered: AgentLifecycleRelease;
      try { answered = await release(held.lifecycleUid, agent); } catch (error) {
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `"${agent}" is held by lifecycle ${held.lifecycleUid}, which is not running, and its release did not complete: ${(error as Error).message}`, {
          target: { agent, lifecycleUid: held.lifecycleUid }, native: { detail: { stage: "release", held } },
          remedy: "nothing was launched; run the spawn again, which releases that lifecycle again",
        });
      }
      if (answered.outcome === "unknown")
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `"${agent}" is held by lifecycle ${held.lifecycleUid}, which is not running, and the mesh could not confirm its release (HTTP ${answered.status}${answered.reason ? `: ${answered.reason}` : ""})`, {
          target: { agent, lifecycleUid: held.lifecycleUid }, native: { detail: { stage: "release", held, release: answered } },
          remedy: `nothing was launched and the release was not repeated; cotal auth retire ${held.lifecycleUid} asks for it again`,
        });
      released = held.lifecycleUid;
      console.error(c.dim(`"${agent}" was held by lifecycle ${held.lifecycleUid}, which is not running; it was released, so this spawn starts a new one …`));
      continue;
    }
    // The released lifecycle is still held, or the name is still retiring: ask again shortly.
    if (deadline === undefined) {
      deadline = Date.now() + RETIREMENT_WAIT_MS;
      console.error(c.dim(`"${agent}" is still retiring on the mesh; trying again every ${RETIREMENT_POLL_MS / 1000}s for up to ${RETIREMENT_WAIT_MS / 60_000} minutes …`));
    }
    if (Date.now() >= deadline)
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `"${agent}" was still retiring on the mesh after ${RETIREMENT_WAIT_MS / 60_000} minutes, so it was not launched: ${answer.reason}`, {
        target: { agent, ...(released ? { lifecycleUid: released } : {}) }, native: { detail: { stage: "retirement" } },
        remedy: "nothing was launched; run the spawn again in a few minutes",
      });
    await sleep(RETIREMENT_POLL_MS);
  }
}

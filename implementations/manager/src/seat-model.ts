/**
 * The model an owner's `set-model` switched a seat to (SPEC 13.22), kept with the seat so `ps`
 * reports it and every relaunch of its lifecycle starts on it. The seat's own live presence is the
 * source, as it is for the name `set-name` changed: the agent's connector writes the
 * `ai.cotal.model-set` mark only once its harness took a switch.
 */
import { AGENT_CONTRACTS, AGENT_MODEL_SET_META_KEY, loadCotalConfig, modelPolicyEnv, rejectionText, type Presence, type SetModelOutput } from "@cotal-ai/core";
import { isTrustedProject } from "@cotal-ai/workspace";
import type { ManagedAgent } from "./seat-types.js";

/** The mark each seat last had refused, so a refusal is logged once and not on every roster change. */
const refusedMarks = new WeakMap<ManagedAgent, string>();

/** Why the manager does not keep `mark`, or undefined when it does. The record is the seat's own
 *  write and nothing validated it, so it must be `set-model`'s answer shape, and a seat whose role is
 *  under `modelPolicy` never switches (its connector refuses), so a mark from one is not kept. */
function markRefusal(a: ManagedAgent, mark: unknown, workspaceRoot: string): string | undefined {
  if (!AGENT_CONTRACTS["set-model"].output.validate(mark)) return `${AGENT_MODEL_SET_META_KEY} is not { model, variant? }`;
  const policed = modelPolicyEnv(loadCotalConfig(workspaceRoot, isTrustedProject), a.role);
  return Object.keys(policed).length ? `role "${a.role}" is under modelPolicy.${a.role}, which judges its model at launch only` : undefined;
}

/**
 * Keep the switch the seat's own live record `seen` shows, unless it is the one the seat launched
 * on. Returns whether the seat's model changed, so the caller rewrites its record. A mark the manager
 * refuses is logged once, and the model the seat last kept stays.
 */
export function noteModelSet(a: ManagedAgent, seen: Presence, o: { workspaceRoot: string; log(line: string): void }): boolean {
  const mark = seen.card.meta?.[AGENT_MODEL_SET_META_KEY];
  if (mark === undefined) return false;
  const set = mark as SetModelOutput;
  if (typeof set === "object" && set !== null && set.model === a.launch.model && set.variant === a.launch.variant) return false;
  let why: string | undefined;
  try {
    why = markRefusal(a, mark, o.workspaceRoot);
  } catch (e) {
    why = `could not read the Cotal configuration: ${rejectionText(e)}`;
  }
  if (why !== undefined) {
    const key = JSON.stringify(mark);
    if (refusedMarks.get(a) !== key) o.log(`! ${a.name}: the model its presence says set-model switched to is not kept for a relaunch: ${why}`);
    refusedMarks.set(a, key);
    return false;
  }
  a.launch.model = set.model;
  a.launch.variant = set.variant;
  return true;
}

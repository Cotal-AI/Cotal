import { isStreamNotFound, type CotalEndpoint } from "@cotal-ai/core";
import { localStackRoot, spaceStreamsAbsent, type CommandFailure } from "@cotal-ai/workspace";
import { runningStackMembers } from "./stack-members.js";

/** Whether the chat stream of the endpoint's space is gone from its broker. Any other failure to
 *  read it answers no. */
export async function chatStreamGone(ep: CotalEndpoint): Promise<boolean> {
  try {
    await ep.chatFrontier();
    return false;
  } catch (e) {
    return isStreamNotFound(e);
  }
}

/** This machine's stack for `space`: its root, and whether it still runs members other than its
 *  broker, which is absent when its records cannot be read. Undefined when no stack of it runs from
 *  this machine. */
export function stackState(space: string): { root: string; stack?: "running" | "stopped" } | undefined {
  const root = localStackRoot(space);
  if (root === undefined) return undefined;
  try { return { root, stack: runningStackMembers(root, space).members.length ? "running" : "stopped" }; } catch { return { root }; }
}

/** The refusal for a space whose streams are not on its broker ({@link spaceStreamsAbsent}), with
 *  the root and stack state this machine records for it. */
export function streamsAbsent(conn: { space: string }): CommandFailure {
  const local = stackState(conn.space);
  return spaceStreamsAbsent(conn.space, local?.root, local?.stack);
}

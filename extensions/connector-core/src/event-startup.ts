import { checkEventStartup as checkSharedEventStartup, EventStateConflictError, principalKey, type CotalEndpoint } from "@cotal-ai/core";
import { eventWalLocation, resolveEventsStateRoot } from "./agui-wal-path.js";
import { EventWal } from "./event-wal.js";

export { EventStateConflictError } from "@cotal-ai/core";

/** Check the connector's selected state using the shared acknowledged-state decision. */
export async function checkEventStartup(ep: CotalEndpoint, env: NodeJS.ProcessEnv): Promise<void> {
  const workspaceRoot = resolveEventsStateRoot(env);
  try {
    await checkSharedEventStartup({
      workspaceRoot,
      space: ep.space,
      principal: ep.principal,
      retainedMessages: async () => (await ep.chatRetention()).senders,
    });
  } catch (error) {
    if (!(error instanceof EventStateConflictError)) throw error;
    // A frozen unacknowledged frame is existing state, not a missing transcript. Admit the
    // connector so its emitter can prove or retry that frame under the principal lock.
    const principal = principalKey(ep.principal.owner, ep.principal.actor).key;
    const threadId = "startup-pending-inspection";
    const { walPath } = eventWalLocation({ workspaceRoot, space: ep.space, principal, threadId });
    const inspection = await EventWal.open(walPath, { space: ep.space, principal, threadId, subjectMayExist: false });
    if ((await inspection.pendingSiblings()).length === 0) throw error;
  }
}

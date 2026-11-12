import { relative, sep } from "node:path";
import { ensureDirNoSymlink, eventChannel, principalKey, type CotalEndpoint } from "@cotal-ai/core";
import { eventPrincipalLocation, resolveEventsStateRoot } from "./agui-wal-path.js";
import { FileSubjectFrontier } from "./subject-frontier.js";

/** The selected state cannot safely start a transcript under this principal. */
export class EventStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventStateConflictError";
  }
}

/** Check startup compatibility using retained counts, never message bodies or a guessed append tip. */
export async function checkEventStartup(ep: CotalEndpoint, env: NodeJS.ProcessEnv): Promise<void> {
  const workspaceRoot = resolveEventsStateRoot(env);
  const principal = principalKey(ep.principal.owner, ep.principal.actor).key;
  const loc = eventPrincipalLocation({ workspaceRoot, space: ep.space, principal });
  ensureDirNoSymlink(workspaceRoot, ...relative(workspaceRoot, loc.principalDir).split(sep));
  // Read only: an emitter in this process may already hold the shared principal lock.
  // Recovery writes still happen under that lock when the emitter opens its frontier.
  const tip = await FileSubjectFrontier.recordedTip(loc.subjectPath, { space: ep.space, principal });
  if (tip !== 0) return;
  const retention = await ep.chatRetention();
  if (retention.senders.some((row) => row.sender === principal && row.channel === eventChannel(ep.principal) && row.messages > 0)) {
    throw new EventStateConflictError(
      `Cannot start events for ${principal}: this state root has no acknowledged transcript frontier, ` +
      `but the broker retains events for this principal. Reuse the previous state root or launch with a new principal. ` +
      `Refusing before work; the existing transcript and local logs are unchanged.`,
    );
  }
}

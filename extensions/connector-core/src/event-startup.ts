import { checkEventStartup as checkSharedEventStartup, type CotalEndpoint } from "@cotal-ai/core";
import { resolveEventsStateRoot } from "./agui-wal-path.js";

export { EventStateConflictError } from "@cotal-ai/core";

/** Check the connector's selected state using the shared acknowledged-state decision. */
export async function checkEventStartup(ep: CotalEndpoint, env: NodeJS.ProcessEnv): Promise<void> {
  await checkSharedEventStartup({
    workspaceRoot: resolveEventsStateRoot(env),
    space: ep.space,
    principal: ep.principal,
    retainedMessages: async () => (await ep.chatRetention()).senders,
  });
}

import type { ControlClient } from "../control/manager.js";
import type { MeshTarget } from "../mesh-target.js";
import { openRoutingChatSession } from "./open-session.js";
import type { AdmittedChatSession } from "./session.js";
import { openStaticChatSession } from "./static-session.js";
import { openUserChatSession } from "./user-session.js";

/** A user-mode session asks for the auth service's whole lifetime cap, 8 hours, which it never
 *  extends. Each bearer within it still lasts at most 15 minutes. */
export const USER_CHAT_TTL_SEC = 8 * 60 * 60;

/** What one admission asks for, by the target's recorded mode. A named channel is the session's
 *  initial channel, read ceiling and post list. Without one, an authenticated session starts on no
 *  channel and can neither join nor post to one; an open session routes anywhere. */
export type ChatAdmission =
  | { readonly mode: "open"; readonly label: string; readonly channels: readonly string[] }
  | { readonly mode: "auth"; readonly label: string; readonly subscribe: readonly string[]; readonly allowPublish: readonly string[] }
  | { readonly mode: "user"; readonly label: string; readonly channels: readonly string[]; readonly read: readonly string[]; readonly post: readonly string[]; readonly ttlSec: number };

/** Admit through the one adapter the mode names. Each adapter refuses a target of another mode.
 *  `reopen` names the command that opens a session on a channel, for refusals that suggest one;
 *  `control` asks the manager that admits and retires a static session. */
export function openChatSession(target: MeshTarget, admission: ChatAdmission, options: {
  readonly reopen: (channel: string) => string;
  readonly control: ControlClient;
}): Promise<AdmittedChatSession> {
  const { reopen, control } = options;
  switch (admission.mode) {
    case "open": return openRoutingChatSession(target, { ...admission, reopen });
    case "auth": return openStaticChatSession(target, { ...admission, reopen, control });
    case "user": return openUserChatSession(target, { ...admission, reopen });
  }
}

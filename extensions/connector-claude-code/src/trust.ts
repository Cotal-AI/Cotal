import type { StartupReply } from "@cotal-ai/core";

/** An authorized managed launch accepts its workspace through Claude's own dialog. The second
 * response requires the selected Yes row, so an Enter can never accept the default No choice.
 * Claude persists its own trust state; Cotal never edits the operator's config file. */
export const CLAUDE_WORKSPACE_TRUST_REPLIES: readonly StartupReply[] = Object.freeze([
  Object.freeze({ prompt: "❯ No, exit\nYes, I trust this folder", key: "Down" as const }),
  Object.freeze({ prompt: "No, exit\n❯ Yes, I trust this folder", key: "Enter" as const }),
]);

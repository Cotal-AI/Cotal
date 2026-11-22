import { codeSpan, CommandFailure, readLiveManagerName, type LocalProcessContext, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";

/** A named refresh can reuse a manager only when its process published the requested name. */
export function assertLiveManagerName(context: LocalProcessContext, requested: string, process: ProcessIdentityRecord | undefined): void {
  let live: string | undefined, cause: unknown;
  try { if (process) live = readLiveManagerName(context, process); }
  catch (error) { cause = error; }
  if (live === requested) return;
  const why = live === undefined ? "its live name cannot be confirmed" : "it keeps the name it started with";
  throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `a manager already runs for space ${context.space}, and ${why}`, {
    target: context, cause,
    remedy: `stop it with \`cotal down\`, then run ${codeSpan(`cotal up --manager-name=${shellWord(requested)}`)}`,
  });
}

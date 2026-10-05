import * as p from "@clack/prompts";
import type { ConnectorAssist } from "@cotal-ai/core";
import { dim } from "./theme.js";

export interface AssistContext {
  /** Failed step slug (as shown to the user and written to the log). */
  step: string;
  error: Error;
  /** Local paths and doc URLs the harness should read for context: referenced in the
   *  prompt, never inlined, so it works without a repo clone. */
  context: string[];
  logPath: string;
}

/** A debug handoff is offered only on a TTY and when not opted out via COTAL_SKIP_ASSIST=1 (CI).
 *  Which harness hosts it is the connectors' answer, not this file's. */
export function assistAllowed(): boolean {
  if (process.env.COTAL_SKIP_ASSIST === "1") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Hand the terminal to a connector's debug session primed with the failure context. Resolves when
 *  the user exits the harness and setup resumes. */
export async function runHandoff(assist: ConnectorAssist, ctx: AssistContext): Promise<void> {
  p.note(
    `Failed step: ${ctx.step}\n${ctx.error.message}\n\nExit ${assist.title} when you're done; setup resumes here.`,
    `Handing off to ${assist.title}`,
  );
  try {
    await assist.run(buildPrompt(ctx));
  } catch {
    p.log.error(`Couldn't launch ${assist.title}; continuing without it.`);
  }
  p.log.info(`Back from ${assist.title}.`);
}

/** The line the failure menu prints when no handoff can be offered, so the absence is explained. */
export function noAssistLine(reason: string): string {
  return dim(`No debug handoff: ${reason}.`);
}

function buildPrompt(ctx: AssistContext): string {
  return [
    "I'm running `cotal setup` (Cotal: a mesh where AI agents coordinate as lateral",
    "peers over NATS/JetStream) and a setup step failed. Help me diagnose and fix it.",
    "",
    `Failed step: ${ctx.step}`,
    `Error: ${ctx.error.message}`,
    "",
    "Read these for context as needed (don't assume their contents):",
    ...[ctx.logPath, ...ctx.context].map((f) => `  - ${f}`),
    "",
    "Be concise. When the issue is fixed, remind me to exit this session, and I'll land back",
    "in the setup flow, which will offer to retry the failed step.",
  ].join("\n");
}

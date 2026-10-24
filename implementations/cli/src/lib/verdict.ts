import type { Section } from "@cotal-ai/workspace";

/** The section a destructive command's dry run opens with, so its decision comes first: the apply is
 *  offered, with the command that runs it and what that apply checks again, or it would refuse, with
 *  the apply's own code, reason and remedy. */
export function verdictSection(
  operation: string,
  refusal: { readonly code: string; readonly message: string; readonly remedy?: string } | undefined,
  apply: { readonly command: string; readonly description: string; readonly recheck: string },
): Section {
  return {
    title: "Verdict",
    blocks: refusal
      ? [{ kind: "lines", lines: [{ text: `${operation} would refuse (${refusal.code}): ${refusal.message}`, tone: "failed" }, ...(refusal.remedy ? [`Next: ${refusal.remedy}`] : [])] }]
      : [
        { kind: "lines", lines: [{ text: `${operation} is offered. ${apply.recheck}`, tone: "ok" }] },
        { kind: "commands", items: [{ command: apply.command, description: apply.description }] },
      ],
  };
}

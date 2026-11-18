import { resolve } from "node:path";
import type { FlagSpec, ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, jsonFlag, plainFlag, presentationOf, trustProject, trustedProjectsPath, writeResult, type Report } from "@cotal-ai/workspace";

export const trustFlags = [jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

/** What `cotal trust` reports: the canonical folder, and the file that records it. */
export interface TrustResult {
  readonly kind: "trust";
  readonly root: string;
  readonly file: string;
}

export function validateTrustArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length !== 1 || args.positionals[0]!.trim() === "")
    throw new CommandFailure("refused", "USAGE_INVALID", "usage: cotal trust <path> [--json|--plain]");
}

/** `cotal trust <path>`: record a project folder as trusted, so its `.cotal/config.json` may declare
 *  MCP servers and `spawn.env` names. A folder already trusted is a no-op. */
export async function trust(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const { root, added } = trustProject(resolve(args.positionals[0]!));
  const result: TrustResult = { kind: "trust", root, file: trustedProjectsPath() };
  writeResult(presentation, { command: "trust", target: { root }, result, noOp: !added }, view(added));
}

function view(added: boolean): (r: TrustResult) => Report {
  return (r) => ({
    sections: [{
      blocks: [
        { kind: "lines", lines: [added ? `Trusted ${r.root}` : `${r.root} was already trusted`] },
        { kind: "lines", lines: [{ text: "Its .cotal/config.json may now declare MCP servers and spawn.env names for agents spawned there.", tone: "hint" }] },
        { kind: "fields", rows: [["file", r.file]] },
      ],
    }],
  });
}

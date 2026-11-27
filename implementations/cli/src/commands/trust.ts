import { resolve } from "node:path";
import type { FlagSpec, ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, jsonFlag, plainFlag, presentationOf, trustProject, trustedProjectsPath, writeResult, type Report } from "@cotal-ai/workspace";

export const trustFlags = [jsonFlag, plainFlag, { name: "hex", type: "boolean", description: "read the path as UTF-8 hex, as printed for paths with shell metacharacters" }] as const satisfies readonly FlagSpec[];

/** What `cotal trust` reports: the canonical folder, and the file that records it. */
export interface TrustResult {
  readonly kind: "trust";
  readonly root: string;
  readonly file: string;
}

export function validateTrustArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length !== 1 || args.positionals[0]!.trim() === "")
    throw new CommandFailure("refused", "USAGE_INVALID", "usage: cotal trust <path> [--hex] [--json|--plain]", { remedy: "name one existing project folder, for example `cotal trust .`" });
  if (args.values.hex) decodePath(args.positionals[0]!);
}

function decodePath(hex: string): string {
  const bytes = Buffer.from(hex, "hex");
  const path = bytes.toString("utf8");
  if (!path || path.includes("\0") || Buffer.from(path, "utf8").toString("hex") !== hex.toLowerCase())
    throw new CommandFailure("refused", "USAGE_INVALID", "the project folder is not valid UTF-8 hex, so it was not trusted", { remedy: "copy the full printed command, or name the project folder without --hex" });
  return path;
}

/** `cotal trust <path>`: record a project folder as trusted, so its `.cotal/config.json` may declare
 *  MCP servers and `spawn.env` names and its persona files may declare launch options. A folder
 *  already trusted is a no-op. */
export async function trust(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const path = args.positionals[0]!;
  const { root, added } = trustProject(resolve(args.values.hex ? decodePath(path) : path));
  const result: TrustResult = { kind: "trust", root, file: trustedProjectsPath() };
  writeResult(presentation, { command: "trust", target: { root }, result, noOp: !added }, view(added));
}

function view(added: boolean): (r: TrustResult) => Report {
  return (r) => ({
    sections: [{
      blocks: [
        { kind: "lines", lines: [added ? `Trusted ${r.root}` : `${r.root} was already trusted`] },
        { kind: "lines", lines: [{ text: "Its .cotal/config.json may now declare MCP servers and spawn.env names, and its persona files launch options, for agents spawned there.", tone: "hint" }] },
        { kind: "fields", rows: [["file", r.file]] },
      ],
    }],
  });
}

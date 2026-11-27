/**
 * How a launch hands its seat the first command (SPEC 13.22): a private file named by one variable,
 * which the seat's agent reads and removes once. A harness that restarts the process holding the
 * agent, as Claude Code does with its MCP servers, then finds no file and runs nothing again.
 */
import { readFileSync, rmSync } from "node:fs";
import { parseFirstCommand, writeLaunchArtifact, type FirstCommand } from "@cotal-ai/core";

const FIRST_COMMAND_ENV = "COTAL_FIRST_COMMAND_FILE";

/** The launch env for `first`, written to a file listed in `artifacts`. Empty without one. */
export function firstCommandEnv(first: FirstCommand | undefined, artifacts: string[]): Record<string, string> {
  if (!first) return {};
  return { [FIRST_COMMAND_ENV]: writeLaunchArtifact(artifacts, "cotal-first-command-", "first-command.json", JSON.stringify(first)) };
}

/** The first command this process's launch named, taken once: the file is removed and the variable
 *  dropped, so no child process inherits it. Undefined when the launch named none, or an earlier
 *  process of this seat took it. */
export function takeFirstCommand(env: NodeJS.ProcessEnv = process.env): FirstCommand | undefined {
  const path = env[FIRST_COMMAND_ENV]?.trim();
  delete env[FIRST_COMMAND_ENV];
  if (!path) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  rmSync(path, { force: true });
  return parseFirstCommand(JSON.parse(text));
}

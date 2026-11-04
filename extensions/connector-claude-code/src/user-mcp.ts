import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcpServerProblem, type McpServerSpec } from "@cotal-ai/core";
import { mcpServerEnvKeys } from "@cotal-ai/connector-core";

/** The user-owned MCP declarations, shared by setup and launch-time environment selection. */
export function claudeUserMcpServers(): Record<string, unknown> {
  const path = join(process.env.CLAUDE_CONFIG_DIR?.trim() || homedir(), ".claude.json");
  if (!existsSync(path)) return {};
  let config: { mcpServers?: Record<string, unknown> } | null;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: invalid JSON - ${(e as Error).message}`);
  }
  return config?.mcpServers ?? {};
}

/** Only user-owned declarations may add ambient environment names. Repository and plugin discovery
 *  stays with Claude, including approvals; reading those files here could grant an untrusted repo
 *  a secret merely by referencing its name. No server definitions or credential values are copied. */
export function claudeUserMcpEnvKeys(): string[] {
  const valid = Object.fromEntries(Object.entries(claudeUserMcpServers())
    .filter(([name, spec]) => mcpServerProblem(name, spec) === undefined)) as Record<string, McpServerSpec>;
  return mcpServerEnvKeys(valid);
}

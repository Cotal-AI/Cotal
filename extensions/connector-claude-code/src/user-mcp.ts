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

/** The MCP server names Claude Code's own configuration declares for a session in `cwd`: the user
 *  config plus the project's `.mcp.json`. Names only; no server definition, env or credential is read
 *  into the launch. Claude Code binds a `server:<name>` wake channel only to one of these (measured
 *  on 2.1.295: a server named only in `--mcp-config` reads "no MCP server configured with that name"
 *  and the session never wakes on a peer message). */
export function claudeDeclaredServerNames(cwd: string): Set<string> {
  const names = new Set(Object.keys(claudeUserMcpServers()));
  const project = join(cwd, ".mcp.json");
  if (!existsSync(project)) return names;
  let config: { mcpServers?: Record<string, unknown> } | null;
  try {
    config = JSON.parse(readFileSync(project, "utf8"));
  } catch (e) {
    throw new Error(`${project}: invalid JSON - ${(e as Error).message}`);
  }
  for (const name of Object.keys(config?.mcpServers ?? {})) names.add(name);
  return names;
}

/** Refuse a managed launch whose wake channel could not bind: without a declared server named
 *  `name`, the seat would join the mesh, report idle and never answer a turn or a direct message. */
export function assertChannelServerDeclared(name: string, cwd: string): void {
  if (claudeDeclaredServerNames(cwd).has(name)) return;
  throw new Error(
    `claude connector: Claude Code binds the server:${name} wake channel only to a server its own configuration declares, ` +
      `and neither the user config nor ${join(cwd, ".mcp.json")} declares one named ${name}; ` +
      "run `cotal setup` or `cotal update`, which registers it at user scope",
  );
}

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { StartAgentOpts } from "./manager.js";

/**
 * A roster file: a supervisor's declarative boot list.
 *
 *   # roster.yaml
 *   agents:
 *     - { name: planner, agent: claude }
 *     - { name: builder, agent: opencode, role: builder }
 *
 * Each entry maps 1:1 to a {@link Manager.startAgent} call — the same spawn path the
 * control-plane `start` op uses. `agent` is required (the connector type; there is no
 * default connector). `name` is the persona REF (the file `.cotal/agents/<name>.md`, which
 * must exist); the booted peer presents under that file's own `name:`. `role`/`config`/`cwd` are
 * optional; persona/model come from the same file, and `cwd` roots the agent at a folder of its
 * own (default: the manager's workspace root). `share-tools` is an optional list narrowing the
 * operator's declared MCP servers for this agent, like `--share-tools` (absent: all; `[]`: none).
 */
export function loadRoster(path: string): StartAgentOpts[] {
  const doc: unknown = parse(readFileSync(path, "utf8"));
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as { agents?: unknown }).agents))
    throw new Error(`roster ${path}: expected a top-level "agents:" list`);
  const agents = (doc as { agents: unknown[] }).agents;
  return agents.map((entry, i) => {
    const at = `roster ${path}: agents[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`${at} is not a map`);
    const e = entry as Record<string, unknown>;
    const str = (k: string): string | undefined => {
      const v = e[k];
      if (v === undefined) return undefined;
      if (typeof v !== "string") throw new Error(`${at}.${k} must be a string`);
      return v;
    };
    const name = str("name")?.trim();
    if (!name) throw new Error(`${at} missing "name"`);
    const agent = str("agent")?.trim();
    if (!agent) throw new Error(`${at} (${name}) missing "agent" (e.g. claude / opencode)`);
    const share = e["share-tools"];
    if (share !== undefined && !(Array.isArray(share) && share.every((s) => typeof s === "string")))
      throw new Error(`${at}.share-tools must be a list of MCP server names`);
    // StartAgentOpts carries the `--share-tools` flag grammar, where an empty selection is `none`.
    const shareTools = share === undefined ? undefined : share.join(",") || "none";
    return { name, agent, role: str("role"), config: str("config"), cwd: str("cwd"), shareTools };
  });
}

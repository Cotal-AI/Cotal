import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { StartAgentOpts } from "./manager.js";

const ENTRY_KEYS = new Set(["name", "agent", "role", "config", "cwd", "share-tools"]);

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
 * Any other key, in an entry or beside `agents:`, is refused, because a misspelling such as
 * `share_tools` would otherwise boot the agent with the default the operator meant to override.
 */
export function loadRoster(path: string): StartAgentOpts[] {
  const doc: unknown = parse(readFileSync(path, "utf8"));
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as { agents?: unknown }).agents))
    throw new Error(`roster ${path}: expected a top-level "agents:" list`);
  const topKey = Object.keys(doc).find((k) => k !== "agents");
  if (topKey !== undefined) throw new Error(`roster ${path}: ${topKey} is not a roster key`);
  const agents = (doc as { agents: unknown[] }).agents;
  return agents.map((entry, i) => {
    const at = `roster ${path}: agents[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`${at} is not a map`);
    const e = entry as Record<string, unknown>;
    const key = Object.keys(e).find((k) => !ENTRY_KEYS.has(k));
    if (key !== undefined) throw new Error(`${at}.${key} is not a roster key`);
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
    const shareTools = e["share-tools"];
    if (shareTools !== undefined && (!Array.isArray(shareTools) || shareTools.some((s) => typeof s !== "string")))
      throw new Error(`${at}.share-tools must be a list of MCP server names`);
    return { name, agent, role: str("role"), config: str("config"), cwd: str("cwd"), shareTools };
  });
}

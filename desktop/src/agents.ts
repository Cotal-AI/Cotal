/** Pure view model for the daemon's local, public agent observations. */
export interface LocalAgent { name: string; application: string; model?: string; space: string; cwd: string; startedAt: string; state: "running" | "exited" }
export interface AgentInventory { agents: LocalAgent[]; unreadable: string[]; available: boolean }
export function agentInventory(status: Record<string, unknown>): AgentInventory {
  if (!Array.isArray(status.agents)) return { agents: [], unreadable: [], available: false };
  const agents: LocalAgent[] = [], unreadable: string[] = [];
  for (const raw of status.agents) {
    if (!raw || typeof raw !== "object" || typeof raw.space !== "string") throw new Error("Unsupported agent inventory.");
    if (raw.state === "unreadable") { unreadable.push(raw.space); continue; }
    if (raw.state !== "read" || !Array.isArray(raw.agents) || raw.agents.length > 50) throw new Error("Unsupported agent inventory.");
    for (const a of raw.agents) {
      if (!a || ["name", "application", "cwd", "startedAt"].some(key => typeof a[key] !== "string") || !Number.isFinite(Date.parse(a.startedAt)) || !["running", "exited"].includes(a.state)) throw new Error("Unsupported agent inventory.");
      agents.push({ name: a.name, application: applicationName(a.application), ...(typeof a.model === "string" ? { model: a.model } : {}), space: raw.space, cwd: a.cwd, startedAt: a.startedAt, state: a.state });
    }
  }
  agents.sort((a, b) => a.space.localeCompare(b.space) || a.name.localeCompare(b.name));
  return { agents, unreadable, available: true };
}
export function applicationName(value: string): string {
  return ({ "claude-code": "Claude Code", claude: "Claude Code", codex: "Codex", jcode: "Jcode", opencode: "OpenCode", pi: "pi", hermes: "Hermes" } as Record<string, string>)[value] ?? value;
}
export function shortFolder(path: string, limit = 42): string {
  if (path.length <= limit) return path;
  const side = Math.floor((limit - 1) / 2);
  return `${path.slice(0, side)}…${path.slice(-side)}`;
}
export function runningFor(startedAt: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(startedAt)) / 60_000);
  if (minutes < 1) return "Just started";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

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
  agents.sort((a, b) => a.space.localeCompare(b.space) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { agents, unreadable, available: true };
}
export function renderAgents(status: Record<string, unknown>, root: HTMLElement): void {
  const inventory = agentInventory(status);
  root.dataset.available = String(inventory.available);
  root.closest(".connection-card")?.classList.toggle("has-running-agents", inventory.agents.length > 0);
  const heading = root.querySelector("#agents-heading")!;
  let count = heading.querySelector<HTMLElement>(".agent-count");
  if (!count) { count = document.createElement("span"); count.className = "agent-count"; heading.replaceChildren(document.createTextNode("Running on this computer "), count); }
  count.textContent = inventory.unreadable.length || !inventory.available ? "(could not read)" : `(${inventory.agents.length})`;
  const list = root.querySelector<HTMLElement>("#agent-list")!;
  const empty = root.querySelector<HTMLElement>("#agents-empty")!;
  const warning = root.querySelector<HTMLElement>("#agents-unavailable")!;
  empty.hidden = inventory.agents.length > 0 || inventory.unreadable.length > 0 || !inventory.available;
  warning.hidden = inventory.available && !inventory.unreadable.length;
  warning.textContent = inventory.available ? `Could not read agents in ${inventory.unreadable.join(", ")}.` : "Agent inventory is unavailable. Update the background service to read it.";
  const keys = new Set<string>();
  if (inventory.agents.length > 6) list.tabIndex = 0;
  else list.removeAttribute("tabindex");
  for (const agent of inventory.agents) {
    const key = JSON.stringify([agent.space, agent.name, agent.startedAt]);
    keys.add(key);
    let row = Array.from(list.children).find(node => (node as HTMLElement).dataset.key === key) as HTMLElement | undefined;
    if (!row) {
      row = document.createElement("li"); row.className = "agent-row"; row.dataset.key = key;
      for (const name of ["agent-name", "agent-meta application-chip", "agent-folder", "agent-time"]) {
        const span = document.createElement("span"); span.className = name; row.append(span);
      }
      list.append(row);
    }
    const values = [shortFolder(agent.name, 28), agent.application, `${shortFolder(agent.cwd, 32)} · ${agent.space}`,  agent.state === "running" ? runningFor(agent.startedAt) : "Exited"];
    Array.from(row.children).forEach((node, i) => { if (node.textContent !== values[i]) node.textContent = values[i]!; });
    (row.children[0] as HTMLElement).title = agent.name;
    row.children[0]!.setAttribute("aria-label", agent.name);
    row.title = `${agent.name} · ${agent.application}${agent.model ? ` · Model: ${agent.model}` : ""}`;
    row.setAttribute("aria-label", `${row.title} · ${agent.cwd} · ${agent.space}`);
    (row.children[1] as HTMLElement).title = row.title;
    const folder = row.children[2] as HTMLElement; folder.title = agent.cwd; folder.setAttribute("aria-label", agent.cwd);
    (row.children[3] as HTMLElement).title = `Started ${agent.startedAt}`;
  }
  for (const row of Array.from(list.children)) if (!keys.has((row as HTMLElement).dataset.key!)) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || typeof row.animate !== "function") row.remove();
    else { const animation = row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 }); animation.onfinish = () => row.remove(); }
  }
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

import { updateScrollThumb } from "./scrollbars";

/** Pure view model for the daemon's local, public agent observations. */
export interface LocalAgent { name: string; lifecycleUid?: string; application: string; model?: string; space: string; cwd: string; startedAt: string; state: "running" | "exited" }
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
      agents.push({ name: a.name, ...(typeof a.lifecycleUid === "string" ? { lifecycleUid: a.lifecycleUid } : {}), application: applicationName(a.application), ...(typeof a.model === "string" ? { model: a.model } : {}), space: raw.space, cwd: a.cwd, startedAt: a.startedAt, state: a.state });
    }
  }
  agents.sort((a, b) => a.space.localeCompare(b.space) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { agents, unreadable, available: true };
}
export type AgentAction = "agent-stop" | "agent-terminal";
export function renderAgents(status: Record<string, unknown>, root: HTMLElement, controls?: { pending: ReadonlyMap<string, AgentAction>; act: (agent: LocalAgent, op: AgentAction) => void }): void {
  const inventory = agentInventory(status);
  root.dataset.available = String(inventory.available);
  root.closest(".connection-card")?.classList.toggle("has-running-agents", inventory.agents.length > 0);
  const heading = root.querySelector("#agents-heading")!;
  let count = heading.querySelector<HTMLElement>(".agent-count");
  if (!count) { count = document.createElement("span"); count.className = "agent-count"; heading.replaceChildren(document.createTextNode("Running on this computer "), count); }
  count.textContent = inventory.unreadable.length || !inventory.available ? "(could not read)" : `(${inventory.agents.length})`;
  const list = root.querySelector<HTMLElement>("#agent-list")!;
  list.classList.toggle("agent-list-with-controls", !!controls && (controls.pending.size > 0 || inventory.agents.some(agent => agent.lifecycleUid)));
  const empty = root.querySelector<HTMLElement>("#agents-empty")!;
  const warning = root.querySelector<HTMLElement>("#agents-unavailable")!;
  empty.hidden = inventory.agents.length > 0 || inventory.unreadable.length > 0 || !inventory.available;
  warning.hidden = inventory.available && !inventory.unreadable.length;
  warning.textContent = inventory.available ? `Could not read agents in ${inventory.unreadable.join(", ")}.` : "Agent inventory is unavailable. Update the background service to read it.";
  const keys = new Set<string>();
  if (inventory.agents.length > 6) list.tabIndex = 0;
  else list.removeAttribute("tabindex");
  for (const agent of inventory.agents) {
    const key = JSON.stringify([agent.space, agent.name, agent.lifecycleUid ?? agent.startedAt]);
    keys.add(key);
    let row = Array.from(list.children).find(node => (node as HTMLElement).dataset.key === key) as HTMLElement | undefined;
    if (!row) {
      row = document.createElement("li"); row.className = "agent-row"; row.dataset.key = key;
      for (const name of ["agent-name", "agent-meta application-chip", "agent-folder", "agent-time"]) {
        const span = document.createElement("span"); span.className = name; row.append(span);
      }
      if (agent.lifecycleUid && controls) {
        const actions = document.createElement("div"); actions.className = "agent-actions";
        for (const op of ["agent-stop", "agent-terminal"] as const) {
          const button = document.createElement("button"); button.className = "text-button"; button.type = "button"; button.dataset.op = op;
          button.addEventListener("click", () => controls.act(agent, op)); actions.append(button);
        }
        row.append(actions);
      }
      list.append(row);
    }
    const shown = shownAgentName(agent.name);
    const values = [shortFolder(shown, 28), agent.model ? `${agent.application} · ${agent.model}` : agent.application, `${shortFolder(agent.cwd, 32)} · ${agent.space}`, agent.state === "running" ? `Running · ${runningFor(agent.startedAt)}` : "Exited"];
    values.forEach((value, i) => { if (row.children[i]!.textContent !== value) row.children[i]!.textContent = value; });
    const pending = controls?.pending.get(key);
    for (const button of row.querySelectorAll<HTMLButtonElement>(".agent-actions button")) {
      const terminal = button.dataset.op === "agent-terminal";
      button.hidden = pending !== button.dataset.op && (agent.state !== "running" || terminal && status.agentTerminal !== true);
      button.disabled = pending !== undefined;
      button.textContent = terminal ? pending === "agent-terminal" ? "Opening terminal…" : "Open in Terminal" : pending === "agent-stop" ? "Stopping…" : "Stop";
      button.setAttribute("aria-label", `${button.textContent} ${shown}`);
    }
    if (agent.lifecycleUid) row.setAttribute("aria-busy", String(pending !== undefined));
    (row.children[0] as HTMLElement).title = shown;
    row.children[0]!.setAttribute("aria-label", shown);
    row.title = `${shown} · ${agent.application}${agent.model ? ` · Model: ${agent.model}` : ""}`;
    row.setAttribute("aria-label", `${row.title} · ${agent.cwd} · ${agent.space}`);
    (row.children[1] as HTMLElement).title = row.title;
    const folder = row.children[2] as HTMLElement; folder.title = agent.cwd; folder.setAttribute("aria-label", agent.cwd);
    (row.children[3] as HTMLElement).title = `Started ${agent.startedAt}`;
  }
  for (const row of Array.from(list.children)) if (!keys.has((row as HTMLElement).dataset.key!)) {
    if (controls?.pending.has((row as HTMLElement).dataset.key!)) continue;
    const remove = () => {
      row.remove();
      if (controls) updateScrollThumb(list, "agent-list");
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || typeof row.animate !== "function") remove();
    else { const animation = row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 }); animation.onfinish = remove; }
  }
}

/** The name a running-agent row shows. A missing or whitespace-only name is not one. This inventory
 *  has no separate id, so the row says it is unnamed rather than inventing one. */
export function shownAgentName(name: string): string {
  return name.trim() ? name : "(unnamed)";
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

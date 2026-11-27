/**
 * Codex's skills as a seat lists and runs them, shared by the seat's dispatcher (commands.ts) and the
 * list read before launch (extension.ts), which must not load the app-server driver.
 */
import type { CommandEntry } from "@cotal-ai/core";
import type { CodexSkill } from "./app-server.js";

/** The enabled skills by name. Codex lists a repo skill before a user or system skill of the same
 *  name, so the first entry of a name is the one listed and run. */
export function enabledSkills(listed: readonly CodexSkill[]): Map<string, CodexSkill> {
  const byName = new Map<string, CodexSkill>();
  for (const skill of listed) if (skill.enabled && !byName.has(skill.name)) byName.set(skill.name, skill);
  return byName;
}

/** What `skills/list` reported, as a seat lists it and runs it by name. */
export function codexSkillEntries(listed: readonly CodexSkill[]): CommandEntry[] {
  return [...enabledSkills(listed).values()].map((s) => ({ name: s.name, target: "skill", description: s.description }));
}

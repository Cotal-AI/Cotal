import { formatAge, presenceAges } from "./presence-ages.js";

// Plain text only; each renderer escapes it at its HTML boundary.
export function presenceFacts(p, now = Date.now()) {
  const ages = presenceAges(p, now);
  const facts = [];
  if (p.condition) facts.push(`${p.condition.code}${ages.conditionSince === undefined ? "" : ` for ${formatAge(ages.conditionSince)}`}`);
  if (ages.statusSince !== undefined) facts.push(`unchanged for ${formatAge(ages.statusSince)}`);
  if (ages.activeAt !== undefined) facts.push(`active ${formatAge(ages.activeAt)} ago`);
  if (ages.activitySince !== undefined) facts.push(`activity set ${formatAge(ages.activitySince)} ago`);
  return facts.join(" · ");
}

export function ago(ts, now = Date.now()) {
  const age = presenceAges({ activeAt: ts }, now).activeAt;
  return age === undefined ? "unknown" : formatAge(age);
}

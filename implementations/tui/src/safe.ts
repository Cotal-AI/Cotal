import { oneLine } from "@cotal-ai/workspace"

// MeshView hands out the same feed entry and presence objects until they change, so each is cleaned
// once and keeps its identity, and Solid redraws only rows that changed.
const clean = new WeakMap<object, unknown>()

/** Peers write names, activities and message text, and a control character in a cell reaches the
 *  terminal as is. Every string keeps its line breaks and tabs and shows any other control character
 *  as an escape. */
export function safe<T>(value: T): T {
  if (typeof value === "object" && value !== null && clean.has(value)) return clean.get(value) as T
  if (typeof value === "string") return value.replace(/\r\n/g, "\n").split("\n").map((line) => line.split("\t").map(oneLine).join("\t")).join("\n") as T
  if (typeof value === "function") return ((...args: unknown[]) => safe((value as (...a: unknown[]) => unknown)(...args))) as T
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(safe) as T
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)])) as T
  clean.set(value, out)
  return out
}

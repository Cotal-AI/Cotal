import { subjectMatches } from "../../src/subjects.js";

// Test-only contract prototype. These values describe permissions; they do not prove issuance.
export type SubjectAllow =
  | { readonly mode: "all" }
  | { readonly mode: "none" }
  | { readonly mode: "patterns"; readonly patterns: readonly string[] };

export interface SubjectPermission {
  readonly allow: SubjectAllow;
  readonly deny: readonly string[];
}

export interface IssuedSubjectPermissions {
  readonly publish: SubjectPermission;
  readonly subscribe: SubjectPermission;
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error(`${label} must be a plain record`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key))
      throw new Error(`${label} contains an unsupported field`);
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))
      throw new Error(`${label} cannot contain accessors`);
  }
  return value as Record<string, unknown>;
}

function subject(value: unknown, pattern: boolean): string {
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)
    || [...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
    throw new Error("subject must be nonempty, without whitespace or control characters; queue-qualified forms are unsupported");
  const parts = value.split(".");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || (part.includes("*") && (!pattern || part !== "*"))
      || (part.includes(">") && (!pattern || part !== ">" || i !== parts.length - 1)))
      throw new Error("subject has an invalid token or wildcard");
  }
  return value;
}

function patterns(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("subject patterns must be an explicit array");
  const copy: string[] = [];
  for (const entry of value) copy.push(subject(entry, true));
  return Object.freeze(copy);
}

function permission(allow: SubjectAllow, deny: readonly string[]): SubjectPermission {
  return Object.freeze({ allow: Object.freeze(allow), deny });
}

export function readSubjectPermission(value: unknown): SubjectPermission {
  const raw = record(value, ["allow", "deny"], "subject permission");
  const allow = record(raw.allow, ["mode", "patterns"], "subject allow");
  const deny = patterns(raw.deny);
  if (allow.mode === "all" || allow.mode === "none") {
    if (Object.hasOwn(allow, "patterns")) throw new Error("only patterns mode accepts a patterns field");
    return permission({ mode: allow.mode }, deny);
  }
  if (allow.mode !== "patterns") throw new Error("unsupported subject allow mode");
  const listed = patterns(allow.patterns);
  if (listed.length === 0) throw new Error("patterns mode requires a nonempty list");
  return permission({ mode: "patterns", patterns: listed }, deny);
}

/** Application scope is explicit: an empty allow list means no requested authority. */
export function requestedSubjectPermission(allow: unknown, deny: unknown = []): SubjectPermission {
  const listed = patterns(allow);
  return permission(listed.length ? { mode: "patterns", patterns: listed } : { mode: "none" }, patterns(deny));
}

/** Native NATS omitted/empty allow lists mean unrestricted, subject to denies. */
function importDirection(value: unknown): SubjectPermission {
  if (value === undefined) return permission({ mode: "all" }, Object.freeze([]));
  const raw = record(value, ["allow", "deny"], "native subject permission");
  const allow = Object.hasOwn(raw, "allow") ? patterns(raw.allow) : Object.freeze([]);
  const deny = Object.hasOwn(raw, "deny") ? patterns(raw.deny) : Object.freeze([]);
  return permission(allow.length ? { mode: "patterns", patterns: allow } : { mode: "all" }, deny);
}

export function importNativeSubjectPermissions(value: unknown): IssuedSubjectPermissions {
  // Accept only the permission fragment, not an entire JWT. resp and queue-qualified rules
  // need their own supported semantics and are deliberately refused in this prototype.
  const raw = record(value, ["pub", "sub"], "native permissions");
  for (const key of ["pub", "sub"]) {
    if (Object.hasOwn(raw, key) && raw[key] === undefined)
      throw new Error("an explicit native direction must not be undefined");
  }
  return Object.freeze({ publish: importDirection(raw.pub), subscribe: importDirection(raw.sub) });
}

export function exportNativeSubjectPermission(value: SubjectPermission): { allow: readonly string[]; deny: readonly string[] } {
  const parsed = readSubjectPermission(value);
  const allow = parsed.allow.mode === "patterns" ? parsed.allow.patterns : Object.freeze([">"]);
  const deny = parsed.allow.mode === "none" ? Object.freeze([...parsed.deny, ">"]) : parsed.deny;
  return Object.freeze({ allow, deny });
}

export function permitsSubject(value: SubjectPermission, concrete: string): boolean {
  const parsed = readSubjectPermission(value);
  subject(concrete, false);
  if (parsed.deny.some((pattern) => subjectMatches(pattern, concrete))) return false;
  if (parsed.allow.mode === "none") return false;
  return parsed.allow.mode === "all" || parsed.allow.patterns.some((pattern) => subjectMatches(pattern, concrete));
}

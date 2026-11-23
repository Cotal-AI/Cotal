export type UsernamePolicy =
  | { source: "claims"; emailLocalPart?: boolean }
  | { source: "directory" };

export function parseUsernamePolicy(raw: unknown): UsernamePolicy {
  if (raw === undefined) return { source: "claims" };
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    if (row.source === "directory" && Object.keys(row).length === 1) return { source: "directory" };
    if (row.source === "claims" && Object.keys(row).every((key) => key === "source" || key === "emailLocalPart") &&
        (row.emailLocalPart === undefined || typeof row.emailLocalPart === "boolean"))
      return row.emailLocalPart ? { source: "claims", emailLocalPart: true } : { source: "claims" };
  }
  throw new Error('username configuration must set source to "claims" or "directory"; only claims may set the boolean emailLocalPart');
}

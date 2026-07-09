/**
 * A managed user-mode agent's last bearer-refresh outcome — written by the auth provider's bearer
 * command after EVERY attempt (`--health-file <path>`, the path composed by the manager), read by
 * the manager's `ps` path. WORKSTATION-layer state (this module is exactly why the workspace tier
 * exists): the auth implementation writes it, the manager renders it, neither may import the
 * other, and it is not wire/protocol substance — so it lives here, not in core. A detached agent's
 * silent bearer death has exactly one operator window — `ps` — and this file is what makes that
 * window see it.
 */
import { readFileSync } from "node:fs";

export interface AgentAuthHealth {
  state: "ok" | "failed";
  /** The operator-exact failure sentence (the bearer command's own copy), when failed. */
  reason?: string;
  /** ISO timestamp of the attempt. */
  at: string;
}

/** A live managed agent's health, as `ps` should render it. Absence/malformation is AMBIGUOUS, not
 *  healthy (the preflight writes the first `ok` record before launch, so a live agent always has
 *  one — a missing file means someone removed it or the record never landed): `auth-unknown`.
 *  A record past `staleMs` on a live agent means refreshes stopped happening at all (the refresh
 *  cadence is a few minutes): `auth-stale`. Never silent-healthy. */
export function agentAuthState(
  path: string,
  staleMs = 15 * 60_000,
): { state: "ok" | "auth-renewal-failed" | "auth-unknown" | "auth-stale"; reason?: string } {
  const rec = readAgentAuthHealth(path);
  if (!rec) return { state: "auth-unknown", reason: "no readable bearer-refresh record - if this persists, respawn the agent" };
  if (rec.state === "failed") return { state: "auth-renewal-failed", ...(rec.reason ? { reason: rec.reason } : {}) };
  const age = Date.now() - Date.parse(rec.at);
  if (!Number.isFinite(age) || age > staleMs)
    return { state: "auth-stale", reason: `last successful bearer refresh was ${Number.isFinite(age) ? Math.round(age / 60_000) + " min" : "an unreadable time"} ago - the agent may be wedged; respawn it` };
  return { state: "ok" };
}

/** Read + validate an {@link AgentAuthHealth} file. Undefined when absent (no attempt yet) or
 *  unreadable/malformed (surfaced as unknown by {@link agentAuthState}, never a crash in `ps`). */
export function readAgentAuthHealth(path: string): AgentAuthHealth | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentAuthHealth;
    if ((parsed.state === "ok" || parsed.state === "failed") && typeof parsed.at === "string")
      return { state: parsed.state, at: parsed.at, ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) };
    return undefined;
  } catch {
    return undefined;
  }
}

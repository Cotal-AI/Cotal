/**
 * The control-surface broker floor (SPEC §13.12, D10).
 *
 * The endpoint surface REQUIRES NATS server >= 2.12: message schedules back durable timers,
 * and per-subject create-CAS backs canonical acceptance. There is no sweeper fallback and no
 * degraded mode; below the floor (or when a required capability is absent, e.g. the
 * offline-assets downgrade) startup fails loud. Only 2.12 schedule semantics may be assumed
 * (same-subject replacement) — never the 2.14 stop-plus-publish path.
 */

/** The minimum broker for the endpoint control surface. */
export const BROKER_FLOOR = { major: 2, minor: 12 } as const;

/** Structural slice of a NATS connection: the pre-auth INFO carries the server version. */
export interface BrokerInfoSource {
  info?: { version?: string };
}

/** Parse a nats-server version string ("2.12.3", "2.12.0-beta.1") into comparable parts. */
export function parseServerVersion(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True iff the version meets the control-surface floor. */
export function meetsBrokerFloor(version: string): boolean {
  const p = parseServerVersion(version);
  if (!p) return false;
  if (p.major !== BROKER_FLOOR.major) return p.major > BROKER_FLOOR.major;
  return p.minor >= BROKER_FLOOR.minor;
}

/** Startup gate: throw (loud, fail-closed) unless the connected broker meets the floor.
 *  Call before creating or serving any control-surface resource. A missing/unparseable
 *  version is a refusal, not a pass — no fallbacks. */
export function requireBrokerFloor(nc: BrokerInfoSource): void {
  const version = nc.info?.version;
  if (!version)
    throw new Error("control surface: connected broker reports no server version; refusing to start (floor is nats-server >= 2.12)");
  if (!meetsBrokerFloor(version))
    throw new Error(`control surface: nats-server ${version} is below the required floor 2.12; upgrade the broker (no degraded mode exists)`);
}

/**
 * The control-surface broker floor (SPEC §13.12, D10).
 *
 * The endpoint surface REQUIRES NATS server >= 2.12: message schedules back durable timers,
 * and per-subject create-CAS backs canonical acceptance. There is no sweeper fallback and no
 * degraded mode; below the floor (or when a required capability is absent, e.g. the
 * offline-assets downgrade) startup fails loud. Only 2.12 schedule semantics may be assumed
 * (same-subject replacement) — never the 2.14 stop-plus-publish path.
 */

/** The minimum broker for the endpoint control surface. Runtime-frozen (the afa715b class): a
 *  post-import `minor = 0` would silently bypass the mandatory 2.12 startup gate. */
export const BROKER_FLOOR = Object.freeze({ major: 2, minor: 12 } as const);

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

/**
 * The broker floor for a credential that carries an exclusion (a `sub`/`pub` deny row).
 *
 * nats-server below 2.12.7 on the 2.12 line, and below 2.14.0, delivers a denied subject to a
 * wildcard subscription that overlaps the deny (CVE-2026-58252, GHSA-wh7g-5m82-pmhr) and lets a queue
 * subscribe bypass a subject deny (CVE-2026-58251, GHSA-jx8g-9g95-6322). An exclusion minted for such a
 * broker removes nothing. Only a stable `MAJOR.MINOR.PATCH` counts: a pre-release or build suffix may
 * predate the fix, so it refuses, as do 2.13.x, a missing version and an unparseable one.
 */
export function meetsExclusionFloor(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major !== 2) return major > 2;
  return minor >= 14 || (minor === 12 && patch >= 7);
}

/** Throw unless `version` meets {@link meetsExclusionFloor}. `who` names the broker in the error. */
export function requireExclusionFloor(version: string | undefined, who = "the broker"): void {
  if (!meetsExclusionFloor(version))
    throw new Error(
      `channel exclusions need nats-server 2.12.7 or later on the 2.12 line, or 2.14.0 or later, and ${who} reports ` +
        `${version === undefined ? "no version" : `"${version}"`}: older servers deliver a denied channel to an overlapping wildcard ` +
        `subscription (CVE-2026-58252, CVE-2026-58251). Upgrade the broker, or grant without exclusions`,
    );
}

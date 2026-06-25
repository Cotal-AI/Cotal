/**
 * Resolved launch spec (`cotal-launch/v1`) — the handoff from the CLI's mesh-manifest resolver to
 * the manager's `supervise --launch`. Each agent is already fully resolved: the manager mints creds
 * from `policy` and never re-reads a persona file for authority. This is a **deployment artifact**,
 * not the wire contract — it lives in core only because it's the one module both `implementations/cli`
 * (producer) and `implementations/manager` (consumer) can share. The manager validates it as
 * untrusted input at load.
 */

/** One agent's effective, resolved launch form. (`Mesh`-prefixed to avoid the connector's
 *  process-launch {@link LaunchSpec}/recipe — this is the deployment-manifest launch.) */
export interface MeshLaunchAgent {
  /** Requested mesh identity / spawn name (auto-numbered on collision at spawn). */
  name: string;
  /** Connector type to spawn with (claude / opencode / hermes / …). */
  agent: string;
  role?: string;
  model?: string;
  description?: string;
  /** Persona body — materialized to a transient, non-authoritative file the connector reads. */
  body?: string;
  capabilities?: string[];
  /** Effective merged read set — the sole creds authority (not re-read from any file). */
  subscribe: string[];
  /** Effective merged read ACL. */
  allowSubscribe: string[];
  /** Effective merged post ACL (default-deny). */
  allowPublish: string[];
  /** Original persona path — for user-facing output only; never read for authority. */
  personaPath?: string;
  /** Content hash of the resolved launch fields (drift detection: a changed hash ⇒ restart-required). */
  hash: string;
}

/** The launch spec file written by `cotal up -f` / `spawn -f` and read by `supervise --launch`. */
export interface MeshLaunchSpec {
  apiVersion: "cotal-launch/v1";
  space: string;
  /** Identifies this apply run: names the transient `.cotal/run/<runId>/` dir and ties to the ledger. */
  runId: string;
  agents: MeshLaunchAgent[];
}

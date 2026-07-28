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
  variant?: string;
  /** Opaque connector-specific launch options (see {@link LaunchOpts.launchOptions}). */
  launchOptions?: Record<string, unknown>;
  description?: string;
  /** Persona body — materialized to a transient, non-authoritative file the connector reads. */
  body?: string;
  /** Kickoff prompt auto-submitted at session start (the manifest's `prompt:`), forwarded to the
   *  connector exactly like the imperative `--prompt`. Part of the launch form: re-submitted on
   *  every (re)start under this entry, and hash-covered so a change marks a running agent stale. */
  prompt?: string;
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
  /** USER-AUTH meshes only: the derived owner (`u_…`) every launched agent runs under — the
   *  logged-in operator who applied the manifest, resolved at apply time (`ownerForLogin`). The
   *  manager refuses a user-mesh launch spec without one (fail loud, never a guessed owner). */
  owner?: string;
  agents: MeshLaunchAgent[];
}

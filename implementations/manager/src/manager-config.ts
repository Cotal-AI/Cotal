import type { SecretStore } from "@cotal-ai/core";
import type { SeatCap } from "@cotal-ai/workspace";
import type { ManagerOptions } from "./manager.js";

/** What the Manager knows about itself from construction: its identity, its operator settings and its
 *  timing. The Manager builds one and hands every part the same object, read-only. No shipped code
 *  writes a member after the constructor returns. The three timings (readinessTimeoutMs,
 *  staticReconcileRetryDelaysMs, goalAcceptanceRetentionMs) are writable so a test can shorten them
 *  through the Manager's own reference, and a test may overwrite another member through a cast; a
 *  part reads every member at use, so an overwritten value is current. */
export interface ManagerConfig {
  readonly space: string;
  readonly servers: string | undefined;
  /** The broker ws listener port (loopback) `cotal up` allocated, for the console session
   *  client's wsUrl. Undefined ⇒ no console session client (POST /session 503s). */
  readonly wsPort?: number;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly eventsRequired: boolean;
  readonly eventPayloadsWithheld: boolean;
  /** The operator-set global live-session ceiling (see {@link ManagerOptions.maxSessions}). */
  readonly maxSessions?: number;
  /** The operator-set per-owner seat ceiling (see {@link ManagerOptions.seatCap}). */
  readonly seatCap: SeatCap;
  /** The ONE secret store for every kind this manager touches (daemon-cred remint + agent kinds).
   *  See {@link ManagerOptions.secretStore}. */
  readonly secrets: SecretStore;
  readonly expectedConnectorGeneration: string;
  readonly machineSetupCommand?: string;
  readonly execution: "runtime" | "none";
  /** Hosted pooled control, recorded so a later seat cannot add a custodial runtime the constructor
   *  already refused for the manager's own. */
  readonly pooled: boolean;
  readonly endpointServeExecutorExpiresInSeconds?: number;
  /** This manager process's own incarnation uid (SPEC 13.1; minted once per supervisor process,
   *  never reused across restarts) — the endpoint's presence key AND the `managerInstance` audit
   *  coordinate every static activation records. */
  readonly managerLifecycleUid: string;
  readonly onServiceIdentity?: ManagerOptions["onServiceIdentity"];
  /** Process start, for the served `status` uptime. */
  readonly startedAtMs: number;
  readonly shutdownReadiness: AbortController;
  readonly resumeAttemptId?: string;
  readonly preserveStopTimeoutMs: number;
  /** Readiness-race backstop: the READINESS_TIMEOUT_MS constant, writable so a test can
   *  shorten it (the join/exit signals are event-driven; only the backstop is timed). Production
   *  leaves it at the constant. */
  readinessTimeoutMs: number;
  /** Held here so broker-owning smokes can compress the schedule without changing production
   *  semantics. It is never a fence expiry: the durable non-retired row stays authoritative. */
  staticReconcileRetryDelaysMs: readonly number[];
  /** How long a terminal goal's acceptance stays in the Manager's goal acceptances: the retry window
   *  its turn twin keeps a settled answer for. Writable so a test can shorten it. */
  goalAcceptanceRetentionMs: number;
}

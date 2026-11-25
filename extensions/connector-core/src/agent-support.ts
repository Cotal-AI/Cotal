import { hostname } from "node:os";
import { AGENT_LABEL_META_KEY, AGENT_NAMING_META_KEY, type DmDurableMissingError, type Presence } from "@cotal-ai/core";
import { eventPlaneArmed, type AgentConfig } from "./config.js";
import type { CommandDispatcher } from "./agent-commands.js";
import type { AgentNaming } from "./agent-naming.js";

/** Grace for a mesh op issued while the link is still coming up. `start()` deliberately returns
 *  immediately so the connector's MCP surface boots while the broker is absent — which means a
 *  host that auto-submits a prompt (`cotal spawn --prompt`) can call a mesh tool a second or two
 *  after launch, several seconds before the first bind lands. Failing that call on the spot
 *  reports "the mesh is down" about a mesh that is merely still connecting, and the agent then
 *  repeats it to the user as fact. Waiting the window out is the honest answer; the bound is what
 *  keeps a genuinely dead broker from becoming a hang instead of an error. */
export const CONNECT_GRACE_MS = 10_000;

/** The card key that says whether this session arms its event plane. Namespaced, because SPEC §11
 *  reserves bare meta keys to the spec. */
export const EVENTS_META_KEY = "ai.cotal.events";

/** The display-only `AgentCard.meta` for a session. Agent-file metadata is preserved, then
 *  connector-owned fields are overlaid so files cannot spoof the hosting harness. `naming` shows the
 *  seat's labelling from its first message as pending. */
export function buildMeta(config: AgentConfig, processCwd: boolean, eventsArmed?: boolean, naming?: boolean): Record<string, string> | undefined {
  const meta: Record<string, string> = { ...(config.meta ?? {}) };
  if (config.model) meta.model = config.model;
  if (config.variant) meta.variant = config.variant;
  if (config.connector) meta.connector = config.connector;
  // WHICH MACHINE this agent runs on. A mesh spans hosts (a manager on another box launches into
  // its own machine), so "where is this agent actually running" is not answerable from the roster
  // without it. This process IS the agent's session, so its own hostname is the authoritative
  // answer — and, like `connector`, it is overlaid LAST so an agent file cannot declare a host it
  // is not on. Advisory display metadata, never an authorization or routing input.
  meta.host = hostname();
  // A routing hint only. The broker's instance grants and the manager's live map still decide.
  delete meta["ai.cotal.manager.instance"];
  if (config.managerInstanceId) meta["ai.cotal.manager.instance"] = config.managerInstanceId;
  // Whether the session arms its event plane, from the predicate the emitting connectors branch on.
  // Overlaid with the other connector-owned keys, so an agent file cannot declare it. Advisory.
  meta[EVENTS_META_KEY] = (eventsArmed ?? eventPlaneArmed(config)) ? "on" : "off";
  // Only the seat's own naming writes these keys, so an agent file can neither hold a seat at pending
  // nor give it a label.
  if (naming) meta[AGENT_NAMING_META_KEY] = "pending";
  else delete meta[AGENT_NAMING_META_KEY];
  delete meta[AGENT_LABEL_META_KEY];
  // Snapshot the connector process directory when the session is constructed. This is display
  // metadata, not a model harness's later shell directory or a routing/authorization input. A
  // connector whose process directory is not the session's leaves it unknown until the harness
  // reports one (`setCwd`); an agent-file value never stands in for it.
  if (processCwd) meta.cwd = process.cwd();
  else delete meta.cwd;
  return Object.keys(meta).length ? meta : undefined;
}

/** Connector-owned construction options, never read from an agent file. */
export interface MeshAgentOptions {
  /** The connector process directory is not this session's (one process hosts several sessions),
   *  so `meta.cwd` stays unknown until the harness reports it through {@link MeshAgent.setCwd}. */
  withholdProcessCwd?: boolean;
  /** The connector already decided to arm the event plane, then removed `COTAL_EVENTS` from the
   *  process environment. The card and startup check follow this decision. */
  eventsArmed?: boolean;
  /** The event state root read by the connector before it scrubbed the process environment. */
  eventsWorkspaceRoot?: string;
  /** A once task this seat pulled and did not claim within `ONCE_HANDOFF_MS` in once.ts is sealed and
   *  reported. For a connector whose wake for the task is a push it cannot confirm, so a dead push
   *  cannot hold a served task. */
  onceClaimBound?: boolean;
  /** Lists and starts the harness commands and skills this agent's `agent` endpoint offers. Without
   *  one, `commands` answers `supported: false` and `command` is refused. */
  commands?: CommandDispatcher;
  /** How the connector labels a seat launched with `COTAL_AUTO_NAME` from its first message (SPEC
   *  13.22). Without it such a seat shows no label and never shows `ai.cotal.naming`. */
  naming?: AgentNaming;
}

/** Host-authorized participation for one native personal connection. The connector validates the
 * identity fields against the live connection before arming its existing self-only turn relay. */
export interface NativeTurnParticipationLease {
  owner: string;
  actor: string;
  lifecycleUid: string;
  name: string;
  managerInstanceId: string;
  expiresAt: number;
}

/** Reply correlation for outgoing messages (SPEC §5): `contextId` is the asker's conversation id,
 *  `replyTo` the id of the message being answered. */
export interface Correlation {
  contextId?: string;
  replyTo?: string;
  /** The peer whose conversation the call runs in, for a caller with its own `contextId`: a DM to
   *  that peer answers it, and a DM to any other peer is a new question. */
  peerId?: string;
}
/** Repeated async NATS status errors can arrive once per ordered-consumer retry. They describe one
 * fault, not one hundred useful facts; keep the first visible and summarize at most twice a minute. */
export const ENDPOINT_ERROR_LOG_WINDOW_MS = 30_000;
/** How many distinct endpoint notices {@link MeshAgent.logEndpointNotice} remembers for repeat
 *  suppression, oldest forgotten first, so a server producing novel error text on every request
 *  cannot grow the map. */
export const MAX_ENDPOINT_NOTICES = 16;


export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForStop(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, 3_000); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The five states a caller has to tell apart, derived in one place so every consumer agrees.
 *
 * `degraded` is the one that matters and the one a single boolean gets wrong: the endpoint is bound
 * but the socket underneath it is down, so sends queue or fail while the client reconnects. It is
 * NOT the same as `disconnected`, and it is not a stopped session either. `stopped` is terminal and
 * is not a fault at all.
 */
export type ConnectionState = "ready" | "stalled" | "degraded" | "connecting" | "disconnected" | "stopped";

/**
 * How long a non-empty automatic queue may make no progress before this session stops calling
 * itself `ready` (#1233).
 *
 * Generous on purpose. A healthy seat commits automatic deliveries within seconds of the turn that
 * carries them, and the incident this bound exists for ran for HOURS: 27 deliveries held 13.8h
 * behind timed-out soft interrupts, reported `ready` throughout. Ten minutes is far outside normal
 * turn length and far inside the window in which an operator still has a healthy seat to save.
 */
export const AUTOMATIC_QUEUE_STALL_MS = 600_000;

/** One {@link MeshAgent.readRoster}: the roster, and why it is last-known when the read failed. */
export interface RosterRead {
  roster: Presence[];
  failure?: Error;
}

/** Why an authenticated session whose DM durable is gone cannot reconnect, and what restores it. The
 *  route comes first because the orientation card shows only the first 300 characters. */
export function missingInboxIssue(e: DmDurableMissingError): string {
  return "this session's direct-message inbox is missing on the broker, and on an authenticated mesh only a new launch " +
    "creates one, so reconnecting cannot restore it. Restart this session, or respawn it if a manager launched it. " +
    `Missing durable "${e.durable}" on stream "${e.stream}". Retries continue in case a broker restore brings it back.`;
}

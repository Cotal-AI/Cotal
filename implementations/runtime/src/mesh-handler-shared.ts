/** Constants and helpers shared by the mesh handler and its components (pause timers, seat watch,
 *  turn and ask): poll and deadline bounds, seat and agent-handle readings, the permit and supervise
 *  readers, and the spawn despawn target. A leaf: it imports no sibling of the handler. */
import {
  replyTargetUnmapped,
  type EpError,
  type GoalResultFact,
} from "@cotal-ai/core";
import {
  parseDuration,
} from "@cotal-ai/lang";

/**
 * A checkpoint resumed with no answer to read.
 *
 * The settle fact is the arbiter and it NAMES the answer it accepted, so a `resumed` settlement
 * with no id — or with an id no record answers to — means the token was presented by something
 * other than the run driver's own `resolveCheckpoint`. There is no honest value to return for it:
 * the program asked a question, something released the pause, and what was answered is not
 * recoverable. Returning `resolved` with an empty value would invent one.
 */
export class CheckpointAnswerMissing extends Error {
  constructor(readonly token: string, readonly answerId: string | undefined) {
    super(
      `checkpoint "${token}" settled as resumed but ${answerId === undefined
        ? "its settle fact names no answer"
        : `no answer record exists under the id ${answerId} it names`}; ` +
        `a workflow checkpoint is answered through the run driver's resolveCheckpoint, which writes the answer BEFORE presenting the token`,
    );
    this.name = "CheckpointAnswerMissing";
  }
}

/** How long one poll of a wait's consumer blocks. The deadline itself is durable; this is only how
 *  late its observation can be, and a shorter poll buys latency at the cost of fetch traffic. */
export const WAIT_POLL_MS = 2_000;

/** The budgets this host meters for an agent, read from the spawn's `permits` record. */
export type AgentPermits = { turns?: number; wallClockMs?: number };

/** What an `expired` turn refusal shows. The placed host speaks for its own seat. A class-rail
 *  target-unmapped refusal says only that no member the call reached maps the seat: in a space with
 *  more than one manager a live seat on a member it missed answers the same as a dead one. */
export function seatDownReading(err: EpError, host: string | undefined): string {
  if (host !== undefined) return `found the agent down on its placed host ${host}`;
  return replyTargetUnmapped(err)
    ? "found the agent down or unreachable (no manager the class rail reached maps it; a live seat on a member the call missed answers the same)"
    : "found the agent down";
}

/** The restart budget this host asks the manager to enforce for a spawn. */
type AgentSupervise = { restarts: number; windowMs: number };

/**
 * Read a spawn's `supervise` as the restart policy this host can enforce: `restarts`, a positive
 * integer of in-window process deaths the manager may restart under the same handle, and
 * `window`, an optional duration (default `10m`) those deaths are counted in. Anything else is a
 * policy this host has no restart for, and a policy it cannot enforce is refused loudly rather
 * than accepted as a silent no-op.
 */
export function readSupervise(raw: unknown, persona: string): AgentSupervise {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`spawn(${persona}): supervise must be a record of { restarts, window? }, got ${JSON.stringify(raw)}`);
  let restarts: number | undefined;
  let windowMs: number | undefined;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "restarts") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
        throw new Error(`spawn(${persona}): supervise.restarts must be a positive integer, got ${JSON.stringify(value)}`);
      restarts = value;
    } else if (key === "window") {
      if (typeof value !== "string")
        throw new Error(`spawn(${persona}): supervise.window must be a duration string, got ${JSON.stringify(value)}`);
      windowMs = parseDuration(value);
    } else {
      throw new Error(`spawn(${persona}): supervise.${key} is not a restart policy this host enforces; it takes restarts and window, and a policy it cannot enforce is refused rather than ignored`);
    }
  }
  if (restarts === undefined)
    throw new Error(`spawn(${persona}): supervise.restarts must be a positive integer`);
  return { restarts, windowMs: windowMs ?? parseDuration("10m") };
}

/**
 * Read a spawn's `permits` as the budgets this host can enforce: `turns`, a positive integer of
 * turns the run may dispatch to the agent, and `wallClock`, a duration from the spawn after which
 * no turn is admitted. Anything else (tokens, spend) is a budget this host has no meter for, and a
 * budget it cannot enforce is refused loudly rather than accepted as a silent no-op.
 */
export function readPermits(raw: unknown, persona: string): AgentPermits {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`spawn(${persona}): permits must be a record of budgets, got ${JSON.stringify(raw)}`);
  const out: AgentPermits = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "turns") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
        throw new Error(`spawn(${persona}): permits.turns must be a positive integer, got ${JSON.stringify(value)}`);
      out.turns = value;
    } else if (key === "wallClock") {
      if (typeof value !== "string")
        throw new Error(`spawn(${persona}): permits.wallClock must be a duration string, got ${JSON.stringify(value)}`);
      out.wallClockMs = parseDuration(value);
    } else {
      throw new Error(`spawn(${persona}): permits.${key} is a budget this host has no meter for; it meters turns and wallClock, and a budget it cannot enforce is refused rather than ignored`);
    }
  }
  return out;
}

/** How often an action's durable terminal fact is looked for. Same argument as `WAIT_POLL_MS`. */
export const GOAL_POLL_MS = 2_000;

/** How long one acceptance round-trip may take. The ACCEPT is synchronous and cheap on the far
 *  side (the manager replies at identity mint, before any provision), so this bounds a lost
 *  broker, not the spawn itself — the spawn's own outcome rides the goal terminal. */
export const SPAWN_ACCEPT_DEADLINE_MS = 30_000;

/** Bound on the manager's synchronous `turn` ACCEPT reply (the relay registration, not the yield). */
export const TURN_ACCEPT_DEADLINE_MS = 30_000;

/** How many class-rail calls a despawn, a relay withdrawal or a lapse's inspect sends before it stops
 *  waiting for the one manager that holds its goal (the spawn's allocator, the relay's accepter) to
 *  answer. Each is one {@link MeshHandler.invokeManager} call, whose describe and invoke both land on
 *  that manager with probability 1/m^2 per trip in a space of m managers, so one call reaches it with
 *  probability (1 - ((m-1)/m)^17) / m: about 1/2 for m = 2 and 0.25 for m = 4. All 65 then miss
 *  with probability about 2^-65 and 9e-9. */
export const MANAGER_ROUTE_ATTEMPTS = 64;

/** What phase A establishes and the step journal keeps: the canonical directory as the SERVING host
 *  stated it, plus the authoritative identity that stated it. Phase B dispatches `cwd` from here. */
export interface CwdResolution {
  cwd: string;
  endpoint: string;
  instanceId: string;
  host?: string;
}

/** The despawn target for a discharged spawn: the identity a SUCCEEDED terminal records (`id` is
 *  the `owner.actor` principal, `lifecycleUid` the incarnation), else the bound acceptance floor,
 *  else what any other terminal records. A host that enrolls a user-auth agent picks its lifecycle
 *  after the acceptance, so only the terminal names the incarnation that came up. `undefined` when
 *  none names an agent. */
export function spawnDespawnTarget(
  external: Readonly<Record<string, unknown>> | undefined,
  fact: GoalResultFact,
): { owner: string; actor: string; lifecycleUid: string } | undefined {
  const recorded = terminalAgent(fact);
  if (fact.state === "succeeded" && recorded !== undefined) return recorded;
  if (typeof external?.owner === "string" && typeof external.actor === "string" && typeof external.uid === "string")
    return { owner: external.owner, actor: external.actor, lifecycleUid: external.uid };
  return recorded;
}

/** The agent a spawn terminal records, when its `id` is an `owner.actor` principal. */
function terminalAgent(fact: GoalResultFact): { owner: string; actor: string; lifecycleUid: string } | undefined {
  const d = fact.data as { id?: unknown; lifecycleUid?: unknown } | undefined;
  if (typeof d?.id !== "string" || typeof d.lifecycleUid !== "string") return undefined;
  const dot = d.id.indexOf(".");
  if (dot <= 0 || dot === d.id.length - 1) return undefined;
  return { owner: d.id.slice(0, dot), actor: d.id.slice(dot + 1), lifecycleUid: d.lifecycleUid };
}

/** Split an agent handle `<name>#<lifecycleUid>` on its LAST `#` — the uid alphabet
 *  (`[a-z0-9]{26,32}`) cannot carry one, a name could. */
export function parseAgentHandle(agent: string): { name: string; uid: string } {
  const i = agent.lastIndexOf("#");
  if (i <= 0 || i === agent.length - 1)
    throw new Error(`"${agent}" is not an agent handle of the form <name>#<lifecycleUid>`);
  return { name: agent.slice(0, i), uid: agent.slice(i + 1) };
}

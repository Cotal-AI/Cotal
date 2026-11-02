// A managed launch: the request a surface sends to a manager's `start` command and the joined
// result it reads back. The `@cotal-ai/workspace/launch` subpath is this module. Flags, prompts,
// refusal remedies and the printed report belong to each surface.
import type { ManagerRequestIntent, ManagerRequestReceipt } from "./control/manager.js";
import { CommandFailure } from "./output.js";

/** What one managed launch asks the manager for. */
export interface ManagedLaunchRequest {
  /** The persona the manager loads: a name in its catalog, or the file `config` names on its host. */
  persona: string;
  config?: string;
  /** The agent's name, when it is not the persona file's `name:`. */
  identity?: string;
  role?: string;
  /** An explicit harness. It ranks above the persona file's pin, which ranks above `defaultAgent`. */
  agent?: string;
  /** The caller's default harness, kept apart from `agent` so it never beats the persona file's pin. */
  defaultAgent?: string;
  model?: string;
  variant?: string;
  supervise?: { restarts: number; windowMs: number };
  launchOptions?: Record<string, string>;
  cwd?: string;
  /** A host-local session id. The manager checks that the connector can resume it. */
  resume?: string;
  /** The transcript claim the caller carried for `resume`, and the harness it carried it with. */
  resumeClaim?: { claim: string; agent: string };
  prompt?: string;
  shareTools?: readonly string[];
  subscribe?: string[];
  allowSubscribe?: string[];
  allowPublish?: string[];
  /** Whether the agent publishes an event plane. Absent leaves it to the manager and the space's policy. */
  events?: boolean;
  runtime?: string;
}

/** Sends the manager's `start` command with `args` and resolves with its reply. The caller owns the
 *  control connection, the manager pin and the request window. */
export type ManagerStart<R> = (args: Record<string, unknown>) => Promise<R>;

/** Send `request` to a manager as its `start` command. The reply comes back unread, so the caller
 *  can settle a held name or report a refusal before {@link readManagedLaunch} reads the join. */
export function requestManagedLaunch<R>(request: ManagedLaunchRequest, start: ManagerStart<R>): Promise<R> {
  return start({
    name: request.persona,
    identity: request.identity,
    role: request.role,
    agent: request.agent,
    defaultAgent: request.defaultAgent,
    config: request.config,
    model: request.model,
    variant: request.variant,
    ...(request.supervise !== undefined ? { supervise: request.supervise } : {}),
    launchOptions: request.launchOptions,
    cwd: request.cwd,
    resume: request.resume,
    ...(request.resumeClaim !== undefined ? { resumeClaim: request.resumeClaim.claim, resumeAgent: request.resumeClaim.agent } : {}),
    prompt: request.prompt,
    shareTools: request.shareTools,
    subscribe: request.subscribe,
    allowSubscribe: request.allowSubscribe,
    allowPublish: request.allowPublish,
    events: request.events,
    ...(request.runtime !== undefined ? { runtime: request.runtime } : {}),
  });
}

/** The parts of a successful `start` reply that a joined launch is read from. */
export interface ManagedLaunchReply {
  data?: unknown;
  managerInstanceId?: string;
  request?: ManagerRequestReceipt;
  intent?: ManagerRequestIntent;
}

export interface ManagedLaunchResult {
  kind: "managed-launch";
  name: string;
  id: string;
  lifecycleUid: string;
  space: string;
  managerInstanceId: string;
  harness: string;
  runtime: string;
  role: string | null;
  request: ManagerRequestReceipt | null;
  intent: ManagerRequestIntent | null;
  readiness: "joined";
  requestedModel: string | null;
  detached: boolean;
  /** Whether this seat's runtime opens a terminal stream, as its manager reports: false means no
   *  `cotal attach` can open one here and this launch never tried. Null when the manager is too old
   *  to report it, which is the only case that still finds out by attaching. */
  streamsTerminal: boolean | null;
  /** The channels the agent asked to read and post on and the ones its host granted, when the host
   *  granted other ones. Null when it granted what was asked. */
  acl: ManagedLaunchAcl | null;
}

/** A managed agent's read and post channels as asked for and as granted. */
export interface ManagedLaunchAcl {
  requested: { allowSubscribe: string[]; allowPublish: string[] };
  effective: { allowSubscribe: string[]; allowPublish: string[] };
}

/** The manager's `acl` launch field: null when the manager sent none, undefined when it cannot be read. */
export function managedLaunchAcl(value: unknown): ManagedLaunchAcl | null | undefined {
  if (value === undefined) return null;
  const lists = (raw: unknown) => {
    const { allowSubscribe, allowPublish } = (raw ?? {}) as { allowSubscribe?: unknown; allowPublish?: unknown };
    const channels = (list: unknown): list is string[] => Array.isArray(list) && list.every((channel) => typeof channel === "string");
    return channels(allowSubscribe) && channels(allowPublish) ? { allowSubscribe: [...allowSubscribe], allowPublish: [...allowPublish] } : undefined;
  };
  const requested = lists((value as { requested?: unknown } | null)?.requested), effective = lists((value as { effective?: unknown } | null)?.effective);
  return requested && effective ? { requested, effective } : undefined;
}

/** Read the joined agent from a successful `start` reply. `launch` carries the facts the caller
 *  holds, and `target` goes on the partial failure thrown when the reply lacks the identity, the
 *  manager or a readable channel grant. The manager's event-plane notice comes back beside the result. */
export function readManagedLaunch(
  reply: ManagedLaunchReply,
  launch: Pick<ManagedLaunchResult, "space" | "requestedModel" | "detached">,
  target: Record<string, unknown>,
): { result: ManagedLaunchResult; eventsNotice: string | undefined } {
  const d = reply.data as { name?: unknown; id?: unknown; lifecycleUid?: unknown; role?: string; agent?: unknown; mode?: unknown; streamsTerminal?: unknown; eventsNotice?: string; acl?: unknown };
  if (!d || typeof d.name !== "string" || typeof d.id !== "string" || typeof d.lifecycleUid !== "string" || typeof d.agent !== "string" || typeof d.mode !== "string" || !reply.managerInstanceId)
    throw new CommandFailure("partial", "OPERATION_PARTIAL", "the manager reported a successful launch but did not supply the identity and manager needed for a safe handoff", { target, changed: [{ kind: "managed-launch", readinessReported: true }], remedy: "inspect `cotal ps` before doing anything else; do not relaunch" });
  const acl = managedLaunchAcl(d.acl);
  if (acl === undefined)
    throw new CommandFailure("partial", "OPERATION_PARTIAL", "the agent joined, but the manager's report of the channels its host granted could not be read; no replacement was launched", { target, changed: [{ kind: "managed-launch", readinessReported: true }], remedy: "inspect `cotal ps` before doing anything else; do not relaunch" });
  // The manager's own answer about the runtime it spawned through. A manager too old to report it
  // leaves null, and that launch finds out by attaching, as every launch used to: the caller cannot
  // know better from here, and reading an absent field as "no stream" would leave a pty foreground
  // spawn unattached against every manager below this version.
  const streamsTerminal = typeof d.streamsTerminal === "boolean" ? d.streamsTerminal : null;
  const result: ManagedLaunchResult = { kind: "managed-launch", name: d.name, id: d.id, lifecycleUid: d.lifecycleUid, space: launch.space, managerInstanceId: reply.managerInstanceId, harness: d.agent, runtime: d.mode, role: d.role ?? null, request: reply.request ?? null, intent: reply.intent ?? null, readiness: "joined", requestedModel: launch.requestedModel, detached: launch.detached, streamsTerminal, acl };
  return { result, eventsNotice: d.eventsNotice };
}

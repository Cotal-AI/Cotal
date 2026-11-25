/**
 * What the ACP agent needs from a Cotal space, as one interface. The protocol layer in `agent.ts`
 * depends on this and on nothing else in the repo, so a smoke can drive it with a fake space and
 * `live-mesh.ts` binds it to a real one.
 */

/** One application a manager can launch, with its model catalog. */
export interface AgentCatalog {
  readonly agent: string;
  /** False when the manager reports the application unavailable on its host. */
  readonly available: boolean;
  /** Whether the connector publishes an AG-UI event plane. The bridge needs one. */
  readonly eventPlane: boolean;
  /** A seat launches asking before it uses a tool: the connector takes `askPermissions` and serves
   *  its prompts on this space, so the thread answers them. Absent: it launches as the connector's
   *  default. */
  readonly askPermissions?: boolean;
  /** A seat launches publishing the model's reasoning: the connector takes `reasoningEvents` and
   *  publishes an event plane. */
  readonly reasoningEvents?: boolean;
  readonly reason?: string;
  /** Why the manager could not read the application's models. A thread does not start it, since its
   *  model list would be a default the application may not take. Absent when the read worked, and
   *  for a connector with no model list to read, which keeps its default alone. */
  readonly modelsUnread?: string;
  readonly models: readonly CatalogModel[];
}

/** Which `agent` endpoint commands a seat serves now, as its presence `agentEndpoint` field says
 *  (SPEC §6). A seat older than `set-model` omits `setModel`. */
export interface AgentEndpointServes {
  readonly interrupt: boolean;
  readonly turn: boolean;
  readonly images: boolean;
  readonly usage: boolean;
  readonly setModel?: boolean;
}

export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly variants: readonly string[];
}

/** One persona in a manager's catalog. */
export interface PersonaRow {
  readonly name: string;
  /** The caller owns the persona's file. */
  readonly own?: true;
}

/** One channel of the space: how many messages the space retains on it, and the purpose its registry
 *  entry states. */
export interface ChannelRow {
  readonly channel: string;
  readonly messages: number;
  readonly description?: string;
}

/** A manager the bridge can spawn through. */
export interface ManagerChoice {
  readonly instanceId: string;
  /** The host name it reported, shown and never compared. */
  readonly host?: string;
  /** The manager runs on this process's machine: it names this machine's id (`managerMachineId`),
   *  or it names none, as one an older release started, and this machine's manager service record
   *  says it runs here. */
  readonly local: boolean;
  /** The manager's presence is current, or, with no presence row to read, it answered for its host.
   *  A registration whose computer is gone can stay listed. */
  readonly live?: boolean;
}

/** One seat incarnation: its name, principal and lifecycle. */
export interface SeatRef {
  readonly name: string;
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
  /** The manager that holds the seat. Seat commands go to it. */
  readonly managerInstanceId?: string;
}

/** A managed seat as a manager's `ps` lists it. */
export interface SeatRow extends SeatRef {
  /** The name the agent shows, when `set-name` made it differ from {@link SeatRef.name}. */
  readonly display?: string;
  readonly agent: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly status: string;
  readonly uptimeMs?: number;
}

export interface SpawnRequest {
  readonly name: string;
  readonly agent: string;
  readonly model?: string;
  readonly variant?: string;
  readonly persona?: string;
  /** Channels the seat subscribes to at launch. */
  readonly subscribe?: readonly string[];
  readonly cwd: string;
  /** The seat's first turn. Absent: the seat starts with none. */
  readonly prompt?: string;
  readonly managerInstanceId?: string;
  /** Launch the harness asking before it uses a tool. */
  readonly askPermissions?: true;
  /** Publish the model's reasoning on the event plane. */
  readonly reasoningEvents?: true;
}

/** One AG-UI event as the bridge reads it. Only the fields the mapping uses are named. */
export interface AguiEventLike {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** One AG-UI frame from a seat's event channel, or from its payload rail (SPEC 13.19), which carries
 *  only its tool calls' arguments and results. */
export interface SeatFrame {
  readonly plane: "events" | "payloads";
  /** The principal whose event channel carried the frame. */
  readonly owner: string;
  readonly actor: string;
  readonly threadId: string;
  readonly runId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly events: readonly AguiEventLike[];
  /** When the frame was published, epoch ms. */
  readonly ts: number;
}

/** A call to a seat's `agent` endpoint (SPEC 13.22) that did not succeed. `code` is the endpoint's
 *  refusal code, such as `unimplemented`, or `unavailable` when the seat serves no endpoint. */
export class AgentCallFailed extends Error {
  override readonly name = "AgentCallFailed";
  constructor(message: string, readonly code: string, readonly details?: readonly unknown[]) {
    super(message);
  }
}

/** What a seat's presence says about the prompts its `agent` endpoint holds. `runtime` is the serving
 *  process, and `seq` goes up each time one of its prompts opens or changes state. */
export interface PromptCounter {
  readonly runtime: string;
  readonly open: number;
  readonly seq: number;
}

export interface RosterEntry {
  readonly name: string;
  readonly status: string;
  readonly role?: string;
  readonly activity?: string;
}

/** Opening the space needs the operator to sign in first. Any other failure to open is not this. */
export class SignInRequired extends Error {
  override readonly name = "SignInRequired";
}

/** The caller may not read a manager's launch lists, its applications, models and personas: a person
 *  whose grant does not let them spawn agents. They still control the agents they have. */
export class LaunchListsRefused extends Error {
  override readonly name = "LaunchListsRefused";
}

/** No manager may start a new agent for the caller, as when none of a person's registered managers is
 *  live. The agents they have stay listed and controllable. The message says why. */
export class NoLaunchManager extends Error {
  override readonly name = "NoLaunchManager";
}

/** No live manager is registered for the space, as once the last one stopped itself, so none runs
 *  there to list the agents. */
export class NoManagerRegistered extends Error {
  override readonly name = "NoManagerRegistered";
  constructor(readonly space: string) {
    super(`No live manager is registered for ${space}`);
  }
}

/** What a person on a space where people sign in can do about a registered manager that does not
 *  answer. Its registration stays listed until it is removed, as `cotal ps` says. */
export function deregisterRemedy(space: string, instanceIds: readonly string[]): string {
  return `For a computer that is gone, ask the space's auth service to remove your registration. Removing it needs the \`supervise\` scope: ${instanceIds.map((id) => `\`cotal endpoint deregister manager ${id} --space ${space} --yes\``).join(", ")}.`;
}

/** The seats the managers listed, and the managers that did not answer, whose seats are missing. */
export interface SeatList {
  readonly rows: SeatRow[];
  readonly silent: readonly string[];
  /** The silent managers that are the person's own registrations and did not answer, on a space
   *  where people sign in. Such a registration may belong to a computer that is gone. */
  readonly removable?: readonly string[];
}

export interface Mesh {
  /** The space this process acts in. */
  readonly space: string;
  /** The application a launch uses when none is chosen, as the operator's preference names it. */
  readonly defaultAgent?: string;
  /** The applications and models a manager offers. Rejects with {@link LaunchListsRefused} when the
   *  caller may not read them. */
  catalogs(managerInstanceId?: string): Promise<AgentCatalog[]>;
  /** The managers this caller can spawn through. On a space where people sign in, rejects with
   *  {@link NoLaunchManager} when none may. */
  managers(): Promise<ManagerChoice[]>;
  /** Start this machine's manager for the space, for a new agent that no manager may start. It stops
   *  itself after a while with no agents. Resolves with the line the thread shows; rejects with
   *  {@link NoLaunchManager} naming the start's reason. */
  startManager(): Promise<string>;
  /** Why this machine's identity could not be read, undefined when it could. Without it no manager
   *  reads as this machine's, so a thread neither defaults to one nor starts one. */
  machineUnreadable(): string | undefined;
  /** One manager as a choice, described from its presence, or from its own answer when its presence
   *  row is not found. */
  manager(instanceId: string): Promise<ManagerChoice>;
  /** The personas in a manager's catalog, by name. Each manager holds its own. Rejects with
   *  {@link LaunchListsRefused} when the caller may not read them. */
  personas(managerInstanceId?: string): Promise<PersonaRow[]>;
  /** Launch a seat and wait until the manager confirms it joined. */
  spawn(request: SpawnRequest): Promise<SeatRef>;
  /** Every managed seat the caller can see. Rejects with {@link NoManagerRegistered} when no live
   *  manager is registered for the space. */
  seats(): Promise<SeatList>;
  /** Stop one seat through the manager that holds it. */
  despawn(seat: SeatRef): Promise<void>;
  /** Interrupt the seat's live turn through its manager, which writes the connector's interrupt key
   *  into its terminal. Rejects, naming why, when the manager refuses. */
  interrupt(seat: SeatRef): Promise<void>;
  /** Call one of the seat's `agent` endpoint commands as its owner and resolve with the reply's
   *  data. Rejects with {@link AgentCallFailed}, `unavailable` when the seat does not serve it. */
  agentCall(seat: SeatRef, command: string, args: Record<string, unknown>): Promise<unknown>;
  /** The seat's prompt counter from its presence, or undefined when it serves no `agent` endpoint. */
  promptCounter(seat: SeatRef): PromptCounter | undefined;
  /** Which `agent` endpoint commands the seat's presence says it serves now (SPEC §6), or undefined
   *  when it shows none or the space has no agent endpoint. The bridge reads it once to pick a path
   *  before it sends anything. */
  served(seat: SeatRef): AgentEndpointServes | undefined;
  /** Change the name the seat shows with its agent endpoint's `set-name`, as the seat's owner. Resolves
   *  with the name its card now carries; rejects, naming why, when the space or the agent refuses. */
  rename(seat: SeatRef, name: string): Promise<string>;
  /** Why the manager would refuse `name` for a new seat on this space, or undefined when it would not. */
  spawnNameError(name: string): string | undefined;
  /** Type `text` into the seat's terminal and press Enter, through its manager's `input` command, so
   *  it arrives as the operator's own words. Rejects, naming why, when the manager refuses. */
  input(seat: SeatRef, text: string): Promise<void>;
  /** Follow every seat's event frames and payload frames. Returns a function that stops following. */
  followFrames(onFrame: (frame: SeatFrame) => void): () => void;
  /** The event and payload frames the space still retains for one seat, oldest first, a payload frame
   *  before the event frame it belongs to. */
  frameHistory(seat: SeatRef): Promise<SeatFrame[]>;
  /** A seat's presence status (`idle`, `working`, `waiting`), or undefined when it is not on the
   *  roster. */
  presence(seat: SeatRef): string | undefined;
  roster(): Promise<RosterEntry[]>;
  /** The space's channels, by name, without the agents' event channels. */
  channels(): Promise<ChannelRow[]>;
  close(): Promise<void>;
}

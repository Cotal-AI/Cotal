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
  readonly reason?: string;
  readonly models: readonly CatalogModel[];
}

export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly variants: readonly string[];
}

/** A manager the bridge can spawn through. */
export interface ManagerChoice {
  readonly instanceId: string;
  readonly host?: string;
  /** The manager runs on the host this process runs on. */
  readonly local: boolean;
  /** The manager's presence is current, or off a signed-in space, it answered for its host. A
   *  registration whose computer is gone can stay listed. */
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
  readonly prompt: string;
  readonly managerInstanceId?: string;
}

/** One AG-UI event as the bridge reads it. Only the fields the mapping uses are named. */
export interface AguiEventLike {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** One AG-UI frame from a seat's event channel. */
export interface SeatFrame {
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

/** What a person on a space where people sign in can do about a registered manager that does not
 *  answer. Its registration stays listed until it is removed, as `cotal ps` says. */
export function deregisterRemedy(space: string, instanceIds: readonly string[]): string {
  return `For a computer that is gone, ask the space's auth service to remove your registration, which needs the \`supervise\` scope: ${instanceIds.map((id) => `\`cotal endpoint deregister manager ${id} --space ${space} --yes\``).join(", ")}.`;
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
  /** Whether the space authenticates users, which constrains seat names. */
  readonly userMode: boolean;
  /** The applications and models a manager offers. Rejects with {@link LaunchListsRefused} when the
   *  caller may not read them. */
  catalogs(managerInstanceId?: string): Promise<AgentCatalog[]>;
  /** The managers this caller can spawn through. On a space where people sign in, rejects with
   *  {@link NoLaunchManager} when none may. */
  managers(): Promise<ManagerChoice[]>;
  /** One manager as a choice, described from its presence, or from its own answer when its presence
   *  row is not found. */
  manager(instanceId: string): Promise<ManagerChoice>;
  /** Persona names in a manager's catalog. Each manager holds its own. Rejects with
   *  {@link LaunchListsRefused} when the caller may not read them. */
  personas(managerInstanceId?: string): Promise<string[]>;
  /** Launch a seat and wait until the manager confirms it joined. */
  spawn(request: SpawnRequest): Promise<SeatRef>;
  /** Every managed seat the caller can see. */
  seats(): Promise<SeatList>;
  /** Stop one seat through the manager that holds it. */
  despawn(seat: SeatRef): Promise<void>;
  /** Interrupt the seat's live turn: its manager writes the connector's interrupt key into the
   *  seat's terminal. Rejects, naming why, when the manager refuses. */
  interrupt(seat: SeatRef): Promise<void>;
  /** Type `text` into the seat's terminal and press Enter, through its manager's `input` command, so
   *  it arrives as the operator's own words. Rejects, naming why, when the manager refuses. */
  input(seat: SeatRef, text: string): Promise<void>;
  /** Follow every seat's event frames. Returns a function that stops following. */
  followFrames(onFrame: (frame: SeatFrame) => void): () => void;
  /** The event frames the space still retains for one seat, oldest first. */
  frameHistory(seat: SeatRef): Promise<SeatFrame[]>;
  /** A seat's presence status (`idle`, `working`, `waiting`), or undefined when it is not on the
   *  roster. */
  presence(seat: SeatRef): string | undefined;
  roster(): Promise<RosterEntry[]>;
  channels(): Promise<string[]>;
  close(): Promise<void>;
}

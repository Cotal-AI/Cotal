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
}

/** One seat incarnation: its name, principal and lifecycle. */
export interface SeatRef {
  readonly name: string;
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
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

export interface Mesh {
  /** The space this process acts in. */
  readonly space: string;
  /** The application a launch uses when none is chosen, as the operator's preference names it. */
  readonly defaultAgent?: string;
  /** Whether the space authenticates users, which constrains seat names. */
  readonly userMode: boolean;
  /** The applications and models a manager offers. */
  catalogs(managerInstanceId?: string): Promise<AgentCatalog[]>;
  /** The managers this caller can spawn through. */
  managers(): Promise<ManagerChoice[]>;
  /** Persona names in the manager's catalog. */
  personas(): Promise<string[]>;
  /** Launch a seat and wait until the manager confirms it joined. */
  spawn(request: SpawnRequest): Promise<SeatRef>;
  /** Every managed seat the caller can see. */
  seats(): Promise<SeatRow[]>;
  /** Stop one seat through the manager that holds it. */
  despawn(seat: SeatRef): Promise<void>;
  /** Interrupt the seat's live turn: its manager writes the connector's interrupt key into the
   *  seat's terminal. Rejects, naming why, when the manager refuses. */
  interrupt(seat: SeatRef): Promise<void>;
  /** Send `text` to the seat as a direct message from the operator. Resolves with when the broker
   *  stored it, epoch ms. */
  dm(seat: SeatRef, text: string): Promise<{ storedAt: number }>;
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

import type { SeatLaunchSpec } from "./launcher.js";
import type { ClientRequest, ServerEvent, ServerReply } from "./protocol.js";

/** Private Linux host transport. Distinct from the nested per-seat protocol. */
export const SHARED_CONTROL_PROTOCOL = 2;

export type SharedLaunchPayload = {
  name: string;
  cwd: string;
  spec: SeatLaunchSpec;
  artifactRoot: string;
};

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
export type SharedSeatRequestBody = WithoutId<ClientRequest>;

export type SharedControlRequest = { id: number } & (
  | { op: "hello"; protocol: number; token: string }
  | { op: "launch"; seat: string; launch: SharedLaunchPayload }
  | { op: "launch-state"; seat: string }
  | { op: "seat"; seat: string; request: ClientRequest }
);

/** Only use not-admitted on a request that is known not to have taken effect. */
export type SharedControlOutcome = "not-admitted" | "unknown";

export type SharedControlReply = { id: number } & (
  | { ok: true; op: "hello"; protocol: number; pid: number; start: string }
  | { ok: true; op: "launch" }
  | { ok: true; op: "launch-state"; state: "absent" | "unknown" }
  | { ok: true; op: "seat"; seat: string; reply: ServerReply }
  | { ok: false; outcome: SharedControlOutcome; error: string }
);

export type SharedControlEvent = { event: "seat"; seat: string; message: ServerEvent };
export type SharedControlMessage = SharedControlReply | SharedControlEvent;

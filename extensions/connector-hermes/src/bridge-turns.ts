/**
 * The bridge's turn and request bookkeeping: turns handed to the gateway in the user's own words, and
 * requests the adapter answers, each tracked by frame id until the adapter answers it or the
 * connection it went to closes. See bridge.ts for the frames.
 */
import type { Socket } from "node:net";
import type { TurnImage } from "@cotal-ai/core";
import type { BridgeServer } from "./bridge.js";

type Answer = { data?: Record<string, unknown>; error?: Error };

interface TurnDesk extends Pick<BridgeServer, "submitTurn" | "ask"> {
  /** Send every turn not yet sent to the subscribed adapter. */
  pushTurns(): void;
  settleTurn(id: unknown, error?: Error): void;
  settleRequest(id: unknown, answer: Answer): void;
  /** Settle every turn and request that went to `sock`, which closed before it answered. */
  connectionClosed(sock: Socket): void;
  /** Turns not yet answered by the gateway. */
  pending(): number;
}

/** `adapter` returns the subscribed adapter connection, if any; `onIdle` runs after a turn settles. */
export function createTurnDesk(
  adapter: () => Socket | undefined,
  sendFrame: (sock: Socket, frame: Record<string, unknown>) => void,
  onIdle: () => void,
): TurnDesk {
  /** Turns not yet answered by the gateway, by id; `to` is the adapter connection a turn went to. */
  const turns = new Map<string, { text: string; images: readonly TurnImage[]; to?: Socket; settle: (error?: Error) => void }>();
  /** Requests not yet answered, by id, each sent to the adapter connection `to`. */
  const requests = new Map<string, { to: Socket; settle: (answer: Answer) => void }>();
  let frameIds = 0;

  const pushTurns = (): void => {
    const to = adapter();
    if (!to) return;
    for (const [id, turn] of turns) {
      if (turn.to) continue;
      turn.to = to;
      sendFrame(to, { t: "turn", id, text: turn.text, ...(turn.images.length ? { images: turn.images } : {}) });
    }
  };
  const settleTurn = (id: unknown, error?: Error): void => {
    const turn = typeof id === "string" ? turns.get(id) : undefined;
    if (!turn) return;
    turns.delete(id as string);
    turn.settle(error);
    onIdle();
  };
  const settleRequest = (id: unknown, answer: Answer): void => {
    const request = typeof id === "string" ? requests.get(id) : undefined;
    if (!request) return;
    requests.delete(id as string);
    request.settle(answer);
  };

  return {
    pushTurns,
    settleTurn,
    settleRequest,
    submitTurn(text, images = []) {
      return new Promise<void>((resolve, reject) => {
        turns.set(`turn-${++frameIds}`, { text, images, settle: (error) => (error ? reject(error) : resolve()) });
        pushTurns();
      });
    },
    ask(request) {
      return new Promise((resolve, reject) => {
        const to = adapter();
        if (!to) return reject(new Error("the gateway's cotal adapter is not connected"));
        const id = `${request}-${++frameIds}`;
        requests.set(id, { to, settle: ({ data, error }) => (error ? reject(error) : resolve(data!)) });
        sendFrame(to, { t: request, id });
      });
    },
    connectionClosed(sock) {
      for (const [id, turn] of turns)
        if (turn.to === sock) settleTurn(id, new Error("the gateway disconnected before it answered the turn, so whether it started is unknown"));
      for (const [id, request] of requests)
        if (request.to === sock) settleRequest(id, { error: new Error("the gateway disconnected before it answered") });
    },
    pending() {
      return turns.size;
    },
  };
}

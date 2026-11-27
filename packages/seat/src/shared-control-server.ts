import type { Socket } from "node:net";
import type { CustodianChannel, CustodianSession } from "./custodian.js";
import { encodeFrame, FrameReader, MAX_FRAME_SIZE, type ClientRequest, type ServerMessage } from "./protocol.js";
import { isSeatId } from "./record.js";
import { SHARED_CONTROL_PROTOCOL, type SharedControlMessage, type SharedLaunchPayload } from "./shared-control-protocol.js";
import { linuxWriterProof, type LinuxWriterIdentity } from "./shared-control-linux.js";
import type { ExactIdentity, ProcessObservation } from "./shared-platform.js";

export type SharedManagerIdentity = ExactIdentity;
export interface SharedWriterProof<Identity extends SharedManagerIdentity, Peer = Socket> {
  same(a: Identity, b: Identity): boolean;
  observe(identity: Identity): ProcessObservation;
  matchesPeer(peer: Peer, identity: Identity): boolean;
}
export type SharedSeatAcceptor = (channel: CustodianChannel) => CustodianSession;
interface HostControlOptions<Identity extends SharedManagerIdentity, Peer> {
  host: SharedManagerIdentity & { token: string };
  authorized(): Identity | undefined;
  writer: SharedWriterProof<Identity, Peer>;
  acceptSeat(id: string): SharedSeatAcceptor | undefined;
  launch(id: string, payload: SharedLaunchPayload, authorize: () => void): Promise<"admitted" | "not-admitted" | "unknown">;
  launchState?(id: string): "absent" | "unknown";
  closing(): boolean;
}

function frameObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The socket itself is the writer epoch. A closed epoch cannot affect its replacement. */
export function hostControl(options: Omit<HostControlOptions<LinuxWriterIdentity, Socket>, "writer">): (socket: Socket) => void {
  const accept = createHostControl({ ...options, writer: linuxWriterProof });
  return socket => accept(socket, socket);
}

export function createHostControl<Identity extends SharedManagerIdentity, Peer>(options: HostControlOptions<Identity, Peer>): (socket: Socket, peer: Peer) => void {
  const { writer } = options;
  let owner: { socket: Socket; identity: Identity } | undefined;
  return (socket, peer) => {
    const sessions = new Map<string, CustodianSession>();
    const reader = new FrameReader();
    let identity: Identity | undefined;
    let closed = false;
    let lastId = 0;
    const close = () => {
      if (closed) return;
      closed = true;
      if (owner?.socket === socket) owner = undefined;
      for (const session of sessions.values()) session.close();
      sessions.clear();
      socket.destroy();
    };
    const transmit = (frame: SharedControlMessage) => {
      if (closed || !socket.writable) return;
      try {
        const bytes = encodeFrame(frame);
        if (socket.writableLength + bytes.length > 2 * (MAX_FRAME_SIZE + 4)) { close(); return; }
        socket.write(bytes);
      } catch { close(); }
    };
    const failure = (id: number, outcome: "unknown" | "not-admitted") =>
      transmit({ id, ok: false, outcome, error: "shared PTY host did not confirm the request" });
    const authorize = () => {
      const claim = options.authorized();
      if (!identity || closed || socket.destroyed || owner?.socket !== socket || !claim || !writer.same(claim, identity) ||
          writer.observe(identity) !== "live")
        throw new Error("shared PTY controller lifetime is unknown");
    };
    const hello = (id: number, raw: Record<string, unknown>) => {
      const claim = options.authorized();
      if (!claim || raw.protocol !== SHARED_CONTROL_PROTOCOL || raw.token !== options.host.token || !writer.matchesPeer(peer, claim)) {
        failure(id, "not-admitted"); return;
      }
      if (owner && owner.socket !== socket) {
        const prior = owner;
        if (writer.observe(prior.identity) !== "gone") { failure(id, "not-admitted"); return; }
        prior.socket.destroy();
      }
      if (options.closing()) { failure(id, "not-admitted"); return; }
      identity = claim;
      owner = { socket, identity };
      socket.setTimeout(0);
      transmit({ id, ok: true, op: "hello", protocol: SHARED_CONTROL_PROTOCOL, pid: options.host.pid, start: options.host.start });
    };
    const routeSeat = (id: number, seat: string, request: ClientRequest) => {
      let session = sessions.get(seat);
      if (!session) {
        const accept = options.acceptSeat(seat);
        if (request.op !== "hello" || !accept) { failure(id, "not-admitted"); return; }
        const endSeat = () => { sessions.get(seat)?.close(); sessions.delete(seat); };
        session = accept({
          get writable() { return !closed && owner?.socket === socket && socket.writable; },
          get writableLength() { return socket.writableLength; },
          authorize, destroy: endSeat,
          send(message: ServerMessage) {
            if ("event" in message) transmit({ event: "seat", seat, message });
            else transmit({ id: message.id, ok: true, op: "seat", seat, reply: message });
          },
        });
        sessions.set(seat, session);
      }
      session.receive(request);
    };
    const receive = (raw: unknown) => {
      if (closed) return;
      if (!frameObject(raw) || typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || raw.id <= lastId) { close(); return; }
      const id = lastId = raw.id;
      if (!identity) { if (raw.op === "hello") hello(id, raw); else close(); return; }
      authorize();
      if (typeof raw.seat !== "string" || !isSeatId(raw.seat)) { failure(id, "not-admitted"); return; }
      const seat = raw.seat;
      if (raw.op === "launch" && frameObject(raw.launch)) {
        void options.launch(seat, raw.launch as SharedLaunchPayload, authorize).then(outcome => {
          if (outcome === "admitted") transmit({ id, ok: true, op: "launch" });
          else failure(id, outcome);
        }, () => failure(id, "unknown"));
      } else if (raw.op === "launch-state" && options.launchState) {
        transmit({ id, ok: true, op: "launch-state", state: options.launchState(seat) });
      } else if (raw.op === "seat" && frameObject(raw.request) && raw.request.id === id) {
        routeSeat(id, seat, raw.request as ClientRequest);
      } else failure(id, "not-admitted");
    };
    socket.setTimeout(2_000, close);
    socket.on("error", close);
    socket.once("close", close);
    socket.on("data", chunk => {
      try { for (const incoming of reader.push(chunk)) receive(incoming); }
      catch { close(); }
    });
  };
}

import { HarnessError, JcodeClient, unixSocketTransport, type ServerFrame } from "@1jehuang/jcode-sdk";

interface SteerReplies {
  capture?: (id: number) => void;
  late: Map<number, (accepted: boolean) => void>;
}
const replies = new WeakMap<JcodeClient, SteerReplies>();

/** Observe SDK-assigned request ids without changing frames or its request timeout. */
export async function connectSteerClient(socketPath: string, requestTimeoutMs?: number): Promise<JcodeClient> {
  const socket = await unixSocketTransport(socketPath);
  const state: SteerReplies = { late: new Map() };
  let client: JcodeClient;
  try {
    client = await JcodeClient.connect({
      socketPath,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      transport: {
        write(data) {
          // SDK Transport.write receives one encoded request frame. The SDK remains the sole
          // allocator of ids and the sole reader/correlator of replies, including partial chunks.
          const frame = JSON.parse(data) as { id: number; req: string };
          if (frame.req === "soft_interrupt") state.capture?.(frame.id);
          socket.write(data);
        },
        onData: (listener) => socket.onData(listener),
        onClose: (listener) => socket.onClose(listener),
        close: () => socket.close(),
      },
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  replies.set(client, state);
  client.on("event", (frame: ServerFrame) => {
    if (typeof frame.reply_to !== "number") return;
    const settle = state.late.get(frame.reply_to);
    if (!settle) return;
    state.late.delete(frame.reply_to);
    settle(frame.ev === "ok");
  });
  client.on("close", () => state.late.clear());
  return client;
}

/** Keep only a timed-out steer's correlated reply observable until its reservation is released. */
export function softInterruptWithLateReply(
  client: JcodeClient,
  session: string,
  content: string,
  settle: (accepted: boolean) => void,
): { request: Promise<void>; dispose: () => void } {
  const state = replies.get(client);
  if (!state) throw new Error("jcode connector: steer client has no request observer");
  let id: number | undefined;
  state.capture = (value) => { id = value; };
  let request: Promise<void>;
  try {
    // softInterrupt writes synchronously through the SDK transport before returning its promise.
    request = client.softInterrupt(session, content, false);
  } finally {
    state.capture = undefined;
  }
  let disposed = false;
  const dispose = (): void => {
    disposed = true;
    if (id !== undefined) state.late.delete(id);
  };
  request = request.catch((error: unknown) => {
    if (!disposed && id !== undefined && error instanceof HarnessError && error.code === "timeout")
      state.late.set(id, settle);
    throw error;
  });
  return { request, dispose };
}

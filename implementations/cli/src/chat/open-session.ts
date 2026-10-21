import { randomBytes } from "node:crypto";
import {
  CotalEndpoint,
  dialerFor,
  dmDurable,
  dmStream,
  isConcreteChannel,
  isConsumerNotFound,
  isJetStreamMissing,
  mintLifecycleUid,
  standaloneConnectOpts,
  unicastRecvFilter,
} from "@cotal-ai/core";
import { JetStreamApiCodes, jetstreamManager, type ConsumerInfo } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { CommandFailure, type MeshTarget } from "@cotal-ai/workspace";
import { NativeChatSession } from "./native-session.js";
import type { CloseReport, SessionIdentity } from "./session.js";

interface InboxPin {
  readonly streamCreated: string;
  readonly consumerCreated: string;
}

const absent = (error: unknown): boolean => isConsumerNotFound(error) || isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound);
const BACKSTOP = "The 600-second inactive threshold is a backstop, not an erasure guarantee; retained messages and interrupted history readers are not erased.";

/** Open mode supplies routing identity only. No credentials, auth rows or authority retirement. */
export async function openRoutingChatSession(target: MeshTarget, options: {
  readonly label: string;
  readonly channels: readonly string[];
}): Promise<NativeChatSession> {
  if (target.mode !== "open") throw new CommandFailure("refused", "UNSUPPORTED", "the routing-only chat adapter requires a recorded open target; no authentication fallback was attempted", { target: { space: target.space } });
  if (!options.label || options.label.length > 128 || options.channels.some((channel) => !isConcreteChannel(channel)))
    throw new CommandFailure("refused", "USAGE_INVALID", "chat requires a label of 1 to 128 characters and concrete initial channels");
  const actor = `local_${randomBytes(16).toString("hex")}`;
  const uid = mintLifecycleUid();
  const owner = "local";
  const stream = dmStream(target.space);
  const durable = dmDurable(owner, actor, uid);
  const filter = unicastRecvFilter(target.space, owner, actor);
  let connection: NatsConnection | undefined;
  let pin: InboxPin | undefined;
  const endpoint = new CotalEndpoint({
    space: target.space,
    servers: target.server,
    tls: target.tlsRequired,
    card: { owner, actor, name: options.label, kind: "endpoint", meta: { sessionKind: "chat" } },
    lifecycleUid: uid,
    channels: [...options.channels],
    inactiveThresholdMs: 600_000,
    onConnection: (nc) => { connection = nc; },
  });
  const identity: SessionIdentity = {
    mode: "open", space: target.space, principal: `${owner}.${actor}`, lifecycleUid: uid, label: options.label,
    // These are routing intent, not broker-enforced ceilings on an open mesh.
    allowSubscribe: [">"], allowPublish: [">"],
  };
  const matches = (info: ConsumerInfo): boolean => info.name === durable && info.stream_name === stream &&
    info.config.durable_name === durable && info.config.filter_subject === filter;

  const retire = async (): Promise<CloseReport> => {
    // stop() is memoized. A rejected close cannot authorize a consumer delete, even when called
    // after NativeChatSession already attempted that same close.
    try { await endpoint.stop(); }
    catch { return { retirement: "not-applicable", connectionClosed: "not-confirmed", message: `Open session connection closure was not confirmed; inbox cleanup was held. ${BACKSTOP}` }; }
    if (!pin) return { retirement: "not-applicable", connectionClosed: "confirmed", message: `Open session closed; inbox creation identity was not captured, so cleanup was held. ${BACKSTOP}` };
    let cleanupConnection: NatsConnection | undefined;
    let message = "Open session closed; inbox cleanup was not confirmed and was not retried.";
    let closed = true;
    try {
      cleanupConnection = await dialerFor(target.server)({
        servers: target.server, ...standaloneConnectOpts({ tls: target.tlsRequired }),
        timeout: 2_000, reconnect: false, maxReconnectAttempts: 0,
      });
      const jsm = await jetstreamManager(cleanupConnection, { checkAPI: false, timeout: 2_000 });
      const streamInfo = await jsm.streams.info(stream);
      const info = await jsm.consumers.info(stream, durable);
      if (streamInfo.config.name !== stream || streamInfo.created !== pin.streamCreated ||
          !matches(info) || info.created !== pin.consumerCreated) {
        message = "Open session closed; the inbox or stream creation identity changed, so cleanup was held.";
      } else if (await jsm.consumers.delete(stream, durable)) {
        try {
          await jsm.consumers.info(stream, durable);
          message = "Open session closed; a consumer is present after the delete acknowledgement, so cleanup remains unconfirmed.";
        } catch (error) {
          if (!absent(error)) throw error;
          message = "Open session closed; its own DM inbox was observed absent. Routing only: no ownership, confinement or revocation.";
        }
      }
    } catch (error) {
      if (absent(error)) message = "Open session closed; its own DM inbox was observed absent. Routing only: no ownership, confinement or revocation.";
      // A permission denial, unreadable response or timeout is not absence. Never replay a delete.
    } finally {
      if (cleanupConnection) {
        try { await cleanupConnection.close(); } catch { closed = false; }
        if (!cleanupConnection.isClosed()) closed = false;
      }
    }
    return { retirement: "not-applicable", connectionClosed: closed ? "confirmed" : "not-confirmed", message: `${message} ${BACKSTOP}${closed ? "" : " The cleanup connection closure was not confirmed."}` };
  };
  // Register the real participant listeners before starting the endpoint. No fabricated session or
  // connector runtime is involved; NativeChatSession owns its endpoint listeners through close().
  const session = new NativeChatSession({ endpoint, identity, retire });
  try {
    await endpoint.start();
    if (!connection || connection.isClosed()) throw new Error("the opened transport is unavailable");
    const jsm = await jetstreamManager(connection, { checkAPI: false, timeout: 2_000 });
    const streamInfo = await jsm.streams.info(stream);
    const info = await jsm.consumers.info(stream, durable);
    if (streamInfo.config.name !== stream || !streamInfo.created || !matches(info) || !info.created)
      throw new Error("the own inbox creation identity could not be verified");
    pin = { streamCreated: streamInfo.created, consumerCreated: info.created };
    return session;
  } catch {
    const close = await session.close();
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the routing-only chat opening did not finish; no automatic retry was made", {
      target: { space: target.space, principal: identity.principal, lifecycleUid: uid },
      native: { outcome: "unknown", detail: { close } },
      remedy: "inspect the original broker before another opening; an unconfirmed inbox remains subject to its inactive backstop",
    });
  }
}

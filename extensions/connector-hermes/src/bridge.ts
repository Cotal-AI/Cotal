/**
 * The Hermes adapter bridge — a local unix-socket server the in-gateway Python plugin connects
 * to. It is the half of the integration that connector-core's one-shot control socket (used for
 * presence hooks, via the relay.ts pattern) can't do: a **persistent, bidirectional** channel so
 * the sidecar can *push* inbound mesh messages into a live gateway turn (wake / queue / interrupt)
 * and the plugin can route turn replies + cotal_* tool calls back out over the same {@link MeshAgent}.
 *
 * Wire format: newline-delimited JSON, both directions.
 *
 *   Python → sidecar
 *     {t:"subscribe"}                          adapter: start receiving inbound pushes
 *     {t:"delivered", recvKey}                 adapter: turn accepted delivery <recvKey> → ack it on the stream
 *     {t:"deferred", recvKey}                  adapter: the host would not take delivery <recvKey> →
 *                                              leave it unacked, offer it again after DEFER_MS
 *     {t:"reply", target, text, replyTo?, contextId?}
 *                                              adapter: route a turn's reply back to its origin,
 *                                              answering message <replyTo> in conversation <contextId>
 *     {t:"tool", id, name, args, contextId?, peerId?}
 *                                              tools: invoke a cotal_* tool (full shared surface);
 *                                              a question it asks carries <contextId>, this call
 *                                              only; a DM to <peerId>, whose session it runs in,
 *                                              answers that peer
 *
 *   sidecar → Python
 *     {t:"incoming", msg}                      push one buffered mesh message (for handle_message)
 *     {t:"tool_result", id, ok, text?, isError?, error?}   reply to a {t:"tool"} request
 *
 * Delivery is **serial + ack-on-surface**: the sidecar pushes the oldest buffered message, waits
 * for the adapter's `delivered`, then `drainInbox(1)` acks exactly that message before pushing the
 * next. A crash before `delivered` redelivers — nothing is lost, matching the stream-backed inbox
 * contract. (One adapter connection at a time; a fresh `subscribe` supersedes the previous.)
 *
 * Tool calls are dispatched generically over {@link cotalToolSpecs} (looked up by name), so this
 * bridge never has to enumerate the surface — full parity by construction.
 *
 * One gateway runs many sessions over this one seat, so correlation is per frame, never the seat's
 * single context id: the plugin stamps each question with its own `contextId`, and an incoming DM
 * carries `answersQuestion` when it copies one from the peer the question went to, so the adapter
 * can run it in the session that asked (see replies.py).
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  cotalToolSpecs,
  parseToolArgs,
  NO_TOOL_ARGS,
  tokenMatches,
  MAX_FRAME_BYTES,
  AUTH_DEADLINE_MS,
  type MeshAgent,
  type AgentConfig,
  type Correlation,
  type InboxItem,
  type CotalToolSpec,
} from "@cotal-ai/connector-core";

/** Reply routing target the adapter derives from a turn's session/chat id. */
interface ReplyTarget {
  channel?: string;
  /** Peer instance id (or name) for a DM/anycast reply. */
  peerId?: string;
}

/** How long a delivery the host would not take waits before it is offered again. */
const DEFER_MS = 30_000;

/** An optional string field of a frame; anything else is absent. */
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function log(msg: string): void {
  process.stderr.write(`[cotal-hermes/bridge] ${msg}\n`);
}

/** The inbox item, flattened for the Python side (handle_message builds a MessageEvent from it). */
function wireItem(agent: MeshAgent, i: InboxItem): Record<string, unknown> {
  return {
    id: i.id,
    // #624: the opaque per-delivery receive key. The sidecar echoes this back on `delivered`, so
    // the bridge can ack THIS delivery. For an id-less message the wire id is "", which the
    // delivered guard below would treat as falsy and never match: the bridge would wedge forever
    // after surfacing one empty-id message. The receive key is never "" and never a dedup key.
    recvKey: i.recvKey,
    ts: i.ts,
    kind: i.kind,
    channel: i.channel,
    service: i.service,
    fromId: i.fromId,
    fromName: i.fromName,
    fromRole: i.fromRole,
    mentions: i.mentions,
    mentionsMe: i.mentionsMe,
    // Backfilled on join: the sidecar frames it as history, as connector-core's fmtItem does.
    // Without it a restart replays every retained mention as a live turn (#2205).
    historical: i.historical,
    text: i.text,
    replyTo: i.replyTo,
    contextId: i.contextId,
    // The DM answers a question this seat asked, from the peer it asked: only then may the adapter
    // route it by its contextId (see MeshAgent.answersQuestion).
    answersQuestion: agent.answersQuestion(i),
  };
}

export interface BridgeServer {
  close(): void;
}

/** Start the adapter bridge. Returns a handle whose `close()` stops the server. `token` is the
 *  launch's control token: the same shared secret {@link startControlServer} authenticates the
 *  control plane with, presented here as the first frame's `token` field. */
export function startBridgeServer(agent: MeshAgent, config: AgentConfig, socketPath: string, token: string): BridgeServer {
  const digest = createHash("sha256").update(token).digest();

  if (process.platform !== "win32" && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath); // clear a stale socket from a dead predecessor
    } catch {
      /* ignore */
    }
  }

  // The shared tool surface, indexed by name — calls are dispatched straight onto these specs.
  const specs = new Map<string, CotalToolSpec>(cotalToolSpecs(config, "hermes").map((s) => [s.name, s]));

  /** The single subscribed adapter connection, and the id we're currently awaiting an ack for. */
  let adapter: Socket | undefined;
  let awaitingId: string | undefined;
  /** Receive keys of deliveries the host would not take, each held back until its timer frees it. */
  const deferred = new Set<string>();

  const sendFrame = (sock: Socket, frame: Record<string, unknown>): void => {
    try {
      sock.write(JSON.stringify(frame) + "\n");
    } catch (e) {
      log(`write failed: ${(e as Error).message}`);
    }
  };

  /** Push the oldest buffered message to the adapter, one at a time. Acks happen only on the
   *  adapter's `delivered` (see below), so a turn that never surfaces a message redelivers it. A
   *  deferred one waits out its delay while the messages behind it go first. */
  const pump = (): void => {
    if (!adapter || awaitingId) return;
    const next = agent.peekInbox("automatic").find((i) => !deferred.has(i.recvKey));
    if (!next) return;
    awaitingId = next.recvKey;
    sendFrame(adapter, { t: "incoming", msg: wireItem(agent, next) });
  };

  agent.on("incoming", () => pump());
  // The Stop→idle batch flush (see the hook handle): an idle gateway has nothing in flight, so a
  // wake is just another reason to drain whatever is buffered.
  agent.on("wake", () => pump());

  const onReply = async (target: ReplyTarget, text: string): Promise<void> => {
    if (!text.trim()) return;
    if (target.channel) await agent.send(text, target.channel);
    else if (target.peerId) await agent.dm(target.peerId, text);
  };

  /** Run a cotal_* tool by name against the shared specs. cotal_inbox consumes only pull-only
   *  quiet traffic, so it cannot race the connector's automatic per-turn delivery ack.
   *
   *  The args arrive raw off the sidecar socket — nothing above us has validated them against the
   *  descriptor we published, so this is the only place the spec's closed object can bite. An
   *  unmodelled key is refused by name rather than dropped: on the MCP and pi hosts the host
   *  itself refuses one, and a key the model believes it sent (`owner`, `actor`) must not go
   *  silently missing here just because Hermes's validation lives outside our process.
   *
   *  cotal_inbox is the one tool whose enforced contract is NOT the shared spec's: Hermes publishes
   *  it with no parameters (`peek` is deliberately withheld — the pull is destructive here) and its
   *  `scope` is ours, not the caller's. Validate against what we actually published, not against
   *  the spec — otherwise `peek` passes the check and is then dropped by the substitution, which is
   *  the silent-drop this seam exists to close, reopened for one tool.
   *
   *  The call runs under the frame's `correlation`, entered only once its args are accepted. */
  const onTool = async (
    name: string,
    args: Record<string, unknown>,
    correlation: Correlation,
  ): Promise<{ text: string; isError: boolean }> => {
    const spec = specs.get(name);
    if (!spec) throw new Error(`unknown cotal tool: ${name}`);
    const published = name === "cotal_inbox" ? { ...spec, schema: NO_TOOL_ARGS } : spec;
    const caller = parseToolArgs(published, args);
    const a = name === "cotal_inbox" ? { scope: "pull-only" } : caller;
    const r = await agent.withCorrelation(correlation, () => spec.run(agent, config, a));
    return { text: r.text, isError: !!r.isError };
  };

  const handleFrame = async (sock: Socket, frame: Record<string, unknown>): Promise<void> => {
    switch (frame.t) {
      case "subscribe":
        adapter = sock;
        awaitingId = undefined;
        log("adapter subscribed");
        pump();
        return;
      case "delivered":
        // Address by the receive key the sidecar echoes (NOT the wire id: an id-less message's
        // id is "", which the old truthiness guard silently never matched).
        if (typeof frame.recvKey === "string" && frame.recvKey !== "" && frame.recvKey === awaitingId) {
          // Ack exactly the surfaced message — but ONLY if it's still the front. MeshAgent
          // force-evicts (and acks) from the FRONT at MAX_INBOX, so a large ambient burst during a
          // long turn can already have evicted our in-flight item; draining the front then would
          // mis-ack a newer, unsurfaced message (losing it). If the front is no longer ours, the
          // overflow already acked it — just resync and let pump() surface the new front.
          agent.drainInboxDeliveries([awaitingId]);
          awaitingId = undefined;
          pump();
        }
        return;
      case "deferred":
        // The host would not run it where it belongs (see adapter.py). It stays buffered and unacked.
        if (typeof frame.recvKey === "string" && frame.recvKey !== "" && frame.recvKey === awaitingId) {
          const key = awaitingId;
          deferred.add(key);
          awaitingId = undefined;
          setTimeout(() => {
            deferred.delete(key);
            pump();
          }, DEFER_MS).unref();
          pump();
        }
        return;
      case "reply":
        try {
          await agent.withCorrelation({ replyTo: str(frame.replyTo), contextId: str(frame.contextId) }, () =>
            onReply((frame.target ?? {}) as ReplyTarget, String(frame.text ?? "")),
          );
        } catch (e) {
          log(`reply failed: ${(e as Error).message}`);
        }
        return;
      case "tool": {
        const id = frame.id;
        try {
          const { text, isError } = await onTool(String(frame.name), (frame.args ?? {}) as Record<string, unknown>, {
            contextId: str(frame.contextId),
            peerId: str(frame.peerId),
          });
          sendFrame(sock, { t: "tool_result", id, ok: true, text, isError });
        } catch (e) {
          sendFrame(sock, { t: "tool_result", id, ok: false, error: (e as Error).message });
        }
        return;
      }
      default:
        log(`unknown frame: ${JSON.stringify(frame).slice(0, 120)}`);
    }
  };

  const server: Server = createServer((sock) => {
    let buf = "";
    let authenticated = false;
    sock.setEncoding("utf8");
    // ABSOLUTE deadline (not an idle timeout) on an unauthenticated connection — a slow-loris
    // dribbling one byte at a time must not camp on the socket forever. Cleared the instant the
    // first frame is in hand (successful or not: either way the connection is decided).
    const deadline = setTimeout(() => sock.destroy(), AUTH_DEADLINE_MS);
    deadline.unref?.();
    const dropUnauthenticated = (): void => {
      clearTimeout(deadline);
      log("bridge: dropped an unauthenticated connection");
      sock.destroy();
    };
    sock.on("data", (d) => {
      buf += d;
      if (!authenticated && buf.length > MAX_FRAME_BYTES) {
        // oversized pre-auth frame — drop hard, never half-close (it keeps spewing)
        dropUnauthenticated();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: Record<string, unknown> = {};
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          if (!authenticated) {
            dropUnauthenticated();
            return;
          }
          log(`malformed frame dropped`);
          continue;
        }
        if (!authenticated) {
          // The first frame off an unauthenticated connection must be the subscribe carrying the
          // launch's control token — anything else (a wrong/missing token, or any other frame
          // type) is dropped before `adapter` can be assigned or `onTool` reached.
          if (frame.t !== "subscribe" || !tokenMatches(frame.token, digest)) {
            dropUnauthenticated();
            return;
          }
          clearTimeout(deadline);
          authenticated = true;
          // This same subscribe frame is also the subscribe — handleFrame's "subscribe" case
          // assigns `adapter` and pumps the queue.
          void handleFrame(sock, frame);
          continue;
        }
        void handleFrame(sock, frame);
      }
    });
    sock.on("close", () => {
      clearTimeout(deadline);
      if (sock === adapter) {
        adapter = undefined;
        awaitingId = undefined;
        log("adapter disconnected");
      }
    });
    sock.on("error", () => {
      /* ignore client errors */
    });
  });

  let bound = false;
  server.on("error", (e) => {
    log(`server error: ${(e as Error).message}`);
    // A bind we never held (e.g. EADDRINUSE from a squatter) is fatal: better to die than leave a
    // dead bridge behind a live seat that thinks it has one.
    if (!bound) process.exit(1);
  });
  server.listen(socketPath, () => {
    bound = true;
    log(`listening: ${socketPath}`);
  });

  return {
    close() {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}

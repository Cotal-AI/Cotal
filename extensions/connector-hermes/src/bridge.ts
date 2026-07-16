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
 *     {t:"delivered", id}                      adapter: turn accepted msg <id> → ack it on the stream
 *     {t:"reply", target, text}                adapter: route a turn's reply back to its origin
 *     {t:"tool", id, name, args}               tools: invoke a cotal_* tool (full shared surface)
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
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { cotalToolSpecs, type MeshAgent, type AgentConfig, type InboxItem, type CotalToolSpec } from "@cotal-ai/connector-core";

/** Reply routing target the adapter derives from a turn's session/chat id. */
interface ReplyTarget {
  channel?: string;
  /** Peer instance id (or name) for a DM/anycast reply. */
  peerId?: string;
}

function log(msg: string): void {
  process.stderr.write(`[cotal-hermes/bridge] ${msg}\n`);
}

/** The inbox item, flattened for the Python side (handle_message builds a MessageEvent from it). */
function wireItem(i: InboxItem): Record<string, unknown> {
  return {
    id: i.id,
    ts: i.ts,
    kind: i.kind,
    channel: i.channel,
    service: i.service,
    fromId: i.fromId,
    fromName: i.fromName,
    fromRole: i.fromRole,
    mentions: i.mentions,
    mentionsMe: i.mentionsMe,
    text: i.text,
    replyTo: i.replyTo,
    contextId: i.contextId,
  };
}

export interface BridgeServer {
  close(): void;
}

/** Start the adapter bridge. Returns a handle whose `close()` stops the server. */
export function startBridgeServer(agent: MeshAgent, config: AgentConfig, socketPath: string): BridgeServer {
  if (existsSync(socketPath)) {
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

  const sendFrame = (sock: Socket, frame: Record<string, unknown>): void => {
    try {
      sock.write(JSON.stringify(frame) + "\n");
    } catch (e) {
      log(`write failed: ${(e as Error).message}`);
    }
  };

  /** Push the oldest buffered message to the adapter, one at a time. Acks happen only on the
   *  adapter's `delivered` (see below), so a turn that never surfaces a message redelivers it. */
  const pump = (): void => {
    if (!adapter || awaitingId) return;
    const pending = agent.peekInbox("automatic");
    if (!pending.length) return;
    const next = pending[0];
    awaitingId = next.id;
    sendFrame(adapter, { t: "incoming", msg: wireItem(next) });
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
   *  quiet traffic, so it cannot race the connector's automatic per-turn delivery ack. */
  const onTool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const spec = specs.get(name);
    if (!spec) throw new Error(`unknown cotal tool: ${name}`);
    const a = name === "cotal_inbox" ? { scope: "pull-only" } : (args ?? {});
    const r = await spec.run(agent, config, a);
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
        if (frame.id && frame.id === awaitingId) {
          // Ack exactly the surfaced message — but ONLY if it's still the front. MeshAgent
          // force-evicts (and acks) from the FRONT at MAX_INBOX, so a large ambient burst during a
          // long turn can already have evicted our in-flight item; draining the front then would
          // mis-ack a newer, unsurfaced message (losing it). If the front is no longer ours, the
          // overflow already acked it — just resync and let pump() surface the new front.
          agent.drainInboxIds([awaitingId]);
          awaitingId = undefined;
          pump();
        }
        return;
      case "reply":
        try {
          await onReply((frame.target ?? {}) as ReplyTarget, String(frame.text ?? ""));
        } catch (e) {
          log(`reply failed: ${(e as Error).message}`);
        }
        return;
      case "tool": {
        const id = frame.id;
        try {
          const { text, isError } = await onTool(String(frame.name), (frame.args ?? {}) as Record<string, unknown>);
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
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: Record<string, unknown> = {};
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          log(`malformed frame dropped`);
          continue;
        }
        void handleFrame(sock, frame);
      }
    });
    sock.on("close", () => {
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

  server.on("error", (e) => log(`server error: ${(e as Error).message}`));
  server.listen(socketPath, () => log(`listening: ${socketPath}`));

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

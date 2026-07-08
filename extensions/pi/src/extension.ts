/**
 * The Cotal mesh as a pi extension: load this file into ANY pi session — the interactive
 * TUI (`pi --extension …`), a headless mode, or an agent built on pi's SDK (pi's default
 * resource loader discovers `~/.pi/agent/extensions/`) — and that session becomes a mesh
 * peer. Inbound DMs, role anycasts, @mentions, and wakeable channel chatter are injected as
 * user messages into the live session (directed traffic can steer mid-turn); the MODEL replies by
 * calling the cotal_* send tools (cotal_dm / cotal_send / cotal_anycast) — the same
 * model-initiated contract as every sibling connector, so nothing leaves the peer that
 * the model didn't deliberately send. This loop only surfaces inbound and acks.
 *
 * Delivery is ack-on-surface via {@link InboxTurn}: a surfaced message is acked only when
 * the turn that consumed it completes, so a crash or kill redelivers — no message loss.
 * One accepted residual: pi's extension API cannot drain the steering queue at turn end,
 * so a message steered after the loop's final queue poll can carry into the next turn
 * (the in-session operator sees both turns; SDK embedders who need the race fully closed
 * can drive their own session and use `session.clearQueue()` + `InboxTurn.commitExcept`).
 *
 * Activation is opt-in by mesh identity: with NO `COTAL_*` config in the env the extension
 * stays inert — a globally-installed copy must not touch the user's normal pi sessions.
 * COTAL_* config without an identity (`COTAL_NAME` / `COTAL_AGENT_FILE` / `COTAL_LINK`), or
 * an identity that's invalid, fails loud — never a session that silently isn't on the mesh.
 */
import { MeshAgent, configFromEnv, formatInjection, hasIdentity } from "@cotal-ai/connector-core";
import type { InboxItem } from "@cotal-ai/connector-core";
import { InboxTurn } from "./inbox-turn.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCotalTools } from "./tools.js";

/** Own echoes are never useful to surface. */
function ownEcho(mesh: MeshAgent, item: InboxItem): boolean {
  return item.fromId === mesh.id;
}

/** Directed messages may steer a live turn; ambient channel chatter waits for the next pump. */
function directed(mesh: MeshAgent, item: InboxItem): boolean {
  return !ownEcho(mesh, item) && (item.kind !== "channel" || item.mentionsMe);
}

/** The final assistant message's stopReason ("stop" | "aborted" | "error"), if any. */
function lastStopReason(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; stopReason?: unknown };
    if (m.role === "assistant") return typeof m.stopReason === "string" ? m.stopReason : undefined;
  }
  return undefined;
}

export default function cotalMesh(pi: ExtensionAPI): void {
  if (!hasIdentity()) {
    // Inert is only safe when the operator plainly didn't opt in. OTHER COTAL_* config with no
    // identity is a misconfiguration (e.g. a typo'd COTAL_NAME) — running the session normally
    // while silently never joining the mesh is exactly the no-fallbacks failure mode. (Global
    // operator settings like COTAL_FEEDBACK_EMAIL don't signal intent to join.)
    const stray = Object.keys(process.env).filter(
      (k) => k.startsWith("COTAL_") && k !== "COTAL_FEEDBACK_EMAIL",
    );
    if (stray.length)
      throw new Error(
        `COTAL config present (${stray.join(", ")}) but no mesh identity — set COTAL_NAME, ` +
          `COTAL_AGENT_FILE, or COTAL_LINK to join, or unset COTAL_* to run pi off-mesh`,
      );
    return; // no COTAL config at all → stay inert (opt-in switch)
  }

  const config = configFromEnv();
  config.connector = "pi"; // advertise the host harness on our AgentCard (meta.connector)
  const mesh = new MeshAgent(config);
  const turn = new InboxTurn(mesh);
  let streaming = false; // gates steer-delivery: only once the agent is actually running
  /** Ids folded mid-turn whose steer delivery THREW — surfaced but never reached the model.
   *  agent_end commits everything except these, so they stay on the stream and redeliver. */
  const failedSteer = new Set<string>();

  const setStatus = (status: "idle" | "working", activity?: string): void => {
    void mesh.setStatus(status, activity).catch(() => {});
  };

  /** Start the next connector-owned turn when the shared attention policy says something should wake us.
   *  Leading own echoes are ack-dropped, but ambient chatter stays buffered: in open mode it
   *  can wake an idle session; in dnd/quiet it rides the next directed or human-driven turn. */
  function pump(force = false, steer = false): void {
    if (turn.inFlight) return;
    turn.drop((i) => ownEcho(mesh, i));
    if (force ? mesh.inboxCount() === 0 : mesh.pendingWake() === 0) {
      if (!force) setStatus("idle");
      return;
    }
    const origin = turn.start();
    if (!origin) {
      setStatus("idle");
      return;
    }
    const batch = [origin, ...turn.extend((i) => !ownEcho(mesh, i))];
    const injection = formatInjection(batch)!;
    // A plain send is REFUSED by pi while an agent turn is streaming (e.g. a human-driven turn
    // with an empty backlog at agent_start) — deliver as steer whenever one is live, or the
    // surfaced batch would be silently dropped yet acked at agent_end. If delivery still
    // throws, abandon: the batch stays on the stream and redelivers instead of being lost.
    try {
      if (steer || streaming) pi.sendUserMessage(injection, { deliverAs: "steer" });
      else pi.sendUserMessage(injection); // lands in the live session; always triggers a turn
    } catch {
      turn.abandon();
    }
  }

  /** Fold front-contiguous directed messages into the live turn (true mid-turn steer).
   *  Ambient chatter does not steer; it waits for the next between-turn pump. */
  function fold(): void {
    if (!turn.inFlight || !streaming) return;
    const items = turn.extend((i) => directed(mesh, i));
    if (!items.length) return;
    try {
      pi.sendUserMessage(formatInjection(items)!, { deliverAs: "steer" });
    } catch {
      // Already surfaced but never delivered — exempt from the commit so they redeliver.
      for (const i of items) failedSteer.add(i.id);
    }
  }

  // The full shared cotal_* surface — the model owns replies (cotal_dm / cotal_send /
  // cotal_anycast), exactly like the Claude Code and OpenCode peers.
  registerCotalTools(pi, mesh, config);

  mesh.on("incoming", () => (turn.inFlight ? fold() : pump()));
  mesh.on("wake", () => {
    if (!turn.inFlight) pump();
  });
  // Focus-mode @mention: the body was ack-dropped at ingest (recallable via cotal_inbox), so
  // there is nothing to surface or commit — a bare nudge is the whole job. Without this
  // handler a peer whose model set attention=focus goes permanently deaf to mentions (the
  // sibling connectors all subscribe to this event).
  mesh.on("mention-wake", (item: InboxItem) => {
    const nudge =
      `📨 Cotal — you were @mentioned on #${item.channel} by "${item.fromName}"` +
      `${item.fromRole ? ` (${item.fromRole})` : ""} while in focus. The message body is held — ` +
      `read it with cotal_inbox and reply with cotal_send if warranted.`;
    // Steer whenever ANY turn is streaming (incl. human-driven ones): a plain send is refused
    // by pi mid-turn, and the mention body was already acked at ingest — a dropped nudge would
    // never redeliver, leaving the peer deaf to that mention.
    try {
      pi.sendUserMessage(nudge, streaming ? { deliverAs: "steer" } : undefined);
    } catch {
      /* nothing to abandon — the recall path (cotal_inbox) still holds the body */
    }
  });

  pi.on("session_start", () => {
    mesh.start();
    pump(); // drain anything buffered before the listeners attached
  });
  pi.on("agent_start", () => {
    streaming = true;
    setStatus("working", "thinking");
    if (turn.inFlight) fold(); // flush directed peers that landed before streaming began
    else pump(true, true); // human-started turn: surface any quiet/dnd backlog as steer context
  });
  pi.on("tool_execution_start", (ev) => {
    setStatus("working", `running ${(ev as { toolName?: string }).toolName ?? "tool"}`);
  });
  pi.on("tool_execution_end", () => {
    setStatus("working", "thinking"); // clear the per-tool activity so it can't read stale
  });
  pi.on("agent_end", (ev) => {
    streaming = false;
    // Esc/abort restores unconsumed queued messages to the human's editor instead of the model —
    // committing would ack messages never seen. An aborted turn ends with stopReason "aborted":
    // abandon so the surfaced run stays on the stream and redelivers. A clean or errored finish
    // commits (per the InboxTurn contract: a failed turn is dropped, not retry-looped).
    if (lastStopReason(ev.messages) === "aborted") turn.abandon();
    else turn.commitExcept((i) => failedSteer.has(i.id)); // sole ack site; failed folds redeliver
    failedSteer.clear();
    setImmediate(pump); // next batch, after the session settles
  });
  pi.on("session_shutdown", async () => {
    if (turn.inFlight) turn.abandon(); // leave the in-flight run on the stream → redeliver
    await mesh.stop().catch(() => {});
  });
}

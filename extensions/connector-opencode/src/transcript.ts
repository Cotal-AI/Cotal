/**
 * OpenCode transcript mirror — publishes the agent's OWN session output to the per-agent `tr-<name>`
 * channel (assistant text in full, tool calls as one-liners, tool results truncated, reasoning
 * omitted) so observers can read what an OpenCode agent ACTUALLY did — not only what it narrates on
 * the work channels (the Claude connector has had this; OpenCode did not).
 *
 * EVENT-DRIVEN, not poll-based. The connector plugin already receives OpenCode's bus events
 * in-process, so the mirror taps them (the same live stream the frontier-faces studio proxies to its
 * browser, instead of re-reading the session each frame):
 *   • record(msg)   ← message.updated:      learn which messageIDs are ASSISTANT (mirror the agent's
 *                                           own output, never the injected user/peer turns).
 *   • observe(part) ← message.part.updated: condense the part NOW and buffer its lines (tool results
 *                                           truncated to a preview, assistant text kept in full;
 *                                           keyed by `${messageID}:${partID}`, replaced as it streams).
 *   • flush()       ← session.idle:         publish the turn's settled assistant lines, then clear.
 *   • reset()       ← session adoption:     drop the buffer at a hard boundary (`/new`).
 * Cost is O(parts-this-turn) with NO HTTP — unlike a fetch-the-whole-session-every-idle poll, which is
 * O(N²) and grows unboundedly over a long session. flush() snapshots the turn's lines and clears before
 * it publishes, so a duplicate/late session.idle can't republish the batch.
 *
 * Each turn's lines are published ONCE to the channel; DURABLE delivery (persistence, replay to offline
 * readers) is the channel's job — a durable `tr-<name>` is JetStream-backed — not a hand-rolled retry
 * buffer here. This mirror is therefore best-effort at the publish boundary: the plugin runs flush() on
 * the turn-end path and keeps a transport error OFF the turn loop by logging it (so a failed publish can
 * never wedge the agent) — which means a publish that fails outright drops THAT turn's lines. That is
 * the deliberate tradeoff for an opt-in observability side-channel; it is logged, never silent.
 */
import type { MeshAgent } from "@cotal-ai/connector-core";

const MAX_PREVIEW = 700; // tool results — enough to see what happened
const MAX_CHUNK = 6000; // chars per published message

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A tool call's most salient input — mirrors the Claude connector's `salient`. */
function salient(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.filePath ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.description;
  const s = typeof v === "string" ? v : Object.keys(i).length ? JSON.stringify(i) : "";
  return s ? `: ${truncate(s, 300)}` : "";
}

/** One OpenCode message Part → the line(s) worth mirroring (empty for reasoning/file/step/etc). */
function condensePart(part: any): string[] {
  switch (part?.type) {
    case "text":
      if (part.synthetic || part.ignored || !part.text?.trim()) return [];
      return [part.text.trim()]; // assistant text in FULL — chunkLines splits it across messages

    case "tool": {
      const head = `⚒ ${part.tool}${salient(part.state?.input)}`;
      const status = part.state?.status;
      if (status === "completed")
        return [head, `→ ${truncate(String(part.state.output ?? ""), MAX_PREVIEW) || "(no output)"}`];
      if (status === "error") return [head, `→ ERROR: ${truncate(String(part.state.error ?? ""), MAX_PREVIEW)}`];
      return [head];
    }
    default:
      return []; // reasoning (thinking) omitted; file/step/snapshot/patch skipped
  }
}

/** Batch lines into wire-sized chunks, splitting on line boundaries — and hard-splitting any single
 *  line longer than `max` (e.g. a long assistant answer/code block) so full text is preserved across
 *  messages rather than truncated. */
function chunkLines(lines: string[], max: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const ln of lines) {
    if (ln.length > max) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (let i = 0; i < ln.length; i += max) chunks.push(ln.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + ln.length + 1 > max) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${ln}` : ln;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface TranscriptMirror {
  /** message.updated → remember which messageIDs are assistant-authored (this turn). */
  record(message: any): void;
  /** message.part.updated → condense+truncate the part and buffer its lines (keyed by id, this turn). */
  observe(part: any): void;
  /** session.idle → publish the turn's settled assistant lines to the channel, then clear. */
  flush(): Promise<void>;
  /** session adoption (`/new`) → drop the buffer so a new session never inherits stale parts. */
  reset(): void;
}

/** An event-driven mirror to `channel`, fed from the plugin's OpenCode event hook. */
export function createTranscriptMirror(agent: MeshAgent, channel: string): TranscriptMirror {
  // One turn's worth, cleared every flush. `condensed` keeps each part's already-condensed lines (not
  // the raw part) — tool results truncated to a preview, assistant text kept in full — so noisy tool
  // output never sits in memory at full size. Map insertion order preserves emission order (a later
  // .updated replaces the value, keeping its slot).
  const assistantMsgs = new Set<string>(); // messageIDs whose role is "assistant"
  // Keyed by `${messageID}:${partID}` (NOT partID alone): OpenCode part ids are message-scoped, so a
  // multi-message turn could otherwise collide two parts on the same id and drop output.
  const condensed = new Map<string, { messageID: string; lines: string[] }>();
  const clear = (): void => {
    condensed.clear();
    assistantMsgs.clear();
  };

  return {
    record(message) {
      const info = message?.info ?? message;
      if (info?.role === "assistant" && typeof info.id === "string") assistantMsgs.add(info.id);
    },
    observe(part) {
      if (!part?.id || typeof part.messageID !== "string") return;
      const key = `${part.messageID}:${part.id}`;
      const lines = condensePart(part); // condense NOW (tool results truncated) → assistant text kept full
      if (lines.length) condensed.set(key, { messageID: part.messageID, lines });
      else condensed.delete(key); // a part that condensed to nothing (e.g. reasoning) holds no slot
    },
    async flush() {
      // Collect this turn's assistant lines and clear — each turn's output is published ONCE, then
      // forgotten. Snapshot-then-clear before the await means a duplicate/late session.idle finds an
      // empty buffer and can't republish. Delivery reliability is the CHANNEL's job (NATS/JetStream),
      // not a hand-rolled retry buffer here.
      const lines: string[] = [];
      for (const { messageID, lines: ls } of condensed.values())
        if (assistantMsgs.has(messageID)) lines.push(...ls); // the agent's OWN output, not injected turns
      clear();
      for (const chunk of chunkLines(lines, MAX_CHUNK)) await agent.send(chunk, channel);
    },
    reset() {
      clear();
    },
  };
}

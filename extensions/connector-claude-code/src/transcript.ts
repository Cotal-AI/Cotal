/**
 * Transcript mirror — publishes this session's own Claude Code transcript (the JSONL
 * behind the hooks' `transcript_path`) onto a per-agent mesh channel, `tr-<name>`, so
 * peers and observer agents can read what the agent is ACTUALLY doing, not only what
 * it chooses to narrate.
 *
 * Off unless the launch sets COTAL_TRANSCRIPT (the connector's buildLaunch sets it for
 * managed sessions; a personal session never mirrors). Flushes ride the lifecycle hooks:
 * read the JSONL from the last offset, condense each entry to its observable surface
 * (assistant text in full, tool calls as one-liners, tool results truncated, thinking
 * omitted), and multicast the batch. The offset starts at end-of-file on adopt, so a
 * resumed session never rebroadcasts history. Publishing is at-least-once: the offset
 * commits only after a successful publish, so a mesh outage replays the batch rather
 * than losing it.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { MeshAgent } from "@cotal-ai/connector-core";

const MAX_PREVIEW = 700; // tool results / user prompts — enough to see what happened
const MAX_CHUNK = 6000; // chars per published message; batches split on entry boundaries

// The `tr-<name>` convention now lives in connector-core (shared with the manager + opencode
// connector). Re-exported here so existing imports (mcp.ts, index.ts) keep resolving.
export { transcriptChannel } from "@cotal-ai/connector-core";

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A tool call's most salient input, mirroring the presence preview in mcp.ts. */
function salient(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.description;
  const s = typeof v === "string" ? v : Object.keys(i).length ? JSON.stringify(i) : "";
  return s ? `: ${truncate(s, 300)}` : "";
}

/** Flatten a tool_result's content (string or text-block array) to plain text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

/** One JSONL entry → the lines worth mirroring (empty for meta/system/thinking-only entries). */
function condense(line: string): string[] {
  let e: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
  try {
    e = JSON.parse(line) as typeof e;
  } catch {
    return [];
  }
  if (!e || e.isMeta) return [];
  const content = e.message?.content;
  if (e.type === "assistant" && Array.isArray(content)) {
    const out: string[] = [];
    for (const b of content as { type?: string; text?: string; name?: string; input?: unknown }[]) {
      if (b.type === "text" && b.text?.trim()) out.push(b.text.trim());
      else if (b.type === "tool_use" && b.name) out.push(`⚒ ${b.name}${salient(b.input)}`);
    }
    return out;
  }
  if (e.type === "user") {
    if (typeof content === "string")
      return content.trim() ? [`» ${truncate(content.trim(), MAX_PREVIEW)}`] : [];
    if (Array.isArray(content)) {
      const out: string[] = [];
      for (const b of content as { type?: string; text?: string; content?: unknown; is_error?: boolean }[]) {
        if (b.type === "tool_result") {
          const t = resultText(b.content).trim();
          out.push(`→ ${b.is_error ? "ERROR: " : ""}${t ? truncate(t, MAX_PREVIEW) : "(no output)"}`);
        } else if (b.type === "text" && b.text?.trim()) {
          out.push(`» ${truncate(b.text.trim(), MAX_PREVIEW)}`);
        }
      }
      return out;
    }
  }
  return [];
}

export class TranscriptMirror {
  private path?: string;
  private offset = 0;
  /** A batch that failed mid-publish: chunks + how many already landed. Retried (from the
   *  first unsent chunk — never re-sending a delivered one) before any new read. */
  private pending?: { chunks: string[]; sent: number; nextOffset: number };
  /** ALL path/offset mutation and publishing runs on this serialized chain — hook events
   *  land concurrently on the control socket. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly agent: MeshAgent,
    private readonly channel: string,
  ) {}

  /** Adopt the transcript at its CURRENT end — mirror only what happens from now on, so a
   *  resumed session (or a mirror that first sees the path mid-session) never rebroadcasts. */
  adopt(path: unknown): void {
    this.enqueue(() => {
      this.adoptNow(path);
      return Promise.resolve();
    });
  }

  /** Queue a flush of new transcript entries to the channel. Never throws, never blocks the
   *  hook reply — the read+publish runs on the serialized chain. */
  flush(path: unknown): void {
    this.enqueue(() => {
      if (!this.path) this.adoptNow(path);
      return this.doFlush();
    });
  }

  private enqueue(step: () => Promise<void>): void {
    this.chain = this.chain.then(step).catch((e) => {
      process.stderr.write(`[cotal-connector] transcript mirror: ${(e as Error).message}\n`);
    });
  }

  private adoptNow(path: unknown): void {
    if (typeof path !== "string" || !path || this.path === path) return;
    this.path = path;
    this.pending = undefined; // a batch from the old path must not commit the new offset
    try {
      this.offset = statSync(path).size;
    } catch {
      this.offset = 0; // not written yet — everything from byte 0 is this session's
    }
  }

  private async doFlush(): Promise<void> {
    if (!this.path || !this.agent.connected) return; // offset untouched — catch up next flush
    if (!this.pending) {
      const { lines, nextOffset } = this.readComplete();
      if (nextOffset === this.offset) return; // nothing new
      this.pending = { chunks: chunkLines(lines.flatMap(condense), MAX_CHUNK), sent: 0, nextOffset };
    }
    // Publish the pinned batch, tracking per-chunk progress: a mid-batch failure resumes at
    // the first UNSENT chunk (no duplicates), and only a fully delivered batch commits the
    // offset — the read range stays pinned until then.
    const p = this.pending;
    while (p.sent < p.chunks.length) {
      await this.agent.send(p.chunks[p.sent], this.channel);
      p.sent++;
    }
    this.offset = p.nextOffset;
    this.pending = undefined;
  }

  /** New complete lines since the offset (a trailing partial line stays for the next flush). */
  private readComplete(): { lines: string[]; nextOffset: number } {
    const none = () => ({ lines: [], nextOffset: this.offset }); // evaluated late — after any truncation reset
    let fd: number;
    try {
      fd = openSync(this.path!, "r");
    } catch {
      return none();
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) this.offset = 0; // truncated/rotated — start over
      if (size === this.offset) return none();
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      const text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) return none();
      return {
        lines: text.slice(0, lastNl).split("\n").filter(Boolean),
        nextOffset: this.offset + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8"),
      };
    } finally {
      closeSync(fd);
    }
  }
}

/** Pack lines into chunks of at most `max` chars, splitting only on line boundaries
 *  (an oversized single line becomes its own chunk — never dropped). */
function chunkLines(lines: string[], max: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur && cur.length + 1 + line.length > max) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

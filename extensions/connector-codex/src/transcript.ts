/**
 * Codex transcript mirror — publishes the agent's OWN thread output to the per-agent
 * `tr-<name>` channel (assistant text in full, commands/tool calls as one-liners,
 * reasoning omitted), at parity with the Claude Code and OpenCode mirrors.
 *
 * EVENT-DRIVEN off the app-server notification stream the host already consumes:
 *   • observe(item) ← item/completed: condense the item NOW and buffer its lines;
 *   • flush()       ← turn end:       publish the turn's settled lines, then clear.
 * Snapshot-then-clear before the await means a duplicate turn-end can't republish.
 * Best-effort at the publish boundary: the host keeps a transport error OFF the turn
 * loop (logged, never wedging the agent); durability/replay is the channel's job.
 */
import type { MeshAgent } from "@cotal-ai/connector-core";
import type { ThreadItem } from "./app-server.js";

const MAX_PREVIEW = 700; // command/tool output — enough to see what happened
const MAX_CHUNK = 6000; // chars per published message

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One completed thread item → the line(s) worth mirroring (empty for reasoning etc.). */
function condense(item: ThreadItem): string[] {
  switch (item.type) {
    case "agentMessage":
      return item.text?.trim() ? [item.text.trim()] : []; // full text — chunkLines splits it
    case "commandExecution": {
      const cmd = typeof item.command === "string" ? item.command : "";
      const exit = item.exitCode === null || item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`;
      return [`$ ${truncate(cmd, 300)}${exit}`];
    }
    case "dynamicToolCall":
    case "mcpToolCall": {
      const args = item.arguments === undefined ? "" : `: ${truncate(JSON.stringify(item.arguments), 300)}`;
      return [`⚒ ${item.tool ?? "?"}${args}${item.status === "failed" ? " (failed)" : ""}`];
    }
    case "fileChange":
      return ["✎ file change"];
    case "webSearch":
      return ["⌕ web search"];
    default:
      return []; // reasoning / userMessage (injected peer batches) / plan / … omitted
  }
}

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
  /** item/completed → buffer the item's condensed lines (preview-truncated at buffer time). */
  observe(item: ThreadItem): void;
  /** turn end → publish the turn's lines to the channel, then clear. */
  flush(): Promise<void>;
}

export function createTranscriptMirror(agent: MeshAgent, channel: string): TranscriptMirror {
  let lines: string[] = [];
  return {
    observe(item) {
      lines.push(...condense(item));
    },
    async flush() {
      const batch = lines;
      lines = [];
      for (const chunk of chunkLines(batch, MAX_CHUNK)) await agent.send(chunk, channel);
    },
  };
}

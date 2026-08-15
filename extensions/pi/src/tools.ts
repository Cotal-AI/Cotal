/**
 * The Cotal tool surface for pi, rendered from the **shared** {@link cotalToolSpecs} (the
 * same source the Claude Code MCP and OpenCode connectors render) via `pi.registerTool`.
 * One source of truth → the cotal_* surface can't drift across adapters: a pi peer gets
 * the same tools (send/dm/anycast, roster, channels, status, spawn where capable).
 *
 * The one pi-specific tool is `cotal_inbox`: the driver keeps ownership of automatic traffic,
 * while the tool destructively pulls only quiet ambient (plus read-only focus recall).
 *
 * Schemas: the shared spec carries a CLOSED Zod object; pi's `registerTool` takes a TypeBox
 * TSchema. TypeBox schemas are plain JSON Schema, so we render Zod → JSON Schema (Zod 4's
 * `toJSONSchema`, the same path the Hermes connector uses) and brand it with `Type.Unsafe`.
 */
import { z } from "zod";
import { isConcreteChannel } from "@cotal-ai/core";
import {
  cotalToolSpecs,
  MESH_FIRST_STEER,
  type MeshAgent,
  type AgentConfig,
  type CotalToolInput,
} from "@cotal-ai/connector-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

const PULL_INBOX_DESCRIPTION =
  "Pull and clear quiet-channel ambient waiting for you. Connector-managed automatic traffic " +
  "stays queued; in focus mode, normal channel recall is also shown read-only.";

/** Mesh etiquette, appended to the system prompt while the send tools are active. The first
 *  line is load-bearing: with loop-owned delivery removed, plain chat output goes nowhere —
 *  a reply EXISTS only if the model sends it through a tool. */
const SEND_GUIDELINES = [
  "Peer messages from the Cotal mesh arrive as user messages tagged 📨. Your chat output is NOT " +
    "delivered to peers — when a reply is warranted, send it with cotal_dm (back to that peer), " +
    "cotal_send (to a channel), or cotal_anycast (to a role).",
  "Reply only when a reply is actually needed — a silent acknowledgement is correct; " +
    '"agreed/thanks/good point" messages are noise. And @-mention a peer only when you need THAT ' +
    "specific peer to act: a mention wakes them, so mentioning in acknowledgements or sign-offs " +
    "makes peers ping-pong wake-ups in an endless loop.",
  MESH_FIRST_STEER,
];

function toParameters(schema: CotalToolInput | undefined): TSchema {
  if (!schema) return Type.Object({});
  // The shared spec's object is CLOSED, and a closed object emits `additionalProperties: false`
  // under every io mode — so pi's strict validation now refuses a stray key rather than matching
  // the other adapters' strip. That is the point: an unmodelled `owner`/`actor` must not vanish
  // silently on any host. io:"input" stays because this describes what a caller may SEND (it is
  // what keeps a future `.default()` field optional here); it no longer decides closure.
  return Type.Unsafe(z.toJSONSchema(schema, { io: "input" }));
}

/** `<label> → <target>: <text>` for a send-tool call, so the operator SEES what the model is
 *  sending from inside the session (pi's default extension-tool rendering shows only the label). */
function sendCallLine(name: string, config: AgentConfig, args: Record<string, unknown>): string {
  // While the call's args are still streaming in, fields may be absent — render "…" rather
  // than a bogus concrete target; the settled frame paints the real one.
  const text = String(args.text ?? "");
  if (name === "cotal_dm") return `cotal_dm → ${args.to ? `"${String(args.to)}"` : "…"}: ${text}`;
  if (name === "cotal_anycast") return `cotal_anycast → @${String(args.role ?? "…")}: ${text}`;
  // Same default the tool itself applies (first CONCRETE channel) — subscribe[0] may be a
  // wildcard like `team.>`, which the message can never actually go to. Strip a display `#`
  // the model may have echoed back, as the tool's own channel normalization does.
  const channel = String(args.channel ?? config.subscribe.find(isConcreteChannel) ?? "general").replace(/^#+/, "");
  return `cotal_send → #${channel}: ${text}`;
}

/** Word-wrap a line to the viewport, satisfying pi-tui's structural `Component` contract
 *  ({ render(width): string[]; invalidate(): void }) without importing pi-tui — the published
 *  extension must add no runtime dependency on the host. Static text: invalidate is a no-op. */
function wrapped(line: string): { render(width: number): string[]; invalidate(): void } {
  return {
    invalidate(): void {},
    render(width: number): string[] {
      const w = Math.max(16, width);
      const out: string[] = [];
      let rest = line.replace(/\s+/g, " ");
      while (rest.length > w) {
        const cut = rest.lastIndexOf(" ", w);
        const at = cut > w / 2 ? cut : w;
        out.push(rest.slice(0, at));
        rest = rest.slice(at).trimStart();
      }
      out.push(rest);
      return out;
    },
  };
}

const SEND_TOOLS = new Set(["cotal_send", "cotal_dm", "cotal_anycast"]);

/** Register the full cotal_* tool set on a pi session, wired to one mesh agent. */
export function registerCotalTools(pi: ExtensionAPI, mesh: MeshAgent, config: AgentConfig): void {
  for (const spec of cotalToolSpecs(config, "pi")) {
    const readonlyInbox = spec.name === "cotal_inbox";
    pi.registerTool({
      name: spec.name,
      label: spec.title,
       description: readonlyInbox ? PULL_INBOX_DESCRIPTION : spec.description,
      parameters: readonlyInbox ? Type.Object({}) : toParameters(spec.schema),
      promptGuidelines: spec.name === "cotal_send" ? SEND_GUIDELINES : undefined,
      renderCall: SEND_TOOLS.has(spec.name)
        ? (args) => wrapped(sendCallLine(spec.name, config, (args ?? {}) as Record<string, unknown>))
        : undefined,
      async execute(_id, params) {
        const args: Record<string, unknown> = readonlyInbox
          ? { scope: "pull-only" }
          : { ...((params ?? {}) as Record<string, unknown>) };
        if (spec.name === "cotal_send" && typeof args.channel === "string") {
          const channel = args.channel.replace(/^#+/, "");
          if (!isConcreteChannel(channel)) {
            return {
              content: [{ type: "text", text: `⚠ ${JSON.stringify(args.channel)} is not a concrete channel` }],
              details: undefined,
            };
          }
          args.channel = channel;
        }
        const r = await spec.run(mesh, config, args);
        return { content: [{ type: "text", text: r.isError ? `⚠ ${r.text}` : r.text }], details: undefined };
      },
    });
  }
}

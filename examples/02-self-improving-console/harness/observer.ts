/**
 * harness/observer.ts — log ALL mesh traffic for a run to a transcript file.
 *
 * Runs as a read-only observer. In OPEN mode (the harness starts NATS with `--open`)
 * the whole-space tap sees chat, unicast (DM), and anycast — so peer-to-peer DMs are
 * visible, which is exactly what `evaluate.ts` measures.
 *
 *   COTAL_SPACE=<space> TRANSCRIPT=<path> tsx harness/observer.ts
 */
import { appendFileSync } from "node:fs";
import { CotalEndpoint, DEFAULT_SERVER, deliveryOf, partsToText, type CotalMessage } from "@cotal-ai/core";
// Self-registers the `ag-ui.frame` renderer, which is what makes the `partsToText` below able to
// draw a frame. Without this import the shared renderer still runs, but it has no provider for that
// kind and records the `[unrenderable part kind …]` marker instead. Named rather than left implicit
// because "the transcript went quiet" and "the transcript recorded a marker" send a reader to two
// completely different places.
import "@cotal-ai/connector-core/agui-render";

const space = process.env.COTAL_SPACE || "console";
const server = process.env.COTAL_SERVERS || DEFAULT_SERVER;
const out = process.env.TRANSCRIPT || "transcript.jsonl";

/**
 * THIS USED TO DROP EVERY PART IT COULD NOT READ, and the transcript is what `evaluate.ts` scores.
 *
 * The old body filtered to `p.kind === "text"` and mapped the rest away. `parts.ts` names this
 * surface as one of the four still carrying a private copy of that expression, and the cost here is
 * the worst of the four: a message whose content is not a text part was logged as an EMPTY STRING,
 * so the record showed an agent that spoke and said nothing. An AG-UI frame carries no text part by
 * design, so every frame would have scored as silence.
 *
 * The shared renderer draws what it can and NAMES what it cannot, so a kind this build has no
 * provider for leaves a marker in the transcript rather than a blank. Nothing emits frames yet, so
 * this changes no recorded run today; it means the day one does, the harness records it instead of
 * quietly scoring it as an agent that stopped talking.
 */
function text(msg: CotalMessage): string {
  return partsToText(msg.parts ?? []);
}

const ep = new CotalEndpoint({
  space,
  servers: server,
  channels: [],
  consume: false,
  registerPresence: false,
  watchPresence: true,
  card: { name: "harness-observer", kind: "endpoint" },
});
ep.on("error", (e: Error) => process.stderr.write(`observer error: ${e.message}\n`));
ep.on("presence", (ev) => {
  appendFileSync(
    out,
    JSON.stringify({
      t: Date.now(),
      type: "presence",
      ev: ev.type,
      name: ev.presence.card.name,
      role: ev.presence.card.role,
      status: ev.presence.status,
      activity: ev.presence.activity,
    }) + "\n",
  );
});

await ep.start();
ep.tap((subject, msg) => {
  if (!msg) return;
  appendFileSync(
    out,
    JSON.stringify({
      t: Date.now(),
      type: "message",
      mode: deliveryOf(subject), // "chat" | "unicast" | "anycast" | null
      subject,
      from: msg.from?.name,
      fromId: msg.from?.id,
      fromRole: msg.from?.role,
      to: msg.to, // NOTE: recipient INSTANCE ID for unicast, not a name — resolve via fromId map
      channel: msg.channel,
      toService: msg.toService,
      text: text(msg),
    }) + "\n",
  );
});
process.stderr.write(`observer logging space "${space}" -> ${out}\n`);
await new Promise<void>(() => {});

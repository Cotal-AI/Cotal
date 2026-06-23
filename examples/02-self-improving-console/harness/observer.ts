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
import { CotalEndpoint, DEFAULT_SERVER, deliveryOf, type CotalMessage } from "@cotal-ai/core";

const space = process.env.COTAL_SPACE || "console";
const server = process.env.COTAL_SERVERS || DEFAULT_SERVER;
const out = process.env.TRANSCRIPT || "transcript.jsonl";

function text(msg: CotalMessage): string {
  return (msg.parts ?? [])
    .filter((p) => p.kind === "text")
    .map((p) => (p as { text: string }).text)
    .join(" ");
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

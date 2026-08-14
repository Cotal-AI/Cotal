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

/**
 * The TEXT parts, and only those — the name is now load-bearing.
 *
 * **This used to be the whole record of a message and it silently was not.** The `.filter` below
 * drops every non-text part before mapping, so an `artifact` part, an `ag-ui.frame` part, or any
 * future kind vanished from the transcript with nothing indicating a part had been discarded —
 * and `evaluate.ts` then measured a transcript that was quietly incomplete.
 *
 * **It is a DIFFERENT MECHANISM from the same defect in the four `bodyText`-shaped renderers**,
 * which stringify a missing `data` field to `undefined` and leave a stray separator behind. A
 * filter leaves no trace at all, and cannot be found by searching for the stringify call. That is
 * why the sweep for this has to be by OUTCOME — a part kind that reaches neither a reader nor an
 * error — rather than by expression.
 *
 * The filter STAYS, because a function called `text` returning non-text would be a worse lie. What
 * changes is that it is no longer the only thing written: the record now carries `parts` verbatim,
 * so nothing is dropped and a reader can see exactly what this line does not cover.
 *
 * **DELIBERATELY NOT UNIFIED HERE.** The right fix is core's shared `partsToText`, which renders
 * `artifact` by name and exists on `origin/main` — but NOT on this branch, which is 157 commits
 * behind it. Hand-rolling an equivalent here would create a SIXTH copy of the expression whose
 * five existing copies are the defect being fixed. It unifies when this branch has that function.
 */
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
      // EVERY part, verbatim and unrendered. `text` above covers only the text ones, so without
      // this a transcript loses whole parts silently — and a transcript that is quietly incomplete
      // is worse than one that is obviously empty, because `evaluate.ts` measures it either way.
      parts: msg.parts ?? [],
    }) + "\n",
  );
});
process.stderr.write(`observer logging space "${space}" -> ${out}\n`);
await new Promise<void>(() => {});

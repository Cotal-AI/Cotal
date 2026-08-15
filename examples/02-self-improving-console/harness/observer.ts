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
 * **It is a DIFFERENT MECHANISM from the same defect in the stringify-form renderers**, which
 * stringify a missing `data` field and leave a stray separator behind. A filter leaves no trace at
 * all, and cannot be found by searching for the stringify call. That is why the sweep for this has
 * to be by OUTCOME — a part kind that reaches neither a reader nor an error — rather than by
 * expression. The count lives in the census at the bottom of this comment and nowhere else, so it
 * has one place to go stale instead of two that can disagree.
 *
 * The filter STAYS, because a function called `text` returning non-text would be a worse lie. What
 * changes is that it is no longer the only thing written: the record now carries `parts` verbatim,
 * so nothing is dropped and a reader can see exactly what this line does not cover.
 *
 * **NOW UNIFIED, AND THE OWNERSHIP QUESTION THAT HELD IT BACK HAS BEEN ANSWERED.** This paragraph
 * previously declined to adopt core's shared `partsToText` on the grounds that this file is one of
 * the surfaces named in the AG-UI cutover's renderer precondition, that ownership of that work was
 * open, and that closing the smallest third of a gate reads as progress on it and is not. **That
 * reasoning was right and it is no longer load-bearing:** the precondition has since been ruled to
 * be "no surface silently DROPS a part", not "every surface RENDERS one", and this file and
 * `examples/04-frontier-faces/tools/studio.mjs` were assigned together. Real frame rendering and the
 * `events.*` filter are separate, still-unowned work.
 *
 * **So this change is NON-SILENCE work and claims nothing more.** It does not advance frame
 * rendering and must not be read as doing so.
 *
 * `text` above stays TEXT-ONLY on purpose, and that is not an oversight: `replay.ts` republishes
 * this exact field as message content, so folding markers into it would replay
 * `[unrenderable part kind …]` to the mesh as though an agent had typed it. The rendering goes in
 * its own field instead, where a reader gets it and no republisher mistakes it for input.
 *
 * Census re-derived at this tip rather than carried: of the seven surfaces, **5 adopted**
 * `partsToText` (`connector-core/src/agent.ts`, `cli/src/commands/join.ts`, `cli/src/view/mesh-view.ts`,
 * this file, and `studio.mjs`) and **2 keep a stringify-form copy** (`web/src/web/app.js`,
 * `.../graph.js`) — those two are routed to the lane that owns that tree, not to this one.
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
      // The same message as a READER sees it, through core's shared renderer. Separate from `text`
      // because they answer different questions and one of them is replayed: `text` is what an
      // agent actually typed, `rendered` is what the message amounts to on a surface — including a
      // named marker for any kind this build cannot draw.
      rendered: partsToText(msg.parts ?? []),
      // EVERY part, verbatim and unrendered. `text` above covers only the text ones, so without
      // this a transcript loses whole parts silently — and a transcript that is quietly incomplete
      // is worse than one that is obviously empty, because `evaluate.ts` measures it either way.
      parts: msg.parts ?? [],
    }) + "\n",
  );
});
process.stderr.write(`observer logging space "${space}" -> ${out}\n`);
await new Promise<void>(() => {});

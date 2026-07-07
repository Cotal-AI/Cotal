/**
 * Replay the captured swarm conversation through the live console — for recording a
 * demo video / GIF. It re-publishes the captured messages (examples/02…/demo-script.json)
 * back onto the same OPEN mesh the console reads, at an even, readable cadence. Plays
 * through ONCE and holds the final frame (does not loop). No console/CLI changes: the TUI
 * renders them exactly as in a live run, and the activity-pulse sparkline animates because
 * messages arrive in real time.
 *
 *   # in the tab you record:
 *   pnpm cotal up --open        # if NATS isn't already running
 *   pnpm cotal console --space console
 *
 *   # then start recording and, in another tab:
 *   pnpm tsx examples/02-self-improving-console/replay.ts
 *
 * Env knobs:
 *   STEP_MS         gap between messages (default 1900 → ~45s run; GIF: try 1200 → ~30s)
 *   START_DELAY_MS  pause before the first message (default 0 = start right away)
 *   HOLD_MS         hold the final frame before parking (default 4000)
 *   LOOPS           number of passes (default 1; set 0 to loop forever)
 *   SERVER          NATS url (default localhost:4222)
 *
 * The single `ALL DONE` wrap is floated to the very end so the demo closes on it
 * (in the real run it landed before the reviewer's last catch — this reads better).
 * Each agent shows `working` (green) across its active span (first→last message), so
 * collaborators appear busy concurrently; everyone idles out at the end.
 */
// @ts-nocheck — standalone demo script; run via tsx (not part of the typechecked build).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect } from "../../packages/core/node_modules/@nats-io/transport-node/lib/mod.js";
import { jetstream, jetstreamManager } from "../../packages/core/node_modules/@nats-io/jetstream/lib/mod.js";
import { Kvm } from "../../packages/core/node_modules/@nats-io/kv/lib/mod.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const script = JSON.parse(readFileSync(join(HERE, "demo-script.json"), "utf8"));

const SERVER = process.env.SERVER ?? "localhost:4222";
const START_DELAY_MS = Number(process.env.START_DELAY_MS ?? 0); // 0 = start right away
const STEP_MS = Number(process.env.STEP_MS ?? 1900);
const HOLD_MS = Number(process.env.HOLD_MS ?? 4000);
const LOOPS = Number(process.env.LOOPS ?? 1); // 1 = single pass then hold; 0 = loop forever

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => (m.payload.parts ?? []).map((p) => p.text ?? "").join(" ");
const isAllDone = (m) => /ALL DONE/i.test(textOf(m));

let counter = 0;
const freshId = () => `replay-${Date.now().toString(36)}-${counter++}`;

// Order: everything in capture (ts) order, then float the ALL DONE wrap to the end.
const inTs = [...script.messages].sort((a, b) => (a.payload.ts ?? 0) - (b.payload.ts ?? 0));
const SEQ = [...inTs.filter((m) => !isAllDone(m)), ...inTs.filter(isAllDone)];

// Cards for roster/presence animation, keyed by the sender id used in `from`.
const cards = (script.presence ?? []).map((p) => p.value.card).filter((c) => c?.id);

// Working-status spans: an agent shows `working` (green) from its first message to its last,
// so collaborators (backend + tui-designer) appear busy concurrently and the reviewer while it
// reviews. Outside that span it's `idle`. `latestText` feeds the roster's activity line.
const firstIdx = new Map();
const lastIdx = new Map();
SEQ.forEach((m, i) => {
  const id = m.payload.from?.id;
  if (id == null) return;
  if (!firstIdx.has(id)) firstIdx.set(id, i);
  lastIdx.set(id, i);
});
const latestText = new Map();

const nc = await connect({ servers: SERVER });
const jsm = await jetstreamManager(nc);
const js = jetstream(nc);
let presenceKv;
try {
  presenceKv = await new Kvm(js).open("cotal_presence_console");
} catch (e) {
  console.warn("presence KV unavailable (roster won't populate):", e?.message ?? e);
}

async function putPresence(card, status, activity) {
  if (!presenceKv || !card) return;
  try {
    await presenceKv.put(card.id, JSON.stringify({ card, status, activity, ts: Date.now() }));
  } catch {
    /* best-effort */
  }
}
// Presence KV entries TTL out after 6s, so a heartbeat re-asserts the whole roster every 3s —
// otherwise the agents vanish during the startup delay, the final hold, and any idle gap.
// `curStep` drives status: -1 before playback and SEQ.length after both mean "all idle".
let curStep = -1;
async function pulse() {
  await Promise.all(
    cards.map((c) => {
      const f = firstIdx.get(c.id);
      const l = lastIdx.get(c.id);
      const working = f !== undefined && curStep >= f && curStep <= l;
      return putPresence(c, working ? "working" : "idle", latestText.get(c.id));
    }),
  );
}
const heartbeat = setInterval(() => void pulse().catch(() => {}), 3000);
async function purgeHistory() {
  for (const s of ["CHAT_console", "DM_console"]) {
    try {
      await jsm.streams.purge(s);
    } catch {
      /* stream may not exist yet */
    }
  }
}

async function publish(m, i) {
  const payload = { ...m.payload, id: freshId(), ts: Date.now() };
  curStep = i;
  const id = m.payload.from?.id;
  if (id != null) latestText.set(id, textOf(m).slice(0, 60));
  await pulse();
  await js.publish(m.subject, JSON.stringify(payload), { msgID: payload.id });
}

async function runOnce(passIdx) {
  await purgeHistory();
  curStep = -1;
  latestText.clear();
  await pulse();
  for (let i = 0; i < SEQ.length; i++) {
    await publish(SEQ[i], i);
    await sleep(i === SEQ.length - 1 ? 0 : STEP_MS);
  }
  curStep = SEQ.length; // past every span → everyone idle
  await pulse();
  console.log(`  pass ${passIdx} done — holding ${HOLD_MS / 1000}s on the final frame`);
  await sleep(HOLD_MS);
}

// Get the mesh into the "ready" frame NOW, so a console joining during the countdown
// shows an empty feed + the full roster (good first frame to start recording on).
await purgeHistory();
await pulse();

const runSecs = Math.round((SEQ.length * STEP_MS + HOLD_MS) / 1000);
console.log(`Replay ready: ${SEQ.length} messages @ ${STEP_MS}ms  (~${runSecs}s)`);
if (START_DELAY_MS > 0) {
  console.log(`First message in ${START_DELAY_MS / 1000}s:`);
  for (let s = Math.round(START_DELAY_MS / 1000); s > 0; s--) {
    process.stdout.write(`\r  starting in ${s}s   `);
    await sleep(1000);
  }
  process.stdout.write("\n");
}

let pass = 0;
while (LOOPS === 0 || pass < LOOPS) {
  pass++;
  console.log(`▶ pass ${pass}`);
  await runOnce(pass);
}
// Done — don't loop, don't exit: hold the final frame. The heartbeat keeps the roster alive
// so the closing "ALL DONE" + full feed stay on screen until you Ctrl-C.
console.log("finished — holding the final frame (Ctrl-C to exit)");
await new Promise(() => {});

/**
 * harness/replay.ts <transcript> [space] [targetSec] — re-enact a recorded run on a LIVE mesh.
 *
 * Spins up one real endpoint per agent in the transcript (so they show in the roster), then
 * replays every presence change + message (multicast / peer DM / anycast) in order, looping.
 * Point `cotal console-ink --space <space>` at it to watch the swarm coordinate — no agents,
 * no cost, fully repeatable. The demo's "play button".
 *
 * Pacing is length-aware: a fixed time budget (targetSec, default 120s) is spread across the
 * messages by text length, so long posts (the reviewer's findings, the contract negotiation)
 * linger and short acks go quick — one loop runs ~targetSec, not rushed.
 *
 *   pnpm cotal up --open
 *   pnpm tsx examples/02-self-improving-console/harness/replay.ts <transcript.jsonl> demo-replay 120
 *   pnpm cotal console --space demo-replay   # in a real terminal
 */
import { readFileSync } from "node:fs";
import { CotalEndpoint, DEFAULT_SERVER } from "@cotal-ai/core";

const transcript = process.argv[2];
const space = process.argv[3] ?? "demo-replay";
const targetSec = Number(process.argv[4] ?? "120"); // total seconds per replay loop
if (!transcript) {
  console.error("usage: replay.ts <transcript> [space] [targetSec]");
  process.exit(1);
}
const server = process.env.COTAL_SERVERS?.trim() || DEFAULT_SERVER;

type Rec = {
  type: string; ev?: string; mode?: string;
  name?: string; role?: string; status?: string; activity?: string;
  from?: string; fromId?: string; fromRole?: string; to?: string;
  channel?: string; toService?: string; text?: string;
};
const recs: Rec[] = readFileSync(transcript, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Infra endpoints aren't agents — don't give them a roster row.
const INFRA = new Set(["manager", "cli", "harness-observer", "console"]);

// Collect agents + their roles from presence and message records.
const roleOf = new Map<string, string>();
for (const r of recs) {
  const n = r.name ?? r.from;
  if (n && !INFRA.has(n)) roleOf.set(n, r.role ?? r.fromRole ?? roleOf.get(n) ?? n);
}

// One live endpoint per agent (registers presence → shows in the roster).
const eps = new Map<string, CotalEndpoint>();
for (const [name, role] of roleOf) {
  const ep = new CotalEndpoint({
    space, servers: server,
    card: { name, role, kind: "agent" },
    // consume:true so each agent's inbox JetStream stream exists — otherwise replayed
    // peer DMs (unicast) have no responder and fail.
    channels: ["team"], consume: true, registerPresence: true, watchPresence: false,
  });
  await ep.start();
  eps.set(name, ep);
}
console.log(`replay: ${eps.size} agents live in space "${space}" — ${[...eps.keys()].join(", ")}`);

// Map the recording's instance ids → the names we just spun up, so peer DMs resolve.
const idToName: Record<string, string> = {};
for (const r of recs) if (r.fromId && r.from) idToName[r.fromId] = r.from;
const newIdOf = (name?: string) => (name ? eps.get(name)?.card.id : undefined);

// Length-aware pacing: spread a fixed time budget across the messages by text length, so long
// posts linger and short acks go quick. Every message gets at least MIN_MS; the rest of the
// budget is shared in proportion to length so one loop lands around targetSec.
const GAP_MS = 3000; // pause between loops
const MIN_MS = 1500; // floor so even a short "standing by" is readable
const paced = recs.filter((r) => r.type === "message" && r.text && r.from && eps.has(r.from));
const totalLen = paced.reduce((a, r) => a + Math.max(1, (r.text ?? "").length), 0) || 1;
const budget = Math.max(paced.length * MIN_MS, targetSec * 1000 - GAP_MS);
const extra = budget - paced.length * MIN_MS;
const delayOf = new Map<Rec, number>();
for (const r of paced) delayOf.set(r, MIN_MS + (extra * Math.max(1, (r.text ?? "").length)) / totalLen);

async function once() {
  for (const r of recs) {
    if (r.type === "presence" && (r.ev === "update" || r.ev === "join") && r.name && eps.has(r.name)) {
      await eps.get(r.name)!.setStatus((r.status as never) ?? "working");
      continue;
    }
    if (r.type !== "message" || !r.text) continue;
    const ep = r.from ? eps.get(r.from) : undefined;
    if (!ep) continue;
    try {
      if (r.mode === "chat") await ep.multicast(r.text, { channel: r.channel ?? "team" });
      else if (r.mode === "unicast") {
        const tid = newIdOf(idToName[r.to ?? ""]);
        if (tid) await ep.unicast(tid, r.text);
      } else if (r.mode === "anycast") await ep.anycast(r.toService ?? "team", r.text);
    } catch (e) {
      console.error(`  (skipped ${r.mode} from ${r.from}: ${(e as Error).message})`);
    }
    await sleep(delayOf.get(r) ?? MIN_MS);
  }
}

console.log(
  `replay: ${paced.length} messages paced over ~${Math.round((budget + GAP_MS) / 1000)}s/loop — Ctrl-C to stop. Open the console:`,
);
console.log(`  cotal console-ink --space ${space}`);
for (;;) {
  await once();
  await sleep(GAP_MS);
}

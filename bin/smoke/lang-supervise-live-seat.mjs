// Real agent child for lang-supervise-live: joins presence under the manager-assigned
// id, polls turn-pending on the self reach, and optionally yields the first pulled turn.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const e = process.env;
const { CotalEndpoint } = await import(pathToFileURL(e.CORE_DIST).href);

const logPath = e.COTAL_TURN_LOG;
const autoYield = e.COTAL_AUTO_YIELD === "1";
const note = (action, goalId) => {
  if (!logPath) return;
  appendFileSync(logPath, `${process.pid}\t${action}\t${goalId}\n`);
};

const ep = new CotalEndpoint({
  space: e.COTAL_SPACE,
  servers: e.COTAL_SERVERS,
  lifecycleUid: e.COTAL_LIFECYCLE_UID || undefined,
  channels: [],
  consume: false,
  registerPresence: true,
  watchPresence: false,
  card: { id: e.COTAL_ID || undefined, name: e.COTAL_NAME, kind: "agent" },
});
ep.on("error", () => {});
await ep.start();

let yielded = false;
const tick = async () => {
  const r = await ep.invokeService("manager", "turn-pending", undefined, {
    target: { mode: "self" },
    deadlineMs: 8_000,
  });
  if (!r.reply?.ok) return;
  const turns = r.reply.data?.turns ?? [];
  for (const t of turns) {
    if (typeof t?.goalId !== "string") continue;
    note("PULLED", t.goalId);
    if (!autoYield || yielded) continue;
    yielded = true;
    await ep.invokeService("manager", "turn-yield", {
      goalId: t.goalId,
      status: "done",
      note: "after restart",
    }, { target: { mode: "self" }, deadlineMs: 20_000 });
    note("YIELDED", t.goalId);
  }
};

setInterval(() => { void tick().catch(() => {}); }, 400);
setInterval(() => {}, 1 << 30);

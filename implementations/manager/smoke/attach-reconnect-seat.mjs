// The seat for the attach-reconnect probe and gate. A real mesh agent (so the manager's readiness
// fence resolves on a genuine presence join, exactly as with e2e-stub.mjs), plus two terminal
// behaviours the suite needs from a PTY child:
//
//   - TICK-<n> on a tick interval (SEAT_TICK_MS, default 400): continuous serving-side output, so
//     the session rail carries real traffic and a link death is observable rather than theoretical.
//     The gate drives this fast (50ms) on purpose: the manager's stall watchdog only ARMS once the
//     64-frame send window is full, so the tick rate is what decides whether a given outage is
//     shorter or longer than the serving side's own death, and a slow tick would put the long-outage
//     cell a minute downstream of its own fault. SEAT_SILENT=1 emits nothing at all, which is the
//     case the human actually walks away from: an idle agent whose window never fills.
//   - each input LINE echoed back wrapped as ECHO[<line>]. The wrapper is what makes the
//     assertion honest: a bare echo is indistinguishable from the local terminal echoing the
//     keystroke, whereas ECHO[...] can only have been produced by this process. A nonce written
//     after the link heals and returned inside the wrapper therefore proves seat output produced
//     AFTER the heal reached the client, and cannot be explained by the backlog snapshot the
//     manager replays on every open.
import { readFileSync } from "node:fs";
import { CotalEndpoint } from "@cotal-ai/core";

const e = process.env;
const ep = new CotalEndpoint({
  space: e.COTAL_SPACE,
  servers: e.COTAL_SERVERS,
  creds: readFileSync(e.COTAL_CREDS, "utf8"),
  card: { id: e.COTAL_ID, name: e.COTAL_NAME, role: "worker", kind: "agent" },
  lifecycleUid: e.COTAL_LIFECYCLE_UID,
  channels: [],
  consume: false,
  registerPresence: true,
});
ep.on("error", (err) => console.error("SEAT_ERR", err?.message ?? err));
await ep.start();
process.stdout.write(`SEAT_JOINED ${e.COTAL_NAME}\r\n`);

let n = 0;
const ticker = process.env.SEAT_SILENT === "1"
  ? setInterval(() => {}, 1 << 30) // silent seat: joined, alive, emitting nothing
  : setInterval(() => { process.stdout.write(`TICK-${++n}\r\n`); }, Number(process.env.SEAT_TICK_MS ?? 400));

// Line-buffered so a keystroke burst split across reads still comes back as one wrapped line.
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  pending += String(d);
  for (;;) {
    const i = pending.search(/[\r\n]/);
    if (i === -1) break;
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    if (line) process.stdout.write(`ECHO[${line}]\r\n`);
  }
});

const bye = () => { clearInterval(ticker); ep.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);

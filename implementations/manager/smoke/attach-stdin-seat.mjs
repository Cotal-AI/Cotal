// The seat for the stdin-ownership gate and its probe (#585). A real mesh agent, as the other stubs are, plus
// the three witnesses this probe needs and the reconnect seat does not have:
//
//   - COTAL_PID_SINK: its own pid, written at boot. The issue's Ctrl-C evidence stopped at the
//     manager's live-session count, which is "consistent with the seat taking the signal" and not
//     the same claim; a pid the probe can signal-0 settles it.
//   - COTAL_INPUT_SINK: every byte read on stdin, appended raw, no decoding and no line buffering.
//     Bytes are the question here: a 0x03 or a 0x1d that arrives is invisible to a line echo.
//   - ECHO[<line>] on stdout, the same wrapper the reconnect seat uses, so the client transcript is
//     a second witness that cannot be confused with local terminal echo.
//
// SIGINT is RECORDED rather than merely obeyed: it appends `\n<SIGINT>\n` to the sink before
// exiting, so "the seat took a signal" is a fact in the file rather than an inference from a
// process that is no longer there.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { CotalEndpoint } from "@cotal-ai/core";

const e = process.env;
for (const k of ["COTAL_INPUT_SINK", "COTAL_PID_SINK"])
  if (!e[k]) throw new Error(`${k} is required: without it this stub silently proves nothing`);
writeFileSync(e.COTAL_PID_SINK, String(process.pid));

// A starved seat, for the probe that asks whether a negative assertion behind a fixed sleep can be
// beaten by a delivery that is merely SLOW. Unset in every suite, so the gate's timing is unchanged;
// set only by `pnpm probe:late-delivery`. It holds the WHOLE handler, sink write and echo together,
// because a seat whose process is descheduled does not do half of its work on time.
const SINK_DELAY_MS = Number(e.COTAL_SEAT_SINK_DELAY_MS ?? 0);
let pending = "";
const onData = (d) => {
  appendFileSync(e.COTAL_INPUT_SINK, d); // raw first: the wrapper below cannot represent a control byte
  pending += d.toString("utf8");
  for (;;) {
    const i = pending.search(/[\r\n]/);
    if (i === -1) break;
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    if (line) process.stdout.write(`ECHO[${line}]\r\n`);
  }
};
// setTimeout preserves order for equal delays, so a slow seat stays a FIFO seat.
process.stdin.on("data", (d) => { if (SINK_DELAY_MS > 0) setTimeout(() => onData(d), SINK_DELAY_MS); else onData(d); });
process.stdin.resume();

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

const keep = setInterval(() => {}, 1 << 30); // silent: joined, alive, emitting nothing on its own
const bye = (why) => {
  if (why) appendFileSync(e.COTAL_INPUT_SINK, `\n<${why}>\n`);
  clearInterval(keep);
  ep.stop().finally(() => process.exit(0));
};
process.on("SIGTERM", () => bye("SIGTERM"));
process.on("SIGINT", () => bye("SIGINT"));

// The seat for the attach-reconnect repro/suite. A real mesh agent (so the manager's readiness
// fence resolves on a genuine presence join, exactly as with e2e-stub.mjs), plus two terminal
// behaviours the repro needs from a PTY child:
//
//   - TICK-<n> every 400ms: continuous serving-side output. The manager's session rail only arms
//     its stall watchdog while the send window is FULL with no ack advance, so a silent seat would
//     never reach the fault this suite is about. Ticks are what make the link death observable.
//   - stdin echoed straight back to stdout: lets the suite inject a NONCE through the attach
//     client's keyboard AFTER the link heals and see it come back. A nonce minted at heal time
//     cannot be in the pty's pre-heal backlog, so its arrival cannot be explained by the
//     reconstruction snapshot the manager replays on every open.
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
const ticker = setInterval(() => {
  process.stdout.write(`TICK-${++n}\r\n`);
}, 400);

// Echo. The pty delivers keystrokes on stdin; write them straight back so the caller sees them as
// seat output. `\r\n` normalisation keeps the transcript readable when the caller sends a bare CR.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  process.stdout.write(String(d).replace(/\r(?!\n)/g, "\r\n"));
});

const bye = () => { clearInterval(ticker); ep.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);

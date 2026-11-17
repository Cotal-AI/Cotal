// The seat for attach-end-reason.smoke.ts. A real mesh agent, so the manager's readiness fence
// resolves on a genuine presence join, that exits on its own when it reads the input line
// SEAT_EXIT. It prints SEAT_BYE first, so the gate can also see that its last output reaches the
// attached caller.
import { readFileSync } from "node:fs";
import { CotalEndpoint } from "@cotal-ai/core";

const e = process.env;
const ep = new CotalEndpoint({
  space: e.COTAL_SPACE,
  servers: e.COTAL_SERVERS,
  ...(e.COTAL_CREDS ? { creds: readFileSync(e.COTAL_CREDS, "utf8") } : {}),
  card: { id: e.COTAL_ID, name: e.COTAL_NAME, role: "worker", kind: "agent", meta: { "ai.cotal.manager.instance": e.COTAL_MANAGER_INSTANCE } },
  lifecycleUid: e.COTAL_LIFECYCLE_UID,
  channels: [],
  consume: false,
  registerPresence: true,
});
ep.on("error", (err) => console.error("SEAT_ERR", err?.message ?? err));
await ep.start();
process.stdout.write(`SEAT_JOINED ${e.COTAL_NAME}\r\n`);

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  pending += String(d);
  for (;;) {
    const i = pending.search(/[\r\n]/);
    if (i === -1) break;
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    if (line === "SEAT_EXIT") {
      process.stdout.write("SEAT_BYE\r\n");
      process.exit(0);
    }
  }
});

const bye = () => { ep.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);

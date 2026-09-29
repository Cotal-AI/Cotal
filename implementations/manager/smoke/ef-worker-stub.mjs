import { readFileSync } from "node:fs";
import { CotalEndpoint } from "@cotal-ai/core";

const e = process.env;
const creds = readFileSync(e.COTAL_CREDS, "utf8");
const ep = new CotalEndpoint({
  space: e.COTAL_SPACE,
  servers: e.COTAL_SERVERS,
  creds,
  card: {
    owner: e.COTAL_OWNER,
    actor: e.COTAL_NAME,
    name: e.COTAL_NAME,
    role: "worker",
    kind: "agent",
  },
  lifecycleUid: e.COTAL_LIFECYCLE_UID,
  channels: [],
  consume: false,
  registerPresence: true,
});
await ep.start();
const t = setInterval(() => {}, 1000);
process.on("SIGTERM", () => { clearInterval(t); ep.stop().then(() => process.exit(0)); });

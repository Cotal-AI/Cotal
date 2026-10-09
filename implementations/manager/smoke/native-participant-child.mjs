// A scripted native participant harness, not a model/provider. It authenticates exactly as a
// connector's user-mode child and records actual PTY bytes for the selected session witness.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { CotalEndpoint } from "@cotal-ai/core";
const e = process.env;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (bytes) => { appendFileSync(e.COTAL_NATIVE_SINK, bytes); process.stdout.write(bytes); });
process.stdin.resume();
const cmd = JSON.parse(e.COTAL_BEARER_CMD);
const ep = new CotalEndpoint({ space: e.COTAL_SPACE, servers: e.COTAL_SERVERS,
  bearer: () => execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", env: process.env }).trim(),
  sentinelCreds: readFileSync(e.COTAL_SENTINEL_CREDS, "utf8"), lifecycleUid: e.COTAL_LIFECYCLE_UID,
  card: { name: e.COTAL_NAME, role: "worker", kind: "agent", owner: e.COTAL_OWNER, actor: e.COTAL_ACTOR },
  channels: [], consume: false, registerPresence: true });
ep.on("error", (error) => console.error("NATIVE_CHILD_ERROR", error.message));
await ep.start();
writeFileSync(e.COTAL_NATIVE_READY, "ready");
const keep = setInterval(() => {}, 1 << 30);
const end = () => { clearInterval(keep); ep.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", end); process.on("SIGINT", end);

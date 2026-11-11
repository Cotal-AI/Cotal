// A fake `pi --mode rpc` for list-models.smoke.ts. It journals to FAKE_PI_LOG its pid and argv,
// whether a seat identity or a provider key reached it, each command it reads and any SIGTERM, then
// acts by FAKE_PI_MODE: reply → answer each command with the response in FAKE_PI_REPLY under that
// command's id; silent → never answer; garbage → write a line that is not JSON; exit → exit 3 before
// reading anything. FAKE_PI_STUBBORN=1 ignores SIGTERM and stdin EOF, so only SIGKILL ends it.
import { appendFileSync, readFileSync } from "node:fs";

const log = (entry) => appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(entry) + "\n");
log({
  pid: process.pid,
  argv: process.argv.slice(2),
  seatIdentity: "COTAL_SPACE" in process.env || "COTAL_NAME" in process.env,
  providerKey: "ANTHROPIC_API_KEY" in process.env,
});
const mode = process.env.FAKE_PI_MODE;
if (mode === "exit") process.exit(3);
if (process.env.FAKE_PI_STUBBORN === "1") {
  process.on("SIGTERM", () => log({ sigterm: true }));
  setInterval(() => {}, 1_000);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const command = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    log({ command });
    if (mode === "reply") process.stdout.write(JSON.stringify({ ...JSON.parse(readFileSync(process.env.FAKE_PI_REPLY, "utf8")), id: command.id }) + "\n");
    else if (mode === "garbage") process.stdout.write("pi: not a protocol record\n");
  }
});

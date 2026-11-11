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

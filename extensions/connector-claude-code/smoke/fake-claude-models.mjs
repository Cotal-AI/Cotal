import { appendFileSync, readFileSync } from "node:fs";

const log = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
const reply = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_REPLY, "utf8"));
log({ pid: process.pid, argv: process.argv.slice(2), env: Object.keys(process.env) });
if (reply === "exit") process.exit(3);

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const request = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    log({ request });
    if (reply !== "silent") process.stdout.write(JSON.stringify({ ...reply, response: { ...reply.response, request_id: request.request_id } }) + "\n");
  }
});

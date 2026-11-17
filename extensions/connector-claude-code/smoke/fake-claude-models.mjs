import { appendFileSync, readFileSync, readdirSync } from "node:fs";

const log = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
const reply = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_REPLY, "utf8"));
log({ pid: process.pid, argv: process.argv.slice(2), env: Object.keys(process.env), cwd: process.cwd(), cwdEntries: readdirSync(".") });
if (reply === "exit") process.exit(3);
process.on("exit", (code) => log({ exited: code }));
// A busy claude that keeps running after its input closes. It still ends within 30s if the suite dies.
if (process.env.FAKE_CLAUDE_STUBBORN === "1") setTimeout(() => {}, 30_000);

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const request = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    log({ request });
    const answer = JSON.stringify({ ...reply, response: { ...reply.response, request_id: request.request_id } }) + "\n";
    if (reply !== "silent") setTimeout(() => process.stdout.write(answer), Number(process.env.FAKE_CLAUDE_ANSWER_DELAY_MS ?? 0));
  }
});
// The real claude ends on its own once its input closes, and so does this one unless it is stubborn.
process.stdin.on("end", () => log({ stdinClosed: true }));

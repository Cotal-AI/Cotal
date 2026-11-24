// A stand-in for an OpenCode 1.x binary, as measured on 1.19.6: `serve` prints the URL it listens on
// and answers `GET /command` with commands and skills in one list behind the server's password.
// Env: FAKE_OC1_LOG, a file each `serve` appends one JSON line to; FAKE_OC1_REPLY, the file whose
// contents `GET /command` answers.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.19.6\n");
} else if (args[0] === "serve") {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const expected = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${password}`).toString("base64")}`;
  // A child of the server stands for any process OpenCode starts, which a stop must take down too.
  const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
  appendFileSync(process.env.FAKE_OC1_LOG, JSON.stringify({
    argv: args, cwd: process.cwd(), db: process.env.OPENCODE_DB ?? null, password: Boolean(password), pids: [process.pid, grandchild.pid],
  }) + "\n");
  const server = createServer((req, res) => {
    if (!password || req.headers.authorization !== expected) return void res.writeHead(401).end("Unauthorized");
    if (new URL(req.url, "http://localhost").pathname !== "/command") return void res.writeHead(404).end("Not Found");
    res.writeHead(200, { "content-type": "application/json" }).end(readFileSync(process.env.FAKE_OC1_REPLY, "utf8"));
  });
  const host = args[args.indexOf("--hostname") + 1];
  server.listen(Number(args[args.indexOf("--port") + 1]), host, () => {
    process.stdout.write(`opencode server listening on http://${host}:${server.address().port}\n`);
  });
} else {
  process.stderr.write(`fake opencode 1.x: unexpected arguments: ${args.join(" ")}\n`);
  process.exit(2);
}

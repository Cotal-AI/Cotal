// A stand-in for an OpenCode 2.x binary's private servers, as measured on 2.0.24 and 2.4.1: a
// location starts loading on its first request, its model list stays empty and then partial until
// its plugin list fills, and `api --standalone` answers its one request before that.
// Usage: node fake-opencode2-serve.mjs <config.json> <opencode arguments...>
// config: { settleMs: number | null (null never settles), modelBody: string, modelStatus?: number,
//           pidFile: string } — `serve` writes its own pid and a grandchild's pid to pidFile.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const [configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const empty = JSON.stringify({ location: { directory: "/work" }, data: [] });
const partial = JSON.stringify({ location: { directory: "/work" }, data: [{ id: "early", modelID: "early", providerID: "opencode", variants: [] }] });
let firstRequest;

function answer(path) {
  const first = firstRequest === undefined;
  firstRequest ??= Date.now();
  const age = Date.now() - firstRequest;
  // The first request only starts the load, so it is never answered from a settled location.
  const settled = !first && config.settleMs !== null && age >= config.settleMs;
  if (path === "/api/plugin") return [200, settled ? JSON.stringify({ location: { directory: "/work" }, data: [{ id: "opencode.agent", state: { status: "active" } }] }) : empty];
  if (path === "/api/model") {
    if (!settled) return [200, first ? empty : partial];
    return [config.modelStatus ?? 200, config.modelBody];
  }
  return [404, JSON.stringify({ _tag: "NotFound" })];
}

if (args[0] === "api" && args[1] === "--standalone" && args[2] === "GET") {
  process.stdout.write(`${answer(args[3])[1]}\n`);
} else if (args[0] === "serve" && args.includes("--stdio")) {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  // A child of the server stands for any process OpenCode starts, which a stop must take down too.
  const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(config.pidFile, `${process.pid} ${grandchild.pid}`);
  const server = createServer((req, res) => {
    if (!password || req.headers.authorization !== expected) {
      res.writeHead(401).end(JSON.stringify({ _tag: "UnauthorizedError" }));
      return;
    }
    const [status, body] = answer(new URL(req.url, "http://localhost").pathname);
    res.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  const host = args[args.indexOf("--hostname") + 1];
  server.listen(Number(args[args.indexOf("--port") + 1]), host, () => {
    process.stdout.write(`${JSON.stringify({ url: `http://${host}:${server.address().port}` })}\n`);
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} else {
  process.stderr.write(`fake opencode: unexpected arguments: ${args.join(" ")}\n`);
  process.exit(2);
}

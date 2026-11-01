// Test fixture: the BUILT gateway HTTP entry on a loopback port, in its own process so the client's fetch cannot
// confound what this process loads. GET /__undici answers how many undici modules this process has loaded.
import { createRequire } from "node:module";
// ESM loading of node:http itself makes Node load one undici module; require() does not, so the listener comes from require() to keep the count about the gateway.
const { createServer } = createRequire(import.meta.url)("node:http");
import { handleGatewayRequest } from "../dist/gateway.js";

const undici = () => process.moduleLoadList.filter((name) => /undici/.test(name)).length;
const host = { account: () => "acct", open: async () => { throw new Error("unused"); }, find: async () => undefined, close: async () => false };
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined));
  req.on("error", reject);
});
const server = createServer(async (req, res) => {
  if (req.url === "/__undici") return void res.end(String(undici()));
  await handleGatewayRequest(host, { req, res, body: req.method === "POST" ? await readBody(req) : undefined, auth: { token: "t", clientId: "smoke", scopes: [], extra: { account: "acct" } } });
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port, undiciAtReady: undici() })));

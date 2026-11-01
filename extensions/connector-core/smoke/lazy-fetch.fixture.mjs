// Test fixture: real product fetch-on-use. The built feedback sender posts to a private loopback server; the
// process reports how many undici modules it had loaded before and after that one call.
import { createRequire } from "node:module";
// Listener from require(): ESM loading of node:http would itself count one undici module.
const { createServer } = createRequire(import.meta.url)("node:http");
import { submitFeedback } from "../dist/feedback.js";

const undici = () => process.moduleLoadList.filter((name) => /undici/.test(name)).length;
const server = createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "fixture-1" }))); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const before = undici();
const result = await submitFeedback({ origin: "agent", type: "other", summary: "fixture", source: "smoke" }, { url: `http://127.0.0.1:${server.address().port}/`, email: "smoke@example.invalid" });
const after = undici();
server.close();
console.log(JSON.stringify({ before, after, text: result.text, isError: Boolean(result.isError) }));

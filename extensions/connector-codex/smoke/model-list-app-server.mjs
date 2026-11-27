// Stand-in for `codex app-server` over stdio, answering `model/list` with the reply codex-cli 0.172.0
// was measured to give (fixtures/model-list-0.172.json). FAKE_CODEX_NO_TIERS names one model whose
// row is sent without `serviceTiers`, as a model that offers no fast tier would be.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const result = JSON.parse(readFileSync(new URL("./fixtures/model-list-0.172.json", import.meta.url), "utf8"));
const bare = process.env.FAKE_CODEX_NO_TIERS;
for (const row of result.data) if (row.id === bare) delete row.serviceTiers;

const reply = (id, payload) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") reply(msg.id, { result: { userAgent: "fake-model-list" } });
  else if (msg.method === "model/list") reply(msg.id, { result });
  else if (msg.id !== undefined) reply(msg.id, { error: { code: -32601, message: `unexpected ${msg.method}` } });
});

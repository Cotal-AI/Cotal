// Drive core's OWN CotalEndpoint (built dist, with dialerFor) over wss://hack.cotal.ai/mesh-ws.
// The endpoint's start() resolving is its claim; the platform membership read afterwards is the
// independent evidence. Bearer minted through the public exchange with the AGENT arm.
import { readFileSync } from "node:fs";
const b = JSON.parse(readFileSync(new URL("./prod/bundle.json", import.meta.url), "utf8"));
const core = await import("../packages/core/dist/index.js");

const mint = async () => {
  const res = await fetch(b.authServiceUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: b.owner, actor: b.actor, actorToken: b.actorToken }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`exchange ${res.status}: ${await res.text()}`);
  const out = await res.json();
  return out.token;
};

const bearer0 = await mint();
console.log(`bearer minted: ${bearer0.length} bytes`);

const ep = new core.CotalEndpoint({
  space: b.space,
  card: { name: b.actor, owner: b.owner, actor: b.actor, kind: "agent" },
  lifecycleUid: b.lifecycleUid,
  servers: "wss://hack.cotal.ai/mesh-ws",
  sentinelCreds: b.sentinelCreds,
  bearer: mint,
  subscribe: b.subscribe,
});
try {
  await ep.start();
  console.log("CONNECTED_OK over wss", `${b.owner}.${b.actor}`);
  await new Promise((r) => setTimeout(r, 35000));
} catch (e) {
  console.log("JOIN_FAILED", String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
} finally {
  try { await (ep.drain?.() ?? ep.stop?.()); } catch {}
  console.log("STOPPED_OK");
}

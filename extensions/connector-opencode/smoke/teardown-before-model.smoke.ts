/**
 * OPENCODE 2.x: A TEARDOWN THAT LANDS BEFORE THE MODEL CHECK SETTLES LEAVES NOTHING BEHIND.
 *
 * `setupCotal` queues the agent start behind the model check (`modelReady`), and the check polls
 * `GET /api/model` while the listing is empty. A host that tears the plugin down inside that window
 * must not then see the queued start run on a stopped agent (`cannot start a stopped mesh session`,
 * an unhandled rejection) or a late model refusal call `process.exit(1)`: the teardown owns what
 * setup queued.
 *
 * No broker is needed: COTAL_SERVERS points at a closed port and the agent is never started.
 *
 *   A. model pinned, late refusal (short settle window) after teardown -> no rejection, no exit
 *   B. model pinned, the model is listed after the teardown            -> no start on a stopped agent
 *   C. no model pin, teardown with the start in flight              -> still clean (control)
 *
 * Run: pnpm smoke:opencode-teardown-before-model
 */
import { createServer } from "node:http";
import { once } from "node:events";
import { setupCotal } from "../src/plugin2.js";
import { fakeOpenCode2Context } from "./_boot-plugin.js";
import { pickFreePort } from "./_free-port.js";

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let listAt = Infinity; // wall-clock time from which the fake server lists prov/m
const oc = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/model") {
    const data = Date.now() >= listAt ? [{ providerID: "prov", modelID: "m" }] : [];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    return;
  }
  res.writeHead(404).end();
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocPort = (oc.address() as { port: number }).port;
const deadPort = await pickFreePort(); // nothing listens: the mesh start can only fail or hang, never join

const rejections: string[] = [];
process.on("unhandledRejection", (reason) => rejections.push((reason as Error)?.message ?? String(reason)));
const exits: Array<string | number | undefined> = [];
const realExit = process.exit;
process.exit = ((code?: string | number) => {
  exits.push(code);
  return undefined as never;
}) as typeof process.exit;

async function arm(name: string, env: Record<string, string>): Promise<void> {
  for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
  Object.assign(process.env, {
    COTAL_SPACE: "teardownmodel",
    COTAL_NAME: name,
    COTAL_ID: name.toLowerCase(),
    COTAL_SERVERS: `nats://127.0.0.1:${deadPort}`,
    COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${ocPort}`,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: "test-secret",
    ...env,
  });
  delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;
  listAt = env.LIST_AFTER_MS ? Date.now() + Number(env.LIST_AFTER_MS) : Infinity;
  delete process.env.LIST_AFTER_MS;
  rejections.length = 0;
  exits.length = 0;
  const ctx = fakeOpenCode2Context();
  const teardown = await setupCotal(ctx);
  await sleep(300);
  ctx.end();
  await (teardown as () => Promise<void>)();
  await sleep(2500); // past the point where the queued continuation would have fired
}

try {
  console.log("A. model pinned, late refusal after the teardown");
  await arm("TdA", { COTAL_MODEL: "prov/m", COTAL_MODEL_LIST_SETTLE_MS: "1200" });
  // the 1.2 s settle window elapses after the teardown at ~0.3 s
  check("no process.exit after the teardown", exits.length === 0, exits);
  check("no unhandled rejection after the teardown", rejections.length === 0, rejections);

  console.log("B. model pinned, listed after the teardown");
  await arm("TdB", { COTAL_MODEL: "prov/m", LIST_AFTER_MS: "1000" });
  check("no process.exit after the teardown", exits.length === 0, exits);
  check("no unhandled rejection after the teardown", rejections.length === 0, rejections);

  console.log("C. no model pin (control)");
  await arm("TdC", {});
  check("no process.exit", exits.length === 0, exits);
  check("no unhandled rejection", rejections.length === 0, rejections);
} finally {
  process.exit = realExit;
  oc.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
realExit(fail ? 1 : 0);

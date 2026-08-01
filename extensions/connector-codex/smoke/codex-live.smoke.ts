/**
 * Live E2E for the Codex connector — drives the REAL `codex` binary end to end. Spins up its
 * own nats-server + a real mesh, launches the host peer (tsx host-main.ts) as a child, then DMs
 * it and asserts the model replies BACK OVER THE MESH via its cotal_dm dynamic tool — proving
 * wake (turn/start), the dynamic-tool surface, presence, and ack in one pass against the
 * installed binary. Needs an AUTHENTICATED codex, so it is gated behind `COTAL_E2E_CODEX=1`
 * (without the flag it skips and stays green in CI).
 *
 * Run: COTAL_E2E_CODEX=1 pnpm smoke:codex-live
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";

if (!/^(1|true|yes|on)$/i.test(process.env.COTAL_E2E_CODEX ?? "")) {
  console.log("SKIP codex live E2E — set COTAL_E2E_CODEX=1 (needs an authenticated `codex` CLI) to run it");
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "codexe2e";
const PEER = "codexpeer";
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const HOST_ENTRY = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "cotal-codexe2e-"));
const nats = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });

const operator = new CotalEndpoint({
  space,
  servers,
  card: { name: "operator", kind: "agent", id: "operator" },
  channels: ["team"],
});
operator.on("error", () => {});

let reply = "";
operator.on("message", (msg: { parts?: { kind: string; text?: string }[] }, _d: unknown, meta: { kind: string; historical: boolean }) => {
  if (meta.historical || meta.kind !== "dm") return;
  reply += (msg.parts ?? []).filter((p) => p.kind === "text").map((p) => p.text ?? "").join("");
});
let online = false;
let sawWorking = false;
operator.on("presence", (e: { type: string; presence: { card: { id: string; name: string }; status?: string } }) => {
  const c = e.presence.card;
  if (c.id !== PEER && c.name !== PEER) return;
  if (e.type !== "offline") online = true;
  if (e.presence.status === "working") sawWorking = true;
});

/** DM the peer by its ROSTER id (principal dot-form) — names are not unicast recipients. */
async function dm(text: string): Promise<void> {
  const id = operator.getRoster().find((p) => p.card.name === PEER)?.card.id;
  if (!id) throw new Error(`peer ${PEER} not in the operator's roster yet`);
  await operator.unicast(id, text);
}

let host: ReturnType<typeof spawn> | undefined;
try {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) break;
    await sleep(200);
  }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await operator.start();

  // Scrub any ambient COTAL_* (e.g. the invoking agent session's own mesh identity) so the
  // host child sees ONLY the identity this smoke assigns.
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];
  host = spawn(TSX, [HOST_ENTRY], {
    env: {
      ...cleanEnv,
      COTAL_SPACE: space,
      COTAL_NAME: PEER,
      COTAL_ID: PEER,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ROLE: "coder",
      COTAL_CODEX_HOME: dir,
      // Keep the live run cheap and safe: read-only sandbox, light reasoning.
      COTAL_CODEX_CONFIG: JSON.stringify({ sandbox_mode: '"read-only"', model_reasoning_effort: '"low"' }),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  // The host reports idle only after the app-server thread is up (~model auth included).
  for (let i = 0; i < 600 && !online; i++) await sleep(100);
  check("codex host peer comes online", online);

  await dm("Use your cotal_dm tool to send exactly the single word PONG to the peer named operator. Do not run any commands; do not reply in text; just make that one tool call.",
  );

  for (let i = 0; i < 1800 && !/PONG/i.test(reply); i++) await sleep(100);
  check("model replies over the mesh via cotal_dm", /PONG/i.test(reply), reply.trim());
  check("presence reported working during the turn", sawWorking);

  console.log(`\nCODEX LIVE E2E PASSED ✅  (${pass} checks)  reply=${JSON.stringify(reply.trim())}`);
} finally {
  // Give the cooperative shutdown its clean mesh leave against a LIVE broker before tearing the
  // broker down — otherwise this teardown races the very path it should exercise, and the host
  // only ever exits via its bounded grace.
  if (host) {
    host.kill("SIGTERM");
    await Promise.race([once(host, "exit"), sleep(10_000)]);
  }
  await Promise.race([operator.stop().catch(() => {}), sleep(3_000)]);
  nats.kill("SIGKILL");
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);

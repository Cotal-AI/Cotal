/**
 * Live E2E for the Codex host-mode connector — drives the REAL `codex` binary end to end.
 * Spins up its own nats-server + a real mesh, launches the host peer (tsx host-main.ts) as a
 * child, then DMs it and asserts a model reply routes back over the mesh. Unlike the opencode
 * turn-wedge smoke (fake client), this needs an AUTHENTICATED codex, so it is gated behind
 * `COTAL_E2E_CODEX=1` — without the flag it skips (keeps `pnpm smoke`/CI green).
 *
 *   1. handshake — AppServerDriver.start() against the real binary returns a thread id (no model);
 *   2. full turn — operator DMs the peer "reply PONG"; the codex turn's final message comes back
 *      as a DM. Proves wake (turn/start) + presence + reply routing over a real mesh.
 * Run: COTAL_E2E_CODEX=1 pnpm smoke:codex
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { AppServerDriver } from "../src/app-server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!/^(1|true|yes|on)$/i.test(process.env.COTAL_E2E_CODEX ?? "")) {
  console.log("SKIP codex host E2E — set COTAL_E2E_CODEX=1 (needs an authenticated `codex` CLI) to run it");
  process.exit(0);
}

const PORT = 14271;
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
operator.on("presence", (e: { type: string; presence: { card: { id: string; name: string } } }) => {
  const c = e.presence.card;
  if ((c.id === PEER || c.name === PEER) && e.type !== "offline") online = true;
});

let host: ReturnType<typeof spawn> | undefined;
let handshakeDriver: AppServerDriver | undefined;
try {
  // (1) handshake against the real binary — spawn → initialize → thread/start returns a thread id.
  handshakeDriver = new AppServerDriver({ cwd: dir, log: () => {} });
  const threadId = await handshakeDriver.start();
  check("app-server handshake returns a thread id", typeof threadId === "string" && threadId.length > 0, threadId);
  await handshakeDriver.stop();

  // (2) full turn over a real mesh.
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await operator.start();

  host = spawn(TSX, [HOST_ENTRY], {
    env: {
      ...process.env,
      COTAL_SPACE: space,
      COTAL_NAME: PEER,
      COTAL_ID: PEER,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ROLE: "coder",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  // Wait for the peer to come online (mesh connected AND app-server thread up — the host only
  // reports idle after driver.start()).
  for (let i = 0; i < 600 && !online; i++) await sleep(100); // up to 60s
  check("codex host peer comes online", online);

  await operator.unicast(PEER, "Reply with exactly the single word: PONG. Do not run any tools or commands.");

  // A model turn can take a while; poll up to 120s for the reply DM.
  for (let i = 0; i < 1200 && !/PONG/i.test(reply); i++) await sleep(100);
  check("codex peer replies to the DM with PONG", /PONG/i.test(reply), reply.trim());

  console.log(`\nCODEX HOST E2E PASSED ✅  (${pass} checks)  reply=${JSON.stringify(reply.trim())}`);
} finally {
  host?.kill("SIGTERM");
  await handshakeDriver?.stop().catch(() => {});
  await operator.stop().catch(() => {});
  nats.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);

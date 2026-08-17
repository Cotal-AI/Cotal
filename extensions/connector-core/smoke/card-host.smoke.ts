/**
 * Agent-card `meta.host` test (no test runner) — spins up its OWN nats-server and drives a
 * MeshAgent directly to verify that a session reports WHICH MACHINE it runs on:
 *   - `meta.host` is this machine's `os.hostname()`, and it travels on the wire (a *peer* reads it
 *     off the roster, not the agent's own local object);
 *   - an agent file CANNOT spoof it: a config-supplied `meta.host` is overlaid by the real
 *     hostname, exactly like `meta.connector`;
 *   - the other connector-owned meta keys still survive alongside it.
 * Run: pnpm smoke:card-host
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "hostsmoke";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// The agent file's own `meta` deliberately CLAIMS a false host, to prove the connector overlays it.
const cfg: AgentConfig = {
  space,
  name: "Hosty",
  role: "generalist",
  servers,
  subscribe: ["open-ch"],
  allowSubscribe: ["open-ch"],
  allowPublish: ["open-ch"],
  kind: "agent",
  tls: false,
  id: "hosty_agent",
  connector: "claude",
  model: "opus",
  meta: { host: "definitely-not-this-machine", custom: "kept" },
  lifecycleUid: mintLifecycleUid(),
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});

// A separate endpoint, so every assertion below reads the card as it arrived OVER THE WIRE.
const peer = new CotalEndpoint({
  space,
  servers,
  card: { name: "Peer", kind: "agent", id: "peer" },
  channels: ["open-ch"],
  lifecycleUid: mintLifecycleUid(),
});
peer.on("error", () => {});

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  await peer.start();
  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected", agent.connected === true);

  let seen: Record<string, unknown> | undefined;
  for (let i = 0; i < 50; i++) {
    // Match on the display name: the wire `card.id` is the principal dot-form (`<owner>.<actor>`),
    // not the config's local id.
    seen = peer.getRoster().find((p) => p.card.name === "Hosty")?.card.meta as Record<string, unknown> | undefined;
    if (seen?.host) break;
    await sleep(200);
  }

  check("peer sees the agent's card meta", seen !== undefined, seen);
  check("meta.host is THIS machine's hostname", seen?.host === hostname(), { got: seen?.host, want: hostname() });
  check("an agent file cannot spoof meta.host", seen?.host !== "definitely-not-this-machine", seen?.host);
  check("connector-owned meta survives alongside host", seen?.connector === "claude" && seen?.model === "opus", seen);
  check("agent-file meta the connector does not own is preserved", seen?.custom === "kept", seen);

  console.log(`\n✓ card-host smoke passed (${pass} checks)`);
} finally {
  await agent.stop?.();
  await peer.stop?.();
  srv.kill();
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

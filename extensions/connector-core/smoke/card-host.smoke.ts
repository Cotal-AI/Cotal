/**
 * Agent-card `meta.host` test (no test runner) — spins up its OWN nats-server and drives a
 * MeshAgent directly to verify that a session reports WHICH MACHINE it runs on:
 *   - `meta.host` and `meta.cwd` travel on the wire to a peer's roster (`meta.host` is this machine's `os.hostname()`, and it travels on the wire (a *peer* reads it
 *     off the roster, not the agent's own local object);
 *   - an agent file CANNOT spoof it: a config-supplied `meta.host` is overlaid by the real
 *     hostname, exactly like `meta.connector`;
 *   - the other connector-owned meta keys still survive alongside it;
 *   - `meta["ai.cotal.events"]` says whether the session arms its event plane ("on" with
 *     COTAL_EVENTS in the environment at construction, "off" without), and an agent file declaring
 *     it "on" cannot make an unarmed session read "on".
 * Run: pnpm smoke:card-host
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent, type MeshAgentOptions } from "../src/agent.js";
import { eventPlaneArmed } from "../src/config.js";
import type { AgentConfig } from "../src/config.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
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

// Agent-file metadata supplies false location values; the connector must overlay both.
const startupCwd = process.cwd();
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
  meta: { host: "definitely-not-this-machine", cwd: "definitely-not-this-directory", custom: "kept" },
  lifecycleUid: mintLifecycleUid(),
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});

// The card is built when the MeshAgent is constructed, so COTAL_EVENTS is set (or cleared) around
// the construction only and `process.env` is restored right after it.
function constructWithEvents(config: AgentConfig, events: boolean, captured?: boolean, scrub = false): MeshAgent {
  const had = Object.prototype.hasOwnProperty.call(process.env, "COTAL_EVENTS");
  const before = process.env.COTAL_EVENTS;
  if (events) process.env.COTAL_EVENTS = "1";
  else delete process.env.COTAL_EVENTS;
  try {
    const options: MeshAgentOptions & { eventsArmed?: boolean } = {};
    if (captured !== undefined) options.eventsArmed = captured;
    if (scrub) {
      options.eventsArmed = eventPlaneArmed(config);
      delete process.env.COTAL_EVENTS;
    }
    const a = new MeshAgent(config, { ...process.env, COTAL_WORKSPACE_ROOT: dir }, options);
    a.on("error", () => {});
    return a;
  } finally {
    if (had) process.env.COTAL_EVENTS = before;
    else delete process.env.COTAL_EVENTS;
  }
}

const armedAgent = constructWithEvents({ ...cfg, name: "Armed", id: "armed_agent", meta: undefined }, true);
const unarmedAgent = constructWithEvents({ ...cfg, name: "Unarmed", id: "unarmed_agent", meta: undefined }, false);
// The agent file CLAIMS the plane is armed while the environment says it is not.
const spoofAgent = constructWithEvents(
  { ...cfg, name: "Spoof", id: "spoof_agent", meta: { "ai.cotal.events": "on" } },
  false,
);

const capturedAgent = constructWithEvents(
  { ...cfg, name: "Captured", id: "captured_agent", meta: { "ai.cotal.events": "off" } }, true, undefined, true,
);
const capturedOffAgent = constructWithEvents(
  { ...cfg, name: "CapturedOff", id: "captured_off", meta: { "ai.cotal.events": "on" } }, true, false,
);
const requiredAgent = constructWithEvents(
  { ...cfg, name: "Required", id: "required_agent", eventsRequired: true }, false, false,
);
const extras = [armedAgent, unarmedAgent, spoofAgent, capturedAgent, capturedOffAgent, requiredAgent];

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
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });

  await peer.start();
  agent.start();
  await agent.waitUntilConnected(10_000);
  check("agent connected", agent.connected === true);

  for (const extra of extras) {
    extra.start();
    await extra.waitUntilConnected(10_000);
  }

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
  check("meta.cwd is the connector's startup directory", seen?.cwd === startupCwd, { got: seen?.cwd, want: startupCwd });
  check("an agent file cannot spoof meta.cwd", seen?.cwd !== "definitely-not-this-directory", seen?.cwd);
  check("connector-owned meta survives alongside location", seen?.connector === "claude" && seen?.model === "opus", seen);
  check("agent-file meta the connector does not own is preserved", seen?.custom === "kept", seen);

  const eventsOf = async (name: string): Promise<unknown> => {
    for (let i = 0; i < 50; i++) {
      const meta = peer.getRoster().find((p) => p.card.name === name)?.card.meta as Record<string, unknown> | undefined;
      if (meta?.host) return meta["ai.cotal.events"];
      await sleep(200);
    }
    return undefined;
  };
  check("a session with COTAL_EVENTS reads on over the wire", (await eventsOf("Armed")) === "on");
  check("a session without COTAL_EVENTS reads off over the wire", (await eventsOf("Unarmed")) === "off");
  check(
    "an agent file declaring ai.cotal.events on cannot arm an unarmed session",
    (await eventsOf("Spoof")) === "off",
  );

  const capturedWire = await eventsOf("Captured");
  check("captured-on before scrub stays advertised-on after scrub", capturedWire === "on", { captured: "on", advertised: capturedWire });
  check("captured false overrides ambient on and spoofed metadata", (await eventsOf("CapturedOff")) === "off");
  check("required events override captured false", (await eventsOf("Required")) === "on");

  console.log(`\n✓ card-host smoke passed (${pass} checks)`);
} finally {
  await agent.stop?.();
  for (const extra of extras) await extra.stop();
  await peer.stop?.();
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

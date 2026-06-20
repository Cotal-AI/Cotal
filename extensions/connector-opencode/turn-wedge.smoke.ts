/**
 * OpenCode turn-state regression test (no test runner) — spins up its OWN nats-server and drives the
 * plugin's turn state machine with a FAKE opencode `client` + real opencode bus events. It guards the
 * wedge fixed in plugin.ts: `busy` is set true by `session.status: busy` for ANY turn (incl. a human
 * typing into the attached TUI), but used to be cleared only on a connector-DRIVEN turn's end — so the
 * first human turn left `busy` stuck true and every later channel/DM push was buffered forever.
 *
 * Flow (no model, no `opencode` binary — just the plugin closure + a real mesh):
 *   1. a live channel message drives a turn (promptAsync #1)  — baseline push works;
 *   2. that turn completes (session.idle);
 *   3. a HUMAN turn runs on the same session (session.status busy → session.idle) — the wedge trigger;
 *   4. a second channel message MUST still drive a turn (promptAsync #2) — pre-fix this never fires.
 * Run: pnpm smoke:opencode
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { cotal } from "./src/plugin.js";

const PORT = 14238;
const servers = `nats://127.0.0.1:${PORT}`;
const space = "ocwedge";
const SID = "ses_test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "cotal-ocwedge-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// The plugin reads its identity from COTAL_* env (it runs inside the opencode process).
Object.assign(process.env, {
  COTAL_NAME: "Otto",
  COTAL_SPACE: space,
  COTAL_SERVERS: servers,
  COTAL_CHANNELS: "team",
  COTAL_ROLE: "generalist",
});

// A fake opencode client: hand the plugin a session id and record every turn it drives.
const prompts: { id: string }[] = [];
const fakeClient = {
  session: {
    create: async (_: unknown) => ({ data: { id: SID } }),
    promptAsync: async ({ path }: { path: { id: string } }) => {
      prompts.push({ id: path.id });
      return { data: {} };
    },
  },
};

// Fire one opencode bus event at the plugin's `event` hook.
type Hooks = Awaited<ReturnType<typeof cotal>>;
const fire = (hooks: Hooks, event: unknown) => hooks.event!({ event } as never);

// A plain peer that posts ambient channel traffic at the agent.
const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: ["team"] });
pub.on("error", () => {});

// Poll until the plugin has driven `n` turns (push is event-driven + async).
const waitForPrompts = async (n: number, ms = 5000): Promise<void> => {
  for (let i = 0; i < ms / 100 && prompts.length < n; i++) await sleep(100);
};

let hooks: Hooks | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await pub.start();

  // Boot the plugin (it connects its mesh agent in the background and creates session SID).
  hooks = await cotal({ client: fakeClient } as never);
  await sleep(2000); // let the internal MeshAgent connect + subscribe to #team

  // (1) a live channel message drives a turn — baseline push works.
  await pub.multicast("hello team", { channel: "team" });
  await waitForPrompts(1);
  check("a channel message drives a turn (push works)", prompts.length === 1, prompts);

  // (2) complete the connector's turn (acks it, returns the session to idle).
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // (3) a HUMAN turn on the same session — the exact thing that used to wedge `busy`.
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // (4) a second channel message MUST still drive a turn. Pre-fix: `busy` is stuck true, so the
  //     incoming message is buffered and this never fires — waitForPrompts times out at length 1.
  await pub.multicast("still there?", { channel: "team" });
  await waitForPrompts(2);
  check("a channel message STILL drives after a human turn (no busy wedge)", prompts.length === 2, prompts);

  console.log(`\nOPENCODE TURN-WEDGE TEST PASSED ✅  (${pass} checks)`);
} finally {
  await hooks?.dispose?.();
  await pub.stop();
  srv.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);

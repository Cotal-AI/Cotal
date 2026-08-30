/*
 * Claude channel activation wake reconciliation over a uniquely owned real NATS/JetStream broker.
 * No test runner, Claude client, or claude/channel handshake is launched: this drives the shipped
 * MeshAgent and createWakePolicy directly at the false-to-true activation seam.
 *
 * Run: pnpm smoke:claude-activation-wake
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/activation-wake-reconcile.json
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";
import { MeshAgent, type InboxItem } from "@cotal-ai/connector-core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createWakePolicy } from "../src/hooks.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const waitFor = async (what: string, condition: () => boolean, timeoutMs = 8_000): Promise<void> => {
  for (let elapsed = 0; elapsed < timeoutMs && !condition(); elapsed += 100) await sleep(100);
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
};

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "ccactivate";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

let pass = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  assert.ok(condition, `${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const agent = new MeshAgent({
  space,
  name: "Wanda",
  id: "wanda",
  kind: "agent",
  role: "generalist",
  servers,
  subscribe: ["team"],
  allowSubscribe: ["team"],
  allowPublish: ["team"],
  tls: false,
});
agent.on("error", () => {});
const publisher = new CotalEndpoint({
  space,
  servers,
  card: { name: "Pubby", kind: "agent", id: "pubby" },
  channels: ["team"],
});
publisher.on("error", () => {});
const pending = (text: string): boolean => agent.peekInbox("all").some((item: InboxItem) => item.text.includes(text));

try {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) break;
    await sleep(200);
  }
  await seedChannelRegistry({
    servers,
    space,
    file: { defaults: { replay: false }, channels: { team: { replay: false } } },
  });
  await publisher.start();
  agent.start();
  await waitFor("Wanda to join", () => publisher.getRoster().some((peer) => peer.card.name === "Wanda"));
  const wandaId = publisher.getRoster().find((peer) => peer.card.name === "Wanda")!.card.id;

  const notices: string[] = [];
  const wake = createWakePolicy(agent, async ({ content }) => {
    notices.push(content);
  });
  try {
    await agent.setAttention("focus");
    await publisher.multicast("@Wanda mention before activation", { channel: "team", mentions: ["Wanda"] });
    await sleep(500);
    check("the pre-activation focus mention is ack-dropped with pendingWake zero", agent.pendingWake() === 0, {
      pendingWake: agent.pendingWake(),
    });
    check("the pre-activation focus mention is absent from the inbox", !pending("mention before activation"));
    check("the inactive mention nudge emits no notice", notices.length === 0, notices);

    wake.setChannelActive(true);
    await sleep(500);
    check("activation re-fires the remembered focus mention", notices.length === 1 && notices[0].includes("pull it with cotal_inbox"), notices);
    wake.setChannelActive(true);
    await sleep(500);
    check("repeated active state emits no duplicate mention notice", notices.length === 1, notices);

    wake.setChannelActive(false);
    await publisher.unicast(wandaId, "buffered before activation");
    await waitFor("the buffered DM", () => pending("buffered before activation"));
    check("the inactive buffered wake emits no notice", notices.length === 1, notices);
    wake.setChannelActive(true);
    await waitFor("the activation batch notice", () => notices.length === 2);
    check("activation falls back to one buffered pending wake", notices[1].includes("Cotal message"), notices);
    check("the buffered activation notice does not deliver or ack the DM", pending("buffered before activation"));
    wake.setChannelActive(true);
    await sleep(500);
    check("repeated active state emits no duplicate buffered notice", notices.length === 2, notices);
    agent.drainInbox();

    wake.setChannelActive(false);
    await publisher.unicast(wandaId, "buffered behind mention priority");
    await waitFor("the priority DM", () => pending("buffered behind mention priority"));
    await agent.setAttention("focus");
    await publisher.multicast("@Wanda priority mention", { channel: "team", mentions: ["Wanda"] });
    await sleep(500);
    const beforePriorityActivation = notices.length;
    wake.setChannelActive(true);
    await waitFor("the priority mention notice", () => notices.length === beforePriorityActivation + 1);
    check("activation reconciles the remembered mention before buffered work", notices.at(-1)?.includes("pull it with cotal_inbox") === true, notices);
    check("mention-first activation leaves the buffered DM pending", pending("buffered behind mention priority"));
    wake.setChannelActive(false);
    wake.setChannelActive(true);
    await waitFor("the remaining buffered wake", () => notices.length === beforePriorityActivation + 2);
    check("the next activation reconciles the one remaining buffered wake", notices.at(-1)?.includes("Cotal message") === true, notices);
  } finally {
    wake.stop();
  }

  console.log(`\nCLAUDE ACTIVATION-WAKE TEST PASSED ✅  (${pass} checks passed)`);
} finally {
  await agent.stop().catch(() => {});
  await publisher.stop().catch(() => {});
  broker.kill("SIGKILL");
  await once(broker, "exit").catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(0);

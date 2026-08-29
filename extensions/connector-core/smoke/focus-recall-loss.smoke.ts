/**
 * Issue #977 real-broker reproduction at exact SHA 7c0b24a9.
 *
 * Drives the actual MeshAgent ingest, recallAmbient, and cotal_inbox tool spec against an isolated
 * nats-server. It proves replay-on recall works, then asks the two issue cases whether loss is either
 * recovered or reported: replay-off concrete channel and wildcard subscription.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent, type InboxItem } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "issue977";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(40); } return f(); };
const awaitExit = (p: ReturnType<typeof spawn>) => new Promise<void>((resolve) => { if (p.exitCode !== null) return resolve(); p.once("exit", () => resolve()); setTimeout(resolve, 3000); });

const cfg: AgentConfig = {
  space, name: "Otto", role: "reviewer", servers,
  subscribe: ["open-ch", "quiet-ch", "team.>"],
  allowSubscribe: ["open-ch", "quiet-ch", "team.>"],
  allowPublish: ["open-ch", "quiet-ch", "team.x"],
  kind: "agent", tls: false, id: "otto_issue977", lifecycleUid: mintLifecycleUid(),
};
const agent = new MeshAgent(cfg); agent.on("error", () => {});
const wakes: InboxItem[] = []; agent.on("mention-wake", (i: InboxItem) => wakes.push(i));
const pub = new CotalEndpoint({
  space, servers, card: { name: "Pubby", kind: "agent", id: "pubby_issue977" },
  channels: ["open-ch", "quiet-ch", "team.x"], lifecycleUid: mintLifecycleUid(),
});
pub.on("error", () => {});
const inbox = cotalToolSpecs(cfg).find((s) => s.name === "cotal_inbox")!;

const result: Record<string, unknown> = { sha: "7c0b24a971c22186145d372a0364437d6f8b8b22", broker: "nats-server 2.14.0" };
try {
  for (let i = 0; i < 50 && !(await isReachable(servers)); i++) await sleep(100);
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { "open-ch": { replay: true }, "quiet-ch": { replay: false }, "team.x": { replay: true } } } });
  await pub.start(); agent.start();
  for (let i = 0; i < 50 && !agent.connected; i++) await sleep(100);
  assert.equal(agent.connected, true, "agent connects");
  await sleep(300); await agent.setAttention("focus");

  // Positive control: replay-on concrete channel returns both ambient and mention through real inbox.
  await pub.multicast("control-ambient", { channel: "open-ch" });
  await pub.multicast("control-mention", { channel: "open-ch", mentions: ["otto"] });
  assert.equal(await until(() => wakes.some((i) => i.text === "control-mention")), true, "control mention wakes");
  await sleep(250);
  const controlRecall = await agent.recallAmbient();
  const controlInbox = await inbox.run(agent, cfg, { peek: true });
  assert(controlRecall.items.some((i) => i.text === "control-ambient"));
  assert(controlRecall.items.some((i) => i.text === "control-mention"));
  assert(controlInbox.text.includes("control-ambient") && controlInbox.text.includes("control-mention"));
  result.control = { recallTexts: controlRecall.items.map((i) => i.text), droppedChannels: controlRecall.droppedChannels, inboxText: controlInbox.text };

  // Case 1: replay-off concrete. Both bodies are ack-dropped; recall must return or report loss.
  await pub.multicast("off-ambient", { channel: "quiet-ch" });
  await pub.multicast("off-mention", { channel: "quiet-ch", mentions: ["otto"] });
  assert.equal(await until(() => wakes.some((i) => i.text === "off-mention")), true, "replay-off mention wakes");
  await sleep(250);
  const offRecall = await agent.recallAmbient();
  const offInbox = await inbox.run(agent, cfg, { peek: true });
  const offBodiesInInbox = offInbox.text.includes("off-ambient") && offInbox.text.includes("off-mention");
  result.replayOff = { recallTexts: offRecall.items.map((i) => i.text), droppedChannels: offRecall.droppedChannels, inboxText: offInbox.text,
    bodiesRecovered: offBodiesInInbox, lossReported: offRecall.droppedChannels.includes("quiet-ch") };

  // Case 2: wildcard. team.x is replay-on, but recall walks joinedChannels() and skips team.>.
  await pub.multicast("wild-ambient", { channel: "team.x" });
  await pub.multicast("wild-mention", { channel: "team.x", mentions: ["otto"] });
  assert.equal(await until(() => wakes.some((i) => i.text === "wild-mention")), true, "wildcard mention wakes");
  await sleep(250);
  const wildRecall = await agent.recallAmbient();
  const wildInbox = await inbox.run(agent, cfg, { peek: true });
  const wildBodiesInInbox = wildInbox.text.includes("wild-ambient") && wildInbox.text.includes("wild-mention");
  result.wildcard = { joinedChannels: agent.joinedChannels(), recallTexts: wildRecall.items.map((i) => i.text), droppedChannels: wildRecall.droppedChannels, inboxText: wildInbox.text,
    bodiesRecovered: wildBodiesInInbox, lossReported: wildRecall.droppedChannels.includes("team.>") || wildRecall.droppedChannels.includes("team.x") };

  console.log(JSON.stringify(result, null, 2));
  const off = result.replayOff as { bodiesRecovered: boolean; lossReported: boolean };
  const wild = result.wildcard as { bodiesRecovered: boolean; lossReported: boolean };
  assert.equal(off.bodiesRecovered || off.lossReported, true, "replay-off body must be returned or loss reported");
  assert.equal(wild.bodiesRecovered || wild.lossReported, true, "wildcard body must be returned or loss reported");

  // End-user pull semantics: one destructive cotal_inbox call returns each target body once and
  // clears the locally retained lane; the next call cannot repeat them. Stream-recalled controls are
  // read-only but advance their cursor when delivered, so they also disappear from the second reply.
  const delivered = await inbox.run(agent, cfg, { peek: false });
  for (const body of ["off-ambient", "off-mention", "wild-ambient", "wild-mention"])
    assert.equal(delivered.text.split(body).length - 1, 1, `${body} delivered exactly once`);
  const after = await inbox.run(agent, cfg, { peek: false });
  for (const body of ["off-ambient", "off-mention", "wild-ambient", "wild-mention"])
    assert.equal(after.text.includes(body), false, `${body} not repeated after destructive pull`);
  result.destructivePull = { delivered: delivered.text, after: after.text };
  console.log("ISSUE_977_ACCEPTANCE_PASSED");
  await agent.stop(); await pub.stop();
} finally {
  srv.kill("SIGKILL"); await awaitExit(srv); rmSync(dir, { recursive: true, force: true }); releaseBroker();
}

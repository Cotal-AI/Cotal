/**
 * LIVE: a retired chat leaves an offline presence card but no DM durable. A send's storage receipt
 * must not promise delivery on reconnect. The control keeps an offline lifecycle's inbox and proves
 * that the same lifecycle still receives its pending DM. All CLI calls use an isolated static stack.
 * Run: pnpm smoke:send-retired-chat:live
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CotalEndpoint, dmDurable, parsePrincipalKey } from "@cotal-ai/core";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { connectOrThrow } from "@cotal-ai/workspace";

const repo = resolve(import.meta.dirname, "../../..");
const cliPath = join(repo, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const scratch = mkdtempSync(join(tmpdir(), "cotal-send-retired-chat-"));
const root = join(scratch, "root");
const home = join(scratch, "home");
const xdg = join(scratch, "xdg");
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
const evidence = process.env.SEND_RETIRED_CHAT_EVIDENCE ?? join(scratch, "evidence");
mkdirSync(evidence, { recursive: true });
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
  HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg,
  TMPDIR: scratch, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", DO_NOT_TRACK: "1",
};
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
function cli(label: string, ...args: string[]) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, ["--import", tsx, cliPath, ...args], options);
  writeFileSync(join(evidence, `${label}.json`), JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2));
  return result;
}
function child(label: string, ...args: string[]) {
  const process = spawn(globalThis.process.execPath, ["--import", tsx, cliPath, ...args], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  process.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
  process.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
  const done = new Promise<number | null>((resolve, reject) => {
    process.once("error", reject);
    process.once("close", (code) => {
      writeFileSync(join(evidence, `${label}.json`), JSON.stringify({ code, stdout, stderr }, null, 2));
      resolve(code);
    });
  });
  return { process, done, output: () => stdout };
}
async function until(test: () => boolean): Promise<void> {
  const end = Date.now() + 30_000;
  while (!test()) {
    assert.ok(Date.now() < end, "timed out waiting for a stdio result");
    await wait(50);
  }
}
const records = (chat: ReturnType<typeof child>) => chat.output().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const notice = "Only the same lifecycle can receive it, while its inbox still exists. If the session ended or its inbox was removed, it cannot receive this message. A new session or agent named eve does not receive it.";
let chat: ReturnType<typeof child> | undefined;
let sender: ReturnType<typeof child> | undefined;
let control: CotalEndpoint | undefined;
let receiver: CotalEndpoint | undefined;
let truthful = false;
try {
  const server = `nats://127.0.0.1:${await freePort()}`;
  const up = cli("up", "up", "--detach", "--server", server);
  assert.equal(up.status, 0, up.stderr);
  let ready = false;
  for (let attempt = 0; attempt < 20 && !ready; attempt++) {
    ready = cli(`ps-${attempt}`, "ps").status === 0;
    if (!ready) await wait(500);
  }
  assert.ok(ready, "owned stack manager did not become ready");

  // Keep setup and process startup outside the short retained offline-card window.
  chat = child("eve", "chat", "--stdio", "--name", "eve");
  chat.process.stdin.write(`${JSON.stringify({ schemaVersion: 1, type: "connection", id: "identity" })}\n`);
  await until(() => chat!.output().includes('"id":"identity"'));
  const identity = records(chat).find((r) => r.id === "identity").result.identity;
  const principal = parsePrincipalKey(identity.principal);
  assert.ok(principal);
  const durable = dmDurable(principal.owner, principal.actor, identity.lifecycleUid);
  const live = cli("live-control", "send", "-t", "eve", "live-control", "--json");
  assert.equal(live.status, 0, live.stderr);
  await until(() => records(chat!).some((r) => r.type === "message" && r.message.text === "live-control"));

  sender = child("retired-send", "send", "-t", "eve", "--stdin", "--json");
  await wait(1_000);
  chat.process.stdin.end();
  assert.equal(await chat.done, 0);
  const end = records(chat).find((r) => r.type === "end");
  assert.equal(end.close.retirement, "retired");
  assert.equal(end.close.connectionClosed, "confirmed");
  sender.process.stdin.end("held-after-retirement");
  assert.equal(await sender.done, 0);
  const sent = JSON.parse(sender.output());
  assert.equal(sent.result.stored, true);
  assert.equal(sent.result.delivery, null);
  const warning = sent.warnings.find((w: { code: string }) => w.code === "RECIPIENT_OFFLINE");
  assert.ok(warning, "send missed the retained offline presence window");
  truthful = warning.message.includes(notice) && !warning.message.includes("stored and delivered when");
  const missing = cli("retired-pending", "pending", "eve", "--durable", durable, "--json");
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).error.code, "TARGET_NOT_FOUND");
  console.log("Retired case: chat confirmed retirement, send stored a DM, and its exact inbox was absent.");

  chat = child("eve-successor", "chat", "--stdio", "--name", "eve");
  chat.process.stdin.write(`${JSON.stringify({ schemaVersion: 1, type: "connection", id: "successor" })}\n`);
  await until(() => chat!.output().includes('"id":"successor"'));
  const next = records(chat).find((r) => r.id === "successor").result.identity;
  assert.notEqual(next.principal, identity.principal);
  await wait(500);
  chat.process.stdin.end();
  assert.equal(await chat.done, 0);
  assert.ok(!records(chat).some((r) => r.type === "message" && r.message.text === "held-after-retirement"));

  // Shipped mint entrypoint provisions the control's lifecycle. Only the endpoint opens its private
  // credential, as in an ordinary library client. No credential bytes enter the evidence.
  const creds = join(scratch, "control.creds");
  const minted = cli("control-mint", "auth", "mint", "ctrl", "--provision", "--out", creds, "--json");
  assert.equal(minted.status, 0, minted.stderr);
  const mintedResult = JSON.parse(minted.stdout).result;
  const connection = await connectOrThrow({ space: identity.space, server, creds }, "operator");
  const options = { space: identity.space, servers: server, creds: connection.creds, lifecycleUid: mintedResult.lifecycleUid,
    card: { name: "ctrl", kind: "agent" as const }, channels: [] as string[], consume: false, heartbeatMs: 500 };
  control = new CotalEndpoint(options);
  control.on("error", () => {});
  await control.start();
  await control.setStatus("offline");
  const held = cli("control-send", "send", "-t", "ctrl", "held-for-reconnect", "--json");
  assert.equal(held.status, 0, held.stderr);
  const controlSend = JSON.parse(held.stdout);
  assert.equal(controlSend.result.stored, true);
  assert.ok(controlSend.warnings.some((w: { code: string }) => w.code === "RECIPIENT_OFFLINE"));
  const controlPrincipal = parsePrincipalKey(mintedResult.principal);
  assert.ok(controlPrincipal);
  const controlDurable = dmDurable(controlPrincipal.owner, controlPrincipal.actor, mintedResult.lifecycleUid);
  const pending = cli("control-pending", "pending", "ctrl", "--durable", controlDurable, "--json");
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).result.pending, 1);
  await control.stop();
  receiver = new CotalEndpoint({ ...options, consume: true });
  const received: string[] = [];
  receiver.on("error", () => {});
  receiver.on("message", (message, delivery) => {
    received.push(message.id);
    delivery.ack();
  });
  await receiver.start();
  await until(() => received.includes(controlSend.result.messageId));
  console.log("Positive control: offline lifecycle kept one pending DM and received it after reconnect.");
  assert.ok(truthful, "retired-chat send promised delivery without an inbox instead of explaining the lifecycle limit");
  console.log("Retired-chat receipt explains that an ended lifecycle cannot receive the stored DM.");
} finally {
  for (const active of [sender, chat]) {
    if (active && active.process.exitCode === null && active.process.signalCode === null) {
      active.process.stdin.end();
      active.process.kill("SIGTERM");
      await active.done;
    }
  }
  await receiver?.stop();
  await control?.stop();
  const down = cli("down", "down", "--yes");
  assert.equal(down.status, 0, down.stderr);
  console.log(`Evidence retained at ${evidence}`);
}

/** Tool outcomes through the shipped Jcode host with an owned, stopped broker.
 * Run: pnpm exec tsx extensions/connector-jcode/smoke/jcode-transport-outcome.smoke.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CotalEndpoint, isReachable, mintLifecycleUid, partsToText, seedChannelRegistry } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const root = mkdtempSync("/tmp/jout-");
const store = join(root, SMOKE_BROKER_TOKEN);
const port = await freePort();
assert.notEqual(port, 4222);
const servers = `nats://127.0.0.1:${port}`;
const space = `jout${randomBytes(5).toString("hex")}`;
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ambient: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambient)) if (key.startsWith("COTAL_") || key.startsWith("JCODE_")) delete ambient[key];
for (const path of ["bin", "source", "home", "config", "cotalhome"]) mkdirSync(join(root, path), { mode: 0o700 });
const env: NodeJS.ProcessEnv = { ...ambient, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_HOME: join(root, "cotalhome") };
writeFileSync(join(root, "source/auth.json"), "owned-transport-fixture", { mode: 0o600 });
writeFileSync(join(root, "bin/jcode"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
chmodSync(join(root, "bin/jcode"), 0o755);
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-js", "-p", String(port), "-sd", store], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
const disarm = teardownOnSignal(broker, root);
let brokerLog = "", hostLog = "";
broker.stderr.on("data", (chunk: Buffer) => { brokerLog += chunk.toString(); });
let child: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let client: Client | undefined;
let passed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}: ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ✓ ${name}`);
};
const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const reply = await client!.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  return JSON.stringify(reply.content);
};
try {
  let ready = false;
  for (let i = 0; i < 200; i++) { if (await isReachable(servers)) { ready = true; break; } await wait(50); }
  assert(ready, brokerLog);
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  operator = new CotalEndpoint({ servers, space, channels: ["team"], card: { id: "operator", name: "operator", kind: "agent" } });
  operator.on("error", () => {});
  const seen: string[] = [];
  operator.on("message", (message) => { seen.push(partsToText(message.parts)); });
  await operator.start();
  child = spawn(tsx, [host], { cwd: root, detached: true, env: {
    ...env, PATH: `${join(root, "bin")}:${env.PATH ?? ""}`, JCODE_HOME: join(root, "source"),
    COTAL_SPACE: space, COTAL_NAME: "seat", COTAL_ID: "seat", COTAL_LIFECYCLE_UID: mintLifecycleUid(), COTAL_SERVERS: servers,
    COTAL_SUBSCRIBE: "team", COTAL_ALLOW_SUBSCRIBE: "team", COTAL_ALLOW_PUBLISH: "team", COTAL_JCODE_HOME: root,
    COTAL_JCODE_TUI: "0", COTAL_CONTROL_SOCKET: join(root, "control.sock"), COTAL_CONTROL_TOKEN: randomBytes(32).toString("base64url"),
  }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr!.on("data", (chunk: Buffer) => { hostLog += chunk.toString(); });
  let entry: { command: string; args: string[]; env: Record<string, string> } | undefined;
  for (let i = 0; i < 300 && !entry; i++) {
    const homes = join(root, ".cotal/jcode");
    if (existsSync(homes)) for (const home of readdirSync(homes)) {
      const path = join(homes, home, "mcp.json");
      if (existsSync(path)) entry = (JSON.parse(readFileSync(path, "utf8")) as { servers: { cotal: typeof entry } }).servers.cotal;
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(hostLog);
    if (!entry) await wait(50);
  }
  assert(entry, hostLog);
  client = new Client({ name: "transport-outcome-smoke", version: "1" });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, cwd: root, env: { ...(env.PATH ? { PATH: env.PATH } : {}), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), ...entry.env }, stderr: "pipe" }));
  let state = "";
  for (let i = 0; i < 200; i++) { state = await invoke("cotal_connection_status"); if (state.includes("ready")) break; await wait(50); }
  check("healthy host reports ready", state.includes("ready"), state);
  check("healthy no-turn yield keeps its refusal", (await invoke("cotal_yield", { status: "blocked" })).includes("no turn is active"));
  check("healthy channel send still succeeds", (await invoke("cotal_send", { channel: "team", text: "healthy-control" })).includes("Sent to #team"));
  broker.kill("SIGSTOP");
  const uncertain = await invoke("cotal_send", { channel: "team", text: "timed-out-but-stored" });
  check("publish timeout reports unknown outcome without claiming non-delivery", uncertain.includes("send outcome is unknown") && !uncertain.includes("was not sent"), uncertain);
  broker.kill("SIGCONT");
  for (let i = 0; i < 200 && !seen.includes("timed-out-but-stored"); i++) await wait(50);
  check("the exact timed-out message can arrive after the broker resumes", seen.includes("timed-out-but-stored"), seen);
  broker.kill("SIGSTOP");
  const reconnect = await invoke("cotal_reconnect");
  check("stopped broker reconnect returns its bounded failure", reconnect.includes("Reconnect failed: timeout"), reconnect);
  const [send, yielded] = await Promise.all([
    invoke("cotal_send", { channel: "team", text: "refused-before-send" }),
    invoke("cotal_yield", { status: "blocked" }),
  ]);
  check("disconnected send says it was not sent", send.includes("not connected") && send.includes("The message was not sent"), send);
  check("disconnected yield says it was not sent", yielded.includes("not connected") && yielded.includes("The yield was not sent"), yielded);
  broker.kill("SIGCONT");
  assert.equal(passed, 8);
  console.log(`\nJCODE TRANSPORT OUTCOME PASSED (${passed} checks)`);
} catch (error) {
  process.stderr.write(`HOST STDERR:\n${hostLog}\nBROKER STDERR:\n${brokerLog}\n`);
  throw error;
} finally {
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGCONT");
  await client?.close().catch(() => {});
  if (child) {
    child.kill("SIGTERM");
    for (let i = 0; i < 300 && child.exitCode === null && child.signalCode === null; i++) await wait(50);
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* owned group already gone */ } }
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await wait(50);
    assert(child.exitCode !== null || child.signalCode !== null, "owned host exit unproved");
  }
  await operator?.stop();
  await killAndAwaitExit(broker);
  disarm();
  rmSync(root, { recursive: true });
}

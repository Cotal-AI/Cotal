/** A reconnect keeps the initially selected seat, even with an explicit manager constraint. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { Connector, LaunchSpec } from "@cotal-ai/core";

const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}attach-identity-`));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "COTAL_HOME"]) {
  process.env[key] = join(dir, key);
  mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
}
const { registry, setupSpaceStreams, isReachable, mintLifecycleUid } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { attachRefusal } = await import("@cotal-ai/workspace/attach");
const { MeshAgent } = await import("@cotal-ai/connector-core");
const { Manager } = await import("../dist/index.js");
const repo = resolve(import.meta.dirname, "../../..");
const root = join(dir, "workspace");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const connector: Connector = { kind: "connector", name: "identity-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({
  command: process.execPath, args: [join(import.meta.dirname, "e2e-stub.mjs")], env: {
    COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_ID: String(o.id),
    COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid), PATH: process.env.PATH ?? "",
  },
}) };
registry.register(connector);
const cases = ["pinned-cli", "located-cli", "pinned-workspace", "healthy-cli"] as const;
for (const name of cases) writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nagent: identity-stub\n---\n`);
const port = await freePort(), proxyPort = await freePort();
const server = `nats://127.0.0.1:${port}`, proxyUrl = `nats://127.0.0.1:${proxyPort}`;
const space = `attach-identity-${randomUUID().slice(0, 8)}`;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 25_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return true; await wait(100); }
  return await f();
};
let proxy: Server | undefined;
const sockets = new Set<Socket>();
const heal = async () => {
  proxy = createServer(client => {
    const upstream = netConnect(port, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    const drop = () => { sockets.delete(client); sockets.delete(upstream); client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) { socket.on("error", drop); socket.on("close", drop); }
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise<void>((r, j) => { proxy!.once("error", j); proxy!.listen(proxyPort, "127.0.0.1", r); });
};
const sever = async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (proxy) { const old = proxy; proxy = undefined; await new Promise<void>(r => old.close(() => r())); }
};
const env = { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
const cli = async (args: string[]) => {
  const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), ...args, "--server", server, "--space", space, "--json"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", b => { out += String(b); }); child.stderr.on("data", b => { err += String(b); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try { const code = await new Promise<number | null>((r, j) => { child.once("error", j); child.once("close", r); }); return { code, out, err }; }
  finally { clearTimeout(timer); }
};
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let manager: InstanceType<typeof Manager> | undefined;
let observer: InstanceType<typeof MeshAgent> | undefined;
const attaches: { child: ReturnType<typeof spawn>; done: Promise<void> }[] = [];
let checks = 0;
const failures: string[] = [];
const check = (label: string, condition: boolean, detail: unknown) => {
  checks++;
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures.push(`${label}: ${JSON.stringify(detail)}`);
};
try {
  check("epoch expiry alone stays recoverable", attachRefusal("expired") === "transient", "expired");
  assert.ok(await until(() => isReachable(server)), "private broker ready");
  await setupSpaceStreams({ servers: server, space });
  recordMesh({ space, server, root, mode: "open", ts: new Date().toISOString() });
  manager = new Manager({ space, servers: server, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const iid = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
  observer = new MeshAgent({ space, servers: server, name: "identity-observer", kind: "agent", lifecycleUid: mintLifecycleUid(), subscribe: [], allowSubscribe: [], allowPublish: [], tls: false });
  observer.on("error", () => {});
  await observer.start();
  assert.ok(await until(() => observer!.connected), "observer ready");
  await heal();
  for (const name of cases) {
    assert.ok((await manager.startAgent({ name, agent: connector.name, cwd: dir, events: false })).ok, "initial seat ready");
    const before = await observer.invokeEndpoint("manager", "inspect", { name });
    assert.ok(before.reply.ok);
    const original = before.reply.data as { id: string; lifecycleUid: string };
    const workspace = name === "pinned-workspace";
    const script = `const { attachSeat } = await import(${JSON.stringify(new URL("../../../packages/workspace/dist/attach/index.js", import.meta.url).href)});
      const { cliControl } = await import(${JSON.stringify(new URL("../../cli/dist/lib/control.js", import.meta.url).href)});
      const verdict = await attachSeat(${JSON.stringify({ space, server: proxyUrl, name })}, { control: cliControl, onRefusal: "throw", verb: "cotal attach", reconnect: true, on: ${JSON.stringify(iid)} });
      console.log("WORKSPACE_VERDICT", JSON.stringify(verdict));`;
    const args = workspace ? ["--input-type=module", "-e", script]
      : [join(repo, "bin/dist/cotal.js"), "attach", "--name", name, "--space", space, "--server", proxyUrl, ...(name === "located-cli" ? [] : ["--on", iid])];
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let text = "", exited = false, exitCode: number | null = null;
    child.stdout!.on("data", b => { text += String(b); }); child.stderr!.on("data", b => { text += String(b); });
    const done = new Promise<void>((r, j) => { child.once("error", j); child.once("close", code => { exited = true; exitCode = code; r(); }); });
    attaches.push({ child, done });
    assert.ok(await until(() => text.includes("attached to ") || exited) && !exited, `initial attach: ${text}`);
    check(`${name}: positive control streams original actor`, await until(() => text.includes(original.id)), text);
    await sever();
    assert.ok(await until(() => text.includes("connection lost, reconnecting"), 8_000), `loss observed: ${text}`);
    if (name === "healthy-cli") {
      await heal();
      check("same incarnation reconnects after link interruption", await until(() => text.includes("[cotal: reconnected]")), text);
      const current = await observer.invokeEndpoint("manager", "inspect", { name });
      check("reconnect control keeps the actual original lifecycle", current.reply.ok && (current.reply.data as { lifecycleUid: string }).lifecycleUid === original.lifecycleUid, current.reply);
      child.stdin!.write("\x1d");
      assert.ok(await until(() => exited, 6_000), "control detaches");
      await done;
      continue;
    }
    const stopped = await cli(["stop", "--name", name, "--on", iid]);
    assert.equal(stopped.code, 0, JSON.stringify(stopped));
    assert.ok(await until(async () => !(await observer!.ep.readPresence()).some(p => p.card.name === name && p.status !== "offline")), "old presence retired");
    type State = { agents: Map<string, unknown>; retiring: Map<string, unknown>; reserved: Set<string>; liveRosterNames(): Set<string> };
    const state = manager as unknown as State;
    assert.ok(await until(() => !state.agents.has(name) && !state.retiring.has(name) && !state.reserved.has(name) && !state.liveRosterNames().has(name)), "alias released");
    assert.ok((await manager.startAgent({ name, identity: name, agent: connector.name, cwd: dir, events: false })).ok, "replacement ready");
    const after = await observer.invokeEndpoint("manager", "inspect", { name });
    assert.ok(after.reply.ok);
    const replacement = after.reply.data as { id: string; lifecycleUid: string };
    check(`${name}: same alias has distinct real principal and lifecycle`, replacement.id !== original.id && replacement.lifecycleUid !== original.lifecycleUid, { original, replacement });
    await heal();
    await until(() => exited || text.includes("[cotal: reconnected]"), 18_000);
    check(`${name}: replacement never reconnects or streams`, !text.includes("[cotal: reconnected]") && !text.includes(replacement.id), text);
    check(`${name}: permanent selection mismatch ends without detach`, exited && exitCode === 0 && (workspace ? text.includes('"kind":"gone"') : text.includes("Attach target no longer available")), { text, exited, exitCode });
    if (!exited) child.stdin!.write("\x1d");
    if (!await until(() => exited, 6_000)) child.kill("SIGTERM");
    await done;
  }
  assert.deepEqual(failures, []);
  console.log(`ATTACH SEAT IDENTITY SMOKE OK (${checks} passed)`);
} finally {
  for (const { child, done } of attaches) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await done; }
  await sever();
  await observer?.stop();
  await manager?.stop({ withAgents: true });
  await killAndAwaitExit(broker);
  release();
  console.log("Retained private test state:", dir);
}

/**
 * An attached caller learns why its session ended. Run: pnpm smoke:attach-end-reason
 * (needs nats-server + node on PATH; boots its own broker).
 *
 * A real manager runs pty seats, and a real `attachSeat` (what `cotal attach` and the terminal app
 * run) holds a session to each. A seat that exits on its own must end the attach with
 * `process-exit` and still deliver its last output, and so must a supervised seat whose last exit
 * spends its restart budget. A seat stopped with `cotal stop` must end it with `target-despawn`
 * (SPEC 13.6), and so must a child the manager stops because its parent exited on its own.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { Connector, LaunchSpec, Runtime } from "@cotal-ai/core";
import { childlessRuntime } from "./_childless-runtime.js";

const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}attach-end-reason-`));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = join(dir, "COTAL_HOME");
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "COTAL_HOME"]) {
  process.env[key] = join(dir, key);
  mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
}
const { registry, setupSpaceStreams, isReachable } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("../dist/index.js");
const repo = resolve(import.meta.dirname, "../../..");
const root = join(dir, "workspace");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const seat = join(import.meta.dirname, "attach-exit-seat.mjs");
const connector: Connector = { kind: "connector", name: "end-reason-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({
  command: process.execPath, args: [seat], env: {
    COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_ID: String(o.id),
    COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid), PATH: process.env.PATH ?? "",
  },
}) };
registry.register(connector);
for (const name of ["exits", "looped", "stopped", "parent", "child"]) writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nagent: ${connector.name}\n---\n`);
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const space = `attach-end-${randomUUID().slice(0, 8)}`;
const env = { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return true; await wait(100); }
  return await f();
};

type Attach = { child: ReturnType<typeof spawn>; text: () => string; exited: () => boolean; done: Promise<void> };
const attaches: Attach[] = [];
function attach(name: string, on: string): Attach {
  const script = `const { attachSeat } = await import(${JSON.stringify(new URL("../../../packages/workspace/dist/attach/index.js", import.meta.url).href)});
    const { cliControl } = await import(${JSON.stringify(new URL("../../cli/dist/lib/control.js", import.meta.url).href)});
    const verdict = await attachSeat(${JSON.stringify({ space, server, name })}, { control: cliControl, onRefusal: "throw", verb: "cotal attach", reconnect: true, on: ${JSON.stringify(on)} });
    console.log("VERDICT", JSON.stringify(verdict));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let text = "", exited = false;
  child.stdout!.on("data", b => { text += String(b); });
  child.stderr!.on("data", b => { text += String(b); });
  const done = new Promise<void>((r, j) => { child.once("error", j); child.once("close", () => { exited = true; r(); }); });
  const a = { child, text: () => text, exited: () => exited, done };
  attaches.push(a);
  return a;
}
const endedWith = (a: Attach, reason: string): boolean => {
  const line = /VERDICT (\{.*\})/.exec(a.text());
  return line !== null && JSON.stringify(JSON.parse(line[1]!)) === JSON.stringify({ kind: "ended", reason });
};

const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let manager: InstanceType<typeof Manager> | undefined;
let passed = 0;
const failures: string[] = [];
const check = (label: string, condition: boolean, detail: unknown) => {
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (condition) passed++;
  else failures.push(`${label}: ${JSON.stringify(detail)}`);
};
try {
  assert.ok(await until(() => isReachable(server)), "private broker ready");
  await setupSpaceStreams({ servers: server, space });
  recordMesh({ space, server, root, mode: "open", ts: new Date().toISOString() });
  manager = new Manager({ space, servers: server, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const iid = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
  const agents = (manager as unknown as { agents: Map<string, unknown> }).agents;

  console.log("A. a seat that exits on its own");
  assert.ok((await manager.startAgent({ name: "exits", agent: connector.name, cwd: dir, events: false })).ok, "exits seat ready");
  const a = attach("exits", iid);
  assert.ok(await until(() => a.text().includes("SEAT_JOINED exits") || a.exited()) && !a.exited(), `attached: ${a.text()}`);
  a.child.stdin!.write("SEAT_EXIT\r");
  await until(() => a.exited());
  check("the attach ends with process-exit", endedWith(a, "process-exit"), a.text());
  check("the seat's last output reaches the caller", a.text().includes("SEAT_BYE"), a.text());
  check("the manager freed the seat", await until(() => !agents.has("exits")), [...agents.keys()]);

  console.log("B. a supervised seat whose last exit spends its restart budget");
  if (process.platform !== "linux") console.log("  • skipped: the childless runtime fixture that lets a pty seat be supervised needs Linux");
  else {
    // The seat starts no child processes, so its own exit is the proof that its work ended.
    childlessRuntime((manager as unknown as { runtime: Runtime }).runtime, join(dir, "childless-runtime"),
      (spec) => spec.command === process.execPath && spec.args.length === 1 && spec.args[0] === seat);
    type Seat = { handle: { pid?: number }; restart?: { recovering: boolean } };
    const looped = await manager.startAgent({ name: "looped", agent: connector.name, cwd: dir, events: false, supervise: { restarts: 1, windowMs: 60_000 } });
    assert.ok(looped.ok, `looped seat ready: ${JSON.stringify(looped)}`);
    const firstPid = (agents.get("looped") as Seat).handle.pid;
    const c1 = attach("looped", iid);
    assert.ok(await until(() => c1.text().includes("SEAT_JOINED looped") || c1.exited()) && !c1.exited(), `attached: ${c1.text()}`);
    c1.child.stdin!.write("SEAT_EXIT\r");
    await until(() => c1.exited());
    check("an exit the manager restarts ends the attach with process-exit", endedWith(c1, "process-exit"), c1.text());
    const restarted = () => { const row = agents.get("looped") as Seat | undefined; return row !== undefined && row.handle.pid !== firstPid && row.restart?.recovering === false; };
    assert.ok(await until(restarted), "looped seat restarted under the same lifecycle");
    const c2 = attach("looped", iid);
    assert.ok(await until(() => c2.text().includes("SEAT_JOINED looped") || c2.exited()) && !c2.exited(), `attached after restart: ${c2.text()}`);
    c2.child.stdin!.write("SEAT_EXIT\r");
    await until(() => c2.exited());
    check("the exit that spends the budget ends the attach with process-exit", endedWith(c2, "process-exit"), c2.text());
    check("the manager retired the seat", await until(() => !agents.has("looped")), [...agents.keys()]);
  }

  console.log("C. a seat stopped while attached");
  assert.ok((await manager.startAgent({ name: "stopped", agent: connector.name, cwd: dir, events: false })).ok, "stopped seat ready");
  const b = attach("stopped", iid);
  assert.ok(await until(() => b.text().includes("SEAT_JOINED stopped") || b.exited()) && !b.exited(), `attached: ${b.text()}`);
  const stop = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "stop", "--name", "stopped", "--on", iid, "--server", server, "--space", space, "--json"], { cwd: dir, env, stdio: "ignore" });
  const stopCode = await new Promise<number | null>((r, j) => { stop.once("error", j); stop.once("close", r); });
  assert.equal(stopCode, 0, "cotal stop succeeded");
  await until(() => b.exited());
  check("the attach ends with target-despawn", endedWith(b, "target-despawn"), b.text());

  console.log("D. a child reaped because its parent exited on its own");
  assert.ok((await manager.startAgent({ name: "parent", agent: connector.name, cwd: dir, events: false })).ok, "parent seat ready");
  const parentKey = (manager as unknown as { managedPrincipal(a: unknown): string }).managedPrincipal(agents.get("parent"));
  assert.ok((await manager.startAgent({ name: "child", agent: connector.name, cwd: dir, events: false }, parentKey)).ok, "child seat ready");
  const p = attach("parent", iid);
  const k = attach("child", iid);
  for (const [x, name] of [[p, "parent"], [k, "child"]] as const)
    assert.ok(await until(() => x.text().includes(`SEAT_JOINED ${name}`) || x.exited()) && !x.exited(), `attached ${name}: ${x.text()}`);
  p.child.stdin!.write("SEAT_EXIT\r");
  await until(() => p.exited() && k.exited());
  check("the parent's attach ends with process-exit", endedWith(p, "process-exit"), p.text());
  check("the reaped child's attach ends with target-despawn", endedWith(k, "target-despawn"), k.text());
  check("the manager freed both seats", await until(() => !agents.has("parent") && !agents.has("child")), [...agents.keys()]);
} finally {
  for (const { child, done } of attaches) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await done; }
  await manager?.stop({ withAgents: true });
  await killAndAwaitExit(broker);
  release();
  console.log("Retained private test state:", dir);
}
for (const f of failures) console.error(`  ✗ ${f}`);
emitSentinel({ passed, failed: failures.length });
process.exit(failures.length ? 1 : 0);

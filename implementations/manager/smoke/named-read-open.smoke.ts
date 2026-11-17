/** Named reads preserve an explicit broker address even without a local space registration. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import type { Connector, LaunchSpec } from "@cotal-ai/core";

const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}named-open-`));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = join(dir, "cotal");
for (const [key, value] of Object.entries({ HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: join(dir, "run"), COTAL_HOME: join(dir, "cotal") })) {
  process.env[key] = value;
  mkdirSync(value, { recursive: true, mode: 0o700 });
}
const { CotalEndpoint, registry, isReachable, setupSpaceStreams } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("../dist/index.js");
const repo = resolve(import.meta.dirname, "../../..");
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const space = `named-open-${randomUUID().slice(0, 8)}`;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const connector: Connector = { kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({
  command: "node", args: [join(import.meta.dirname, "e2e-stub.mjs")], env: {
    COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_ID: String(o.id),
    COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid), PATH: process.env.PATH ?? "",
  },
}) };
registry.register(connector);
const root = join(dir, "workspace");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "raw-seat.md"), "---\nname: raw-seat\nagent: e2e-stub\n---\n");
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let manager: InstanceType<typeof Manager> | undefined;
let duplicate: InstanceType<typeof CotalEndpoint> | undefined;
let checks = 0;
const failures: string[] = [];
const check = (label: string, condition: boolean, detail: unknown) => {
  if (!condition) failures.push(`${label}: ${JSON.stringify(detail)}`);
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  checks++;
};
const cli = async (args: string[]) => {
  const child = spawn(process.execPath, [join(repo, "bin", "dist", "cotal.js"), ...args, "--server", server, "--space", space, "--json"], {
    cwd: dir, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", data => { out += String(data); });
  child.stderr.on("data", data => { err += String(data); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("close", resolveExit); });
    return { code, out, err };
  } finally { clearTimeout(timer); }
};
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(server)) { up = true; break; } await wait(100); }
  assert.ok(up, "private open broker is reachable");
  await setupSpaceStreams({ servers: server, space });
  manager = new Manager({ space, servers: server, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const started = await manager.startAgent({ name: "raw-seat", agent: "e2e-stub", model: "raw-pin", cwd: dir, events: false });
  assert.ok(started.ok, JSON.stringify(started));
  const iid = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
  const ps = await cli(["ps"]);
  check("positive control: raw-open ps sees the held seat", ps.code === 0 && ps.out.includes("raw-seat"), ps);
  const row = (JSON.parse(ps.out).result.items as { name: string; id: string }[]).find(p => p.name === "raw-seat")!;
  for (const pin of [[], ["--on", iid]]) {
    const status = await cli(["status", "raw-seat", ...pin]);
    check(`raw-open named status ${pin.length ? "with" : "without"} explicit owner`, status.code === 0 && status.out.includes("raw-seat") && status.out.includes("raw-pin") && status.out.includes(iid), status);
  }
  for (const alias of ["RAW-SEAT", `local.${row.id}`, row.id]) {
    for (const pin of [[], ["--on", iid]]) {
      const status = await cli(["status", alias, ...pin]);
      check(`raw-open status resolves ${alias} ${pin.length ? "with" : "without"} explicit owner`, status.code === 0 && status.out.includes('"name":"raw-seat"') && status.out.includes("raw-pin") && status.out.includes(iid), status);
    }
  }
  duplicate = new CotalEndpoint({ space, servers: server, card: { id: "duplicate_seat", name: "raw-seat", kind: "endpoint", meta: { "ai.cotal.manager.instance": iid } }, lifecycleUid: randomUUID().replaceAll("-", ""), channels: [], consume: false, registerPresence: true });
  await duplicate.start();
  for (const action of [["status", "RAW-SEAT"], ["stop", "RAW-SEAT"], ["input", "RAW-SEAT", "unchanged"]]) {
    for (const pin of [[], ["--on", iid]]) {
      const result = await cli([...action, ...pin]);
      check(`ambiguous ${action[0]} ${pin.length ? "pinned" : "unpinned"} preserves typed refusal`, result.code === 2 && result.out.includes('"code":"TARGET_AMBIGUOUS"'), result);
      console.log("AMBIGUITY_OBSERVATION", JSON.stringify({ action: action[0], pinned: pin.length > 0, ...result }));
    }
  }
  await duplicate.stop();
  duplicate = undefined;
  const restored = await cli(["status", "RAW-SEAT", "--on", iid]);
  check("removing duplicate restores pinned uppercase status on original seat", restored.code === 0 && restored.out.includes("raw-pin"), restored);
  const absent = await cli(["status", "absent-seat"]);
  check("raw-open absent name is TARGET_NOT_FOUND", absent.code === 2 && absent.out.includes("TARGET_NOT_FOUND"), absent);
  recordMesh({ space, server, root, mode: "open", ts: new Date().toISOString() });
  const registered = await cli(["status", "raw-seat"]);
  check("positive control: registered-open named status still works", registered.code === 0 && registered.out.includes("raw-pin"), registered);
  for (const pin of [[], ["--on", iid]]) {
    const inspect = await cli(["endpoint", "invoke", "manager", "inspect", "--args", JSON.stringify({ name: "raw-seat" }), ...pin]);
    check(`registered-open generic inspect ${pin.length ? "with" : "without"} explicit owner stays unsupported`, inspect.code === 2 && inspect.out.includes('"code":"UNSUPPORTED"') && inspect.out.includes("requires an authenticated caller"), inspect);
  }
  assert.deepEqual(failures, []);
  console.log(`NAMED READ OPEN SMOKE OK (${checks} passed)`);
} finally {
  await duplicate?.stop();
  await manager?.stop({ withAgents: true });
  await killAndAwaitExit(broker);
  release();
  console.log("Retained private test state:", dir);
}

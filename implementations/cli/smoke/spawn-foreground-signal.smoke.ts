/** Real foreground dispatch on an owned open broker, with a dummy harness. No auth or model.
 * The outer SIGTERM observer keeps the wrapper alive so absence of forwarding is observable. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../manager/smoke/_free-port.js";

if (process.argv[2] === "entry") {
  const [server, root, home, program, marker, received] = process.argv.slice(3) as [string, string, string, string, string, string];
  process.env.COTAL_HOME = home;
  process.env.COTAL_NO_PROMPT = "1";
  process.on("SIGTERM", () => writeFileSync(received, "received"));
  await import("../src/index.js");
  const { runCli } = await import("../src/command.js");
  const { registry } = await import("@cotal-ai/core");
  const { recordMesh } = await import("@cotal-ai/workspace");
  recordMesh({ space: "signalprobe", server, root, mode: "open", ts: new Date().toISOString() } as never);
  const probe: import("@cotal-ai/core").Connector = { kind: "connector", name: "signal_probe", requires: [], buildLaunch() {
    return { command: process.execPath, args: [program, marker], env: { PATH: process.env.PATH! } };
  } };
  registry.register(probe);
  const persona = join(root, "probe.md");
  writeFileSync(persona, "---\nname: signal_probe\nrole: worker\n---\nfixture persona\n");
  await runCli(registry, ["spawn", "--config", persona, "--agent", "signal_probe", "--server", server, "--space", "signalprobe", "--no-events"]);
  process.exit();
}
const dir = mkdtempSync(join(tmpdir(), "cotal-fg-signal-"));
const home = join(dir, "home"), root = join(dir, "root");
const marker = join(dir, "harness.json"), received = join(dir, "received");
mkdirSync(home); mkdirSync(root);
const program = join(dir, "dummy.cjs");
writeFileSync(program, 'const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(process.argv[2],JSON.stringify({term:true})));process.stdin.on("data",d=>{if(/fixture-(exit|cleanup)/.test(d.toString()))process.exit(0)});fs.writeFileSync(process.argv[2],JSON.stringify({term:false}));setInterval(()=>{},1000);');
const port = await pickFreePort();
const store = join(dir, `${SMOKE_BROKER_TOKEN}signal-js`);
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
teardownOnSignal(broker, store);
const self = fileURLToPath(import.meta.url);
const tsx = resolve(dirname(self), "../../../node_modules/tsx/dist/cli.mjs");
let cli: ReturnType<typeof spawn> | undefined;
let stderr = "";
async function until(test: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`timeout ${label}: ${stderr}`);
}
try {
  await new Promise(resolve => setTimeout(resolve, 500));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  cli = spawn(process.execPath, [tsx, self, "entry", `nats://127.0.0.1:${port}`, root, home, program, marker, received], { env, stdio: ["pipe", "ignore", "pipe"] });
  cli.stderr!.on("data", bytes => { stderr += bytes.toString(); });
  await until(() => existsSync(marker), "foreground harness");
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).term, false, "ordinary launch is a positive control");
  console.log("PASS ordinary foreground harness launch");
  cli.kill("SIGTERM");
  await until(() => existsSync(received), "CLI signal observer");
  await until(() => JSON.parse(readFileSync(marker, "utf8")).term === true, "foreground CLI forwards SIGTERM to its owned harness");
  assert.equal(cli.exitCode, null, "foreground CLI waits while its signalled harness is still alive");
  assert.equal(cli.signalCode, null, "foreground CLI stays alive for child cleanup");
  cli.stdin!.write("fixture-exit\n");
  await until(() => cli!.exitCode !== null || cli!.signalCode !== null, "foreground cleanup");
  assert.equal(cli.exitCode, 0, "foreground CLI waits for the clean child exit");
  console.log("PASS foreground CLI signal relay and child-exit cleanup");
} finally {
  try {
    if (cli && cli.exitCode === null && cli.signalCode === null) {
      cli.stdin!.write("fixture-cleanup\n");
      await until(() => cli!.exitCode !== null || cli!.signalCode !== null, "owned fixture cleanup");
    }
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) { broker.kill("SIGTERM"); await new Promise(resolve => broker.once("exit", resolve)); }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("SPAWN FOREGROUND SIGNAL COMPLETE");
}

/** A silent listener stays distinct from a closed port in every space report. Status shares its
 *  selected preflight instead of spending the confirm budget once per section.
 *  Run: pnpm smoke:broker-not-answering */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, freePort, listenOn } from "@cotal-ai/smoke-kit";
import { isReachable, probeReachability } from "@cotal-ai/core";

const BIN = join(import.meta.dirname, "../../../bin/dist/cotal.js");
if (!existsSync(BIN)) throw new Error("build the binary before running this suite");
const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-broker-not-answering-"));
const project = join(home, "project");
const outside = join(home, "outside");
mkdirSync(project, { mode: 0o700 });
mkdirSync(outside, { mode: 0o700 });
// Give both directories their own project boundary, never an ancestor's records.
mkdirSync(join(project, ".cotal"), { mode: 0o700 });
mkdirSync(join(outside, ".cotal"), { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR", "NODE_OPTIONS"].includes(key)));
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), COTAL_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "0", NO_COLOR: "1" });
const sockets = new Set<Socket>();
let dials = 0;
const listener = createServer((socket) => {
  dials++;
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  socket.resume();
});
const server = `nats://127.0.0.1:${await listenOn(listener, await freePort())}`;

async function run(args: string[], cwd = outside) {
  const start = Date.now();
  const before = dials;
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    if (signal !== null) throw new Error(`CLI did not finish: ${signal}\n${stderr}`);
    return { code, stdout, stderr, ms: Date.now() - start, dials: dials - before };
  } finally { clearTimeout(timer); }
}

try {
  check("a silent INFO read retains its timeout", await probeReachability(server, { timeoutMs: 40 }) === "slow-link");
  check("the boolean liveness API still returns false for silence", await isReachable(server, { timeoutMs: 40 }) === false);
  const added = await run(["space", "add", "silent", "--root", project, "--server", server, "--mode", "open", "--force", "--yes", "--json"]);
  check("the shipped registration entrypoint accepts an unchecked space", added.code === 0, added);
  const selected = await run(["use", "silent", "--json"]);
  check("the shipped selection entrypoint selects it", selected.code === 0, selected);

  for (const mode of ["silent", "closed"] as const) {
    if (mode === "closed") {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
    const expected = mode === "silent" ? "slow-link" : "unreachable";
    const word = mode === "silent" ? "not answering" : "unreachable";
    const status = await run(["status", "--json"]);
    const result = JSON.parse(status.stdout).result;
    check(`${mode}: status JSON agrees across the selected connection and registry row`, status.code === 0 && result.selected.connection === expected && result.meshes.items[0].check === expected, status);
    check(`${mode}: status spends only one selected preflight`, status.dials === (mode === "silent" ? 2 : 0), { ms: status.ms, dials: status.dials });
    check(`${mode}: status never marks an inconclusive timeout stale`, mode !== "silent" || result.selected.staleRecord === false, result.selected);
    const human = await run(["status"]);
    check(`${mode}: human status uses the shared state name`, human.code === 0 && human.stdout.includes(word) && !human.stdout.includes("connection timed out"), human);
    for (const args of [["space"], ["space", "show", "silent"]]) {
      const json = await run([...args, "--json"]);
      const data = JSON.parse(json.stdout).result;
      check(`${mode}: ${args.join(" ")} JSON preserves the connection class`, json.code === 0 && (data.items?.[0] ?? data).check === expected, json);
      const report = await run(args);
      check(`${mode}: ${args.join(" ")} uses the shared state name`, report.code === 0 && report.stdout.includes(word), report);
    }
    for (const command of ["send", "who"]) {
      const args = command === "send" ? [command, "-c", "general", "x"] : [command];
      const refusal = await run(args);
      check(`${mode}: ${command} distinguishes silence from refusal`, refusal.code === 2 && (mode === "silent" ? refusal.stderr.includes("not answering") : refusal.stderr.includes("no broker answered")), refusal);
    }
    if (mode === "silent") {
      const all = await run(["status", "--all", "--json"]);
      check("--all does not probe the selected row again", all.code === 0 && all.dials === 2 && JSON.parse(all.stdout).result.meshes.items[0].check === expected, { ms: all.ms, dials: all.dials });
    }
  }
  check("a closed port is not a timeout", await probeReachability(server, { timeoutMs: 40 }) === "unreachable");
} finally {
  for (const socket of sockets) socket.destroy();
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
}
finish();

/** Real CLI roster observations over an isolated broker, including chat joins, status and leave.
 * Run after building the binary: pnpm smoke:watch-roster:live. Requires nats-server on PATH.
 * The private scratch directory is retained with the raw observer output for diagnosis. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, setupSpaceStreams } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { awaitBrokerReady, createSuite, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { clean, cotalPty, repoRoot, type Pty } from "./_console-pty.js";

const { check, finish } = createSuite();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(read: () => boolean, ms = 8_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (read()) return true; await wait(100); }
  return read();
}
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home"), root = join(dir, "project");
for (const path of [home, root]) mkdirSync(path, { mode: 0o700 });
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("COTAL_") && key !== "FORCE_COLOR") env[key] = value;
}
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", TERM: "xterm-256color" });
process.env.COTAL_HOME = home;
const space = "watch-roster-live";
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-js", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
// Keep the directory as evidence. Registration owns the broker, not the retained scratch tree.
const release = teardownOnSignal(broker);
const children: { child: ChildProcess; out: string; err: string; name: string }[] = [];
const endpoints: CotalEndpoint[] = [];
let terminal: Pty | undefined, terminalOut = "", terminalExit: number | undefined;
function cli(name: string, args: string[]) {
  const child = spawn(process.execPath, [join(repoRoot, "bin/dist/cotal.js"), ...args, "--space", space, "--server", server], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const run = { child, out: "", err: "", name };
  child.stdout.on("data", (data: Buffer) => { run.out += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { run.err += data.toString(); });
  children.push(run);
  return run;
}
function snapshots(run: { out: string }): { agents: { name: string; reportedStatus: string }[]; endpoints: { name: string; reportedStatus: string }[] }[] {
  return run.out.split("\n").slice(0, -1).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).filter((record) => record.type === "snapshot").map((record) => record.data);
}
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 200 });
  await setupSpaceStreams({ servers: server, space });
  recordMesh({ space, server, root, mode: "open", ts: new Date().toISOString() });
  const plain = cli("plain", ["watch", "--view", "roster", "--plain"]);
  const json = cli("json", ["watch", "--view", "roster", "--json"]);
  terminal = cotalPty(["watch", "--view", "roster", "--space", space, "--server", server], { cwd: root, env, cols: 180, rows: 40 });
  terminal.onData((data) => { terminalOut += data; });
  terminal.onExit(({ exitCode }) => { terminalExit = exitCode; });
  if (!await until(() => snapshots(json).length > 0 && plain.out.includes("snapshot") && clean(terminalOut).includes("q leave"), 20_000)) throw new Error("observers did not start");
  check("positive control: the JSON roster is initially empty", snapshots(json).at(-1)?.agents.length === 0 && snapshots(json).at(-1)?.endpoints.length === 0);
  check("an empty text roster says no participants", plain.out.includes("No participants in this observer snapshot."));

  const chat = cli("chat", ["chat", "--stdio", "--name", "ana", "general"]);
  check("positive control: the real chat CLI publishes endpoint presence", await until(() => snapshots(json).at(-1)?.endpoints.some((row) => row.name === "ana") === true, 20_000), chat.err);
  const who = cli("who", ["who", "--all", "--plain"]);
  check("positive control: who --all lists the chat session", await until(() => who.out.includes("ana")), who.err);
  check("plain roster updates when an endpoint joins", await until(() => /\bana\b.*\bendpoint\b.*\bidle\b/.test(plain.out)), plain.out);
  check("terminal roster includes the same endpoint", await until(() => /\bana\b.*\bendpoint\b.*\bidle\b/.test(clean(terminalOut))), clean(terminalOut));

  chat.child.stdin.write(`${JSON.stringify({ schemaVersion: 1, id: "status-1", type: "status", status: "working", activity: "roster-live-activity" })}\n`);
  check("positive control: JSON sees the chat status change", await until(() => snapshots(json).at(-1)?.endpoints.some((row) => row.name === "ana" && row.reportedStatus === "working") === true));
  check("plain roster updates endpoint state and qualifies unknown progress", await until(() => /\bana\b.*working - progress unknown.*roster-live-activity/.test(plain.out)), plain.out);
  check("terminal roster updates endpoint state and activity", await until(() => /\bana\b.*working - progress unknown.*roster-live-activity/.test(clean(terminalOut))), clean(terminalOut));

  const agent = new CotalEndpoint({ space, servers: server, consume: false, card: { name: "planner", kind: "agent", role: "reviewer" } });
  endpoints.push(agent);
  await agent.start();
  const service = new CotalEndpoint({ space, servers: server, consume: false, card: { name: "inventory", kind: "endpoint", role: "service" } });
  endpoints.push(service);
  await service.start();
  check("positive control: JSON carries mixed participants", await until(() => snapshots(json).at(-1)?.agents.some((row) => row.name === "planner") === true && snapshots(json).at(-1)?.endpoints.some((row) => row.name === "inventory") === true));
  check("plain roster retains agents alongside service and chat endpoints", await until(() => /planner.*agent.*reviewer/.test(plain.out) && /inventory.*endpoint.*service/.test(plain.out)), plain.out);

  const left = plain.out.length, terminalLeft = terminalOut.length;
  chat.child.stdin.end();
  check("chat CLI closes normally", await until(() => chat.child.exitCode !== null) && chat.child.exitCode === 0, chat.err);
  check("positive control: JSON observes chat departure", await until(() => snapshots(json).at(-1)?.endpoints.every((row) => row.name !== "ana" || row.reportedStatus === "offline") === true));
  check("plain roster reports the endpoint departure", await until(() => /ana.*offline/.test(plain.out.slice(left)) || (plain.out.slice(left).includes("inventory") && !plain.out.slice(left).includes("ana"))), plain.out.slice(left));
  check("terminal roster reports the endpoint departure", await until(() => /ana.*offline/.test(clean(terminalOut.slice(terminalLeft))) || (clean(terminalOut.slice(terminalLeft)).includes("inventory") && !clean(terminalOut.slice(terminalLeft)).includes("ana"))), clean(terminalOut.slice(terminalLeft)));

  terminal.write("q");
  check("leaving the terminal observer exits normally", await until(() => terminalExit !== undefined) && terminalExit === 0);
  check("leaving the observer does not stop the agent", Boolean((await agent.multicast("observer left", { channel: "general" })).id));
} finally {
  if (terminal && terminalExit === undefined) {
    terminal.kill();
    if (!await until(() => terminalExit !== undefined)) throw new Error("owned terminal did not exit");
  }
  writeFileSync(join(dir, "terminal.log"), terminalOut);
  for (const run of children) {
    await killAndAwaitExit(run.child);
    if (run.child.exitCode === null && run.child.signalCode === null) throw new Error(`owned ${run.name} did not exit`);
    writeFileSync(join(dir, `${run.name}.stdout`), run.out);
    writeFileSync(join(dir, `${run.name}.stderr`), run.err);
  }
  for (const endpoint of endpoints.reverse()) await endpoint.stop();
  await killAndAwaitExit(broker);
  release();
  console.log(`Retained observer evidence: ${dir}`);
}
finish();

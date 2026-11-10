/** A silent listener stays distinct from a closed port in every space report. Status shares its
 *  selected preflight instead of spending the confirm budget once per section.
 *  Run: pnpm smoke:broker-not-answering */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, freePort, listenOn } from "@cotal-ai/smoke-kit";
import { isReachable, probeConnect, probeReachability } from "@cotal-ai/core";

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
let greeting: "silent" | "tls" | "plaintext" = "silent";
let clearConnects = 0;
const listener = createServer((socket) => {
  dials++;
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  if (greeting !== "silent") socket.write(`INFO ${JSON.stringify({ server_id: "owned-fixture", version: "2.12.0", proto: 1, max_payload: 1048576, tls_required: greeting === "tls" })}\r\n`);
  socket.on("data", (chunk: Buffer) => { if (chunk.toString().includes("CONNECT ")) clearConnects++; });
  socket.resume();
});
const server = `nats://127.0.0.1:${await listenOn(listener, await freePort())}`;

async function run(args: string[], cwd = outside, timeoutMs = 60_000) {
  const start = Date.now();
  const before = dials;
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    return { code, signal, stdout, stderr, ms: Date.now() - start, dials: dials - before };
  } finally { clearTimeout(timer); }
}

try {
  check("a silent INFO read retains its timeout", await probeReachability(server, { timeoutMs: 40 }) === "slow-link");
  check("the boolean liveness API still returns false for silence", await isReachable(server, { timeoutMs: 40 }) === false);
  const concurrent = Promise.all([
    probeReachability(server, { tls: true, timeoutMs: 80 }),
    probeConnect(server, { tls: true, timeoutMs: 160 }),
  ]);
  const unrelated = createConnection({ host: "127.0.0.1", port: Number(new URL(server).port) });
  try {
    await once(unrelated, "connect");
    const [liveness, connection] = await concurrent;
    check("concurrent TLS probes retain their timeout classes", liveness === "slow-link" && !connection.ok && connection.reason === "timeout", { liveness, connection });
    await new Promise((resolve) => setTimeout(resolve, 100));
    check("TLS probes release their sockets without closing an unrelated connection", sockets.size === 1 && !unrelated.destroyed, { remaining: sockets.size });
  } finally { unrelated.destroy(); }
  greeting = "tls";
  const stalled = await probeConnect(server, { tls: true, timeoutMs: 100 });
  check("a stalled TLS upgrade remains a timeout", !stalled.ok && stalled.reason === "timeout", stalled);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check("a stalled TLS upgrade releases its pending socket", sockets.size === 0, { remaining: sockets.size });
  greeting = "plaintext";
  const downgrade = await probeConnect(server, { tls: true, token: "owned-test-token", timeoutMs: 100 });
  check("a forged plaintext greeting cannot satisfy required TLS", !downgrade.ok && downgrade.reason === "tls-unsupported", downgrade);
  check("a TLS refusal never sends CONNECT in plaintext", clearConnects === 0, { clearConnects });
  greeting = "silent";
  const added = await run(["space", "add", "silent", "--root", project, "--server", server, "--mode", "open", "--force", "--yes", "--json"]);
  check("the shipped registration entrypoint accepts an unchecked space", added.code === 0, added);
  const selected = await run(["use", "silent", "--json"]);
  check("the shipped selection entrypoint selects it", selected.code === 0, selected);

  // TLS-required reads must release their native dial, not just print the timeout verdict.
  const strict = await run(["space", "add", "strict", "--root", project, "--server", server, "--mode", "open", "--tls", "--force", "--yes", "--json"]);
  check("the shipped registration entrypoint records TLS intent", strict.code === 0, strict);
  for (const args of [["space", "show", "strict"], ["space"]]) {
    const read = await run([...args, "--json"], outside, 15_000);
    const result = JSON.parse(read.stdout).result;
    console.log(`  TLS read ${args.join(" ")}: ${JSON.stringify({ code: read.code, signal: read.signal, ms: read.ms, dials: read.dials })}`);
    check(`TLS: ${args.join(" ")} classifies silence and exits inside its budget`, read.code === 0 && read.signal === null && (result.items?.find((row: { space: string }) => row.space === "strict") ?? result).check === "slow-link", read);
    await new Promise((resolve) => setTimeout(resolve, 100));
    check(`TLS: ${args.join(" ")} releases every accepted socket without a forced exit`, read.code === 0 && sockets.size === 0, { remaining: sockets.size });
  }
  const removed = await run(["space", "forget", "strict", "--json"]);
  check("the TLS test registration is removed", removed.code === 0, removed);

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

  // Upgrade successfully, then withhold both NATS INFO and the WebSocket close reply.
  const wsSockets = new Set<Socket>();
  let upgrades = 0;
  let healthy = false;
  const websocket = createServer((socket) => {
    wsSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => wsSockets.delete(socket));
    let header = "";
    const handshake = (chunk: Buffer) => {
      header += chunk.toString();
      if (!header.includes("\r\n\r\n")) return;
      const key = /Sec-WebSocket-Key:\s*(.+)\r\n/i.exec(header)?.[1];
      if (!key) return;
      socket.off("data", handshake);
      upgrades++;
      const accept = createHash("sha1").update(key.trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      if (healthy) {
        const info = Buffer.from('INFO {"server_id":"owned-fixture","version":"2.12.0","proto":1,"max_payload":1048576}\r\n');
        socket.write(Buffer.concat([Buffer.from([0x82, info.length]), info]));
        socket.on("data", (frame: Buffer) => {
          if ((frame[0]! & 15) === 8) socket.end(Buffer.from([0x88, 0]));
          else socket.write(Buffer.from([0x82, 6, ...Buffer.from("PONG\r\n")]));
        });
      } else socket.resume();
    };
    socket.on("data", handshake);
  });
  const wsServer = `ws://127.0.0.1:${await listenOn(websocket, await freePort())}`;
  try {
    const registered = await run(["space", "add", "websocket", "--root", project, "--server", wsServer, "--mode", "open", "--force", "--yes", "--json"]);
    check("the shipped registration entrypoint accepts a WebSocket space", registered.code === 0, registered);
    for (const args of [["space", "show", "websocket"], ["status", "--space", "websocket"]]) {
      const before = upgrades;
      const read = await run([...args, "--json"], outside, 15_000);
      const result = read.code === 0 ? JSON.parse(read.stdout).result : undefined;
      console.log(`  WebSocket read ${args[0]}: ${JSON.stringify({ code: read.code, signal: read.signal, ms: read.ms, upgrades: upgrades - before })}`);
      check(`WebSocket: ${args[0]} times out without a close reply and exits`, read.code === 0 && (result.check ?? result.selected.connection) === "slow-link" && upgrades - before === 2, read);
      await new Promise((resolve) => setTimeout(resolve, 100));
      check(`WebSocket: ${args[0]} releases its upgraded sockets`, read.code === 0 && wsSockets.size === 0, { remaining: wsSockets.size });
    }
    healthy = true;
    const live = await run(["space", "show", "websocket", "--json"], outside, 15_000);
    check("a WebSocket peer answering NATS remains reachable", live.code === 0 && JSON.parse(live.stdout).result.check === "reachable", live);
  } finally {
    for (const socket of wsSockets) socket.destroy();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
  }
} finally {
  for (const socket of sockets) socket.destroy();
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
}
finish();

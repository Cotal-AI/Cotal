/**
 * After Cotal disables nats-core reconnect, teardown must CLOSE the connection, not drain it.
 *
 * nats-core 3.4.0 `drain()` flushes with a PING and waits for the matching PONG. It only rejects
 * that waiter inside reconnect `prepare()`. With reconnect=false, a half-open socket therefore
 * leaves drain pending until the 2-minute ping interval times out. That is the hang that cancelled
 * `smoke:opencode-events-release` in CI: the suite cut a TCP relay, the emitter logged
 * `stream CHAT_* info unavailable (timeout)`, and `stop()` then waited on drain forever.
 *
 * This suite is the named cell for that ordering. It starts a live endpoint, disables library
 * reconnect, cuts the socket without a TCP close, and asserts `stop()` returns well inside the
 * ping interval. Mutation-proved: restoring `drain()` in `closeWithoutLibraryReconnect` reds the
 * cell because the child never prints STOPPED.
 *
 * Run: pnpm smoke:reconnect-fence-close
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SELF = fileURLToPath(import.meta.url);
const STOP_BUDGET_MS = 8_000;

if (process.argv[2] === "stop-child") {
  const [, , , servers] = process.argv;
  if (!servers) throw new Error("stop child requires servers");
  const ep = new CotalEndpoint({
    space: "fenceclose",
    servers,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name: "fence-close-child", kind: "endpoint" },
  });
  await ep.start();
  const nc = (ep as unknown as { nc?: { protocol?: { options?: { reconnect?: boolean } } } }).nc;
  if (!nc) throw new Error("stop child started without a NATS connection");
  (ep as unknown as { disableLibraryReconnect: (c: unknown) => void }).disableLibraryReconnect(nc);
  if (nc.protocol?.options?.reconnect !== false) throw new Error("stop child failed to disable library reconnect");
  process.stdout.write("FENCED\n");
  process.stdin.resume();
  const cut = await Promise.race([
    new Promise<boolean>((resolve) => {
      process.stdin.on("data", (chunk) => {
        if (String(chunk).includes("CUT")) resolve(true);
      });
    }),
    wait(10_000).then(() => false),
  ]);
  if (!cut) throw new Error("stop child never received CUT");
  const started = Date.now();
  await ep.stop();
  process.stdout.write(`STOPPED ${Date.now() - started}\n`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.error(`  ✗ ${name}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
};

const PORT = await pickFreePort();
if (PORT === 4222) throw new Error("refusing to bind :4222 (shared with the workstation broker)");
const dir = mkdtempSync(join("/var/tmp", SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const servers = `nats://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 50; i++) { if (await isReachable(servers)) { up = true; break; } await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const relayPort = await pickFreePort();
let cut = false;
const relaySockets: Socket[] = [];
const relay = createNetServer((client) => {
  const upSock = netConnect(PORT, "127.0.0.1");
  relaySockets.push(client, upSock);
  client.on("data", (d) => { if (!cut) upSock.write(d); });
  upSock.on("data", (d) => { if (!cut) client.write(d); });
  const bye = (): void => { client.destroy(); upSock.destroy(); };
  for (const sock of [client, upSock]) { sock.on("error", () => {}); }
  client.on("close", bye);
  upSock.on("close", bye);
});
relay.listen(relayPort, "127.0.0.1");
await once(relay, "listening");

let child: ReturnType<typeof spawn> | undefined;
try {
  child = spawn(process.execPath, ["--import", "tsx", SELF, "stop-child", `nats://127.0.0.1:${relayPort}`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const fenced = await Promise.race([
    new Promise<boolean>((resolve) => {
      const tick = (): void => {
        if (output.includes("FENCED")) resolve(true);
        else setTimeout(tick, 50);
      };
      tick();
    }),
    wait(10_000).then(() => false),
  ]);
  check("the child armed the reconnect fence on a live connection", fenced, output.slice(-400));
  cut = true;
  child.stdin?.write("CUT\n");
  const done = await Promise.race([
    new Promise<number | null>((resolve) => child!.once("exit", (code) => resolve(code))),
    wait(STOP_BUDGET_MS).then(() => "timeout" as const),
  ]);
  if (done === "timeout") child.kill("SIGKILL");
  const stopped = output.split("\n").find((line) => line.startsWith("STOPPED "));
  const stopMs = stopped ? Number(stopped.slice("STOPPED ".length)) : NaN;
  check(
    "stop() after a reconnect-disable on a half-open socket returns without waiting for a drain PONG",
    done === 0 && Number.isFinite(stopMs) && stopMs < STOP_BUDGET_MS,
    { done, stopMs, output: output.slice(-400) },
  );
} finally {
  child?.kill("SIGKILL");
  relay.close();
  for (const sock of relaySockets) sock.destroy();
  broker.kill("SIGKILL");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

console.log(
  fail === 0
    ? `\nRECONNECT-FENCE-CLOSE SMOKE PASSED ✅  (${pass} checks)`
    : `\nRECONNECT-FENCE-CLOSE SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);

/** Broker URL syntax, transport and access mode through the shipped CLI on owned brokers. */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable, seedChannelRegistry, setupSpaceStreams } from "@cotal-ai/core";
import { awaitBrokerReady, createSuite, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { recordMesh, spaceSegment } from "@cotal-ai/workspace";

const BIN = join(import.meta.dirname, "../../../bin/dist/cotal.js");
if (!existsSync(BIN)) throw new Error("build the shipped CLI first: pnpm --filter cotal-ai... build");
const { check, finish } = createSuite();
const scratch = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(scratch, "home");
const root = join(scratch, "project");
mkdirSync(home, { mode: 0o700 });
mkdirSync(root, { mode: 0o700 });
mkdirSync(join(root, ".cotal"), { mode: 0o700 });
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const env = { ...cleanEnv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
const port = await freePort();
const wsPort = await freePort();
const server = `nats://127.0.0.1:${port}`;
const wsAddress = `ws://127.0.0.1:${wsPort}`;
const wsServer = `${wsAddress}/mesh-ws`;
async function withBroker(websocket: boolean, runChecks: () => Promise<void>, auth = false): Promise<void> {
  const tcpPort = websocket ? port : wsPort;
  const config = join(scratch, websocket ? "websocket.conf" : "native.conf");
  const listener = websocket ? `websocket { host: 127.0.0.1, port: ${wsPort}, no_tls: true }\n` : "";
  const access = auth ? "authorization { user: fixture, password: fixture }\n" : "";
  const store = join(scratch, auth ? "auth-js" : "js");
  writeFileSync(config, `host: 127.0.0.1\nport: ${tcpPort}\njetstream { store_dir: ${JSON.stringify(store)} }\n${listener}${access}`);
  const broker = spawn("nats-server", ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
  const releaseBroker = teardownOnSignal(broker);
  let brokerOutput = "";
  broker.stderr!.on("data", (chunk: Buffer) => { brokerOutput += chunk.toString(); });
  try {
    const readyAt = `nats://127.0.0.1:${tcpPort}`;
    await awaitBrokerReady(() => isReachable(readyAt), { servers: readyAt, attempts: 50, delayMs: 100, output: () => brokerOutput });
    await runChecks();
  } finally {
    await killAndAwaitExit(broker);
    releaseBroker();
  }
}
type Reply = { status: number; stdout: string; stderr: string; envelope?: { outcome?: string; error?: { code?: string; message?: string; remedy?: string }; result?: unknown } };
const run = (args: string[]): Promise<Reply> => new Promise((resolve, reject) => {
  execFile(process.execPath, [BIN, ...args], { cwd: root, env, timeout: 30_000 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") { reject(error); return; }
    const envelope = stdout.trim().startsWith("{") ? JSON.parse(stdout) as Reply["envelope"] : undefined;
    resolve({ status: error && typeof error.code === "number" ? error.code : 0, stdout, stderr, envelope });
  });
});
const commands = (url: string, space: string, text: string) => [
  ["send", "-c", "general", text, "--server", url, "--space", space, "--json"],
  ["history", "general", "--limit", "100", "--server", url, "--space", space, "--json"],
  ["who", "--server", url, "--space", space, "--json"],
];
const addOpen = (space: string, url: string) => ["space", "add", space, "--server", url, "--root", root, "--mode", "open", "--json"];
const wsRegistration = addOpen("websocket", wsAddress);
await withBroker(true, async () => {
  for (const space of ["registered", "raw"]) {
    await setupSpaceStreams({ servers: server, space });
    await seedChannelRegistry({ servers: server, space, file: { channels: { general: {} } } });
  }
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = env.COTAL_HOME;
  try { recordMesh({ space: "registered", server, root, mode: "open", origin: "manual", ts: new Date().toISOString() }); }
  finally { if (priorHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = priorHome; }

  for (const space of ["registered", "raw"]) {
    for (const url of [server, server.replace("127.0.0.1", "localhost"), server.replace("nats:", "NATS:"), wsServer]) {
      const text = `control-${space}-${url}`;
      for (const args of commands(url, space, text)) {
        const reply = await run(args);
        check(`${space}: ${args[0]} accepts ${url}`, reply.status === 0 && reply.envelope?.outcome === "ok", reply);
        if (args[0] === "history") check(`${space}: history reads the control post`, reply.stdout.includes(text), reply);
      }
    }
    const invalid = [
      "https://127.0.0.1:" + port,
      "http://127.0.0.1:" + port,
      "tcp://127.0.0.1:" + port,
      "127.0.0.1:" + port,
      `${server}/path?x=1`,
      `${server}/path`,
      `${server}?x=1`,
      `${server}#fragment`,
      "",
    ];
    for (const [index, url] of invalid.entries()) {
      for (const args of commands(url, space, `refused-${space}-${index}`)) {
        const reply = await run(args);
        check(`${space}: ${args[0]} refuses invalid URL ${index} before connecting`, reply.status === 1 && reply.envelope?.error?.code === "USAGE_INVALID", reply);
      }
    }
    for (const url of [server.replace("nats:", "tls:"), server.replace("nats://127.0.0.1", "tls://localhost")]) {
      for (const args of commands(url, space, `refused-${space}-tls`)) {
        const reply = await run(args);
        check(`${space}: ${args[0]} requires TLS at ${url} instead of using plaintext`, reply.status === 2 && reply.envelope?.outcome === "refused" && ["DEPENDENCY_UNAVAILABLE", "TARGET_UNAVAILABLE"].includes(reply.envelope.error?.code ?? ""), reply);
      }
    }
    const history = await run(["history", "general", "--server", server, "--space", space, "--json", "--limit", "100"]);
    check(`${space}: refused sends stored no posts`, history.status === 0 && !history.stdout.includes(`refused-${space}-`), history);
  }
  const registration = await run(["space", "add", "bad-url-control", "--server", server.replace("nats:", "https:"), "--root", root, "--json"]);
  check("positive control: registration already refuses https", registration.status === 1 && registration.envelope?.error?.code === "USAGE_INVALID", registration);
  const creds = await run(["who", "--server", server.replace("nats:", "https:"), "--creds", join(scratch, "must-not-read.creds"), "--json"]);
  check("explicit credentials: invalid server refuses before reading a credential", creds.status === 1 && creds.envelope?.error?.code === "USAGE_INVALID", creds);
  await setupSpaceStreams({ servers: server, space: "websocket" });
  const registered = await run(wsRegistration);
  check("register an open space through its WebSocket listener", registered.status === 0 && registered.envelope?.outcome === "ok", registered);
  const checked = await run(addOpen("raw", server));
  check("register a checked open space on the native listener", checked.status === 0 && checked.envelope?.outcome === "ok", checked);
});

const registrationFile = join(env.COTAL_HOME, "meshes", `${spaceSegment("websocket")}.json`);
const snapshot = (file = registrationFile) => {
  const { ino, mtimeNs } = statSync(file, { bigint: true });
  return [ino, mtimeNs, readFileSync(file, "utf8")].join("\n");
};
const before = snapshot();
const offline = await run(wsRegistration);
check("an offline recheck keeps the recorded port and does not offer force",
  offline.status === 2 && offline.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
  offline.envelope.error.remedy === `check that the mesh is up and listening on port ${wsPort} of 127.0.0.1, then retry` &&
  snapshot() === before, offline);
await withBroker(false, async () => {
  const tcpAddress = `nats://127.0.0.1:${wsPort}`;
  const recheck = await run(wsRegistration);
  check("an existing WebSocket registration diagnoses the native listener and asks to restore the recorded transport",
    recheck.status === 2 && recheck.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
    recheck.envelope.error.message?.includes(`one answers at ${tcpAddress}`) === true &&
    recheck.envelope.error.remedy === `restore the broker listener at ${wsAddress} with its recorded transport, then rerun the check unchanged`, recheck);
  const changed = await run(addOpen("websocket", tcpAddress));
  check("the alternate transport still conflicts and leaves the checked registration alone",
    changed.status === 2 && changed.envelope?.error?.code === "CONFLICT" && snapshot() === before, changed);
  const fresh = await run(addOpen("fresh", wsAddress));
  check("an unregistered name still gets the alternate address and force advice",
    fresh.status === 2 && fresh.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
    fresh.envelope.error.remedy?.startsWith(`run it again with --server ${tcpAddress}`) === true &&
    fresh.envelope.error.remedy.includes("pass --force"), fresh);
});
await withBroker(true, async () => {
  const restored = await run(wsRegistration);
  check("restoring the recorded transport lets the unchanged recheck succeed without rewriting the record",
    restored.status === 0 && restored.envelope?.outcome === "no-op" && snapshot() === before, restored);
});
const nativeFile = join(env.COTAL_HOME, "meshes", `${spaceSegment("raw")}.json`);
const beforeModeDrift = snapshot(nativeFile);
await withBroker(true, async () => {
  const recheck = await run(addOpen("raw", server));
  const error = recheck.envelope?.error;
  check("an auth listener at the recorded open address asks to restore the recorded mode without rewriting the record",
    recheck.status === 2 && error?.code === "CONFLICT" && error.message?.includes('requires auth, but "raw" is registered in open mode') === true &&
    error.remedy === `restore the broker at ${server} to its recorded open mode, then rerun the check unchanged` &&
    !/signing seed|--mode auth/.test(recheck.stdout) && snapshot(nativeFile) === beforeModeDrift, recheck);
  const fresh = await run(addOpen("fresh", server));
  check("an unregistered name still gets fresh-add auth guidance",
    fresh.status === 2 && fresh.envelope?.error?.code === "CONFLICT" && fresh.envelope.error.message?.includes("account + creds") === true, fresh);
}, true);
await withBroker(true, async () => {
  const restored = await run(addOpen("raw", server));
  check("restoring the recorded mode lets the unchanged recheck succeed without rewriting the record",
    restored.status === 0 && restored.envelope?.outcome === "no-op" && snapshot(nativeFile) === beforeModeDrift, restored);
});
finish();

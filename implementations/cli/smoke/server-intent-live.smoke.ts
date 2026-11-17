/** Broker URL syntax and transport intent through the shipped CLI on owned open brokers. */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable, seedChannelRegistry, setupSpaceStreams } from "@cotal-ai/core";
import { awaitBrokerReady, createSuite, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { recordMesh } from "@cotal-ai/workspace";

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
const wsServer = `ws://127.0.0.1:${wsPort}/mesh-ws`;
const config = join(scratch, "server.conf");
writeFileSync(config, `host: 127.0.0.1\nport: ${port}\njetstream { store_dir: ${JSON.stringify(join(scratch, "js"))} }\nwebsocket { host: 127.0.0.1, port: ${wsPort}, no_tls: true }\n`);
const broker = spawn("nats-server", ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
const releaseBroker = teardownOnSignal(broker);
let brokerOutput = "";
broker.stderr!.on("data", (chunk: Buffer) => { brokerOutput += chunk.toString(); });
type Reply = { status: number; stdout: string; stderr: string; envelope?: { outcome?: string; error?: { code?: string; message?: string }; result?: unknown } };
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
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100, output: () => brokerOutput });
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
} finally {
  await killAndAwaitExit(broker);
  releaseBroker();
}
finish();

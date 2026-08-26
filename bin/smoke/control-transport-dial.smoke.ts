/**
 * The CLI control family selects the transport from the resolved broker URL (#855).
 *
 * A real authenticated nats-server exposes the same account over nats:// and ws://, and the real CLI
 * runs as a subprocess from a sandboxed COTAL_HOME. No manager runs: a successful dial reaches the
 * ep-rails deadline, while the defect fails before that with the node transport's `wsconnect` refusal.
 * The websocket cells discriminate on the pre-fix node-transport refusal naming `wsconnect`; the TCP
 * cells are negative controls proving transport selection did not regress ordinary NATS dials.
 */
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const awaitExit = (child: ChildProcess, ms = 5_000): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, ms).unref?.();
  });

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}${extra === undefined ? "" : ` - ${JSON.stringify(extra)}`}`);
  }
};
const must = (name: string, condition: boolean, extra?: unknown): void => {
  if (!condition) throw new Error(`FAIL (rig): ${name}${extra === undefined ? "" : ` - ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];

const home = mkdtempSync(join(tmpdir(), "cotal-control-dial-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-control-dial-root-"));
const tcpPort = await freePort();
const wsPort = await freePort();
const tcpServer = `nats://127.0.0.1:${tcpPort}`;
const wsServer = `ws://127.0.0.1:${wsPort}`;
const space = "controldial";
const cli = join(import.meta.dirname, "..", "cotal.ts");
const kids: ChildProcess[] = [];

const {
  createSpaceAuth,
  mintCreds,
  newIdentity,
  probeConnect,
  serverConfig,
  setupSpaceStreams,
} = await import("@cotal-ai/core");
const { authDir, recordMesh, saveSpaceAuth } = await import("@cotal-ai/workspace");

const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(root), auth);
const conf = join(root, "server.conf");
writeFileSync(
  conf,
  serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: tcpPort,
    host: "127.0.0.1",
    wsPort,
    wsHost: "127.0.0.1",
    storeDir: join(root, "js"),
  }),
);

const runCli = (args: string[], timeout = 60_000) => {
  const result = spawnSync("npx", ["tsx", cli, ...args], {
    cwd: root,
    env: { ...cleanEnv, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" },
    encoding: "utf8",
    timeout,
  });
  return {
    status: result.status,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, ""),
  };
};
const reachedRails = (result: { status: number | null; out: string }): boolean =>
  result.status !== 0 && /no manager reachable on the ep rails|no manager service is registered|service "manager" has no live registered instances/.test(result.out) &&
  !/wsconnect|websocket connections must use/i.test(result.out);

try {
  const broker = spawnProc("nats-server", ["-c", conf], { stdio: "ignore" });
  kids.push(broker);
  let serving = false;
  for (let i = 0; i < 80; i++) {
    const probe = await probeConnect(tcpServer, { timeoutMs: 400 });
    if (probe.ok || ("reason" in probe && probe.reason === "auth-required")) { serving = true; break; }
    await sleep(100);
  }
  must("the authenticated broker is serving its TCP listener", serving, tcpServer);
  await setupSpaceStreams({ servers: tcpServer, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  recordMesh({ space, server: wsServer, root, mode: "auth", ts: new Date().toISOString() });

  const wsModels = runCli(["models", "--space", space]);
  ok(
    "A: models reaches the manager over ws:// through askManagerEp",
    reachedRails(wsModels),
    wsModels,
  );

  const wsPs = runCli(["ps", "--space", space]);
  ok(
    "B: ps reaches the manager over ws:// through the scatter connection",
    reachedRails(wsPs),
    wsPs,
  );

  recordMesh({ space, server: tcpServer, root, mode: "auth", ts: new Date().toISOString() });
  const tcpModels = runCli(["models", "--space", space]);
  ok("C: models still reaches the ep rails over nats://", reachedRails(tcpModels), tcpModels);
  const tcpPs = runCli(["ps", "--space", space]);
  ok("D: ps still reaches the ep rails over nats://", reachedRails(tcpPs), tcpPs);

  console.log(`\ncontrol transport dial: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
} finally {
  await Promise.all(kids.map(async (child) => { if (child.exitCode === null) child.kill("SIGKILL"); await awaitExit(child); }));
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

/**
 * `cotal supervise` against a REGISTERED REMOTE mesh selects its transport from the recorded
 * broker URL.
 *
 * A registry entry for a user-auth mesh may hold a `ws://`/`wss://` server, because a remote broker
 * is published through an HTTPS edge. The supervisor's first dial is the remote manager-authority
 * registration, and the raw node transport refuses such a URL outright with the refusal that names
 * `wsconnect` — so supervision stopped before the manager was ever constructed.
 *
 * One authenticated nats-server exposes the same account over both listeners. The websocket cells
 * discriminate on that pre-fix refusal; the TCP cells are negative controls proving the transport
 * selection did not regress ordinary NATS dials. The registered server is read back through
 * `superviseTarget`, so the URL under test is the one the shipped command actually hands to the
 * registration, not one the suite chose.
 *
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/supervise-remote-dial.json
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
const fixtureId = randomUUID().replaceAll("-", "");
const home = mkdtempSync(join(tmpdir(), `cotal-supervise-dial-home-${fixtureId}-`));
const releaseHome = teardownPathOnSignal(home);
process.env.COTAL_HOME = home;
const xdg = join(home, "xdg");
mkdirSync(xdg);
process.env.XDG_CONFIG_HOME = xdg;
const root = mkdtempSync(join(tmpdir(), `cotal-supervise-dial-root-${fixtureId}-`));
const releaseRoot = teardownPathOnSignal(root);
// The JetStream store gets its own tokened dir rather than living under `root`, because the reaper
// claims a lost broker by that prefix.
const brokerStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-dial-js-${fixtureId}-`));
const releaseBrokerStore = teardownPathOnSignal(brokerStore);
const tcpPort = await freePort();
const wsPort = await freePort();
const tcpServer = `nats://127.0.0.1:${tcpPort}`;
const wsServer = `ws://127.0.0.1:${wsPort}`;
const space = "supervisedial";
const kids: ChildProcess[] = [];

const { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity, probeConnect, remoteManagerActors, serverConfig, setupSpaceStreams } =
  await import("@cotal-ai/core");
const { authDir, recordMesh, saveSpaceAuth } = await import("@cotal-ai/workspace");
const { MANAGER_ENDPOINT } = await import("../../implementations/manager/src/manager-service-contract.js");
const { registerRemoteManagerAuthority } = await import("../../implementations/manager/src/remote-register.js");
const { superviseTarget } = await import("../../implementations/manager/src/commands.js");
const { runWorkflow } = await import("../../implementations/runtime/src/run-command.js");

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
    storeDir: brokerStore,
  }),
);

/** Run the registration half the supervisor runs, over the target it resolved, as one line. */
const drive = async (target: { server: string; tlsRequired: boolean }): Promise<string> => {
  const instanceId = mintLifecycleUid();
  const prepareCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId },
  });
  try {
    const registered = await registerRemoteManagerAuthority({
      space,
      server: target.server,
      owner: "local",
      instanceId,
      serveActor: remoteManagerActors(instanceId).serve,
      prepareCreds,
      tlsRequired: target.tlsRequired,
    });
    return `registered epoch=${registered.processEpoch} revision=${registered.registrationRevision}`;
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
};
const registered = (line: string): boolean => line.startsWith("registered ") && !/wsconnect|websocket/i.test(line);

/** `cotal run ps --local` over the resolved mesh, as the one line the shipped verb printed — or as
 *  its refusal. The verb opens its own planes on the registry-resolved server, so this drives the
 *  same registry URL through a second command's dial. */
const runPs = async (): Promise<string> => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]): void => void printed.push(parts.map(String).join(" "));
  try {
    await runWorkflow({ values: { local: true }, positionals: ["ps"], raw: ["run", "ps", "--local"] });
    return printed.join("\n");
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  } finally {
    console.log = log;
  }
};

let releaseBroker: (() => void) | undefined;
/** Kill the broker and remove every artifact this suite made. Idempotent: cell D asserts on it
 *  where the banner can still count the verdict, and the `finally` repeats it for the paths that
 *  never reach the cell. */
let tornDown = false;
const teardown = async (): Promise<void> => {
  if (tornDown) return;
  tornDown = true;
  process.chdir(tmpdir());
  await Promise.all(kids.map(async (child) => { if (child.exitCode === null) child.kill("SIGKILL"); await awaitExit(child); }));
  rmSync(brokerStore, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
};
try {
  const broker = spawnProc("nats-server", ["-c", conf], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, brokerStore);
  kids.push(broker);
  let serving = false;
  for (let i = 0; i < 80; i++) {
    const probe = await probeConnect(tcpServer, { timeoutMs: 400 });
    if (probe.ok || ("reason" in probe && probe.reason === "auth-required")) { serving = true; break; }
    await sleep(100);
  }
  must("the authenticated broker is serving its TCP listener", serving, tcpServer);
  // `setupSpaceStreams` also runs `createEndpointStreams`, so the records + endpoint-auth buckets and
  // the contract store the registration writes into exist before either cell dials.
  await setupSpaceStreams({ servers: tcpServer, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // A registered remote user-auth mesh whose broker is published over websocket. `root` holds no
  // user-auth marker, so this machine is a PARTICIPANT: exactly the case supervise routes through
  // the remote manager-authority registration.
  const userAuth = {
    provider: "cotal",
    idp: { url: "https://idp.invalid", issuer: "https://idp.invalid", audience: "cotal" },
    endpoints: { url: "https://exchange.invalid" },
    remote: true as const,
  };
  process.chdir(root);
  recordMesh({ space, server: wsServer, root, mode: "user", userAuth, ts: new Date().toISOString() });

  const wsTarget = superviseTarget({});
  must("the supervisor resolves the registered websocket broker as a remote-user target", wsTarget.remoteUser === true && wsTarget.server === wsServer, wsTarget);

  const wsLine = await drive(wsTarget);
  ok("A: the remote manager-authority registration completes over the recorded ws:// broker", registered(wsLine), wsLine);

  recordMesh({ space, server: tcpServer, root, mode: "user", userAuth, ts: new Date().toISOString() });
  const tcpTarget = superviseTarget({});
  must("the supervisor resolves the registered TCP broker as a remote-user target", tcpTarget.remoteUser === true && tcpTarget.server === tcpServer, tcpTarget);
  const tcpLine = await drive(tcpTarget);
  ok("B: the same registration still completes over a nats:// broker", registered(tcpLine), tcpLine);

  // The record is the only authority on whether the broker requires TLS. Re-record the SAME
  // plaintext broker as TLS-required: the registration must now demand TLS and be turned away by a
  // server that offers none. A dial that hardcodes `tls: false` connects anyway and sends the
  // prepare credential in the clear, which is what this cell exists to catch.
  recordMesh({ space, server: tcpServer, root, mode: "user", userAuth, tlsRequired: true, ts: new Date().toISOString() });
  const tlsTarget = superviseTarget({});
  must("the supervisor carries tlsRequired from the mesh record", tlsTarget.tlsRequired === true, tlsTarget);
  const tlsLine = await drive(tlsTarget);
  ok("C: a TLS-required record makes the registration demand TLS of the broker", /refused: .*tls/i.test(tlsLine), tlsLine);

  // The supervisor is not the only command handed a registry server URL: `cotal run --local` opens
  // its planes on the same resolved server, so a ws:// record reaches that dial too and the raw
  // node transport refuses it there for the same reason. A run's credentials are minted by the
  // space signer, which a client of a user-auth mesh does not hold, so this leg records the same
  // websocket broker as a STATIC mesh - the mode `cotal run` is reachable on at all.
  recordMesh({ space, server: wsServer, root, mode: "auth", ts: new Date().toISOString() });
  const runLine = await runPs();
  ok("E: `cotal run ps --local` opens its run planes over the recorded ws:// broker", runLine === `no workflow runs recorded in space ${space}`, runLine);

  await teardown();
  const remainingArtifacts = [brokerStore, root, home, xdg].filter((path) => existsSync(path)).length;
  ok("D: broker store, project root, COTAL_HOME, and XDG artifacts remaining after teardown = 0", remainingArtifacts === 0, remainingArtifacts);
  console.log(`\nsupervise remote dial: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
} finally {
  await teardown();
  releaseHome?.();
  releaseRoot?.();
  releaseBrokerStore();
  releaseBroker?.(); // last: ownership is held until this teardown has actually finished
}

/**
 * A tmux manager hosts one explicitly selected pty seat, attaches to it, and restarts it on pty.
 *
 * Live: a JWT-auth scratch broker, the real Manager started on tmux, and a stub that joins presence
 * and echoes its terminal. The seat names runtime pty, so dispatch is not the manager's tmux. A
 * console session reaches that pty and reads its echo. SIGKILL is the crash. The same lifecycle
 * comes back on a pty handle, and the persisted record stays runtime pty. A supervise request for
 * tmux is refused before launch and starts no window.
 *
 * Run: pnpm --filter @cotal-ai/manager exec tsx smoke/per-deployment-lifecycle.smoke.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credsAuthenticator, wsconnect } from "@nats-io/nats-core";
import {
  createSpaceAuth, decodeTerminalFrame, encodeTerminalData, isReachable, mintCreds, newIdentity, openSessionRail,
  registry, serverConfig, setupSpaceStreams, terminalFrameBytes,
  type Connector, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";
import "@cotal-ai/tmux";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { pickFreePort } from "./_free-port.js";

const here = dirname(fileURLToPath(import.meta.url));
const STUB = JSON.stringify(join(here, "e2e-stub.mjs"));
const space = `life-${randomUUID().slice(0, 8)}`;
const session = `cotal-${space}`;
const auth = await createSpaceAuth(space);
const brokerPort = await pickFreePort();
const wsPort = await pickFreePort();
const servers = `nats://127.0.0.1:${brokerPort}`;
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(brokerDir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: brokerPort, storeDir: join(brokerDir, "js"), host: "127.0.0.1", wsPort, wsHost: "127.0.0.1",
}));
const broker = spawn("nats-server", ["-c", join(brokerDir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, brokerDir);
const root = mkdtempSync(join(tmpdir(), "cotal-per-deployment-life-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(root), auth);
writeFileSync(join(root, ".cotal", "agents", "pty-seat.md"), "---\nname: pty-seat\nrole: worker\n---\n");

const connector: Connector = {
  kind: "connector",
  name: "per-deployment-life",
  requires: ["node"],
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env = launchEnv();
    return {
      command: "node",
      args: ["-e", `process.stdin.pipe(process.stdout); await import(${STUB});`],
      env: {
        ...env,
        COTAL_SPACE: opts.space,
        COTAL_SERVERS: String(opts.servers ?? servers),
        COTAL_CREDS: String(opts.creds),
        COTAL_ID: String(opts.id),
        COTAL_NAME: opts.name,
        COTAL_LIFECYCLE_UID: String(opts.lifecycleUid),
        PATH: env.PATH ?? process.env.PATH ?? "",
      },
    };
  },
};
registry.register(connector);

let failed = 0;
const check = (label: string, condition: boolean, detail?: unknown): void => {
  console.log(`${condition ? "ok" : "FAIL"} ${label}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!condition) failed++;
};
const reply = (value: { ok: boolean; error?: string; data?: unknown }) =>
  ({ ok: value.ok, error: value.error, data: value.data });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Row = {
  id: string;
  lifecycleUid: string;
  handle: { kind: string; pid?: number; status(): string; stop(opts?: { graceful?: boolean }): void };
  launch: { runtime: string };
  restart?: { recovering: boolean };
};

const manager = new Manager({ space, servers, runtime: "tmux", workspaceRoot: root, wsPort, consolePort: 0 });
const rows = (manager as unknown as { agents: Map<string, Row> }).agents;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let name = "";
for (let i = 0; i < 25 && broker.exitCode === null && !await isReachable(servers); i++) await wait(200);
if (broker.exitCode !== null || !await isReachable(servers)) throw new Error(`nats-server did not come up on ${brokerPort}`);
try {
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspaceSecretStore(root).identity });
  await manager.start();

  const tmuxSeat = await manager.startAgent({
    name: "pty-seat", agent: connector.name, identity: "tmux-policy", runtime: "tmux",
    supervise: { restarts: 1, windowMs: 60_000 }, events: false,
  });
  check("tmux supervise is refused before launch", tmuxSeat.ok === false && /runtime "tmux" cannot respawn a name in place/.test(tmuxSeat.error ?? ""), reply(tmuxSeat));
  let windows = "";
  try { windows = execFileSync("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { encoding: "utf8" }); } catch { windows = ""; }
  check("the refused tmux seat starts no window", !windows.split("\n").includes("pty-seat"), windows.trim());

  const started = await manager.startAgent({
    name: "pty-seat", agent: connector.name, runtime: "pty",
    supervise: { restarts: 1, windowMs: 60_000 }, events: false,
  });
  if (started.ok) name = String((started.data as { name: string }).name);
  const row = rows.get(name);
  check("the explicit pty seat starts under the tmux manager", started.ok === true && (started.data as { mode?: string }).mode === "pty", reply(started));
  check("the manager runtime stays tmux", manager.runtimeKind === "tmux", manager.runtimeKind);
  check("the live handle is pty", row?.handle.kind === "pty" && row.handle.status() === "running", row?.handle.kind);
  const recordPath = join(root, ".cotal", "seat-records", space, "pty-seat.json");
  const before = JSON.parse(readFileSync(recordPath, "utf8")) as { agent?: { launch?: { runtime?: string } } };
  check("the persisted seat keeps runtime pty", before.agent?.launch?.runtime === "pty", before.agent?.launch);

  const consoleUrl = new URL(manager.consoleUrl);
  const token = new URLSearchParams(consoleUrl.hash.replace(/^#/, "")).get("t") ?? "";
  const established = await (await fetch(`${consoleUrl.origin}/session/${name}?t=${token}`, { method: "POST" })).json() as { grant: { subjects: { in: string } }; wsUrl: string; creds: string };
  const nc = await wsconnect({ servers: established.wsUrl, authenticator: credsAuthenticator(new TextEncoder().encode(established.creds)) });
  const received: Buffer[] = [];
  const rail = openSessionRail({
    nc, grant: established.grant as never, role: "caller",
    onData: (data) => {
      const frame = decodeTerminalFrame(data);
      if (frame.k === "data") received.push(Buffer.from(terminalFrameBytes(frame)));
    },
  });
  await nc.flush();
  rail.send({ k: "ready" });
  rail.send(encodeTerminalData(new TextEncoder().encode("PTYMARK\n")));
  const until = Date.now() + 5_000;
  while (!Buffer.concat(received).toString("utf8").includes("PTYMARK") && Date.now() < until) await wait(50);
  check("the console attaches to the explicit pty and reads its echo", Buffer.concat(received).toString("utf8").includes("PTYMARK"), Buffer.concat(received).toString("utf8").slice(-80));
  rail.close();
  await nc.close();

  const firstPid = row?.handle.pid;
  const firstId = row?.id;
  const firstUid = row?.lifecycleUid;
  if (typeof firstPid === "number") process.kill(firstPid, "SIGKILL");
  const deadline = Date.now() + 20_000;
  let after = rows.get(name);
  while ((after?.handle.pid === undefined || after.handle.pid === firstPid || after.restart?.recovering !== false) && Date.now() < deadline) {
    await wait(100);
    after = rows.get(name);
  }
  check("the same lifecycle restarts on pty", after !== undefined && after.id === firstId && after.lifecycleUid === firstUid && after.handle.kind === "pty" && after.handle.pid !== firstPid && after.launch.runtime === "pty", { firstPid, next: after?.handle.pid, kind: after?.handle.kind, runtime: after?.launch.runtime });
  const persisted = JSON.parse(readFileSync(recordPath, "utf8")) as { agent?: { launch?: { runtime?: string } } };
  check("the restarted record stays runtime pty", persisted.agent?.launch?.runtime === "pty", persisted.agent?.launch);
  try { windows = execFileSync("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { encoding: "utf8" }); } catch { windows = ""; }
  check("pty recovery creates no tmux window", !windows.split("\n").includes("pty-seat"), windows.trim());
} finally {
  try { rows.get(name)?.handle.stop({ graceful: false }); } catch { /* already gone */ }
  try { await manager.stop(); } catch { /* not started */ }
  try { await delivery?.stop(); } catch { /* not started */ }
  try { execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" }); } catch { /* no session */ }
  broker.kill("SIGTERM");
  await wait(200);
  rmSync(brokerDir, { recursive: true, force: true });
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("per-deployment lifecycle smoke passed");

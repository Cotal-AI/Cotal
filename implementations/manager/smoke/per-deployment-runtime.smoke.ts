/**
 * One manager hosts a pty seat and a tmux seat at the same time.
 *
 * Live: a JWT-auth scratch broker, the real Manager started on pty, and a stub that joins presence.
 * One spawn names no runtime and lands on pty. A second names tmux and lands in a tmux window. Both
 * stay running, the manager's own runtime stays pty, and stopping each seat closes only that seat.
 * An unknown runtime refuses and starts nothing.
 *
 * Run: pnpm --filter @cotal-ai/manager exec tsx smoke/per-deployment-runtime.smoke.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSpaceAuth, registry, setupSpaceStreams, mintCreds, newIdentity,
  type Connector, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import "@cotal-ai/tmux";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, "e2e-stub.mjs");
const space = `rt-${randomUUID().slice(0, 8)}`;
const session = `cotal-${space}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const root = mkdtempSync(join(tmpdir(), "cotal-per-deployment-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(root), auth);
for (const name of ["pty-seat", "tmux-seat", "missing-seat"]) {
  writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\n---\n`);
}

const connector: Connector = {
  kind: "connector",
  name: "per-deployment-smoke",
  requires: ["node"],
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    return {
      command: "node",
      args: [STUB],
      env: {
        COTAL_SPACE: opts.space,
        COTAL_SERVERS: String(opts.servers ?? broker.servers),
        COTAL_CREDS: String(opts.creds),
        COTAL_ID: String(opts.id),
        COTAL_NAME: opts.name,
        COTAL_LIFECYCLE_UID: String(opts.lifecycleUid),
        PATH: process.env.PATH ?? "",
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

const manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot: root });
const started: string[] = [];
const rows = (manager as unknown as { agents: Map<string, { handle: { kind: string; status(): string; stop(opts?: { graceful?: boolean }): void } }> }).agents;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(root).identity });
  await manager.start();

  const omitted = await manager.startAgent({ name: "pty-seat", agent: connector.name, events: false });
  const named = await manager.startAgent({ name: "tmux-seat", agent: connector.name, runtime: "tmux", events: false });
  const unknown = await manager.startAgent({ name: "missing-seat", agent: connector.name, runtime: "not-a-runtime", events: false });
  const automatic = await manager.startAgent({ name: "pty-seat", agent: connector.name, identity: "auto-seat", runtime: "auto", events: false });
  if (omitted.ok) started.push(String((omitted.data as { name: string }).name));
  if (named.ok) started.push(String((named.data as { name: string }).name));

  check("the omitted runtime stays on the manager pty", omitted.ok === true && (omitted.data as { mode?: string }).mode === "pty", reply(omitted));
  check("the named runtime lands on tmux", named.ok === true && (named.data as { mode?: string }).mode === "tmux", reply(named));
  check("tmux reports that it streams no terminal", named.ok === true && (named.data as { streamsTerminal?: boolean }).streamsTerminal === false, reply(named));
  check("pty reports that it streams a terminal", omitted.ok === true && (omitted.data as { streamsTerminal?: boolean }).streamsTerminal === true, reply(omitted));
  check("an unknown runtime starts nothing", unknown.ok === false && /unknown runtime "not-a-runtime"/.test(unknown.error ?? ""), reply(unknown));
  check("auto is not a per-seat runtime", automatic.ok === false && /runtime "auto"/.test(automatic.error ?? ""), reply(automatic));
  check("both seats are running together", started.length === 2 && started.every((name) => rows.get(name)?.handle.status() === "running"), [...rows.keys()]);
  check("the manager runtime stays pty", manager.runtimeKind === "pty", manager.runtimeKind);
  const windows = execFileSync("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { encoding: "utf8" });
  check("the tmux window exists", windows.split("\n").includes("tmux-seat"), windows.trim());
  const recordPath = join(root, ".cotal", "seat-records", space, "tmux-seat.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as { agent?: { launch?: { runtime?: string } } };
  check("the persisted tmux seat keeps runtime tmux", record.agent?.launch?.runtime === "tmux", record.agent?.launch);

  const stopped: string[] = [];
  for (const name of started) {
    const handle = rows.get(name)?.handle;
    if (!handle) continue;
    handle.stop({ graceful: false });
    const until = Date.now() + 5_000;
    let status = handle.status();
    while (status === "running" && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = handle.status();
    }
    stopped.push(status);
  }
  check("both seats stop", stopped.length === 2 && stopped.every((status) => status === "exited"), stopped);
  let remaining = "";
  try { remaining = execFileSync("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { encoding: "utf8" }); } catch { remaining = ""; }
  check("the tmux window is gone", !remaining.split("\n").includes("tmux-seat"), remaining.trim());
} finally {
  for (const name of started) { try { rows.get(name)?.handle.stop({ graceful: false }); } catch { /* already gone */ } }
  try { await manager.stop({ withAgents: true }); } catch { /* not started */ }
  try { await delivery?.stop(); } catch { /* not started */ }
  try { execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" }); } catch { /* no session */ }
  await broker.stop();
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("per-deployment runtime smoke passed");

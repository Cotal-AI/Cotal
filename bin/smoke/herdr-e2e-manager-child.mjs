/**
 * The manager half of the herdr e2e (herdr-e2e-live.smoke.ts).
 *
 * Runs a REAL Manager on the herdr runtime in its OWN process, starts one real agent, prints a
 * single JSON line describing what it created, then idles until killed.
 *
 * It has to be a separate process because the claim under test is "agents survive the manager
 * going away". That is only provable by killing a manager — which an in-process Manager cannot do
 * to itself, and which asserting on the process tree does NOT establish: herdr's server is spawned
 * `detached`, so it is a child of the manager until the manager exits and then reparents to init.
 * Ancestry at time T says nothing about what happens at time T+1. Only SIGKILL does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import * as herdr from "../../extensions/herdr/src/driver.js";
import "../../extensions/herdr/src/runtime.js"; // self-registers runtime/herdr

const e = process.env;
const SPACE = e.HE2E_SPACE;
const SERVERS = e.HE2E_SERVERS;
const workspaceRoot = e.HE2E_WORKSPACE;
const STUB = e.HE2E_STUB;
const CANARY = e.HE2E_CANARY;
const HERDR_SESSION = `cotal-${SPACE}`;

const envFor = (o) => ({
  COTAL_SPACE: o.space,
  COTAL_SERVERS: String(o.servers ?? SERVERS),
  COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id),
  COTAL_NAME: o.name,
  PATH: e.PATH ?? "",
  COTAL_CONTROL_TOKEN: CANARY,
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({
  kind: "connector",
  name: "herdr-e2e",
  requires: ["node"],
  buildLaunch: (o) => ({ command: process.execPath, args: [STUB], env: envFor(o) }),
});

const mgr = new Manager({ space: SPACE, servers: SERVERS, runtime: "herdr", workspaceRoot });
await mgr.start();
const started = await mgr.startAgent({ name: "hagent", agent: "herdr-e2e", cwd: workspaceRoot });

// The lifecycle uid is what names the creds file on disk; read it off the managed agent while it
// is still managed. The e2e greps that real credential against herdr's records.
const lifecycleUid = mgr.agents?.get?.("hagent")?.lifecycleUid ?? "";
const panes = herdr.run(HERDR_SESSION, ["pane", "list"]).panes ?? [];
const pane = panes[0];
let agentPid;
if (pane) {
  const info = herdr.run(HERDR_SESSION, ["pane", "process-info", "--pane", pane.pane_id]);
  agentPid = (info.process_info?.foreground_processes ?? []).find((p) => String(p.argv0) === "node")?.pid;
}

console.log(`HE2E_READY ${JSON.stringify({
  ok: started?.ok === true,
  detail: started?.ok === true ? "" : JSON.stringify(started),
  id: started?.data?.id ?? "",
  lifecycleUid,
  managerPid: process.pid,
  paneId: pane?.pane_id ?? "",
  terminalId: pane?.terminal_id ?? "",
  agentPid: agentPid ?? 0,
})}`);

// Idle. The parent SIGKILLs this process to test survival — deliberately NO shutdown hook, because
// a graceful teardown would tear the agent down and defeat the whole point.
setInterval(() => {}, 1 << 30);

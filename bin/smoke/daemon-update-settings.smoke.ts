import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateSettings } from "@cotal-ai/workspace";
import { serveDaemon } from "../daemon/server.js";
import { daemonPathsFor } from "../daemon/endpoint.js";
import { parseRequest } from "../daemon/protocol.js";
import { parseDesktopRequest } from "../daemon/desktop.js";
import { updateViaDaemon } from "../daemon/client.js";
import { automaticUpdates } from "../daemon/auto-update.js";

const root = mkdtempSync(join(tmpdir(), "cotal-update-settings-"));
Object.assign(process.env, { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_HOME: join(root, "cotal") });
for (const dir of [process.env.HOME!, process.env.XDG_CONFIG_HOME!, process.env.COTAL_HOME!]) mkdirSync(dir, { mode: 0o700 });
const runtime = join(root, "rt"); mkdirSync(runtime, { recursive: true, mode: 0o700 });
let prepares = 0, aborts = 0;
const updates = automaticUpdates({ version: "0.160.5", eligible: () => false, prepare: async () => { prepares++; }, abort: async () => { aborts++; }, report: () => {} });
const paths = daemonPathsFor(process.env.COTAL_HOME!, { XDG_RUNTIME_DIR: runtime });
const daemon = await serveDaemon({ paths, sessionDir: process.env.COTAL_HOME!, version: "0.160.5", updateStatus: updates.status, updateCheck: updates.check });
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; console.log(`ok ${label}`); };
try {
  for (const key of ["auto", "notify"] as const) for (const enabled of [false, true]) {
    const result = await updateViaDaemon({ paths }, { op: "update-settings", [key]: enabled });
    check(readUpdateSettings()[key] === enabled, `${key} ${enabled} persisted through real daemon endpoint`);
    if (key === "notify") check(result.update?.notify === enabled, `notify ${enabled} reflected in daemon status`);
  }
  const result = await updateViaDaemon({ paths }, { op: "update-check" });
  check(result.update?.current === "0.160.5", "check returns update status");
  check(prepares === 0 && aborts === 0 && !updates.updating(), "settings and check do not install or restart");
  for (const value of ["on", 1, null, [], {}]) {
    check(!parseRequest(JSON.stringify({ v: 1, id: "bad", op: "update-settings", auto: value })).ok, "nonboolean setting refused");
    assert.throws(() => parseDesktopRequest({ op: "update-settings", notify: value }));
  }
  check(!parseRequest(JSON.stringify({ v: 1, id: "bad", op: "update-check", force: true })).ok, "unknown check field refused");
  assert.throws(() => parseDesktopRequest({ op: "update-release", version: "../../bad" }));
  console.log(`COTAL_SMOKE_RESULT ${JSON.stringify({ suite: "daemon-update-settings", passed: checks, failed: 0 })}`);
} finally { await daemon.close(); await updates.close(); }

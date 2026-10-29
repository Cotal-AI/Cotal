/** Real host MCP catalog and dispatch stay aligned when user-mode credentials are hidden.
 * These cells exercise the pre-connect tool surface. No broker authentication or run is claimed.
 * Run: pnpm exec tsx extensions/connector-jcode/smoke/jcode-tool-catalog.smoke.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { freePort } from "@cotal-ai/smoke-kit";

const root = mkdtempSync("/tmp/jcat-");
const port = await freePort();
assert.notEqual(port, 4222);
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const auth = await createSpaceAuth("catalogfixture");
const sentinel = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() });
const ambient: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambient)) if (key.startsWith("COTAL_") || key.startsWith("JCODE_")) delete ambient[key];
let passed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}: ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ✓ ${name}`);
};
const live = new Set<ChildProcess>();
try {
  for (const mode of ["open", "user_no_run", "user_run"]) {
    const dir = join(root, mode);
    for (const path of [dir, join(dir, "bin"), join(dir, "source"), join(dir, "home"), join(dir, "config")]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "source", "auth.json"), "owned-catalog-fixture", { mode: 0o600 });
    writeFileSync(join(dir, "sentinel.creds"), sentinel, { mode: 0o600 });
    writeFileSync(join(dir, "bin", "jcode"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(join(dir, "bin", "jcode"), 0o755);
    const env: NodeJS.ProcessEnv = {
      ...ambient, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), COTAL_HOME: join(dir, "cotalhome"),
      PATH: `${join(dir, "bin")}:${ambient.PATH ?? ""}`, JCODE_HOME: join(dir, "source"),
      COTAL_SPACE: "catalogfixture", COTAL_NAME: mode, COTAL_ID: mode, COTAL_LIFECYCLE_UID: mintLifecycleUid(),
      COTAL_SERVERS: `nats://127.0.0.1:${port}`, COTAL_SUBSCRIBE: "team", COTAL_ALLOW_SUBSCRIBE: "team", COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: dir, COTAL_JCODE_TUI: "0", COTAL_CONTROL_SOCKET: join(dir, "control.sock"), COTAL_CONTROL_TOKEN: randomBytes(32).toString("base64url"),
    };
    if (mode !== "open") {
      delete env.COTAL_ID;
      Object.assign(env, {
        COTAL_OWNER: `u_${"a".repeat(26)}`, COTAL_ACTOR: mode,
        COTAL_SENTINEL_CREDS: join(dir, "sentinel.creds"), COTAL_BEARER_CMD: JSON.stringify([process.execPath, "-e", "process.exit(1)"]),
      });
    }
    if (mode === "user_run") env.COTAL_CAPABILITIES = "run";
    const child = spawn(tsx, [host], { cwd: dir, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    live.add(child);
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    let client: Client | undefined;
    try {
      let entry: { command: string; args: string[]; env: Record<string, string> } | undefined;
      for (let i = 0; i < 300 && !entry; i++) {
        const homes = join(dir, ".cotal", "jcode");
        if (existsSync(homes)) for (const home of readdirSync(homes)) {
          const path = join(homes, home, "mcp.json");
          if (existsSync(path)) entry = (JSON.parse(readFileSync(path, "utf8")) as { servers: { cotal: typeof entry } }).servers.cotal;
        }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${mode}: host exited: ${stderr}`);
        if (!entry) await wait(50);
      }
      assert(entry, `${mode}: host wrote MCP config: ${stderr}`);
      const publicConfig = JSON.parse(entry.env.COTAL_JCODE_MCP_CONFIG!) as { creds?: string; userAuth?: unknown };
      check(`${mode}: child config retains only an authenticated-mode marker`,
        publicConfig.creds === (mode === "open" ? undefined : "managed") && publicConfig.userAuth === undefined,
        { marker: publicConfig.creds, userAuthPresent: publicConfig.userAuth !== undefined });
      check(`${mode}: child config contains no sentinel credential`, !entry.env.COTAL_JCODE_MCP_CONFIG!.includes(sentinel));
      client = new Client({ name: "catalog-smoke", version: "1" });
      await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, cwd: dir, env: { ...(ambient.PATH ? { PATH: ambient.PATH } : {}), HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), ...entry.env }, stderr: "pipe" }));
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      check(`${mode}: run catalog follows the host capability gate`, names.includes("cotal_run") === (mode !== "user_no_run"), names);
      check(`${mode}: spawn catalog follows the host capability gate`, names.includes("cotal_spawn") === (mode === "open"), names);
      const status = await client.callTool({ name: "cotal_connection_status", arguments: {} });
      check(`${mode}: baseline tool reaches the actual host`, status.content !== undefined);
      if (mode !== "user_no_run") {
        const reply = await client.callTool({ name: "cotal_run", arguments: { verb: "status", runId: `run-${"a".repeat(32)}` } }, undefined, { timeout: 15_000 });
        const text = JSON.stringify(reply.content);
        check(`${mode}: advertised run tool dispatches rather than returning unknown`, !text.includes("unknown cotal tool") && text.includes("not connected"), text);
      }
    } finally {
      await client?.close().catch(() => {});
      child.kill("SIGTERM");
      for (let i = 0; i < 300 && child.exitCode === null && child.signalCode === null; i++) await wait(50);
      if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* owned group already gone */ } }
      for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await wait(50);
      assert(child.exitCode !== null || child.signalCode !== null, `${mode}: owned host exit unproved`);
      live.delete(child);
    }
  }
  assert.equal(passed, 17);
  console.log(`\nJCODE TOOL CATALOG PASSED (${passed} checks)`);
} finally {
  for (const child of live) if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* owned group already gone */ } }
  if (live.size === 0) rmSync(root, { recursive: true });
}

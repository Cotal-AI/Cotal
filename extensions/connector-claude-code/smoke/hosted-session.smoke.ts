/** Real hosted API and stream lifecycle, with a local TCP failure fixture and no broker.
 *  Requires the package build: source imports run the direct stdio entrypoint. */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ClaudeSession, ClaudeSessionOptions } from "../src/mcp.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const require = createRequire(import.meta.url);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function child(scenario: string): Promise<void> {
  const { serveClaudeSession } = require("../dist/mcp.cjs") as {
    serveClaudeSession(opts: ClaudeSessionOptions): Promise<ClaudeSession>;
  };
  let input: PassThrough | Socket = new PassThrough();
  let output: PassThrough | Socket = new PassThrough();
  let client: Socket | undefined;
  let relay: ReturnType<typeof createServer> | undefined;
  let pendingConnection: Socket | undefined;
  let failure: ReturnType<typeof createServer> | undefined;
  let connectionReady: Promise<void> | undefined;
  let serverURL = process.env.HOSTED_SMOKE_SERVER;
  let session: ClaudeSession | undefined;
  let sibling: ClaudeSession | undefined;
  let notifications = 0;
  let code: number | undefined;
  const events: string[] = [];
  const lifecycle = scenario === "custody" ? {
    COTAL_ID: "synthetic_hosted_actor",
    COTAL_LIFECYCLE_UID: randomBytes(16).toString("hex"),
  } : {};
  const path = join(process.cwd(), "control.sock");
  const env = (name: string) => ({
    ...lifecycle,
    HOME: process.env.HOME,
    COTAL_NAME: name,
    COTAL_SPACE: "hosted_component",
    COTAL_SERVERS: serverURL,
    COTAL_WORKSPACE_ROOT: process.cwd(),
    COTAL_CONTROL_SOCKET: name === "primary" ? path : join(process.cwd(), "sibling.sock"),
    COTAL_CONTROL_TOKEN: randomBytes(32).toString("hex"),
  });
  try {
    if (scenario === "failure" || scenario === "custody" || scenario === "rebuild-stop") {
      connectionReady = new Promise<void>((resolve) => {
        failure = createServer((socket) => {
          if (pendingConnection) { socket.destroy(); return; }
          pendingConnection = socket;
          resolve();
        });
        failure.listen(0, "127.0.0.1");
      });
      await once(failure!, "listening");
      const address = failure!.address();
      assert.ok(address && typeof address !== "string");
      serverURL = `nats://127.0.0.1:${address.port}`;
    }
    if (scenario === "rebuild-stop") {
      const { CotalEndpoint } = await import("@cotal-ai/core");
      const endpoint = new CotalEndpoint({
        servers: serverURL,
        space: "hosted_component",
        card: { id: "synthetic_rebuild_actor", name: "rebuild_fixture", kind: "agent" },
      });
      endpoint.on("error", () => {});
      const rebuilding = endpoint.reconnect();
      await connectionReady;
      const stopping = endpoint.stop();
      await wait(20);
      pendingConnection!.destroy();
      await Promise.all([rebuilding, stopping]);
      return;
    }
    if (scenario === "reset") {
      const accepted = new Promise<Socket>((resolve) => {
        relay = createServer(resolve);
        relay.listen(0, "127.0.0.1");
      });
      await once(relay!, "listening");
      const address = relay!.address();
      assert.ok(address && typeof address !== "string");
      client = createConnection(address.port, "127.0.0.1");
      client.on("error", () => {});
      await once(client, "connect");
      input = output = await accepted;
    } else {
      output.resume();
    }
    input.on("end", () => events.push("end"));
    input.on("close", () => events.push("close"));
    input.on("error", (error: NodeJS.ErrnoException) => events.push(error.code ?? "error"));
    const endListeners = input.listenerCount("end");
    const closeListeners = input.listenerCount("close");
    if (scenario === "ended") {
      input.resume();
      input.end();
      await once(input, "end");
    }
    if (scenario === "destroyed-before") input.destroy();
    if (scenario === "buffered") {
      input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hosted-smoke", version: "1" } } }) + "\n");
      assert.equal(input.readableEnded, false);
    }
    const pending = serveClaudeSession({ env: env("primary"), input, output, onShutdown: (value) => { notifications++; code = value; } });
    if (scenario === "startup-eof") { input.resume(); input.end(); }
    if (scenario === "ended" || scenario === "destroyed-before" || scenario === "startup-eof") {
      await assert.rejects(pending, /hosted MCP input/);
      assert.equal(existsSync(path), false);
      return;
    }
    session = await pending;
    if (scenario === "custody") {
      await connectionReady;
      const duplicateInput = new PassThrough();
      const duplicateOutput = new PassThrough();
      try {
        await assert.rejects(
          serveClaudeSession({ env: env("sibling"), input: duplicateInput, output: duplicateOutput }),
          /local inbox already has a consuming session/,
        );
      } finally {
        duplicateInput.destroy();
        duplicateOutput.destroy();
      }
      const closing = session.close();
      await wait(20);
      pendingConnection!.destroy();
      await closing;
      assert.equal(existsSync(path), false);
      sibling = await serveClaudeSession({ env: env("sibling"), input: new PassThrough(), output: new PassThrough() });
      await sibling.close();
      assert.equal(existsSync(join(process.cwd(), "sibling.sock")), false);
      assert.equal(notifications, 0);
    } else if (scenario === "explicit") {
      const first = session.close();
      assert.equal(first, session.close());
      await first;
      assert.equal(input.listenerCount("end"), endListeners);
      assert.equal(input.listenerCount("close"), closeListeners);
      assert.equal(input.destroyed, false);
      assert.equal(output.destroyed, false);
      input.destroy();
      await wait(50);
      assert.equal(notifications, 0);
    } else {
      if (scenario === "eof") {
        sibling = await serveClaudeSession({ env: env("sibling"), input: new PassThrough(), output: new PassThrough() });
      }
      if (scenario === "failure") {
        await connectionReady;
        input.end();
        await wait(20);
        pendingConnection!.destroy();
      } else {
        await wait(300);
        if (scenario === "reset") client!.resetAndDestroy();
        else if (scenario === "destroy") input.destroy();
        else input.end();
      }
      for (let i = 0; i < 80 && notifications === 0; i++) await wait(50);
      assert.equal(notifications, 1, "transport closure must notify once");
      assert.ok(code === 0 || code === 1);
      if (scenario === "eof" || scenario === "failure" || scenario === "buffered") {
        assert.ok(events.includes("end"));
        if (scenario === "eof") assert.equal(existsSync(join(process.cwd(), "sibling.sock")), true);
        if (scenario === "failure") assert.equal(code, 0, "a stopped dial failure is not a teardown failure");
      } else {
        assert.ok(events.includes("close"));
        assert.equal(events.includes("end"), false);
        if (scenario === "reset") assert.ok(events.includes("ECONNRESET"));
      }
      assert.equal(input.listenerCount("end"), endListeners);
      assert.equal(input.listenerCount("close"), closeListeners);
      await wait(50);
      assert.equal(notifications, 1);
    }
    assert.equal(existsSync(path), false);
  } finally {
    await session?.close().catch(() => {});
    await sibling?.close().catch(() => {});
    input.destroy();
    output.destroy();
    client?.destroy();
    pendingConnection?.destroy();
    if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
    if (failure) await new Promise<void>((resolve) => failure!.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hs-"));
  const failure = createServer((socket) => socket.destroy());
  failure.listen(0, "127.0.0.1");
  await once(failure, "listening");
  const address = failure.address();
  assert.ok(address && typeof address !== "string");
  let failed = 0;
  try {
    for (const scenario of ["explicit", "eof", "failure", "destroy", "reset", "ended", "destroyed-before", "startup-eof", "buffered", "custody", "rebuild-stop"]) {
      const cwd = join(root, scenario);
      mkdirSync(cwd, { mode: 0o700 });
      for (const name of ["home", "config", "cache", "state", ".cotal"]) mkdirSync(join(cwd, name), { mode: 0o700 });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
        const processChild = spawn(process.execPath, [require.resolve("tsx/cli"), fileURLToPath(import.meta.url)], {
          cwd,
          env: { HOME: join(cwd, "home"), TMPDIR: cwd, XDG_CONFIG_HOME: join(cwd, "config"), XDG_CACHE_HOME: join(cwd, "cache"), XDG_STATE_HOME: join(cwd, "state"), PATH: process.env.PATH, LANG: "C.UTF-8", HOSTED_SMOKE_CASE: scenario, HOSTED_SMOKE_SERVER: `nats://127.0.0.1:${address.port}` },
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 12000,
        });
        let stderr = "";
        processChild.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        processChild.once("error", reject);
        processChild.once("close", (code, signal) => resolve({ code, signal, stderr }));
      });
      const name = `hosted_${scenario}_lifecycle`;
      if (result.code === 0 && !result.signal) console.log(`PASS ${name}`);
      else { failed++; console.error(`FAIL ${name}\n${result.stderr}`); }
    }
  } finally {
    await new Promise<void>((resolve) => failure.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(failed, 0, "hosted session lifecycle failures");
  emitSentinel({ passed: counted.cells(), failed: 0 });
}

const scenario = process.env.HOSTED_SMOKE_CASE;
(scenario ? child(scenario) : main()).catch((error) => { console.error(error); process.exitCode = 1; });

/** Isolated installed-provider check. No user home, mesh, model request or plugin is used. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requireNativeLifecycleOperation, resolveNativeLifecycleProvider } from "@cotal-ai/core";
import "../src/native-lifecycle.js";

const home = await mkdtemp(join(tmpdir(), "cotal-opencode-native-"));
const password = randomBytes(24).toString("base64url");
const binary = process.env.COTAL_TEST_OPENCODE_BINARY ?? "opencode";
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: home,
  env: {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, plugin: [], mcp: {}, permission: "deny", share: "disabled" }),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let processExited = false;
const exited = new Promise<void>(resolve => { child.once("exit", () => { processExited = true; resolve(); }); child.once("error", () => resolve()); });
try {
  const endpoint = await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("Isolated OpenCode server startup timed out")); }, 40_000);
    const receive = (data: Buffer): void => {
      log = (log + data.toString("utf8")).slice(-16_384);
      const match = /http:\/\/127\.0\.0\.1:[0-9]+/.exec(log);
      if (match) { cleanup(); resolve(match[0]); }
    };
    const fail = (): void => { cleanup(); reject(new Error("Isolated OpenCode server failed before listening")); };
    const cleanup = (): void => {
      clearTimeout(timer); child.stdout.off("data", receive); child.stderr.off("data", receive);
      child.off("exit", fail); child.off("error", fail);
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive); child.once("exit", fail); child.once("error", fail);
  });
  // Drain logs without publishing provider output or credentials into test evidence.
  child.stdout.resume(); child.stderr.resume();
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
  const fixtureRequest = async (path: string, method = "GET", body?: object): Promise<unknown> => {
    const response = await fetch(endpoint + path, { method, headers, redirect: "error", signal: AbortSignal.timeout(10_000), ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.ok, true, `isolated fixture HTTP ${response.status}`);
    return response.json();
  };
  assert.deepEqual(await fixtureRequest("/session"), []);
  // Only the fixture creates sessions. The provider itself has no session-creation operation.
  const first = await fixtureRequest("/session", "POST", { title: "Native lifecycle fixture" }) as { id: string; directory: string; time: { created: number } };
  const provider = resolveNativeLifecycleProvider("opencode");
  const connection = provider.connect({ endpoint, password, hostIdentity: "isolated-native-host", nativeOwnerNamespace: "isolated-owner" });
  const observations = await requireNativeLifecycleOperation(connection, "discover")();
  const resource = observations.find(observation => observation.resourceKey.stableSessionId === first.id)?.resourceKey;
  assert.ok(resource);
  await test("installed OpenCode returns the same externally created session through the registered provider", async () => {
    const value = await requireNativeLifecycleOperation(connection, "inspect")(resource);
    assert.equal(value.directory, first.directory);
    assert.equal(value.providerVersion, "1.18.15", "update native-version evidence deliberately before changing the certification pin");
    assert.equal(value.resourceKey.stableSessionId, first.id);
    assert.equal(value.incarnationProof, undefined);
  });
  const second = await fixtureRequest("/session", "POST", { title: "Native lifecycle fixture" }) as { id: string };
  await test("a second same-title native session never retargets the original resource", async () => {
    assert.notEqual(first.id, second.id);
    const value = await requireNativeLifecycleOperation(connection, "inspect")(resource);
    assert.equal(value.resourceKey.stableSessionId, first.id);
    assert.equal((await fixtureRequest("/session") as unknown[]).length, 2);
  });
  await test("refused adoption leaves native session identity and directory unchanged", async () => {
    const before = await fixtureRequest(`/session/${first.id}`);
    const preflight = await requireNativeLifecycleOperation(connection, "preflight")("adopt", resource);
    assert.equal(preflight.ok, false);
    assert.deepEqual(await fixtureRequest(`/session/${first.id}`), before);
    assert.equal((await fixtureRequest("/session") as unknown[]).length, 2);
  });
  await test("view description selects the original session without carrying native credentials", async () => {
    const view = await requireNativeLifecycleOperation(connection, "openView")(resource);
    assert.deepEqual(view.args, ["attach", endpoint, "--session", first.id]);
    assert.ok(!JSON.stringify(view).includes(password));
  });
  console.log(JSON.stringify({ provider: "opencode", version: "1.18.15", platform: process.platform, source: "registered native provider", externalFixtureSessions: 2, modelCalls: 0, managementCertification: false }));
} finally {
  if (!processExited) {
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 8000); })]);
    if (timer) clearTimeout(timer);
    if (!processExited && child.pid) { child.kill("SIGKILL"); await exited; }
  }
  await rm(home, { recursive: true, force: true });
}

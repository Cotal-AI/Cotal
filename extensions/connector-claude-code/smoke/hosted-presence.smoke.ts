/** REAL broker on loopback: hosted presence with distinct and absent launch labels. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "@nats-io/transport-node";
import { CotalEndpoint, isReachable, presenceBucket, setupSpaceStreams, type Presence } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { ClaudeSession, ClaudeSessionOptions } from "../src/mcp.js";

const require = createRequire(import.meta.url);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function check(name: string, passed: boolean): void {
  assert.equal(passed, true, name);
  console.log(`PASS ${name}`);
}

async function child(): Promise<void> {
  const { serveClaudeSession } = require("@cotal-ai/connector-claude-code/mcp") as {
    serveClaudeSession(opts: ClaudeSessionOptions): Promise<ClaudeSession>;
  };
  const coreRequire = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
  const { Kvm } = await import(pathToFileURL(coreRequire.resolve("@nats-io/kv")).href);
  const root = process.cwd(), servers = process.env.HOSTED_PRESENCE_SERVER!;
  const space = `hosted_presence_${process.env.HOSTED_PRESENCE_CASE!}`;
  await setupSpaceStreams({ servers, space });
  const sessions: { session?: ClaudeSession; input: PassThrough; output: PassThrough; name: string; expected: string | null }[] = [];
  const endpoints: CotalEndpoint[] = [];
  const nc = await connect({ servers });
  try {
    for (const [name, environment] of [["legacy_presence", undefined], ["core_explicit", "  explicit-core  "], ["core_null", null]] as const) {
      const endpoint = new CotalEndpoint({
        servers, space, card: { name, kind: "endpoint" }, environment,
        consume: false, watchPresence: false, watchChannels: false,
      });
      endpoint.on("error", () => {}); endpoints.push(endpoint);
      await endpoint.start();
    }
    for (const [name, value] of [["sess_a", "env-for-sess_a"], ["sess_b", "env-for-sess_b"], ["sess_absent", undefined], ["sess_blank", "   "]] as const) {
      const home = join(root, name); mkdirSync(home, { mode: 0o700 });
      const input = new PassThrough(), output = new PassThrough(); output.resume();
      input.on("error", () => {}); output.on("error", () => {});
      const env: NodeJS.ProcessEnv = {
        HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, COTAL_NAME: name,
        COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_WORKSPACE_ROOT: home,
        COTAL_CONTROL_SOCKET: join(home, "c.sock"), COTAL_CONTROL_TOKEN: randomBytes(32).toString("hex"),
        COTAL_CHANNEL: "0", ...(value === undefined ? {} : { COTAL_ENVIRONMENT: value }),
      };
      const state = { input, output, name, expected: value?.trim() || null, session: undefined as ClaudeSession | undefined };
      sessions.push(state);
      state.session = await serveClaudeSession({ env, input, output });
    }
    const kv = await new Kvm(nc).open(presenceBucket(space));
    const seen = new Map<string, string | null>();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for await (const key of await kv.keys()) {
        const entry = await kv.get(key);
        if (!entry?.value?.length) continue;
        const presence = JSON.parse(new TextDecoder().decode(entry.value)) as Presence;
        if (presence.status !== "offline") seen.set(presence.card.name, presence.environment ?? null);
      }
      if (seen.size === sessions.length + endpoints.length) break;
      await wait(25);
    }
    check("hosted_presence_all_sessions_published", seen.size === 7);
    for (const state of sessions) {
      check(`hosted_presence_${state.name}`, seen.get(state.name) === state.expected);
    }
    check("hosted_presence_legacy_inherits", seen.get("legacy_presence") === (process.env.COTAL_ENVIRONMENT?.trim() || null));
    check("hosted_presence_core_override", seen.get("core_explicit") === "explicit-core");
    check("hosted_presence_core_null", seen.get("core_null") === null);
  } finally {
    const closed = await Promise.allSettled([
      ...sessions.map((state) => state.session?.close()), ...endpoints.map((endpoint) => endpoint.stop()),
    ]);
    for (const state of sessions) { state.input.destroy(); state.output.destroy(); }
    await nc.close();
    assert.deepEqual(closed.filter((entry) => entry.status === "rejected"), [], "presence fixture teardown failed");
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
  const brokerHome = join(root, "broker-home"); mkdirSync(brokerHome, { mode: 0o700 });
  const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, "js")], {
    stdio: "ignore", env: { HOME: brokerHome, PATH: process.env.PATH, LANG: "C.UTF-8" },
  });
  const release = teardownOnSignal(broker, root);
  try {
    await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
    assert.equal(broker.exitCode, null);
    check("hosted_presence_broker_ready", true);
    for (const mode of ["host_set", "host_unset"]) {
      const cwd = join(root, mode); mkdirSync(cwd, { mode: 0o700 });
      for (const name of ["home", "xdg", "cotal", "tmp", ".cotal"]) mkdirSync(join(cwd, name), { mode: 0o700 });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
        const childProcess = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, fileURLToPath(import.meta.url)], {
          cwd,
          env: {
            HOME: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "xdg"), COTAL_HOME: join(cwd, "cotal"), TMPDIR: join(cwd, "tmp"),
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`, LANG: "C.UTF-8",
            HOSTED_PRESENCE_CASE: mode, HOSTED_PRESENCE_SERVER: servers,
            ...(process.env.MUTATION_PROOF_RUN ? { MUTATION_PROOF_RUN: process.env.MUTATION_PROOF_RUN } : {}),
            ...(process.env.SMOKE_BROKER_SCOPE ? { SMOKE_BROKER_SCOPE: process.env.SMOKE_BROKER_SCOPE } : {}),
            ...(mode === "host_set" ? { COTAL_ENVIRONMENT: "env-of-host-process" } : {}),
          },
          stdio: ["ignore", "inherit", "pipe"], timeout: 30000,
        });
        const releaseChild = teardownOnSignal(childProcess, cwd);
        let stderr = "";
        childProcess.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        childProcess.once("error", reject);
        childProcess.once("close", (code, signal) => { releaseChild(); resolve({ code, signal, stderr }); });
      });
      if (result.code !== 0 || result.signal) { process.stderr.write(result.stderr); throw new Error(`hosted presence failed: ${mode}`); }
    }
  } finally {
    await killAndAwaitExit(broker);
    rmSync(root, { recursive: true, force: true });
    release();
  }
}
(process.env.HOSTED_PRESENCE_CASE ? child() : main()).catch((error) => { console.error(error); process.exitCode = 1; });

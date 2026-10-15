/** Native hosted API, bearer children, hook sockets and loopback feedback. No broker or model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createBrokerAuth, createSpaceAccountAuth, mintLifecycleUid, runAgentBearer } from "@cotal-ai/core";
import { createCalloutAuth } from "@cotal-ai/auth";
import { configFromEnv, MeshAgent } from "@cotal-ai/connector-core";
import type { ClaudeSession, ClaudeSessionOptions } from "../src/mcp.js";

const require = createRequire(import.meta.url);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function check(label: string, passed: boolean): void {
  assert.equal(passed, true, label);
  console.log(`PASS ${label}`);
}
async function stopFixture(agent?: MeshAgent): Promise<void> {
  await agent?.stop().catch((error: unknown) => {
    assert.match((error as Error).message, /^fixture refuses before authentication$/);
  });
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "bearer helper observation deadline");
    await wait(20);
  }
}
function carried(home: string, source: string) {
  const project = join(home, "projects", "seat");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ type: "custom-title", customTitle: source }) + "\n";
  writeFileSync(join(project, `${source}.jsonl`), content, { mode: 0o600 });
  return { home, source, project, record: join(home, "cotal-fork.json"), digest: createHash("sha256").update(content).digest("hex") };
}
async function hook(env: NodeJS.ProcessEnv, event: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: env.COTAL_CONTROL_SOCKET! });
    let text = "";
    // SessionStart waits the normal 10s initial-connect grace in this intentionally offline fixture.
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("hook reply deadline")); }, 13000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { text += chunk; });
    socket.once("connect", () => socket.write(JSON.stringify({ token: env.COTAL_CONTROL_TOKEN, event }) + "\n"));
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("end", () => { clearTimeout(timer); socket.destroy(); JSON.parse(text); resolve(); });
  });
}

async function child(): Promise<void> {
  const { serveClaudeSession } = require("../dist/mcp.cjs") as {
    serveClaudeSession(opts: ClaudeSessionOptions): Promise<ClaudeSession>;
  };
  const root = process.cwd();
  const helper = join(root, "bearer.cjs");
  writeFileSync(helper, `const fs = require('node:fs');
const out = process.argv[2];
if (!fs.existsSync(out)) {
  const tmp = out + '.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({name: process.env.COTAL_NAME, space: process.env.COTAL_SPACE, home: process.env.HOME, marker: process.env.FIXTURE_SESSION_MARKER, hostOnly: process.env.FIXTURE_HOST_ONLY_CANARY !== undefined}), {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, out);
}
process.stderr.write('fixture refuses before authentication\\n');
process.exitCode = 1;
`, { mode: 0o600 });
  const broker = await createBrokerAuth("hosted-env-fixture");
  const account = await createSpaceAccountAuth(broker, "hosted_env");
  const callout = await createCalloutAuth({ space: "hosted_env", operatorSeed: broker.operator.seed, accountPub: account.account.pub });
  const sentinel = join(root, "sentinel.creds");
  writeFileSync(sentinel, callout.sentinelCreds, { mode: 0o600 });
  const ambientCarried = carried(join(root, "ambient-carried"), "ambient_source");
  const ambientGit = join(root, "ambient.gitconfig");
  writeFileSync(ambientGit, "[user]\n\temail = ambient-git@example.invalid\n", { mode: 0o600 });
  Object.assign(process.env, {
    COTAL_NAME: "ambient_name", COTAL_SPACE: "ambient_space", FIXTURE_SESSION_MARKER: "ambient_marker",
    FIXTURE_HOST_ONLY_CANARY: "synthetic", COTAL_FEEDBACK_EMAIL: "ambient-env@example.invalid",
    COTAL_CLAUDE_CARRIED: ambientCarried.source, CLAUDE_CONFIG_DIR: ambientCarried.home,
    GIT_CONFIG_GLOBAL: ambientGit, GIT_CONFIG_NOSYSTEM: "1",
  });
  const baseline = { ...process.env };
  let dials = 0;
  const failure = createServer((socket) => { dials++; socket.destroy(); });
  failure.listen(0, "127.0.0.1");
  await once(failure, "listening");
  const address = failure.address();
  assert.ok(address && typeof address !== "string");
  const contacts: string[] = [];
  const feedback = createHttpServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/fixture-feedback");
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      contacts.push((JSON.parse(body) as { email: string }).email);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "fixture-only", published: true }));
    });
  });
  feedback.listen(0, "127.0.0.1");
  await once(feedback, "listening");
  const feedbackAddress = feedback.address();
  assert.ok(feedbackAddress && typeof feedbackAddress !== "string");
  const sessions: { session?: ClaudeSession; input: PassThrough; output: PassThrough; env: NodeJS.ProcessEnv; timers: Set<ReturnType<typeof setTimeout>> }[] = [];
  let legacy: MeshAgent | undefined;
  let scoped: MeshAgent | undefined;
  const envFor = (name: string): NodeJS.ProcessEnv => ({
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, COTAL_NAME: name, COTAL_SPACE: "hosted_env",
    COTAL_OWNER: `u_${"a".repeat(26)}`, COTAL_ACTOR: name, COTAL_LIFECYCLE_UID: mintLifecycleUid(),
    COTAL_SENTINEL_CREDS: sentinel, COTAL_BEARER_CMD: JSON.stringify([process.execPath, helper, join(root, `${name}.json`)]),
    COTAL_SERVERS: `nats://127.0.0.1:${address.port}`, COTAL_WORKSPACE_ROOT: root,
    COTAL_CONTROL_SOCKET: join(root, `${name}.sock`), COTAL_CONTROL_TOKEN: randomBytes(32).toString("hex"),
    COTAL_CHANNEL: "0", FIXTURE_SESSION_MARKER: `marker_${name}`,
    COTAL_FEEDBACK_URL: `http://127.0.0.1:${feedbackAddress.port}/fixture-feedback`,
  });
  try {
    const direct = join(root, "direct.json");
    const directEnv = envFor("direct");
    await assert.rejects(runAgentBearer([process.execPath, helper, direct], { env: directEnv }), /fixture refuses/);
    check("hosted_env_direct_control", (JSON.parse(readFileSync(direct, "utf8")) as { hostOnly: boolean }).hostOnly === false);
    legacy = new MeshAgent(configFromEnv(envFor("legacy")));
    legacy.start();
    await until(() => existsSync(join(root, "legacy.json")));
    const inherited = JSON.parse(readFileSync(join(root, "legacy.json"), "utf8")) as { name: string; hostOnly: boolean };
    check("hosted_env_legacy_inheritance", inherited.name === "ambient_name" && inherited.hostOnly);
    await stopFixture(legacy);
    const supplied = envFor("mesh_scoped");
    scoped = new MeshAgent(configFromEnv(supplied), supplied);
    supplied.FIXTURE_SESSION_MARKER = "mutated_after_constructor";
    scoped.start();
    await until(() => existsSync(join(root, "mesh_scoped.json")));
    const scopedObservation = JSON.parse(readFileSync(join(root, "mesh_scoped.json"), "utf8")) as { marker: string; hostOnly: boolean };
    check("hosted_env_mesh_snapshot", scopedObservation.marker === "marker_mesh_scoped" && !scopedObservation.hostOnly);
    await stopFixture(scoped);
    for (const label of ["a", "b"]) {
      const name = `session_${label}`;
      const own = carried(join(root, `carried-${label}`), `source_${label}`);
      const git = join(root, `${label}.gitconfig`);
      writeFileSync(git, `[user]\n\temail = session-git-${label}@example.invalid\n`, { mode: 0o600 });
      const env: NodeJS.ProcessEnv = { ...envFor(name), COTAL_CLAUDE_CARRIED: own.source, CLAUDE_CONFIG_DIR: own.home,
        COTAL_FEEDBACK_EMAIL: label === "a" ? "session-env-a@example.invalid" : "",
        GIT_CONFIG_GLOBAL: git, GIT_CONFIG_NOSYSTEM: "1" };
      const expected: NodeJS.ProcessEnv = { ...env };
      const input = new PassThrough(), output = new PassThrough();
      input.on("error", () => {}); output.on("error", () => {});
      const pending = new Map<number, (frame: { result?: unknown; error?: unknown }) => void>();
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const state = { input, output, env: expected, timers, session: undefined as ClaudeSession | undefined };
      sessions.push(state);
      let id = 0, buffer = "";
      output.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        while (buffer.includes("\n")) {
          const at = buffer.indexOf("\n"), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          if (!line) continue;
          const frame = JSON.parse(line) as { id: number; result?: unknown; error?: unknown };
          const done = pending.get(frame.id);
          if (done) { pending.delete(frame.id); done(frame); }
        }
      });
      const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
        const current = ++id;
        const timer = setTimeout(() => { timers.delete(timer); pending.delete(current); reject(new Error(`MCP deadline: ${method}`)); }, 5000);
        timers.add(timer);
        pending.set(current, (frame) => { clearTimeout(timer); timers.delete(timer); frame.error ? reject(new Error("MCP request refused")) : resolve(frame.result); });
        input.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
      });
      const starting = serveClaudeSession({ env, input, output });
      if (label === "a") Object.assign(env, { FIXTURE_SESSION_MARKER: "mutated", COTAL_FEEDBACK_EMAIL: "mutated@example.invalid", CLAUDE_CONFIG_DIR: ambientCarried.home, COTAL_CLAUDE_CARRIED: ambientCarried.source });
      state.session = await starting;
      check(`hosted_env_name_${label}`, state.session.name === name);
      await until(() => existsSync(join(root, `${name}.json`)));
      const observed = JSON.parse(readFileSync(join(root, `${name}.json`), "utf8")) as Record<string, unknown>;
      check(`hosted_env_bearer_${label}`, observed.name === expected.COTAL_NAME && observed.space === expected.COTAL_SPACE && observed.home === expected.HOME && observed.marker === expected.FIXTURE_SESSION_MARKER && observed.hostOnly === false);
      await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hosted-env-fixture", version: "1" } });
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await hook(expected, { hook_event_name: "SessionStart", source: "fork", session_id: `fork_${label}`, transcript_path: join(own.project, `fork_${label}.jsonl`) });
      check(`hosted_env_carried_${label}`, existsSync(own.record));
      const record = JSON.parse(readFileSync(own.record, "utf8")) as { source: string; transcriptSha256: string };
      check(`hosted_env_carried_digest_${label}`, record.source === own.source && record.transcriptSha256 === own.digest && (statSync(own.record).mode & 0o777) === 0o600);
      if (label === "b") delete process.env.COTAL_FEEDBACK_EMAIL;
      const reply = await request("tools/call", { name: "cotal_feedback", arguments: { origin: "agent", type: "other", summary: "Loopback-only environment fixture" } }) as { isError?: boolean };
      assert.notEqual(reply.isError, true);
      check(label === "a" ? "hosted_env_feedback_a" : "hosted_env_feedback_git", contacts.at(-1) === (label === "a" ? expected.COTAL_FEEDBACK_EMAIL : "session-git-b@example.invalid"));
      if (label === "b") process.env.COTAL_FEEDBACK_EMAIL = baseline.COTAL_FEEDBACK_EMAIL;
    }
    await hook(sessions[0].env, { hook_event_name: "SessionStart", source: "fork", session_id: "ambient_target", transcript_path: join(ambientCarried.project, "ambient_target.jsonl") });
    check("hosted_env_ambient_fork_untouched", !existsSync(ambientCarried.record));
    check("hosted_env_no_broker_dial", dials === 0);
    check("hosted_env_loopback_only", contacts.length === 2);
    assert.deepEqual({ ...process.env }, baseline, "hosted API must not mutate ambient env");
    console.log("PASS hosted_env_ambient_unchanged");
  } finally {
    const closed = await Promise.allSettled([
      stopFixture(scoped), stopFixture(legacy), ...sessions.map((state) => state.session?.close()),
    ]);
    const owned = sessions.every((state) => !state.input.destroyed && !state.output.destroyed);
    for (const state of sessions) {
      for (const timer of state.timers) clearTimeout(timer);
      state.input.destroy(); state.output.destroy();
    }
    feedback.closeAllConnections();
    await new Promise<void>((resolve) => feedback.close(() => resolve()));
    await new Promise<void>((resolve) => failure.close(() => resolve()));
    const rejected = closed.filter((entry) => entry.status === "rejected");
    assert.deepEqual(rejected, [], "fixture teardown failed");
    check("hosted_env_caller_streams_owned", owned);
    for (const state of sessions) assert.equal(existsSync(state.env.COTAL_CONTROL_SOCKET!), false);
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "he-"));
  for (const name of ["home", "xdg", "cotal", "tmp", ".cotal"]) mkdirSync(join(root, name), { mode: 0o700 });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const processChild = spawn(process.execPath, [require.resolve("tsx/cli"), fileURLToPath(import.meta.url)], {
        cwd: root, env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"), COTAL_HOME: join(root, "cotal"), TMPDIR: join(root, "tmp"), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", HOSTED_ENV_CHILD: "1" },
        stdio: ["ignore", "inherit", "pipe"], timeout: 65000,
      });
      let stderr = "";
      processChild.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      processChild.once("error", reject);
      processChild.once("close", (code, signal) => resolve({ code, signal, stderr }));
    });
    if (result.code !== 0 || result.signal) { process.stderr.write(result.stderr); throw new Error("hosted environment smoke failed"); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
(process.env.HOSTED_ENV_CHILD ? child() : main()).catch((error) => { console.error(error); process.exitCode = 1; });

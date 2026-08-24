import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await sleep(100);
  }
}

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-host-"));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const log = join(root, "fake.jsonl");
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
let child: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const entries = (): Array<{ ev: string; [key: string]: unknown }> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({ servers, space: "jcodehost", file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  operator = new CotalEndpoint({ space: "jcodehost", servers, card: { name: "operator", kind: "agent", id: "operator" }, channels: ["team"] });
  operator.on("error", () => {});
  let peerId: string | undefined;
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (event.type !== "offline" && event.presence.card.name === "jcodepeer") peerId = event.presence.card.id;
  });
  await operator.start();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  const inheritedJcodeHome = join(root, "source-jcode");
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "host-smoke-token", { mode: 0o600 });
  child = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_MODEL: "fake-model",
      COTAL_VARIANT: "high",
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-host-smoke-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor("fake bridge", () => entries().find((entry) => entry.ev === "listening"));
  await waitFor("mesh presence", () => peerId);
  check("Jcode host joins the mesh", Boolean(peerId));
  const argv = entries().find((entry) => entry.ev === "argv") as { argv?: string[]; env?: Record<string, string> };
  check("host uses api-bridge with its private socket", argv.argv?.[0] === "api-bridge" && argv.argv?.[1] === "--api-socket", argv);
  check("host scrubs Cotal material before launching Jcode", Object.keys(argv.env ?? {}).every((key) => !key.startsWith("COTAL_")), argv.env);
  check("private JCODE_HOME is passed to the harness", Boolean(argv.env?.JCODE_HOME?.includes("/tmp/jc-") && argv.env?.JCODE_HOME?.endsWith("/home")), argv.env);
  check("host disables SDK symlinked credential inheritance", argv.env?.JCODE_HOME !== undefined && !Object.keys(argv.env ?? {}).some((key) => key === "COTAL_JCODE_HOME"), argv.env);
  const managedHome = join(root, ".cotal", "jcode", "jcodehost-jcodepeer-3276792e8714");
  check("host copies auth mirror rather than linking it", lstatSync(join(managedHome, "auth.json")).isFile() && !lstatSync(join(managedHome, "auth.json")).isSymbolicLink());
  check("host copied auth mirror is owner-only", (statSync(join(managedHome, "auth.json")).mode & 0o777) === 0o600);

  await operator.unicast(peerId!, "mesh-wake");
  const turn = await waitFor("Harness API turn", () => entries().find((entry) => entry.ev === "request" && (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" && !(entry.frame as { no_reply?: boolean }).no_reply && String((entry.frame as { content?: string }).content).includes("mesh-wake")));
  check("mesh DM becomes a Harness API turn", JSON.stringify(turn).includes("mesh-wake"), turn);
  const bootTurns = entries().filter((entry) => entry.ev === "request" && (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" && !(entry.frame as { no_reply?: boolean }).no_reply && String((entry.frame as { content?: string }).content).includes("cotal_orientation"));
  check("host runs the mandatory cotal MCP readiness turn before joining", bootTurns.length === 1, bootTurns);

  // The Cotal variant IS the session's reasoning effort. Assert the requested TIER reaches the
  // Harness API — the value on the wire, not that some call happened — and that it lands before the
  // first turn, so no turn is ever served at an effort the operator did not ask for.
  const requests = entries().filter((entry) => entry.ev === "request");
  const effortAt = requests.findIndex((entry) => (entry.frame as { req?: string }).req === "set_reasoning_effort");
  const effortFrame = effortAt < 0 ? undefined : (requests[effortAt].frame as { effort?: string; session_id?: string });
  check("requested variant reaches the session as its reasoning effort", effortFrame?.effort === "high", effortFrame);
  check("reasoning effort is applied to the host's own session", effortFrame?.session_id === "fake-session", effortFrame);
  const firstTurnAt = requests.findIndex((entry) => (entry.frame as { req?: string; no_reply?: boolean }).req === "send_message" && !(entry.frame as { no_reply?: boolean }).no_reply);
  check("reasoning effort is set before the session's first turn", effortAt >= 0 && firstTurnAt > effortAt, { effortAt, firstTurnAt });

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(10_000)]);
  check("host exits cleanly on SIGTERM", child.exitCode === 0, { code: child.exitCode, stderr });

  // Deliberate failing case: Jcode owns the per-model effort ladder, so a tier its provider rejects
  // must end the launch rather than leave a seat running at an effort nobody chose. The refusal has
  // to NAME the model, or an operator cannot tell which ladder refused them.
  const refusedLog = join(root, "refused.jsonl");
  const refused = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: refusedLog,
      FAKE_JCODE_REFUSE_EFFORT: "xhigh",
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "refusedpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_MODEL: "fake-model",
      COTAL_VARIANT: "xhigh",
      COTAL_CONTROL_SOCKET: join(root, "refused-control.sock"),
      COTAL_CONTROL_TOKEN: "refused-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let refusedErr = "";
  refused.stderr?.on("data", (chunk: Buffer) => (refusedErr += chunk.toString()));
  await Promise.race([once(refused, "exit"), sleep(20_000)]);
  const refusedCode = refused.exitCode;
  if (refusedCode === null) refused.kill("SIGKILL"); // only reachable if the refusal was swallowed; do not leak the seat
  // `exitCode` is null while the child is STILL RUNNING, and `null !== 0` reads as a refusal — so a
  // seat that swallowed the rejection and stayed up would pass this cell. Demand a real exit with a
  // real failure status. (Measured: mutation-proof graded the swallow-the-refusal mutant WRONG-RED
  // against the looser form, because this cell went green for a host that never exited at all.)
  check("a tier the provider refuses ends the launch", refusedCode !== null && refusedCode !== 0, { code: refusedCode, stderr: refusedErr });
  check("the refusal names the tier and the model", /"xhigh"/.test(refusedErr) && /"fake-model"/.test(refusedErr), refusedErr);
  const refusedEntries = readFileSync(refusedLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{ ev: string; frame?: { req?: string; no_reply?: boolean } }>;
  check(
    "a seat whose effort was refused never takes a turn",
    !refusedEntries.some((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply),
    refusedEntries.filter((entry) => entry.ev === "request").map((entry) => entry.frame?.req),
  );

  // Deliberate failing case: project MCP files would override Jcode's private cotal config, so the
  // host must refuse before it starts an API bridge rather than silently loading another server.
  writeFileSync(join(root, ".mcp.json"), '{"mcpServers":{}}');
  const blocked = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: join(root, "should-not-exist.jsonl"),
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "blocked",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "blocked-control.sock"),
      COTAL_CONTROL_TOKEN: "blocked-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let blockedErr = "";
  blocked.stderr?.on("data", (chunk: Buffer) => (blockedErr += chunk.toString()));
  await Promise.race([once(blocked, "exit"), sleep(10_000)]);
  check("project MCP config is refused rather than overlaid", blocked.exitCode !== 0 && /Jcode host startup failed \(project_mcp_config\)/.test(blockedErr), blockedErr);
  console.log(`\nJCODE HOST SMOKE PASSED (${pass} checks)`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await operator?.stop().catch(() => {});
  nats.kill("SIGKILL");
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
}

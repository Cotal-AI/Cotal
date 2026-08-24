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
  // Every seat this operator ever SAW announce itself. A launch that must fail is graded on the
  // outcome an operator cares about — that no such seat ever appeared on the roster — not merely on
  // the exit status of the process that was supposed to produce it.
  const announced = new Set<string>();
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (event.type === "offline") return;
    announced.add(event.presence.card.name);
    if (event.presence.card.name === "jcodepeer") peerId = event.presence.card.id;
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

  // Real Jcode can complete its first readiness turn against the pre-MCP tool snapshot, then rebuild
  // that snapshot once the cotal server connects. The host gets exactly one second proof turn: enough
  // to cross the measured race, never an open-ended wait that turns a missing bridge into a launch.
  const raceLog = join(root, "readiness-race.jsonl");
  const race = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: raceLog,
      FAKE_JCODE_ORIENTATION_DELAY_TURNS: "1",
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "racepeer",
      COTAL_ID: "racepeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "race-control.sock"),
      COTAL_CONTROL_TOKEN: "race-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let raceErr = "";
  race.stderr?.on("data", (chunk: Buffer) => (raceErr += chunk.toString()));
  await Promise.race([
    once(race, "exit"),
    waitFor("readiness-race peer", () => announced.has("racepeer") ? true : undefined),
  ]);
  const raceEntries = readFileSync(raceLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{ ev: string; frame?: { req?: string; content?: string; no_reply?: boolean } }>;
  const raceTurns = raceEntries.filter((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply && String(entry.frame?.content).includes("cotal_orientation"));
  check("a first-turn MCP snapshot race is retried once", announced.has("racepeer") && raceTurns.length === 2, { code: race.exitCode, turns: raceTurns });
  race.kill("SIGTERM");
  await Promise.race([once(race, "exit"), sleep(10_000)]);
  check("the recovered readiness launch exits cleanly", race.exitCode === 0, { code: race.exitCode, stderr: raceErr });

  // Permanent absence remains terminal after the bounded second proof; the retry is not a fallback.
  const absentLog = join(root, "readiness-absent.jsonl");
  const absent = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: absentLog,
      FAKE_JCODE_NEVER_ORIENTATION: "1",
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "absentpeer",
      COTAL_ID: "absentpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "absent-control.sock"),
      COTAL_CONTROL_TOKEN: "absent-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let absentErr = "";
  absent.stderr?.on("data", (chunk: Buffer) => (absentErr += chunk.toString()));
  await Promise.race([once(absent, "exit"), sleep(20_000)]);
  const absentCode = absent.exitCode;
  if (absentCode === null) absent.kill("SIGKILL");
  const absentEntries = readFileSync(absentLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{ ev: string; frame?: { req?: string; content?: string; no_reply?: boolean } }>;
  const absentTurns = absentEntries.filter((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply && String(entry.frame?.content).includes("cotal_orientation"));
  check("a permanently absent cotal tool gets exactly two readiness turns", absentTurns.length === 2, absentTurns);
  check("a permanently absent cotal tool ends the launch", absentCode !== null && absentCode !== 0, { code: absentCode, stderr: absentErr });
  check("a permanently absent cotal tool never reaches the roster", !announced.has("absentpeer"), [...announced]);

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
  // The tier and the model say what was rejected; only the provider's own list says what to ask for
  // instead. Losing it turns a self-service fix into a log-dig.
  check("the refusal carries the ladder the provider would accept", /available: low, medium, high/.test(refusedErr), refusedErr);
  check("a seat whose effort was refused never reaches the roster", !announced.has("refusedpeer"), [...announced]);
  const refusedEntries = readFileSync(refusedLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{ ev: string; frame?: { req?: string; no_reply?: boolean } }>;
  check(
    "a seat whose effort was refused never takes a turn",
    !refusedEntries.some((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply),
    refusedEntries.filter((entry) => entry.ev === "request").map((entry) => entry.frame?.req),
  );

  // Deliberate failing case, and the adversarial half of the one above. The host renders its OWN
  // effort refusal in full, and redacts every other startup error to a fixed code — because the SDK
  // appends the dying child's last stderr to those, and that can be anything the provider printed.
  // Those two rules meet here: a child whose stderr FORGES the refusal's wording must still be
  // redacted. The exception is keyed to messages this host composes (the refusal is the WHOLE
  // message, from its first character), never to text appearing somewhere in a message — the second
  // is a key that captured stderr can reach, and reaching it is all a leak needs.
  const canary = "PROVIDER-TOKEN-a4c1f0d2-DO-NOT-PRINT";
  const forgery = `jcode connector: reasoning effort "high" was refused for model "x" — ${canary}`;
  const forged = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: join(root, "forged.jsonl"),
      FAKE_JCODE_STARTUP_STDERR: forgery,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "forgedpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "forged-control.sock"),
      COTAL_CONTROL_TOKEN: "forged-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let forgedErr = "";
  forged.stderr?.on("data", (chunk: Buffer) => (forgedErr += chunk.toString()));
  await Promise.race([once(forged, "exit"), sleep(30_000)]);
  const forgedCode = forged.exitCode;
  if (forgedCode === null) forged.kill("SIGKILL");
  check("a child that dies during startup still ends the launch", forgedCode !== null && forgedCode !== 0, { code: forgedCode, stderr: forgedErr });
  // The leak is asserted BEFORE the shape of what replaces it: both cells fail when the exception
  // widens, and whichever runs first is the one that names the defect. "A token reached the
  // terminal" is the defect; "the fatal line lost its fixed-code form" is a symptom of it.
  check("child stderr forging the refusal's wording does not reach the operator", !forgedErr.includes(canary), forgedErr);
  check("captured child stderr stays redacted to a fixed code", /Jcode host startup failed \((?:startup_failed|startup_timeout)\)/.test(forgedErr), forgedErr);
  check("a seat whose harness died never reaches the roster", !announced.has("forgedpeer"), [...announced]);

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

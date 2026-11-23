import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { configFromEnv, MeshAgent } from "@cotal-ai/connector-core";
import { CotalEndpoint, PERSONA_SOURCE_META_KEY, isReachable, personaSourceRef, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, skipSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { recordMesh } from "@cotal-ai/workspace";

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "cotal-persona-running-"));
const project = join(root, "project");
const catalog = join(project, ".cotal", "agents");
mkdirSync(catalog, { recursive: true });
const sample = file(join(root, "scope.md"), "scope");
if (personaSourceRef(sample) === undefined) skipSuite("filesystem-scoped persona matching requires Linux boot and inode identity");
const env = {
  HOME: root, USERPROFILE: root, COTAL_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
  PATH: process.env.PATH, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
};
process.env.COTAL_HOME = env.COTAL_HOME;
const space = "persona-lab";
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(root, SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
teardownOnSignal(broker, store);

async function listRunning(): Promise<string> {
  const bin = join(import.meta.dirname, "..", "dist", "cotal.js");
  const { stdout } = await promisify(execFile)(process.execPath, [bin, "personas", "list", "--running", "--space", space], {
    cwd: project, env, encoding: "utf8", timeout: 30_000,
  });
  assert.match(stdout, /^Mesh: persona-lab$/m);
  return stdout;
}

const sessions: (MeshAgent | CotalEndpoint)[] = [];
async function startSession(name: string, file?: string): Promise<MeshAgent> {
  const launch = { COTAL_NAME: name, COTAL_AGENT_FILE: file, COTAL_SERVERS: server, COTAL_SPACE: space };
  const agent = new MeshAgent(configFromEnv(launch), launch);
  sessions.push(agent);
  await Promise.all([agent.start(), agent.waitUntilConnected()]);
  return agent;
}

function file(path: string, name: string, extra = ""): string {
  writeFileSync(path, `---\nname: ${name}\n${extra}---\n`);
  return path;
}

try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: server, space });
  recordMesh({ space, server, root: project, mode: "open", ts: new Date().toISOString() });

  const mismatch = file(join(catalog, "mismatch.md"), "displayed");
  const control = file(join(catalog, "control.md"), "control");
  file(join(catalog, "duplicate.md"), "displayed");
  const external = file(join(catalog, "external.md"), "external");
  file(join(catalog, "joiner.md"), "joiner");
  linkSync(mismatch, join(catalog, "alias.md"));
  const running = await startSession("displayed", mismatch);
  await startSession("control", control);
  // A file outside this catalog with the same basename and display name supplies no match.
  await startSession("external", file(join(root, "external.md"), "external", `${PERSONA_SOURCE_META_KEY}: ${personaSourceRef(external)}\n`));
  await startSession("joiner");
  const listed = await listRunning();
  check("a different display name still marks the source catalog entry running", /^mismatch\s+● running$/m.test(listed), listed);
  check("a matching display name still works", /^control\s+● running$/m.test(listed), listed);
  check("unrelated files and fileless sessions do not match, even with colliding names or frontmatter metadata",
    ["alias", "duplicate", "external", "joiner"].every((name) => new RegExp(`^${name}\\s+○ not running$`, "m").test(listed)), listed);

  await running.ep.setCardName("renamed");
  const renamed = await listRunning();
  check("renaming a running session keeps the source match", /^mismatch\s+● running$/m.test(renamed), renamed);
  renameSync(mismatch, join(root, "original.md"));
  file(mismatch, "displayed");
  const replaced = await listRunning();
  check("a different file at the same path is not mistaken for the launched file", /^mismatch\s+○ not running$/m.test(replaced), replaced);
  renameSync(join(root, "original.md"), mismatch);
  const legacy = new CotalEndpoint({
    servers: server, space, channels: [], consume: false, watchPresence: false,
    card: { name: "duplicate", kind: "agent" },
  });
  sessions.push(legacy);
  await legacy.start();
  const partial = await listRunning();
  check("unattributed live presence neither proves nor rules out a persona by name",
    /^duplicate\s+\? running status unknown$/m.test(partial) && /^mismatch\s+● running$/m.test(partial), partial);
  await legacy.stop();
  await running.stop();
  const stopped = await listRunning();
  check("offline sessions no longer count as running or unattributed",
    /^mismatch\s+○ not running$/m.test(stopped) && /^duplicate\s+○ not running$/m.test(stopped), stopped);
} finally {
  try { await Promise.allSettled(sessions.map((session) => session.stop())); }
  finally { await killAndAwaitExit(broker); }
}
finish();

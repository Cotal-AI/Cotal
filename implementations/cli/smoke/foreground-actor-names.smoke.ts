import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { emitSentinel, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// The real foreground command re-executes its provider's bearer command before launch.
// This fixture studies allocation/material custody, not token issuance or authenticated joins.
if (process.argv[2] === "agent-bearer") {
  console.log("foreground-names-fixture-bearer");
  process.exit(0);
}
if (process.argv[2] === "worker") {
  await import("../src/index.js");
  const { runCli } = await import("../src/command.js");
  const { registry, eventChannel } = await import("@cotal-ai/core");
  type Connector = import("@cotal-ai/core").Connector;
  const { cotalAuthProvider } = await import("@cotal-ai/auth");
  registry.unregister("auth-provider", cotalAuthProvider.name);
  const provisioningDouble: typeof cotalAuthProvider = {
    ...cotalAuthProvider,
    async postAgentProvisioning({ actor }: { actor: string }) {
      const response = await fetch(process.env.FOREGROUND_NAMES_URL!, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor }),
      });
      if (!response.ok) throw new Error('foreground actor material for "denied" is already held');
      return response.json();
    },
  };
  registry.register(provisioningDouble);
  const connector: Connector = {
    kind: "connector", name: "foreground-names-fixture", requires: [], eventChannel,
    buildLaunch: (options) => ({
      command: process.execPath,
      args: ["-e", "console.log('FIXTURE_READY '+process.env.COTAL_NAME+' '+process.env.COTAL_ACTOR+' '+process.env.COTAL_BEARER_ACTOR);process.stdin.on('data',()=>process.exit(0));process.stdin.resume();"],
      env: {
        COTAL_NAME: options.name,
        COTAL_ACTOR: options.userAuth?.actor ?? "",
        COTAL_BEARER_ACTOR: options.userAuth?.bearerCmd[options.userAuth.bearerCmd.indexOf("--actor") + 1] ?? "",
      },
    }),
  };
  registry.register(connector);
  // Direct foreground execution. A bare spawn is a managed attachment, which needs terminals.
  await runCli(registry, ["spawn", "--foreground", ...process.argv.slice(3)]);
  process.exit(process.exitCode ?? 0);
}

const home = mkdtempSync(join(tmpdir(), "cotal-foreground-names-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-foreground-names-root-"));
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}foreground-names-js-`));
process.env.COTAL_HOME = home;
const { isReachable, mintLifecycleUid } = await import("@cotal-ai/core");
const { recordMesh, agentSecretFilePaths } = await import("@cotal-ai/workspace");
const owner = `u_${"a".repeat(26)}`;
const granted = new Set<string>();
const requests: string[] = [];
const provisioning = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const { actor } = JSON.parse(Buffer.concat(chunks).toString()) as { actor: string };
  requests.push(actor);
  response.setHeader("content-type", "application/json");
  if (actor === "denied") {
    response.statusCode = 403;
    response.end('{"error":"fixture_denied"}');
  } else if (granted.has(actor)) {
    response.end('{"exists":true}');
  } else {
    granted.add(actor);
    response.end(JSON.stringify({ actor, owner, lifecycleUid: mintLifecycleUid(), actorToken: "fixture-actor-token", sentinelCreds: "fixture-sentinel", allowSubscribe: [], allowPublish: [] }));
  }
});
await new Promise<void>((resolve) => provisioning.listen(0, "127.0.0.1", resolve));
const provisioningUrl = `http://127.0.0.1:${(provisioning.address() as AddressInfo).port}`;
const portFinder = createServer();
await new Promise<void>((resolve) => portFinder.listen(0, "127.0.0.1", resolve));
const port = (portFinder.address() as AddressInfo).port;
await new Promise<void>((resolve) => portFinder.close(() => resolve()));
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
teardownOnSignal(broker, store);
const server = `nats://127.0.0.1:${port}`;
const space = "foregroundnames";
recordMesh({ space, server, root, mode: "user", origin: "manual", policy: { events: "required" }, userAuth: {
  provider: "cotal", idp: { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example" },
  endpoints: { url: provisioningUrl, agentProvisioningUrl: provisioningUrl }, remote: true,
}, ts: new Date().toISOString() } as never);
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const persona = join(root, ".cotal", "agents", "default.md");
const writePersona = (name: string) => writeFileSync(persona, `---\nname: ${name}\nagent: foreground-names-fixture\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\nFixture only.\n`);
writePersona("default_agent");
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: join(home, "home"), COTAL_HOME: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", NO_COLOR: "1", FOREGROUND_NAMES_URL: provisioningUrl,
};
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) mkdirSync(env[key]!, { recursive: true });
type Worker = { child: ChildProcessWithoutNullStreams; output: string; ready: Promise<boolean>; closed: Promise<number | null>; exited: boolean };
const workers: Worker[] = [];
function launch(extra: string[] = []): Worker {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "worker", ...extra], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let complete!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { complete = resolve; });
  const worker: Worker = { child, output: "", ready, closed: Promise.resolve(null), exited: false };
  const timer = setTimeout(() => complete(false), 15_000);
  const collect = (chunk: Buffer) => {
    worker.output += chunk.toString();
    if (worker.output.includes("FIXTURE_READY ")) { clearTimeout(timer); complete(true); }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  worker.closed = new Promise((resolve) => {
    child.once("error", () => { clearTimeout(timer); complete(false); worker.exited = true; resolve(null); });
    child.once("close", (code) => { clearTimeout(timer); complete(false); worker.exited = true; resolve(code); });
  });
  workers.push(worker);
  return worker;
}
async function stop(worker: Worker): Promise<void> {
  if (worker.exited) return;
  worker.child.stdin.write("stop\n");
  const timer = setTimeout(() => {
    if (!worker.exited) {
      try {
        if (process.platform === "win32") worker.child.kill("SIGKILL");
        else process.kill(-worker.child.pid!, "SIGKILL");
      } catch { /* exact owned child/group already exited */ }
    }
  }, 5_000);
  await worker.closed;
  clearTimeout(timer);
}
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
let passed = false;
try {
  let reachable = false;
  for (let attempt = 0; attempt < 50 && !reachable; attempt++) {
    reachable = await isReachable(server);
    if (!reachable) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(reachable, "fixture broker is reachable");
  const first = launch();
  assert(await first.ready, `first implicit foreground launch reaches a real child: ${first.output}`);
  assert(first.output.split(/\r?\n/).includes("FIXTURE_READY default_agent default_agent default_agent"), "first implicit foreground launch uses the available base name in every identity field");
  const original = agentSecretFilePaths(root, space, "default_agent");
  const before = { token: digest(original.actorToken), sentinel: digest(original.sentinelCreds), claim: digest(original.actorToken + ".launch.lock") };
  const second = launch();
  assert(await second.ready, `implicit foreground launch allocates a fresh actor while prior material is held: ${second.output}`);
  assert(second.output.split(/\r?\n/).includes("FIXTURE_READY default_agent_2 default_agent_2 default_agent_2"), "second implicit foreground launch uses the numbered actor in every identity field");
  assert.deepEqual({ token: digest(original.actorToken), sentinel: digest(original.sentinelCreds), claim: digest(original.actorToken + ".launch.lock") }, before, "second launch preserves every original material and claim byte");
  const beforePinned = requests.length;
  const pinned = launch(["--name", "default_agent"]);
  assert.equal(await pinned.ready, false, "explicit held identity never launches a replacement");
  assert.equal(await pinned.closed, 2, `explicit held identity still refuses: ${pinned.output}`);
  assert(/Outcome: refused/.test(pinned.output) && /Code:\s+CONFLICT/.test(pinned.output), `a held identity is a refusal, not an unconfirmed outcome: ${pinned.output}`);
  assert(pinned.output.includes("foreground actor material") && requests.length === beforePinned, "explicit collision refuses before remote provisioning");
  await stop(first);
  const third = launch();
  assert(await third.ready, `implicit launch skips an existing remote grant as well as a local held name: ${third.output}`);
  assert(third.output.split(/\r?\n/).includes("FIXTURE_READY default_agent_3 default_agent_3 default_agent_3"), "remote grant and held second name allocate the next fresh actor in every identity field");
  assert.equal(requests.filter((name) => name === "default_agent").length, 2, "remote existing-grant response is observed without reissuing it");
  writePersona("denied");
  const beforeDenied = requests.length;
  const denied = launch();
  assert.equal(await denied.ready, false, "ordinary authorization refusal never launches");
  // The provider's failure reaches the command unclassified, so its outcome is reported unconfirmed.
  assert.equal(await denied.closed, 3, `ordinary authorization refusal remains an error: ${denied.output}`);
  assert.deepEqual(requests.slice(beforeDenied), ["denied"], "ordinary authorization refusal is not retried under another actor");
  console.log("FOREGROUND ACTOR NAMING: all real-process collision controls passed");
  emitSentinel({ passed: 16, failed: 0 });
  passed = true;
} finally {
  for (const worker of workers) await stop(worker);
  if (broker.exitCode === null && broker.signalCode === null) {
    const closed = new Promise<void>((resolve) => broker.once("close", () => resolve()));
    broker.kill("SIGKILL");
    await closed;
  }
  await new Promise<void>((resolve) => provisioning.close(() => resolve()));
  if (passed && workers.every((worker) => worker.exited)) {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
}

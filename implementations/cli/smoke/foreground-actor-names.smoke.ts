import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const { registry, eventChannel, AGENT_LIFECYCLE_HELD, agentLifecycleHeld, EpEnvelopeError } = await import("@cotal-ai/core");
  type Connector = import("@cotal-ai/core").Connector;
  const { cotalAuthProvider } = await import("@cotal-ai/auth");
  // With no FOREGROUND_NAMES_URL the real provider runs. This fixture has no sign-in, so it refuses
  // before any request.
  if (process.env.FOREGROUND_NAMES_URL) {
    registry.unregister("auth-provider", cotalAuthProvider.name);
    // The provisioning double throws what the real provider throws for each answer: a typed held
    // 409 is a conflict carrying the host's answer, no other failure carries a code, and a 401 names
    // the login. Its release lists and deletes the way the real provider does.
    const url = process.env.FOREGROUND_NAMES_URL!;
    const provisioningDouble: typeof cotalAuthProvider = {
      ...cotalAuthProvider,
      async postAgentProvisioning({ actor }: { actor: string }) {
        const response = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor }),
        });
        if (response.ok) return response.json();
        const body = await response.json().catch(() => ({}));
        const reason = (body as { error?: string }).error;
        if (response.status === 401)
          throw new Error(`the mesh refused this login for agent provisioning: ${reason} - your session may have expired; re-run \`cotal login --idp https://idp.example/api/auth\``);
        const held = agentLifecycleHeld(body);
        if (response.status === 409 && held)
          throw new EpEnvelopeError("conflict", `the mesh did not provision agent "${actor}": ${reason}`, [{ kind: AGENT_LIFECYCLE_HELD, code: "AGENT_LIFECYCLE_HELD", actor, held }], "not-executed");
        throw Object.assign(new Error(`the mesh's agent-provisioning endpoint answered HTTP ${response.status}: ${reason}; whether "${actor}" was provisioned is unknown`), { status: response.status, reason });
      },
      async releaseAgentLifecycle({ lifecycleUid, actor }: { lifecycleUid: string; actor?: string }) {
        const { agents } = await (await fetch(`${url}/agents`)).json() as { agents: { id: string; lifecycleUid: string; actor: string; revoked: boolean }[] };
        const row = agents.find((r) => r.lifecycleUid === lifecycleUid && r.actor === actor && !r.revoked);
        if (!row) return { outcome: "not-found" as const };
        const answer = await (await fetch(`${url}/agents/${row.id}`, { method: "DELETE" })).json() as { removed?: boolean };
        return { outcome: answer.removed ? "revoked" as const : "already-revoked" as const, agentId: row.id, actor: row.actor };
      },
      async postAgentEnrollment({ url }: { url: string }) {
        const response = await fetch(url, { method: "POST" });
        if (!response.ok) throw new Error("fixture enrollment refused");
        return response.json();
      },
    };
    registry.register(provisioningDouble);
  }
  const connector: Connector = {
    kind: "connector", name: "foreground-names-fixture", requires: [], eventChannel,
    buildLaunch: (options) => ({
      command: process.execPath,
      args: ["-e", "console.log('FIXTURE_BEARER '+process.env.COTAL_BEARER_CMD);console.log('FIXTURE_CREDS '+process.env.FIXTURE_CREDS_PATH);console.log('FIXTURE_READY '+process.env.COTAL_NAME+' '+process.env.COTAL_ACTOR+' '+process.env.COTAL_BEARER_ACTOR);process.stdin.on('data',()=>process.exit(0));process.stdin.resume();"],
      env: {
        COTAL_NAME: options.name,
        COTAL_ACTOR: options.userAuth?.actor ?? "",
        COTAL_BEARER_ACTOR: options.userAuth?.bearerCmd[options.userAuth.bearerCmd.indexOf("--actor") + 1] ?? "",
        COTAL_BEARER_CMD: JSON.stringify(options.userAuth?.bearerCmd ?? []),
        FIXTURE_CREDS_PATH: options.creds ?? "",
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
const { createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams } = await import("@cotal-ai/core");
const { recordMesh, agentCredsKey, agentSecretFilePaths, agentSecretKeyForFile, authDir, materializeSecretToFile, saveSpaceAuth, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { bootBroker } = await import("../../manager/smoke/_boot-broker.js");
const owner = `u_${"a".repeat(26)}`;
const idp = { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example" };
const granted = new Set<string>();
const requests: string[] = [];
const redeemed: string[] = [];
const released: string[] = [];
// A registration the host still holds for "stale_name" at a lifecycle that does not run; the first
// request after its release is answered "still retiring", as a mesh answers while it retires.
const liveUid = mintLifecycleUid();
const registrations = new Map([["agt_stale_name", { id: "agt_stale_name", lifecycleUid: mintLifecycleUid(), actor: "stale_name", revoked: false, connection: "offline" }]]);
let retiringAnswers = 1;
const provisioning = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  response.setHeader("content-type", "application/json");
  // A one-time enrollment: each redemption issues a fresh grant for the actor its path names.
  const enrollment = /^\/enroll\/([a-z0-9_]+)$/.exec(request.url ?? "");
  if (enrollment) {
    redeemed.push(enrollment[1]);
    response.end(JSON.stringify({
      space, brokerAccess: { kind: "direct", url: server }, authServiceUrl: provisioningUrl, idp,
      actor: enrollment[1], owner, lifecycleUid: mintLifecycleUid(), actorToken: "fixture-enrolled-token", sentinelCreds: "fixture-enrolled-sentinel", allowSubscribe: [], allowPublish: [],
    }));
    return;
  }
  // The agent list and the release of one registration, as the release contract documents.
  if (request.method === "GET" && request.url === "/agents") {
    response.end(JSON.stringify({ health: "live", stockRegistration: "available", scope: "own", agents: [...registrations.values()] }));
    return;
  }
  if (request.method === "DELETE" && request.url?.startsWith("/agents/")) {
    const row = registrations.get(request.url.slice("/agents/".length));
    released.push(row?.actor ?? "?");
    if (row) row.revoked = true;
    response.end(JSON.stringify({ ok: true, removed: true }));
    return;
  }
  const { actor } = JSON.parse(Buffer.concat(chunks).toString()) as { actor: string };
  requests.push(actor);
  const stale = registrations.get(`agt_${actor}`);
  if (actor.startsWith("live_name") && actor !== "live_name_2") {
    response.statusCode = 409;
    response.end(JSON.stringify({ error: "fixture_live", code: "AGENT_LIFECYCLE_HELD", held: { agentId: `agt_${actor}`, lifecycleUid: liveUid, custody: { state: "known", kind: "foreground" }, presence: "online" } }));
  } else if (stale && !stale.revoked) {
    response.statusCode = 409;
    response.end(JSON.stringify({ error: "fixture_stale", code: "AGENT_LIFECYCLE_HELD", held: { agentId: stale.id, lifecycleUid: stale.lifecycleUid, custody: { state: "absent" }, presence: "offline" } }));
  } else if (stale && retiringAnswers-- > 0) {
    response.statusCode = 409;
    response.end('{"error":"that agent name is still retiring; retry in a few minutes"}');
  } else if (actor === "denied") {
    response.statusCode = 403;
    response.end('{"error":"fixture_denied"}');
  } else if (actor === "expired") {
    response.statusCode = 401;
    response.end('{"error":"fixture_expired"}');
  } else if (actor === "unavailable") {
    response.statusCode = 503;
    response.end('{"error":"fixture_unavailable"}');
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
  provider: "cotal", idp,
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
  DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off",
};
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) mkdirSync(env[key]!, { recursive: true });
type Worker = { child: ChildProcessWithoutNullStreams; output: string; ready: Promise<boolean>; closed: Promise<number | null>; exited: boolean };
const workers: Worker[] = [];
function launch(extra: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, entry = process.argv[1], cwd = root): Worker {
  const child = spawn(process.execPath, [...process.execArgv, entry, "worker", ...extra], { cwd, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], detached: true });
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
const staticRoot = mkdtempSync(join(tmpdir(), "cotal-foreground-names-static-"));
let staticBroker: Awaited<ReturnType<typeof bootBroker>> | undefined;
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
  // An enrollment is redeemed before the actor's material is claimed. A held actor found after that
  // is not a refusal: the one-time enrollment is already spent.
  const beforeEnrolled = requests.length;
  const enrolled = launch(["--name", "default_agent_2", "--space", space], { COTAL_ENROLLMENT_URL: `${provisioningUrl}/enroll/default_agent_2` });
  assert.equal(await enrolled.ready, false, "an enrollment for a held actor never launches a replacement");
  assert.equal(await enrolled.closed, 3, `a held actor after a redeemed enrollment is not reported as a refusal: ${enrolled.output}`);
  assert(/Outcome: unknown/.test(enrolled.output) && /Code:\s+OPERATION_UNKNOWN/.test(enrolled.output) && enrolled.output.includes("foreground actor material"), `the spent enrollment's outcome is reported unconfirmed: ${enrolled.output}`);
  assert(redeemed.join() === "default_agent_2" && requests.length === beforeEnrolled, "the enrollment was redeemed once and nothing was provisioned besides it");
  // The real provider, with no sign-in on this machine, refuses before it sends anything.
  writePersona("signed_out");
  const beforeSignedOut = requests.length;
  const signedOut = launch([], { FOREGROUND_NAMES_URL: "" });
  assert.equal(await signedOut.ready, false, "a launch with no sign-in never launches");
  assert.equal(await signedOut.closed, 2, `a launch with no sign-in exits as a refusal: ${signedOut.output}`);
  assert(/Outcome: refused/.test(signedOut.output) && /Code:\s+AUTH_REQUIRED/.test(signedOut.output) && signedOut.output.includes("cotal login --idp"), `the real provider's missing sign-in is a sign-in refusal: ${signedOut.output}`);
  assert.equal(requests.length, beforeSignedOut, "a launch with no sign-in sends no provisioning request");
  writePersona("denied");
  const beforeDenied = requests.length;
  const denied = launch();
  assert.equal(await denied.ready, false, "ordinary authorization refusal never launches");
  // The endpoint is the deployment's, and nothing says what its 403 left behind, so the outcome
  // stays unconfirmed.
  assert.equal(await denied.closed, 3, `an endpoint 403's outcome is unconfirmed: ${denied.output}`);
  assert(/Outcome: unknown/.test(denied.output) && /Code:\s+OPERATION_UNKNOWN/.test(denied.output) && denied.output.includes("fixture_denied"), `the endpoint's 403 is reported unconfirmed with its own reason: ${denied.output}`);
  assert.deepEqual(requests.slice(beforeDenied), ["denied"], "ordinary authorization refusal is not retried under another actor");
  writePersona("expired");
  const beforeExpired = requests.length;
  const expired = launch();
  assert.equal(await expired.ready, false, "a refused login never launches");
  assert.equal(await expired.closed, 3, `an endpoint 401's outcome is unconfirmed: ${expired.output}`);
  assert(/Outcome: unknown/.test(expired.output) && /Code:\s+OPERATION_UNKNOWN/.test(expired.output) && expired.output.includes("cotal login --idp"), `the endpoint's 401 is reported unconfirmed and still names the login: ${expired.output}`);
  assert.deepEqual(requests.slice(beforeExpired), ["expired"], "a refused login is not retried under another actor");
  writePersona("unavailable");
  const beforeUnavailable = requests.length;
  const unavailable = launch();
  assert.equal(await unavailable.ready, false, "a failing endpoint never launches");
  // A 5xx says nothing about what the endpoint did, so its outcome stays unconfirmed.
  assert.equal(await unavailable.closed, 3, `a failing endpoint's outcome is unconfirmed: ${unavailable.output}`);
  assert(/Outcome: unknown/.test(unavailable.output) && /Code:\s+OPERATION_UNKNOWN/.test(unavailable.output), `a 5xx stays an unknown outcome: ${unavailable.output}`);
  assert.deepEqual(requests.slice(beforeUnavailable), ["unavailable"], "a failing endpoint is not retried under another actor");
  // A name the host holds at a lifecycle that does not run is released by its exact UID and the
  // agent starts under that same name, once the mesh stops saying it is still retiring.
  writePersona("stale_name");
  const staleStart = requests.length;
  const stale = launch(["--name", "stale_name"]);
  assert(await stale.ready, `a name held by a lifecycle that does not run starts after its release: ${stale.output}`);
  assert(stale.output.split(/\r?\n/).includes("FIXTURE_READY stale_name stale_name stale_name"), "the released name runs under that same name");
  assert.deepEqual([released, requests.slice(staleStart)], [["stale_name"], ["stale_name", "stale_name", "stale_name"]], "one release, then the same name asked for until it was granted");
  await stop(stale);
  // A name whose holder is online is never released: an implicit launch takes the next number,
  // and an explicit one launches nothing and says where it runs, as a success.
  writePersona("live_name");
  const liveStart = requests.length;
  const nextFree = launch();
  assert(await nextFree.ready, `an implicit launch past an online holder runs: ${nextFree.output}`);
  assert(nextFree.output.split(/\r?\n/).includes("FIXTURE_READY live_name_2 live_name_2 live_name_2"), "it runs under the next number");
  assert.deepEqual([released.length, requests.slice(liveStart)], [1, ["live_name", "live_name_2"]], "the online holder was not released");
  await stop(nextFree);
  const named = launch(["--name", "live_name"]);
  assert.equal(await named.ready, false, "an explicit name whose holder is online launches nothing new");
  assert.equal(await named.closed, 0, `it is a success, not a refusal: ${named.output}`);
  assert(/live_name is already running/.test(named.output) && released.length === 1, `it says the agent already runs, and released nothing: ${named.output}`);
  // An install can replace the bin link a seat was started through: get.cotal.ai writes a shell
  // launcher over `~/.local/bin/cotal`, which `npm i -g` had made a link to `dist/cotal.js`. The seat
  // runs its bearer command for every renewal for as long as it lives, so that command must name the
  // file the link resolved to. Skipped on Windows, where unprivileged `symlinkSync` is EPERM.
  const relinkChecks = process.platform === "win32" ? 0 : 2;
  if (relinkChecks) {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const link = join(bin, "foreground-actor-names.smoke.ts");
    symlinkSync(fileURLToPath(import.meta.url), link);
    writePersona("relinked");
    const relinked = launch([], {}, link);
    assert(await relinked.ready, `a launch through a bin link reaches a real child: ${relinked.output}`);
    const bearerCmd = JSON.parse(/^FIXTURE_BEARER (.*)$/m.exec(relinked.output)?.[1] ?? "[]") as string[];
    rmSync(link);
    writeFileSync(link, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(link, 0o755);
    const renewal = spawnSync(bearerCmd[0]!, bearerCmd.slice(1), { cwd: root, env, encoding: "utf8" });
    assert.equal(renewal.stdout.trim(), "foreground-names-fixture-bearer", `the bearer command still runs after an install replaced the bin link: ${JSON.stringify(bearerCmd)} ${renewal.stderr}`);
  }
  // #3857: a static-auth spawn keys its creds by the lifecycle UID it minted, as the manager keys its
  // own spawns. The fixture child joins no presence, so a second spawn started while the first runs
  // lands on the same name, as two real spawns do before the first one joins. Each holds its own file
  // and store row, retiring one leaves the other's in place, and the operator's standing
  // `<name>.creds` is never touched.
  const staticSpace = "foregroundstatic";
  const staticAuth = await createSpaceAuth(staticSpace);
  staticBroker = await bootBroker(staticAuth);
  saveSpaceAuth(authDir(staticRoot), staticAuth);
  await setupSpaceStreams({ servers: staticBroker.servers, space: staticSpace, creds: await mintCreds(staticAuth, newIdentity(), "provisioner") });
  recordMesh({ space: staticSpace, server: staticBroker.servers, root: staticRoot, mode: "auth", origin: "manual", ts: new Date().toISOString() });
  mkdirSync(join(staticRoot, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(staticRoot, ".cotal", "agents", "default.md"), "---\nname: worker\nagent: foreground-names-fixture\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\nFixture only.\n");
  const secrets = workspaceSecretStore(staticRoot);
  const standing = agentSecretFilePaths(staticRoot, staticSpace, "worker").creds;
  const standingKey = agentCredsKey(staticSpace, "worker", { injected: false, root: staticRoot });
  await secrets.put(standingKey, "fixture standing operator credential\n");
  await materializeSecretToFile(secrets, standingKey, standing);
  const standingBefore = digest(standing);
  const credsOf = (worker: Worker) => /^FIXTURE_CREDS (.+)$/m.exec(worker.output)?.[1] ?? "";
  const row = (path: string) => secrets.get(agentSecretKeyForFile(path, staticSpace));
  const spawnA = launch(["--name", "worker", "--space", staticSpace], {}, process.argv[1], staticRoot);
  assert(await spawnA.ready, `a static foreground spawn reaches a real child: ${spawnA.output}`);
  const credsA = credsOf(spawnA);
  const heldA = digest(credsA);
  const spawnB = launch(["--name", "worker", "--space", staticSpace], {}, process.argv[1], staticRoot);
  assert(await spawnB.ready, `a second static foreground spawn reaches a real child: ${spawnB.output}`);
  const credsB = credsOf(spawnB);
  assert([spawnA, spawnB].every((worker) => /^FIXTURE_READY worker /m.test(worker.output)), `both static spawns run under the one name: ${spawnA.output}${spawnB.output}`);
  assert(credsA !== credsB && [credsA, credsB].every((path) => dirname(path) === dirname(standing) && /^worker\.[a-z0-9]+\.creds$/.test(basename(path))), `each static spawn holds its own lifecycle-keyed creds file: ${credsA} ${credsB}`);
  assert.equal(digest(credsA), heldA, "the second spawn leaves the first one's creds file as the first was handed it");
  await stop(spawnB);
  assert(spawnB.output.includes("↩ retired creds for worker (agent exited)") && !existsSync(credsB) && await row(credsB) === undefined, `the second spawn's exit retires its own creds file and store row: ${spawnB.output}`);
  assert(!spawnA.exited && digest(credsA) === heldA && await row(credsA) === readFileSync(credsA, "utf8"), "the first spawn keeps running with its creds file and store row in place");
  assert(digest(standing) === standingBefore && await row(standing) === readFileSync(standing, "utf8"), "the standing worker.creds survives the second spawn's retirement");
  await stop(spawnA);
  assert(!existsSync(credsA) && await row(credsA) === undefined && digest(standing) === standingBefore && await row(standing) !== undefined, `the first spawn's exit retires its own creds and leaves the standing worker.creds: ${spawnA.output}`);
  console.log("FOREGROUND ACTOR NAMING: all real-process collision controls passed");
  emitSentinel({ passed: 51 + relinkChecks, failed: 0 });
  passed = true;
} finally {
  for (const worker of workers) await stop(worker);
  await staticBroker?.stop();
  if (broker.exitCode === null && broker.signalCode === null) {
    const closed = new Promise<void>((resolve) => broker.once("close", () => resolve()));
    broker.kill("SIGKILL");
    await closed;
  }
  await new Promise<void>((resolve) => provisioning.close(() => resolve()));
  if (passed && workers.every((worker) => worker.exited)) {
    rmSync(root, { recursive: true, force: true });
    rmSync(staticRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
}

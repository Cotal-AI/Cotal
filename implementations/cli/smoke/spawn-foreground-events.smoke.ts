/**
 * THE FOREGROUND SPAWN HANDS THE CONNECTOR THE LAUNCH AN ARMED SESSION NEEDS, and this suite exists
 * because it did not.
 *
 * A session's structured event plane is armed by default, and a connector that publishes one needs two
 * things from the launch: the flag, and a workspace root for the emitter's write-ahead log. The
 * manager passed both. This path passed the flag and not the root, so `cotal spawn <persona>
 * --events` failed at launch construction for every armed session while `--detach` worked.
 *
 * NOTHING CAUGHT IT, and the reason is the interesting part. The connector's own suite injects a
 * root in every accepted case, so it proves the connector's contract in isolation and can say
 * nothing about whether a caller honours it. A contract asserted only against itself is how a caller
 * goes missing, so the assertion has to live on the caller's side of the boundary.
 *
 * Real argv through `runCli`, the binary's own dispatch, against a real broker on an OS-assigned
 * loopback port. Open mesh, no trust material on disk, so neither authenticated branch runs: the
 * probe connector records what it was handed and throws, which is after every arming decision and
 * before anything is spawned. Needs `nats-server` on PATH.
 *
 * WHAT IT DOES NOT COVER, stated rather than left to be found. The event GRANT is minted inside the
 * two authenticated branches, which an open mesh does not enter, so the channel landing in
 * `allowPublish` is proved for the manager by `smoke:events-grant` and is not proved here. This
 * suite is about the launch bag and the refusal.
 *
 * THE USER-AUTH DEPARTURE SENTENCE (#1837): the two user-auth arms print DIFFERENT truths after a
 * successful launch. The local arm's cleanup revokes the actor row (`provisionUserForeground` →
 * `provider.revokeAgent`), so "revoked automatically when this process exits" is true there. The
 * REMOTE arm's cleanup shreds only this machine's token/sentinel/health files and leaves the
 * mesh-side grant standing (this machine holds no authority to revoke it), so the same sentence
 * there was a promise about revocation that never happens. Both arms are driven here through the
 * real dispatch: the remote arm on a synthetic REMOTE user-mode registry entry with an auth-provider
 * double that answers `postAgentProvisioning` (the login gate and the endpoint are not what this
 * cell studies) and a self-dispatched `agent-bearer` re-exec that succeeds the preflight; the local
 * arm's sentence is asserted by reading the code's own choice against the arm flag, because staging
 * a full local user-auth mesh (trust material + daemon + login) is the user-spawn live suite's job.
 *
 * Run: pnpm smoke:spawn-foreground-events
 */
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickFreePort } from "../../manager/smoke/_free-port.js";
import { openTelemetryIntake } from "./_telemetry-intake.js";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const home = mkdtempSync(join(tmpdir(), "cotal-fg-events-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-fg-events-root-"));
const caller = mkdtempSync(join(tmpdir(), "cotal-fg-events-caller-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";

// The bearer preflight the REMOTE user arm runs re-execs this file with `agent-bearer` as argv[2]
// (the same self-dispatch trick the user-spawn live suite uses). Answer success: the preflight's
// outcome is what the spawn path consumes, not the bearer itself, and this suite does not stage an
// exchange. Must sit before any harness below runs.
if (process.argv[2] === "agent-bearer") {
  console.log("fg-events-bearer");
  process.exit(0);
}

// The composition root, exactly as the binary imports it.
await import("../src/index.js");
const { runCli } = await import("../src/command.js");
const { registry, eventChannel } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
type LaunchOpts = import("@cotal-ai/core").LaunchOpts;
type LaunchSpec = import("@cotal-ai/core").LaunchSpec;
type Connector = import("@cotal-ai/core").Connector;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const captured: LaunchOpts[] = [];
const probe = (name: string, emits: boolean): Connector => ({
  kind: "connector",
  name,
  requires: [],
  ...(emits ? { eventChannel } : {}),
  // Records and stops. Returning a real spec would launch a child and wait on it; the fact under
  // test is what this function RECEIVED, which is already decided by the time it runs.
  buildLaunch: (o: LaunchOpts): LaunchSpec => { captured.push(o); throw new Error("__probe_stop__"); },
});
registry.register(probe("fg-probe-emitter", true));
registry.register(probe("fg-probe-silent", false)); // publishes no event plane
// A probe whose spec really launches, so the spawn body proceeds PAST buildLaunch to its prints
// (the departure sentence prints after a successful buildLaunch, before the child reaps). /bin/true
// exits at once, so the run settles.
const liveProbe: Connector = {
  kind: "connector",
  name: "fg-probe-live",
  requires: [],
  eventChannel,
  buildLaunch: (o: LaunchOpts): LaunchSpec => { captured.push(o); return { command: "/bin/true", args: [], env: {} }; },
};
registry.register(liveProbe);
const binaryProbe: Connector = { ...liveProbe, name: "fg-probe-binary", requires: ["opencode"] };
registry.register(binaryProbe);
// A probe whose child ends the way `--opt` says: `exit <code>`, or killed by `<signal>` (#7043).
const exitProbe: Connector = {
  kind: "connector",
  name: "fg-probe-exit",
  requires: [],
  buildLaunch: (o: LaunchOpts): LaunchSpec => {
    const signal = o.launchOptions?.signal;
    const finish = signal ? `kill -${Number(signal)} $$` : `exit ${Number(o.launchOptions?.code ?? 0)}`;
    return { command: "/bin/sh", args: ["-c", finish], env: {} };
  },
};
registry.register(exitProbe);

mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const persona = join(root, ".cotal", "agents", "probe.md");
writeFileSync(persona, "---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\n---\nbody\n");
writeFileSync(join(root, ".cotal", "config.json"), JSON.stringify({
  connectors: { "fg-probe-emitter": { mcpServers: { alpha: { command: "true" }, beta: { command: "true" } } } },
}));
// A project config that declares servers applies only in a folder the operator trusts. The trust
// record lives in this suite's own config folder.
process.env.XDG_CONFIG_HOME = join(home, "xdg");
const { trustProject } = await import("@cotal-ai/workspace");
trustProject(root);

const port = await pickFreePort();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}fg-events-js-`));
// JetStream on: the spawn path pre-creates this agent's durable footprint before it builds the
// launch, so a stream-less broker refuses long before the connector is reached.
const broker = spawnProcess("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
teardownOnSignal(broker, store);
const server = `nats://127.0.0.1:${port}`;
// The mesh this spawn targets, recorded the way `cotal up` records one: an OPEN mesh, so neither
// authenticated branch runs and the launch reaches the connector with nothing minted.
recordMesh({ space: "fgevents", server, root, mode: "open", ts: new Date().toISOString() } as never);
// The REMOTE user-auth twin (#1837): the exact entry shape `meshes add --mode user --user-auth-file`
// records (remote pins + a pinned agent-provisioning endpoint). `policy` is set so the spawn's
// pre-launch policy refresh short-circuits (a manual entry WITH a policy never fetches). The same
// broker serves both: the user arm's preflight only checks reachability, and the provisioning POST
// never leaves this process (the provider double below answers it).
recordMesh({
  space: "fgremote",
  server,
  root,
  mode: "user",
  origin: "manual",
  policy: { events: "required" },
  userAuth: {
    provider: "cotal",
    idp: { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example" },
    endpoints: { url: "http://127.0.0.1:19000", agentProvisioningUrl: "http://127.0.0.1:19001" },
    remote: true,
  },
  ts: new Date().toISOString(),
} as never);
await new Promise<void>((resolve, reject) => {
  const deadline = Date.now() + 15_000;
  const tick = (): void => {
    const probeSock = spawnProcess("nc", ["-z", "127.0.0.1", String(port)], { stdio: "ignore" });
    probeSock.on("exit", (code) => {
      if (code === 0) resolve();
      else if (Date.now() > deadline) reject(new Error(`broker did not come up on ${server}`));
      else setTimeout(tick, 200);
    });
  };
  tick();
});

/** Real argv through the binary's dispatch. Returns what the connector was handed, or how it stopped. */
async function run(argv: string[]): Promise<{ opts?: LaunchOpts; exited?: number; stderr: string }> {
  const before = captured.length;
  const realExit = process.exit;
  const realErr = console.error;
  const realWrite = process.stderr.write.bind(process.stderr);
  let exited: number | undefined;
  let stderr = "";
  // `c.dim` lines and provenance both land on process.stderr.write, not console.error; the
  // departure sentence is one of them, so both taps are needed to see it.
  const tap = (chunk: unknown): boolean => { stderr += typeof chunk === "string" ? chunk : String(chunk); return true; };
  process.stderr.write = tap as typeof process.stderr.write;
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(" ") + "\n"; };
  // The refusal ends the process. A suite cannot let it, and turning it into a throw is what makes
  // "it refused" an observable outcome rather than a dead run.
  (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
    exited = code ?? 0;
    throw new Error(`__exit__${exited}`);
  }) as never;
  try {
    await runCli(registry, argv);
  } catch { /* the probe's stop, or the stubbed exit */ }
  finally {
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    console.error = realErr;
    process.stderr.write = realWrite;
  }
  return { opts: captured.length > before ? captured[captured.length - 1] : undefined, exited, stderr };
}

/** The open-mesh runs of this suite's original cells: one target, one persona, extra flags. */
// Public --config is now reserved and a bare spawn is a managed attach, so the foreground path is --foreground --file.
const openRun = (extra: string[]): Promise<{ opts?: LaunchOpts; exited?: number; stderr: string }> =>
  run(["spawn", "--foreground", "--file", persona, "--server", server, "--space", "fgevents", ...extra]);

async function checkPersonaRefusals() {
  const binary = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  Object.assign(env, { COTAL_HOME: home, COTAL_NO_PROMPT: "1", COTAL_SKIP_CONNECTOR_SEED: "1" });
  const invoke = (args: string[]) => spawnSync(process.execPath, [binary, "spawn", ...args], {
    cwd: caller, env, encoding: "utf8", timeout: 30_000,
  });
  const selectors = ["--server", server, "--space", "fgevents"];
  const path = join(root, ".cotal", "agents", "edit-control.md");
  const source = '---\nname: "Review Bot"\nagent: opencode\n---\n';
  writeFileSync(path, source);
  for (const mode of [[], ["--dry-run", "--plain"]]) {
    const refused = invoke(["edit-control", "--no-events", ...selectors, ...mode]);
    const retry = refused.stderr.match(/`((?:cotal|pnpm cotal) spawn [^`]+)`/)?.[1];
    check(`a bad frontmatter name gives a ${mode.length ? "preview" : "direct launch"} retry with the same flags`,
      refused.status === 1 && refused.stderr.includes("the persona's frontmatter name cannot be used for launch") &&
      !!retry && retry.includes("spawn edit-control") && retry.includes(`--server ${server}`) &&
      retry.includes("--space fgevents") && retry.includes("--no-events") && retry.includes("--name edit-control") &&
      (mode.length ? retry.includes("--dry-run") && retry.includes("--plain") : !retry.includes("--dry-run")), refused.stderr);
    if (mode.length && retry) {
      const preview = invoke(retry.split(" spawn ")[1]!.split(" "));
      check("the suggested preview succeeds without rewriting the persona",
        preview.status === 0 && /Requested name:\s+edit-control/.test(preview.stdout) && readFileSync(path, "utf8") === source,
        preview.stdout + preview.stderr);
    }
  }
  const launched = await run(["spawn", "edit-control", "--space", "fgevents", "--harness", "fg-probe-live", "--name", "edit-control"]);
  check("the name override launches from the unchanged persona", launched.opts?.name === "edit-control" && readFileSync(path, "utf8") === source, launched.stderr);
  const explicit = invoke(["edit-control", "--dry-run", "--plain", "--name", "Invalid Name", ...selectors]);
  check("a bad explicit name is not blamed on the persona", explicit.status === 1 && explicit.stderr.includes('unsafe name "Invalid Name"') &&
    !explicit.stderr.includes("frontmatter name"), explicit.stderr);
  if (process.platform === "win32") return;
  const marker = "private launch directory";
  const longDir = join(home, `${marker} ${"x".repeat(100)}`);
  mkdirSync(longDir);
  const intake = await openTelemetryIntake();
  try {
    const connector = new URL("../../../extensions/connector-codex/dist/index.js", import.meta.url).href;
    const result = await foregroundCliProbe(binary, connector, caller, {
      ...env, HOME: home, TMPDIR: longDir, COTAL_CODEX_BIN: process.execPath,
      DO_NOT_TRACK: undefined, COTAL_TELEMETRY: "regular", COTAL_TELEMETRY_URL: intake.url,
    }, ["spawn", "--foreground", "--agent", "codex", "--file", persona, ...selectors]);
    const event = intake.received.find(body => body.event === "command");
    check("an overlong control socket path stays in the local launch refusal", result.code === 1 &&
      result.err.includes(marker) && /Point TMPDIR at a shorter directory/.test(result.err.replace(/\s+/g, " ")) &&
      event?.errorCode === "USAGE_INVALID" && event.errorMessage === null && event.errorStack === null &&
      !JSON.stringify(intake.received).includes(marker), result);
  } finally { intake.server.close(); }
  const parentFile = join(realpathSync(caller), "plain-parent");
  writeFileSync(parentFile, "not a directory");
  const fileArgs = ["--file", "plain-parent/nested/persona.md", ...selectors];
  const preview = invoke(["--dry-run", "--json", ...fileArgs]);
  const refusal = preview.stdout && (JSON.parse(preview.stdout) as { error?: { code: string; message: string; remedy?: string } }).error;
  const remedy = "pass the correct persona file path with `--file`";
  check("foreground preview names the blocking persona path component and gives a retry",
    preview.status === 2 && !!refusal && refusal.code === "TARGET_NOT_FOUND" && refusal.message.includes(`${parentFile} is not a directory`) &&
    refusal.remedy === remedy, preview.stdout + preview.stderr);
  const launch = invoke(["--foreground", ...fileArgs]);
  check("foreground launch names the blocking persona path component and gives the same retry",
    launch.status === 1 && launch.stderr.includes(parentFile) && /plain-parent\s+is not a directory/.test(launch.stderr) &&
    launch.stderr.replace(/\s+/g, " ").includes(remedy) && !launch.stderr.includes("ENOTDIR"), launch.stderr);

  const blocked = join(root, "parent-file");
  const link = join(root, ".cotal", "agents", "notdir-link.md");
  const target = "../../parent-file/child.md";
  writeFileSync(blocked, "not a directory");
  symlinkSync(target, link);
  for (const mode of [[], ["--dry-run", "--plain"]]) {
    const refused = invoke(["notdir-link", ...selectors, ...mode]);
    check(`foreground ${mode.length ? "preview" : "launch"} identifies a symlink whose target crosses a file`,
      refused.status === (mode.length ? 2 : 1) && refused.stderr.includes(link) && refused.stderr.includes(target) &&
      refused.stderr.includes("is a symbolic link to a missing target") && refused.stderr.includes("put a regular persona file in its place") &&
      !refused.stderr.includes("PERMISSION_DENIED") && readlinkSync(link) === target, refused.stderr);
  }
  rmSync(blocked);
  mkdirSync(blocked);
  writeFileSync(join(blocked, "child.md"), "---\nname: notdir-link\nagent: opencode\n---\n");
  const repaired = invoke(["notdir-link", "--dry-run", "--plain", ...selectors]);
  check("foreground preview follows the symlink once its target is restored", repaired.status === 0 && repaired.stdout.includes(link), repaired.stderr);
}

console.log("cotal spawn (foreground): the launch bag an armed session needs");

try {
  await checkPersonaRefusals();
  {
    const previous = process.cwd();
    const previousDefault = process.env.COTAL_DEFAULT_PERSONA;
    writeFileSync(join(caller, "probe.md"), "---\nname: caller-probe\n---\nCaller persona.\n");
    writeFileSync(join(root, "probe.md"), "---\nname: mesh-probe\n---\nMesh persona.\n");
    const dotted = join(root, ".cotal", "agents", "probe.md.md");
    writeFileSync(dotted, "---\nname: catalog-probe\n---\nCatalog persona.\n");
    try {
      process.chdir(caller);
      const local = await run(["spawn", "--foreground", "--file", "probe.md", "--space", "fgevents", "-H", "fg-probe-live"]);
      check("foreground --file uses the caller's persona even when the mesh has the same filename", local.opts?.name === "caller-probe", local.stderr);
      const named = await run(["spawn", "--foreground", "probe", "--space", "fgevents", "-H", "fg-probe-live"]);
      check("foreground catalog names still read the selected mesh persona", named.opts?.name === "probe", named.stderr);
      const dottedArgs = ["spawn", "--foreground", "probe.md", "--space", "fgevents", "-H", "fg-probe-live"];
      const shadowed = await run(dottedArgs);
      check("a catalog name ending in .md wins over a same-named project file", shadowed.opts?.name === "catalog-probe", shadowed.stderr);
      const preferredArgs = ["spawn", "--foreground", "--space", "fgevents", "-H", "fg-probe-live"];
      process.env.COTAL_DEFAULT_PERSONA = "probe.md";
      const preferred = await run(preferredArgs);
      check("a preferred catalog name ending in .md wins over a same-named project file", preferred.opts?.name === "catalog-probe", preferred.stderr);
      process.env.COTAL_DEFAULT_PERSONA = "./probe.md";
      const relative = await run(preferredArgs);
      check("an explicit relative default persona path still selects the project file", relative.opts?.name === "mesh-probe", relative.stderr);
      const explicit = await run(["spawn", "--foreground", "--file", join(root, "probe.md"), "--space", "fgevents", "-H", "fg-probe-live"]);
      check("an explicit file selects the project file even when its basename is a catalog name", explicit.opts?.name === "mesh-probe", explicit.stderr);
      rmSync(join(root, "probe.md"));
      const unshadowed = await run(dottedArgs);
      check("a catalog name ending in .md works without a same-named project file", unshadowed.opts?.name === "catalog-probe", unshadowed.stderr);
      const malformed = join(root, ".cotal", "agents", "bad-utf8.md");
      writeFileSync(malformed, Buffer.from("---\nname: bad-utf8\n---\nbefore\xffafter\n", "latin1"));
      const bad = await run(["spawn", "--foreground", "--file", malformed, "--space", "fgevents", "-H", "fg-probe-live"]);
      check("foreground spawn refuses invalid UTF-8 before building a launch", bad.opts === undefined && bad.exited === 1, bad);
      rmSync(malformed);
      if (process.platform !== "win32") {
        const loop = join(root, ".cotal", "agents", "loop.md");
        const binary = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
        symlinkSync("loop.md", loop);
        const loopEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
        for (const key of Object.keys(loopEnv)) if (key.startsWith("COTAL_")) delete loopEnv[key];
        Object.assign(loopEnv, { COTAL_HOME: home, COTAL_NO_PROMPT: "1", COTAL_SKIP_CONNECTOR_SEED: "1" });
        for (const mode of [[], ["--dry-run", "--plain"]]) {
          for (const source of [["--", "loop"], ["--file", loop]]) {
            const refused = spawnSync(process.execPath, [binary, "spawn", "--foreground", "--server", server, "--space", "fgevents", ...mode, ...source], {
              cwd: caller, env: loopEnv, encoding: "utf8", timeout: 30_000,
            });
            check(`foreground ${mode.length ? "preview" : "spawn"} ${source[0]} names the looping persona and how to fix it`,
              refused.status === 1 && /Code:\s+SCHEMA_INVALID/.test(refused.stderr) &&
              refused.stderr.includes(`the persona path contains a symbolic-link loop: ${loop}`) &&
              refused.stderr.includes("correct the link's target") && refused.stderr.includes("put a regular persona file in its place") &&
              readlinkSync(loop) === "loop.md" && !refused.stderr.includes("spawning loop"), refused.stderr || refused.error);
          }
        }
        rmSync(loop);
      }
    } finally {
      if (previousDefault === undefined) delete process.env.COTAL_DEFAULT_PERSONA; else process.env.COTAL_DEFAULT_PERSONA = previousDefault;
      process.chdir(previous);
    }
  }
  {
    const path = process.env.PATH;
    const pin = process.env.COTAL_OPENCODE_BIN;
    process.env.PATH = "";
    delete process.env.COTAL_OPENCODE_BIN;
    try {
      const missing = await openRun(["--agent", "fg-probe-binary"]);
      check("a missing harness refuses before launch construction", missing.opts === undefined && missing.exited === 2, missing.stderr);
      process.env.COTAL_OPENCODE_BIN = process.execPath;
      const pinned = await openRun(["--agent", "fg-probe-binary"]);
      check("a valid executable pin outside PATH still launches", pinned.opts !== undefined && pinned.exited === undefined, pinned.stderr);
      process.env.COTAL_OPENCODE_BIN = join(root, "missing-opencode");
      const invalid = await openRun(["--agent", "fg-probe-binary"]);
      check("an invalid executable pin refuses before launch construction", invalid.opts === undefined && invalid.exited === 2, invalid.stderr);
    } finally {
      if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
      if (pin === undefined) delete process.env.COTAL_OPENCODE_BIN; else process.env.COTAL_OPENCODE_BIN = pin;
    }
  }
  const outside = await openRun(["--agent", "fg-probe-live", "--subscribe", "other"]);
  check("a foreground subscription outside the persona policy refuses before launch and explains how to retry",
    outside.exited === 1 && outside.opts === undefined && outside.stderr.includes('subscribe "other" is not within allowSubscribe') &&
    outside.stderr.includes("omit the conflicting channel override"), outside.stderr);
  // CONTROL FIRST. Without it every assertion below could be passing because the launch never
  // reached the connector at all, which is exactly how the first draft of this suite fooled itself.
  {
    const r = await openRun(["--agent", "fg-probe-emitter"]);
    check("CONTROL: an ordinary foreground launch reaches the connector", r.opts !== undefined, r.stderr.slice(0, 300));
    check("CONTROL: and it is armed by default", r.opts?.events === true, r.opts?.events);
    check("foreground default keeps native MCP discovery", r.opts?.mcpServersExclusive === false);
    // The root is passed on EVERY foreground launch, not only an armed one, and two connectors read
    // it whether or not events are on: Codex and OpenCode root their per-agent home at it. Without
    // this cell an edit that passed it only under `--events` would leave the suite green and move
    // both of those homes back to whatever directory the operator happened to be standing in.
    check("a default-armed foreground launch carries the mesh root", r.opts?.workspaceRoot === root, { got: r.opts?.workspaceRoot, expected: root });
    check("a foreground launch without --cwd leaves the connector's managed cwd unset", r.opts !== undefined && r.opts.cwd === undefined);
  }

  {
    const work = join(root, "work");
    const link = join(root, "work-link");
    mkdirSync(work);
    symlinkSync(work, link, "junction");
    const receipt = join(root, "child-cwd.txt");
    const cwdProbe: Connector = {
      ...liveProbe,
      name: "fg-probe-cwd",
      buildLaunch: (o: LaunchOpts): LaunchSpec => {
        captured.push(o);
        return {
          command: process.execPath,
          args: ["-e", 'require("node:fs").writeFileSync(process.argv[1], process.cwd())', receipt],
          env: {},
        };
      },
    };
    registry.register(cwdProbe);
    const r = await openRun(["--agent", "fg-probe-cwd", "--cwd", link]);
    const childCwd = existsSync(receipt) ? readFileSync(receipt, "utf8") : undefined;
    check("foreground --cwd runs the child in the canonical directory without a managed connector cwd",
      childCwd === realpathSync(work) && r.opts !== undefined && r.opts.cwd === undefined, { childCwd, ...r });
  }

  for (const field of ["role: two words", "launchOptions: null"]) {
    const invalid = join(root, ".cotal", "agents", "invalid.md");
    writeFileSync(invalid, `---\nname: invalid\n${field}\n---\nbody\n`);
    const r = await run(["spawn", "invalid", "--foreground", "--server", server, "--space", "fgevents", "--agent", "fg-probe-live"]);
    check(`foreground with ${field} refuses before reaching the connector`, r.opts === undefined && r.exited === 1, r);
  }

  {
    const r = await openRun(["--agent", "fg-probe-emitter", "--events"]);
    check("--events reaches the connector on the foreground path", r.opts?.events === true, r.stderr.slice(0, 300));
    // THE CELL THAT WAS MISSING. The flag alone launches nothing: a connector that publishes an
    // event plane refuses an armed launch whose write-ahead log has nowhere to live.
    // Compared against THE MESH ROOT this suite registered, not merely checked for non-emptiness.
    // Any wrong-but-present path passes the weaker test, and a write-ahead log under a path the next
    // start does not look in fails in exactly the way an absent one does.
    check(
      "an armed foreground launch carries the mesh's own root for the write-ahead log",
      r.opts?.workspaceRoot === root,
      { got: r.opts?.workspaceRoot, expected: root },
    );
  }

  {
    const r = await openRun(["--agent", "fg-probe-emitter", "--no-events"]);
    check("--no-events reaches the connector as an explicit opt-out", r.opts?.events === false, r.stderr.slice(0, 300));
  }

  {
    const r = await openRun(["--agent", "fg-probe-silent"]);
    check("a bare spawn leaves an unsupported event plane unarmed", r.opts?.events === false, r.stderr.slice(0, 300));
  }

  {
    const r = await openRun(["--agent", "fg-probe-silent", "--events"]);
    check("explicit --events refuses an unsupported connector", /connector "fg-probe-silent".*omit --events/.test(r.stderr), r.stderr);
    check("explicit unsupported events refuse before launch", r.opts === undefined);
  }

  {
    const r = await openRun(["--agent", "fg-probe-silent", "--no-events"]);
    check("--no-events lets a connector without an event plane launch", r.opts?.events === false, r.stderr.slice(0, 300));
  }

  {
    const none = await openRun(["--agent", "fg-probe-emitter", "--share-tools", "none"]);
    check("foreground --share-tools none reaches the connector as an exclusive empty selection", none.opts?.mcpServersExclusive === true && Object.keys(none.opts.mcpServers ?? {}).length === 0, none.stderr.slice(0, 300));
    const named = await openRun(["--agent", "fg-probe-emitter", "--share-tools", "alpha"]);
    check("foreground named sharing reaches the connector as an exclusive selection", named.opts?.mcpServersExclusive === true && Object.keys(named.opts.mcpServers ?? {}).join() === "alpha", named.stderr.slice(0, 300));
  }

  // ── #7043: the foreground exit status is the application's ──────────────────────────────────────
  {
    const exitOf = async (opt: string): Promise<number | string | undefined> => {
      process.exitCode = undefined;
      await openRun(["--agent", "fg-probe-exit", "--no-events", "--opt", opt]);
      const code = process.exitCode;
      process.exitCode = undefined;
      return code;
    };
    // CONTROL: an ordinary exit already came through, so a cell below that goes red is about the signal.
    const ordinary = await exitOf("code=7");
    check("CONTROL: an application's own exit code is the spawn's exit code", ordinary === 7, ordinary);
    const term = await exitOf("signal=15");
    check("an application killed by SIGTERM exits 143, not 0", term === 143, term);
    const kill = await exitOf("signal=9");
    check("an application killed by SIGKILL exits 137, not 0", kill === 137, kill);
  }

  // ── #1837: the user-auth departure sentence names its own arm's cleanup ────────────────────────
  // The REMOTE arm is driven END TO END through the real dispatch: a synthetic remote user-mode
  // entry (recorded above), an auth-provider double that answers `postAgentProvisioning` with the
  // material a real mesh endpoint returns (the login gate and the endpoint's own semantics are not
  // what this cell studies), and the live probe that lets the spawn body run to its prints. The
  // provider double replaces the real provider BEFORE this cell because no other cell in this suite
  // enters a user-auth branch; nothing else in the process observes the swap.
  const { cotalAuthProvider } = await import("@cotal-ai/auth");
  let revokeCalls = 0;
  const provisioningDouble = {
    ...cotalAuthProvider,
    async postAgentProvisioning({ actor }: { actor: string }) {
      return {
        exists: false,
        actor,
        owner: `u_${"a".repeat(26)}`,
        lifecycleUid: "11111111-1111-4111-8111-111111111111",
        actorToken: "actor-token-material",
        sentinelCreds: "sentinel-creds-material",
      };
    },
    async revokeAgent() { revokeCalls++; return true; },
  };
  registry.unregister("auth-provider", cotalAuthProvider.name);
  registry.register(provisioningDouble);
  {
    // The same foreground spelling as openRun: --config is reserved for internal launch callers.
    const r = await run(["spawn", "--foreground", "--file", persona, "--server", server, "--space", "fgremote", "--agent", "fg-probe-live"]);
    // CONTROL for this arm: the run must have completed a real launch (the live probe ran, the
    // child was spawned and reaped), or the sentence cells below would pass on a refusal that
    // never printed anything.
    check("CONTROL: the remote user-auth arm completes a real launch", r.opts?.userAuth?.owner === `u_${"a".repeat(26)}`, r.stderr.slice(0, 400));
    const sentence = r.stderr.split("\n").find((l) => l.includes("running as you")) ?? "";
    // THE CELL. On the remote arm the sentence must NOT promise automatic revocation: cleanup
    // there shreds only the local credential files, and the mesh-side grant stands until the mesh
    // operator revokes it. The sentence must say both facts (the local-file removal and the
    // operator route) in its own words.
    check(
      "the remote user-auth arm does not promise automatic revocation",
      sentence.includes("running as you") && !sentence.includes("revoked automatically"),
      sentence,
    );
    check(
      "…and it names what cleanup does: local files removed, grant stays until the mesh operator revokes it",
      sentence.includes("local credential files are removed when this process exits") &&
        sentence.includes("the grant stays until the mesh operator revokes it"),
      sentence,
    );
    // And the honesty is not cosmetic: on this arm nothing was revoked (the provider double counts
    // the calls cleanup would have made; the mesh-side row lives where this machine has no
    // authority). This pins the SENTENCE to the BEHAVIOR rather than to a string.
    check("the remote arm revoked nothing on this machine (its cleanup is local-file shred only)", revokeCalls === 0, `revokeAgent called ${revokeCalls} times`);
  }
  registry.unregister("auth-provider", cotalAuthProvider.name);
  registry.register(cotalAuthProvider); // restore: later cells (if any) see the real provider
  {
    // The LOCAL arm keeps its sentence, asserted at the choice point rather than end to end:
    // staging a full local user-auth mesh (space trust, a running auth service, a cached login) is
    // the user-spawn live suite's surface, not this one's. Reading the code's own source at the
    // branch keeps this cell honest without that staging: if the per-arm selection is lost (the
    // #1837 regression), the local arm's sentence text disappears from the file and this goes red.
    const source = readFileSync(new URL("../src/commands/spawn.ts", import.meta.url), "utf8");
    check(
      "the local user-auth arm keeps its 'revoked automatically' sentence (the arm whose cleanup really revokes)",
      source.includes('"(actor granted; revoked automatically when this process exits)"') &&
        source.includes('remoteUserAuth\n        ? "(actor granted by the mesh;'),
      "the per-arm sentence selection in spawn.ts changed shape; re-check both arms",
    );
  }
} finally {
  broker.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
  rmSync(caller, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
}

const EXPECTED = process.platform === "win32" ? 42 : 52;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/**
 * PERSONA ROLE/CAPABILITY GUARD smoke (issue #966) — a seat labelled `manager` that cannot spawn
 * is refused at spawn-accept, loudly, instead of joining and failing silently on first use.
 *
 * THE DEFECT. `cotal_persona` takes content only (`name`/`prompt`/`model`); capabilities are POLICY
 * with no slot on the wire write path (P6 — `smoke:persona-input-closed` guards that closure, and
 * it names capabilities as exactly the vector it exists to catch). So every persona a peer defines
 * lands with NO `capabilities:` line. `cotal_spawn` takes a free-form `role`, and nothing reconciles
 * the label with the grant: a wire-defined persona spawned with `role: "manager"` joins presenting
 * as a manager (role is the presence label AND the anycast address other agents route on) while its
 * credential cannot reach the privileged control plane. The seat discovers that the first time it
 * tries to seat a worker — minutes in, after it has planned around having help. Silent degradation,
 * the shape the repo's no-fallbacks rule exists for.
 *
 * WHAT THIS SUITE ASSERTS, against a real Manager on a real throwaway JWT broker, driven through
 * the REAL tool surfaces (`cotalToolSpecs(...).run(...)`), not hand-called internals:
 *
 *   1. THE REPRO, AS THE FIX'S POSITIVE CONTROL. The pre-fix chain still reaches the refusal point:
 *      a spawn-capable peer defines a persona via `cotal_persona`, the file on disk carries NO
 *      `capabilities:` line, and the definition time result said nothing about capabilities — the
 *      gap is real, and the spawn is where it must be caught.
 *   2. THE REFUSAL (the cell the mutation must redden). `cotal_spawn(name, role: "manager")` on
 *      that persona is REFUSED: `reply.ok === false`, naming the persona, the missing capability,
 *      and the remediation for BOTH authors (an operator edits the file; a peer must ask one).
 *   3. THE FILE'S OWN ROLE TOO. A persona file with `role: manager` in frontmatter and no
 *      capabilities is refused identically — the guard keys on the EFFECTIVE role, which the file
 *      supplies when no override is passed.
 *   4. NON-REGRESSION, the cells that keep the guard narrow:
 *      a. `role: "manager"` + `capabilities: [spawn]` in the file SPAWNS (the guard must not
 *         break the legitimate manager persona — this workspace's catalog carries many).
 *      b. A non-manager role (`worker`) on a no-capability persona SPAWNS (the common case; the
 *         guard is not a general role-to-capability map).
 *      c. A `role:` OVERRIDE to a non-manager role on the same file SPAWNS (the effective-role
 *         rule works in the widening direction too: spawn-time role wins over the file).
 *   5. NO SIDE EFFECTS. A refused spawn mints nothing: no credential file for the refused name.
 *
 * WHAT IT DOES NOT COVER, said plainly: it drives `startAgent` through the manager's control path
 * via the tool spec's `run()` → `MeshAgent.spawn` → the manager service, but it does not exercise
 * the MCP zod validation layer (same limit as `smoke:persona-announce`, one layer below the host
 * registration). The CLI foreground path shares `startAgent`'s persona resolution but mints its own
 * creds; this suite does not run the foreground CLI.
 *
 * Run: pnpm smoke:persona-role-capability   (boots its own ephemeral-loopback JWT broker)
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn as spawnProc } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  registry,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
  type Connector,
  type LaunchOpts,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { MeshAgent, cotalToolSpecs, type AgentConfig } from "@cotal-ai/connector-core";
import { Manager } from "@cotal-ai/manager";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FIRST ACTION: never touch a shared broker. Scrub an inherited COTAL_* env (a suite that starts a
// real Manager hands its children an environment) and assert the dial string is ephemeral loopback.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
assert.ok(
  SERVERS.startsWith("nats://127.0.0.1:") && !SERVERS.includes("broker.cotal.ai"),
  `broker under test must be ephemeral loopback, got ${SERVERS}`,
);

const space = `persona966-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }),
);
const srv = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const brokerPid = srv.pid;
// The seat process runs with cwd = the manager's workspaceRoot (a scratch dir outside any
// package tree), so its core import must be baked to this checkout's BUILT core dist: the smoke
// runs against dist ("a suite under implementations/* audits the last BUILD", mutation-proof's
// own warning), and a bare '@cotal-ai/core' would not resolve from the copy's location anyway.
const coreDist = new URL("../../../packages/core/dist/index.js", import.meta.url).href;
const seatSrc = readFileSync(new URL("./_persona-role-seat.mjs", import.meta.url), "utf8").replace(
  "CORE_DIST_URL_PLACEHOLDER",
  JSON.stringify(coreDist),
);
writeFileSync(join(dir, "seat.mjs"), seatSrc);


/** A connector that launches a real always-alive stub seat (registers presence and idles), so a
 *  spawn resolves "started" without any real harness binary. Mirrors what real connectors do:
 *  env only, creds/id/role/lifecycleUid from LaunchOpts. */
const stub: Connector = {
  kind: "connector",
  name: "p966-stub",
  requires: ["node"],
  buildLaunch: (o: LaunchOpts) => ({
    command: process.execPath,
    args: [join(dir, "seat.mjs")],
    env: {
      COTAL_SPACE: o.space,
      COTAL_SERVERS: o.servers ?? "",
      COTAL_CREDS: o.creds ?? "",
      COTAL_ID: o.id ?? "",
      COTAL_NAME: o.name,
      COTAL_ROLE: o.role ?? "",
      COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "",
    },
  }),
};
registry.register(stub);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
let provisioner: CotalEndpoint | undefined;
let definer: MeshAgent | undefined;

let pass = 0;
let code = 1;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await sleep(200);
  }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  await seedChannelRegistry({
    servers: SERVERS,
    space,
    creds: provisionerCreds,
    file: { defaults: { replay: false }, channels: { general: {} } },
  });
  provisioner = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: provisionerCreds,
    card: { name: "provisioner", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
  });
  provisioner.on("error", () => {});
  await provisioner.start();
  await mgr.start();

  const chACL = { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] };
  const definerId = newIdentity();
  const definerUid = mintLifecycleUid();
  const definerCreds = await provisionAgent(provisioner, auth, definerId, {
    ...chACL,
    role: "worker",
    lifecycleUid: definerUid,
    capabilities: ["spawn"],
    endpointCapabilities: [{ endpoint: "manager", command: "define-persona" }, { endpoint: "manager", command: "spawn" }],
  });
  const cfg: AgentConfig = {
    space,
    name: "definer",
    role: "worker",
    servers: SERVERS,
    creds: definerCreds,
    ...chACL,
    kind: "agent",
    tls: false,
    id: definerId.id,
    capabilities: ["spawn"],
    lifecycleUid: definerUid,
  };
  definer = new MeshAgent(cfg);
  definer.on("error", () => {});
  definer.start();
  for (let i = 0; i < 60; i++) {
    if (definer.connected) break;
    await sleep(200);
  }
  check("definer connected with spawn-capable scoped creds", definer.connected === true);
  await sleep(500);

  const personaTool = cotalToolSpecs(cfg).find((s) => s.name === "cotal_persona");
  const spawnTool = cotalToolSpecs(cfg).find((s) => s.name === "cotal_spawn");
  check("both manager-op tools are exposed to the spawn-capable definer", personaTool !== undefined && spawnTool !== undefined);
  if (!personaTool || !spawnTool) throw new Error("manager-op tools missing from the tool surface");

  // ---- 1. the repro: a wire-defined persona carries no capabilities line -----------------------
  console.log("1. the gap is real: a wire-defined persona carries no capabilities line");
  const WIRE = "p966-wire-manager";
  const defined = await personaTool.run(definer, cfg, {
    name: WIRE,
    prompt: "A lane manager persona defined over the wire by a peer.",
  });
  check("cotal_persona reports success", defined.isError !== true, defined);
  const wireFile = join(workspaceRoot, ".cotal", "agents", `${WIRE}.md`);
  check("the persona file is on disk", existsSync(wireFile));
  const wireRaw = readFileSync(wireFile, "utf8");
  check(
    "the wire-defined persona has NO capabilities line (the write path is content-only by design)",
    !/^capabilities:/m.test(wireRaw),
  );
  check(
    "nothing at definition time mentions capabilities (the gap is invisible at define)",
    !String(defined.text ?? "").includes("capabilit"),
    defined,
  );

  // Hand-written personas for the file-side cells.
  const writePersona = (name: string, frontmatter: string): void => {
    writeFileSync(join(workspaceRoot, ".cotal", "agents", `${name}.md`), `---\n${frontmatter}\n---\nbody\n`);
  };
  writePersona("p966-file-manager", "name: p966-file-manager\nrole: manager");
  writePersona("p966-manager-capped", "name: p966-manager-capped\nrole: manager\ncapabilities: [spawn]");
  writePersona("p966-plain-worker", "name: p966-plain-worker\nrole: worker");

  // ---- 2. THE REFUSAL: role: manager on a no-capability persona is refused at accept -----------
  console.log("2. a manager-role spawn of a no-capability persona is refused, loudly");
  const refused = await spawnTool.run(definer, cfg, { name: WIRE, role: "manager", agent: "p966-stub" });
  const rt = String(refused.text ?? "");
  check("the spawn is refused (the tool result is an error)", refused.isError === true, refused);
  check("the refusal names the persona", rt.includes(WIRE), rt);
  check("the refusal names the missing spawn capability", rt.includes("no spawn capability"), rt);
  check(
    "the refusal tells an operator the file remedy (capabilities: [spawn])",
    rt.includes("capabilities: [spawn]"),
    rt,
  );
  check(
    "the refusal tells a peer author to ask an operator (it cannot self-serve the grant)",
    rt.includes("ask an operator"),
    rt,
  );

  // ---- 3. the file's own role is held to the same standard -------------------------------------
  console.log("3. a persona file declaring role: manager without the grant refuses identically");
  const fileRefused = await spawnTool.run(definer, cfg, { name: "p966-file-manager", agent: "p966-stub" });
  check("the file-role manager spawn is refused too", fileRefused.isError === true, fileRefused);
  check(
    "its refusal also names the missing spawn capability",
    String(fileRefused.text ?? "").includes("no spawn capability"),
    fileRefused,
  );

  // ---- 4. the guard is narrow: every legitimate spawn still spawns -----------------------------
  console.log("4. non-regression: legitimate spawns still work");
  const capped = await spawnTool.run(definer, cfg, { name: "p966-manager-capped", agent: "p966-stub" });
  check("a manager persona WITH capabilities: [spawn] still spawns", capped.isError !== true, capped);
  const worker = await spawnTool.run(definer, cfg, { name: "p966-plain-worker", agent: "p966-stub" });
  check("a plain worker persona with no capabilities still spawns", worker.isError !== true, worker);
  const overridden = await spawnTool.run(definer, cfg, { name: WIRE, role: "worker", agent: "p966-stub" });
  check("a non-manager role OVERRIDE on the same file spawns (effective role, both directions)", overridden.isError !== true, overridden);

  // ---- 5. a refused spawn mints nothing --------------------------------------------------------
  console.log("5. a refused spawn leaves no credential footprint");
  const agentsDir = join(workspaceRoot, ".cotal", "agents");
  const filesAfter = (await import("node:fs")).readdirSync(agentsDir).sort().join(",");
  const expected = [`${WIRE}.md`, "p966-file-manager.md", "p966-manager-capped.md", "p966-plain-worker.md"].sort().join(",");
  check(
    "only the four defined persona files exist (no side-effect file minted by the refusal)",
    filesAfter === expected,
    { got: filesAfter, want: expected },
  );

  console.log(`\n  ${pass} checks passed`);
  code = 0;
} finally {
  await definer?.stop().catch(() => {});
  await provisioner?.stop().catch(() => {});
  // Reap leftover PTY seats. A plain stop leaves node-pty's waitpid worker holding this
  // process open after the banner (Linux CI shard 2 hung that way after this suite).
  await mgr.stop({ withAgents: true }).catch(() => {});
  if (brokerPid) try { process.kill(brokerPid, "SIGKILL"); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(code);

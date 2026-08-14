/**
 * PERSONA ANNOUNCE smoke (issue #380) — defining a persona is SILENT unless you ask for a post.
 *
 * The defect: `MeshAgent.definePersona` ended in a bare `this.send(text)`. `send` with no channel
 * reaches `Endpoint.multicast`, which resolves the destination as `opts?.channel ?? the caller's
 * FIRST CONCRETE CHANNEL ?? "general"` — so every persona definition broadcast to `#general`, not
 * because anyone chose `#general` but because `general` is first in most personas' channel list.
 * Standing up a four-seat review panel put four posts in every peer's inbox on the mesh, a tool
 * retry announced the same persona twice (the send was unconditional on `reply.ok`, and the
 * manager write is an idempotent overwrite), and the text — "spawn it to bring it online" — is an
 * imperative addressed to strangers, which tripped a real provenance investigation.
 *
 * What this proves, against a REAL Manager on a real JWT broker, driven through the REAL
 * `cotal_persona` MCP tool entry point (not `definePersona` called by hand):
 *
 *   1. DEFINE STILL WORKS. The persona file lands on disk and the tool reports success. This runs
 *      FIRST and deliberately: every silence assertion below is worthless if the define failed,
 *      because a failed define is silent too. Silence has to be the silence of a job done.
 *   2. THE DEFAULT IS SILENT. No `announce` ⇒ a witness peer subscribed to BOTH `general` and the
 *      lane receives NOTHING on either. This is the assertion the mutation must redden.
 *   3. THE OPT-IN ROUTE WORKS, and works on the same settle window cell 2 waited out — so the
 *      silence above is silence, not a window too short to have caught anything. The message must
 *      arrive ON THE NAMED LANE, carry the persona's name, and NOT carry the old solicitation
 *      wording; and `general` must still receive nothing.
 *   4. THE DESTINATION IS THE ONE NAMED, never one inferred from channel order — asserted by
 *      announcing to the lane while `general` sits first in the definer's channel list, which is
 *      exactly the ordering that produced the bug.
 *
 * Run: pnpm smoke:persona-announce   (needs nats-server + node on PATH; boots its own broker)
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
  type CotalMessage,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { MeshAgent, cotalToolSpecs, type AgentConfig } from "@cotal-ai/connector-core";
import { Manager } from "@cotal-ai/manager";

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
const LANE = "lane.fm380";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A message's text lives in its parts (`{kind:"text", text}`), not in a top-level field. */
const textOf = (m: CotalMessage): string =>
  (m.parts ?? []).filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join(" ");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// FIRST ACTION, before anything connects: this suite boots its own broker in a scratch dir and must
// never touch a shared one. A smoke that publishes chat traffic at a live broker is not a smoke, it
// is an incident.
//
// Two separate hazards, so two separate steps. (1) The suite's OWN dial string must be ephemeral
// loopback — that is the assertion. (2) A run started from a session that is itself joined to a mesh
// inherits `COTAL_*` in its environment, and this suite starts a real Manager, which hands its
// children an environment; an inherited `COTAL_SERVERS` is a live broker one process removed. Scrub
// it rather than refuse, so the suite is runnable on exactly the machines that run meshes, and
// assert the scrub took so it can never become a comment about something that did not happen.
const LIVE_BROKER = "broker.cotal.ai";
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
check(
  "the inherited COTAL_* environment is scrubbed (a real Manager here hands children an env)",
  Object.keys(process.env).every((k) => !k.startsWith("COTAL_")),
  Object.keys(process.env).filter((k) => k.startsWith("COTAL_")),
);
check(
  `the broker under test is ephemeral loopback, not ${LIVE_BROKER}`,
  SERVERS.startsWith("nats://127.0.0.1:") && !SERVERS.includes(LIVE_BROKER),
  SERVERS,
);

const space = `personaann-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-personaann-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

/** The settle window. Cell 3 receives inside it on this same harness, which is what licenses cell 2
 *  to read an empty mailbox as silence rather than as impatience. */
const SETTLE_MS = 2000;

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
let provisioner: CotalEndpoint | undefined;
let definer: MeshAgent | undefined;
let witness: CotalEndpoint | undefined;

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
    file: { defaults: { replay: false }, channels: { general: {}, [LANE]: {} } },
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

  // `general` FIRST in the definer's channel list, deliberately: that ordering is what the old code
  // turned into a destination. If the fix ever regresses, the traffic lands on general again.
  const chACL = { subscribe: ["general", LANE], allowSubscribe: ["general", LANE], allowPublish: ["general", LANE] };

  const definerId = newIdentity();
  const definerUid = mintLifecycleUid();
  const definerCreds = await provisionAgent(provisioner, auth, definerId, {
    ...chACL,
    role: "feature-manager",
    lifecycleUid: definerUid,
    capabilities: ["spawn"],
    endpointCapabilities: [{ endpoint: "manager", command: "define-persona" }],
  });

  const witnessId = newIdentity();
  const witnessUid = mintLifecycleUid();
  const witnessCreds = await provisionAgent(provisioner, auth, witnessId, { ...chACL, role: "witness", lifecycleUid: witnessUid });

  const cfg: AgentConfig = {
    space,
    name: "definer",
    role: "feature-manager",
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

  // The witness is an ordinary peer reading both channels — the "every agent's inbox" the issue is
  // about. Bucket by channel so a message on the wrong one is a distinguishable failure, not a
  // count that happens to match.
  const heard: Record<string, CotalMessage[]> = { general: [], [LANE]: [] };
  witness = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: witnessCreds,
    card: { name: "witness", kind: "agent", id: witnessId.id },
    channels: ["general", LANE],
    lifecycleUid: witnessUid,
  });
  witness.on("error", () => {});
  witness.on("message", (m: CotalMessage) => {
    if (heard[m.channel]) heard[m.channel].push(m);
  });
  await witness.start();

  definer.start();
  for (let i = 0; i < 60; i++) {
    if (definer.connected) break;
    await sleep(200);
  }
  check("definer connected with spawn-capable scoped creds", definer.connected === true);
  await sleep(500);

  // The REAL entry point: the tool the model actually calls, resolved from the real spec list.
  const persona = cotalToolSpecs(cfg).find((s) => s.name === "cotal_persona");
  check("cotal_persona is exposed to a spawn-capable agent", persona !== undefined);
  if (!persona) throw new Error("cotal_persona missing from the tool surface");

  const before = { general: heard.general.length, [LANE]: heard[LANE].length };

  // ---- 1. define still works (the anti-circularity guard) --------------------------------------
  console.log("1. a silent define is still a define");
  const silentName = "fm380silent";
  const silentResult = await persona.run(definer, cfg, {
    name: silentName,
    prompt: "A probe persona defined without an announce.",
  });
  const silentFile = join(workspaceRoot, ".cotal", "agents", `${silentName}.md`);
  check("the tool reports success for a define with no announce", silentResult.isError !== true, silentResult);
  check("the persona file was actually written (so silence below is a job done, not a job failed)", existsSync(silentFile));
  check(
    "the silent tool result claims no announcement (the caller is told what actually happened)",
    !String(silentResult.text ?? "").includes("announced"),
    silentResult,
  );

  // ---- 2. the default is silent ----------------------------------------------------------------
  console.log("2. the default is silent");
  await sleep(SETTLE_MS);
  const silentGeneral = heard.general.slice(before.general);
  const silentLane = heard[LANE].slice(before[LANE]);
  // THE assertion. Restoring the unconditional send must break this line and no other first.
  check(
    "defining a persona with no announce delivers NOTHING on #general",
    silentGeneral.length === 0,
    silentGeneral.map(textOf),
  );
  check(
    "defining a persona with no announce delivers nothing on the lane either",
    silentLane.length === 0,
    silentLane.map(textOf),
  );

  // ---- 3. the opt-in route works, on the same window --------------------------------------------
  console.log("3. the opt-in route delivers, to the channel named");
  const loudName = "fm380announced";
  const loudBefore = { general: heard.general.length, [LANE]: heard[LANE].length };
  const loudResult = await persona.run(definer, cfg, {
    name: loudName,
    prompt: "A probe persona defined WITH an announce.",
    announce: LANE,
  });
  check("the tool reports success for an announced define", loudResult.isError !== true, loudResult);
  await sleep(SETTLE_MS);
  const loudLane = heard[LANE].slice(loudBefore[LANE]);
  const loudGeneral = heard.general.slice(loudBefore.general);

  check("exactly one message arrives on the announced lane", loudLane.length === 1, loudLane.map(textOf));
  const text = loudLane[0] ? textOf(loudLane[0]) : "";
  check("the announcement names the persona it announced", text.includes(loudName), text);
  check(
    "the announcement is an attributed statement, not the old spawn solicitation",
    !text.includes("is now available") && !text.includes("spawn it to bring it online"),
    text,
  );
  check("the announcement came from the definer", loudLane[0]?.from.name === "definer", loudLane[0]?.from);
  check(
    "an announced define STILL puts nothing on #general, though general is first in the channel list",
    loudGeneral.length === 0,
    loudGeneral.map(textOf),
  );
  check("the tool result names where it announced", String(loudResult.text ?? "").includes(LANE), loudResult);

  console.log(`\n  ${pass} checks passed`);
} finally {
  await definer?.stop().catch(() => {});
  await witness?.stop().catch(() => {});
  await provisioner?.stop().catch(() => {});
  await mgr.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

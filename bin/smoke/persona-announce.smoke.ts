/**
 * PERSONA ANNOUNCE smoke (issue #380) — defining a persona is SILENT unless you ask for a post.
 *
 * The defect: `MeshAgent.definePersona` ended in a bare `this.send(text)`. `send` with no channel
 * reaches `Endpoint.multicast`, which resolves the destination as `opts?.channel ?? the caller's
 * FIRST CONCRETE CHANNEL ?? "general"` — so every persona definition broadcast to `#general`, not
 * because anyone chose `#general` but because `general` is first in most personas' channel list.
 * Standing up a four-seat review panel put four posts in every peer's inbox on the mesh, and the
 * text — "spawn it to bring it online" — is an imperative addressed to strangers, which tripped a
 * real provenance investigation. The retry harm was narrower than "unconditional": the old send WAS
 * gated on `reply.ok`, so a failed manager reply announced nothing; but nothing else gated it, and
 * the manager write is an idempotent overwrite, so a retry that SUCCEEDED announced a second time.
 *
 * What this proves, against a REAL Manager on a real JWT broker, driven through the `cotal_persona`
 * tool spec — the platform-neutral object every host renders onto its own tool API, resolved out of
 * `cotalToolSpecs()` and invoked via its `run()`, not `definePersona` called by hand. Note the
 * limit: this is one layer below a host's registration (`tools.ts`), so it does NOT exercise the
 * MCP layer's zod input validation. That is why `announce` is validated inside `definePersona`
 * rather than only in the schema — the guarantee has to hold on the path a direct API caller takes,
 * and cell 4 below is what proves it does.
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
 *      exactly the ordering that produced the bug. Cell 3 asserts the message text EXACTLY, because
 *      a name-plus-absence-of-old-phrases pair let a review swap the production sentence for
 *      `deleted persona <name> - no longer spawnable` with the suite still fully green.
 *   5. A BAD DESTINATION FAILS LOUD AND FAILS EARLY (cell 4). `""`, whitespace, a wildcard, and a
 *      name the subject layer would rewrite are each refused, with NO persona file written and
 *      nothing published — `present` must mean exactly the channel named, and a refusal must blame
 *      the argument rather than the spawn capability.
 *   6. A DENIED ANNOUNCEMENT IS A SAVED PERSONA (cell 5), against a real broker denial from a
 *      definer with read-but-not-post rights on the lane. The file is on disk, the result says so,
 *      it points at `allowPublish`, and it tells the caller not to re-run — because the retry is
 *      exactly where the duplicate announcement came from.
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
  // The EXACT sentence, spelled out here rather than imported from the implementation. An
  // `includes(name)` + "doesn't say the old thing" pair is not a content assertion: a review of this
  // suite replaced the production text with `deleted persona <name> - no longer spawnable` and the
  // whole suite still passed, because that string also contains the name and neither old phrase. A
  // shared constant would have the same hole from the other direction — it would follow the
  // implementation wherever it went. Only a literal written down independently pins the wording.
  const EXPECTED = `defined persona \`${loudName}\` — in this workspace's persona catalog, spawnable with cotal_spawn`;
  check("the announcement is EXACTLY the intended sentence", text === EXPECTED, { got: text, want: EXPECTED });
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

  // ---- 4. a destination that is not a channel is refused BEFORE anything is written -------------
  console.log("4. a bad announce target fails loud, and fails before the write");
  // `""` is the dangerous one: falsy, so a truthiness guard reads a supplied destination as "absent"
  // and publishes nowhere while reporting success. `team.>` is a wildcard. `lane/fm380` is not a
  // channel name — the subject layer would rewrite it and publish somewhere the caller did not name.
  for (const bad of ["", "   ", "team.>", "lane/fm380"]) {
    const badName = `fm380bad${Buffer.from(bad).toString("hex").slice(0, 8)}`;
    const beforeBad = { general: heard.general.length, [LANE]: heard[LANE].length };
    const r = await persona.run(definer, cfg, { name: badName, prompt: "should never be written.", announce: bad });
    check(`announce ${JSON.stringify(bad)} is refused`, r.isError === true, r);
    // Assert what the message SAYS, not just what it avoids. The previous version of this cell
    // checked only that the text lacked spawn-capability advice — and passed while the tool was
    // answering "no manager reachable ... Is the manager running?" for a bad argument, because that
    // wrong message also lacks the phrase. Absence of one wrong answer is not presence of the right
    // one; that is the same hole review found in the content assertion, in a second place.
    const rt = String(r.text ?? "");
    check(`announce ${JSON.stringify(bad)} names the offending argument`, rt.includes("announce:"), r);
    check(
      `announce ${JSON.stringify(bad)} does NOT blame a dead manager (the manager was never called)`,
      !rt.includes("no manager reachable") && !rt.includes("Is the manager running?"),
      r,
    );
    check(
      `announce ${JSON.stringify(bad)} does not blame the spawn capability (the argument is the problem)`,
      !rt.includes("capabilities: [spawn]"),
      r,
    );
    check(
      `announce ${JSON.stringify(bad)} wrote NO persona file (refused before the manager op)`,
      !existsSync(join(workspaceRoot, ".cotal", "agents", `${badName}.md`)),
    );
    await sleep(300);
    check(
      `announce ${JSON.stringify(bad)} published nothing anywhere`,
      heard.general.length === beforeBad.general && heard[LANE].length === beforeBad[LANE],
    );
  }

  // ---- 5. a denied announcement is a saved persona, not a failed definition ---------------------
  console.log("5. saved-but-not-announced is reported as such");
  // A definer that may READ the lane but may not POST to it. The manager writes the file, then the
  // broker refuses the post. Reporting that as "couldn't define" names the wrong fix and invites a
  // retry — and the retry is where the duplicate announcement comes from.
  const mutedId = newIdentity();
  const mutedUid = mintLifecycleUid();
  const mutedCreds = await provisionAgent(provisioner, auth, mutedId, {
    subscribe: ["general", LANE],
    allowSubscribe: ["general", LANE],
    allowPublish: ["general"], // NOT the lane
    role: "feature-manager",
    lifecycleUid: mutedUid,
    capabilities: ["spawn"],
    endpointCapabilities: [{ endpoint: "manager", command: "define-persona" }],
  });
  const mutedCfg: AgentConfig = {
    ...cfg,
    name: "definer-nopost",
    creds: mutedCreds,
    id: mutedId.id,
    lifecycleUid: mutedUid,
    allowPublish: ["general"],
  };
  const mutedAgent = new MeshAgent(mutedCfg);
  mutedAgent.on("error", () => {});
  mutedAgent.start();
  for (let i = 0; i < 60; i++) {
    if (mutedAgent.connected) break;
    await sleep(200);
  }
  check("the post-denied definer connected", mutedAgent.connected === true);
  try {
    const deniedName = "fm380denied";
    const deniedBefore = { general: heard.general.length, [LANE]: heard[LANE].length };
    const deniedResult = await persona.run(mutedAgent, mutedCfg, {
      name: deniedName,
      prompt: "Saved, but its announcement is refused by the broker.",
      announce: LANE,
    });
    await sleep(SETTLE_MS);
    check(
      "the persona IS on disk even though the announcement was refused",
      existsSync(join(workspaceRoot, ".cotal", "agents", `${deniedName}.md`)),
    );
    check("a denied announcement is NOT reported as a failed definition", deniedResult.isError !== true, deniedResult);
    const dt = String(deniedResult.text ?? "");
    check("the result says the persona was saved", dt.includes("saved"), dt);
    check("the result says the announcement was REFUSED (a denial proves non-delivery)", dt.includes("REFUSED"), dt);
    check("the result says it did not go out", dt.includes("did not go out"), dt);
    check("the result points at allowPublish, not at the spawn capability", dt.includes("allowPublish"), dt);
    check(
      "the result does NOT blame the spawn capability (the caller has it; that was never the problem)",
      !dt.includes("capabilities: [spawn]"),
      dt,
    );
    check("the result tells the caller not to re-run (a retry is how the duplicate happens)", dt.includes("do not re-run"), dt);
    check(
      "nothing was actually delivered on either channel",
      heard.general.length === deniedBefore.general && heard[LANE].length === deniedBefore[LANE],
      { general: heard.general.slice(deniedBefore.general).map(textOf), lane: heard[LANE].slice(deniedBefore[LANE]).map(textOf) },
    );
  } finally {
    await mutedAgent.stop().catch(() => {});
  }

  // ---- 6. an UNCONFIRMED post is not a denied post ---------------------------------------------
  console.log("6. an unknown send outcome is reported as unconfirmed, not as 'did not go out'");
  // A chat publish rides JetStream request/PubAck, so a timeout can mean the stream STORED the
  // message and we simply never saw the ack. Telling the caller "it did not go out, post it
  // yourself" on that outcome is how the channel gets the announcement twice — the exact harm this
  // change removes. Drive it by making the send itself fail with a non-permission error.
  {
    const unknownName = "fm380unknown";
    const realSend = definer.send.bind(definer);
    (definer as unknown as { send: MeshAgent["send"] }).send = async () => {
      throw new Error("TIMEOUT: no response from stream");
    };
    let unknownResult;
    try {
      unknownResult = await persona.run(definer, cfg, {
        name: unknownName,
        prompt: "Its announcement neither confirms nor denies.",
        announce: LANE,
      });
    } finally {
      (definer as unknown as { send: MeshAgent["send"] }).send = realSend;
    }
    const ut = String(unknownResult?.text ?? "");
    check(
      "the persona is still saved when the announcement outcome is unknown",
      existsSync(join(workspaceRoot, ".cotal", "agents", `${unknownName}.md`)),
    );
    check("an unknown outcome is not reported as a failed definition", unknownResult?.isError !== true, ut);
    check("an unknown outcome says it could NOT CONFIRM", ut.includes("could NOT CONFIRM"), ut);
    check(
      "an unknown outcome does NOT claim the post did not go out (that claim invites a duplicate)",
      !ut.includes("did not go out") && !ut.includes("did NOT go out"),
      ut,
    );
    check(
      "an unknown outcome does NOT blame allowPublish (only a denial proves an ACL problem)",
      !ut.includes("allowPublish"),
      ut,
    );
    check("an unknown outcome tells the caller to READ the channel before posting", ut.includes(`READ #${LANE}`), ut);
  }

  console.log(`\n  ${pass} checks passed`);
} finally {
  await definer?.stop().catch(() => {});
  await witness?.stop().catch(() => {});
  await provisioner?.stop().catch(() => {});
  await mgr.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

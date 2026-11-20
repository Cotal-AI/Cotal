/**
 * Channel exclusions on the connector side (SPEC §9).
 *
 * A read or post list may remove channels or patterns from what it allows. This suite checks what a
 * session does with that before anything reaches the broker:
 *
 *   1. the launch env carries the exclusions beside their list, and `configFromEnv` reads them back,
 *      from the env when the launcher set the list, otherwise from the persona file;
 *   2. the session refuses an excluded channel and keeps its siblings under the same wildcard, for
 *      a send, the default send channel, a join (a pattern excluded in full refused, a partial
 *      overlap allowed), the channel list, a channel mode and a spawn's `join`;
 *   3. a spawn carries the caller's exclusions in `callerAcl`, and the spawn and persona tools pass
 *      the `{ allow, exclude }` form to the manager as written;
 *   4. the endpoint gets the read exclusions only on an authenticated session, where they route
 *      history through the delivery daemon;
 *   5. the orientation card shows the exclusions next to the read and post lists.
 *
 * No broker: tools run over stub agents or a MeshAgent that never connects. The broker refusals and
 * the mediated history read are covered by core's channel-exclusions suites.
 *
 * Run: `pnpm smoke:channel-exclusions-client`
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import { configFromEnv, type AgentConfig } from "../src/config.js";
import { aclEnv } from "../src/launch.js";
import { buildOrientation, renderOrientation } from "../src/orientation.js";
import { cotalToolSpecs, defaultSendChannel } from "../src/tool-specs.js";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
};
const throws = (run: () => unknown, pattern: RegExp): boolean => {
  try {
    run();
    return false;
  } catch (e) {
    return pattern.test((e as Error).message);
  }
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const READ_EXCLUDE = ["team.secret", "team.*.private", "vault.>"];
const POST_EXCLUDE = ["team.secret", "team.*.private"];
const base = { COTAL_NAME: "alice", COTAL_SPACE: "demo", COTAL_SERVERS: "nats://127.0.0.1:1" };

console.log("1. the launch env round trip");
{
  const env = aclEnv({ subscribe: ["team.a"], allowSubscribe: [">"], excludeSubscribe: READ_EXCLUDE, allowPublish: ["team.>"], excludePublish: POST_EXCLUDE });
  check("aclEnv writes each list's exclusions beside it",
    env.COTAL_ALLOW_SUBSCRIBE === ">" && env.COTAL_EXCLUDE_SUBSCRIBE === READ_EXCLUDE.join(",") &&
      env.COTAL_ALLOW_PUBLISH === "team.>" && env.COTAL_EXCLUDE_PUBLISH === POST_EXCLUDE.join(","), env);
  const config = configFromEnv({ ...base, ...env });
  check("configFromEnv reads them back", same(config.excludeSubscribe, READ_EXCLUDE) && same(config.excludePublish, POST_EXCLUDE), config);

  const plain = aclEnv({ subscribe: ["team.a"], allowSubscribe: ["team.>"], allowPublish: ["team.a"] });
  check("a launch with no exclusions writes no exclusion variable",
    !("COTAL_EXCLUDE_SUBSCRIBE" in plain) && !("COTAL_EXCLUDE_PUBLISH" in plain), plain);
  const plainConfig = configFromEnv({ ...base, ...plain });
  check("and its session carries none", !("excludeSubscribe" in plainConfig) && !("excludePublish" in plainConfig), plainConfig);

  check("aclEnv refuses an exclusion without its list",
    throws(() => aclEnv({ excludeSubscribe: ["team.secret"] }), /COTAL_EXCLUDE_SUBSCRIBE needs COTAL_ALLOW_SUBSCRIBE/));
  check("configFromEnv refuses an exclusion variable without its list variable",
    throws(() => configFromEnv({ ...base, COTAL_EXCLUDE_PUBLISH: "team.secret" }), /COTAL_EXCLUDE_PUBLISH needs COTAL_ALLOW_PUBLISH/));
  check("configFromEnv refuses an exclusion that removes nothing",
    throws(() => configFromEnv({ ...base, COTAL_ALLOW_SUBSCRIBE: "team.>", COTAL_EXCLUDE_SUBSCRIBE: "ops" }), /removes nothing/));
  check("configFromEnv refuses a subscription the exclusions remove",
    throws(() => configFromEnv({ ...base, COTAL_SUBSCRIBE: "team.secret", COTAL_ALLOW_SUBSCRIBE: ">", COTAL_EXCLUDE_SUBSCRIBE: "team.secret" }), /excluded/));
  check("configFromEnv refuses a quiet channel the exclusions remove",
    throws(() => configFromEnv({ ...base, ...env, COTAL_QUIET: "team.secret" }), /quiet channel "team.secret" is not within allowSubscribe/));
  check("and accepts a quiet sibling under the same wildcard",
    same(configFromEnv({ ...base, ...env, COTAL_QUIET: "team.a.public" }).quiet, ["team.a.public"]));

  const dir = mkdtempSync(join(tmpdir(), "exclusions-client-"));
  const file = join(dir, "alice.md");
  writeFileSync(file, `---\nname: alice\nsubscribe: [team.a]\nallowSubscribe: { allow: [">"], exclude: [team.secret] }\nallowPublish: { allow: ["team.>"], exclude: ["team.*.private"] }\n---\nA persona.\n`);
  const fromFile = configFromEnv({ ...base, COTAL_AGENT_FILE: file });
  check("with no list variable, the session reads the persona file's exclusions",
    same(fromFile.allowSubscribe, [">"]) && same(fromFile.excludeSubscribe, ["team.secret"]) && same(fromFile.excludePublish, ["team.*.private"]), fromFile);
  const overridden = configFromEnv({ ...base, COTAL_AGENT_FILE: file, COTAL_ALLOW_SUBSCRIBE: "team.>", COTAL_ALLOW_PUBLISH: "team.a" });
  check("a launcher's list replaces the file's together with its exclusions",
    !("excludeSubscribe" in overridden) && !("excludePublish" in overridden) && same(overridden.allowSubscribe, ["team.>"]), overridden);
}

// A real credential, minted offline, because a MeshAgent's endpoint reads its identity from it.
const identity = newIdentity();
const lifecycleUid = mintLifecycleUid();
const creds = await mintCreds(await createSpaceAuth("demo"), identity, "agent", { lifecycleUid, allowSubscribe: [">"], allowPublish: [] });
const authed: AgentConfig = {
  space: "demo", name: "alice", servers: "nats://127.0.0.1:1", kind: "agent", tls: false, id: identity.id, creds, lifecycleUid, capabilities: ["spawn"],
  subscribe: ["team.a"], allowSubscribe: [">"], excludeSubscribe: READ_EXCLUDE, allowPublish: ["team.>"], excludePublish: POST_EXCLUDE,
};
const tool = (name: string) => cotalToolSpecs(authed, "smoke").find((s) => s.name === name)!;

console.log("2. sends");
{
  const sent: string[] = [];
  const agent = {
    connected: true,
    joinedChannels: () => ["team.secret", "team.a.private", "team.a"],
    describeSendChannel: async () => ({ known: true, hints: [] }),
    send: async (_text: string, channel: string) => { sent.push(channel); return { channel, mentions: [] }; },
    channelInfo: () => ({ replay: false, registered: true }),
  } as unknown as MeshAgent;
  const send = tool("cotal_send");
  for (const channel of ["team.secret", "team.b.private"]) {
    const r = await send.run(agent, authed, { text: "hi", channel });
    check(`a post to excluded #${channel} is refused before it is sent`,
      r.isError === true && sent.length === 0 && r.text.startsWith(`Can't post to #${channel}: it's outside your post ACL (allowPublish: #team.> except #team.secret, #team.*.private).`), r.text);
  }
  for (const channel of ["team.secrets", "team.b.public"]) {
    sent.length = 0;
    const r = await send.run(agent, authed, { text: "hi", channel });
    check(`a post to sibling #${channel} under the same wildcard is sent`, !r.isError && same(sent, [channel]), r.text);
  }
  check("the default send channel skips excluded channels the agent reads", defaultSendChannel(authed, ["team.secret", "team.a.private", "team.a"]) === "team.a");
  sent.length = 0;
  const r = await send.run(agent, authed, { text: "hi" });
  check("and a send with no channel goes to that sibling", !r.isError && same(sent, ["team.a"]), r.text);
}

console.log("3. joins, the channel list and channel modes");
{
  const joined: string[] = [];
  const agent = {
    connected: true,
    joinChannel: async (channel: string) => { joined.push(channel); return { joined: true, backfilled: 0, durable: true }; },
    channelInfo: () => ({ replay: false, registered: false }),
    listChannels: async () => ["team.a", "team.secret", "team.b.private", "vault.x"].map((channel) => ({ channel, joined: false, replay: false, mode: "normal" })),
  } as unknown as MeshAgent;
  const join = tool("cotal_join");
  for (const [channel, why] of [
    ["team.secret", "a concrete exclusion"],
    ["team.b.private", "under a pattern exclusion"],
    ["vault.>", "a family the exclusions cover in full"],
    ["team.*.private", "a pattern equal to an exclusion"],
  ] as const) {
    joined.length = 0;
    const r = await join.run(agent, authed, { channel });
    check(`a join on #${channel} is refused (${why})`,
      r.isError === true && joined.length === 0 && r.text.startsWith(`Can't join #${channel}: it's outside your read ACL (allowSubscribe: #> except #team.secret, #team.*.private, #vault.>).`), r.text);
  }
  for (const [channel, why] of [
    ["team.a", "a concrete sibling"],
    ["team.b.public", "a sibling under the pattern exclusion"],
    ["team.>", "a family that only partly overlaps the exclusions"],
    ["team.*", "a pattern that only partly overlaps the exclusions"],
  ] as const) {
    joined.length = 0;
    const r = await join.run(agent, authed, { channel });
    check(`a join on #${channel} goes ahead (${why})`, !r.isError && same(joined, [channel]), r.text);
  }

  const r = await tool("cotal_channels").run(agent, authed, {});
  check("the channel list counts excluded channels as outside the read ACL",
    r.text.includes("#team.a") && !r.text.includes("#team.secret") && !r.text.includes("#vault.x") && r.text.includes("Not listed: 3 channels outside your read ACL"), r.text);

  const mesh = new MeshAgent(authed);
  let refusal = "";
  try { await mesh.setChannelMode("team.secret", "quiet"); }
  catch (e) { refusal = (e as Error).message; }
  check("a channel mode on an excluded channel is refused", refusal === `"team.secret" is not within your read ACL (allowSubscribe) [>] minus [team.secret, team.*.private, vault.>]`, refusal);
  let sibling = "";
  try { await mesh.setChannelMode("team.secrets", "quiet"); }
  catch (e) { sibling = (e as Error).message; }
  check("and a sibling passes the read check", !sibling.includes("read ACL") && mesh.channelMode("team.secrets") === "quiet", sibling);
}

console.log("4. spawns and personas");
{
  type Recorded = { command: string; args?: Record<string, unknown> };
  const recorder = (): { agent: MeshAgent; calls: Recorded[] } => {
    const agent = new MeshAgent(authed);
    const calls: Recorded[] = [];
    (agent as unknown as { ep: unknown }).ep = {
      invokeService: (endpoint: string, command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return Promise.resolve({ reply: { ok: true, data: { name: args?.name, mode: "pty" } }, responder: { endpoint, instanceId: "i", epoch: 0 } });
      },
      principal: { owner: "local", actor: "alice" },
    };
    agent.invokeEndpoint = (agent as unknown as { ep: { invokeService: MeshAgent["invokeEndpoint"] } }).ep.invokeService;
    (agent as unknown as { _connected: boolean })._connected = true;
    return { agent, calls };
  };

  const excluded = recorder();
  const refused = await excluded.agent.spawn("helper", undefined, { join: ["team.secret"] });
  check("a spawn's join on an excluded channel is refused before anything is sent",
    refused.ok === false && /join: "team.secret" is not within your read ACL \(allowSubscribe\) \[>\] minus \[team.secret, team.\*.private, vault.>\]/.test(refused.error ?? "") && excluded.calls.length === 0, refused);

  const sibling = recorder();
  await sibling.agent.spawn("helper", undefined, { join: ["team.secrets"] });
  const spawned = sibling.calls.find((c) => c.command === "spawn");
  check("a spawn's join on a sibling is sent", same(spawned?.args?.join, ["team.secrets"]), spawned?.args);
  check("the spawn carries the caller's exclusions in callerAcl as { allow, exclude }",
    same(spawned?.args?.callerAcl, { allowSubscribe: { allow: [">"], exclude: READ_EXCLUDE }, allowPublish: { allow: ["team.>"], exclude: POST_EXCLUDE } }), spawned?.args?.callerAcl);

  const plain = new MeshAgent({ ...authed, excludeSubscribe: undefined, excludePublish: undefined, subscribe: [], allowSubscribe: ["team.>"], allowPublish: ["team.a"] });
  const plainCalls: Recorded[] = [];
  (plain as unknown as { ep: unknown }).ep = (sibling.agent as unknown as { ep: unknown }).ep;
  plain.invokeEndpoint = async (endpoint, command, args) => { plainCalls.push({ command, args }); return { reply: { ok: true, data: { name: args?.name, mode: "pty" } }, responder: { endpoint, instanceId: "i", epoch: 0 } } as never; };
  (plain as unknown as { _connected: boolean })._connected = true;
  await plain.spawn("helper");
  check("a caller with no exclusions sends plain lists in callerAcl",
    same(plainCalls.find((c) => c.command === "spawn")?.args?.callerAcl, { allowSubscribe: ["team.>"], allowPublish: ["team.a"] }), plainCalls);

  type Parse = { safeParse: (v: unknown) => { success: boolean } };
  const spawnTool = tool("cotal_spawn") as unknown as { schema: { shape: Record<string, Parse> }; run: (a: MeshAgent, c: AgentConfig, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> };
  const persona = { prompt: "You review.", allowSubscribe: { allow: ["team.>"], exclude: ["team.secret"] }, allowPublish: { allow: ["team.a"], exclude: ["team.a.x"] } };
  check("the inline persona schema takes { allow, exclude }", spawnTool.schema.shape.persona.safeParse(persona).success);
  check("and refuses an object with no exclusion or an unknown key",
    !spawnTool.schema.shape.persona.safeParse({ prompt: "x", allowSubscribe: { allow: ["team.>"], exclude: [] } }).success &&
      !spawnTool.schema.shape.persona.safeParse({ prompt: "x", allowSubscribe: { allow: ["team.>"], exclude: ["team.x"], owner: "u" } }).success);
  const viaTool = recorder();
  await spawnTool.run(viaTool.agent, authed, { name: "helper", persona });
  check("cotal_spawn passes the persona's { allow, exclude } lists to the manager as written",
    same(viaTool.calls.find((c) => c.command === "spawn")?.args?.persona, persona), viaTool.calls);

  const personaTool = tool("cotal_persona") as unknown as typeof spawnTool;
  check("cotal_persona's read list takes either shape",
    personaTool.schema.shape.allowSubscribe.safeParse(["team.>"]).success && personaTool.schema.shape.allowSubscribe.safeParse({ allow: ["team.>"], exclude: ["team.secret"] }).success);
  const defined = recorder();
  await personaTool.run(defined.agent, authed, { name: "reviewer", prompt: "You review.", allowSubscribe: persona.allowSubscribe, allowPublish: ["team.a"] });
  const definition = defined.calls.find((c) => c.command === "define-persona")?.args;
  check("cotal_persona passes { allow, exclude } to define-persona as written",
    same(definition?.allowSubscribe, persona.allowSubscribe) && same(definition?.allowPublish, ["team.a"]), definition);
}

console.log("5. the endpoint's read exclusions");
{
  const routed = (config: AgentConfig) => (new MeshAgent(config) as unknown as { ep: { excludeSubscribe: readonly string[] } }).ep.excludeSubscribe;
  check("an authenticated session hands its read exclusions to the endpoint, which routes history by them",
    same(routed(authed), READ_EXCLUDE));
  check("an open session does not: it has no withheld history row and no delivery daemon to ask",
    same(routed({ ...authed, id: undefined, creds: undefined, lifecycleUid: undefined }), []));
}

console.log("6. the orientation card");
{
  const agent = {
    id: "ALICEID0000000000000000000000000000000000000", status: "working", attention: "open", connected: true, transportConnected: true,
    readRoster: async () => ({ roster: [] }), inboxCount: () => 0, channelInfo: () => ({ replay: false, registered: false }),
  } as unknown as MeshAgent;
  const o = buildOrientation(agent, authed, [], 1, await agent.readRoster());
  check("the card carries the exclusions beside the lists", same(o.access.readExclude, READ_EXCLUDE) && same(o.access.postExclude, POST_EXCLUDE), o.access);
  const text = renderOrientation(o);
  check("and shows them next to the read and post lists",
    text.includes("  • excluded from reading: #team.secret, #team.*.private, #vault.> (never delivered; joining one is refused)") &&
      text.includes("  • post: #team.>\n  • excluded from posting: #team.secret, #team.*.private"), text);
  const plain = buildOrientation(agent, { ...authed, excludeSubscribe: undefined, excludePublish: undefined }, [], 1, await agent.readRoster());
  check("a card with no exclusions carries and shows none", !("readExclude" in plain.access) && !("postExclude" in plain.access) && !renderOrientation(plain).includes("excluded from"));
}

console.log(`\nCHANNEL-EXCLUSIONS-CLIENT SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

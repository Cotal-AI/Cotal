/**
 * Send-channel receipt (#989).
 *
 * `cotal_send` still publishes to any well-formed name (ad hoc create is allowed).
 * The defect was the SUCCESS LINE: a typo of an existing channel returned the same
 * words as a send into a known room. The discriminating assertion is that a caller
 * can TELL. A cell that only asserts "bogus send fails" would pass against a design
 * that also breaks channel creation.
 *
 * No broker: describeSendChannel is graded through a stub endpoint. closeChannelNames
 * is graded as a pure function. cotal_send / cotal_channel_info are graded through
 * the live tool specs with a stub agent.
 *
 * Run: `pnpm smoke:send-channel-receipt`
 */
import { MAX_CHANNEL_LENGTH } from "@cotal-ai/core";
import { closeChannelNames, MeshAgent, type MeshAgent as MeshAgentType } from "../src/agent.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import type { AgentConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? extra : "");
  }
};

check("a one-substitution typo of a known name is a close match", closeChannelNames("lane.ci", ["lane.cj"]).includes("lane.cj"));
check("an unrelated name is not a close match", closeChannelNames("lane.ci", ["ops"]).length === 0);
check("the known name itself is not listed as a suggestion", closeChannelNames("lane.ci", ["lane.ci"]).length === 0);

function stubAgent(opts: {
  joined: string[];
  listed: { channel: string }[];
  listThrows?: boolean;
  registered?: string[];
}): MeshAgentType {
  const registered = new Set(opts.registered ?? []);
  const ep = {
    joinedChannels: () => opts.joined,
    listChannels: async () => {
      if (opts.listThrows) throw new Error("no stream");
      return opts.listed;
    },
    getChannelConfig: (channel: string) => (registered.has(channel) ? { description: "from registry" } : undefined),
  };
  return { ep, joinedChannels: () => opts.joined, connected: true } as unknown as MeshAgentType;
}

const proto = MeshAgent.prototype as unknown as {
  describeSendChannel: (this: MeshAgentType, c: string) => Promise<string>;
};

{
  const agent = stubAgent({ joined: ["lane.ci"], listed: [{ channel: "lane.ci" }, { channel: "ops" }] });
  const existing = await proto.describeSendChannel.call(agent, "lane.ci");
  const invented = await proto.describeSendChannel.call(agent, "lane.cj");
  check("send to a joined name reports existing", existing === "existing channel");
  check(
    "send to a one-edit typo reports new and names the close match",
    invented.includes("new channel") && invented.includes("#lane.ci"),
    invented,
  );
  check("the typo receipt is not identical to the existing receipt", existing !== invented);
}

{
  const agent = stubAgent({ joined: [], listed: [], listThrows: true, registered: ["ops"] });
  const fromRegistry = await proto.describeSendChannel.call(agent, "ops");
  const invented = await proto.describeSendChannel.call(agent, "zzz-typo-probe-4471");
  check("a registry entry still counts as existing when listChannels throws", fromRegistry === "existing channel");
  check(
    "an unknown name with no list still reports new (create is not refused)",
    invented.includes("new channel") && !invented.includes("did you mean"),
    invented,
  );
}

{
  const cfg = {
    space: "demo",
    name: "alice",
    servers: "nats://127.0.0.1:4222",
    subscribe: ["lane.ci"],
    allowSubscribe: ["lane.ci"],
    allowPublish: ["lane.ci", "lane.cj"],
    kind: "agent",
    tls: false,
  } as AgentConfig;
  const specs = cotalToolSpecs(cfg, "smoke");
  const send = specs.find((s) => s.name === "cotal_send")!;
  const info = specs.find((s) => s.name === "cotal_channel_info")!;
  const agent = stubAgent({ joined: ["lane.ci"], listed: [{ channel: "lane.ci" }] });
  (agent as unknown as { send: MeshAgentType["send"]; describeSendChannel: MeshAgentType["describeSendChannel"]; channelInfo: MeshAgentType["channelInfo"] }).send =
    async (_t, channel) =>
      ({
        id: "m",
        ts: 1,
        space: "demo",
        from: { id: "a", name: "alice", kind: "agent" },
        channel: channel ?? "lane.ci",
        parts: [],
      }) as never;
  (agent as unknown as { describeSendChannel: MeshAgentType["describeSendChannel"] }).describeSendChannel = (c) =>
    proto.describeSendChannel.call(agent, c);
  (agent as unknown as { channelInfo: MeshAgentType["channelInfo"] }).channelInfo = (channel) => ({
    replay: true,
    registered: channel === "lane.ci",
  });

  const known = await send.run(agent, cfg, { text: "hi", channel: "lane.ci" });
  const typo = await send.run(agent, cfg, { text: "hi", channel: "lane.cj" });
  check("cotal_send still succeeds on a new name (create is allowed)", !typo.isError, typo.text);
  check("cotal_send on a known name does not say new channel", !known.text.includes("new channel"), known.text);
  check("cotal_send on a typo says new channel so the caller can TELL", typo.text.includes("new channel"), typo.text);
  check("cotal_send on a known name says existing channel", known.text.includes("existing channel"), known.text);

  const knownInfo = await Promise.resolve(info.run(agent, cfg, { channel: "lane.ci" }));
  const inventedInfo = await Promise.resolve(info.run(agent, cfg, { channel: "lane.cj" }));
  check("channel_info on a registered name does not say not in the registry", !knownInfo.text.includes("not in the channel registry"), knownInfo.text);
  check(
    "channel_info on an unregistered name says so (the other half of the indistinguishable pair)",
    inventedInfo.text.includes("not in the channel registry"),
    inventedInfo.text,
  );
}

// ── #1229: send/dm consult whether the roster READ succeeded, not just the roster. A real
//    MeshAgent over a stub endpoint, so the guard runs through the shipped send()/dm() paths. ──
{
  const cfg1229 = {
    space: "demo",
    name: "alice",
    servers: "nats://127.0.0.1:4222",
    subscribe: ["ch"],
    allowSubscribe: ["ch"],
    allowPublish: ["ch"],
    kind: "agent",
    tls: false,
  } as AgentConfig;
  const mkMsg = (channel = "ch") =>
    ({ id: "m", ts: 1, space: "demo", from: { id: "a", name: "alice", kind: "agent" }, channel, parts: [] }) as never;
  const OTTO = { card: { id: "OTTOID0000000000000000000000000000000000000", name: "otto", role: "worker" }, status: "idle" };

  /** A presence read that fails the way an old credential does: the broker refuses the Direct Get. */
  const refused = () => Promise.reject(new Error("presence read refused for alice: this credential may not publish $JS.API.DIRECT.GET.KV_cotal_presence_demo"));

  function agentOverEp(ep: Record<string, unknown>): MeshAgentType {
    const a = new MeshAgent({ ...cfg1229 });
    a.on("error", () => {});
    (a as unknown as { _connected: boolean })._connected = true;
    (a as unknown as { ep: Record<string, unknown> }).ep = ep;
    return a;
  }

  // (d) the read returns the peer: the send goes out, after exactly one read.
  {
    let reads = 0;
    const multicast: { text: string; opts: { channel?: string; mentions?: string[] } }[] = [];
    const agent = agentOverEp({
      card: { id: "ALICEID0000000000000000000000000000000000000", name: "alice" },
      getRoster: () => [OTTO],
      readPresence: async () => { reads++; return [OTTO]; },
      multicast: async (text: string, opts: { channel?: string; mentions?: string[] }) => {
        multicast.push({ text, opts });
        return mkMsg(opts?.channel);
      },
      unicast: async () => mkMsg("dm"),
      unicastAttributed: async () => ({ msg: mkMsg("dm"), ack: { seq: 7, duplicate: false } }),
    });
    const msg = await agent.send("hi", "ch", ["otto"]);
    check(
      "1229:d send reads the roster once and then publishes the mention",
      reads === 1 && multicast.length === 1 && multicast[0]!.opts.mentions?.[0] === "otto" && msg.channel === "ch",
      { reads, multicast },
    );
  }

  // (e) a failed read and an empty roster: the refusal names the read's error, never "unknown mention".
  {
    const multicast: unknown[] = [];
    const agent = agentOverEp({
      card: { id: "ALICEID0000000000000000000000000000000000000", name: "alice" },
      getRoster: () => [],
      readPresence: refused,
      multicast: async () => {
        multicast.push("called");
        return mkMsg();
      },
      unicast: async () => mkMsg("dm"),
      unicastAttributed: async () => ({ msg: mkMsg("dm"), ack: { seq: 7, duplicate: false } }),
    });
    let threw = "";
    try {
      await agent.send("hi", "ch", ["otto"]);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(
      "1229:e send under a failed read refuses naming the read's error and the missing grant, not \"unknown mention\"",
      threw.includes("presence read failed") && threw.includes("DIRECT.GET.KV_cotal_presence_demo") && !threw.includes("unknown mention") && threw.includes("otto"),
      threw,
    );
    check("1229:e the refused send never reached multicast", multicast.length === 0, multicast);
  }

  // (f) a failed read and an empty roster: dm refuses naming the read's error, never "no peer", and never sends.
  {
    const unicast: unknown[] = [];
    const agent = agentOverEp({
      card: { id: "ALICEID0000000000000000000000000000000000000", name: "alice" },
      getRoster: () => [],
      readPresence: refused,
      multicast: async () => mkMsg(),
      unicast: async () => {
        unicast.push("called");
        return mkMsg("dm");
      },
      unicastAttributed: async () => ({ msg: mkMsg("dm"), ack: { seq: 7, duplicate: false } }),
    });
    let threw = "";
    try {
      await agent.dm("otto", "x");
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(
      "1229:f dm under a failed read refuses naming the read's error, not \"no peer\"",
      threw.includes("presence read failed") && !threw.includes("no peer") && threw.includes("otto"),
      threw,
    );
    check("1229:f the refused dm never reached unicast", unicast.length === 0, unicast);
  }

  // (g) control: a read that succeeded keeps the existing refusal — the guard added no permissiveness.
  {
    const agent = agentOverEp({
      card: { id: "ALICEID0000000000000000000000000000000000000", name: "alice" },
      getRoster: () => [],
      readPresence: async () => [],
      multicast: async () => mkMsg(),
      unicast: async () => mkMsg("dm"),
      unicastAttributed: async () => ({ msg: mkMsg("dm"), ack: { seq: 7, duplicate: false } }),
    });
    let threw = "";
    try {
      await agent.send("hi", "ch", ["otto"]);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check("1229:g a read that succeeded still refuses an unobserved mention with the existing sentence", threw.includes("unknown mention"), threw);
  }

  // (h) a failed read with the peer in the last roster: an earlier read's row is still an
  //     observation, so the DM goes out rather than being refused over the failed read.
  {
    const unicast: { to: string; text: string }[] = [];
    const agent = agentOverEp({
      card: { id: "ALICEID0000000000000000000000000000000000000", name: "alice" },
      getRoster: () => [OTTO],
      readPresence: refused,
      multicast: async () => mkMsg(),
      unicast: async (to: string, text: string) => {
        unicast.push({ to, text });
        return mkMsg("dm");
      },
      unicastAttributed: async (to: string, text: string) => {
        unicast.push({ to, text });
        return { msg: mkMsg("dm"), ack: { seq: 7, duplicate: false } };
      },
    });
    const { peer, ack } = await agent.dm("otto", "x");
    check("1229:h dm to a peer in the last roster still publishes under a failed read", unicast.length === 1 && peer?.card.name === "otto", unicast);
    check("1229:h dm passes through the attributed ack sequence", ack.seq === 7, ack);
  }

  // (i) M3 proof: recipientStatusAtSend reflects the roster snapshot at send for both an offline
  //     and an idle card, the ack sequence passes through, and the cotal_dm tool text says
  //     "stored as seq 7" and "delivery not confirmed" for both.
  for (const status of ["offline", "idle"] as const) {
    const peerCard = { card: { id: "OTTOID0000000000000000000000000000000000000", name: "otto", role: "worker" }, status };
    const agent = agentOverEp({
      card: { id: "ALICEID0000000000000000000000000000000000000", name: "alice" },
      getRoster: () => [peerCard],
      readPresence: async () => [peerCard],
      multicast: async () => mkMsg(),
      unicast: async () => mkMsg("dm"),
      unicastAttributed: async () => ({ msg: mkMsg("dm"), ack: { seq: 7, duplicate: false } }),
    });
    const dmResult = await agent.dm("otto", "x");
    check(
      `1229:i dm() reports recipientStatusAtSend ${status} from the roster snapshot`,
      dmResult.ack.seq === 7 && dmResult.recipientStatusAtSend === status,
      dmResult,
    );
    const cfgDm = cfg1229;
    const specsDm = cotalToolSpecs(cfgDm, "smoke");
    const dmTool = specsDm.find((s) => s.name === "cotal_dm")!;
    (agent as unknown as { dm: MeshAgentType["dm"] }).dm = async () => dmResult;
    const dmText = await Promise.resolve(dmTool.run(agent, cfgDm, { to: "otto", text: "x" }));
    check(
      `1229:i cotal_dm text for a ${status} recipient says stored seq and delivery not confirmed`,
      dmText.text.includes("stored as seq 7") && dmText.text.includes("delivery not confirmed"),
      dmText.text,
    );
    // Only an offline recipient gets the notice of what happens to the stored DM.
    const notice = "otto is offline: the DM is delivered when otto reconnects, and a new agent spawned as otto does not receive it.";
    check(
      `1229:i cotal_dm text for a ${status} recipient ${status === "offline" ? "says" : "does not say"} otto is offline and when the DM arrives`,
      status === "offline" ? dmText.text.includes(notice) : !dmText.text.includes("is offline"),
      dmText.text,
    );
  }
}

// The default for a send with no channel. On a mesh that enforces ACLs it is the first channel the
// agent reads and may post to, so a read-only announcements channel listed first is skipped. Live
// repro: a Cloud agent reading [announce, team.rocket] defaulted to #announce and was refused.
{
  const userAuth = { owner: "u_x", actor: "alice", sentinelCreds: "creds", bearerCmd: ["true"] };
  const base = { space: "demo", name: "alice", servers: "nats://127.0.0.1:4222", kind: "agent", tls: false } as const;
  const run = async (cfg: AgentConfig, joined: string[]) => {
    const sent: (string | undefined)[] = [];
    const agent = stubAgent({ joined, listed: joined.map((channel) => ({ channel })) });
    (agent as unknown as { send: MeshAgentType["send"] }).send = async (_t, channel) => {
      sent.push(channel);
      return { id: "m", ts: 1, space: "demo", from: { id: "a", name: "alice", kind: "agent" }, channel: channel ?? joined[0], parts: [] } as never;
    };
    (agent as unknown as { describeSendChannel: MeshAgentType["describeSendChannel"] }).describeSendChannel = async () => "existing channel";
    const send = cotalToolSpecs(cfg, "smoke").find((s) => s.name === "cotal_send")!;
    const result = await send.run(agent, cfg, { text: "hi" });
    const described = (send.schema.shape.channel as { description?: string } | undefined)?.description ?? "";
    return { result, sent, described };
  };

  const authed = { ...base, subscribe: ["announce", "team.rocket"], allowSubscribe: ["announce", "team.rocket"], allowPublish: ["team.rocket", "team.rocket.>"], userAuth } as AgentConfig;
  const skip = await run(authed, ["announce", "team.rocket"]);
  check("an omitted channel goes to the first channel the agent may post to", !skip.result.isError && skip.sent[0] === "team.rocket", skip);
  check("the advertised default is the first channel the agent may post to", skip.described.includes("default: team.rocket"), skip.described);

  const readOnly = { ...base, subscribe: ["announce"], allowSubscribe: ["announce"], allowPublish: [], userAuth } as AgentConfig;
  const none = await run(readOnly, ["announce"]);
  check("with no channel it may post to, an omitted channel is refused before sending", none.result.isError === true && none.sent.length === 0 && none.result.text.includes("post to none"), none);
  check("the advertised text says there is no default to post to", none.described.includes("post to none"), none.described);
  check(
    "with nowhere to post, the refusal says an operator widens the grant and names cotal_dm meanwhile",
    none.result.text.includes("ask an operator to widen it") && none.result.text.includes("cotal_dm"),
    none.result.text,
  );

  // A seat on no channel at all (the fresh-helper case) is told the channels it may post to and the
  // exact next call, so the first send does not have to bounce through the orientation card.
  const nowhere = { ...base, subscribe: [], allowSubscribe: ["team.rocket"], allowPublish: ["team.rocket"], userAuth } as AgentConfig;
  const fresh = await run(nowhere, []);
  check(
    "on no channel, the refusal names the postable channel and the exact next call",
    fresh.result.isError === true && fresh.sent.length === 0 && fresh.result.text.includes("you are on no channel")
      && fresh.result.text.includes('cotal_send with channel: "team.rocket"') && fresh.result.text.includes("cotal_join team.rocket"),
    fresh.result.text,
  );
  check("the advertised text carries the same next call", fresh.described.includes('cotal_send with channel: "team.rocket"'), fresh.described);

  const elsewhere = { ...base, subscribe: ["announce"], allowSubscribe: ["announce", "team.rocket"], allowPublish: ["team.rocket"], userAuth } as AgentConfig;
  const other = await run(elsewhere, ["announce"]);
  check(
    "reading only a channel it may not post to, the refusal names what it reads and where it may post",
    other.result.isError === true && other.sent.length === 0 && other.result.text.includes("post to none of the channels you read (#announce)")
      && other.result.text.includes('cotal_send with channel: "team.rocket"'),
    other.result.text,
  );

  const open = { ...base, subscribe: ["announce", "lobby"], allowSubscribe: ["announce", "lobby"], allowPublish: [] } as AgentConfig;
  const unchanged = await run(open, ["announce", "lobby"]);
  check("an open mesh, which enforces no post ACL, keeps the first channel read", !unchanged.result.isError && unchanged.sent[0] === "announce", unchanged);
}

// A pattern as the channel is refused before any read or publish, and the refusal names the two ways
// to reach a channel family: one post to a channel the pattern matches, or a post to each by name.
{
  const cfg = {
    space: "demo",
    name: "alice",
    servers: "nats://127.0.0.1:4222",
    subscribe: ["team.>"],
    allowSubscribe: ["team.>"],
    allowPublish: ["team.>"],
    kind: "agent",
    tls: false,
  } as AgentConfig;
  const calls: string[] = [];
  const agent = stubAgent({ joined: ["team.>"], listed: [] });
  (agent as unknown as { joinedChannels: MeshAgentType["joinedChannels"] }).joinedChannels = () => {
    calls.push("joined");
    return ["team.>"];
  };
  (agent as unknown as { send: MeshAgentType["send"] }).send = async (_t, channel) => {
    calls.push(`send ${channel}`);
    return { id: "m", ts: 1, space: "demo", from: { id: "a", name: "alice", kind: "agent" }, channel, parts: [] } as never;
  };
  (agent as unknown as { describeSendChannel: MeshAgentType["describeSendChannel"] }).describeSendChannel = async (c) => {
    calls.push(`describe ${c}`);
    return "existing channel";
  };
  const send = cotalToolSpecs(cfg, "smoke").find((s) => s.name === "cotal_send")!;
  for (const pattern of ["team.>", "team.*.ci", ">", "*"]) {
    const refused = await send.run(agent, cfg, { text: "hi", channel: pattern });
    check(
      `cotal_send refuses the pattern ${pattern} before reading or sending`,
      refused.isError === true && calls.length === 0 && refused.text.includes("Nothing was sent."),
      { refused, calls },
    );
    check(
      `the refusal for ${pattern} says one post to a channel it matches reaches its connected followers`,
      refused.text.includes(`To reach the agents connected and following ${pattern} now, post once to one channel it matches.`),
      refused.text,
    );
    check(
      `the refusal for ${pattern} says a pattern follow has no durable backstop`,
      refused.text.includes("A pattern follow has no durable backstop, so a follower that is offline then may miss it."),
      refused.text,
    );
    check(
      `the refusal for ${pattern} says to post to each channel by name and where to list them`,
      refused.text.includes("To reach several channels, post to each by name; cotal_channels lists the existing ones."),
      refused.text,
    );
  }
  {
    const refused = await send.run(agent, cfg, { text: "hi", channel: "team.>" });
    check(
      "the whole refusal for team.> reads as written",
      refused.text ===
        `Couldn't send: "team.>" is a pattern, and a post goes to one concrete channel. To reach the agents connected and following team.> now, post once to one channel it matches. A pattern follow has no durable backstop, so a follower that is offline then may miss it. To reach several channels, post to each by name; cotal_channels lists the existing ones. Nothing was sent.`,
      refused.text,
    );
  }
  // A name that is not a channel name is refused too, with the send's own rule. The endpoint would
  // otherwise rewrite its characters onto a different subject than the receipt names (team.** goes
  // out as team.__), and the policy grammar's message would offer * and > as valid segments.
  for (const bad of ["team.>.x", "team. >", "team.**", "team.a*", "team.>>", "#*", "#team", "team..announce", "team/announce", "team.announce ", " team.announce", ""]) {
    const refused = await send.run(agent, cfg, { text: "hi", channel: bad });
    check(
      `${JSON.stringify(bad)} is refused as no channel name before reading or sending`,
      refused.isError === true && calls.length === 0 && refused.text.includes(`${JSON.stringify(bad)} is not a channel name.`) &&
        refused.text.includes("Nothing was sent.") && !refused.text.includes("is a pattern") && !/'[*>]'/.test(refused.text),
      { refused, calls },
    );
  }
  // The refusal says what a channel name is, with core's own length limit, and cuts a long name to
  // its first 64 characters.
  {
    const refused = await send.run(agent, cfg, { text: "hi", channel: "team.**" });
    check(
      "the no-channel-name refusal states the channel grammar",
      refused.text.includes("A channel name is segments of letters, digits, _ and - joined by dots, such as team.announce,"),
      refused.text,
    );
    check(
      `the no-channel-name refusal states core's limit of ${MAX_CHANNEL_LENGTH} characters`,
      refused.text.includes(`at most ${MAX_CHANNEL_LENGTH} characters. Nothing was sent.`),
      refused.text,
    );
  }
  // 64 different characters, taken in turn by index, so a cut in the wrong place shows.
  const symbols = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
  const counted = (start: number, length: number): string =>
    Array.from({ length }, (_, i) => symbols[(start + i) % symbols.length]).join("");
  // `team.**.` and then counted characters: a name that is no channel name, of the given length (over 8).
  const badName = (length: number): string => `team.**.${counted(8, length - 8)}`;
  {
    const whole = badName(64);
    const refused = await send.run(agent, cfg, { text: "hi", channel: whole });
    check(
      "a 64-character name that is no channel name is shown whole",
      refused.isError === true && calls.length === 0 && refused.text.includes(`${JSON.stringify(whole)} is not a channel name.`),
      refused.text,
    );
  }
  {
    const long = badName(65);
    const refused = await send.run(agent, cfg, { text: "hi", channel: long });
    check(
      "a 65-character name that is no channel name is shown cut to its first 64 characters",
      refused.isError === true && calls.length === 0 &&
        refused.text.includes(`${JSON.stringify(`${long.slice(0, 64)}…`)} is not a channel name.`) && !refused.text.includes(long),
      refused.text,
    );
  }
  {
    const over = counted(0, MAX_CHANNEL_LENGTH + 1);
    const refused = await send.run(agent, cfg, { text: "hi", channel: over });
    check(
      `a name one character over the ${MAX_CHANNEL_LENGTH}-character limit is refused as no channel name`,
      refused.isError === true && calls.length === 0 &&
        refused.text.includes(`${JSON.stringify(`${over.slice(0, 64)}…`)} is not a channel name.`) && !refused.text.includes(over),
      refused.text,
    );
  }
  const sent = await send.run(agent, cfg, { text: "hi", channel: "team.announce" });
  check("a channel the pattern matches still sends", !sent.isError && calls.includes("send team.announce"), { sent, calls });
  {
    const max = `team.${counted(5, MAX_CHANNEL_LENGTH - 5)}`;
    const at = await send.run(agent, cfg, { text: "hi", channel: max });
    check(`a name of ${MAX_CHANNEL_LENGTH} characters is sent`, !at.isError && calls.includes(`send ${max}`), at.text.slice(0, 200));
  }
  const described = (send.schema.shape.channel as { description?: string } | undefined)?.description ?? "";
  check(
    "the advertised channel text names both ways to reach a family",
    described.includes(
      "A pattern such as team.> is refused. To reach the agents connected and following team.> now, post once to one channel it matches, such as team.announce; to reach several channels, post to each by name (cotal_channels lists the existing ones).",
    ),
    described,
  );
  check("the cotal_send description says one channel", send.description === "Broadcast a message to everyone on one channel in your space.", send.description);
}

console.log(`\nSEND-CHANNEL-RECEIPT SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

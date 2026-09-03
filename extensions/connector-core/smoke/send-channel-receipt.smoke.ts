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

console.log(`\nSEND-CHANNEL-RECEIPT SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

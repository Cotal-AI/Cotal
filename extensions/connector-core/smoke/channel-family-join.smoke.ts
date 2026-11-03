/**
 * cotal_join for a channel family (#5404).
 *
 * A family such as team.> keeps stored copies from the join on, any other pattern is followed live
 * only, and a name that is no channel name is refused before anything joins. The read ACL is checked
 * by containment for a pattern: perm.* covers every channel perm.> matches only one segment deep, so
 * perm.> is refused under it.
 *
 * No broker: the tool runs over a stub agent, whose joinChannel returns what the endpoint would.
 * channel-family-auth covers that return against a real broker.
 *
 * Run: `pnpm smoke:channel-family:join`
 */
import type { MeshAgent } from "../src/agent.js";
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

type JoinResult = { joined: boolean; backfilled: number; durable: boolean; reason?: string };

const cfg = {
  space: "demo",
  name: "alice",
  servers: "nats://127.0.0.1:4222",
  subscribe: [],
  allowSubscribe: ["team.>", "perm.*", "ops"],
  allowPublish: [],
  kind: "agent",
  tls: false,
} as unknown as AgentConfig;
const join = cotalToolSpecs(cfg, "smoke").find((s) => s.name === "cotal_join")!;

const calls: string[] = [];
const agentFor = (result: JoinResult): MeshAgent =>
  ({
    connected: true,
    joinChannel: async (channel: string) => {
      calls.push(channel);
      return result;
    },
    channelInfo: () => ({ replay: false, registered: false }),
  }) as unknown as MeshAgent;

{
  const r = await join.run(agentFor({ joined: true, backfilled: 0, durable: true }), cfg, { channel: "team.>" });
  check(
    "a family joined with its membership says stored copies are on for its durable channels",
    !r.isError && r.text.startsWith(
      "Joined #team.> (stored copies on: posts on its durable channels are kept for you while you're offline, from now on; its live channels reach you only while you're connected).",
    ),
    r.text,
  );
  check(
    "the family's info says a pattern has no registry entry of its own",
    r.text.includes("a pattern: it has no registry entry of its own") && !r.text.includes("A prior send may have invented it"),
    r.text,
  );
}
{
  // A malformed pattern is no channel at all, so its info is a refusal, never a pattern's description.
  const info = cotalToolSpecs(cfg, "smoke").find((s) => s.name === "cotal_channel_info")!;
  const r = await info.run(agentFor({ joined: false, backfilled: 0, durable: false }), cfg, { channel: "team.>.x" });
  check(
    "cotal_channel_info refuses a malformed pattern as no channel name",
    r.isError === true && r.text.includes('"team.>.x" is not a channel name') && !r.text.includes("a pattern"),
    r.text,
  );
}
{
  const r = await join.run(agentFor({ joined: true, backfilled: 0, durable: false, reason: "durable backstop unavailable (no responders)" }), cfg, { channel: "team.ci.>" });
  check(
    "a family joined without its membership says live only and that offline posts are not kept",
    r.text.startsWith("Joined #team.ci.> (LIVE only — durable backstop unavailable (no responders); messages sent while you're offline won't be replayed)."),
    r.text,
  );
}
{
  const reason = "a pattern with * or the root > has no stored copies; follow a concrete channel or a family such as review.>";
  const r = await join.run(agentFor({ joined: true, backfilled: 0, durable: false, reason }), cfg, { channel: "team.*" });
  check("a pattern with * joined says live only and why", r.text.startsWith(`Joined #team.* (live only: ${reason}).`), r.text);
}
{
  const r = await join.run(agentFor({ joined: true, backfilled: 0, durable: true }), cfg, { channel: "ops" });
  check("a concrete durable channel keeps its own headline", r.text.startsWith("Joined #ops (durable backstop active"), r.text);
}

calls.length = 0;
for (const bad of ["team.**", "team.>.x", "team..ci", ""]) {
  const r = await join.run(agentFor({ joined: true, backfilled: 0, durable: true }), cfg, { channel: bad });
  check(
    `${JSON.stringify(bad)} is refused as no channel name before anything joins`,
    r.isError === true && calls.length === 0 && r.text.startsWith(`Couldn't join: ${JSON.stringify(bad)} is not a channel name.`) &&
      r.text.endsWith("Nothing was joined."),
    { r, calls },
  );
}

for (const [channel, why] of [
  ["perm.>", "perm.* covers one segment under perm"],
  ["team", "team.> does not cover team itself"],
  [">", "no entry covers every channel"],
] as const) {
  const r = await join.run(agentFor({ joined: true, backfilled: 0, durable: true }), cfg, { channel });
  check(`${channel} is refused as outside the read ACL (${why})`, r.isError === true && calls.length === 0 && r.text.startsWith(`Can't join #${channel}: it's outside your read ACL`), { r, calls });
}
for (const channel of ["team.>", "team.ci.>", "team.*", "perm.*", "perm.x"]) {
  calls.length = 0;
  await join.run(agentFor({ joined: true, backfilled: 0, durable: true }), cfg, { channel });
  check(`${channel} passes the read ACL and is joined`, calls.length === 1 && calls[0] === channel, calls);
}

check(
  "the cotal_join description says what a family keeps",
  join.description.includes("Under a family such as review.>, posts on its durable channels are kept for you while you are offline, from the join on, and its live channels reach you only while you are connected."),
  join.description,
);

console.log(`\nCHANNEL-FAMILY-JOIN SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

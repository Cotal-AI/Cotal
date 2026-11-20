/**
 * Channel exclusions in the workspace layer (SPEC §9).
 *
 *   1. `agentGrants` reads a credential's deny rows back as its read and post exclusions, so a
 *      remint built from the credential keeps them, and `grantMintFlags` names them;
 *   2. a managed launch request sends a list with exclusions as `{ allow, exclude }` and a list
 *      without them as the plain array it always was, and the launch's `acl` report reads either;
 *   3. a chat session refuses an excluded channel and keeps its siblings, for a concrete channel and
 *      under a pattern exclusion, and a pattern join excluded in full; `/whoami` shows the exclusions;
 *   4. a static chat open refuses exclusions that cannot be written before anything is sent.
 *
 * No broker and no manager: the credential is minted offline from a throwaway space signer, the
 * manager's `start` is a recording function, and the static open refuses before it dials.
 *
 * Run: `pnpm smoke:channel-exclusions-workspace`
 */
import { createSpaceAuth, credsClaims, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { agentGrants, grantMintFlags } from "../src/agent-grants.js";
import { managedLaunchAcl, requestManagedLaunch } from "../src/launch.js";
import { describeConnection } from "../src/chat/compose.js";
import { grantRefusal } from "../src/chat/native-session.js";
import { openStaticChatSession } from "../src/chat/static-session.js";
import type { ConnectionReport } from "../src/chat/session.js";
import type { ChatWords } from "../src/chat/words.js";
import type { ControlClient } from "../src/control/manager.js";
import type { MeshTarget } from "../src/mesh-target.js";

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
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const SPACE = "excl";
const auth = await createSpaceAuth(SPACE);

console.log("1. a credential's grants read back with their exclusions");
{
  const lifecycleUid = mintLifecycleUid();
  const creds = await mintCreds(auth, newIdentity(), "agent", {
    lifecycleUid, allowSubscribe: [">"], excludeSubscribe: ["team.secret", "team.*.private"],
    allowPublish: ["team.>"], excludePublish: ["team.secret.>"], brokerVersion: "2.14.0",
  });
  const grants = agentGrants(credsClaims(creds).nats ?? {}, SPACE);
  check("the subscribe deny rows read back as the read exclusions", same(grants.read, [">"]) && same(grants.excludeRead, ["team.secret", "team.*.private"]), grants);
  check("the own publish deny rows read back as the post exclusions", same(grants.post, ["team.>"]) && same(grants.excludePost, ["team.secret.>"]), grants);
  check("the mint flags carry the exclusions beside their lists",
    grantMintFlags(grants) === " --allow-subscribe '>' --exclude-subscribe 'team.secret,team.*.private' --allow-publish 'team.>' --exclude-publish 'team.secret.>' --no-persona",
    grantMintFlags(grants));

  const plain = agentGrants(credsClaims(await mintCreds(auth, newIdentity(), "agent", { lifecycleUid, allowSubscribe: ["team.>"], allowPublish: ["team.a"] })).nats ?? {}, SPACE);
  check("a credential with no exclusions reads back none", same(plain.excludeRead, []) && same(plain.excludePost, []), plain);
  check("and its mint flags name no exclusion flag", grantMintFlags(plain) === " --allow-subscribe 'team.>' --allow-publish team.a --no-persona", grantMintFlags(plain));
}

console.log("2. the managed launch request and its acl report");
{
  let sent: Record<string, unknown> | undefined;
  const record = async (args: Record<string, unknown>) => { sent = args; };
  await requestManagedLaunch({ persona: "p", allowSubscribe: [">"], excludeSubscribe: ["team.secret"], allowPublish: ["team.>"], excludePublish: ["team.*.private"] }, record);
  check("a list with exclusions is sent as { allow, exclude }",
    same(sent?.allowSubscribe, { allow: [">"], exclude: ["team.secret"] }) && same(sent?.allowPublish, { allow: ["team.>"], exclude: ["team.*.private"] }), sent);
  await requestManagedLaunch({ persona: "p", allowSubscribe: ["team.>"], allowPublish: ["team.a"] }, record);
  check("a list without them is the plain array", same(sent?.allowSubscribe, ["team.>"]) && same(sent?.allowPublish, ["team.a"]), sent);
  let refused = "";
  try { await requestManagedLaunch({ persona: "p", excludePublish: ["team.secret"] }, record); }
  catch (e) { refused = (e as Error).message; }
  check("an exclusion without its list is refused", /allowPublish exclusions need its allowPublish list/.test(refused), refused);

  const acl = managedLaunchAcl({
    requested: { allowSubscribe: { allow: [">"], exclude: ["team.secret"] }, allowPublish: ["team.>"] },
    effective: { allowSubscribe: { allow: ["team.>"], exclude: ["team.secret"] }, allowPublish: ["team.a"] },
  });
  check("the acl report reads either shape",
    same(acl?.requested, { allowSubscribe: [">"], allowPublish: ["team.>"], excludeSubscribe: ["team.secret"], excludePublish: [] }) &&
      same(acl?.effective, { allowSubscribe: ["team.>"], allowPublish: ["team.a"], excludeSubscribe: ["team.secret"], excludePublish: [] }), acl);
  check("and refuses an object form with no exclusion",
    managedLaunchAcl({ requested: { allowSubscribe: { allow: [">"], exclude: [] }, allowPublish: [] }, effective: { allowSubscribe: [], allowPublish: [] } }) === undefined);
}

console.log("3. chat session checks");
{
  const words = { reopen: (channel: string) => `reopen on ${channel}` } as ChatWords;
  const exclude = ["team.secret", "team.*.private", "vault.>"];
  for (const channel of ["team.secret", "team.b.private", "vault.x", "vault.>"]) {
    const r = grantRefusal([">"], channel, "read", words, exclude);
    check(`#${channel} is refused`, r?.code === "PERMISSION_DENIED" && r.message === `#${channel} is outside this session's read grant. reopen on ${channel}`, r);
  }
  for (const channel of ["team.secrets", "team.b.public", "team.>"])
    check(`#${channel} passes`, grantRefusal([">"], channel, "read", words, exclude) === undefined);
  const report = {
    state: "connected", bufferedInbox: 0, joinedChannels: ["team.a"], attention: "open", channelModes: {},
    identity: { mode: "static", space: SPACE, principal: "local.x", lifecycleUid: "u".repeat(26), label: "me", allowSubscribe: [">"], allowPublish: ["team.>"], excludeSubscribe: ["team.secret"], excludePublish: ["team.*.private"] },
  } as unknown as ConnectionReport;
  check("/whoami shows the exclusions beside each ceiling", describeConnection(report)[2] === "may read: > except team.secret · may post: team.> except team.*.private", describeConnection(report));
}

console.log("4. a static chat open refuses exclusions that cannot be written, before it dials");
{
  const target = { mode: "auth", auth, space: SPACE, server: "nats://127.0.0.1:1", tlsRequired: false } as unknown as MeshTarget;
  const control = {} as ControlClient;
  const words = { reopen: () => "" } as unknown as ChatWords;
  for (const [what, options, pattern] of [
    ["a read exclusion with no explicit read ceiling", { subscribe: ["team.a"], excludeSubscribe: ["team.secret"] }, /needs an explicit allowSubscribe/],
    ["an initial channel the exclusions remove", { subscribe: ["team.secret"], allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"] }, /excluded/],
    ["a post exclusion that removes nothing", { allowPublish: ["team.a"], excludePublish: ["ops"] }, /removes nothing/],
  ] as const) {
    let refused: { code?: string; message?: string } = {};
    try { await openStaticChatSession(target, { label: "me", words, control, ...options }); }
    catch (e) { refused = e as { code?: string; message?: string }; }
    check(`${what} is refused as usage`, refused.code === "USAGE_INVALID" && pattern.test(refused.message ?? ""), refused.message);
  }
}

console.log(`\nCHANNEL-EXCLUSIONS-WORKSPACE SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

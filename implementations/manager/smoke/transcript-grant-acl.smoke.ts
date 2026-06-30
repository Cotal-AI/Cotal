/**
 * Auth-mode transcript-grant smoke — proves the manager grants an agent publish rights on its OWN
 * transcript channel (whatever the resolved connector's `transcriptChannel(name)` returns) when
 * transcript mirroring is enabled, scopes the grant to exactly that channel, and FAILS LOUD when
 * transcript is requested for a connector that doesn't mirror. This catches manager-grant ↔
 * connector-publish-channel drift at the cred/ACL layer — which typecheck can't, since the manager now
 * sources the channel through the optional `Connector.transcriptChannel` contract method.
 *
 * No broker: real crypto (createSpaceAuth + the manager's mint path), a fake runtime + ep stub, and we
 * DECODE the written creds JWT to read the minted publish ACL. Modeled on persona-identity-acl.smoke.ts.
 * Run with: pnpm smoke:transcript-grant
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import { createSpaceAuth, registry, type Connector, type LaunchSpec, type AgentHandle } from "@cotal-ai/core";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// The chat-publish subjects allowed by a minted creds file (decode the JWT's nats.pub.allow).
function pubAcl(path: string): string[] {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  return ((claims.nats?.pub?.allow as string[] | undefined) ?? []).filter((s) => s.includes(".chat.") && !s.startsWith("$JS"));
}

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-transcript-grant-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
// A persona with a known non-transcript post ACL, so we can tell the transcript grant apart from it.
writeFileSync(
  join(agentsDir, "mirror-bot.md"),
  "---\nname: mirrorbot\nrole: worker\nsubscribe: [work]\nallowSubscribe: [work]\nallowPublish: [work]\n---\nbody\n",
);

const mgr = new Manager({ space: "demo", servers: undefined, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = await createSpaceAuth("demo"); // real trust material, no broker

const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  provisionDmInbox: async () => {},
  provisionDlvInbox: async () => {},
  commitAcl: async () => {},
  provisionTaskQueue: async () => {},
};

// The exact `tr-<name>` sanitizer the real connectors use (connector-core); the manager grants whatever
// the connector returns, so a mirroring connector hands back this and a non-mirroring one omits the method.
const tr = (n: string): string => `tr-${n.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
const base = { kind: "connector" as const, requires: ["node"], buildLaunch: (): LaunchSpec => ({ command: "true", args: [], env: {} }) };
registry.register({ ...base, name: "smoke-mirror", transcriptChannel: tr } satisfies Connector);
registry.register({ ...base, name: "smoke-nomirror" } satisfies Connector); // no transcriptChannel → doesn't mirror

const credsDir = join(workspaceRoot, ".cotal", "auth", "creds");

// 1 — transcript ON + a mirroring connector: the agent is granted pub on its OWN tr-<name>.
{
  const reply = await mgr.startAgent({ name: "mirror-bot", agent: "smoke-mirror", transcript: true });
  check("spawn with transcript succeeds", reply.ok === true, reply);
  const pub = pubAcl(join(credsDir, "mirrorbot.creds"));
  check("auth-mode grant includes the connector's transcript channel (tr-mirrorbot)", pub.some((s) => s.includes(".tr-mirrorbot")), pub);
  check("the granted channel is the connector's transcriptChannel, no drift", pub.some((s) => s.includes(`.${tr("mirrorbot")}`)), pub);
}

// 2 — transcript OFF: no transcript channel is granted (only the persona's own post ACL).
{
  const reply = await mgr.startAgent({ name: "mirror-bot", agent: "smoke-mirror" }); // auto-numbered → mirrorbot-2
  check("spawn without transcript succeeds", reply.ok === true && reply.data?.name === "mirrorbot-2", reply);
  const pub = pubAcl(join(credsDir, "mirrorbot-2.creds"));
  check("no transcript channel granted when transcript is off", !pub.some((s) => s.includes(".tr-")), pub);
}

// 3 — transcript ON + a connector that does NOT mirror: fail loud, never a silently-skipped grant.
{
  const reply = await mgr.startAgent({ name: "mirror-bot", agent: "smoke-nomirror", transcript: true });
  check("transcript on a non-mirroring connector fails loud", reply.ok === false && /does not support transcript mirroring/.test(reply.error ?? ""), reply);
}

console.log(`\nTRANSCRIPT-GRANT/ACL SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Mesh-manifest launch smoke — proves the `supervise --launch` path: `startAgent({ resolved })`
 * mints creds from the RESOLVED policy (no persona file read for authority), the launch-spec loader
 * rejects untrusted/unsafe input, and `materializePersona` writes a transient, non-authoritative
 * persona (no ACL frontmatter, with a generated header). No broker, no real harness — real crypto
 * (createSpaceAuth + the mint path), a fake runtime + no-op ep stub, decode the minted creds JWT.
 * Run with: pnpm smoke:manifest-launch
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import { loadLaunchSpec, materializePersona, launchAgentToStartOpts, launchSpecForRun } from "../src/launch.js";
import { createSpaceAuth, registry, type Connector, type LaunchSpec, type AgentHandle, type MeshLaunchAgent, type MeshLaunchSpec } from "@cotal-ai/core";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}
function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    check(label, false, "did not throw");
  } catch {
    check(label, true);
  }
}

function credAcl(path: string): { sub: string[]; pub: string[] } {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  const nats = claims.nats ?? {};
  const chat = (arr: string[] | undefined, keepJs: boolean) =>
    (arr ?? []).filter((s) => s.includes(".chat.") && (keepJs || !s.startsWith("$JS")));
  return { sub: chat(nats.sub?.allow, true), pub: chat(nats.pub?.allow, false) };
}

const root = mkdtempSync(join(tmpdir(), "cotal-launch-"));
const runId = "deadbeef01";

// --- materializePersona: transient, non-authoritative -------------------------------------------
const resolved: MeshLaunchAgent = {
  name: "scout",
  agent: "smoke-launch",
  role: "researcher",
  model: "opus",
  description: "Quick web researcher.",
  body: "Research the web; report in 3 bullets.",
  capabilities: ["spawn"],
  subscribe: ["general", "ops"],
  allowSubscribe: ["general", "ops", "review"],
  allowPublish: ["general"],
  personaPath: undefined,
  hash: "abc123",
};
const personaPath = materializePersona(root, runId, resolved);
{
  const md = readFileSync(personaPath, "utf8");
  check("transient persona lives under .cotal/run/<runId>/agents", personaPath.includes(join(".cotal", "run", runId, "agents")));
  check("not under .cotal/agents", !personaPath.includes(join(".cotal", "agents", "scout")));
  check("carries identity/role/model", /name: scout/.test(md) && /role: researcher/.test(md) && /model: opus/.test(md));
  check("carries the persona body", md.includes("Research the web"));
  check("has a generated-artifact header", /Generated runtime artifact/.test(md));
  check("NO authoritative ACL frontmatter", !/^(subscribe|allowSubscribe|allowPublish|capabilities):/m.test(md), md);
}

// --- startAgent({ resolved }): creds minted from the resolved policy, no file authority ----------
const mgr = new Manager({ space: "demo", servers: undefined, runtime: "pty", workspaceRoot: root });
(mgr as unknown as { auth: unknown }).auth = await createSpaceAuth("demo");
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
const recCon: Connector = { kind: "connector", name: "smoke-launch", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(recCon);

{
  // Note: there is NO .cotal/agents/scout.md — only the transient file. A non-resolved spawn would
  // fail "no persona scout"; the resolved path must succeed from the launch object alone.
  const reply = await mgr.startAgent(launchAgentToStartOpts(resolved, personaPath));
  check("resolved spawn succeeds with no persona file in .cotal/agents", reply.ok === true, reply);
  check("identity is the resolved name", reply.ok && reply.data?.name === "scout", reply.ok && reply.data?.name);

  const acl = credAcl(join(root, ".cotal", "auth", "creds", "scout.creds"));
  check("read ACL = resolved allowSubscribe (general+ops+review)", ["general", "ops", "review"].every((ch) => acl.sub.some((s) => s.endsWith("." + ch))), acl.sub);
  check("post ACL = resolved allowPublish (general only)", acl.pub.some((s) => s.endsWith(".general")) && !acl.pub.some((s) => s.endsWith(".ops")), acl.pub);
}

// --- loadLaunchSpec: untrusted-input validation -------------------------------------------------
const specOf = (over: Partial<MeshLaunchSpec> = {}): unknown => ({
  apiVersion: "cotal-launch/v1",
  space: "demo",
  runId: "run01",
  agents: [{ name: "a", agent: "claude", subscribe: ["general"], allowSubscribe: ["general"], allowPublish: [], hash: "h" }],
  ...over,
});
function writeSpec(name: string, body: unknown): string {
  const p = join(root, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}
{
  const spec = loadLaunchSpec(writeSpec("ok.json", specOf()));
  check("valid launch spec loads", spec.agents.length === 1 && spec.runId === "run01");
  throws("bad apiVersion rejected", () => loadLaunchSpec(writeSpec("v.json", specOf({ apiVersion: "nope" as never }))));
  throws("path-traversal runId rejected", () => loadLaunchSpec(writeSpec("r.json", specOf({ runId: "../evil" }))));
  throws("unknown top-level key rejected (strict)", () => loadLaunchSpec(writeSpec("k.json", { ...(specOf() as object), bogus: 1 })));
  throws("unsafe agent name rejected", () =>
    loadLaunchSpec(writeSpec("n.json", specOf({ agents: [{ name: "../x", agent: "claude", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "h" }] }))));
  // Tightened untrusted-input contract: connector / role / capability / hash must be safe tokens.
  const agent1 = (over: Record<string, unknown>) => specOf({ agents: [{ name: "a", agent: "claude", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "h", ...over }] });
  throws("injection-y connector token rejected", () => loadLaunchSpec(writeSpec("a1.json", agent1({ agent: "claude;rm -rf" }))));
  throws("unsafe role token rejected", () => loadLaunchSpec(writeSpec("a2.json", agent1({ role: "a/b" }))));
  throws("unsafe capability token rejected", () => loadLaunchSpec(writeSpec("a3.json", agent1({ capabilities: ["spawn x"] }))));
  throws("non-alphanumeric hash rejected", () => loadLaunchSpec(writeSpec("a4.json", agent1({ hash: "../../etc" }))));
  // Policy re-validation at the manager boundary — --launch must not be a looser manifest format.
  throws("wildcard scope in launch policy rejected", () => loadLaunchSpec(writeSpec("p1.json", agent1({ subscribe: ["team.>"], allowSubscribe: ["team.>"] }))));
  throws("subscribe ⊄ allowSubscribe rejected", () => loadLaunchSpec(writeSpec("p2.json", agent1({ subscribe: ["general"], allowSubscribe: [] }))));
  throws("unknown capability rejected (not just unsafe token)", () => loadLaunchSpec(writeSpec("p3.json", agent1({ capabilities: ["teleport"] }))));
  // Belt-and-suspenders (review-fact): allowPublish-only wildcard is rejected too (same validateLaunchPolicy loop).
  throws("wildcard allowPublish rejected", () => loadLaunchSpec(writeSpec("p4.json", agent1({ allowPublish: ["team.>"] }))));
}

// --- launchSpecForRun + the `launch` control op: spawn -f onto a RUNNING manager ----------------
{
  const runId2 = "feedface02";
  const spec2: MeshLaunchSpec = {
    apiVersion: "cotal-launch/v1",
    space: "demo",
    runId: runId2,
    agents: [{
      name: "scout", agent: "smoke-launch", role: "researcher", model: "opus", description: "Quick researcher.",
      body: "Research; 3 bullets.", capabilities: ["spawn"], subscribe: ["general"], allowSubscribe: ["general", "ops"],
      allowPublish: ["general"], personaPath: undefined, hash: "abc123",
    }],
  };
  mkdirSync(join(root, ".cotal", "run"), { recursive: true });
  writeFileSync(join(root, ".cotal", "run", `${runId2}.json`), JSON.stringify(spec2));

  // The op takes a runId, NOT a path — the manager derives + validates the spec location itself.
  check("launchSpecForRun derives + loads the spec by runId", launchSpecForRun(root, runId2).agents[0].name === "scout");
  throws("launchSpecForRun rejects an unsafe runId token", () => launchSpecForRun(root, "../evil"));
  throws("launchSpecForRun rejects a missing run", () => launchSpecForRun(root, "nosuchrun"));

  type LaunchReply = { ok: boolean; data?: Record<string, unknown>; error?: string };
  const op = (a: Record<string, unknown>) =>
    (mgr as unknown as { opLaunch(a: Record<string, unknown>, c: string): Promise<LaunchReply> }).opLaunch(a, "smoke-caller");
  const reply = await op({ runId: runId2, name: "scout" });
  check("opLaunch boots the resolved agent", reply.ok === true, reply.error);
  // `scout` is already on the (fake) mesh from the startAgent test above, so it collision-numbers.
  check("reply.name is the SPAWNED collision-numbered name (scout-2)", reply.ok && reply.data?.name === "scout-2", reply.ok && reply.data?.name);
  check("reply carries the manifest requested name", reply.ok && reply.data?.requested === "scout");
  check("reply carries runId + resolved hash for the ledger", reply.ok && reply.data?.runId === runId2 && reply.data?.hash === "abc123");
  check("reply carries the spawned nkey id", reply.ok && typeof reply.data?.id === "string" && (reply.data.id as string).length > 0);
  check("creds are filed under the SPAWNED name (ledger-keying invariant)", existsSync(join(root, ".cotal", "auth", "creds", "scout-2.creds")));
  // The cred file's OWN nkey subject equals the reply id — the invariant `down -f` relies on to
  // verify a cred belongs to the recorded agent before deleting it (name+id ownership).
  {
    const credText = readFileSync(join(root, ".cotal", "auth", "creds", "scout-2.creds"), "utf8");
    const jwt = credText.split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
    const sub = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).sub;
    check("minted cred's JWT subject == the reply id (down -f cred-ownership check)", reply.ok && sub === reply.data?.id, { sub, id: reply.ok && reply.data?.id });
  }
  const bad = await op({ runId: runId2, name: "ghost" });
  check("opLaunch rejects an unknown agent name", bad.ok === false);
}

// --- symlinked parent dir refused (writes can't escape the run tree) ----------------------------
{
  const root2 = mkdtempSync(join(tmpdir(), "cotal-launch-sym-"));
  const external = mkdtempSync(join(tmpdir(), "cotal-launch-ext-"));
  mkdirSync(join(root2, ".cotal"));
  symlinkSync(external, join(root2, ".cotal", "run")); // .cotal/run → outside the workspace
  throws("materialize refuses a symlinked .cotal/run parent", () => materializePersona(root2, "run01", { ...resolved, name: "x" }));
  throws("launchSpecForRun refuses a symlinked .cotal/run parent", () => launchSpecForRun(root2, "run01"));

  // Belt-and-suspenders (review-fact): a symlinked <runId> dir is refused too (same per-component lstat).
  const root3 = mkdtempSync(join(tmpdir(), "cotal-launch-sym2-"));
  mkdirSync(join(root3, ".cotal", "run", "agents"), { recursive: true });
  symlinkSync(mkdtempSync(join(tmpdir(), "cotal-launch-ext2-")), join(root3, ".cotal", "run", "rid"));
  throws("materialize refuses a symlinked .cotal/run/<runId> dir", () => materializePersona(root3, "rid", { ...resolved, name: "y" }));
}

console.log(`\nMANIFEST-LAUNCH SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);

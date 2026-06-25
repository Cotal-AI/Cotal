/**
 * Persona identity + ACL smoke — proves a manager spawn resolves the persona by FILENAME but takes
 * the mesh IDENTITY from inside the file (`name:`), and mints the file's read/post ACL — never a
 * silent default. Regression guard for the "spawned-by-display-name → default-ACL agent" bug.
 * No broker, no real harness: real crypto (createSpaceAuth + the manager's mint path), a fake
 * runtime + a no-op DurableProvisioner ep stub, and we DECODE the written creds JWT to read the ACL.
 * Run with: pnpm smoke:persona-acl
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import { createSpaceAuth, registry, type Connector, type LaunchSpec, type AgentHandle } from "@cotal-ai/core";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

// Decode the `nats` permission block out of a minted creds file (the JWT is the first line after the
// BEGIN marker; its middle segment is base64url JSON).
function credAcl(path: string): { sub: string[]; pub: string[] } {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  const nats = claims.nats ?? {};
  const chat = (arr: string[] | undefined, keepJs: boolean) =>
    (arr ?? []).filter((s) => s.includes(".chat.") && (keepJs || !s.startsWith("$JS")));
  return { sub: chat(nats.sub?.allow, true), pub: chat(nats.pub?.allow, false) };
}

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-persona-acl-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
// Filename (review-critic) ≠ in-file name (socrates); a non-default read/post ACL.
writeFileSync(
  join(agentsDir, "review-critic.md"),
  "---\nname: socrates\nrole: critic\nsubscribe: [review]\nallowSubscribe: [review, review.>]\nallowPublish: [review.>]\n---\nbody\n",
);

const mgr = new Manager({ space: "demo", servers: undefined, runtime: "pty", workspaceRoot });
// Real space trust material so the mint path runs end to end (pure crypto, no broker).
(mgr as unknown as { auth: unknown }).auth = await createSpaceAuth("demo");

// Fake runtime (records the spec, launches nothing) + an ep stub that is both ref() and a no-op
// DurableProvisioner (the manager hands its ep to provisionAgent).
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
  kind: "fake",
  spawn: (name) => fakeHandle(name),
};
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  provisionDmInbox: async () => {},
  provisionDlvInbox: async () => {},
  commitAcl: async () => {},
  provisionTaskQueue: async () => {},
};

const recCon: Connector = { kind: "connector", name: "smoke-rec2", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(recCon);

// 1 — Spawn by FILENAME; identity comes from the file's name:, ACL from the file (not default).
{
  const reply = await mgr.startAgent({ name: "review-critic", agent: "smoke-rec2" });
  check("spawn by filename succeeds", reply.ok === true, reply);
  check("identity is the file's name: (socrates), not the filename", reply.ok && reply.data?.name === "socrates", reply.ok && reply.data?.name);

  const acl = credAcl(join(workspaceRoot, ".cotal", "auth", "creds", "socrates.creds"));
  check("read ACL is the persona's review scope", acl.sub.some((s) => s.endsWith(".review")) && acl.sub.some((s) => s.endsWith(".review.>")), acl.sub);
  check("post ACL is the persona's review.> (not default-deny)", acl.pub.some((s) => s.includes(".review.>")), acl.pub);
  check("NOT the silent default (general-only read)", !(acl.sub.length === 1 && acl.sub[0].endsWith(".general")), acl.sub);
}

// 2 — Spawning by the DISPLAY name (socrates) fails loud — there is no socrates.md; you spawn by file.
{
  const reply = await mgr.startAgent({ name: "socrates", agent: "smoke-rec2" });
  check("spawn by display-name fails loud (no socrates.md)", reply.ok === false && /no persona "socrates"/.test(reply.error ?? ""), reply);
}

// 3 — A second spawn of the same persona auto-numbers the IDENTITY (socrates → socrates-2).
{
  const reply = await mgr.startAgent({ name: "review-critic", agent: "smoke-rec2" });
  check("second spawn auto-numbers the identity", reply.ok && reply.data?.name === "socrates-2", reply.ok && reply.data?.name);
}

console.log(`\nPERSONA-IDENTITY/ACL SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * `cotal app-identity`: the plumbing a Claude app conversation runs to open its own identity, and
 * to retire it. A new identity opens only after a person approves it at the mesh's authority, so a
 * static-credential mesh opens none. What an earlier provision opened there still retires.
 *
 * Live: a throwaway JWT-auth broker on an OS-assigned port, a mesh registered in a temp COTAL_HOME
 * with `cotal meshes add`, and the command run in-process with its stdout captured, because stdout
 * is the whole contract: one JSON line, never the credential.
 *
 * Needs `nats-server` on PATH, as the rest of smoke:ci does.
 * Run: pnpm smoke:app-identity:live
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-home-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";
delete process.env.COTAL_DEFAULT_PERSONA;

const {
  conversationSelection, createSpaceAuth, deprovisionAgent, mintCreds, mintLifecycleUid, newIdentity, provisionAgent,
  seedChannelRegistry, setupSpaceStreams, CotalEndpoint,
} = await import("@cotal-ai/core");
const { authDir, recordMesh, saveSpaceAuth } = await import("@cotal-ai/workspace");
const { meshes } = await import("../src/commands/meshes.js");
const { appIdentity } = await import("../src/commands/app-identity.js");
const { bootBroker } = await import("../../manager/smoke/_boot-broker.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** Run `cotal app-identity …` in-process and return what it wrote to stdout and its exit code. */
async function run(positionals: string[], values: Record<string, unknown>): Promise<{ out: string; code: number; reply: any }> {
  const chunks: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => (chunks.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    await appIdentity({ positionals, values, raw: [] } as never);
  } finally {
    process.stdout.write = write;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  const out = chunks.join("");
  let reply: any;
  try {
    reply = JSON.parse(out);
  } catch {
    reply = undefined;
  }
  return { out, code, reply };
}

/** `cotal meshes …` in-process; it reports through console and process.exit. */
class ExitSignal extends Error {}
async function runMeshes(positionals: string[], values: Record<string, unknown>): Promise<number> {
  const [log, err, exit] = [console.log, console.error, process.exit];
  let code = 0;
  console.log = () => {};
  console.error = () => {};
  process.exit = ((c?: number) => { code = c ?? 0; throw new ExitSignal(); }) as never;
  try {
    await meshes({ positionals, values, raw: [] } as never);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log; console.error = err; process.exit = exit;
  }
  return code;
}

const credDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("cotal-app-identity-"));
const noApproval = /no human approval for app conversations, so no identity was opened/;

const SPACE = "appmesh";
const root = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-root-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(
  join(root, ".cotal", "agents", "default.md"),
  "---\nname: default\nrole: default\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\n\nA Claude app conversation.\n",
);
const userRoot = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-user-"));
const auth = await createSpaceAuth(SPACE);
const broker = await bootBroker(auth);
const cleanup: Array<() => Promise<void> | void> = [];
let brokerUp = true;

try {
  saveSpaceAuth(authDir(root), auth);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space: SPACE, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space: SPACE, creds: provisioner, file: { channels: { general: {} } } });
  check("the mesh registers", (await runMeshes(["add", SPACE], { server: broker.servers, root })) === 0);
  const supervisor = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: provisioner, card: { name: "prov", kind: "endpoint" },
    consume: false, watchPresence: false, registerPresence: false,
  });
  await supervisor.start();
  cleanup.push(() => supervisor.stop());

  /** An identity as a static-mesh provision made one before connection approval: a fresh `mkdtemp`
   *  directory with its record and credential, and the broker footprint of a foreground spawn. */
  const earlier = async (owner: number) => {
    const identity = newIdentity(), lifecycleUid = mintLifecycleUid();
    const dir = mkdtempSync(join(tmpdir(), "cotal-app-identity-"));
    writeFileSync(join(dir, "identity.json"), JSON.stringify({ space: SPACE, id: identity.id, lifecycleUid, owner }), { mode: 0o600 });
    const creds = await provisionAgent(supervisor, auth, identity,
      { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], role: "default", lifecycleUid });
    writeFileSync(join(dir, "agent.creds"), creds, { mode: 0o600 });
    return { dir, id: identity.id, lifecycleUid };
  };
  const footprintGone = async (who: { id: string; lifecycleUid: string }) => {
    const again = await deprovisionAgent({
      servers: broker.servers, space: SPACE, targetId: who.id, lifecycleUid: who.lifecycleUid,
      creds: await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: who.id, lifecycleUid: who.lifecycleUid } }),
    });
    return again.acls.absent === 1 && again.consumers.absent === 2 && again.deleted === 0;
  };

  // ── provision opens nothing without a person's approval ──────────────────────────────────────
  const usage = await run(["open"], {});
  check("an unknown verb answers its usage as one JSON line", usage.code === 1 && usage.reply?.ok === false && /usage/.test(usage.reply.error), usage.out);
  const nameless = await run(["provision"], { space: SPACE });
  check("provision without a name is refused", nameless.code === 1 && /--name/.test(nameless.reply?.error), nameless.out);
  const before = credDirs().length;
  const refused = await run(["provision"], { space: SPACE, name: "claude_app" });
  check("a static-credential mesh refuses a new app identity by name", refused.code === 1 && refused.reply?.ok === false &&
    noApproval.test(refused.reply.error) && refused.reply.error.includes(`"${SPACE}"`) && refused.out.trim().split("\n").length === 1, refused.out);
  check("  with no environment or credential in the reply", refused.reply.env === undefined && !/BEGIN NATS|NKEY SEED|COTAL_CREDS/.test(refused.out), refused.out);
  check("  and it made no credential directory", credDirs().length === before, credDirs());
  const selected = await run(["provision"], { space: SPACE, name: "claude_app",
    selection: JSON.stringify(conversationSelection({ capabilities: ["run"] })) });
  check("a selection does not open one either", selected.code === 1 && noApproval.test(selected.reply?.error) && credDirs().length === before, selected.out);
  // A per-user sign-in mesh, recorded the way `cotal meshes add` records one. It is refused before
  // anything dials it, so its addresses only need to parse.
  recordMesh({ space: "usermesh", server: "nats://127.0.0.1:9", root: userRoot, mode: "user", origin: "manual", userAuth: {
    provider: "cotal", idp: { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example" },
    endpoints: { url: "https://cotal.example/agents", agentProvisioningUrl: "https://cotal.example/agents" }, remote: true,
  }, ts: new Date().toISOString() } as never);
  const userMesh = await run(["provision"], { space: "usermesh", name: "claude_app" });
  check(
    "a signed-in mesh refuses a missing native session before provisioning",
    userMesh.code === 1 && /native session identity before connecting/.test(userMesh.reply?.error),
    userMesh.out,
  );

  // ── an identity opened before approval still retires, with its broker footprint ─────────────
  const live = await earlier(process.ppid);
  const retired = await run(["retire"], { dir: live.dir });
  check("an earlier identity retires", retired.code === 0 && retired.reply?.ok === true && retired.out.trim().split("\n").length === 1, retired.out);
  check("  and its credential directory is gone", !existsSync(live.dir));
  check("  and so is its broker footprint", await footprintGone(live));

  const orphan = await earlier(spawnSync(process.execPath, ["-e", ""]).pid);
  const kept = await earlier(process.ppid);
  const next = await run(["provision"], { space: SPACE, name: "claude_app_3" });
  check("a refused provision still retires an earlier identity whose host is gone", noApproval.test(next.reply?.error) && !existsSync(orphan.dir));
  check("  with its broker footprint", await footprintGone(orphan));
  check("  and keeps the one whose host is alive", existsSync(join(kept.dir, "agent.creds")));

  // ── retire removes only what provision made ─────────────────────────────────────────────────
  const foreign = mkdtempSync(join(tmpdir(), "not-an-app-identity-"));
  const notOurs = await run(["retire"], { dir: foreign });
  check("retire refuses a directory provision did not make", notOurs.code === 1 && /refusing to remove/.test(notOurs.reply?.error), notOurs.out);
  check("  and leaves it in place", existsSync(foreign));
  // Raw, as a caller could pass it: `join` would normalize the climb away before retire saw it.
  const climbing = `${tmpdir()}/cotal-app-identity-/../${basename(foreign)}`;
  const climbed = await run(["retire"], { dir: climbing });
  check("retire refuses a path that climbs out of a credential directory", climbed.code === 1 && /refusing to remove/.test(climbed.reply?.error), climbed.out);
  check("  and leaves what it names in place", existsSync(foreign));
  rmSync(foreign, { recursive: true, force: true });
  const elsewhere = join(root, "cotal-app-identity-elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "agent.creds"), "not provision's");
  // A readable record naming the live mesh, so only the directory checks stand between retire and the file.
  writeFileSync(join(elsewhere, "identity.json"), JSON.stringify({ space: SPACE, id: newIdentity().id, lifecycleUid: mintLifecycleUid(), owner: process.pid }));
  const misplaced = await run(["retire"], { dir: elsewhere });
  check("retire refuses a credential-named directory outside the temp directory", misplaced.code === 1 && /refusing to remove/.test(misplaced.reply?.error), misplaced.out);
  check("  and leaves its file in place", existsSync(join(elsewhere, "agent.creds")));
  const link = join(tmpdir(), `cotal-app-identity-link-${process.pid}`);
  symlinkSync(elsewhere, link);
  const linked = await run(["retire"], { dir: link });
  check("retire refuses a credential-named link to another directory", linked.code === 1 && /refusing to remove/.test(linked.reply?.error), linked.out);
  check("  and leaves the file it points at", existsSync(join(elsewhere, "agent.creds")));
  rmSync(link, { force: true });
  const missing = await run(["retire"], {});
  check("retire without a directory is refused", missing.code === 1 && /--dir/.test(missing.reply?.error), missing.out);

  // ── a mesh that does not answer ──────────────────────────────────────────────────────────────
  for (const stop of cleanup.splice(0).reverse()) await stop();
  await broker.stop();
  brokerUp = false;
  const beforeDown = credDirs().length;
  const down = await run(["provision"], { space: SPACE, name: "claude_app" });
  check("a mesh that is not answering still opens nothing", down.code === 1 && noApproval.test(down.reply?.error) && credDirs().length === beforeDown, down.out);
  const downRetire = await run(["retire"], { dir: kept.dir });
  check("retire on a mesh that is not answering is refused", downRetire.code === 1 && /not answering/.test(downRetire.reply?.error), downRetire.out);
  check("  and keeps what a later retire needs", existsSync(join(kept.dir, "agent.creds")) && existsSync(join(kept.dir, "identity.json")));
  rmSync(kept.dir, { recursive: true, force: true });
} finally {
  for (const stop of cleanup.reverse()) await Promise.resolve(stop()).catch(() => {});
  if (brokerUp) await broker.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(userRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`\nAPP IDENTITY TESTS PASSED ✅  (${pass} checks)`);
process.exit(0);
